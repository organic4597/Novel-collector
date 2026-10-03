import { lookup } from "node:dns/promises";
import { browserProxyOptions } from "./browser-proxy.mjs";
import { isPublicAddress, readReaderDocument } from "./collector.mjs";
import { parseRetryAfter } from "./retry-after.mjs";

export class SourceRequestGate {
  constructor({
    owner,
    backoff,
    normalizeUrl,
    attention,
    resolveUrl,
    validateNavigation,
  }) {
    this.owner = owner;
    this.backoff = backoff;
    this.normalizeUrl = normalizeUrl;
    this.attention = attention;
    this.resolveUrl = resolveUrl || ((url) => url);
    this.validateNavigation = validateNavigation;
    this.epoch = 0;
  }
  snapshot() {
    return typeof this.backoff?.snapshot === "function"
      ? this.backoff.snapshot()
      : this.backoff?.snapshot || { active: false };
  }
  get active() {
    return !!this.snapshot().active;
  }
  isHeld(host = "newtoki1.org") {
    // Public listing/profile/cover reads do not consume protected chapter bodies.
    // Their own HTTP responses and rendered challenges still fail navigation.
    if (this.owner.publicMetadata) return false;
    return (
      /^newtoki\d*\.(org|com|net|me)$/i.test(host) &&
      !!this.attention?.isHeld(host)
    );
  }
  assertAvailable(host = "newtoki1.org") {
    this.owner.checkOpen();
    if (this.isHeld(host)) {
      const site = this.attention
        .snapshot?.()
        .sites?.find((site) => site.host === host && site.held);
      throw Object.assign(
        new Error(site?.reason || "원본 사이트의 인증을 먼저 완료하세요."),
        { status: 503, code: "SITE_VERIFICATION_REQUIRED", siteHost: host },
      );
    }
    const state = this.snapshot();
    if (state.active) {
      const until = state.until || state.resumeAt;
      const time = until
        ? new Date(until).toLocaleTimeString("ko-KR", {
            timeZone: "Asia/Seoul",
          })
        : "10분 뒤";
      throw Object.assign(
        new Error(
          `연속 다운로드 실패로 원본 사이트 요청을 쉬고 있습니다. ${time}에 다시 시도합니다.`,
        ),
        { status: 503, code: "REQUEST_BACKOFF", until: until || null },
      );
    }
  }
  async openContext(host = "newtoki1.org") {
    this.assertAvailable(host);
    const owner = this.owner;
    if (owner.contextPromise) return owner.contextPromise;
    if (owner.context) return owner.context;
    const epoch = this.epoch;
    owner.contextPromise = this.createContext(epoch, host)
      .then(async (context) => {
        try {
          this.assertAvailable(host);
          if (epoch !== this.epoch)
            throw Object.assign(new Error("원본 사이트 요청이 중단됐습니다."), {
              status: 503,
              code: "REQUEST_BACKOFF",
            });
          owner.context = context;
          return context;
        } catch (problem) {
          await context.close().catch(() => {});
          throw problem;
        }
      })
      .finally(() => {
        owner.contextPromise = null;
      });
    return owner.contextPromise;
  }
  async createContext(epoch, host) {
    this.assertAvailable(host);
    const owner = this.owner;
    let context;
    const connection = browserProxyOptions();
    if (owner.launchContext) context = await owner.launchContext(connection);
    else {
      const { chromium } = await import("playwright");
      context = await chromium.launchPersistentContext(owner.profileDir, {
        ...connection,
        executablePath: owner.browserPath || undefined,
        headless: true,
        chromiumSandbox: true,
        serviceWorkers: "block",
      });
    }
    try {
      await context.route("**/*", async (route) => {
        try {
          if (this.active || owner.closing || epoch !== this.epoch) {
            await route.abort();
            return;
          }
          const request = route.request(),
            url = new URL(request.url());
          // Canonical hosts are database identities only. Their former network
          // routes are disabled, including page subresources and redirects.
          if (/^newtoki\d*\.(org|com|net|me)$/i.test(url.hostname)) {
            await route.abort();
            return;
          }
          let sourceHost = host;
          if (/^newtoki\d*\.(org|com|net|me)$/i.test(url.hostname))
            sourceHost = url.hostname;
          else {
            try {
              const frameHost = new URL(request.frame?.().url?.() || "")
                .hostname;
              if (/^newtoki\d*\.(org|com|net|me)$/i.test(frameHost))
                sourceHost = frameHost;
            } catch {
              /* Initial navigation uses its target host. */
            }
          }
          if (this.isHeld(sourceHost)) {
            await route.abort();
            return;
          }
          if (
            ["image", "font", "media"].includes(request.resourceType()) ||
            url.protocol !== "https:" ||
            url.username ||
            url.password
          ) {
            await route.abort();
            return;
          }
          let cached = owner.dnsCache.get(url.hostname);
          if (!cached || owner.now() - cached.time > 60000) {
            const addresses = await lookup(url.hostname, { all: true });
            if (owner.dnsCache.size > 500) owner.dnsCache.clear();
            cached = { addresses, time: owner.now() };
            owner.dnsCache.set(url.hostname, cached);
          }
          if (
            !cached.addresses.length ||
            cached.addresses.some((item) => !isPublicAddress(item.address)) ||
            this.active ||
            this.isHeld(sourceHost)
          ) {
            await route.abort();
            return;
          }
          await route.continue();
        } catch {
          await route.abort().catch(() => {});
        }
      });
      this.assertAvailable(host);
      if (epoch !== this.epoch)
        throw Object.assign(new Error("원본 사이트 요청이 중단됐습니다."), {
          status: 503,
          code: "REQUEST_BACKOFF",
        });
      return context;
    } catch (problem) {
      await context.close().catch(() => {});
      throw problem;
    }
  }
  async navigate(page, url) {
    const siteHost = new URL(url).hostname;
    this.assertAvailable(siteHost);
    const target = this.resolveUrl(url);
    const response = await page.goto(target, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    this.assertAvailable(siteHost);
    await this.assertResponse(response, siteHost);
    try {
      this.normalizeUrl(page.url());
      this.validateNavigation?.(url, page.url());
    } catch {
      throw Object.assign(new Error("사이트가 다른 페이지로 이동했습니다."), {
        code: "NEEDS_ATTENTION",
      });
    }
    const reader = await page.evaluate(readReaderDocument);
    if (reader.challenge || reader.verificationRequired) {
      const problem = Object.assign(
        new Error(
          reader.challenge
            ? "사이트 보안 확인이 표시됐습니다."
            : reader.verificationReason || "원본 사이트의 인증이 필요합니다.",
        ),
        {
          code: "NEEDS_ATTENTION",
          attentionKind: reader.challenge
            ? "captcha"
            : reader.verificationKind || "authentication",
          siteHost,
        },
      );
      await this.owner.onRequestFailure?.(problem);
      throw problem;
    }
  }
  async assertResponse(response, siteHost) {
    const status = response?.status() || 200;
    if (status >= 400) {
      const header =
        typeof response.headerValue === "function"
          ? await response.headerValue("retry-after")
          : (await response.headers?.())?.["retry-after"];
      const retryAfterMs = Math.max(
        parseRetryAfter(header, this.owner.now()),
        status === 429 ? 600000 : 0,
      );
      const problem = Object.assign(
        new Error(
          [401, 403, 429].includes(status)
            ? `사이트 접근 확인이 필요합니다 (HTTP ${status}).`
            : `작품 목록 요청 실패 (HTTP ${status}).`,
        ),
        { httpStatus: status, retryAfterMs, siteHost },
      );
      if ([401, 403, 429].includes(status)) problem.code = "NEEDS_ATTENTION";
      if (status === 401) problem.attentionKind = "authentication";
      if (status === 403) problem.attentionKind = "site_blocked";
      if (status === 429 || retryAfterMs > 0 || [401, 403].includes(status))
        await this.owner.onRequestFailure?.(problem);
      throw problem;
    }
  }
  async suspend() {
    this.epoch++;
    const context = this.owner.context;
    this.owner.context = null;
    // A context still being created checks this epoch before it can be exposed.
    this.owner.contextPromise?.catch(() => {});
    await context?.close().catch(() => {});
  }
}
