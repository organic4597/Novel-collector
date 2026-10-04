import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm,readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActivityLog } from "../src/activity-log.mjs";
test("frequent successful polling is one counted row and cannot evict the actionable error",async t=>{
  const root=await mkdtemp(join(tmpdir(),"activity-groups-"));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,"events.jsonl"),log=await new ActivityLog({path,capacity:5,maxBytes:4000}).load();
  const error=log.add({scope:"update",level:"error",message:"Missing runtime",details:{step:"ACTIVATE",errorCode:"ENOENT"}});
  for(let i=0;i<250;i++)log.add({scope:"api",level:"info",message:"GET /api/status · 200",details:{method:"GET",status:200,elapsedMs:i%7}});
  const rows=log.query().items;assert.equal(rows.length,2);assert.equal(rows.find(r=>r.groupId).count,250);assert.ok(rows.some(r=>r.id===error.id));await log.close();
  const restored=await new ActivityLog({path,capacity:5,maxBytes:4000}).load();assert.equal(restored.query().items.length,2);assert.equal(restored.query().items.find(r=>r.groupId).count,250);await restored.close();
});
test("changed statuses and failure stages are not incorrectly merged; incremental cursor gets the new count",async t=>{
  const root=await mkdtemp(join(tmpdir(),"activity-cursor-"));t.after(()=>rm(root,{recursive:true,force:true}));const log=await new ActivityLog({path:join(root,"events.jsonl")}).load();
  const first=log.add({scope:"api",level:"info",message:"GET /api/jobs · 200",details:{status:200,elapsedMs:1}});
  log.add({scope:"api",level:"info",message:"GET /api/jobs · 200",details:{status:200,elapsedMs:9}});const delta=log.query({after:first.id}).items;
  assert.equal(delta.length,1);assert.equal(delta[0].groupId,first.groupId);assert.equal(delta[0].count,2);
  log.add({scope:"api",level:"error",message:"GET /api/jobs · 500",details:{status:500}});
  log.add({scope:"update",level:"error",message:"failure",details:{step:"SETUP_RUNTIME",errorCode:"COMMAND_FAILED"}});log.add({scope:"update",level:"error",message:"failure",details:{step:"ACTIVATE",errorCode:"ENOENT"}});
  assert.equal(log.query().items.length,4);assert.equal(log.query({level:"error"}).items.length,3);await log.close();
});
