import { siteAccountHost } from "./site-accounts.mjs";
const fail = (message, status) => Object.assign(new Error(message), { status });
function queryHost(url) {
  if (
    [...url.searchParams.keys()].some((key) => key !== "host") ||
    url.searchParams.getAll("host").length !== 1
  )
    throw fail("올바른 사이트 호스트를 입력하세요.", 400);
  return siteAccountHost(url.searchParams.get("host"));
}
function testHost(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== "host")
  )
    throw fail("로그인 확인 요청이 올바르지 않습니다.", 400);
  return siteAccountHost(input.host);
}
export function publicTestState(host, state = {}) {
  const states = ["idle", "running", "ready", "needs_attention", "failed"];
  const current = states.includes(state.state) ? state.state : "idle";
  const phases = {
    idle: "로그인 확인 대기",
    running: "사이트 로그인 확인 중",
    ready: "정상 로그인 확인 완료",
    needs_attention: "사이트 인증 확인 필요",
    failed: "사이트 로그인 확인 실패",
  };
  const output = {
    host,
    state: current,
    phase: phases[current],
    error: null,
    pendingSlots: [],
    retryAt: null,
    slotResults: [],
  };
  try {
    if (state.accountHost)
      output.accountHost = siteAccountHost(state.accountHost);
  } catch {
    /* Unknown destinations are not exposed as supported authentication hosts. */
  }
  for (const field of ["startedAt", "finishedAt", "lastAttemptAt"])
    if (
      typeof state[field] === "string" &&
      Number.isFinite(Date.parse(state[field]))
    )
      output[field] = new Date(state[field]).toISOString();
  for (const field of ["needsAttention", "success"])
    if (typeof state[field] === "boolean") output[field] = state[field];
  if (
    [
      "captcha",
      "authentication",
      "site_blocked",
      "rate",
      "verification",
    ].includes(state.failureKind)
  )
    output.failureKind = state.failureKind;
  if (state.error)
    output.error =
      {
        captcha: "CAPTCHA 해제가 아직 확인되지 않았습니다.",
        authentication: "사이트 계정 설정을 확인하세요.",
        rate: "사이트 요청 대기 시간을 기다립니다.",
        site_blocked: "사이트 접근 상태를 확인하고 있습니다.",
        verification: "본문 상태를 아직 확인할 수 없습니다.",
      }[output.failureKind] || "사이트 로그인 확인에 실패했습니다.";
  if (Array.isArray(state.pendingSlots))
    output.pendingSlots = [
      ...new Set(state.pendingSlots.filter((slot) => [1, 2].includes(slot))),
    ];
  if (state.retryAt && Number.isFinite(new Date(state.retryAt).getTime()))
    output.retryAt = new Date(state.retryAt).toISOString();
  if (Array.isArray(state.slotResults))
    output.slotResults = state.slotResults
      .slice(0, 2)
      .filter((slot) => slot && [1, 2].includes(slot.slot))
      .map((slot) => ({
        slot: slot.slot,
        ...(states.includes(slot.status) ? { status: slot.status } : {}),
        ...(typeof slot.success === "boolean" ? { success: slot.success } : {}),
        ...(typeof slot.reused === "boolean" ? { reused: slot.reused } : {}),
      }));
  return output;
}
// Mount after the parent application's authentication and origin checks.
export function createSiteAccountsRouter({
  accounts,
  autoAuth,
  onChanged = () => {},
}) {
  return async ({ request, response, url, send, readBody }) => {
    if (!["/api/site-account", "/api/site-account/test"].includes(url.pathname))
      return false;
    const method = request.method;
    if (["PUT", "POST"].includes(method) && url.search)
      throw fail("계정 설정과 로그인 확인은 요청 본문으로 전달하세요.", 400);
    if (url.pathname === "/api/site-account/test") {
      if (!autoAuth)
        throw fail("사이트 로그인 확인을 사용할 수 없습니다.", 503);
      if (method === "POST") {
        const host = testHost(await readBody(request));
        let state;
        try {
          state = await autoAuth.start(host);
        } catch (error) {
          if (error.status === 409)
            throw fail(
              "다른 인증 확인이 진행 중이거나 인증 대기가 해제되었습니다.",
              409,
            );
          if (error.status === 429)
            throw fail(
              "자동 로그인 재시도는 안내된 대기 시간 이후에 가능합니다.",
              429,
            );
          throw fail("사이트 로그인 확인을 시작하지 못했습니다.", 503);
        }
        send(response, 202, publicTestState(host, state));
        return true;
      }
      if (method === "GET") {
        const host = queryHost(url);
        let state;
        try {
          state = await autoAuth.status(host);
        } catch {
          throw fail("사이트 로그인 확인 상태를 읽지 못했습니다.", 503);
        }
        send(response, 200, publicTestState(host, state));
        return true;
      }
      return false;
    }
    if (!accounts) throw fail("사이트 계정 설정을 사용할 수 없습니다.", 503);
    if (method === "GET") {
      send(response, 200, accounts.status(queryHost(url)));
      return true;
    }
    if (method === "PUT") {
      const saved = await accounts.save(await readBody(request));
      try {
        await onChanged(saved);
      } catch {
        /* Saved configuration remains valid even when recovery cannot start. */
      }
      send(response, 200, saved);
      return true;
    }
    if (method === "DELETE") {
      send(response, 200, await accounts.clear(queryHost(url)));
      return true;
    }
    return false;
  };
}
