import test from "node:test";
import assert from "node:assert/strict";
import {CollectionNetwork} from "../src/collection-network.mjs";
const flush=()=>new Promise(r=>setImmediate(r));
class Timers{
 now=1000;next=0;entries=new Map();
 schedule=(fn,delay)=>{const id=++this.next;this.entries.set(id,{fn,at:this.now+delay});return id;};
 cancel=id=>this.entries.delete(id);
 async advance(ms){this.now+=ms;for(let n=0;n<10;n++){const due=[...this.entries].filter(([,x])=>x.at<=this.now);if(!due.length)break;for(const[id,x]of due){this.entries.delete(id);x.fn();}await flush();}await flush();}
}
function setup({saved=null,ready=true,phone,connect,probe}={}){
 const timer=new Timers(),calls=[],events=[];
 const store={path:n=>n,json:async()=>saved&&structuredClone(saved),atomic:async(_p,v)=>{saved=structuredClone(v);}};
 const network=new CollectionNetwork({enabled:true,store,phone:phone||(async a=>{calls.push(a);return{enabled:a==="on"};}),connect:connect||(async()=>{calls.push("connect");ready=true;return{ready:true};}),probe:probe||(async()=>{calls.push("probe");return{ready};}),clock:()=>timer.now,schedule:timer.schedule,cancel:timer.cancel,pollMs:10000,onChange:x=>events.push(x)});
 return{network,timer,calls,events,store,saved:()=>structuredClone(saved),setReady:x=>{ready=x;}};
}
const block={siteHost:"sbxh9.com",blockCode:"NGINX_CIDR_REALIP"};
test("disabled mode does no work",async()=>{const n=new CollectionNetwork();await n.start();n.assertAvailable();assert.equal(n.snapshot().active,false);assert.equal(await n.block(block),false);n.close();});
test("startup probes without changing phone",async()=>{const f=setup();await f.network.start();assert.deepEqual(f.calls,["probe"]);assert.equal(f.network.snapshot().ready,true);f.network.close();});
test("offline holds, verified reconnect releases",async()=>{const f=setup({ready:false});await f.network.start();assert.throws(()=>f.network.assertAvailable(),{code:"COLLECTION_NETWORK_PAUSED",status:503});f.setReady(true);await f.network.refresh();assert.equal(f.network.snapshot().ready,true);f.network.close();});
test("bootstrap requires verified phone, connect and probe",async()=>{const f=setup({ready:false});await f.network.start();await f.network.bootstrap();assert.deepEqual(f.calls,["probe","on","connect","probe"]);assert.equal(f.network.snapshot().ready,true);f.network.close();const bad=setup({ready:false,phone:async()=>({ok:true})});await bad.network.start();await bad.network.bootstrap();assert.equal(bad.network.snapshot().phase,"needs_attention");bad.network.close();});
test("simultaneous blocks coalesce and wait full 300000ms",async()=>{const f=setup();await f.network.start();f.calls.length=0;const a=f.network.block(block),b=f.network.block(block);assert.equal(f.network.snapshot().active,true);await Promise.all([a,b]);assert.deepEqual(f.calls,["off"]);assert.equal(Date.parse(f.network.snapshot().retryAt),f.timer.now+300000);await f.timer.advance(299999);assert.deepEqual(f.calls,["off"]);await f.timer.advance(1);assert.deepEqual(f.calls,["off","on","connect","probe"]);assert.equal(f.network.snapshot().phase,"ready");f.network.close();});
test("restart retains absolute cooldown and never repeats off",async()=>{const f=setup();await f.network.start();await f.network.block(block);const saved=f.saved();f.network.close();const g=setup({saved});g.timer.now=100001;await g.network.start();assert.deepEqual(g.calls,[]);assert.equal(g.network.snapshot().retryAt,saved.retryAt);await g.timer.advance(Date.parse(saved.retryAt)-g.timer.now);assert.deepEqual(g.calls,["on","connect","probe"]);assert.equal(g.network.snapshot().ready,true);g.network.close();});
test("interrupted disconnect resumes idempotent off",async()=>{const f=setup({saved:{schema:1,phase:"disconnecting",retryAt:null,cycleUsed:true,siteHost:"sbxh9.com"}});await f.network.start();assert.deepEqual(f.calls,["off"]);assert.equal(f.network.snapshot().phase,"cooldown");f.network.close();});
test("phone or connect failure stays paused",async()=>{const f=setup({phone:async()=>{throw Error("secret token=do-not-store");}});await f.network.start();await f.network.block(block);assert.equal(f.network.snapshot().phase,"needs_attention");assert.ok(!JSON.stringify(f.saved()).includes("do-not-store"));await f.timer.advance(600000);assert.equal(f.network.snapshot().phase,"needs_attention");f.network.close();const g=setup({connect:async()=>{throw Error("no interface");}});await g.network.start();await g.network.block(block);await g.timer.advance(300000);assert.equal(g.network.snapshot().phase,"needs_attention");g.network.close();});
test("repeated block after recovery does not rotate forever",async()=>{const f=setup();await f.network.start();await f.network.block(block);await f.timer.advance(300000);await f.network.block(block);assert.equal(f.network.snapshot().phase,"needs_attention");assert.equal(f.calls.filter(x=>x==="off").length,1);f.network.close();});
test("ordinary 403, CAPTCHA and bad hosts cannot toggle phone",async()=>{const f=setup();await f.network.start();assert.equal(await f.network.block({...block,blockCode:"403"}),false);assert.equal(await f.network.block({...block,blockCode:"captcha"}),false);await assert.rejects(f.network.block({...block,siteHost:"https://bad.test/x"}));assert.deepEqual(f.calls,["probe"]);f.network.close();});
test("close ignores late off result",async()=>{let release;const pending=new Promise(r=>{release=r;}),calls=[];const f=setup({phone:async a=>{calls.push(a);return pending;}});await f.network.start();const work=f.network.block(block);await flush();f.network.close();release({enabled:false});await work;await f.timer.advance(600000);assert.deepEqual(calls,["off"]);assert.equal(f.network.snapshot().phase,"closed");assert.equal(f.network.snapshot().active,true);});
test("stale ready probe cannot override a block",async()=>{let release,slow=false;const pending=new Promise(r=>{release=r;});const f=setup({probe:async()=>slow?pending:{ready:true}});await f.network.start();slow=true;const refresh=f.network.refresh();await flush();await f.network.block(block);release({ready:true});await refresh;assert.equal(f.network.snapshot().phase,"cooldown");f.network.close();});
test("monitor does not alter manual queue controls or repeat identical events",async()=>{const f=setup();await f.network.start();const n=f.events.length;await f.network.refresh();assert.equal(f.events.length,n);f.setReady(false);await f.timer.advance(10000);assert.equal(f.network.snapshot().phase,"offline");assert.equal(Object.hasOwn(f.network,"queuePaused"),false);f.network.close();});
test("corrupt state fails closed",async()=>{const f=setup({saved:{schema:1,phase:"cooldown",retryAt:"invalid",cycleUsed:true}});await f.network.start();assert.equal(f.network.snapshot().phase,"needs_attention");assert.deepEqual(f.calls,[]);f.network.close();});

test("observer failure preserves a fail-closed persisted hold",async()=>{
 const f=setup();const n=new CollectionNetwork({enabled:true,store:f.store,phone:async()=>({enabled:true}),connect:async()=>({ready:true}),probe:async()=>({ready:true}),onChange:()=>{throw Error("observer failed");}});
 await n.start();assert.equal(n.snapshot().phase,"needs_attention");assert.equal(f.saved().phase,"needs_attention");n.close();
});
test("expired cooldown reconnects immediately without restarting a full five minutes",async()=>{
 const f=setup({saved:{schema:1,phase:"cooldown",retryAt:new Date(500).toISOString(),cycleUsed:true,siteHost:"sbxh9.com"}});
 await f.network.start();assert.deepEqual(f.calls,[]);await f.timer.advance(0);assert.deepEqual(f.calls,["on","connect","probe"]);f.network.close();
});
test("restart of reconnection verifies before releasing",async()=>{
 const f=setup({saved:{schema:1,phase:"verifying",retryAt:null,cycleUsed:true,siteHost:"sbxh9.com"}});
 await f.network.start();assert.deepEqual(f.calls,["on","connect","probe"]);assert.equal(f.network.snapshot().ready,true);f.network.close();
});
test("closing while phone on is pending prevents connect and ready",async()=>{
 let release;const pending=new Promise(r=>{release=r;}),calls=[];
 const f=setup({phone:async a=>{calls.push(a);return a==="off"?{enabled:false}:pending;}});await f.network.start();await f.network.block(block);await f.timer.advance(300000);assert.deepEqual(calls,["off","on"]);f.network.close();release({enabled:true});await flush();assert.ok(!f.calls.includes("connect"));assert.equal(f.network.snapshot().phase,"closed");
});
test("probe errors cannot grant ready and default observer works",async()=>{
 const f=setup();const n=new CollectionNetwork({enabled:true,store:f.store,phone:async()=>({enabled:true}),connect:async()=>({ready:true}),probe:async()=>{throw Error("unreachable");}});
 await n.start();assert.equal(n.snapshot().phase,"offline");n.close();
});
test("invalid constructor options are refused before side effects",()=>{
 assert.throws(()=>new CollectionNetwork({enabled:"yes"}));assert.throws(()=>new CollectionNetwork({pollMs:0}));assert.throws(()=>new CollectionNetwork({enabled:true}));
});
