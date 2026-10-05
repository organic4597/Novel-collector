import { createReadStream } from "node:fs";
import { safeId } from "./store.mjs";
import { SystemInfo } from "./system-info.mjs";
const fail = (message, status) => Object.assign(new Error(message), { status });
export function streamDownload(request, response, file) {
  const headers = {
    "Content-Type": file.mimeType,
    "Cache-Control": "private, no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `attachment; filename="download.${file.mimeType === "application/zip" ? "zip" : "txt"}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
  };
  if (file.etag) headers.ETag = file.etag;
  response.writeHead(200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(file.path);
  stream.on("error", () => response.destroy());
  response.on("close", () => stream.destroy());
  stream.pipe(response);
}
export function publicBook(book, metadata) {
  const { thumbnailUrl, ...data } = book;
  return {
    ...data,
    thumbnail: `/api/books/${encodeURIComponent(book.id)}/thumbnail`,
    metadataStatus:
      metadata?.status ??
      (book.metadataVersion === 1 ? "completed" : "pending"),
    ...(metadata?.error ? { metadataError: metadata.error } : {}),
  };
}
export function createFeatureRouter({
  store,
  scheduler,
  settings,
  downloads,
  metadata,
  profiles = null,
  recovery = null,
  systemInfo = null,
}) {
  const info = systemInfo ?? new SystemInfo({ store, settings });
  return async ({ request, response, url, send, readBody }) => {
    const method = request.method,
      parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/api/system/info" && method === "GET") {
      send(response, 200, await info.get());
      return true;
    }
    if (
      method === "POST" &&
      ["/api/queue/start", "/api/queue/pause"].includes(url.pathname)
    ) {
      await readBody(request);
      const result = url.pathname.endsWith("/start")
        ? await scheduler.startAll()
        : await scheduler.pauseAll();
      if (url.pathname.endsWith("/start") && recovery)
        for (const site of scheduler.attention?.snapshot().sites ?? [])
          if (site.held) recovery.request(site, { force: true });
      send(response, 200, result);
      return true;
    }
    if(url.pathname==="/api/queue/reorder"&&method==="POST"){
      const input=await readBody(request);
      if(!input||typeof input!=="object"||Array.isArray(input)||!Object.hasOwn(input,"beforeId"))throw fail("이동할 예약과 대상 위치를 지정하세요.",400);
      send(response,200,{jobs:await scheduler.reorder(input.jobId,input.beforeId)});return true;
    }
    if (url.pathname === "/api/settings") {
      if (!settings) throw fail("설정 서비스를 사용할 수 없습니다.", 503);
      if (method === "GET") {
        send(response, 200, settings.get());
        return true;
      }
      if (method === "PUT") {
        const updated = await settings.update(await readBody(request));
        await scheduler.configure?.({
          maxConcurrency: updated.maxConcurrency,
          chapterDelayMs: updated.chapterDelayMs,
        });
        send(response, 200, updated);
        return true;
      }
    }
    if (url.pathname === "/api/downloads" && method === "POST") {
      if (!downloads) throw fail("합본 다운로드를 사용할 수 없습니다.", 503);
      const input = await readBody(request);
      send(
        response,
        202,
        input.all === true
          ? await downloads.requestAllBundle()
          : await downloads.requestBundle(input.bookIds),
      );
      return true;
    }
    if (parts[1] === "downloads" && parts[2]) {
      safeId(parts[2]);
      if (!downloads) throw fail("합본 다운로드를 사용할 수 없습니다.", 503);
      const state = await downloads.getBundle(parts[2]);
      if (!state) throw fail("다운로드 요청을 찾을 수 없습니다.", 404);
      if (parts.length === 3 && method === "GET") {
        send(response, 200, state);
        return true;
      }
      if (
        parts.length === 4 &&
        parts[3] === "file" &&
        ["GET", "HEAD"].includes(method)
      ) {
        const file = await downloads.bundleFile(parts[2]);
        if (!file) throw fail("다운로드 파일이 아직 준비되지 않았습니다.", 409);
        streamDownload(request, response, file);
        return true;
      }
    }
    if (parts[1] === "books" && parts[2] && parts.length >= 4) {
      const id = safeId(parts[2]),
        book = await store.getBook(id);
      if (!book) throw fail("작품을 찾을 수 없습니다.", 404);
      if (
        parts[3] === "export" &&
        parts[4] === "txt" &&
        parts.length === 5 &&
        ["GET", "HEAD"].includes(method)
      ) {
        if (!downloads) throw fail("합본 다운로드를 사용할 수 없습니다.", 503);
        streamDownload(request, response, await downloads.bookTxt(id));
        return true;
      }
      if (parts.length === 4 && parts[3] === "failures" && method === "GET") {
        send(response, 200, await store.listFailures(id));
        return true;
      }
      if (
        parts.length === 4 &&
        parts[3] === "retry-failed" &&
        method === "POST"
      ) {
        const input = await readBody(request),
          failures = await store.listFailures(id);
        if (!failures.length && !(book.missingChapterCount > 0))
          throw fail("재수집할 실패·누락 회차가 없습니다.", 409);
        let selected = null;
        if (input.chapterIds != null) {
          if (
            !Array.isArray(input.chapterIds) ||
            !input.chapterIds.length ||
            input.chapterIds.length > 10000
          )
            throw fail("재수집 회차를 선택하세요.", 400);
          selected = [...new Set(input.chapterIds.map(safeId))];
          if (
            selected.some(
              (chapterId) => !failures.some((row) => row.id === chapterId),
            )
          )
            throw fail("실패 목록에 없는 회차입니다.", 400);
        }
        const result = await store.createJobs([
          {
            url: book.url,
            title: book.title,
            format: settings?.get().defaultFormat ?? "txt",
            overwrite: false,
            retryOnlyFailed: true,
            retryChapterIds: selected,
          },
        ]);
        if (!result.jobs.length)
          throw fail("이미 수집 대기열에 등록된 작품입니다.", 409);
        send(response, 201, result.jobs[0]);
        return true;
      }
      if (parts.length === 4 && parts[3] === "metadata") {
        if (!metadata) throw fail("작품 정보 갱신을 사용할 수 없습니다.", 503);
        if (method === "GET") {
          send(
            response,
            200,
            profiles?.state(id) ?? (await metadata.state(id)),
          );
          return true;
        }
        if (method === "POST") {
          await readBody(request);
          const result = await metadata.request(id);
          send(response, result.status === "pending" ? 202 : 200, result);
          return true;
        }
      }
      if (
        parts.length === 4 &&
        parts[3] === "thumbnail" &&
        ["GET", "HEAD"].includes(method)
      ) {
        const file = await metadata?.thumbnail(id);
        if (!file) throw fail("작품 표지가 없습니다.", 404);
        const headers = {
          "Content-Type": file.mimeType,
          "Cache-Control": "private, max-age=86400",
          "X-Content-Type-Options": "nosniff",
          ETag: file.etag,
        };
        if (request.headers["if-none-match"] === file.etag) {
          response.writeHead(304, headers);
          response.end();
          return true;
        }
        response.writeHead(200, headers);
        if (method === "HEAD") {
          response.end();
          return true;
        }
        const stream = createReadStream(file.path);
        stream.on("error", () => response.destroy());
        response.on("close", () => stream.destroy());
        stream.pipe(response);
        return true;
      }
    }
    return false;
  };
}
