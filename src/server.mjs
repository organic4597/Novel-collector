import { createServer } from "node:http";
import { readFile, mkdir, writeFile, chmod,access } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { dirname, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { FolderStore, safeId, cleanMessage } from "./store.mjs";
import { Scheduler } from "./queue.mjs";
import { MemoryCredentials, openCredentials } from "./auth.mjs";
import { SettingsStore } from "./settings.mjs";
import { ExtractionPresets } from "./extraction-presets.mjs";
import { createExtractionPresetsRouter } from "./extraction-presets-api.mjs";
import { Updates } from "./updates.mjs";
import { APP_VERSION } from "./version.mjs";
import { createUpdatesRouter } from "./updates-api.mjs";
import { atomicJson } from "./update-files.mjs";
import { dashboardRoute,clientEvents } from "./dashboard-audit.mjs";
import { InstanceControl } from "./instance-control.mjs";
import { isWebtoonUrl, webtoonSource, validDiscoveryId } from "./webtoon-source.mjs";
import { webtoonPreset } from "./webtoon-runtime.mjs";
import { LibraryDownloads } from "./library-downloads.mjs";
import { createFeatureRouter, publicBook } from "./features-api.mjs";
import { BackoffController } from "./request-backoff.mjs";
import { SiteAttention } from "./site-attention.mjs";
import { createSiteBrowserRouter } from "./site-browser-api.mjs";
import { SiteAccounts } from "./site-accounts.mjs";
import { createSiteAccountsRouter } from "./site-accounts-api.mjs";
import { JobProfiles } from "./job-profiles.mjs";
import { siteAuthStatus } from "./site-auth-status.mjs";
import { ViewerOrigins } from "./viewer-origins.mjs";
import { createCaptchaSessionRouter } from "./captcha-session-api.mjs";
import { AdminSessions, SESSION_TTL_MS } from "./admin-sessions.mjs";
import { createAdminSessionRouter } from "./admin-session-api.mjs";
import { createAdminRecoveryRouter } from "./admin-recovery.mjs";
import { retainedBrowserOptions } from "./browser-retention.mjs";
import {
  requestProtocol,
  requestOrigin,
  requestSocketOrigin,
} from "./request-origin.mjs";
import {
  activeSourceStatus,
  createSourceSessions,
  sourceAccountChanged,
} from "./source-runtime.mjs";

const BASE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_BODY = 2 * 1024 * 1024;
const HTTP_ERROR = (message, status) =>
  Object.assign(new Error(message), { status });
export function requestAddress(request, trustProxy = false) {
  const peer = request.socket.remoteAddress;
  const forwarded = request.headers["x-real-ip"];
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer);
  return trustProxy &&
    loopback &&
    typeof forwarded === "string" &&
    isIP(forwarded)
    ? forwarded
    : peer;
}
function equal(a, b) {
  const left = Buffer.from(String(a ?? "")),
    right = Buffer.from(String(b ?? ""));
  return left.length === right.length && timingSafeEqual(left, right);
}
async function body(request) {
  const bytes = await new Promise((resolve, reject) => {
    let size = 0,
      tooLarge = false;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        if (!tooLarge) {
          tooLarge = true;
          chunks.length = 0;
          reject(HTTP_ERROR("요청 본문이 너무 큽니다.", 400));
        }
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks));
    });
    request.once("error", reject);
    request.once("aborted", () =>
      reject(HTTP_ERROR("요청이 중단됐습니다.", 400)),
    );
  });
  try {
    const parsed = JSON.parse(bytes.toString() || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw Error();
    return parsed;
  } catch {
    throw HTTP_ERROR("올바른 JSON 객체가 필요합니다.", 400);
  }
}
export function createApp({
  store,
  scheduler,
  adminPassword,
  agentToken = null,
  publicDir = join(BASE, "public"),
  secureCookies = false,
  sessionTtlMs = SESSION_TTL_MS,
  sessionStore = null,
  requestLimit = 600,
  requestWindowMs = 60 * 1000,
  trustProxy = false,
  discovery = null,
  credentials = null,
  settings = null,
  downloads = null,
  metadata = null,
  siteBrowser = null,
  accounts = null,
  autoAuth = null,
  profiles = null,
  recovery = null,
  captchaSession = null,
  viewerOrigins = null,
  activity = null,
  extractionPresets = null,
  updates = null,
  startupIdentity = null,
}) {
  const healthIdentity={version:APP_VERSION,channel:startupIdentity?.version===APP_VERSION?startupIdentity.channel:"stable",commit:startupIdentity?.version===APP_VERSION?startupIdentity.commit:null};
  if (!credentials && (typeof adminPassword !== "string" || !adminPassword))
    throw Error("관리자 인증 설정이 필요합니다.");
  if (
    !Number.isSafeInteger(sessionTtlMs) ||
    sessionTtlMs < 1 ||
    sessionTtlMs > SESSION_TTL_MS
  )
    throw Error("관리자 로그인 유지 시간은 최대 6시간입니다.");
  if (
    !Number.isSafeInteger(requestLimit) ||
    requestLimit < 1 ||
    !Number.isSafeInteger(requestWindowMs) ||
    requestWindowMs < 1
  )
    throw Error("올바른 요청 제한 설정이 필요합니다.");
  const credentialService =
    credentials ?? new MemoryCredentials({ password: adminPassword });
  const jobProfiles =
    profiles ?? (metadata ? new JobProfiles({ store, metadata }) : null);
  const prepareJob=input=>{
    if(input?.presetSnapshot||input?.presetHash)throw HTTP_ERROR("예약 프리셋은 서버에서 확정합니다. presetId만 선택하세요.",400);
    if(!isWebtoonUrl(input?.url))return input;
    const source=webtoonSource(input.url);
    return{...input,...webtoonPreset(extractionPresets,new URL(source.url).origin,input.presetId||null,source.contentType)};
  };
  const featureRouter = createFeatureRouter({
    store,
    scheduler,
    settings,
    downloads,
    metadata,
    profiles: jobProfiles,
    recovery,
  });
  const siteBrowserRouter = createSiteBrowserRouter({ siteBrowser });
  const captchaRouter = createCaptchaSessionRouter({ captchaSession });
  const presetsRouter = createExtractionPresetsRouter({ presets: extractionPresets });
  const updatesRouter = createUpdatesRouter({ updates, activity });
  const siteAccountsRouter = createSiteAccountsRouter({
    accounts,
    autoAuth,
    onChanged: sourceAccountChanged({ scheduler, recovery, autoAuth }),
  });
  const sessions = sessionStore || new AdminSessions(),
    attempts = new Map(),
    requests = new Map();
  const maximumTrackedAddresses = 10000;
  let nextSweep = 0;
  const requestRetrySeconds = (address) => {
    const now = Date.now();
    if (now >= nextSweep || requests.size >= maximumTrackedAddresses) {
      for (const [key, entry] of requests)
        if (entry.until <= now) requests.delete(key);
      for (const [key, entry] of attempts)
        if (entry.until <= now) attempts.delete(key);
      nextSweep = now + requestWindowMs;
    }
    const previous = requests.get(address);
    if (!previous && requests.size >= maximumTrackedAddresses)
      return Math.max(1, Math.ceil(requestWindowMs / 1000));
    const current =
      previous?.until > now
        ? previous
        : { count: 0, until: now + requestWindowMs };
    if (current.count >= requestLimit)
      return Math.max(1, Math.ceil((current.until - now) / 1000));
    requests.set(address, { ...current, count: current.count + 1 });
    return 0;
  };
  const authenticated = (request) => {
    const cookies = request.headers.cookie ?? "";
    const token = cookies
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("collector_session="))
      ?.slice(18);
    const expires = sessions.get(token);
    if (!expires || expires < Date.now()) {
      sessions.delete(token);
      return null;
    }
    return token;
  };
  const originOptions = { secureCookies, trustProxy };
  const cookie = (token, request) =>
    `collector_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? Math.floor(sessionTtlMs / 1000) : 0}; Expires=${new Date(token ? Date.now() + sessionTtlMs : 0).toUTCString()}${requestProtocol(request, originOptions) === "https" ? "; Secure" : ""}`;
  const closeAdminBrowser = () => {
    void captchaSession?.close?.()?.catch(() => {});
    if (siteBrowser) void siteBrowser.close().catch(() => {});
  };
  const adminRecoveryRouter = createAdminRecoveryRouter({
    sessions,
    credentials: credentialService,
    cookie,
    closeBrowser: closeAdminBrowser,
  });
  const adminRouter = createAdminSessionRouter({
    sessions,
    credentials: credentialService,
    authenticated,
    cookie,
    ttlMs: sessionTtlMs,
    attempts,
    address: (request) => requestAddress(request, trustProxy),
    closeBrowser: closeAdminBrowser,
  });
  const send = (response, status, value, headers = {}) => {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    });
    response.end(JSON.stringify(value));
  };
  let jobsSnapshot = null, jobsAt = 0, jobsWork = null;
  const recordActivity = event => { try { activity?.add?.(event); } catch {} };
  const dashboardJobs = async () => {
    if (jobsSnapshot && Date.now() - jobsAt < 750) return jobsSnapshot;
    if (!jobsWork) jobsWork = store.listJobs().then(jobs => { jobsSnapshot = jobs; jobsAt = Date.now(); return jobs; })
      .finally(() => { jobsWork = null; });
    return jobsWork;
  };
  const app = createServer(async (request, response) => {
    const started=Date.now();let auditUrl;try{auditUrl=new URL(request.url,"http://localhost");}catch{auditUrl={pathname:"/invalid"};}const auditRoute=dashboardRoute(auditUrl.pathname);
    const audited=auditUrl.pathname.startsWith("/api/")&&!(["/api/activity","/api/dashboard-log","/api/health","/api/updates/log"].includes(auditUrl.pathname)||auditUrl.pathname.startsWith("/api/agents/"));
    if(audited)response.once("finish",()=>recordActivity({scope:"api",level:response.statusCode>=500?"error":response.statusCode>=400?"warn":"info",message:`${request.method} ${auditRoute} · ${response.statusCode}`,details:{method:request.method,status:response.statusCode,elapsedMs:Date.now()-started}}));
    try {
      const retryAfterSeconds = requestRetrySeconds(
        requestAddress(request, trustProxy),
      );
      if (retryAfterSeconds) {
        request.resume();
        return send(
          response,
          429,
          {
            error: "요청이 너무 많습니다. 잠시 후 재시도하세요.",
            retryAfterSeconds,
          },
          { "Retry-After": String(retryAfterSeconds) },
        );
      }
      const url = new URL(request.url, "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = request.method;
      if(url.pathname==="/api/health"&&method==="GET")return send(response,200,{ok:true,...healthIdentity});
      if (url.pathname.startsWith("/api")) {
        if (method !== "GET" && request.headers.origin) {
          let origin;
          try {
            origin = new URL(request.headers.origin);
          } catch {
            throw HTTP_ERROR("잘못된 요청 출처입니다.", 403);
          }
          if (origin.host !== request.headers.host)
            throw HTTP_ERROR("다른 사이트에서 보낸 요청입니다.", 403);
        }
        if (await adminRecoveryRouter({ request, response, url, send, readBody: body }))
          return;
        if (await adminRouter({ request, response, url, send, readBody: body }))
          return;
        if (parts[1] === "agents") {
          if (
            !agentToken ||
            !equal(request.headers.authorization, "Bearer " + agentToken)
          )
            throw HTTP_ERROR("워커 인증이 필요합니다.", 401);
          if (method !== "POST")
            throw HTTP_ERROR("경로를 찾을 수 없습니다.", 404);
          const input = await body(request);
          safeId(input.clientId);
          if (parts.length === 3 && parts[2] === "claim")
            return send(response, 200, await scheduler.claim(input.clientId));
          if (parts.length === 5 && parts[2] === "jobs") {
            safeId(parts[3]);
            return send(
              response,
              200,
              await scheduler.agentOperation(
                parts[3],
                parts[4],
                input,
                request.headers["x-collector-lease"],
              ),
            );
          }
          throw HTTP_ERROR("경로를 찾을 수 없습니다.", 404);
        }
        const session = authenticated(request);
        if (!session) throw HTTP_ERROR("로그인이 필요합니다.", 401);
        if(url.pathname==="/api/dashboard-log"&&method==="POST"){
          if(!activity)throw HTTP_ERROR("대시보드 로그를 사용할 수 없습니다.",503);for(const event of clientEvents(await body(request)))recordActivity(event);return send(response,202,{accepted:true});
        }
        if(await updatesRouter({request,response,url,send,readBody:body}))return;
        if (method !== "GET" && method !== "HEAD") {
          jobsAt = 0;
          response.once("finish", () => { jobsAt = 0; });
        }
        if (url.pathname === "/api/activity" && method === "GET") {
          if (!activity) throw HTTP_ERROR("상세 로그를 사용할 수 없습니다.", 503);
          if(activity.externalPath)await activity.syncExternal?.(activity.externalPath);
          const number = (key, fallback) => {
            if (!url.searchParams.has(key)) return fallback;
            const value = Number(url.searchParams.get(key));
            if (!Number.isSafeInteger(value) || value < 0) throw HTTP_ERROR("로그 조회 범위를 확인하세요.", 400);
            return value;
          };
          return send(response, 200, activity.query({ after: number("after", 0), before: number("before", Infinity),
            limit: Math.min(200, Math.max(1, number("limit", 100))), level: url.searchParams.get("level") || "all",
            scope: url.searchParams.get("scope") || "all", jobId: url.searchParams.get("jobId") || null }));
        }
        if (
          await siteBrowserRouter({
            request,
            response,
            url,
            send,
            readBody: body,
          })
        )
          return;
        if (await presetsRouter({ request, response, url, send, readBody: body })) return;
        if (
          await captchaRouter({ request, response, url, send, readBody: body })
        )
          return;
        if (
          await siteAccountsRouter({
            request,
            response,
            url,
            send,
            readBody: body,
          })
        )
          return;
        if (
          await featureRouter({ request, response, url, send, readBody: body })
        )
          return;
        if (url.pathname === "/api/status" && method === "GET")
          return send(response, 200, {
            service: "running",
            source: activeSourceStatus(viewerOrigins),
            runner: {
              status: scheduler.currentJobId ? "running" : "idle",
              ...(scheduler.collector?.availability ?? {
                available: true,
                lastError: null,
              }),
            },
            currentJobId: scheduler.currentJobId,
            activeJobIds:
              scheduler.activeJobIds ??
              (scheduler.currentJobId ? [scheduler.currentJobId] : []),
            maxConcurrency: scheduler.maxConcurrency ?? 2,
            queuePaused: scheduler.queuePaused ?? false,
            browserSessionRefresh: scheduler.collector?.contextPool?.refreshStatus?.() ?? null,
            captchaAutomatic: [
              ...(await dashboardJobs()).filter(job => job.status === "running" && job.captcha).map(job => ({jobId:job.id,...job.captcha})),
              ...(captchaSession?.autoStatus?.()?.active ? [captchaSession.autoStatus()] : []),
            ],
            siteAttention:
              scheduler.attention
                ?.snapshot()
                .sites.filter((site) => site.held)
                .map((site) =>
                  siteAuthStatus(site, { accounts, autoAuth, recovery }),
                ) ?? [],
            backoff: scheduler.backoff?.snapshot() ?? {
              active: false,
              until: null,
              remainingSeconds: 0,
              consecutiveFailures: 0,
              reason: null,
            },
            jobCount: (await dashboardJobs()).length,
            browserAgents: scheduler.browserAgents?.() ?? [],
          });
        if (url.pathname === "/api/jobs/batch" && method === "POST") {
          const input=await body(request);
          if(!Array.isArray(input.jobs))throw HTTP_ERROR("예약 목록을 지정하세요.",400);
          const result = await store.createJobs(input.jobs.map(prepareJob));
          const jobs = jobProfiles
            ? await jobProfiles.registerJobs(result.jobs)
            : result.jobs;
          return send(response, 201, { ...result, jobs });
        }
        if (url.pathname === "/api/discover" && method === "GET") {
          if (!discovery)
            throw HTTP_ERROR("작품 목록을 사용할 수 없습니다.", 503);
          if (request.headers.accept?.includes("application/x-ndjson")) {
            response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8",
              "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff" });
            response.flushHeaders();
            const emit = (type, data) => {
              if (!response.destroyed && !response.writableEnded)
                response.write(JSON.stringify({ type, data }) + "\n");
            };
            try {
              const result = await discovery.list(Object.fromEntries(url.searchParams), {
                onProgress: data => emit("progress", data),
              });
              emit("result", result);
            } catch (error) {
              const status = error.status ?? (error.code === "NEEDS_ATTENTION" ? 409 : 500);
              recordActivity({ scope: "api", level: "error", message: `GET ${auditRoute}: ${error.message}`,
                details: { status, errorCode: error.code } });
              emit("error", { status, error: status === 500 ? "작품 목록을 불러오지 못했습니다." : error.message });
            } finally {
              if (!response.destroyed && !response.writableEnded) response.end();
            }
            return;
          }
          return send(
            response,
            200,
            await discovery.list(Object.fromEntries(url.searchParams)),
          );
        }
        if(url.pathname==='/api/discover/rankings'&&method==='GET'){
          if(!discovery?.rankings)throw HTTP_ERROR('랭킹 조회를 사용할 수 없습니다.',503);
          return send(response,200,await discovery.rankings(Object.fromEntries(url.searchParams)));
        }
        if (parts[1] === "discover" && parts.length === 4) {
          if (!validDiscoveryId(parts[2]))
            throw HTTP_ERROR("잘못된 작품 ID입니다.", 400);
          if (!discovery)
            throw HTTP_ERROR("작품 목록을 사용할 수 없습니다.", 503);
          if(parts[3]==='saved'&&method==='GET'){
            const saved=await discovery.overviewState(parts[2]),url=saved.item?.url;
            if(!url)return send(response,200,{book:null});
            const {makeBookId}=await import('./collector.mjs');const book=await store.getBook(makeBookId(url));
            return send(response,200,{book:book?.storedChapterCount>0?publicBook(book,{status:'completed'}):null});
          }
          if (parts[3] === "overview" && ["GET", "POST"].includes(method)) {
            if (!discovery.overviewState || !discovery.requestOverview)
              throw HTTP_ERROR("작품 소개를 사용할 수 없습니다.", 503);
            if (method === "POST") {
              const input = await body(request);
              if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)
                throw HTTP_ERROR("작품 소개 요청에는 추가 입력이 필요하지 않습니다.", 400);
            }
            const result = method === "GET" ? await discovery.overviewState(parts[2]) : await discovery.requestOverview(parts[2]);
            return send(response, method === "POST" && result.status === "pending" ? 202 : 200, result);
          }
          if (parts[3] === "refresh" && method === "POST") {
            await body(request);
            if (discovery.requestDetail) {
              const state = await discovery.requestDetail(parts[2]);
              return send(
                response,
                state.status === "pending" ? 202 : 200,
                state,
              );
            }
            return send(response, 200, await discovery.detail(parts[2]));
          }
          if (
            parts[3] === "metadata" &&
            method === "GET" &&
            discovery.detailState
          )
            return send(response, 200, await discovery.detailState(parts[2]));
          if (
            parts[3] === "thumbnail" &&
            (method === "GET" || method === "HEAD")
          ) {
            const file = await discovery.thumbnail(parts[2]);
            if (!file) throw HTTP_ERROR("표지가 없습니다.", 404);
            const headers = {
              "Content-Type": file.mimeType,
              "Cache-Control": "private, max-age=86400",
              "X-Content-Type-Options": "nosniff",
              ETag: file.etag,
            };
            if (file.etag && request.headers["if-none-match"] === file.etag) {
              response.writeHead(304, headers);
              response.end();
              return;
            }
            response.writeHead(200, headers);
            if (method === "HEAD") {
              response.end();
              return;
            }
            const stream = createReadStream(file.path);
            stream.on("error", () => response.destroy());
            stream.pipe(response);
            return;
          }
        }
        if (url.pathname === "/api/jobs") {
          if (method === "GET")
            return send(response, 200, await dashboardJobs());
          if (method === "POST") {
            const job = await store.createJob(prepareJob(await body(request)));
            const registered = jobProfiles
              ? (await jobProfiles.registerJobs([job]))[0]
              : job;
            return send(response, 201, registered);
          }
        }
        if (parts[1] === "jobs" && parts[2]) {
          safeId(parts[2]);
          const job = await store.getJob(parts[2]);
          if (!job) throw HTTP_ERROR("작업을 찾을 수 없습니다.", 404);
          if (parts.length === 3 && method === "DELETE") {
            const result = scheduler.deleteJob ? await scheduler.deleteJob(job.id) : await store.deleteJob(job.id);
            return send(response, result.pending ? 202 : 200, result);
          }
          if (parts.length === 3 && method === "GET")
            return send(response, 200, job);
          if (
            parts.length === 4 &&
            parts[3] === "action" &&
            method === "POST"
          ) {
            const input = await body(request);
            return send(
              response,
              200,
              await scheduler.action(job.id, input.action, {
                chapterIds: input.chapterIds,
              }),
            );
          }
          if (parts.length === 4 && parts[3] === "events" && method === "GET")
            return send(
              response,
              200,
              await store.readEvents(job.id, url.searchParams.get("limit")),
            );
          if (parts.length === 5 && parts[3] === "export" && method === "GET") {
            const file = await store.getExport(job.id, parts[4]);
            if (!file) throw HTTP_ERROR("저장 파일을 찾을 수 없습니다.", 404);
            response.writeHead(200, {
              "Content-Type": file.mimeType,
              "Content-Disposition": `attachment; filename="export.${parts[4]}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "no-store",
            });
            const stream = createReadStream(file.path);
            stream.on("error", () => response.destroy());
            stream.pipe(response);
            return;
          }
        }
        if (parts[1] === "books" && method === "GET") {
          if (parts.length === 2) {
            const books = await store.listBooks();
            for (const book of books)
              if (
                metadata &&
                book.metadataVersion !== 1 &&
                !jobProfiles?.state(book.id)
              )
                void metadata.request(book.id).catch(() => {});
            return send(
              response,
              200,
              await Promise.all(
                books.map(async (book) =>
                  publicBook(
                    book,
                    jobProfiles?.state(book.id) ??
                      (metadata ? await metadata.state(book.id) : null),
                  ),
                ),
              ),
            );
          }
          safeId(parts[2]);
          const book = await store.getBook(parts[2]);
          if (!book) throw HTTP_ERROR("작품을 찾을 수 없습니다.", 404);
          if (parts.length === 3)
            return send(response, 200, {
              book: publicBook(
                book,
                jobProfiles?.state(book.id) ??
                  (metadata ? await metadata.state(book.id) : null),
              ),
              chapters: await store.listChapters(parts[2]),
            });
          if (parts.length === 5 && parts[3] === "chapters") {
            const chapter = await store.readChapter(parts[2], safeId(parts[4]));
            if (!chapter) throw HTTP_ERROR("회차를 찾을 수 없습니다.", 404);
            return send(response, 200, chapter);
          }
        }
        throw HTTP_ERROR("경로를 찾을 수 없습니다.", 404);
      }
      if (method !== "GET" && method !== "HEAD")
        throw HTTP_ERROR("경로를 찾을 수 없습니다.", 404);
      const names = {
        "/": "index.html",
        "/index.html": "index.html",
        "/app.js": "app.js",
        "/login-recovery.js": "login-recovery.js",
        "/discovery.js": "discovery.js",
        "/discovery-detail.js": "discovery-detail.js",
        "/settings.js": "settings.js",
        "/settings.css": "settings.css",
        "/performance.js": "performance.js",
        "/site-verification.js": "site-verification.js",
        "/captcha-window.js": "captcha-window.js",
        "/site-verification.css": "site-verification.css",
        "/site-account.js": "site-account.js",
        "/site-account.css": "site-account.css",
        "/library.js": "library.js",
        "/logs.js": "logs.js",
        "/activity.js": "activity.js",
        "/dashboard-logger.js": "dashboard-logger.js",
        "/element-picker.js": "element-picker.js",
        "/extraction-presets.js": "extraction-presets.js",
        "/preset-guide.js": "preset-guide.js",
        "/preset-connection.js": "preset-connection.js",
        "/updates.js": "updates.js",
        "/release-history.js": "release-history.js",
        "/theme.js": "theme.js",
        "/queue-ui.js": "queue-ui.js",
        "/style.css": "style.css",
        "/styles.css": "styles.css",
      };
      const filename = names[url.pathname];
      if (!filename) throw HTTP_ERROR("경로를 찾을 수 없습니다.", 404);
      let content;
      try {
        content = await readFile(join(publicDir, filename));
      } catch (error) {
        if (error.code === "ENOENT")
          throw HTTP_ERROR("대시보드 파일을 찾을 수 없습니다.", 404);
        throw error;
      }
      const etag = `"${createHash("sha256").update(content).digest("hex")}"`;
      const unchanged = (request.headers["if-none-match"] || "")
        .split(",")
        .some((value) => [etag, `W/${etag}`, "*"].includes(value.trim()));
      response.writeHead(unchanged ? 304 : 200, {
        "Content-Type": {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
        }[extname(filename)],
        "Cache-Control": "no-cache",
        ETag: etag,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `default-src 'self'; img-src 'self' blob:; script-src 'self'; style-src 'self'; connect-src 'self' ${requestSocketOrigin(request, originOptions)}; frame-ancestors 'none'; base-uri 'none'`,
        "Referrer-Policy": "no-referrer",
      });
      response.end(method === "HEAD" || unchanged ? undefined : content);
    } catch (error) {
      if(audited)recordActivity({scope:"api",level:"error",message:`${request.method} ${auditRoute}: ${error.message}`,details:{errorCode:error.code,stage:error.stage,status:error.status||500}});
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status =
        error.status ?? (error.code === "NEEDS_ATTENTION" ? 409 : 500);
      if (status === 500)
        console.error(
          `[API] ${request.method} ${new URL(request.url, "http://localhost").pathname}: ${cleanMessage(error.message)}`,
        );
      send(response, status, {
        error:
          status !== 500 ? error.message : "서버 처리 중 오류가 발생했습니다.",
      });
    }
  });
  app.on("upgrade", (_request, socket) => {
    socket.end(
      "HTTP/1.1 410 Gone\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
  app.on("close", () => {
    void sessions.flush().catch(() => {});
  });
  app.requestTimeout = 30000;
  app.headersTimeout = 15000;
  if (!profiles) app.once("close", () => jobProfiles?.close());
  return app;
}
async function secretFile(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let secret;
  try {
    secret = (await readFile(path, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    secret = randomBytes(24).toString("base64url");
    await writeFile(path, secret + "\n", { mode: 0o600, flag: "wx" });
  }
  if (!secret) throw Error("빈 인증 파일입니다.");
  await chmod(path, 0o600);
  return secret;
}
export async function startServer({
  rootDir = BASE,
  startupIdentity = null,
  host = process.env.HOST ?? "127.0.0.1",
  port = Number(process.env.PORT ?? 8788),
} = {}) {
  const store = await new FolderStore(join(rootDir, "data")).init();
  const extractionPresets = await new ExtractionPresets({ store }).load();
  const updates = await new Updates({rootDir}).load();
  const { ActivityLog } = await import("./activity-log.mjs");
  const activity = await new ActivityLog({ path: join(rootDir, "data", "activity", "events.jsonl") }).load();
  activity.externalPath=join(rootDir,".updates","dashboard-events.jsonl");
  activity.add({ scope: "service", message: "서비스 시작" });
  const credentials = await openCredentials({
    directory: join(rootDir, "secrets"),
  });
  const sessionStore = new AdminSessions({
    store,
    binding: credentials.sessionVersion(),
  });
  await sessionStore.load();
  const retainedBrowser = retainedBrowserOptions({ store });
  const settings = new SettingsStore({
    path: join(rootDir, "data", "settings.json"),
  });
  await settings.load();
  const backoff = new BackoffController({ store });
  await backoff.load();
  const attention = new SiteAttention({ store });
  await attention.load();
  const viewerOrigins = new ViewerOrigins({ store });
  await viewerOrigins.load();
  const accounts = new SiteAccounts({
    directory: join(rootDir, "secrets", "site-accounts"),
  });
  await accounts.load();
  let autoAuth, recovery;
  const agentToken = await secretFile(
    join(rootDir, "secrets", "agent-token.txt"),
  );
  const { Collector } = await import("./collector.mjs");
  const { CaptchaBrowserSupport } = await import("./captcha-browser.mjs");
  const { createCaptchaAnalyzer } = await import("./captcha-analyzer.mjs");
  const minScore = Number(process.env.CAPTCHA_MIN_SCORE);
  const minMargin = Number(process.env.CAPTCHA_MIN_MARGIN);
  const captchaSupport = new CaptchaBrowserSupport({
    backoff,
    analyze: createCaptchaAnalyzer({
      ...(process.env.CAPTCHA_PYTHON ? { python: process.env.CAPTCHA_PYTHON } : {}),
      profile: minScore > 0 && minScore <= 1 && minMargin > 0 && minMargin <= 1
        ? { minScore, minMargin } : null,
    }),
    log: (event) => { console.info("[NovelCaptcha] " + JSON.stringify(event)); },
  });
  const { Discovery } = await import("./discovery.mjs");
  const discovery = new Discovery({
    presets: extractionPresets,
    rootDir: join(rootDir, "data", "discovery"),
    browserPath: process.env.BROWSER_PATH,
    profileDir: join(rootDir, "profile", "discovery"),
    backoff,
    attention,
    viewerOrigins,
    onRequestFailure: (error) => scheduler.requestFailed(null, error),
  });
  const { LibraryMetadata } = await import("./library-metadata.mjs");
  const metadata = new LibraryMetadata({
    store,
    discovery,
    onError: (error, { bookId }) =>
      console.warn(`[Metadata] ${bookId}: ${cleanMessage(error.message)}`),
  });
  const profiles = new JobProfiles({ store, metadata });
  const downloads = new LibraryDownloads({
    store,
    rootDir: join(rootDir, "data", "downloads"),
  });
  const collector = new Collector({
    captchaSupport,
    contextPool: retainedBrowser.contextPool,
    store,
    browserPath: process.env.BROWSER_PATH,
    profileDir:
      process.env.PROFILE_DIR ?? join(rootDir, "data", "browser-profile"),
    delayMs: settings.get().chapterDelayMs,
    onMetadata: (bookId, value) => metadata.register(bookId, value),
    backoff,
    authenticatePage: (page, signal) =>
      autoAuth?.loginPage(page, signal) ?? null,
    viewerOrigins,
  });
  const scheduler = new Scheduler({
    store,
    collector,
    ...settings.get(),
    backoff,
    onBackoff: () => discovery.suspendRequests(),
    attention,
    onSiteAttention: async (state) => {
      await discovery.suspendRequests();
      recovery?.request(state);
    },
  });
  const {
    siteBrowser,
    autoAuth: sourceAuth,
    recovery: sourceRecovery,
    captchaSession,
  } = createSourceSessions({
    captchaSupport,
    activity,
    ...retainedBrowser,
    store,
    scheduler,
    attention,
    accounts,
    viewerOrigins,
    browserPath: process.env.BROWSER_PATH,
    profileDir:
      process.env.PROFILE_DIR ?? join(rootDir, "data", "browser-profile"),
  });
  autoAuth = sourceAuth;
  recovery = sourceRecovery;
  const app = createApp({
    extractionPresets,
    updates,
    startupIdentity,
    activity,
    store,
    scheduler,
    credentials,
    settings,
    downloads,
    metadata,
    profiles,
    agentToken,
    publicDir: join(rootDir, "public"),
    secureCookies: process.env.SECURE_COOKIES === "1",
    trustProxy: process.env.TRUST_PROXY === "1",
    discovery,
    siteBrowser,
    accounts,
    autoAuth,
    recovery,
    captchaSession,
    viewerOrigins,
    sessionStore,
  });
  await new Promise((resolve, reject) => {
    app.once("error", reject);
    app.listen(port, host, resolve);
  });
  await atomicJson(join(rootDir,".updates","server.json"),{pid:process.pid}).catch(()=>{});
  retainedBrowser.contextPool.startRefresh({
    afterRefresh: () => discovery.refreshConnection(),
    onEvent: event => activity.add(event),
  });
  let verificationTimer=null;
  const startWork=async()=>{
    await profiles.registerJobs((await store.listJobs()).filter(job=>["queued","running","paused","needs_attention"].includes(job.status)));
    await scheduler.start();updates.start();for(const site of attention.snapshot().sites)recovery.request(site);
  };
  const awaitingVerification=()=>access(join(rootDir,".updates","pending-verification.json")).then(()=>true,()=>false);
  if(await awaitingVerification()){
    verificationTimer=setInterval(()=>{void awaitingVerification().then(waiting=>{if(!waiting){clearInterval(verificationTimer);verificationTimer=null;void startWork().catch(()=>{});}});},500);verificationTimer.unref();
  }else await startWork();
  let closing = false;
  let instanceControl=null;
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(verificationTimer);
    updates.close();
    profiles.close();
    recovery.close();
    await captchaSession.close();
    await autoAuth.close();
    await siteBrowser.close();
    await scheduler.stop();
    await retainedBrowser.contextPool.close();
    await metadata.close();
    await downloads.close();
    await discovery.close();
    await sessionStore.flush();
    activity.add({ scope: "service", message: "서비스 종료" });
    await activity.close();
    const {rm}=await import("node:fs/promises");await rm(join(rootDir,".updates","server.json"),{force:true}).catch(()=>{});
    await instanceControl?.close();
    app.closeAllConnections();
    await new Promise((r) => app.close(r));
  };
  process.once("SIGTERM", () => close().then(() => process.exit(0)));
  process.once("SIGINT", () => close().then(() => process.exit(0)));
  updates.onReady=async()=>{await close();setTimeout(()=>process.exit(75),100);};
  instanceControl=await new InstanceControl({root:rootDir,log:record=>activity.add(record),onStop:async()=>{await close();process.exit(0);}}).listen();
  return {
    app,
    store,
    scheduler,
    discovery,
    metadata,
    profiles,
    downloads,
    settings,
    credentials,
    siteBrowser,
    attention,
    accounts,
    autoAuth,
    recovery,
    captchaSession,
    close,
    updates,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  startServer()
    .then(({ app }) =>
      console.log(
        `Novel Collector listening on ${app.address().address}:${app.address().port}`,
      ),
    )
    .catch(() => {
      console.error(
        "Novel Collector failed to start; check service configuration and permissions.",
      );
      process.exitCode = 1;
    });
