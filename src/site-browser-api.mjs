const fail = (message, status) => Object.assign(new Error(message), { status });

// Called only after the parent API has checked the administrator session and CSRF origin.
export function createSiteBrowserRouter({ siteBrowser }) {
  return async ({ request, response, url, send, readBody }) => {
    if (!url.pathname.startsWith("/api/site-browser/")) return false;
    const name = url.pathname.slice("/api/site-browser/".length);
    const reads = ["status", "frame"],
      writes = ["open", "input", "check", "close"];
    if (
      !(request.method === "GET" && reads.includes(name)) &&
      !(request.method === "POST" && writes.includes(name))
    )
      return false;
    if (!siteBrowser)
      throw fail("사이트 인증 브라우저를 사용할 수 없습니다.", 503);
    if (name === "frame") {
      const frame = await siteBrowser.frame();
      response.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Length": frame.bytes.length,
      });
      response.end(frame.bytes);
      return true;
    }
    const input = request.method === "POST" ? await readBody(request) : null;
    const state = ["open", "input"].includes(name)
      ? await siteBrowser[name](input)
      : await siteBrowser[name]();
    send(response, 200, state, { "Cache-Control": "no-store" });
    return true;
  };
}
