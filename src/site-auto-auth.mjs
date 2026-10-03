import { randomUUID } from "node:crypto";
import { siteAccountHost } from "./site-accounts.mjs";
import { ensureSiteLogin } from "./site-login.mjs";
import { parseRetryAfter } from "./retry-after.mjs";

const fail = (message, status) => Object.assign(new Error(message), { status });
const failureKind = (error) => {
  if (error.httpStatus === 429 || error.kind === "rate") return "rate";
  if (error.kind === "captcha" || error.attentionKind === "captcha")
    return "captcha";
  if (
    error.kind === "site_blocked" ||
    error.kind === "unsupported" ||
    error.attentionKind === "site_blocked"
  )
    return "site_blocked";
  if (error.kind === "verification") return "verification";
  return "authentication";
};
const validHost = (host) => {
  try {
    return siteAccountHost(host);
  } catch {
    throw fail("지원하는 사이트를 선택하세요.", 400);
  }
};

async function prepareCatalogLogin(page, host, signal) {
  const interrupted = () => {
    if (signal?.aborted)
      throw Object.assign(fail("사이트 로그인 확인이 중단됐습니다.", 409), {
        name: "AbortError",
        code: "ABORTED",
      });
  };
  interrupted();
  const current = new URL(page.url());
  const work = /^\/novel\/(\d+)\/\d+\/?$/.exec(current.pathname)?.[1];
  if (
    current.protocol !== "https:" ||
    current.hostname !== host ||
    current.username ||
    current.password ||
    current.port ||
    !work
  )
    throw Object.assign(fail("사이트 로그인 경로를 확인하세요.", 409), {
      kind: "unsupported",
      attentionKind: "site_blocked",
    });
  const target = `${current.origin}/novel/${work}`;
  const response = await page.goto(target, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  interrupted();
  const actual = new URL(page.url());
  if (
    actual.origin !== current.origin ||
    actual.username ||
    actual.password ||
    actual.pathname.replace(/\/$/, "") !== new URL(target).pathname
  )
    throw Object.assign(fail("사이트 로그인 경로가 변경됐습니다.", 409), {
      kind: "unsupported",
      attentionKind: "site_blocked",
    });
  const status = response?.status();
  if (status === 429) {
    const headers = await response.headers();
    throw Object.assign(fail("사이트 요청 대기 시간을 기다립니다.", 429), {
      kind: "rate",
      httpStatus: 429,
      retryAfterMs: Math.min(
        86400000,
        Math.max(600000, parseRetryAfter(headers["retry-after"]) || 600000),
      ),
    });
  }
  if (!Number.isSafeInteger(status) || status < 200 || status >= 400)
    throw Object.assign(fail("사이트 로그인 화면을 열 수 없습니다.", 409), {
      kind: "site_blocked",
      attentionKind: "site_blocked",
    });
}

export class SiteAutoAuth {
  constructor({
    accounts,
    siteBrowser,
    attention,
    scheduler,
    login = ensureSiteLogin,
    clock = Date.now,
    accountHostFor = (host) => host,
    gateHostFor = (host) => host,
    loginFromCatalog = false,
  }) {
    Object.assign(this, {
      accounts,
      siteBrowser,
      attention,
      scheduler,
      login,
      clock,
      accountHostFor,
      gateHostFor,
      loginFromCatalog,
    });
    this.states = new Map();
    this.active = new Map();
    this.loginControl = new Map();
    this.failedUntil = new Map();
    this.ownedSlots = new Map();
    this.browserControl = Promise.resolve();
    this.closed = false;
    this.closeWork = null;
  }

  status(host) {
    host = this.gateHost(host);
    const accountHost = this.accountHost(host);
    const state = this.states.get(host);
    return state
      ? {
          ...state,
          accountHost,
          pendingSlots: [...state.pendingSlots],
          slotResults: state.slotResults.map((result) => ({ ...result })),
        }
      : {
          host,
          accountHost,
          id: null,
          state: "idle",
          phase: "대기",
          pendingSlots: [],
          error: null,
          retryAt: null,
          failureKind: null,
          slotResults: [],
        };
  }

  update(host, patch) {
    this.states.set(host, { ...this.states.get(host), ...patch });
  }

  accountHost(host) {
    return validHost(this.accountHostFor(this.gateHost(host)));
  }

  gateHost(host) {
    return validHost(this.gateHostFor(validHost(host)));
  }

  async start(host) {
    const requestedHost = validHost(host);
    host = this.gateHost(requestedHost);
    const accountHost = this.accountHost(host);
    if (requestedHost !== host && requestedHost !== accountHost)
      throw fail("현재 수집 사이트와 계정 설정을 확인하세요.", 409);
    if (this.closed) throw fail("사이트 로그인 서비스가 종료 중입니다.", 503);
    if (this.active.has(host)) return this.status(host);
    const config = await this.accounts.status(accountHost);
    if (!config?.enabled || config.configured === false)
      throw fail("사이트 계정을 저장하고 자동 로그인을 활성화하세요.", 503);
    const site = await this.attention.get(host);
    if (!site?.held)
      throw fail("현재 이 사이트는 인증 대기 상태가 아닙니다.", 409);
    if (this.closed) throw fail("사이트 로그인 서비스가 종료 중입니다.", 503);
    if (this.active.has(host)) return this.status(host);
    const previous = this.states.get(host);
    if (
      (this.failedUntil.get(host) || 0) > this.clock() ||
      (this.failedUntil.get(accountHost) || 0) > this.clock() ||
      (previous?.retryAt && Date.parse(previous.retryAt) > this.clock())
    )
      throw fail(
        "자동 로그인 재시도는 잠시 대기 후 가능합니다. 인증 화면을 직접 사용할 수도 있습니다.",
        429,
      );
    const pendingSlots = site.requiredSlots.filter(
      (slot) => !site.verifiedSlots.includes(slot),
    );
    const state = {
      host,
      accountHost,
      id: randomUUID(),
      state: "running",
      phase: "브라우저 준비 중",
      pendingSlots,
      error: null,
      retryAt: null,
      failureKind: null,
      slotResults: [],
    };
    this.states.set(host, state);
    const controller = new AbortController();
    const operation = this.browserControl
      .catch(() => {})
      .then(() => this.run(host, controller.signal))
      .finally(() => {
        if (this.active.get(host)?.controller === controller)
          this.active.delete(host);
      });
    this.active.set(host, { controller, operation });
    this.browserControl = operation;
    return { ...state, pendingSlots: [...pendingSlots] };
  }

  async wait(host) {
    host = this.gateHost(host);
    await this.active.get(host)?.operation;
    return this.status(host);
  }

  async run(host, signal) {
    let ownedSlot = null;
    try {
      if (signal.aborted || this.closed)
        throw fail("사이트 로그인 확인이 중단됐습니다.", 409);
      const accountHost = this.accountHost(host);
      const credentials = await this.accounts.getCredentials(accountHost);
      if (!credentials) throw fail("사이트 계정 설정을 확인하세요.", 503);
      if (credentials.host !== accountHost)
        throw fail("사이트 계정과 수집 주소를 확인하세요.", 409);
      for (const slot of [...this.states.get(host).pendingSlots]) {
        if (signal.aborted)
          throw fail("사이트 로그인 확인이 중단됐습니다.", 409);
        this.update(host, { phase: `${slot}번 브라우저 준비 중` });
        const opened = await this.siteBrowser.open({ host, slot });
        ownedSlot = slot;
        this.ownedSlots.set(host, slot);
        this.update(host, { phase: `${slot}번 브라우저 로그인 확인 중` });
        let loginResult = { reused: true };
        // Collection identities and authentication origins are separate.
        // Only credentials belonging to this exact viewer can enter its jar.
        if ((opened?.viewerHost || host) !== accountHost)
          throw fail("사이트 계정과 수집 주소를 확인하세요.", 409);
        await this.siteBrowser.authenticate(async (page, target) => {
          if (
            target.host !== host ||
            target.slot !== slot ||
            (target.viewerHost || target.host) !== accountHost
          )
            throw fail("인증 브라우저가 변경됐습니다.", 409);
          if (this.loginFromCatalog)
            await prepareCatalogLogin(page, accountHost, signal);
          const result = await this.serialLogin(accountHost, () =>
            this.login({ page, credentials, signal }),
          );
          loginResult = result;
          if (!result?.authenticated)
            throw Object.assign(fail("사이트 로그인 확인이 필요합니다.", 409), {
              kind: "authentication",
            });
        });
        this.update(host, { phase: `${slot}번 회차 본문 확인 중` });
        const proof = await this.siteBrowser.check({
          reload: this.loginFromCatalog || !loginResult.reused,
        });
        if (!proof?.verified)
          throw Object.assign(
            fail("사이트 회차 본문 확인이 필요합니다.", 409),
            { kind: "verification" },
          );
        ownedSlot = null;
        this.ownedSlots.delete(host);
        const site = await this.attention.get(host);
        this.update(host, {
          pendingSlots: site.requiredSlots.filter(
            (required) => !site.verifiedSlots.includes(required),
          ),
          slotResults: [
            ...this.states.get(host).slotResults,
            { slot, status: "ready", reused: loginResult.reused === true },
          ],
        });
      }
      const site = await this.attention.get(host);
      if (
        site?.held ||
        !site?.requiredSlots?.every((slot) => site.verifiedSlots.includes(slot))
      )
        throw Object.assign(fail("사이트 회차 본문 확인이 필요합니다.", 409), {
          kind: "verification",
        });
      this.update(host, {
        state: "ready",
        phase: "사이트 로그인과 회차 본문 확인 완료",
        error: null,
        retryAt: null,
        failureKind: null,
      });
    } catch (error) {
      const retryAt = this.recordFailure(host, error);
      this.update(host, {
        state: "needs_attention",
        phase: "사이트 직접 확인 필요",
        error:
          error.kind === "captcha"
            ? "사이트 보안 확인이 필요합니다. 인증 화면에서 직접 진행하세요."
            : "자동 로그인 또는 회차 본문 확인을 완료하지 못했습니다. 계정 설정이나 인증 화면을 확인하세요.",
        retryAt,
        failureKind: failureKind(error),
        slotResults:
          ownedSlot === null
            ? this.states.get(host).slotResults
            : [
                ...this.states.get(host).slotResults,
                { slot: ownedSlot, status: "needs_attention" },
              ],
      });
    } finally {
      if (ownedSlot !== null) {
        this.ownedSlots.delete(host);
        const status = await this.siteBrowser.status().catch(() => null);
        if (status?.open && status.host === host && status.slot === ownedSlot)
          await this.siteBrowser.close().catch(() => {});
      }
    }
  }

  recordFailure(host, error) {
    host = this.gateHost(host);
    const until =
      this.clock() +
      Math.min(
        86400000,
        Math.max(
          error.httpStatus === 429 ? 600000 : 60000,
          Number(error.retryAfterMs) || 0,
        ),
      );
    this.failedUntil.set(host, until);
    this.failedUntil.set(this.accountHost(host), until);
    const retryAt = new Date(until).toISOString();
    const previous = this.states.get(host);
    if (!previous || previous.state !== "running")
      this.states.set(host, {
        host,
        id: previous?.id ?? null,
        state: "needs_attention",
        phase: "사이트 직접 확인 필요",
        error:
          "사이트 로그인 확인을 완료하지 못했습니다. 계정 설정이나 인증 화면을 확인하세요.",
        pendingSlots: previous?.pendingSlots ?? [],
        slotResults: previous?.slotResults ?? [],
        retryAt,
        failureKind: failureKind(error),
      });
    return retryAt;
  }

  serialLogin(host, operation) {
    const previous = this.loginControl.get(host) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => {
        if ((this.failedUntil.get(host) || 0) > this.clock())
          throw Object.assign(
            fail(
              "사이트 로그인 재시도는 잠시 대기 후 가능합니다. 인증 화면을 직접 확인하세요.",
              409,
            ),
            {
              code: "NEEDS_ATTENTION",
              kind: "login",
              attentionKind: "authentication",
            },
          );
        return operation();
      });
    this.loginControl.set(host, current);
    return current.finally(() => {
      if (this.loginControl.get(host) === current)
        this.loginControl.delete(host);
    });
  }

  async loginPage(page, signal) {
    if (this.closed) throw fail("사이트 로그인 서비스가 종료 중입니다.", 503);
    let url;
    try {
      url = new URL(page.url());
    } catch {
      throw Object.assign(
        fail("허용한 사이트에서 로그인 상태를 확인하세요.", 409),
        {
          code: "NEEDS_ATTENTION",
          kind: "unsupported",
          attentionKind: "site_blocked",
        },
      );
    }
    const host = validHost(url.hostname);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      throw Object.assign(
        fail("허용한 사이트에서 로그인 상태를 확인하세요.", 409),
        {
          code: "NEEDS_ATTENTION",
          kind: "unsupported",
          attentionKind: "site_blocked",
        },
      );
    const config = await this.accounts.status(host);
    if (!config?.enabled || config.configured === false) return null;
    return this.serialLogin(host, async () => {
      try {
        const credentials = await this.accounts.getCredentials(host);
        if (!credentials) return null;
        return await this.login({ page, credentials, signal });
      } catch (error) {
        this.recordFailure(host, error);
        const kind =
          error.kind === "captcha"
            ? "captcha"
            : error.kind === "rate"
              ? "rate"
              : "login";
        const safe = Object.assign(
          fail(
            "사이트 로그인 확인을 완료하지 못했습니다. 계정 설정이나 인증 화면을 확인하세요.",
            409,
          ),
          {
            code: "NEEDS_ATTENTION",
            kind,
            attentionKind: kind === "captcha" ? "captcha" : "authentication",
          },
        );
        if (error.httpStatus === 429) {
          safe.httpStatus = 429;
          safe.retryAfterMs = Math.min(
            86400000,
            Math.max(600000, Number(error.retryAfterMs) || 600000),
          );
        }
        if (signal?.aborted) {
          safe.name = "AbortError";
          safe.code = "ABORTED";
        }
        throw safe;
      }
    });
  }

  close() {
    if (this.closeWork) return this.closeWork;
    this.closed = true;
    for (const task of this.active.values()) task.controller.abort();
    const browserClose = this.ownedSlots.size
      ? this.siteBrowser.close().catch(() => {})
      : Promise.resolve();
    this.closeWork = this.finishClose(browserClose);
    return this.closeWork;
  }

  async finishClose(browserClose) {
    let timer;
    try {
      await Promise.race([
        Promise.allSettled([
          browserClose,
          ...[...this.active.values()].map((task) => task.operation),
          ...this.loginControl.values(),
        ]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
