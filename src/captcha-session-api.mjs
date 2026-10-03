const fail = (message, status) => Object.assign(new Error(message), { status });

// The parent API must enforce its administrator cookie and same-origin CSRF
// checks before dispatching here, exactly as for the legacy site-browser routes.
export function createCaptchaSessionRouter({ captchaSession }) {
  return async ({ request, response, url, send, readBody }) => {
    if (!url.pathname.startsWith("/api/captcha-session/")) return false;
    const name = url.pathname.slice("/api/captcha-session/".length);
    if (
      !(request.method === "GET" && ["status", "frame"].includes(name)) &&
      !(
        request.method === "POST" &&
        ["open", "input", "apply", "close", "retry"].includes(name)
      )
    )
      return false;
    if (!captchaSession)
      throw fail("사람이 사용할 인증 세션을 준비하지 못했습니다.", 503);
    if (name === "frame") {
      const frame = await captchaSession.frame();
      response.writeHead(200, {
        "Content-Type": frame.mimeType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Length": frame.bytes.length,
      });
      response.end(frame.bytes);
      return true;
    }
    const input = request.method === "POST" ? await readBody(request) : null;
    if (
      ["apply", "close", "retry"].includes(name) &&
      (!input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).length)
    )
      throw fail("이 인증 요청에는 추가 입력을 지정할 수 없습니다.", 400);
    const state = ["open", "input"].includes(name)
      ? await captchaSession[name](input)
      : await captchaSession[name]();
    send(response, name === "retry" ? 202 : 200, state, { "Cache-Control": "no-store" });
    return true;
  };
}
