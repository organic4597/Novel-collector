const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const invalid = () =>
  Object.assign(new Error("올바른 요청 주소가 필요합니다."), { status: 400 });

/** Only the local reverse proxy may describe the browser's actual protocol. */
export function requestProtocol(
  request,
  { trustProxy = false, secureCookies = false } = {},
) {
  const forwarded = request.headers?.["x-forwarded-proto"];
  if (
    trustProxy === true &&
    LOOPBACK.has(request.socket?.remoteAddress) &&
    (forwarded === "http" || forwarded === "https")
  )
    return forwarded;
  return secureCookies || request.socket?.encrypted === true ? "https" : "http";
}

export function requestOrigin(request, options = {}) {
  const host = request.headers?.host;
  if (typeof host !== "string" || !host || /[\s/@\\?#]/.test(host))
    throw invalid();
  try {
    const url = new URL(`${requestProtocol(request, options)}://${host}`);
    if (
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw invalid();
    return url.origin;
  } catch {
    throw invalid();
  }
}

export function requestSocketOrigin(request, options = {}) {
  return requestOrigin(request, options).replace(/^http/, "ws");
}
