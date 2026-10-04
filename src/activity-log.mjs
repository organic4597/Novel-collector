import { appendFile, readFile, rename, stat, mkdir,lstat,writeFile } from "node:fs/promises";
import { randomUUID,createHash } from "node:crypto";
import { dirname,join } from "node:path";
import { cleanMessage } from "./store.mjs";

const fields = new Set(["stage", "attempt", "maxAttempts", "elapsedMs", "x", "y", "code",
  "slot", "count", "loaded", "expected", "previous", "hasMore", "moreReady", "status", "method", "action", "step","exitCode","errorCode","eventId","targetVersion","component"]);
const dashboardScopes=new Set(["api","dashboard","ui","update","service","instance","settings","presets","auth"]);
export const dashboardEvent=event=>dashboardScopes.has(event.scope||"service");
export function aggregateLogKey(event){
  if(!["info","debug"].includes(event.level)||!["api","dashboard","ui"].includes(event.scope))return null;
  const details=Object.fromEntries(Object.entries(event.details||{}).filter(([key])=>!["elapsedMs","eventId"].includes(key)).sort(([a],[b])=>a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify([event.level,event.scope,event.message,details])).digest("hex");
}
export function redactDiagnostic(value){
  return cleanMessage(String(value||""))
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi,"Bearer [생략]")
    .replace(/\b(?:cookie|token|captchaToken|pendingToken|proof|nonce|password|pin|authorization|api[_-]?key|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,"[인증값 생략]")
    .replace(/https?:\/\/[^\s]+/g,"[사이트 주소]")
    .replace(/\b[A-Za-z]:[\\/][^\r\n"'<>]*/g,"[로컬 경로]")
    .replace(/\/(?:home|home1|root|Users)\/[^\s"'<>]+/g,"[로컬 경로]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,"[메일 주소]")
    .slice(0,1200);
}
export function safeActivity(event) {
  const details = {};
  for (const [key, value] of Object.entries(event.details || {})) {
    if (!fields.has(key)) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) details[key] = value;
    else if (typeof value === "string" && /^[\w.:-]{1,100}$/.test(value)) details[key] = value;
  }
  return { level: ["debug", "info", "warn", "error"].includes(event.level) ? event.level : "info",
    scope: /^[a-z-]{1,40}$/.test(event.scope) ? event.scope : "service",
    message: redactDiagnostic(event.message),
    jobId: /^[\w-]{1,100}$/.test(event.jobId) ? event.jobId : null, details };
}

// Dashboard diagnostics only; no crawler/body/header/credential capture.
export class ActivityLog {
  constructor({ path, capacity = 5000, maxBytes = 2 * 1024 * 1024, clock = Date.now,compactRecords=true }) {
    Object.assign(this, { path, capacity, maxBytes, clock,compactRecords });
    this.rows = []; this.sequence = 0; this.bytes = 0; this.pending = Promise.resolve();
    this.closed = false; this.failedWrites = 0; this.inFlight = 0;
    this.imported=new Set();this.externalWork=null;
    this.groups=new Map();this.rawEntries=0;
  }
  async load() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      const size = (await stat(this.path)).size;
      if (size <= this.maxBytes + 16384) {
        const raw = await readFile(this.path, "utf8");
        for (const line of raw.trim().split("\n").filter(Boolean)) {
          try { const r = JSON.parse(line); if (dashboardEvent(r)&&Number.isSafeInteger(r.id) && r.id > 0) {
            const safe=safeActivity(r),groupId=aggregateLogKey(safe);
            const row={...safe,id:r.id,time:r.time,count:Number.isSafeInteger(r.count)&&r.count>0?r.count:1,firstTime:r.firstTime||r.time,...(groupId?{groupId}:{})};
            if(groupId&&this.groups.has(groupId)){const previous=this.groups.get(groupId);if(previous.id>r.id)continue;this.rows=this.rows.filter(x=>x!==previous);if(!r.count){row.count=previous.count+1;row.firstTime=previous.firstTime;}}
            this.rows.push(row);if(groupId)this.groups.set(groupId,row);this.rawEntries++;
            this.sequence = Math.max(this.sequence, r.id);
            if(r.details?.eventId)this.imported.add(r.details.eventId);
          } } catch {}
        }
        this.bytes = size;
        this.rows.sort((a,b)=>a.id-b.id);if(this.rows.length>this.capacity)this.rows=this.rows.slice(-this.capacity);
        this.groups=new Map(this.rows.filter(r=>r.groupId).map(r=>[r.groupId,r]));
      } else { await rename(this.path, this.path + ".previous"); }
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    this.sequence = Math.max(this.sequence, this.clock() * 1000);
    return this;
  }
  add(event) {
    if (this.closed||!dashboardEvent(event)) return;
    const safe=safeActivity(event),groupId=aggregateLogKey(safe),previous=groupId&&this.groups.get(groupId);
    const row = { ...safe, id: ++this.sequence, time: new Date(this.clock()).toISOString(),count:(previous?.count||0)+1,firstTime:previous?.firstTime||new Date(this.clock()).toISOString(),...(groupId?{groupId}:{}) };
    if(previous)this.rows=this.rows.filter(r=>r!==previous);
    this.rows.push(row);
    if(groupId)this.groups.set(groupId,row);
    if (this.rows.length > this.capacity){for(const old of this.rows.splice(0,this.rows.length-this.capacity))if(old.groupId)this.groups.delete(old.groupId);}
    // Do not let disk backpressure create an unbounded chain during failures.
    if (this.inFlight >= 1000) { this.failedWrites++; return row; }
    this.inFlight++;
    this.pending = this.pending.catch(() => {}).then(async () => {
      const line = JSON.stringify(row) + "\n";
      if(this.compactRecords&&(this.rawEntries>=Math.max(200,this.capacity)||this.bytes+Buffer.byteLength(line)>this.maxBytes)){await this.compact();return;}
      if(!this.compactRecords&&this.bytes+Buffer.byteLength(line)>this.maxBytes){await rename(this.path,this.path+".previous").catch(e=>{if(e.code!=="ENOENT")throw e;});this.bytes=0;}
      await appendFile(this.path, line, { mode: 0o600 });
      this.bytes += Buffer.byteLength(line);this.rawEntries++;
    }).catch(() => { this.failedWrites++; }).finally(() => { this.inFlight--; });
    return row;
  }
  async compact(){
    const kept=[];let size=0;for(const row of [...this.rows].reverse()){const line=JSON.stringify(row)+"\n",bytes=Buffer.byteLength(line);if(size+bytes>this.maxBytes)continue;size+=bytes;kept.unshift(line);}
    const temp=this.path+"."+randomUUID()+".tmp";await writeFile(temp,kept.join(""),{mode:0o600});
    await rename(this.path,this.path+".previous").catch(e=>{if(e.code!=="ENOENT")throw e;});await rename(temp,this.path);this.bytes=size;this.rawEntries=kept.length;
  }
  syncExternal(path){
    if(this.externalWork)return this.externalWork;
    this.externalWork=(async()=>{
      for(const file of [path+".previous",path])try{
        const info=await lstat(file);if(info.isSymbolicLink()||info.size>this.maxBytes+16384)continue;
        for(const line of (await readFile(file,"utf8")).split("\n")){
          let event;try{event=JSON.parse(line);}catch{continue;}
          const id=event.details?.eventId;if(!dashboardEvent(event)||typeof id!=="string"||!/^[-a-f0-9]{36}$/.test(id)||this.imported.has(id))continue;
          this.imported.add(id);this.add(event);
        }
      }catch(e){if(e.code!=="ENOENT")this.failedWrites++;}
      if(this.imported.size>20000)this.imported=new Set([...this.imported].slice(-10000));
    })().finally(()=>{this.externalWork=null;});return this.externalWork;
  }
  query({ after = 0, before = Infinity, limit = 200, level = "all", scope = "all", jobId = null } = {}) {
    const selected = this.rows.filter(r => dashboardEvent(r)&&r.id > after && r.id < before &&
      (level === "all" || r.level === level) && (scope === "all" || r.scope === scope) && (!jobId || r.jobId === jobId));
    const items = after ? selected.slice(0, limit) : selected.slice(-limit);
    return { items, oldestId: this.rows[0]?.id ?? null, latestId: this.rows.at(-1)?.id ?? 0,
      hasMore: selected.length > items.length, droppedWrites: this.failedWrites };
  }
  async close() { this.closed = true; await this.pending;if(this.compactRecords)await this.compact().catch(()=>{this.failedWrites++;}); }
}
export function updateLog(rootDir){
  return new ActivityLog({path:join(rootDir,".updates","dashboard-events.jsonl"),compactRecords:false}).load();
}
export function updateEvent(log,step,message,{level="info",...details}={}){
  return log.add({scope:"update",level,message,details:{...details,step,eventId:randomUUID()}});
}
