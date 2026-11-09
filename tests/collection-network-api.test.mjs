import test from "node:test";
import assert from "node:assert/strict";
import {createApp} from "../src/server.mjs";
import {createTetherRuntime} from "../src/tether-runtime.mjs";
async function fixture(t,network){
 const app=createApp({store:{async listJobs(){return[];}},scheduler:{collector:{},activeJobIds:[],browserAgents:()=>[]},adminPassword:"synthetic-test-password",collectionNetwork:network});
 await new Promise(r=>app.listen(0,"127.0.0.1",r));t.after(()=>new Promise(r=>app.close(r)));const origin=`http://127.0.0.1:${app.address().port}`;
 const login=await fetch(origin+"/api/login",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({password:"synthetic-test-password"})});assert.equal(login.status,200);
 const cookie=login.headers.get("set-cookie").split(";")[0];
 return {origin,request:(path,options={})=>fetch(origin+path,{...options,headers:{Origin:origin,Cookie:cookie,"Content-Type":"application/json",...options.headers}})};
}
test("tether hold keeps dashboard health and authenticated status online",async t=>{
 const state={enabled:true,active:true,phase:"offline",retryAt:null};const{request}=await fixture(t,{enabled:true,snapshot:()=>state});
 assert.equal((await request("/api/health")).status,200);const status=await request("/api/status");assert.equal(status.status,200);assert.deepEqual((await status.json()).collectionNetwork,state);
});
test("phone connect requires authentication, same origin and empty payload",async t=>{
 let calls=0;const network={enabled:true,snapshot:()=>({enabled:true,active:true,phase:"offline",retryAt:null}),async bootstrap(){calls++;}};
 const{origin,request}=await fixture(t,network);
 assert.equal((await fetch(origin+"/api/collection-network/connect",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:"{}"})).status,401);
 assert.equal((await request("/api/collection-network/connect",{method:"POST",headers:{Origin:"https://untrusted.example"},body:"{}"})).status,403);
 assert.equal((await request("/api/collection-network/connect",{method:"POST",body:JSON.stringify({command:"arbitrary"})})).status,400);
 assert.equal(calls,0);assert.equal((await request("/api/collection-network/connect",{method:"POST",body:"{}"})).status,202);assert.equal(calls,1);
});
test("connect cannot override the five minute cooldown or disabled mode",async t=>{
 let calls=0;const network={enabled:true,snapshot:()=>({enabled:true,active:true,phase:"cooldown",retryAt:new Date(Date.now()+300000).toISOString()}),async bootstrap(){calls++;}};
 const{request}=await fixture(t,network);assert.equal((await request("/api/collection-network/connect",{method:"POST",body:"{}"})).status,409);assert.equal(calls,0);
 network.enabled=false;assert.equal((await request("/api/collection-network/connect",{method:"POST",body:"{}"})).status,409);
});
const store=()=>{let saved=null;return {path:name=>name,async json(){return saved;},async atomic(_,value){saved=structuredClone(value);}};};
test("direct runtime never calls phone or opens a collection proxy",async()=>{
 let calls=0;const rt=createTetherRuntime({store:store(),rootDir:"/synthetic",env:{},run:async()=>{calls++;}});
 await rt.transport.start();await rt.network.start();assert.equal(calls,0);assert.equal(rt.transport.port,null);rt.network.close();await rt.transport.close();
});
test("runtime validates mobile plus USB and prepares OS guard before phone",async()=>{
 const calls=[];const rt=createTetherRuntime({store:store(),rootDir:"/synthetic",env:{NC_COLLECTION_TETHER:"1",NC_TETHER_PHONE_SERIAL:"FAKE_USB"},run:async(file,args)=>{
  const kind=args[0].endsWith("tether-host.mjs")?"host":"phone",action=args[1];calls.push(kind+":"+action);
  return{stdout:JSON.stringify(kind==="host"?{ready:true,prepared:true}:{ok:true,tethering:action!=="off",usbConnected:true,cellular:true,validated:true})};
 }});
 await rt.transport.start();await rt.network.bootstrap();assert.equal(rt.network.snapshot().ready,true);
 assert.deepEqual(calls.slice(0,3),["host:prepare","phone:on","host:connect"]);
 assert.deepEqual(calls.slice(3),["host:status","phone:status"]);rt.network.close();await rt.transport.close();
});
test("USB sharing home WiFi and malformed control responses remain held",async()=>{
 const rt=createTetherRuntime({store:store(),rootDir:"/synthetic",env:{NC_COLLECTION_TETHER:"1",NC_TETHER_PHONE_SERIAL:"FAKE_USB"},run:async(file,args)=>({stdout:JSON.stringify(args[0].endsWith("tether-host.mjs")?{ready:true}:{ok:true,tethering:true,usbConnected:true,cellular:false,validated:true})})});
 await rt.network.start();assert.equal(rt.network.snapshot().active,true);rt.network.close();await rt.transport.close();
 const bad=createTetherRuntime({store:store(),rootDir:"/synthetic",env:{NC_COLLECTION_TETHER:"1"},run:async()=>{throw Error("must not run without configured USB");}});await bad.network.start();assert.equal(bad.network.snapshot().active,true);bad.network.close();await bad.transport.close();
});

test("shutdown during OS preparation submits no later phone command",async()=>{
 let release,entered;const wait=new Promise(r=>release=r),started=new Promise(r=>entered=r),calls=[];
 const rt=createTetherRuntime({store:store(),rootDir:"/synthetic",env:{NC_COLLECTION_TETHER:"1",NC_TETHER_PHONE_SERIAL:"FAKE_USB"},run:async(file,args)=>{
  calls.push(args[1]);if(args[0].endsWith("tether-host.mjs")&&args[1]==="prepare"){entered();await wait;}return{stdout:JSON.stringify({ready:true,ok:true,tethering:true})};
 }});
 const work=rt.network.bootstrap();await started;rt.network.close();release();await work;assert.deepEqual(calls,["prepare"]);await rt.transport.close();
});

test("runtime close aborts pending helper execution",async()=>{
 let signal;const rt=createTetherRuntime({store:store(),rootDir:"/synthetic",env:{NC_COLLECTION_TETHER:"1",NC_TETHER_PHONE_SERIAL:"FAKE_USB"},run:async(file,args,options)=>{signal=options.signal;return{stdout:JSON.stringify({ready:false})};}});
 await rt.network.start();assert.equal(signal.aborted,false);await rt.close();assert.equal(signal.aborted,true);
});
