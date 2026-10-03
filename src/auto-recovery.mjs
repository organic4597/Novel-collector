const RETRYABLE_PROOF = new Set(["captcha", "verification", "rate"]);
const retryTime = (value) =>
  Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;

export class AutoRecovery {
  constructor({
    scheduler,
    accounts,
    autoAuth,
    pollMs = 250,
    maxWaitMs = 90000,
    captchaDelaysMs = [120000, 300000, 600000, 900000],
    captchaMaxAttempts = 5,
    clock = Date.now,
    onState = () => {},
  }) {
    if (
      !Array.isArray(captchaDelaysMs) ||
      captchaDelaysMs.length !== 4 ||
      !captchaDelaysMs.every(
        (delay) => Number.isSafeInteger(delay) && delay > 0,
      ) ||
      !Number.isSafeInteger(captchaMaxAttempts) ||
      captchaMaxAttempts < 1 ||
      captchaMaxAttempts > 5
    )
      throw new Error("자동 본문 확인 횟수와 대기 시간을 확인하세요.");
    Object.assign(this, {
      scheduler,
      accounts,
      autoAuth,
      pollMs,
      maxWaitMs,
      captchaDelaysMs: [...captchaDelaysMs],
      captchaMaxAttempts,
      clock,
      onState,
    });
    this.pending = new Map();
    this.suspended = new Set();
    this.states = new Map();
    this.owner = null;
    this.closed = false;
  }

  status(host) {
    return { ...(this.states.get(host) ?? { state: "idle" }) };
  }

  update(entry, patch) {
    if (this.closed) return;
    this.states.set(entry.site.host, {
      ...this.status(entry.site.host),
      attempts: entry.attempts,
      maxAttempts: entry.captcha ? this.captchaMaxAttempts : 1,
      ...patch,
    });
    const state = this.status(entry.site.host);
    try {
      this.onState({
        host: entry.site.host,
        state: state.state,
        attempts: state.attempts,
        maxAttempts: state.maxAttempts,
        failureKind: state.failureKind ?? null,
        retryAt: state.retryAt ?? null,
      });
    } catch {
      /* Operational logging must not interrupt a body check. */
    }
  }

  request(site, { force = false } = {}) {
    if (
      this.closed ||
      this.suspended.has(site?.host) ||
      !site?.held ||
      !["authentication", "unknown", "captcha"].includes(site.kind ?? "unknown")
    )
      return;
    const existing = this.pending.get(site.host);
    if (existing) {
      if (force) {
        existing.force = true;
        existing.renewBudget = true;
        if (existing.timer !== null) this.schedule(existing, this.pollMs);
      }
      return;
    }
    if (
      !force &&
      ["needs_attention", "failed"].includes(this.status(site.host).state)
    )
      return;
    if (this.states.size >= 1000 && !this.states.has(site.host)) {
      const disposable = [...this.states.keys()].find(
        (host) => !this.pending.has(host),
      );
      if (disposable) this.states.delete(disposable);
      else return;
    }
    const entry = {
      site: { ...site },
      captcha: site.kind === "captcha",
      force,
      attempts: 0,
      timer: null,
      busyUntil: this.clock() + this.maxWaitMs,
    };
    this.pending.set(site.host, entry);
    this.update(entry, { state: "waiting", retryAt: null, failureKind: null });
    this.schedule(entry, this.pollMs);
  }

  schedule(entry, delay) {
    if (this.closed || this.pending.get(entry.site.host) !== entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => {
        entry.timer = null;
        void this.attempt(entry);
      },
      Math.min(2147483647, Math.max(1, delay)),
    );
    entry.timer.unref?.();
  }

  finish(entry, patch) {
    this.update(entry, { retryAt: null, ...patch });
    clearTimeout(entry.timer);
    if (this.pending.get(entry.site.host) === entry)
      this.pending.delete(entry.site.host);
  }

  deferCooldown(entry, state) {
    const backoff = this.scheduler.backoff?.snapshot();
    const until = Math.max(
      retryTime(state.retryAt),
      backoff?.active
        ? retryTime(backoff.until) ||
            this.clock() +
              Math.max(this.pollMs, (backoff.remainingSeconds || 1) * 1000)
        : 0,
    );
    if (until <= this.clock() && !backoff?.active) return false;
    entry.busyUntil = null;
    this.update(entry, {
      state: "waiting",
      retryAt: new Date(until).toISOString(),
    });
    this.schedule(entry, Math.max(this.pollMs, until - this.clock()));
    return true;
  }

  async attempt(entry) {
    const { host } = entry.site;
    if (this.closed || this.pending.get(host) !== entry) return;
    if (entry.renewBudget) {
      entry.attempts = 0;
      entry.renewBudget = false;
    }
    let ownsBrowser = false;
    try {
      const account = await this.accounts.status(
        this.autoAuth.accountHost?.(host) || host,
      );
      const state = await this.autoAuth.status(host);
      if (this.closed) return;
      if (!account.enabled || !account.configured) {
        this.finish(entry, { state: "idle" });
        return;
      }
      if (
        !entry.force &&
        ["needs_attention", "failed"].includes(state.state) &&
        !(entry.captcha && RETRYABLE_PROOF.has(state.failureKind))
      ) {
        this.finish(entry, {
          state: "needs_attention",
          failureKind: state.failureKind ?? null,
        });
        return;
      }
      if (this.deferCooldown(entry, state)) return;
      const active = [...this.scheduler.active.values()].some((value) => {
        try {
          return new URL(value.job.url).hostname === host;
        } catch {
          return false;
        }
      });
      if (
        this.owner ||
        state.state === "running" ||
        active ||
        this.scheduler.manualSlots?.size
      ) {
        entry.busyUntil ??= this.clock() + this.maxWaitMs;
        if (this.clock() >= entry.busyUntil) {
          this.finish(entry, { state: "failed" });
          return;
        }
        this.schedule(entry, this.pollMs);
        return;
      }
      this.owner = host;
      ownsBrowser = true;
      entry.force = false;
      entry.busyUntil = null;
      this.update(entry, { state: "running", retryAt: null });
      await this.autoAuth.start(host);
      entry.attempts++;
      this.update(entry, { state: "running" });
      const result = await this.autoAuth.wait(host);
      if (this.closed) return;
      if (result.state === "ready") {
        this.finish(entry, { state: "ready", failureKind: null });
        return;
      }
      this.proofFailed(entry, result);
    } catch (error) {
      if (!this.closed) {
        const state = await Promise.resolve()
          .then(() => this.autoAuth.status(host))
          .catch(() => ({}));
        if (error.status === 429 && this.deferCooldown(entry, state)) return;
        this.finish(entry, {
          state: "failed",
          failureKind: state.failureKind ?? null,
        });
      }
    } finally {
      if (ownsBrowser && this.owner === host) this.owner = null;
    }
  }

  proofFailed(entry, result) {
    if (entry.renewBudget) {
      this.update(entry, {
        state: "waiting",
        failureKind: result.failureKind ?? null,
      });
      this.schedule(entry, this.pollMs);
      return;
    }
    if (
      !entry.captcha ||
      !RETRYABLE_PROOF.has(result.failureKind) ||
      entry.attempts >= this.captchaMaxAttempts
    ) {
      this.finish(entry, {
        state: "needs_attention",
        failureKind: result.failureKind ?? null,
      });
      return;
    }
    const until = Math.max(
      this.clock() + this.captchaDelaysMs[entry.attempts - 1],
      retryTime(result.retryAt),
    );
    this.update(entry, {
      state: "waiting",
      failureKind: result.failureKind,
      retryAt: new Date(until).toISOString(),
    });
    this.schedule(entry, until - this.clock());
  }

  close() {
    this.closed = true;
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.states.clear();
    this.suspended.clear();
  }
  suspend(host) {
    this.suspended.add(host);
    const entry = this.pending.get(host);
    if (entry) clearTimeout(entry.timer);
    this.pending.delete(host);
  }
  resume(host) {
    this.suspended.delete(host);
    const site = this.scheduler.attention?.get(host);
    if (site?.held) this.request(site, { force: true });
  }
}
