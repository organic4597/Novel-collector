import { createHash, randomBytes } from "node:crypto";

export const RESET_CONFIRMATION = "관리자 비밀번호 초기화";
const PASSWORD_FILE = "secrets/admin-login.txt";
const CHALLENGE_TTL = 2 * 60 * 1000;
const RESET_WINDOW = 10 * 60 * 1000;
const RECOVERY_COOKIE = "collector_recovery";
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const fail = (message, status) => Object.assign(new Error(message), { status });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("hex");

/** Reverse proxies cannot grant local recovery through trusted forwarded headers. */
export function isLocalAdminRecoveryRequest(request) {
  const { socket = {}, headers = {} } = request;
  if (
    !LOOPBACK.has(socket.remoteAddress) ||
    !LOOPBACK.has(socket.localAddress) ||
    !Number.isSafeInteger(socket.localPort) ||
    socket.localPort < 1 ||
    socket.localPort > 65535
  )
    return false;
  if (
    Object.keys(headers).some((name) => {
      const key = name.toLowerCase();
      return (
        key === "forwarded" ||
        key === "via" ||
        key === "x-real-ip" ||
        key === "true-client-ip" ||
        key === "x-original-host" ||
        key.startsWith("x-forwarded-") ||
        key.startsWith("cf-")
      );
    })
  )
    return false;
  const authority = headers.host;
  if (typeof authority !== "string" || /[\s/@\\?#]/.test(authority))
    return false;
  let origin;
  try {
    const url = new URL(
      `${socket.encrypted === true ? "https" : "http"}://${authority}`,
    );
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      Number(url.port || (socket.encrypted === true ? 443 : 80)) !==
        socket.localPort ||
      url.host !== authority.toLowerCase() ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return false;
    origin = url.origin;
  } catch {
    return false;
  }
  const browserOrigin = headers.origin;
  if (browserOrigin !== undefined && browserOrigin !== origin) return false;
  if (request.method === "POST" && browserOrigin !== origin) return false;
  return (
    headers["sec-fetch-site"] === undefined ||
    ["same-origin", "none"].includes(headers["sec-fetch-site"])
  );
}
function ownerCookie(request) {
  const raw =
    typeof request.headers.cookie === "string" ? request.headers.cookie : "";
  const value = raw
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${RECOVERY_COOKIE}=`))
    ?.slice(RECOVERY_COOKIE.length + 1);
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ? value
    : null;
}
function cookieHeader(request, value) {
  return `${RECOVERY_COOKIE}=${value}; Path=/api/admin-recovery; HttpOnly; SameSite=Strict; Max-Age=${value ? 120 : 0}${request.socket.encrypted === true ? "; Secure" : ""}`;
}
const clearSessionCookie = (request) =>
  `collector_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${request.socket.encrypted === true ? "; Secure" : ""}`;

export function createAdminRecoveryRouter({
  credentials,
  sessions,
  closeBrowser = () => {},
  cookie = null,
  now = Date.now,
}) {
  let challenges = new Map(),
    issues = [],
    resets = [],
    resetting = false;
  const prune = (time) => {
    challenges = new Map(
      [...challenges].filter(([, value]) => value.expiresAt > time),
    );
    issues = issues.filter((timeIssued) => timeIssued > time - 60000);
    resets = resets.filter((timeReset) => timeReset > time - RESET_WINDOW);
  };
  return async ({ request, response, url, send, readBody }) => {
    if (url.pathname !== "/api/admin-recovery") return false;
    const available =
      credentials.recoveryAvailable?.() === true &&
      isLocalAdminRecoveryRequest(request);
    if (request.method === "GET") {
      if (!available) {
        send(response, 200, {
          localAvailable: false,
          initialPasswordFile: PASSWORD_FILE,
        });
        return true;
      }
      if (resetting)
        throw fail(
          "관리자 복구가 진행 중입니다. 완료 후 다시 시도하세요.",
          409,
        );
      const time = now();
      prune(time);
      if (issues.length >= 30 || challenges.size >= 1000)
        throw fail(
          "복구 확인 요청이 너무 많습니다. 잠시 후 다시 시도하세요.",
          429,
        );
      issues = [...issues, time];
      const owner = ownerCookie(request) || random(),
        nonce = random(),
        expiresAt = time + CHALLENGE_TTL;
      challenges = new Map([
        ...challenges,
        [hash(owner), { nonce: hash(nonce), expiresAt }],
      ]);
      send(
        response,
        200,
        {
          localAvailable: true,
          initialPasswordFile: PASSWORD_FILE,
          nonce,
          expiresAt,
        },
        { "Set-Cookie": cookieHeader(request, owner) },
      );
      return true;
    }
    if (request.method !== "POST")
      throw fail("지원하지 않는 복구 요청입니다.", 405);
    if (!available)
      throw fail(
        "관리자 복구는 서버의 직접 로컬 주소에서만 사용할 수 있습니다.",
        403,
      );
    if (resetting)
      throw fail("관리자 복구가 진행 중입니다. 완료 후 다시 시도하세요.", 409);
    const contentType = request.headers["content-type"];
    if (
      typeof contentType !== "string" ||
      contentType.split(";")[0].trim().toLowerCase() !== "application/json"
    )
      throw fail("JSON 복구 요청이 필요합니다.", 400);
    const input = await readBody(request);
    if (resetting)
      throw fail("관리자 복구가 진행 중입니다. 완료 후 다시 시도하세요.", 409);
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => !["confirmation", "nonce"].includes(key))
    )
      throw fail("복구 확인 입력이 올바르지 않습니다.", 400);
    if (input.confirmation !== RESET_CONFIRMATION)
      throw fail(`확인란에 '${RESET_CONFIRMATION}'를 정확히 입력하세요.`, 400);
    const time = now();
    prune(time);
    const owner = ownerCookie(request),
      key = owner ? hash(owner) : null,
      challenge = key ? challenges.get(key) : null;
    if (
      !challenge ||
      typeof input.nonce !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.nonce) ||
      hash(input.nonce) !== challenge.nonce
    )
      throw fail("복구 확인이 만료되었습니다. 복구 창을 다시 여세요.", 403);
    if (resets.length >= 3)
      throw fail(
        "관리자 복구를 너무 자주 요청했습니다. 10분 후 다시 시도하세요.",
        429,
      );
    resets = [...resets, time];
    challenges = new Map();
    resetting = true;
    try {
      const result = await credentials.reset();
      const binding = credentials.sessionVersion?.();
      if (binding) sessions.bind(binding);
      else sessions.clear();
      closeBrowser();
      await sessions.flush();
      send(
        response,
        200,
        { reset: true, authenticated: false, ...result },
        {
          "Set-Cookie": [
            cookieHeader(request, ""),
            cookie ? cookie("", request) : clearSessionCookie(request),
          ],
        },
      );
    } finally {
      resetting = false;
    }
    return true;
  };
}
