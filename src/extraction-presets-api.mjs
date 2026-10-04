import { safeId } from "./store.mjs";
export function createExtractionPresetsRouter({ presets }) {
  return async ({ request, response, url, send, readBody }) => {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api" || parts[1] !== "extraction-presets") return false;
    if (!presets) throw Object.assign(new Error("추출 프리셋을 사용할 수 없습니다."), { status: 503 });
    const method = request.method;
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
