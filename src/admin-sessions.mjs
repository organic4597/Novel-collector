import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

export const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_SESSIONS = 10000,
  MAX_BYTES = 1024 * 1024;
const safeError = () =>
  Object.assign(
    new Error("관리자 로그인 세션을 안전하게 저장하거나 읽을 수 없습니다."),
    { status: 503 },
  );
const inputError = () =>
  Object.assign(new Error("올바른 관리자 로그인 세션이 필요합니다."), {
    status: 400,
  });
const tokenHash = (token) =>
  typeof token === "string" && /^[a-f0-9]{64}$/.test(token)
    ? createHash("sha256").update(token).digest("hex")
    : null;
const validExpiry = (expiry, now) =>
  Number.isSafeInteger(expiry) && expiry > 0 && expiry <= now + SESSION_TTL_MS;
const validBinding = (binding) =>
  typeof binding === "string" && /^[a-f0-9]{64}$/.test(binding);

async function replace(source, target) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(source, target);
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
        attempt >= 4
      )
        throw error;
      await wait(10 * (attempt + 1));
    }
  }
}
async function boundedRead(path) {
  let handle;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw safeError();
    await handle.chmod(0o600);
    const bytes = await handle.readFile();
    if (bytes.length > MAX_BYTES) throw safeError();
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw safeError();
  } finally {
    await handle?.close();
  }
}
function decodedSessions(record, now) {
  if (
    !record ||
    Array.isArray(record) ||
    record.version !== 1 ||
    Object.keys(record).some(
      (key) => !["version", "binding", "sessions"].includes(key),
    ) ||
    (record.binding !== undefined && !validBinding(record.binding)) ||
    !Array.isArray(record.sessions) ||
    record.sessions.length > MAX_SESSIONS
  )
    throw safeError();
  const all = new Set(),
    sessions = new Map();
  for (const entry of record.sessions) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry[0]) ||
      !validExpiry(entry[1], now) ||
      all.has(entry[0])
    )
      throw safeError();
    all.add(entry[0]);
    if (entry[1] > now) sessions.set(entry[0], entry[1]);
  }
  return sessions;
}

/** Keeps bearer cookies out of the database; only hashes and fixed expiries persist. */
export class AdminSessions {
  #path;
  #now;
  #sessions = new Map();
  #pending = Promise.resolve();
  #failure = null;
  #loaded = false;
  #mutated = false;
  #binding;
  constructor({ store = null, now = Date.now, binding = null } = {}) {
    if (binding !== null && !validBinding(binding)) throw inputError();
    this.#path = store ? store.path("admin-sessions.json") : null;
    this.#now = now;
    this.#binding = binding;
  }
  async load() {
    // Loading must never restore an invalidated disk snapshot after a failed write.
    if (this.#loaded || this.#mutated) {
      await this.flush();
      return this;
    }
    try {
      const record = this.#path ? await boundedRead(this.#path) : undefined;
      this.#sessions =
        record === undefined ? new Map() : decodedSessions(record, this.#now());
      const mismatch =
        record !== undefined && (record.binding ?? null) !== this.#binding;
      if (mismatch) this.#sessions = new Map();
      this.#loaded = true;
      this.#failure = null;
      if (
        record &&
        (mismatch || this.#sessions.size !== record.sessions.length)
      ) {
        this.#schedule();
        await this.flush();
      }
      return this;
    } catch {
      this.#sessions = new Map();
      this.#failure = safeError();
      throw this.#failure;
    }
  }
  get size() {
    return this.#sessions.size;
  }
  get(token) {
    const hash = tokenHash(token);
    if (!hash || this.#failure) return null;
    const expiry = this.#sessions.get(hash);
    if (!expiry) return null;
    if (expiry <= this.#now()) {
      this.delete(token);
      return null;
    }
    return expiry;
  }
  set(token, expiry) {
    const hash = tokenHash(token),
      now = this.#now();
    if (!hash || !validExpiry(expiry, now) || expiry <= now) throw inputError();
    this.prune(now);
    if (!this.#sessions.has(hash) && this.#sessions.size >= MAX_SESSIONS)
      throw safeError();
    this.#sessions = new Map([...this.#sessions, [hash, expiry]]);
    this.#schedule();
    return this;
  }
  delete(token) {
    const hash = tokenHash(token);
    if (!hash || !this.#sessions.has(hash)) return false;
    this.#sessions = new Map(
      [...this.#sessions].filter(([key]) => key !== hash),
    );
    this.#schedule();
    return true;
  }
  clear() {
    this.#sessions = new Map();
    this.#schedule();
  }
  bind(binding) {
    if (!validBinding(binding)) throw inputError();
    this.#binding = binding;
    this.clear();
  }
  prune(now = this.#now()) {
    if (!Number.isSafeInteger(now) || now < 0) throw inputError();
    const remaining = new Map(
      [...this.#sessions].filter(([, expiry]) => expiry > now),
    );
    const removed = this.#sessions.size - remaining.size;
    if (removed) {
      this.#sessions = remaining;
      this.#schedule();
    }
    return removed;
  }
  async flush() {
    await this.#pending;
    if (this.#failure) throw this.#failure;
  }
  #schedule() {
    this.#mutated = true;
    const text = JSON.stringify({
      version: 1,
      ...(this.#binding === null ? {} : { binding: this.#binding }),
      sessions: [...this.#sessions],
    });
    const operation = this.#pending
      .catch(() => {})
      .then(async () => {
        try {
          if (this.#path) await this.#write(text);
          this.#failure = null;
        } catch {
          this.#failure = safeError();
          throw this.#failure;
        }
      });
    this.#pending = operation;
    void operation.catch(() => {});
  }
  async #write(text) {
    if (Buffer.byteLength(text) > MAX_BYTES) throw safeError();
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
      await replace(temporary, this.#path);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
