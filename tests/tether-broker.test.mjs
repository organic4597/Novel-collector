import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,readFile,writeFile,lstat,rm,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import http from "node:http";
import {TetherBroker} from "../src/tether-broker.mjs";
import {TetherControl} from "../src/tether-control.mjs";
async function fixture(t){const parent=await mkdtemp(join(tmpdir(),"nc-broker-"));t.after(()=>rm(parent,{recursive:true,force:true}));return join(parent,"broker");}
function fakeGateway(){
 const calls=[];return{calls,started:0,closed:false,ready:true,
  async start(){this.started++;},async isReady(){return this.ready;},async close(){this.closed=true;},
  async runHost(action,options){calls.push(["host",action,options]);return{ready:true,prepared:action==="prepare",secret:"never expose",serial:"private"};},
  async runPhone(action,options){calls.push(["phone",action,options]);return{ok:true,tethering:action==="on",cellular:true,validated:true,device_id:"private",token:"secret"};}
 };
}
function request(socketPath,path,{method="POST",body=""}={}){
 return new Promise((resolve,reject)=>{
  const req=http.request({socketPath,path,method,headers:{"Content-Length":Buffer.byteLength(body)}},res=>{let text="";res.setEncoding("utf8");res.on("data",c=>{text+=c;});res.on("end",()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});
  req.on("error",reject);req.end(body);
 });
}
test("private Unix broker starts without phone actions and client never receives secrets",async t=>{
 const runtimeDir=await fixture(t),gateway=fakeGateway(),broker=new TetherBroker({runtimeDir,gateway});
 await broker.start();t.after(()=>broker.close());
 assert.equal((await lstat(runtimeDir)).mode&0o777,0o700);assert.equal((await lstat(broker.socketPath)).mode&0o777,0o600);
 assert.equal(gateway.calls.length,0);
 const client=new TetherControl({socketPath:broker.socketPath,ownerUid:process.getuid()});t.after(()=>client.close());
 const host=await client.callHost("status");assert.equal(host.ready,true);assert.equal(host.secret,undefined);assert.equal(host.serial,undefined);
 const phone=await client.callPhone("on");assert.equal(phone.tethering,true);assert.equal(phone.token,undefined);assert.equal(phone.device_id,undefined);
 assert.equal(typeof broker.server.address(),"string");
});
test("fixed action allowlist rejects payload query and unsupported methods before execution",async t=>{
 const gateway=fakeGateway(),broker=new TetherBroker({runtimeDir:await fixture(t),gateway});await broker.start();t.after(()=>broker.close());
 for(const [path,options,status] of[
  ["/host/close",{},404],["/phone/reboot",{},404],["/phone/on?x=1",{},404],["/phone/on",{method:"GET"},405],["/host/connect",{body:'{"shell":"id"}'},400]]){
  const out=await request(broker.socketPath,path,options);assert.equal(out.status,status);
 }
 assert.equal(gateway.calls.length,0);
 const client=new TetherControl({socketPath:broker.socketPath,ownerUid:process.getuid()});
 await assert.rejects(client.callHost("close"),{code:"TETHER_CONTROL_ACTION"});client.close();
});
test("only one mutation runs while read-only status remains available",async t=>{
 const gateway=fakeGateway();let finish,entered;const started=new Promise(r=>{entered=r;});
 gateway.runPhone=async(action)=>{if(action==="status")return{ok:true,tethering:false};entered();return new Promise(r=>{finish=r;});};
 const broker=new TetherBroker({runtimeDir:await fixture(t),gateway});await broker.start();t.after(()=>broker.close());
 const first=request(broker.socketPath,"/phone/on");await started;
 assert.equal((await request(broker.socketPath,"/phone/off")).status,409);
 assert.equal((await request(broker.socketPath,"/phone/status")).status,200);
 assert.equal((await request(broker.socketPath,"/phone/off")).status,409);
 finish({ok:true,tethering:true});assert.equal((await first).status,200);
});
test("helper failures are generic and a lost export cannot report collection ready",async t=>{
 const gateway=fakeGateway();gateway.ready=false;
 const broker=new TetherBroker({runtimeDir:await fixture(t),gateway});await broker.start();t.after(()=>broker.close());
 assert.equal((await request(broker.socketPath,"/host/status")).body.ready,false);
 gateway.ready=true;gateway.runHost=async()=>{throw Object.assign(Error("private token password target"),{code:"TETHER_DHCP_TIMEOUT"});};
 const out=await request(broker.socketPath,"/host/connect");assert.equal(out.status,503);assert.equal(out.body.code,"TETHER_DHCP_TIMEOUT");assert.equal(/private|token|password/.test(JSON.stringify(out.body)),false);
});
test("client close aborts a pending phone request and broker propagates cancellation",async t=>{
 const gateway=fakeGateway();let entered,aborted;const started=new Promise(r=>{entered=r;}),stopped=new Promise(r=>{aborted=r;});
 gateway.runPhone=async(_action,{signal})=>new Promise((resolve,reject)=>{entered();signal.addEventListener("abort",()=>{aborted();reject(Error("cancelled"));},{once:true});});
 const broker=new TetherBroker({runtimeDir:await fixture(t),gateway});await broker.start();t.after(()=>broker.close());
 const client=new TetherControl({socketPath:broker.socketPath,ownerUid:process.getuid()});
 const pending=client.callPhone("on");await started;client.close();await assert.rejects(pending,{code:"TETHER_CONTROL_CLOSED"});await stopped;await new Promise(resolve=>setImmediate(resolve));
 assert.equal(broker.mutationBusy,false);
});
test("unknown directories and replacement socket files survive broker cleanup",async t=>{
 let runtimeDir=await fixture(t);await mkdir(runtimeDir,{mode:0o700});await writeFile(join(runtimeDir,"keep"),"keep");
 let broker=new TetherBroker({runtimeDir,gateway:fakeGateway()});await assert.rejects(broker.start(),{code:"TETHER_BROKER_OWNERSHIP"});
 runtimeDir=await fixture(t);broker=new TetherBroker({runtimeDir,gateway:fakeGateway()});await broker.start();
 await new Promise(r=>broker.server.close(r));await writeFile(broker.socketPath,"replacement",{mode:0o600});await broker.close();
 assert.equal(await readFile(broker.socketPath,"utf8"),"replacement");
});
test("client refuses a symlink socket and oversized or invalid response",async t=>{
 const runtimeDir=await fixture(t),gateway=fakeGateway(),broker=new TetherBroker({runtimeDir,gateway});await broker.start();t.after(()=>broker.close());
 const link=join(runtimeDir,"alias.sock");await symlink(broker.socketPath,link);
 const client=new TetherControl({socketPath:link,ownerUid:process.getuid()});await assert.rejects(client.callHost("status"),{code:"TETHER_CONTROL_SOCKET"});
 gateway.runPhone=async()=>({ok:true,tethering:"true"});const out=await request(broker.socketPath,"/phone/status");assert.equal(out.status,503);
});

test("active server cleanup refuses a replacement pathname before Node can unlink it",async t=>{
 const runtimeDir=await fixture(t),broker=new TetherBroker({runtimeDir,gateway:fakeGateway()});await broker.start();
 const{unlink}=await import("node:fs/promises");await unlink(broker.socketPath);await writeFile(broker.socketPath,"preserve",{mode:0o600});
 await assert.rejects(broker.close(),{code:"TETHER_BROKER_OWNERSHIP"});assert.equal(await readFile(broker.socketPath,"utf8"),"preserve");
 await unlink(broker.socketPath);await new Promise(resolve=>broker.server.close(resolve));
});

test("bounded read-only slots do not release a different active request",async t=>{
 const gateway=fakeGateway();const finish=[];gateway.runPhone=async()=>new Promise(resolve=>{finish.push(resolve);});
 const broker=new TetherBroker({runtimeDir:await fixture(t),gateway});await broker.start();t.after(()=>broker.close());
 const pending=Array.from({length:4},()=>request(broker.socketPath,"/phone/status"));
 while(finish.length<4)await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await request(broker.socketPath,"/phone/status")).status,429);assert.equal(broker.readers,4);
 for(const resolve of finish)resolve({ok:true,tethering:false});await Promise.all(pending);assert.equal(broker.readers,0);
});
test("prepare must prove namespace guard setup before subsequent phone actions",async t=>{
 const gateway=fakeGateway();gateway.runHost=async()=>({});
 const broker=new TetherBroker({runtimeDir:await fixture(t),gateway});await broker.start();t.after(()=>broker.close());
 const out=await request(broker.socketPath,"/host/prepare");assert.equal(out.status,503);assert.equal(out.body.code,"TETHER_BROKER_RESPONSE");
});
test("control client rejects malformed and oversized JSON without returning payloads",async t=>{
 const runtimeDir=await fixture(t);await mkdir(runtimeDir,{mode:0o700});const socketPath=join(runtimeDir,"test.sock");
 let payload="[]",mime="application/json",chunked=false;
 const server=http.createServer((_req,res)=>{
  res.writeHead(200,{"Content-Type":mime,...(!chunked?{"Content-Length":Buffer.byteLength(payload)}:{})});
  if(chunked){res.write(payload.slice(0,32768));res.end(payload.slice(32768));}else res.end(payload);
 });
 const mask=process.umask(0o077);try{await new Promise(resolve=>server.listen(socketPath,resolve));}finally{process.umask(mask);}
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const client=new TetherControl({socketPath,ownerUid:process.getuid()});t.after(()=>client.close());
 for(const example of["[]","null","not-json"]){payload=example;await assert.rejects(client.callHost("status"),{code:"TETHER_CONTROL_RESPONSE"});}
 payload='{"ok":true}';mime="text/html";await assert.rejects(client.callHost("status"),{code:"TETHER_CONTROL_RESPONSE"});
 mime="application/json";payload="x".repeat(65537);await assert.rejects(client.callHost("status"),{code:"TETHER_CONTROL_RESPONSE"});
 chunked=true;await assert.rejects(client.callHost("status"),{code:"TETHER_CONTROL_RESPONSE"});
});
test("invalid local socket configuration is rejected without executing anything",()=>{
 for(const options of[{socketPath:"relative.sock"},{socketPath:"/x\0y"},{ownerUid:-1},{ownerUid:1.5}])assert.throws(()=>new TetherControl(options));
 assert.throws(()=>new TetherBroker({runtimeDir:"relative",gateway:fakeGateway()}));
});

test("systemd-created empty private directory and clean restart retain ownership",async t=>{
 const runtimeDir=await fixture(t);await mkdir(runtimeDir,{mode:0o700});
 let broker=new TetherBroker({runtimeDir,gateway:fakeGateway()});await broker.start();await broker.close();
 broker=new TetherBroker({runtimeDir,gateway:fakeGateway()});await broker.start();await broker.close();
 const{chmod}=await import("node:fs/promises");await chmod(join(runtimeDir,"broker-owner.json"),0o644);
 const unsafe=new TetherBroker({runtimeDir,gateway:fakeGateway()});await assert.rejects(unsafe.start(),{code:"TETHER_BROKER_OWNERSHIP"});
});
