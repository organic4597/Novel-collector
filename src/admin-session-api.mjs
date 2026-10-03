import { randomBytes } from "node:crypto";
const fail = (message, status) => Object.assign(new Error(message), { status });

export function createAdminSessionRouter({
  sessions,
  credentials,
  authenticated,
  cookie,
  ttlMs,
  attempts,
  address,
  closeBrowser,
}) {
  return async ({ request, response, url, send, readBody }) => {
    if (url.pathname === "/api/session" && request.method === "GET") {
      const valid = !!authenticated(request);
      await sessions.flush();
      send(response, 200, { authenticated: valid });
      return true;
    }
    if (url.pathname === "/api/login" && request.method === "POST") {
      const peer = address(request),
        previous = attempts.get(peer);
      if (previous && previous.until > Date.now() && previous.count >= 10)
        throw fail("로그인 시도가 너무 많습니다. 잠시 후 재시도하세요.", 429);
      const input = await readBody(request);
      if (typeof input.password !== "string" || input.password.length > 1024)
        throw fail("인증 실패", 401);
      if (!credentials.verify(input.password)) {
        const failed =
          previous?.until > Date.now()
            ? previous
            : { count: 0, until: Date.now() + 60000 };
        attempts.set(peer, { ...failed, count: failed.count + 1 });
        throw fail("인증 실패", 401);
      }
      attempts.delete(peer);
      sessions.prune(Date.now());
      const token = randomBytes(32).toString("hex");
      sessions.set(token, Date.now() + ttlMs);
      await sessions.flush();
      send(
        response,
        200,
        { authenticated: true },
        { "Set-Cookie": cookie(token, request) },
      );
      return true;
    }
    if (
      !["/api/logout", "/api/settings/password"].includes(url.pathname) ||
      request.method !== "POST"
    )
      return false;
    const token = authenticated(request);
    if (!token) throw fail("로그인이 필요합니다.", 401);
    if (url.pathname === "/api/logout") {
      sessions.delete(token);
      closeBrowser();
      await sessions.flush();
      send(
        response,
        200,
        { authenticated: false },
        { "Set-Cookie": cookie("", request) },
      );
      return true;
    }
    const result = await credentials.change(await readBody(request));
    const binding = credentials.sessionVersion?.();
    if (binding) sessions.bind(binding);
    else sessions.clear();
    closeBrowser();
    const next = randomBytes(32).toString("hex");
    sessions.set(next, Date.now() + ttlMs);
    await sessions.flush();
    send(response, 200, result, { "Set-Cookie": cookie(next, request) });
    return true;
  };
}
