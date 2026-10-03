import { publicTestState } from "./site-accounts-api.mjs";

export function siteAuthStatus(site, { accounts, autoAuth, recovery } = {}) {
  if (!accounts || !autoAuth) return site;
  try {
    const state = publicTestState(site.host, autoAuth.status(site.host));
    const account = accounts.status(state.accountHost || site.host);
    const queued = recovery?.status(site.host);
    const deferred =
      state.state !== "running" &&
      ((site.kind === "captcha" &&
        ["waiting", "running", "ready", "needs_attention", "failed"].includes(
          queued?.state,
        )) ||
        (["idle", "ready"].includes(state.state) &&
          ["waiting", "failed"].includes(queued?.state)));
    const failureKind = deferred ? queued.failureKind : state.failureKind;
    return {
      ...site,
      autoLogin: {
        accountHost: state.accountHost || site.host,
        configured: Boolean(account.configured),
        enabled: Boolean(account.enabled),
        state: deferred ? queued.state : state.state,
        phase: deferred
          ? site.kind === "captcha"
            ? "CAPTCHA 응답 확인"
            : queued.state === "waiting"
              ? "수집 브라우저 종료 대기"
              : "자동 인증 준비 확인 필요"
          : state.phase,
        error:
          deferred && queued.state === "failed"
            ? "자동 인증을 시작하지 못했습니다. 다시 시도하거나 계정 설정을 확인하세요."
            : state.error,
        retryAt: state.retryAt,
        ...(deferred ? { retryAt: queued.retryAt ?? null } : {}),
        ...([
          "captcha",
          "authentication",
          "site_blocked",
          "rate",
          "verification",
        ].includes(failureKind)
          ? { failureKind }
          : {}),
        ...(Number.isSafeInteger(queued?.attempts) &&
        queued.attempts >= 0 &&
        queued.attempts <= 5
          ? { attempts: queued.attempts }
          : {}),
        ...(Number.isSafeInteger(queued?.maxAttempts) &&
        queued.maxAttempts >= 0 &&
        queued.maxAttempts <= 5
          ? { maxAttempts: queued.maxAttempts }
          : {}),
      },
    };
  } catch {
    return {
      ...site,
      autoLogin: {
        configured: false,
        enabled: false,
        state: "idle",
        phase: "사이트 계정 확인 필요",
        error: null,
        retryAt: null,
      },
    };
  }
}
