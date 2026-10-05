const SIX_HOURS = 6 * 60 * 60 * 1000;
export const SESSION_REFRESH_MS = 12 * 60 * 60 * 1000;
const ORIGINS = new Set(["https://sbxh9.com", "https://toki32.com"]);
const fail = (message, status = 409) =>
  Object.assign(new Error(message), { status });

function validateTarget(slot, origin) {
  if (![1, 2].includes(slot) || !ORIGINS.has(origin))
    throw fail("지원하는 수집 슬롯과 HTTPS 사이트 주소를 선택하세요.", 400);
}
function validRelease(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== "discard") ||
    (input.discard !== undefined && typeof input.discard !== "boolean")
  )
    throw fail("브라우저 반환 옵션을 확인하세요.", 400);
}

// This pool retains live browser objects, including the original Page. It does
// not export or inspect cookies, storage, credentials, or CAPTCHA grants.
export class CollectionContexts {
  constructor({
    clock = () => Date.now(),
    idleMs = SIX_HOURS,
    closeTimeoutMs = 3000,
  } = {}) {
    if (
      !Number.isSafeInteger(idleMs) ||
      idleMs <= 0 ||
      idleMs > SIX_HOURS ||
      !Number.isSafeInteger(closeTimeoutMs) ||
      closeTimeoutMs <= 0 ||
      closeTimeoutMs > 10000 ||
      typeof clock !== "function"
    )
      throw fail("브라우저 보관 시간과 종료 제한 시간을 확인하세요.", 400);
    Object.assign(this, { clock, idleMs, closeTimeoutMs });
    this.entries = new Map();
    this.deadPages = new WeakSet();
    this.deadContexts = new WeakSet();
    this.closures = new WeakMap();
    this.closing = false;
    this.closePromise = null;
    this.refreshTimer = null;
    this.refreshWork = null;
    this.lastRefreshAt = null;
    this.nextRefreshAt = null;
  }

  refreshDue(entry) {
    return !!entry.refreshRequested || this.clock() >= entry.createdAt + SESSION_REFRESH_MS;
  }

  refreshStatus() {
    return { intervalMs: SESSION_REFRESH_MS, lastRefreshAt: this.lastRefreshAt,
      nextRefreshAt: this.nextRefreshAt,
      pendingSlots: [...this.entries.values()].filter(entry => entry.busy && this.refreshDue(entry)).map(entry => entry.slot) };
  }

  async refreshIdle() {
    this.available();
    let closed = 0, deferred = 0;
    for (const slot of this.entries.keys()) {
      const entry = this.entries.get(slot);
      if (!entry?.context) continue;
      if (entry.busy) {
        this.set(slot, { ...entry, refreshRequested: true });
        deferred++;
      } else {
        if (await this.retire({ ...entry, refreshRequested: true })) closed++;
        else deferred++;
      }
    }
    return { closed, deferred };
  }

  startRefresh({ afterRefresh = async () => {}, onEvent = () => {} } = {}) {
    if (this.refreshTimer || this.refreshWork || this.closing) return;
    const schedule = () => {
      if (this.closing) return;
      this.nextRefreshAt = this.clock() + SESSION_REFRESH_MS;
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null;
        this.refreshWork = (async () => {
          try {
            const state = await this.refreshIdle();
            await afterRefresh();
            this.lastRefreshAt = this.clock();
            onEvent({ scope: "service", level: "info", message: `12시간 브라우저 연결 갱신: ${state.closed}개 정리 · 사용 중 ${state.deferred}개는 안전한 시점에 갱신`, details: { stage: "SESSION_REFRESH", count: state.closed } });
          } catch {
            if (!this.closing) onEvent({ scope: "service", level: "error", message: "정기 브라우저 연결 갱신을 완료하지 못했습니다.", details: { stage: "SESSION_REFRESH", errorCode: "SESSION_REFRESH_FAILED" } });
          } finally {
            this.refreshWork = null;
            schedule();
          }
        })();
      }, SESSION_REFRESH_MS);
      this.refreshTimer.unref?.();
    };
    schedule();
  }

  set(slot, entry) {
    const entries = new Map(this.entries);
    if (entry) entries.set(slot, entry);
    else entries.delete(slot);
    this.entries = entries;
  }

  available() {
    if (this.closing) throw fail("수집 브라우저 보관함이 종료 중입니다.", 503);
  }

  usable(entry, allowBlank = false) {
    try {
      const { context, page, origin } = entry;
      if (
        !context ||
        !page ||
        typeof context.close !== "function" ||
        typeof page.context !== "function" ||
        page.context() !== context ||
        typeof page.isClosed !== "function" ||
        page.isClosed() ||
        this.deadPages.has(page) ||
        this.deadContexts.has(context) ||
        (typeof context.pages === "function" && !context.pages().includes(page))
      )
        return false;
      const value = page.url();
      if (allowBlank && value === "about:blank") return true;
      const url = new URL(value);
      return (
        url.origin === origin &&
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port
      );
    } catch {
      return false;
    }
  }

  record({ slot, origin, context, page, response = null }) {
    const responseBox = { value: response };
    const pageClosed = () => this.deadPages.add(page);
    const contextClosed = () => this.deadContexts.add(context);
    const navigated = (value) => {
      try {
        if (
          value.request().isNavigationRequest() &&
          value.frame() === page.mainFrame()
        )
          responseBox.value = value;
      } catch {}
    };
    page.on?.("close", pageClosed);
    page.on?.("crash", pageClosed);
    context.on?.("close", contextClosed);
    page.on?.("response", navigated);
    return {
      slot,
      origin,
      context,
      page,
      responseBox,
      createdAt: this.clock(),
      generation: Symbol(),
      busy: false,
      timer: null,
      idleAt: this.clock(),
      leaseToken: null,
      detach: () => {
        page.off?.("close", pageClosed);
        page.off?.("crash", pageClosed);
        context.off?.("close", contextClosed);
        page.off?.("response", navigated);
      },
    };
  }

  park(entry, idleAt = this.clock()) {
    clearTimeout(entry.timer);
    const generation = entry.generation;
    const timer = setTimeout(
      () => {
        const current = this.entries.get(entry.slot);
        if (!current || current.generation !== generation || current.busy)
          return;
        if (this.clock() < Math.min(current.idleAt + this.idleMs, current.createdAt + SESSION_REFRESH_MS)) {
          this.park(current, current.idleAt);
          return;
        }
        void this.retire(current).catch(() => {});
      },
      Math.max(1, Math.min(idleAt + this.idleMs, entry.createdAt + SESSION_REFRESH_MS) - this.clock()),
    );
    timer.unref?.();
    const parked = { ...entry, busy: false, leaseToken: null, idleAt, timer };
    this.set(entry.slot, parked);
    return parked;
  }

  async closeBounded(entry) {
    if (!entry.context) return true;
    let pending = this.closures.get(entry.context);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => entry.context.close())
        .then(
          () => true,
          () => this.deadContexts.has(entry.context),
        );
      this.closures.set(entry.context, pending);
    }
    let timer;
    try {
      return await Promise.race([
        pending,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), this.closeTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async retire(entry, { reserve = false } = {}) {
    clearTimeout(entry.timer);
    const retiring = {
      ...entry,
      busy: true,
      leaseToken: Symbol(),
      timer: null,
      retiring: true,
    };
    this.set(entry.slot, retiring);
    const done = await this.closeBounded(retiring);
    const remove = () => {
      const current = this.entries.get(entry.slot);
      if (current?.generation === entry.generation && current.retiring)
        this.set(entry.slot, null);
      entry.detach?.();
    };
    if (done && reserve && !this.closing) {
      entry.detach?.();
      this.set(entry.slot, {
        slot: entry.slot,
        origin: entry.origin,
        busy: true,
        generation: Symbol(),
        leaseToken: Symbol(),
        context: null,
      });
    } else if (done) remove();
    else {
      // A timed-out native close is still running. Keep the slot exclusive so
      // a second persistent browser cannot race it for the same profile.
      void this.closures.get(entry.context)?.then((closed) => {
        if (closed) remove();
      });
    }
    return done;
  }

  async offer({ slot, origin, context, page, response = null } = {}) {
    validateTarget(slot, origin);
    this.available();
    if (!this.usable({ origin, context, page }))
      throw fail(
        "확인한 사이트의 실제 브라우저 화면만 보관할 수 있습니다.",
        400,
      );
    const current = this.entries.get(slot);
    if (current?.busy)
      throw fail("이 수집 슬롯은 다른 작업에서 사용 중입니다.");
    if (current?.context === context) {
      if (current.page !== page || current.origin !== origin)
        throw fail("기존 슬롯과 같은 브라우저 화면을 사용하세요.");
      if (response !== null) current.responseBox.value = response;
      if (this.refreshDue(current)) { await this.retire(current); return; }
      this.park(current);
      return;
    }
    if (current && !(await this.retire(current, { reserve: true })))
      throw fail("이전 브라우저의 종료를 기다려 주세요.", 503);
    this.available();
    this.park(this.record({ slot, origin, context, page, response }));
  }

  async acquire({ slot, origin, open } = {}) {
    validateTarget(slot, origin);
    this.available();
    if (typeof open !== "function")
      throw fail("수집 브라우저 생성기를 설정하세요.", 400);
    const current = this.entries.get(slot);
    if (current?.busy)
      throw fail("이 수집 슬롯은 다른 작업에서 사용 중입니다.");
    if (current && current.origin === origin && this.usable(current) && !this.refreshDue(current))
      return this.lease(current);
    if (current && !(await this.retire(current, { reserve: true })))
      throw fail("이전 브라우저의 종료를 기다려 주세요.", 503);
    this.available();
    const reservation = {
      slot,
      origin,
      busy: true,
      generation: Symbol(),
      leaseToken: Symbol(),
      context: null,
    };
    this.set(slot, reservation);
    let opened;
    try {
      opened = await open();
      if (this.closing || !this.usable({ ...opened, origin }, true))
        throw Error();
      const record = this.record({ ...opened, slot, origin });
      this.set(slot, record);
      return this.lease(record);
    } catch (error) {
      if (opened?.context && this.entries.get(slot) === reservation)
        await this.retire({
          ...reservation,
          context: opened.context,
          page: opened.page,
        });
      else if (opened?.context)
        await this.closeBounded({ context: opened.context });
      else if (this.entries.get(slot) === reservation) this.set(slot, null);
      throw Object.assign(fail("수집 브라우저를 준비하지 못했습니다.", 503), { cause: error });
    }
  }

  lease(record) {
    clearTimeout(record.timer);
    const leaseToken = Symbol(),
      active = { ...record, busy: true, timer: null, leaseToken };
    this.set(record.slot, active);
    let released = false;
    const pool = this;
    return {
      context: record.context,
      page: record.page,
      get refreshDue() {
        const current = pool.entries.get(record.slot);
        return current?.leaseToken === leaseToken && pool.refreshDue(current);
      },
      get response() {
        return record.responseBox.value;
      },
      release: async (input = {}) => {
        validRelease(input);
        if (released) return;
        released = true;
        const current = this.entries.get(record.slot);
        if (
          current?.leaseToken !== leaseToken ||
          current.context !== record.context
        )
          return;
        if (input.discard || this.closing || !this.usable(current) || this.refreshDue(current))
          await this.retire(current);
        else this.park(current);
      },
    };
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    clearTimeout(this.refreshTimer);
    this.nextRefreshAt = null;
    this.closePromise = Promise.all(
      [...this.entries.values()].map((entry) => this.retire(entry)),
    ).then(() => undefined);
    return this.closePromise;
  }
}
