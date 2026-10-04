import { join } from "node:path";
import { Collector, makeBookId, readReaderDocument } from "./collector.mjs";
import { validateUrl } from "./store.mjs";
import { parseRetryAfter } from "./retry-after.mjs";
import { startBrowserScreencast } from "./captcha-live.mjs";

const WIDTH = 1280,
  HEIGHT = 900;
const KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Escape",
  "Control+A",
]);
const fail = (message, status = 409) =>
  Object.assign(new Error(message), { status });

function browserOpenFailure(error, stage) {
  const causes = [];
  for (let cause = error; cause && causes.length < 4; cause = cause.cause) causes.push(cause);
  const text = causes.map(cause => String(cause.message || "").slice(0, 6000)).join("\n");
  let code = "BROWSER_OPEN_FAILED", message = "사이트 인증 브라우저를 열지 못했습니다. 상세 로그의 실패 단계를 확인하세요.", status = 503;
  if (causes.some(cause => cause.code === "ENOENT") || /Executable doesn't exist|executable.*not.*exist/i.test(text)) {
    code = "BROWSER_NOT_INSTALLED"; message = "브라우저 실행 파일이 없습니다. 설치 폴더에서 install.ps1 또는 bash install.sh로 실행 환경을 다시 준비하세요.";
  } else if (causes.some(cause => ["EACCES", "EPERM"].includes(cause.code)) || /permission denied|access is denied/i.test(text)) {
    code = "BROWSER_PERMISSION_DENIED"; message = "브라우저 실행 또는 프로필 폴더 접근 권한이 없습니다. 설치 폴더와 실행 계정의 권한을 확인하세요.";
  } else if (/ProcessSingleton|profile.*in use|user data directory.*in use/i.test(text)) {
    code = "BROWSER_PROFILE_IN_USE"; message = "같은 브라우저 프로필을 다른 프로그램이 사용 중입니다. 같은 설치의 이전 실행을 정상 종료한 뒤 다시 여세요.";
  } else if (/No usable sandbox|Running as root without --no-sandbox|Failed to (?:initialize|move to).*namespace|SUID sandbox helper.*not configured/i.test(text)) {
    code = "BROWSER_SANDBOX_UNAVAILABLE"; message = "브라우저 보안 실행 환경을 시작하지 못했습니다. 서버 실행 계정과 브라우저 설치 상태를 확인하세요.";
  } else if (/error while loading shared libraries|Host system is missing dependencies/i.test(text)) {
    code = "BROWSER_SYSTEM_DEPENDENCIES"; message = "서버에 브라우저 실행용 시스템 라이브러리가 없습니다. 설치 스크립트로 브라우저 의존성을 준비하세요.";
  } else if (/Target page, context or browser has been closed|browser.*closed|BROWSER_CLOSED/i.test(text)) {
    code = "BROWSER_CLOSED"; message = "브라우저가 종료돼 인증 화면을 열지 못했습니다. 서버 브라우저 상태를 확인한 뒤 다시 여세요.";
  } else if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/.test(text)) {
    code = "BROWSER_DNS_FAILED"; message = "인증 사이트의 주소를 찾지 못했습니다. 서버의 DNS와 인터넷 연결을 확인하세요.";
  } else if (/ERR_CERT_|ERR_SSL_/.test(text)) {
    code = "BROWSER_TLS_FAILED"; message = "인증 사이트의 HTTPS 연결을 확인하지 못했습니다. 서버 시각과 인증서를 확인하세요.";
  } else if (/net::ERR_|ECONNREFUSED|ECONNRESET/.test(text)) {
    code = "BROWSER_NETWORK_FAILED"; message = "인증 사이트에 연결하지 못했습니다. 서버 인터넷 연결과 사이트 접속 상태를 확인하세요.";
  } else if (causes.some(cause => cause.name === "TimeoutError") || /Timeout .*exceeded/i.test(text)) {
    code = stage === "NAVIGATE" ? "BROWSER_NAVIGATION_TIMEOUT" : "BROWSER_START_TIMEOUT";
    message = "인증 브라우저의 응답 대기 시간이 초과됐습니다. 서버 자원과 사이트 접속 상태를 확인한 뒤 다시 여세요.";
  } else if (stage === "ACQUIRE_CONTEXT" && causes.some(cause => cause.status === 409)) {
    code = "BROWSER_SLOT_BUSY"; message = "해당 브라우저 세션을 다른 작업이 사용 중입니다. 작업 종료 후 다시 여세요."; status = 409;
  }
  return Object.assign(fail(`${message} (${code})`, status), { code, stage });
}

export function validateViewerOrigin(value) {
  if (!["https://sbxh9.com", "https://toki32.com"].includes(value))
    throw fail("지원하는 HTTPS 뷰어 주소를 선택하세요.", 400);
  return value;
}

function validateTarget(host, slot) {
  if (
    typeof host !== "string" ||
    !/^newtoki\d+\.(org|com|net|me|co|io|site|tv)$/.test(host) ||
    ![1, 2].includes(slot)
  )
    throw fail("지원하는 사이트와 브라우저 슬롯 1 또는 2를 선택하세요.", 400);
}

function validProbe(value, host) {
  try {
    const url = new URL(validateUrl(value));
    return url.hostname === host && /^\/novel\/\d+\/\d+\/?$/.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export class SiteBrowser {
  constructor({
    store,
    scheduler,
    attention,
    browserPath,
    profileDir,
    launchContext,
    viewerOrigins = null,
    contextPool = null,
    captchaSupport = null,
    activity = null,
    onVerified = null,
    clock = () => Date.now(),
    idleMs = 120000,
    maxSessionMs = 900000,
  }) {
    if (
      !Number.isSafeInteger(idleMs) ||
      idleMs <= 0 ||
      !Number.isSafeInteger(maxSessionMs) ||
      maxSessionMs <= 0
    )
      throw fail("브라우저 사용 제한 시간이 올바르지 않습니다.", 400);
    if (onVerified !== null && typeof onVerified !== "function")
      throw fail("확인된 회차 저장기를 설정하세요.", 400);
    Object.assign(this, {
      store,
      scheduler,
      attention,
      browserPath,
      profileDir,
      launchContext,
      viewerOrigins,
      contextPool,
      captchaSupport,
      activity,
      onVerified,
      clock,
      idleMs,
      maxSessionMs,
    });
    this.session = null;
    this.lastHost = null;
    this.control = Promise.resolve();
    this.frameCapture = null;
    this.timer = null;
  }

  serialized(operation) {
    const pending = this.control.catch(() => {}).then(operation);
    this.control = pending;
    return pending;
  }

  async held(host) {
    const snapshot = await this.attention.snapshot();
    return snapshot.sites?.find((site) => site.host === host) || null;
  }

  async probeFor(site) {
    for (const id of site.jobIds || []) {
      const job = await this.store.getJob(id);
      let jobHost;
      try {
        jobHost = new URL(validateUrl(job?.url)).hostname;
      } catch {
        continue;
      }
      if (jobHost !== site.host) continue;
      const direct =
        validProbe(job.currentChapterUrl, site.host) ||
        validProbe(job.url, site.host);
      if (direct) return direct;
      const bookId = job.bookId || makeBookId(job.url);
      const catalog = await this.store.readCatalog?.(bookId);
      const current = catalog?.chapters?.find(
        (chapter) => chapter.id === job.currentChapterId,
      );
      const candidate =
        validProbe(current?.url, site.host) ||
        catalog?.chapters
          ?.map((chapter) => validProbe(chapter.url, site.host))
          .find(Boolean);
      if (candidate) return candidate;
      const stored = await this.store.listChapters?.(bookId);
      const saved = stored
        ?.map((chapter) => validProbe(chapter.url, site.host))
        .find(Boolean);
      if (saved) return saved;
    }
    throw fail(
      "확인할 회차 주소가 저장되지 않았습니다. 작품 목차와 중단 회차를 확인하세요.",
    );
  }

  expires(session) {
    return Math.min(
      session.startedAt + this.maxSessionMs,
      session.lastUsedAt + this.idleMs,
    );
  }

  scheduleExpiry(session) {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        void this.serialized(async () => {
          if (this.session !== session) return;
          if (this.clock() >= this.expires(session))
            await this.closeSession("expired");
          else this.scheduleExpiry(session);
        }).catch(() => {});
      },
      Math.max(1, this.expires(session) - this.clock()),
    );
    this.timer.unref?.();
  }

  async expireIfNeeded() {
    if (this.session?.page?.isClosed?.())
      await this.closeSession("expired");
    else if (this.session && this.clock() >= this.expires(this.session))
      await this.closeSession("expired");
  }

  allowedPage(session) {
    try {
      const url = new URL(session.page.url());
      return (
        url.protocol === "https:" &&
        url.hostname === session.viewerHost &&
        !url.username &&
        !url.password &&
        !url.port
      );
    } catch {
      return false;
    }
  }

  async requireSession(owner = null) {
    await this.expireIfNeeded();
    const session = this.session;
    if (!session?.page) throw fail("사이트 인증 브라우저를 먼저 여세요.");
    this.requireOwner(session, owner);
    if (!this.allowedPage(session))
      throw fail(
        "허용한 사이트를 벗어났습니다. 인증 브라우저를 닫고 다시 여세요.",
      );
    return session;
  }

  requireOwner(session, owner) {
    if (session && (session.owner ?? null) !== owner)
      throw fail("다른 작업에서 사용하는 인증 브라우저입니다.");
  }

  touch(session) {
    session.lastUsedAt = this.clock();
    this.scheduleExpiry(session);
  }

  async view() {
    const session = this.session;
    const host = session?.host || this.lastHost;
    const site = host ? await this.held(host) : null;
    let url = null;
    if (session?.page && this.allowedPage(session)) {
      const parsed = new URL(session.page.url());
      url = parsed.origin + parsed.pathname;
    }
    return {
      open: !!session?.page,
      host,
      viewerHost: session?.viewerHost ?? null,
      viewerOrigin: session?.viewerOrigin ?? null,
      slot: session?.slot ?? null,
      url,
      width: WIDTH,
      height: HEIGHT,
      pendingSlots: (site?.requiredSlots || []).filter(
        (slot) => !site.verifiedSlots?.includes(slot),
      ),
      expiresAt: session ? new Date(this.expires(session)).toISOString() : null,
      verificationRequired: !!site?.held,
    };
  }

  status({ owner = null } = {}) {
    return this.serialized(async () => {
      await this.expireIfNeeded();
      if (owner !== null) this.requireOwner(this.session, owner);
      return this.view();
    });
  }

  open({ host, slot, viewerOrigin, owner = null, onExpired = null } = {}) {
    return this.serialized(async () => {
      validateTarget(host, slot);
      const origin =
        viewerOrigin ??
        this.viewerOrigins?.originFor?.(host) ??
        (await this.viewerOrigins?.get(host));
      if (origin != null) validateViewerOrigin(origin);
      await this.expireIfNeeded();
      if (this.session) throw fail("열려 있는 인증 브라우저를 먼저 닫으세요.");
      const site = await this.held(host);
      if (!site?.held || !site.requiredSlots?.includes(slot))
        throw fail("이 사이트는 해당 슬롯의 인증 대기 상태가 아닙니다.");
      const canonicalProbeUrl = await this.probeFor(site);
      const target = new URL(canonicalProbeUrl);
      if (origin) target.hostname = new URL(origin).hostname;
      const probeUrl = target.href;
      try {
        if ((await this.scheduler.reserveManualSlot(slot)) === false)
          throw fail("해당 브라우저 슬롯이 사용 중입니다.");
      } catch {
        throw fail(
          "해당 브라우저 슬롯이 사용 중입니다. 수집이 멈춘 뒤 다시 여세요.",
        );
      }
      const session = {
        host,
        viewerHost: target.hostname,
        viewerOrigin: target.origin,
        owner,
        onExpired: typeof onExpired === "function" ? onExpired : null,
        slot,
        canonicalProbeUrl,
        probeUrl,
        startedAt: this.clock(),
        lastUsedAt: this.clock(),
        context: null,
        page: null,
        lease: null,
        lastFrameAt: null,
        lastCheckAt: null,
        response: null,
      };
      this.session = session;
      this.lastHost = host;
      let stage = "ACQUIRE_CONTEXT";
      try {
        const options = {
          store: this.store,
          browserPath: this.browserPath,
          profileDir: join(this.profileDir, `slot-${slot}`),
        };
        const collector = new Collector({
          ...options,
          viewerOrigins: this.viewerOrigins,
          launchContext: this.launchContext
            ? () => this.launchContext(options)
            : undefined,
        });
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            let fresh = false;
            const open = async () => {
              stage = "OPEN_CONTEXT";
              const context = await collector.openContext();
              try {
                stage = "INSTALL_NETWORK_GUARD";
                await collector.installNetworkGuard(context, {
                  allowImages: true,
                  allowedMainHost: session.viewerHost,
                });
                stage = "OPEN_PAGE";
                const page = await context.newPage();
                stage = "NAVIGATE";
                const response = await page.goto(probeUrl, {
                  waitUntil: "domcontentloaded",
                  timeout: 45000,
                });
                fresh = true;
                return { context, page, response };
              } catch (error) {
                await context.close().catch(() => {});
                throw error;
              }
            };
            stage = "ACQUIRE_CONTEXT";
            const opened = this.contextPool
              ? (session.lease = await this.contextPool.acquire({ slot, origin: target.origin, open }))
              : await open();
            session.context = opened.context;
            session.page = opened.page;
            stage = "RELEASE_PAGE_MONITOR";
            await this.captchaSupport?.release(session.page);
            session.response = opened.response ?? null;
            if (!fresh) {
              stage = "RESTORE_NETWORK_GUARD";
              await collector.installNetworkGuard(session.context, {
                allowImages: true,
                allowedMainHost: session.viewerHost,
              });
            }
            session.page.setDefaultTimeout?.(5000);
            session.page.setDefaultNavigationTimeout?.(45000);
            // Preserve the current reader; navigating again replaces its proof.
            if (session.page.url() !== probeUrl) {
              stage = "NAVIGATE";
              session.response = await session.page.goto(probeUrl, {
                waitUntil: "domcontentloaded",
                timeout: 45000,
              });
            }
            stage = "CHECK_ORIGIN";
            if (!this.allowedPage(session)) throw fail("사이트 인증 화면을 열 수 없습니다.");
            this.scheduleExpiry(session);
            return this.view();
          } catch (error) {
            const failure = browserOpenFailure(error, stage);
            if (attempt !== 0 || failure.code !== "BROWSER_CLOSED") throw error;
            stage = "DISCARD_CLOSED_CONTEXT";
            if (session.lease) await session.lease.release({ discard: true });
            else await session.context?.close().catch(() => {});
            session.lease = session.context = session.page = null;
            session.response = null;
          }
        }
      } catch (error) {
        const failure = browserOpenFailure(error, stage);
        try { await this.closeSession(); } catch {
          this.activity?.add({ scope: "auth", level: "error", message: "인증 브라우저 정리를 완료하지 못했습니다.", details: { stage: "CLOSE_SESSION", slot } });
        }
        this.activity?.add({ scope: "auth", level: "error", message: failure.message,
          details: { stage: failure.stage, errorCode: failure.code, slot } });
        throw failure;
      }
    });
  }

  input(input = {}, { owner = null } = {}) {
    return this.serialized(async () => {
      const session = await this.requireSession(owner);
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw fail("올바른 브라우저 입력이 필요합니다.", 400);
      let action;
      if (
        input.type === "click" &&
        Number.isFinite(input.x) &&
        Number.isFinite(input.y) &&
        input.x >= 0 &&
        input.x < WIDTH &&
        input.y >= 0 &&
        input.y < HEIGHT
      )
        action = () => session.page.mouse.click(input.x, input.y);
      else if (
        input.type === "pointer" &&
        ["down", "move", "up"].includes(input.phase) &&
        Number.isFinite(input.x) &&
        Number.isFinite(input.y) &&
        input.x >= 0 &&
        input.x < WIDTH &&
        input.y >= 0 &&
        input.y < HEIGHT
      )
        action = async () => {
          await session.page.mouse.move(input.x, input.y);
          if (input.phase === "down") await session.page.mouse.down();
          if (input.phase === "up") await session.page.mouse.up();
        };
      else if (
        input.type === "scroll" &&
        Number.isFinite(input.deltaY) &&
        Math.abs(input.deltaY) <= 2000 &&
        Number.isFinite(input.deltaX ?? 0) &&
        Math.abs(input.deltaX ?? 0) <= 2000
      )
        action = () =>
          session.page.mouse.wheel(input.deltaX ?? 0, input.deltaY);
      else if (input.type === "key" && KEYS.has(input.key))
        action = () => session.page.keyboard.press(input.key);
      else if (
        input.type === "text" &&
        typeof input.text === "string" &&
        input.text.length <= 4096
      )
        action = () => session.page.keyboard.insertText(input.text);
      else throw fail("지원하는 화면 입력과 허용 범위를 확인하세요.", 400);
      this.touch(session);
      try {
        await action();
      } catch {
        throw fail(
          "브라우저 입력을 처리하지 못했습니다. 인증 창을 확인하세요.",
          503,
        );
      }
      return this.view();
    });
  }

  async frame({ owner = null } = {}) {
    const capture = await this.serialized(async () => {
      const session = await this.requireSession(owner);
      if (
        this.frameCapture ||
        (session.lastFrameAt !== null &&
          this.clock() - session.lastFrameAt < 1000)
      )
        throw fail("화면 요청은 1초에 한 번만 할 수 있습니다.", 429);
      const capture = { session, owner };
      this.frameCapture = capture;
      session.lastFrameAt = this.clock();
      this.touch(session);
      return capture;
    });
    try {
      let bytes;
      // Reading a frame must not hold the input/control queue while Chromium
      // encodes it. One capture stays in flight across session replacement.
      try {
        bytes = await capture.session.page.screenshot({
          type: "jpeg",
          quality: 65,
          fullPage: false,
          timeout: 5000,
        });
        if (bytes.length > 4 * 1024 * 1024) throw Error();
      } catch {
        throw fail(
          "브라우저 화면을 읽지 못했습니다. 인증 창을 다시 여세요.",
          503,
        );
      }
      return await this.serialized(async () => {
        await this.expireIfNeeded();
        if (this.session !== capture.session)
          throw fail("인증 브라우저가 변경됐습니다. 화면을 다시 요청하세요.");
        this.requireOwner(capture.session, capture.owner);
        if (!this.allowedPage(capture.session))
          throw fail("허용한 사이트를 벗어났습니다. 인증 창을 다시 여세요.");
        return { bytes, mimeType: "image/jpeg" };
      });
    } finally {
      if (this.frameCapture === capture) this.frameCapture = null;
    }
  }

  live({ owner = null, onFrame, onClose = () => {} } = {}) {
    return this.serialized(async () => {
      const session = await this.requireSession(owner);
      if (session.liveCapture)
        throw fail("이미 연결된 실시간 인증 화면을 먼저 닫으세요.");
      const capture = {};
      session.liveCapture = capture;
      const validate = () =>
        this.session === session &&
        session.liveCapture === capture &&
        (session.owner ?? null) === owner &&
        this.clock() < this.expires(session) &&
        this.allowedPage(session);
      try {
        const lease = await startBrowserScreencast({
          page: session.page,
          context: session.context,
          validate,
          clock: this.clock,
          onFrame,
          onClose: async () => {
            // A disconnected remote pointer must not leave this owned page
            // holding its mouse button. No coordinates or unknown inputs replay.
            if (validate()) {
              try {
                await session.page.mouse.up();
              } catch {}
            }
            if (session.liveCapture === capture) session.liveCapture = null;
            await onClose();
          },
        });
        capture.lease = lease;
        if (!validate()) {
          await lease.close();
          throw fail("인증 화면이 변경됐습니다.");
        }
        this.touch(session);
        return lease;
      } catch (error) {
        if (session.liveCapture === capture) session.liveCapture = null;
        throw error;
      }
    });
  }

  authenticate(callback) {
    return this.serialized(async () => {
      if (typeof callback !== "function")
        throw fail("자동 로그인 확인기를 설정하세요.", 503);
      const session = await this.requireSession();
      if (!this.allowedPage(session))
        throw fail("허용한 수집 사이트에서 로그인 상태를 확인하세요.");
      this.touch(session);
      try {
        await callback(session.page, {
          host: session.host,
          viewerHost: session.viewerHost,
          slot: session.slot,
        });
        if (!this.allowedPage(session))
          throw fail("사이트 로그인 경로를 확인하세요.");
      } catch (error) {
        if (error.name === "AbortError")
          throw Object.assign(new Error("자동 로그인 확인이 중단됐습니다."), {
            name: "AbortError",
            code: "ABORTED",
          });
        const attentionKind = [
          "authentication",
          "captcha",
          "site_blocked",
        ].includes(error.attentionKind)
          ? error.attentionKind
          : "authentication";
        throw Object.assign(
          new Error(
            attentionKind === "captcha"
              ? "사이트 보안 확인이 필요합니다."
              : "자동 로그인 확인에 실패했습니다.",
          ),
          {
            status: error.status === 429 ? 429 : 409,
            code: "NEEDS_ATTENTION",
            attentionKind,
            kind:
              error.kind === "rate" || error.httpStatus === 429
                ? "rate"
                : attentionKind,
            ...(Number.isSafeInteger(error.httpStatus)
              ? { httpStatus: error.httpStatus }
              : {}),
            ...(Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0
              ? { retryAfterMs: error.retryAfterMs }
              : {}),
          },
        );
      }
      return this.view();
    });
  }

  check({ reload = true, owner = null } = {}) {
    return this.serialized(async () => {
      const session = await this.requireSession(owner);
      if (
        session.lastCheckAt !== null &&
        this.clock() - session.lastCheckAt < 5000
      )
        throw fail("회차 확인은 5초 후 다시 시도하세요.", 429);
      session.lastCheckAt = this.clock();
      this.touch(session);
      let reader,
        response = session.lease?.response ?? session.response;
      try {
        if (reload)
          response = await session.page.goto(session.probeUrl, {
            waitUntil: "domcontentloaded",
            timeout: 45000,
          });
        session.response = response;
        if (!this.allowedPage(session)) throw Error();
        if (
          new URL(session.page.url()).pathname.replace(/\/$/, "") !==
          new URL(session.probeUrl).pathname.replace(/\/$/, "")
        )
          throw Error();
        for (let attempt = 0; attempt < 40; attempt++) {
          reader = await session.page.evaluate(readReaderDocument);
          if (
            response?.status() >= 400 ||
            reader.challenge ||
            reader.verificationRequired ||
            reader.text?.trim()
          )
            break;
          if (typeof session.page.waitForTimeout !== "function") break;
          if (attempt < 39) await session.page.waitForTimeout(250);
        }
      } catch {
        throw Object.assign(
          fail(
            "회차 확인을 완료하지 못했습니다. 화면에서 인증을 마친 뒤 다시 확인하세요.",
          ),
          { kind: "verification" },
        );
      }
      if (this.contextPool && !response)
        throw Object.assign(
          fail(
            "회차 응답을 확인하지 못했습니다. 화면을 다시 연 뒤 확인하세요.",
          ),
          { kind: "verification" },
        );
      if (
        response?.status() >= 400 ||
        reader.challenge ||
        reader.verificationRequired ||
        !reader.text?.trim()
      )
        throw Object.assign(
          fail(
            "아직 회차 본문을 확인할 수 없습니다. 화면에서 사이트 인증을 직접 완료한 뒤 다시 확인하세요.",
          ),
          {
            kind:
              response?.status() === 429
                ? "rate"
                : reader.challenge || reader.verificationKind === "captcha"
                  ? "captcha"
                  : response?.status() >= 400
                    ? "site_blocked"
                    : reader.verificationRequired
                      ? "authentication"
                      : "verification",
            ...(response?.status() >= 400
              ? { httpStatus: response.status() }
              : {}),
            ...(response?.status() === 429
              ? {
                  retryAfterMs: parseRetryAfter(
                    response.headers?.()["retry-after"],
                    this.clock(),
                  ),
                }
              : {}),
          },
        );
      if (
        !this.allowedPage(session) ||
        new URL(session.page.url()).pathname.replace(/\/$/, "") !==
          new URL(session.probeUrl).pathname.replace(/\/$/, "")
      )
        throw fail("허용한 회차 화면에서 본문을 다시 확인하세요.");
      try {
        await this.onVerified?.({
          canonicalProbeUrl: session.canonicalProbeUrl,
          viewerOrigin: session.viewerOrigin,
          slot: session.slot,
          text: reader.text,
        });
      } catch {
        throw fail(
          "확인된 회차 본문을 저장하지 못했습니다. 다시 시도하세요.",
          503,
        );
      }
      await this.parkVerifiedSession(session);
      let siteReleased = false;
      try {
        await this.attention.verifySlot(session.host, session.slot, {
          viewerOrigin: session.viewerOrigin,
          beforeRelease: async () => {
            if (session.viewerHost !== session.host) {
              if (!this.viewerOrigins?.save)
                throw fail("인증한 수집 주소를 저장할 수 없습니다.", 503);
              await this.viewerOrigins.save(session.host, session.viewerOrigin);
            } else if (await this.viewerOrigins?.get(session.host)) {
              throw fail("저장된 수집 주소와 같은 사이트에서 확인하세요.");
            }
          },
        });
        const site = await this.held(session.host);
        if (
          site?.requiredSlots?.every((slot) =>
            site.verifiedSlots?.includes(slot),
          )
        ) {
          await this.scheduler.releaseSite(session.host);
          siteReleased = true;
        }
      } finally {
        await this.closeSession();
      }
      const status = await this.view();
      return {
        verified: true,
        host: session.host,
        slot: session.slot,
        pendingSlots: status.pendingSlots,
        siteReleased,
        status,
      };
    });
  }

  retryAutomatic({ owner = null, signal, onProgress } = {}) {
    return this.serialized(async () => {
      const session = await this.requireSession(owner);
      if (!this.captchaSupport) throw fail("자동 CAPTCHA 모듈을 사용할 수 없습니다.", 503);
      this.touch(session);
      await session.liveCapture?.lease?.close();
      session.liveCapture = null;
      const transport = {
        resolve: () => session.probeUrl,
        assertNavigation: (_canonical, actual) => {
          if (actual !== session.probeUrl) throw fail("인증 페이지가 변경됐습니다.");
        },
      };
      const collector = new Collector({ store: this.store, viewerOrigins: transport,
        captchaSupport: this.captchaSupport, captchaMaxAttempts: 5, contentTimeoutMs: 20000 });
      try {
        await collector.chapterText(session.page, { url: session.canonicalProbeUrl }, signal, { onProgress });
      } finally {
        // Explicit dashboard operation hands input back to the human UI after
        // its bounded budget. Remove only this module's native retry latch.
        await this.captchaSupport.release(session.page);
      }
      if (signal?.aborted || this.session !== session || !this.allowedPage(session))
        throw fail("자동 CAPTCHA 확인이 중단됐습니다.");
      session.response = collector.lastNavigationResponse;
      session.lastCheckAt = null;
      return { ready: true };
    });
  }

  async parkVerifiedSession(session) {
    if (!this.contextPool) return;
    if (
      this.session !== session ||
      !this.allowedPage(session) ||
      new URL(session.page.url()).pathname.replace(/\/$/, "") !==
        new URL(session.probeUrl).pathname.replace(/\/$/, "")
    )
      throw fail("인증한 수집 화면이 변경됐습니다.");
    await session.liveCapture?.lease?.close();
    session.liveCapture = null;
    if (session.lease) await session.lease.release();
    else
      await this.contextPool.offer({
        slot: session.slot,
        context: session.context,
        page: session.page,
        response: session.response,
        origin: session.viewerOrigin,
      });
    session.lease = null;
    session.context = null;
    session.page = null;
  }

  async closeSession(reason = "closed") {
    const session = this.session;
    this.session = null;
    clearTimeout(this.timer);
    this.timer = null;
    if (!session) return;
    try {
      await session.liveCapture?.lease?.close().catch(() => {});
      if (session.lease) await session.lease.release({ discard: true });
      else await session.context?.close().catch(() => {});
    } finally {
      await this.scheduler.releaseManualSlot(session.slot);
      if (reason === "expired") await session.onExpired?.();
    }
  }

  close({ owner = null } = {}) {
    return this.serialized(async () => {
      this.requireOwner(this.session, owner);
      await this.closeSession();
      return this.view();
    });
  }
}
