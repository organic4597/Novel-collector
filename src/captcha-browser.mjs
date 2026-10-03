import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { isPublicAddress } from "./collector.mjs";
import { CaptchaError, NovelCaptcha, CAPTCHA_REQUIRED, abortable, verifyResult } from "./novel-captcha.mjs";
import { createCaptchaAnalyzer } from "./captcha-analyzer.mjs";
import { parseRetryAfter } from "./retry-after.mjs";
import { validateTrail, TRAIL_TARGET_MS, TRAIL_MIN_MS, TRAIL_MAX_MS } from "./captcha-trail.mjs";

const endpoints = /\/api\/novel-captcha\/(create|verify)$/;
const origins = new Set(["https://sbxh9.com", "https://toki32.com"]);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const attention = (code) => Object.assign(
  new Error(`CAPTCHA 확인이 필요합니다. 서버 인증 창에서 확인하세요. (${code})`),
  { code: "NEEDS_ATTENTION", attentionKind: "captcha", captchaCode: code },
);

// Native renderer owns create/verify payloads, its real pointer trail, and the
// onVerified(token) callback that builds a fresh content nonce/proof. We never
// replay content requests, patch their body, or infer a token's reuse budget.
export class CaptchaBrowserSupport {
  constructor({ analyze = createCaptchaAnalyzer(), backoff = null, log = () => {},
    timeoutMs = 20000, dragDurationMs = TRAIL_TARGET_MS,
    fetchResponse = (route, options) => route.fetch(options),
    allowRequest = async (url) => {
      const addresses = await lookup(new URL(url).hostname, { all: true });
      return addresses.length > 0 && addresses.every(({ address }) => isPublicAddress(address));
    },
  } = {}) {
    if (!Number.isFinite(dragDurationMs) || dragDurationMs < TRAIL_MIN_MS || dragDurationMs > TRAIL_MAX_MS)
      throw new TypeError("CAPTCHA drag duration must be 1800..4500ms");
    this.coordinator = new NovelCaptcha({ analyze, log, timeoutMs });
    Object.assign(this, { backoff, dragDurationMs, allowRequest, fetchResponse });
    this.sessions = new WeakMap();
    this.pages = new WeakMap();
  }

  async release(page) {
    const previous = this.pages.get(page);
    if (previous) await previous.dispose(false);
  }

  async attach(page, { url, signal, onProgress } = {}) {
    if (!page.on || !page.route || !page.context || !origins.has(new URL(url).origin)) return null;
    await this.release(page);
    const context = page.context();
    let session = this.sessions.get(context);
    if (!session) { session = { key: randomUUID() }; this.sessions.set(context, session); }
    const monitor = new CaptchaPage(this, page, session, url, signal, onProgress);
    this.pages.set(page, monitor);
    await monitor.install();
    return monitor;
  }
}

class CaptchaPage {
  constructor(support, page, session, url, signal, onProgress) {
    Object.assign(this, { support, page, session, url, signal, onProgress });
    this.origin = new URL(url).origin;
    this.controller = new AbortController();
    this.requests = new WeakMap();
    this.reading = new Set();
    this.routing = new Set();
    this.created = deferred();
    this.verified = deferred();
    this.epoch = 0;
    this.attempted = false;
    this.createSeen = false;
    this.verifySeen = false;
    this.handoff = false;
    this.closed = false;
    this.failure = null;
    this.work = null;
    this.route = (route) => {
      const work = this.intercept(route);
      this.routing.add(work);
      work.finally(() => this.routing.delete(work));
      return work;
    };
    this.onAbort = () => this.controller.abort();
    this.onClose = () => { this.closed = true; this.controller.abort(); };
    this.onNavigation = (frame) => {
      if (frame !== page.mainFrame()) return;
      this.epoch++;
      if (this.attempted) {
        this.failure = "CONTEXT_CHANGED";
        this.controller.abort();
      }
    };
    this.onRequest = (request) => {
      this.requests.set(request, { epoch: this.epoch, afterHandoff: this.handoff });
    };
    this.onResponse = (response) => {
      const work = this.observe(response).catch(() => {});
      this.reading.add(work);
      work.finally(() => this.reading.delete(work));
    };
  }

  current(epoch = this.epoch) {
    return !this.closed && !this.controller.signal.aborted && this.epoch === epoch && this.page.url() === this.url;
  }

  async install() {
    this.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (this.signal?.aborted) this.onAbort();
    this.page.on("request", this.onRequest);
    this.page.on("response", this.onResponse);
    this.page.on("framenavigated", this.onNavigation);
    this.page.on("close", this.onClose);
    await this.page.route(endpoints, this.route);
  }

  async observe(response) {
    const request = response.request();
    const requested = this.requests.get(request);
    if (!this.current() || requested?.epoch !== this.epoch ||
        response.url() !== `${this.origin}/api/novel-content` || request.method() !== "POST" ||
        request.frame() !== this.page.mainFrame()) return;
    const ids = this.url.match(/\/novel\/(\d+)\/(\d+)\/?$/);
    let submitted;
    try { submitted = request.postDataJSON(); } catch { return; }
    if (!ids || String(submitted?.novelId) !== ids[1] || String(submitted?.episodeId) !== ids[2]) return;
    const epoch = this.epoch;
    let body;
    try {
      body = await abortable(response.json(), AbortSignal.any([
        this.controller.signal, AbortSignal.timeout(5000),
      ]));
    } catch { return; }
    if (!this.current(epoch) || body?.error !== CAPTCHA_REQUIRED) return;
    if (this.attempted) {
      // A new content request was rejected after the token handoff. No second
      // challenge for this interrupted chapter, even if the renderer retries.
      if (requested.afterHandoff) this.failure = "CAPTCHA_REPEAT_LIMIT";
      return;
    }
    this.attempted = true;
    this.work = this.support.coordinator.handle({
      session: this.session, requestId: randomUUID(),
      event: { source: "response", error: body.error },
      signal: this.controller.signal, isCurrent: () => this.current(epoch),
      onProgress: (event) => {
        this.progressWork = (this.progressWork || Promise.resolve()).catch(() => {}).then(() => this.onProgress?.(event));
        return this.progressWork;
      },
      create: ({ signal }) => abortable(this.created.promise, signal),
      verify: (challenge, answer, options) => {
        this.dragWork = this.drag(challenge, answer, options);
        return this.dragWork;
      },
    }).then((result) => {
      // Keep only safe status after returning the grant to the native renderer.
      this.result = { ok: result.ok, error: result.error, remaining: result.remaining };
      if (!result.ok && (!this.failure || this.failure === "CANCELLED"))
        this.failure = result.error.code;
      this.created = null;
      this.verified = null;
      this.expected = null;
      return this.result;
    });
  }

  async intercept(route) {
    const request = route.request();
    const kind = new URL(request.url()).pathname.endsWith("/create") ? "create" : "verify";
    let response;
    try {
      await Promise.all([...this.reading]);
      // A retired renderer may fire its delayed create while a new navigation
      // is starting. Block it without poisoning the new document's attempt.
      if (!this.attempted) {
        await route.fulfill({ status: 409, contentType: "application/json", body: '{"ok":false,"error":"no_active_challenge"}' });
        return;
      }
      if (!this.current() || this.failure || !this.attempted ||
          request.url() !== `${this.origin}/api/novel-captcha/${kind}` ||
          request.method() !== "POST" || request.frame() !== this.page.mainFrame())
        throw new CaptchaError(this.failure || "CONTEXT_CHANGED");
      if (this.support.backoff?.snapshot().active || !(await this.support.allowRequest(request.url())))
        throw new CaptchaError("REQUEST_BLOCKED");
      if (!this.current() || this.failure) throw new CaptchaError("CONTEXT_CHANGED");
      if (kind === "create") {
        if (this.createSeen) throw new CaptchaError("CREATE_DUPLICATE");
        if (request.postDataBuffer()?.length) throw new CaptchaError("CREATE_BODY_NOT_EMPTY");
        this.createSeen = true;
      } else {
        if (this.verifySeen || !this.expected) throw new CaptchaError("VERIFY_DUPLICATE");
        validateTrail(request.postDataJSON(), this.expected.challenge, this.expected.answer);
        this.verifySeen = true;
      }
      const epoch = this.epoch;
      // The original request carries the live cookie jar and browser headers.
      // Redirects/retries are disabled. No captured headers or body are replayed.
      response = await this.support.fetchResponse(route, { timeout: 10000, maxRedirects: 0, maxRetries: 0 });
      if (!this.current(epoch) || this.failure) throw new CaptchaError(this.failure || "CONTEXT_CHANGED");
      const retryAfterMs = parseRetryAfter(response.headers()["retry-after"]);
      if (response.status() === 429 || retryAfterMs > 0) {
        this.requestBackoff = { httpStatus: response.status(), retryAfterMs: Math.max(response.status() === 429 ? 600000 : 0, retryAfterMs) };
        throw new CaptchaError("REQUEST_BLOCKED");
      }
      let body;
      try { body = await response.json(); } catch {
        throw new CaptchaError(kind === "verify" ? "VERIFY_RESULT_UNKNOWN" : "CREATE_INVALID_RESPONSE");
      }
      if (!this.current(epoch) || this.failure) throw new CaptchaError(this.failure || "CONTEXT_CHANGED");
      if (kind === "create") {
        this.created.resolve({ status: response.status(), body, receivedAt: Date.now() });
        await route.fulfill({ response });
      } else {
        const reply = { status: response.status(), body, challengeId: this.expected.challenge.challengeId };
        verifyResult(reply, this.expected.challenge.challengeId);
        // Strict success is forwarded unchanged to the original onVerified
        // callback. It alone stores the token and refreshes nonce/proof.
        this.handoff = true;
        await route.fulfill({ response });
        this.verified.resolve(reply);
      }
    } catch (error) {
      const problem = error instanceof CaptchaError ? error : new CaptchaError(
        kind === "verify" && this.verifySeen ? "VERIFY_RESULT_UNKNOWN" : "CREATE_INVALID_RESPONSE",
      );
      this.failure ??= problem.code;
      if (kind === "verify") this.verified?.resolve({ error: problem });
      else this.created?.resolve({ error: problem });
      // Return no token or upstream debug fields on failure. The native delayed
      // create retry is held by this route until explicit human takeover.
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: problem.serverError || problem.code }) }).catch(() => {});
    } finally {
      await response?.dispose().catch(() => {});
    }
  }

  async drag(challenge, answer, { signal }) {
    this.expected = { challenge, answer };
    const slider = this.page.getByRole("button", { name: "퍼즐 슬라이더", exact: true });
    let down = false;
    try {
      await slider.waitFor({ state: "visible", timeout: 5000 });
      if (signal.aborted || !this.current()) throw new CaptchaError("CANCELLED");
      // Visibility alone includes elements below the viewport. Native mouse
      // coordinates must target the slider after ordinary page scrolling.
      await slider.scrollIntoViewIfNeeded({ timeout: 5000 });
      const geometry = await slider.evaluate((button) => {
        const track = button.parentElement;
        const box = button.getBoundingClientRect();
        const rail = track.getBoundingClientRect();
        const images = track.previousElementSibling?.querySelectorAll("img");
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { x: box.x + box.width / 2, y: box.y + box.height / 2,
          trackWidth: Math.max(160, rail.width), knobWidth: box.width,
          atStart: Math.abs(box.left - rail.left - track.clientLeft) < 2,
          hitButton: hit === button || button.contains(hit),
          background: images?.[0]?.getAttribute("src"), piece: images?.[1]?.getAttribute("src") };
      });
      if (signal.aborted) throw new CaptchaError("CANCELLED");
      if (!geometry.hitButton) throw new CaptchaError("CAPTCHA_INPUT_BLOCKED");
      if (!this.current() || !geometry.atStart || Math.abs(geometry.knobWidth - 44) > 0.5 ||
          geometry.background !== challenge.background || (challenge.piece && geometry.piece !== challenge.piece))
        throw new CaptchaError("CLIENT_CONTRACT_CHANGED");
      const distance = answer.targetX * Math.max(1, geometry.trackWidth - 44) / Math.max(1, challenge.width - challenge.pieceWidth);
      await this.page.mouse.move(geometry.x, geometry.y);
      if (signal.aborted || !this.current()) throw new CaptchaError("CANCELLED");
      await this.page.mouse.down();
      down = true;
      const started = performance.now();
      for (let step = 1; step <= 24; step++) {
        const wait = started + this.support.dragDurationMs * step / 24 - performance.now();
        if (wait > 0) await sleep(wait, undefined, { signal });
        if (signal.aborted || !this.current()) throw new CaptchaError("CANCELLED");
        await this.page.mouse.move(geometry.x + distance * step / 24, geometry.y);
      }
      await this.page.mouse.up();
      down = false;
      const reply = await abortable(this.verified.promise, signal);
      if (reply.error) throw reply.error;
      return reply;
    } catch (error) {
      this.failure ??= error instanceof CaptchaError ? error.code : signal.aborted ? "CANCELLED" : "CLIENT_CONTRACT_CHANGED";
      throw error instanceof CaptchaError ? error : new CaptchaError(this.failure);
    } finally {
      // A failed drag must not leak a pressed pointer into the human session.
      // The failure latch blocks any submission emitted by this release.
      if (down) await this.page.mouse.up().catch(() => {});
    }
  }

  async settle() {
    await Promise.all([...this.reading]);
    if (this.work) await this.work;
    await this.progressWork?.catch(() => {});
    if (this.failure) throw Object.assign(attention(this.failure), this.requestBackoff ?? {});
    return this.result?.ok === true;
  }

  async dispose(keepBlocked = !!this.failure) {
    this.closed = true;
    this.controller.abort();
    await this.dragWork?.catch(() => {});
    await this.progressWork?.catch(() => {});
    await Promise.allSettled([...this.routing]);
    this.signal?.removeEventListener("abort", this.onAbort);
    this.page.off("request", this.onRequest);
    this.page.off("response", this.onResponse);
    this.page.off("framenavigated", this.onNavigation);
    this.page.off("close", this.onClose);
    if (!keepBlocked) {
      await this.page.unroute(endpoints, this.route).catch(() => {});
      if (this.support.pages.get(this.page) === this) this.support.pages.delete(this.page);
    }
  }
}
