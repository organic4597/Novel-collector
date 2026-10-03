import { appendFile, readFile, rename, stat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { cleanMessage } from "./store.mjs";

const fields = new Set(["stage", "attempt", "maxAttempts", "elapsedMs", "x", "y", "code",
  "slot", "count", "loaded", "expected", "previous", "hasMore", "moreReady", "status", "method", "action"]);
export function safeActivity(event) {
  const details = {};
  for (const [key, value] of Object.entries(event.details || {})) {
    if (!fields.has(key)) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) details[key] = value;
    else if (typeof value === "string" && /^[\w.:-]{1,100}$/.test(value)) details[key] = value;
  }
  return { level: ["debug", "info", "warn", "error"].includes(event.level) ? event.level : "info",
    scope: /^[a-z-]{1,40}$/.test(event.scope) ? event.scope : "service",
    message: cleanMessage(String(event.message || ""))
      .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [생략]")
      .replace(/\b(?:cookie|token|captchaToken|pendingToken|proof|password|pin|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[인증값 생략]")
      .replace(/https?:\/\/[^\s]+/g, "[사이트 주소]").slice(0, 1200),
    jobId: /^[\w-]{1,100}$/.test(event.jobId) ? event.jobId : null, details };
}

// Bounded in-memory queries and rotating local files. No console/header/body capture.
export class ActivityLog {
  constructor({ path, capacity = 5000, maxBytes = 2 * 1024 * 1024, clock = Date.now }) {
    Object.assign(this, { path, capacity, maxBytes, clock });
    this.rows = []; this.sequence = 0; this.bytes = 0; this.pending = Promise.resolve();
    this.closed = false; this.failedWrites = 0; this.inFlight = 0;
  }
  async load() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      const size = (await stat(this.path)).size;
      if (size <= this.maxBytes + 16384) {
        const raw = await readFile(this.path, "utf8");
        for (const line of raw.trim().split("\n").filter(Boolean).slice(-this.capacity)) {
          try { const r = JSON.parse(line); if (Number.isSafeInteger(r.id) && r.id > 0) {
            this.rows.push({ ...safeActivity(r), id: r.id, time: r.time });
            this.sequence = Math.max(this.sequence, r.id);
          } } catch {}
        }
        this.bytes = size;
      } else { await rename(this.path, this.path + ".previous"); }
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    this.sequence = Math.max(this.sequence, this.clock() * 1000);
    return this;
  }
  add(event) {
    if (this.closed) return;
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
  query({ after = 0, before = Infinity, limit = 200, level = "all", scope = "all", jobId = null } = {}) {
    const selected = this.rows.filter(r => r.id > after && r.id < before &&
      (level === "all" || r.level === level) && (scope === "all" || r.scope === scope) && (!jobId || r.jobId === jobId));
    const items = after ? selected.slice(0, limit) : selected.slice(-limit);
    return { items, oldestId: this.rows[0]?.id ?? null, latestId: this.rows.at(-1)?.id ?? 0,
      hasMore: selected.length > items.length, droppedWrites: this.failedWrites };
  }
  async close() { this.closed = true; await this.pending; }
}
