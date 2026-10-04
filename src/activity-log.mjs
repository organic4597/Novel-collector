import { appendFile, readFile, rename, stat, mkdir,lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname,join } from "node:path";
import { cleanMessage } from "./store.mjs";

const fields = new Set(["stage", "attempt", "maxAttempts", "elapsedMs", "x", "y", "code",
  "slot", "count", "loaded", "expected", "previous", "hasMore", "moreReady", "status", "method", "action", "step","exitCode","errorCode","eventId","targetVersion","component"]);
const dashboardScopes=new Set(["api","dashboard","ui","update","service","instance","settings","presets","auth"]);
export const dashboardEvent=event=>dashboardScopes.has(event.scope||"service");
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
  constructor({ path, capacity = 5000, maxBytes = 2 * 1024 * 1024, clock = Date.now }) {
    Object.assign(this, { path, capacity, maxBytes, clock });
    this.rows = []; this.sequence = 0; this.bytes = 0; this.pending = Promise.resolve();
    this.closed = false; this.failedWrites = 0; this.inFlight = 0;
    this.imported=new Set();this.externalWork=null;
  }
  async load() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      const size = (await stat(this.path)).size;
      if (size <= this.maxBytes + 16384) {
        const raw = await readFile(this.path, "utf8");
        for (const line of raw.trim().split("\n").filter(Boolean).slice(-this.capacity)) {
          try { const r = JSON.parse(line); if (dashboardEvent(r)&&Number.isSafeInteger(r.id) && r.id > 0) {
            this.rows.push({ ...safeActivity(r), id: r.id, time: r.time });
            this.sequence = Math.max(this.sequence, r.id);
            if(r.details?.eventId)this.imported.add(r.details.eventId);
          } } catch {}
        }
        this.bytes = size;
      } else { await rename(this.path, this.path + ".previous"); }
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    this.sequence = Math.max(this.sequence, this.clock() * 1000);
    return this;
  }
  add(event) {
    if (this.closed||!dashboardEvent(event)) return;
    const row = { ...safeActivity(event), id: ++this.sequence, time: new Date(this.clock()).toISOString() };
    this.rows.push(row);
    if (this.rows.length > this.capacity) this.rows.splice(0, this.rows.length - this.capacity);
    // Do not let disk backpressure create an unbounded chain during failures.
    if (this.inFlight >= 1000) { this.failedWrites++; return row; }
    this.inFlight++;
    this.pending = this.pending.catch(() => {}).then(async () => {
      const line = JSON.stringify(row) + "\n";
      if (this.bytes + Buffer.byteLength(line) > this.maxBytes) {
        await rename(this.path, this.path + ".previous").catch(e => { if (e.code !== "ENOENT") throw e; });
        this.bytes = 0;
      }
      await appendFile(this.path, line, { mode: 0o600 });
      this.bytes += Buffer.byteLength(line);
    }).catch(() => { this.failedWrites++; }).finally(() => { this.inFlight--; });
    return row;
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
  async close() { this.closed = true; await this.pending; }
}
export function updateLog(rootDir){
  return new ActivityLog({path:join(rootDir,".updates","dashboard-events.jsonl")}).load();
}
export function updateEvent(log,step,message,{level="info",...details}={}){
  return log.add({scope:"update",level,message,details:{...details,step,eventId:randomUUID()}});
}
