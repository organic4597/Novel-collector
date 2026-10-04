import { cleanMessage } from "./store.mjs";

const emptyState = () => ({
  consecutiveFailures: 0,
  until: null,
  reason: null,
  jobId: null,
  cause: null,
});
const aborted = (signal) => {
  if (signal?.aborted)
    throw (
      signal.reason ??
      Object.assign(new Error("요청 대기가 중단됐습니다."), {
        name: "AbortError",
      })
    );
};

export class BackoffController {
  constructor({ store, clock = Date.now, cooldownMs = 600000 }) {
    if (
      !Number.isSafeInteger(cooldownMs) ||
      cooldownMs < 1
    )
      throw new Error("서버 요청 대기 시간이 올바르지 않습니다.");
    this.store = store;
    this.clock = clock;
    this.cooldownMs = cooldownMs;
    this.path = store.path("request-backoff.json");
    this.state = emptyState();
    this.transition = Promise.resolve();
  }
  serialized(operation) {
    const next = this.transition.catch(() => {}).then(operation);
    this.transition = next;
    return next;
  }
  async persist(next) {
    await this.store.atomic(this.path, next);
    this.state = next;
  }
  expiredState(state = this.state) {
    return state.until && Date.parse(state.until) <= this.clock()
      ? emptyState()
      : state;
  }
  async load() {
    return this.serialized(async () => {
      const saved = await this.store.json(this.path);
      if (saved) {
        // Previous versions persisted both streak pauses and server limits in
        // this file. Only explicit server-limit holds belong to the new policy.
        const serverLimit = saved.cause === "server-limit" || /\bHTTP[_\s-]*429\b|too many requests|retry-after/i.test(saved.reason || "");
        this.state = {
          consecutiveFailures:
            Number.isSafeInteger(saved.consecutiveFailures) &&
            saved.consecutiveFailures >= 0
              ? saved.consecutiveFailures
              : 0,
          until:
            serverLimit && saved.until && Number.isFinite(Date.parse(saved.until))
              ? saved.until
              : null,
          reason: saved.reason ? cleanMessage(saved.reason) : null,
          jobId: typeof saved.jobId === "string" ? saved.jobId : null,
          cause: serverLimit ? "server-limit" : null,
        };
        const next = this.expiredState();
        if (next !== this.state || saved.until !== this.state.until) await this.persist(next);
      }
      return this.snapshot();
    });
  }
  async failure({
    retryAfterMs = 0,
    reason = "본문 요청 실패",
    jobId = null,
  } = {}) {
    return this.serialized(async () => {
      const previous = this.expiredState();
      const now = this.clock();
      const consecutiveFailures = previous.consecutiveFailures + 1;
      const oldUntil = previous.until ? Date.parse(previous.until) : 0;
      const explicitDelay =
        Number.isFinite(retryAfterMs) && retryAfterMs > 0
          ? Math.ceil(retryAfterMs)
          : 0;
      const rateLimited = /\bHTTP[_\s-]*429\b|too many requests/i.test(
        String(reason),
      );
      let until = oldUntil;
      if (
        explicitDelay ||
        rateLimited
      )
        until = Math.max(
          oldUntil,
          now + Math.max(this.cooldownMs, explicitDelay),
        );
      const next = {
        consecutiveFailures,
        until: until > now ? new Date(until).toISOString() : null,
        reason: until > now && !explicitDelay && !rateLimited ? previous.reason : cleanMessage(reason),
        jobId: typeof jobId === "string" ? jobId : null,
        cause: until > now ? "server-limit" : null,
      };
      await this.persist(next);
      return {
        triggered: until > oldUntil,
        untilISO: next.until,
        remainingMs: Math.max(0, until - now),
        consecutiveFailures,
      };
    });
  }
  async success() {
    return this.serialized(async () => {
      const previous = this.expiredState();
      if (previous.consecutiveFailures || previous !== this.state)
        await this.persist({ ...previous, consecutiveFailures: 0 });
      return this.snapshot();
    });
  }
  snapshot() {
    const remainingMs = this.state.until
      ? Math.max(0, Date.parse(this.state.until) - this.clock())
      : 0;
    return {
      active: remainingMs > 0,
      until: this.state.until,
      remainingSeconds: Math.ceil(remainingMs / 1000),
      consecutiveFailures: this.state.consecutiveFailures,
      reason: this.state.reason,
    };
  }
  async clearAfterExpiry() {
    return this.serialized(async () => {
      const next = this.expiredState();
      if (next !== this.state) await this.persist(next);
      return this.snapshot();
    });
  }
  async wait(signal) {
    for (;;) {
      aborted(signal);
      await this.clearAfterExpiry();
      aborted(signal);
      const state = this.snapshot();
      if (!state.active) return state;
      const milliseconds = Math.min(
        60000,
        Math.max(1, Date.parse(state.until) - this.clock()),
      );
      await new Promise((resolve, reject) => {
        aborted(signal);
        const finish = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const timer = setTimeout(finish, milliseconds);
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(
            signal.reason ??
              Object.assign(new Error("요청 대기가 중단됐습니다."), {
                name: "AbortError",
              }),
          );
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}
