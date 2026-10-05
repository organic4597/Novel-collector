import { safeId } from "./store.mjs";
export function createExtractionPresetsRouter({ presets }) {
  return async ({ request, response, url, send, readBody }) => {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api" || parts[1] !== "extraction-presets") return false;
    if (!presets) throw Object.assign(new Error("추출 프리셋을 사용할 수 없습니다."), { status: 503 });
    const method = request.method;
    if (parts.length === 3 && parts[2] === "defaults") {
      if (url.search) throw Object.assign(new Error("기본 프리셋 요청에는 쿼리를 사용하지 않습니다."), { status: 400 });
      if (method === "GET") { send(response, 200, presets.defaults()); return true; }
      if (method === "POST") {
        const input = await readBody(request);
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "defaultId") || typeof input.defaultId !== "string" || !input.defaultId || input.defaultId.length > 100)
          throw Object.assign(new Error("추가할 기본 프리셋을 선택하세요."), { status: 400 });
        send(response, 201, await presets.addDefault(input.defaultId)); return true;
      }
      throw Object.assign(new Error("기본 프리셋은 조회하거나 복사해서 추가할 수 있습니다."), { status: 405 });
    }
    if (parts.length === 2 && method === "GET") { send(response, 200, presets.list()); return true; }
    if (parts.length === 2 && method === "POST") { send(response, 201, await presets.save(await readBody(request))); return true; }
    if (parts.length === 3) {
      const id = safeId(parts[2]);
      if (method === "GET") { send(response, 200, presets.get(id)); return true; }
      if (method === "PUT") { send(response, 200, await presets.save(await readBody(request), id)); return true; }
      if (method === "DELETE") { send(response, 200, await presets.remove(id)); return true; }
    }
    return false;
  };
}
