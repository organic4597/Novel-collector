import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import JSZip from "jszip";
import { collectCatalog } from "./collector-catalog.mjs";
export { readCatalogDocument } from "./catalog-document.mjs";
import { runCollection } from "./collector-runner.mjs";
import { navigate as navigateReader } from "./collector-navigation.mjs";
import { parseRetryAfter } from "./retry-after.mjs";
import { cleanMessage } from "./store.mjs";

export function makeBookId(url) {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/novel\/(\d+)/);
  if (
    !match ||
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !/^newtoki\d*\.[a-z.]+$/i.test(parsed.hostname)
  )
    throw new Error("지원하는 작품 URL이 아닙니다.");
  return `${parsed.hostname.replace(/\./g, "_")}-${match[1]}`;
}

export function chapterIdFor(url) {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  return createHash("sha256").update(parsed.href).digest("hex").slice(0, 24);
}

export function isPublicAddress(address) {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice(7);
    if (isIP(mapped) === 4) return isPublicAddress(mapped);
    const pairs = mapped.split(":");
    if (pairs.length === 2) {
      const value = parseInt(pairs[0], 16) * 65536 + parseInt(pairs[1], 16);
      return isPublicAddress(
        [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join("."),
      );
    }
  }
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(address) === 6) return !/^(::|fc|fd|fe[89ab]|ff)/.test(normalized);
  return false;
}

// These two functions are self-contained so they can run inside the browser.
export function readReaderDocument(doc = document) {
  const scopes = [doc];
  const seen = new Set(scopes);
  for (let i = 0; i < scopes.length; i++) {
    for (const el of scopes[i].querySelectorAll("*")) {
      const root =
        el.shadowRoot ||
        (el.__novelShadow?.nodeType === 11 && el.__novelShadow.host === el
          ? el.__novelShadow
          : null) ||
        (el.tagName === "TEMPLATE" && el.hasAttribute("shadowrootmode")
          ? el.content
          : null);
      if (root && !seen.has(root)) {
        seen.add(root);
        scopes.push(root);
      }
    }
  }
  const read = (node) => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType === 1) {
      if (
        /^(SCRIPT|STYLE|NOSCRIPT|NAV|BUTTON|FORM)$/.test(node.tagName) ||
        node.classList.contains("wr-none")
      )
        return "";
      if (node.tagName === "BR") return "\n";
      if (node.shadowRoot) return read(node.shadowRoot);
      if (
        node.__novelShadow?.nodeType === 11 &&
        node.__novelShadow.host === node
      )
        return read(node.__novelShadow);
      const template = [...node.children].find(
        (child) =>
          child.tagName === "TEMPLATE" && child.hasAttribute("shadowrootmode"),
      );
      if (template) return read(template.content);
      if (node.tagName === "TEMPLATE")
        return node.hasAttribute("shadowrootmode") ? read(node.content) : "";
      if (node.tagName === "SLOT" && node.assignedNodes?.().length)
        return node.assignedNodes({ flatten: true }).map(read).join("");
    }
    const text = [...(node.childNodes || [])].map(read).join("");
    return /^(P|DIV|SECTION|ARTICLE|LI|H[1-6])$/.test(node.tagName || "")
      ? `${text}\n\n`
      : text;
  };
  const named = scopes.flatMap((scope) => [
    ...scope.querySelectorAll(
      "[data-theme-novel-content], #novel_content, .novel-epub-rendered",
    ),
  ]);
  const candidates = named.length
    ? named
    : scopes.slice(1).filter((scope) => scope.querySelector("p"));
  const texts = candidates.map(read).map((text) =>
    text
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
  const text = texts.sort((a, b) => b.length - a.length)[0] || "";
  const host = doc.querySelector("[data-theme-novel-content], #novel_content");
  const notice = host?.querySelector(".wr-none")?.textContent.trim() || "";
  const visible = (element) => {
    for (
      let current = element;
      current?.nodeType === 1;
      current = current.parentElement
    ) {
      if (current.hidden || current.getAttribute("aria-hidden") === "true")
        return false;
      const style = doc.defaultView?.getComputedStyle?.(current);
      if (style?.display === "none" || style?.visibility === "hidden")
        return false;
    }
    return true;
  };
  const challenge =
    /just a moment|attention required/i.test(doc.title || "") ||
    [
      ...doc.querySelectorAll(
        '#cf-challenge-running, .cf-browser-verification, #challenge-running, iframe[src*="hcaptcha"], iframe[src*="recaptcha"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha, .cf-turnstile, fieldset.captcha, #captcha, [aria-label="퍼즐 슬라이더"]',
      ),
    ].some(visible);
  const verificationRequired =
    !text &&
    /일일.{0,12}인증|(?:인증|로그인|보안\s*확인|캡차|captcha).{0,20}(?:필요|완료|진행|해\s*주세요)|(?:인증|로그인)\s*후\s*(?:다시|이용|열어)/i.test(
      notice,
    );
  return {
    text,
    notice,
    challenge,
    novelCaptcha: [...doc.querySelectorAll('[aria-label="퍼즐 슬라이더"]')].some(visible),
    verificationRequired,
    verificationKind: verificationRequired
      ? /일일\s*조회\s*인증/.test(notice)
        ? "captcha"
        : "authentication"
      : null,
    verificationReason: verificationRequired ? notice.slice(0, 500) : "",
  };
}

const xml = (text) =>
  String(text).replace(
    /[<>&"']/g,
    (char) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[char],
  );
const filename = (text) =>
  String(text)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .trim()
    .slice(0, 120) || "novel";
export const buildTxt = (title, chapters) =>
  Buffer.from(
    `[ ${title} ]\n${chapters.map((chapter) => `\n\n=== ${chapter.number} · ${chapter.title} ===\n\n${chapter.text}`).join("")}\n`,
    "utf8",
  );

export async function buildEpub(title, chapters) {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  const items = [],
    spine = [],
    nav = [];
  chapters.forEach((chapter, index) => {
    const name = `chapter_${index + 1}.xhtml`;
    zip.file(
      `OEBPS/${name}`,
      `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${xml(chapter.title)}</title></head><body><h2>${xml(chapter.title)}</h2>${chapter.text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => `<p>${xml(line)}</p>`)
        .join("\n")}</body></html>`,
    );
    items.push(
      `<item id="c${index}" href="${name}" media-type="application/xhtml+xml"/>`,
    );
    spine.push(`<itemref idref="c${index}"/>`);
    nav.push(`<li><a href="${name}">${xml(chapter.title)}</a></li>`);
  });
  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>목차</title></head><body><nav epub:type="toc"><h1>목차</h1><ol>${nav.join("")}</ol></nav></body></html>`,
  );
  const uid = createHash("sha256")
    .update(title + chapters.map((chapter) => chapter.text).join(""))
    .digest("hex");
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:sha256:${uid}</dc:identifier><dc:title>${xml(title)}</dc:title><dc:language>ko</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${items.join("")}</manifest><spine>${spine.join("")}</spine></package>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function attention(message, attentionKind = null) {
  return Object.assign(new Error(message), {
    code: "NEEDS_ATTENTION",
    ...(attentionKind ? { attentionKind } : {}),
  });
}

function abortIfNeeded(signal) {
  if (signal?.aborted)
    throw Object.assign(new Error("작업 중단"), {
      name: "AbortError",
      code: "ABORTED",
    });
}

const delay = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("작업 중단"), { name: "AbortError" }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("작업 중단"), { name: "AbortError" }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const networkGuards = new WeakMap();
const retryableCaptcha = new Set([
  "CREATE_INVALID_RESPONSE", "IMAGE_DECODE_FAILED", "IMAGE_SIZE_MISMATCH",
  "POSITION_UNCERTAIN", "ANALYSIS_TIMEOUT", "CHALLENGE_EXPIRED", "CAPTCHA_INPUT_BLOCKED",
  "TRAIL_INVALID", "TRAIL_DURATION_OUT_OF_RANGE", "VERIFY_REJECTED",
  "VERIFY_INVALID_RESPONSE", "VERIFY_RESULT_UNKNOWN", "CAPTCHA_TIMEOUT",
  "CAPTCHA_REPEAT_LIMIT",
]);

export class Collector {
  constructor({
    store,
    browserPath,
    profileDir,
    launchContext,
    delayMs = 1000,
    contentTimeoutMs = 30000,
    onMetadata,
    clock = () => Date.now(),
    backoff = null,
    authenticatePage = null,
    onAuthEvent = null,
    viewerOrigins = null,
    contextPool = null,
    slotId = null,
    captchaSupport = null,
    captchaMaxAttempts = 5,
    onCaptchaProgress = null,
  }) {
    if (!Number.isInteger(captchaMaxAttempts) || captchaMaxAttempts < 1 || captchaMaxAttempts > 5)
      throw new TypeError("CAPTCHA automatic attempts must be 1..5");
    this.store = store;
    this.browserPath = browserPath;
    this.profileDir = profileDir;
    this.launchContext = launchContext;
    this.delayMs = delayMs;
    this.contentTimeoutMs = contentTimeoutMs;
    this.onMetadata = onMetadata;
    this.clock = clock;
    this.backoff = backoff;
    this.authenticatePage = authenticatePage;
    this.onAuthEvent = onAuthEvent;
    this.viewerOrigins = viewerOrigins;
    this.contextPool = contextPool;
    this.slotId = slotId;
    this.captchaSupport = captchaSupport;
    this.captchaMaxAttempts = captchaMaxAttempts;
    this.onCaptchaProgress = onCaptchaProgress;
    this.captchaReaders = new WeakMap();
    this.authenticationChecked = false;
    this.navigationAuthentication = new WeakMap();
    this.context = null;
    this.contextLease = null;
    this.collectionRun = null;
    this.closeWork = null;
    this.availability = { available: true, lastError: null };
  }

  fork(slotId) {
    if (!Number.isSafeInteger(slotId) || slotId < 1 || slotId > 2)
      throw new Error("브라우저 슬롯은 1 또는 2여야 합니다.");
    return new Collector({
      store: this.store,
      browserPath: this.browserPath,
      profileDir: join(this.profileDir, `slot-${slotId}`),
      launchContext: this.launchContext,
      delayMs: this.delayMs,
      contentTimeoutMs: this.contentTimeoutMs,
      onMetadata: this.onMetadata,
      clock: this.clock,
      backoff: this.backoff,
      authenticatePage: this.authenticatePage,
      onAuthEvent: this.onAuthEvent,
      viewerOrigins: this.viewerOrigins,
      contextPool: this.contextPool,
      slotId,
      captchaSupport: this.captchaSupport,
      captchaMaxAttempts: this.captchaMaxAttempts,
      onCaptchaProgress: this.onCaptchaProgress,
    });
  }

  async close() {
    // A retained context cannot become available while its current operation
    // still owns the page. Aborted pooled runs release only from their finally.
    if (this.collectionRun?.pooled) return;
    if (this.closeWork) return this.closeWork;
    const context = this.context;
    const lease = this.contextLease;
    this.context = null;
    this.contextLease = null;
    if (!context && !lease) return;
    if (!lease && context) networkGuards.delete(context);
    const closing = Promise.resolve().then(() =>
      lease ? lease.release() : context.close().catch(() => {}),
    );
    this.closeWork = closing;
    try {
      await closing;
    } finally {
      if (this.closeWork === closing) this.closeWork = null;
    }
  }

  async openContext() {
    this.authenticationChecked = false;
    this.navigationAuthentication = new WeakMap();
    if (this.launchContext) return this.launchContext();
    const { chromium } = await import("playwright");
    return chromium.launchPersistentContext(this.profileDir, {
      executablePath: this.browserPath || undefined,
      headless: true,
      chromiumSandbox: true,
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
      locale: "ko-KR",
      timezoneId: "Asia/Seoul",
      args: ["--disable-dev-shm-usage"],
    });
  }

  async installNetworkGuard(
    context,
    { allowImages = false, allowedMainHost = null } = {},
  ) {
    const cache = new Map();
    const previous = networkGuards.get(context) || [];
    if (previous.length) {
      if (typeof context.unroute !== "function")
        throw new Error("수집 브라우저의 요청 보호 설정을 갱신할 수 없습니다.");
    }
    const handler = async (route) => {
      try {
        if (this.backoff?.snapshot().active) {
          await route.abort();
          return;
        }
        const request = route.request();
        if (
          (allowImages ? ["media"] : ["image", "media", "font"]).includes(
            request.resourceType(),
          )
        ) {
          await route.abort();
          return;
        }
        const url = new URL(request.url());
        if (this.viewerOrigins && /^newtoki\d*\./i.test(url.hostname)) {
          await route.abort();
          return;
        }
        if (
          allowedMainHost &&
          request.isNavigationRequest?.() &&
          !request.frame?.().parentFrame?.() &&
          (url.protocol !== "https:" || url.hostname !== allowedMainHost)
        ) {
          await route.abort();
          return;
        }
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        ) {
          await route.abort();
          return;
        }
        let addresses = cache.get(url.hostname);
        if (!addresses) {
          addresses = isIP(url.hostname)
            ? [{ address: url.hostname }]
            : await lookup(url.hostname, { all: true });
          cache.set(url.hostname, addresses);
        }
        if (
          !addresses.length ||
          addresses.some((item) => !isPublicAddress(item.address))
        ) {
          await route.abort();
          return;
        }
        await route.continue();
      } catch {
        await route.abort().catch(() => {});
      }
    };
    await context.route("**/*", handler);
    // Install the replacement before removing known handlers so there is no
    // unguarded interval while the native page makes background requests.
    networkGuards.set(context, [handler, ...previous]);
    for (const owned of previous) {
      await context.unroute("**/*", owned);
      networkGuards.set(
        context,
        networkGuards.get(context).filter((candidate) => candidate !== owned),
      );
    }
  }

  async navigate(page, url, signal, options = {}) {
    return navigateReader.call(this, page, url, signal, options, {
      makeBookId,
      abortIfNeeded,
      readReaderDocument,
      attention,
    });
  }

  async responseProblem(response) {
    if (response && response.status() >= 400) {
      const status = response.status();
      const error = [401, 403, 429].includes(status)
        ? attention(
            `사이트 접근 확인이 필요합니다 (HTTP ${status}).`,
            status === 401 ? "authentication" : "site_blocked",
          )
        : new Error(`페이지 요청 실패 (HTTP ${status}).`);
      let retryHeader;
      try {
        retryHeader = response.headerValue
          ? await response.headerValue("retry-after")
          : (await response.headers?.())?.["retry-after"];
      } catch {}
      error.httpStatus = status;
      error.retryAfterMs = Math.max(
        status === 429 ? 600000 : 0,
        parseRetryAfter(retryHeader, this.clock()),
      );
      return error;
    }
    return null;
  }

  async authenticateNavigation(page, signal, force = false) {
    // Authenticate the selected source with that source's own account record.
    const attempt = this.navigationAuthentication.get(page);
    if (
      !this.authenticatePage ||
      attempt?.attempted ||
      (!force && this.authenticationChecked)
    )
      return null;
    if (attempt) attempt.attempted = true;
    this.authenticationChecked = true;
    abortIfNeeded(signal);
    await this.onAuthEvent?.("사이트 로그인 상태 확인 중");
    let result;
    try {
      result = await this.authenticatePage(page, signal);
      abortIfNeeded(signal);
    } catch (problem) {
      if (signal?.aborted || problem.name === "AbortError") throw problem;
      if (problem.httpStatus === 429 || problem.retryAfterMs > 0)
        throw Object.assign(
          attention(
            "사이트 로그인 요청 대기 시간이 필요합니다.",
            "site_blocked",
          ),
          {
            httpStatus: problem.httpStatus,
            retryAfterMs: problem.retryAfterMs,
          },
        );
      if (
        ["REQUEST_BACKOFF", "SITE_VERIFICATION_REQUIRED"].includes(problem.code)
      )
        throw problem;
      throw attention(
        problem.kind === "captcha" || problem.attentionKind === "captcha"
          ? "사이트 보안 확인이 필요합니다. 인증 화면에서 직접 진행하세요."
          : "사이트 로그인 확인을 완료하지 못했습니다. 계정 설정이나 인증 화면을 확인하세요.",
        problem.kind === "captcha" || problem.attentionKind === "captcha"
          ? "captcha"
          : "authentication",
      );
    }
    if (result && !result.authenticated)
      throw attention(
        "사이트 로그인 확인이 필요합니다. 계정 설정이나 인증 화면을 확인하세요.",
        "authentication",
      );
    if (result?.authenticated)
      await this.onAuthEvent?.(
        result.reused
          ? "저장된 사이트 로그인 상태 확인 완료"
          : "사이트 로그인 완료",
      );
    return result;
  }

  async catalog(page, job, hooks, signal) {
    return collectCatalog.call(this, page, job, hooks, signal, {
      chapterIdFor,
      delay,
      abortIfNeeded,
      readReaderDocument,
      attention,
    });
  }
  async chapterText(page, chapter, signal, { onProgress = this.onCaptchaProgress } = {}) {
    const limit = this.captchaSupport ? this.captchaMaxAttempts : 1;
    for (let attempt = 1; attempt <= limit; attempt++) {
      abortIfNeeded(signal);
      const monitor = await this.captchaSupport?.attach(page, {
        url: this.viewerOrigins?.resolve(chapter.url) || chapter.url,
        signal,
        onProgress: async (event) => onProgress?.({ ...event, attempt, maxAttempts: limit,
          active: !["SUCCEEDED", "FAILED"].includes(event.stage) }),
      });
      if (monitor) this.captchaReaders.set(page, monitor);
      try {
        return await this.readChapterText(page, chapter, signal);
      } catch (error) {
        abortIfNeeded(signal);
        if (error.captchaCode) error.captchaAttempts = attempt;
        if (!monitor || !retryableCaptcha.has(error.captchaCode) || attempt === limit) {
          if (error.captchaCode && attempt === limit && attempt > 1)
            error.message = `CAPTCHA 자동 처리가 ${attempt}회 실패했습니다. 서버 인증 창에서 직접 확인하세요. (${error.captchaCode})`;
          throw error;
        }
        // The next navigation belongs to the existing renderer: it generates
        await onProgress?.({ stage: "RETRYING", attempt: attempt + 1, maxAttempts: limit,
          active: true, elapsedMs: 0, code: error.captchaCode });
        // fresh nonce/proof and, only if required again, a new challenge. No
        // previous verify payload or token is replayed. Disposal drains input
        // and HTTP work before another attempt may own this page.
      } finally {
        this.captchaReaders.delete(page);
        await monitor?.dispose();
      }
      await delay(250, signal);
    }
  }

  async readChapterText(page, chapter, signal) {
    await this.navigate(page, chapter.url, signal);
    let deadline = Date.now() + this.contentTimeoutMs;
    let resumed = false;
    while (Date.now() < deadline) {
      abortIfNeeded(signal);
      let reader = await page.evaluate(readReaderDocument);
      if (await this.captchaReaders.get(page)?.settle()) {
        abortIfNeeded(signal);
        if (!resumed) {
          resumed = true;
          deadline = Date.now() + this.contentTimeoutMs;
        }
        reader = await page.evaluate(readReaderDocument);
        if (reader.novelCaptcha) {
          await delay(100, signal);
          continue;
        }
      }
      if (reader.challenge || reader.verificationKind === "captcha")
        throw attention(
          reader.challenge
            ? "회차 페이지에서 사이트 보안 확인이 필요합니다."
            : "CAPTCHA 확인이 필요합니다. 서버 인증 창에서 완료한 뒤 다시 시도하세요.",
          "captcha",
        );
      if (reader.verificationRequired) {
        const authentication = await this.authenticateNavigation(
          page,
          signal,
          true,
        );
        if (authentication?.authenticated && !authentication.reused) {
          await this.navigate(page, chapter.url, signal, {
            preserveAuthentication: true,
          });
          continue;
        }
        throw attention(
          reader.verificationReason || reader.notice,
          "authentication",
        );
      }
      if (reader.text) return reader.text;
      if (/아직 준비되지|본문이 없습니다|삭제된/.test(reader.notice))
        throw new Error("사이트에 회차 본문이 준비되지 않았습니다.");
      await delay(500, signal);
    }
    throw new Error("30초 동안 회차 본문이 표시되지 않았습니다.");
  }

  async exportBook(job, chapters) {
    const collected = [];
    for (const chapter of chapters) {
      const saved = chapter.text
        ? chapter
        : await this.store.readChapter(job.bookId, chapter.id);
      if (saved?.text) collected.push(saved);
    }
    if (!collected.length) return { exports: [] };
    collected.sort((a, b) => a.number - b.number);
    const name = `${filename(job.title)}_${collected[0].number}-${collected.at(-1).number}`;
    const exports = [];
    for (const format of job.format === "epub" ? ["txt", "epub"] : ["txt"]) {
      const bytes =
        format === "epub"
          ? await buildEpub(job.title, collected)
          : buildTxt(job.title, collected);
      await this.store.writeExport(job.id, format, bytes, `${name}.${format}`);
      exports.push({
        format,
        filename: `${name}.${format}`,
        mimeType:
          format === "epub"
            ? "application/epub+zip"
            : "text/plain;charset=utf-8",
      });
    }
    return { exports };
  }

  async collectionPlan(page, job, hooks, signal, bookId) {
    const stored = await this.store.readCatalog(bookId);
    const complete = stored?.chapters?.length > 0 &&
      stored.expectedChapters === stored.chapters.length &&
      new Set(stored.chapters.map(c => c.url)).size === stored.chapters.length;
    const fresh = Date.now() - Date.parse(stored?.catalogVerifiedAt || "") < 30 * 60 * 1000;
    const cached = job.retryOnlyFailed || (complete && (job.resumeCatalog || fresh)) ? stored : null;
    if (cached) await hooks.event("info", "검증된 저장 목차 재사용 · 목차 재스캔 생략");
    const plan = cached
      ? { ...cached, allChapters: cached.chapters, chapters: cached.chapters.filter(c =>
          (job.startEpisode == null || c.number >= job.startEpisode) &&
          (job.endEpisode == null || c.number <= job.endEpisode)) }
      : await this.catalog(page, job, hooks, signal);
    if (!job.retryOnlyFailed) return plan;
    const allChapters = plan.allChapters;
    const selected = job.retryChapterIds ? new Set(job.retryChapterIds) : null;
    if (
      selected &&
      [...selected].some(
        (id) => !allChapters.some((chapter) => chapter.id === id),
      )
    )
      throw new Error("재시도 회차가 저장된 목차에 없습니다.");
    const failures = await this.store.listFailures(bookId);
    const failedIds = new Set(failures.map((chapter) => chapter.id));
    const candidates = allChapters.filter(
      (chapter) =>
        (job.startEpisode == null || chapter.number >= job.startEpisode) &&
        (job.endEpisode == null || chapter.number <= job.endEpisode) &&
        (!selected || selected.has(chapter.id)),
    );
    const chapters = [];
    for (const chapter of candidates) {
      const failed = failedIds.has(chapter.id);
      const saved = (await this.store.readChapter(bookId, chapter.id))?.text;
      if (selected && !failed && saved)
        throw new Error(
          "이미 정상 저장된 회차는 실패 재시도에 선택할 수 없습니다.",
        );
      if (failedIds.size ? failed : !saved) chapters.push(chapter);
    }
    return {
      ...plan,
      allChapters,
      chapters,
      expectedChapters: allChapters.length,
    };
  }

  async saveFailure(bookId, chapter, error, jobId) {
    const code = error.code || "CHAPTER_ERROR",
      message = cleanMessage(error.message);
    await this.store.recordFailure(bookId, chapter, {
      code,
      message,
      retryable: true,
      jobId,
    });
    return { ...chapter, error: message, code };
  }

  async run(job, hooks, signal) {
    return runCollection.call(this, job, hooks, signal, makeBookId(job.url));
  }
}
