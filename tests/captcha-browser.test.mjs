import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { Collector } from "../src/collector.mjs";
import { CaptchaBrowserSupport } from "../src/captcha-browser.mjs";
import { createCaptchaAnalyzer } from "../src/captcha-analyzer.mjs";

const target = "https://sbxh9.com/novel/1/2";
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";
const challenge = { challengeId: "local-challenge", background: png, width: 320, height: 160, pieceWidth: 60, pieceHeight: 60, y: 51 };

async function fixture(t, options = {}) {
  const calls = { create: [], verify: [], content: [], analyze: 0 };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    res.setHeader("content-type", "application/json");
    const kind = req.url.endsWith("/create") ? "create" : "verify";
    calls[kind].push({ raw, headers: req.headers });
    if (kind === "create") res.end(JSON.stringify({ ok: true, challenge: options.challenge ?? challenge }));
    else {
      if (options.verifyDelay) await new Promise((r) => setTimeout(r, options.verifyDelay));
      res.end(JSON.stringify(options.verifyBody ?? { ok: true, token: "local-captcha-grant", remaining: 50 }));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const bundledBrowser = new URL("../browser/chrome-linux64/chrome", import.meta.url).pathname;
  const browser = await chromium.launch({
    executablePath: process.env.BROWSER_PATH || (existsSync(bundledBrowser) ? bundledBrowser : undefined),
    headless: true,
  });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.addCookies([{ name: "local-session", value: "current-cookie", url: new URL(target).origin }]);
  const page = await context.newPage();
  await page.addInitScript((opts) => { window.fixtureOptions = opts; }, { shortTrail: !!options.shortTrail, duplicate: !!options.duplicate });
  const html = await readFile(new URL("./fixtures/captcha-reader.html", import.meta.url), "utf8");
  // All browsing is fulfilled locally. Only the isolated server receives POSTs.
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === target) return route.fulfill({ contentType: "text/html", body: html });
    if (url.endsWith("/api/novel-content")) {
      const body = route.request().postDataJSON();
      calls.content.push(body);
      if (options.duplicate && calls.content.length === 2)
        await new Promise((r) => setTimeout(r, 2600));
      const accepted = options.noCaptcha || (body.captchaToken === "local-captcha-grant" && !options.repeat);
      return route.fulfill({ status: accepted ? 200 : 429, contentType: "application/json", body: JSON.stringify(
        accepted ? { ok: true } : { error: "captcha_required_daily_quota" },
      ) });
    }
    return route.abort();
  });
  const support = new CaptchaBrowserSupport({
    timeoutMs: options.timeoutMs ?? 10000,
    allowRequest: async () => true,
    fetchResponse: async (route, opts) => route.fetch({ ...opts,
      headers: await route.request().allHeaders(),
      url: `http://127.0.0.1:${server.address().port}${new URL(route.request().url()).pathname}` }),
    analyze: options.analyze ?? (async (c) => {
      calls.analyze++;
      return { challengeId: c.challengeId, targetX: 117.4, targetY: c.y, matchScore: .99, candidateMargin: .2, decision: options.abstain ? "abstain" : "accept" };
    }),
  });
  const collector = new Collector({ store: {}, captchaSupport: support, contentTimeoutMs: 5000,
    viewerOrigins: { resolve: () => target, assertNavigation: (_a, actual) => assert.equal(actual, target) },
  });
  return { calls, page, support, collector };
}

test("native browser trail hands a validated token to fresh content nonce/proof in the same session", async (t) => {
  const f = await fixture(t);
  const text = await f.collector.chapterText(f.page, { url: "https://newtoki1.org/novel/1/2" });
  assert.equal(text, "Local verified content");
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.verify.length, 1);
  assert.equal(f.calls.create[0].raw, "");
  assert.equal(f.calls.create[0].headers["x-nv-session"], undefined);
  assert.match(f.calls.create[0].headers.cookie, /local-session=current-cookie/);
  const submitted = JSON.parse(f.calls.verify[0].raw);
  assert.equal(submitted.challengeId, challenge.challengeId);
  assert.equal(submitted.x, 117);
  assert.equal(submitted.y, 51);
  assert.ok(submitted.trail.at(-1).t >= 1800 && submitted.trail.at(-1).t <= 4500);
  assert.ok(submitted.trail.some((point) => !Number.isInteger(point.x)), "native fractional x samples survive unchanged");
  assert.ok(submitted.trail.some((point) => !Number.isInteger(point.t)), "native performance timestamps retain fractional milliseconds");
  assert.equal(f.calls.content.length, 2);
  assert.equal(f.calls.content[1].captchaToken, "local-captcha-grant");
  assert.notEqual(f.calls.content[0].nonce, f.calls.content[1].nonce);
  assert.notEqual(f.calls.content[0].proof, f.calls.content[1].proof);
});

test("no CAPTCHA means no create, analysis, verify, or drag", async (t) => {
  const f = await fixture(t, { noCaptcha: true });
  assert.equal(await f.collector.chapterText(f.page, { url: "https://newtoki1.org/novel/1/2" }), "Local verified content");
  assert.equal(f.calls.create.length + f.calls.verify.length + f.calls.analyze, 0);
});

test("a delayed quota response from a concurrent original request shares the ongoing attempt", async (t) => {
  const f = await fixture(t, { duplicate: true, verifyDelay: 600 });
  assert.equal(await f.collector.chapterText(f.page, { url: "https://newtoki1.org/novel/1/2" }), "Local verified content");
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.verify.length, 1);
  assert.equal(f.calls.content.length, 3);
});

test("OpenCV plus actual browser pointer events completes the isolated reader flow", async (t) => {
  const challenge = JSON.parse(execFileSync(new URL("../.venv-captcha/bin/python", import.meta.url).pathname,
    ["-c", 'import sys,json; sys.path.insert(0,"tests"); from captcha_position_test import fixture; print(json.dumps(fixture()))'],
    { cwd: new URL("../", import.meta.url), encoding: "utf8" }));
  const f = await fixture(t, { challenge, analyze: createCaptchaAnalyzer({ profile: { minScore: .85, minMargin: .12 } }) });
  assert.equal(await f.collector.chapterText(f.page, { url: "https://newtoki1.org/novel/1/2" }), "Local verified content");
  assert.equal(JSON.parse(f.calls.verify[0].raw).x, 117);
});

test("late verify success after timeout never resumes content or submits twice", async (t) => {
  const f = await fixture(t, { timeoutMs: 3000, verifyDelay: 1000 });
  await assert.rejects(f.collector.chapterText(f.page, { url: "https://newtoki1.org/novel/1/2" }),
    (e) => e.captchaCode === "VERIFY_RESULT_UNKNOWN");
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(f.calls.verify.length, 1);
  assert.equal(f.calls.content.length, 1);
});

test("navigation during analysis cancels before any verification", async (t) => {
  let started;
  const analyzing = new Promise((r) => { started = r; });
  const f = await fixture(t, { analyze: async () => { started(); return new Promise(() => {}); } });
  const work = f.collector.chapterText(f.page, { url: "https://newtoki1.org/novel/1/2" });
  const rejected = assert.rejects(work, (e) => e.code === "NEEDS_ATTENTION" && e.captchaCode === "CONTEXT_CHANGED");
  await analyzing;
  await f.page.goto("about:blank");
  await rejected;
  assert.equal(f.calls.verify.length, 0);
});

for (const [name, options, code, verifies] of [
  ["ambiguous position", { abstain: true }, "POSITION_UNCERTAIN", 0],
  ["server rejection", { verifyBody: { ok: false, error: "too_fast" } }, "VERIFY_REJECTED", 1],
  ["malformed success", { verifyBody: { ok: true, token: " " } }, "VERIFY_INVALID_RESPONSE", 1],
  ["short trail", { shortTrail: true }, "TRAIL_INVALID", 0],
  ["repeat CAPTCHA", { repeat: true }, "CAPTCHA_REPEAT_LIMIT", 1],
]) test(`${name} holds the chapter and suppresses native automatic retries`, async (t) => {
  const f = await fixture(t, options);
  await assert.rejects(f.collector.chapterText(f.page, { url: "https://newtoki1.org/novel/1/2" }), (error) =>
    error.code === "NEEDS_ATTENTION" && error.captchaCode === code,
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.verify.length, verifies);
  assert.ok(f.calls.content.length <= 2);
  await f.support.release(f.page);
  assert.equal(f.support.pages.has(f.page), false, "human takeover removes the automatic attempt latch");
});
