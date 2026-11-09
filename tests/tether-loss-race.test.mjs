import test from "node:test";import assert from "node:assert/strict";import {Scheduler} from "../src/queue.mjs";
function make(offlineAfterProbe){
 let active=false,probes=0,failures=0,held=0;
 const scheduler={network:{enabled:true,snapshot:()=>({active}),async refresh(){probes++;active=offlineAfterProbe;}},attention:null,backoff:{async failure(){failures++;return{triggered:false};}},async holdNetwork(){held++;}};
 return{scheduler,result:()=>({probes,failures,held})};
}
test("tether loss before monitor tick holds collection without counting source failure",async()=>{
 const f=make(true);await Scheduler.prototype.requestFailed.call(f.scheduler,"job",Error("page.goto: net::ERR_CONNECTION_CLOSED"));
 assert.deepEqual(f.result(),{probes:1,failures:0,held:1});
});
test("origin TLS outage with a healthy tether remains a normal source failure",async()=>{
 const f=make(false);await Scheduler.prototype.requestFailed.call(f.scheduler,"job",Error("page.goto: net::ERR_CONNECTION_RESET"));
 assert.deepEqual(f.result(),{probes:1,failures:1,held:0});
});
test("ordinary HTTP errors do not trigger phone reconnect or extra route probes",async()=>{
 const f=make(false);await Scheduler.prototype.requestFailed.call(f.scheduler,"job",Object.assign(Error("HTTP 503"),{httpStatus:503}));
 assert.deepEqual(f.result(),{probes:0,failures:1,held:0});
});
