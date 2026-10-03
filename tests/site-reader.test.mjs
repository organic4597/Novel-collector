import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { Collector, readReaderDocument } from "../src/collector.mjs";

test("actual daily verification notice is recognized immediately, never collected as novel text", () => {
  const dom = new JSDOM(
    '<div data-theme-novel-content><div class="wr-none">일일 조회 인증이 필요합니다. 일반 소설 뷰어에서 인증 후 다시 열어주세요.</div></div>',
  );
  const reader = readReaderDocument(dom.window.document);
  assert.equal(reader.text, "");
  assert.equal(reader.verificationRequired, true);
  assert.equal(reader.verificationKind, "captcha");
  assert.equal(reader.challenge, false);
  assert.match(reader.verificationReason, /일일 조회 인증/);
  dom.window.close();
});
test("Turnstile and reCAPTCHA challenge frames are detected while inactive login widgets are ignored", () => {
  for (const markup of [
    '<div class="cf-turnstile"></div>',
    '<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x"></iframe>',
    '<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>',
  ]) {
    const d = new JSDOM(markup);
    assert.equal(readReaderDocument(d.window.document).challenge, true);
    d.window.close();
  }
  const d = new JSDOM(
    '<div hidden><div class="g-recaptcha"></div></div><div data-theme-novel-content><p>정상 본문</p></div>',
  );
  const reader = readReaderDocument(d.window.document);
  assert.equal(reader.challenge, false);
  assert.equal(reader.text, "정상 본문");
  assert.equal(reader.verificationRequired, false);
  d.window.close();
});
test("daily auth notice throws typed attention before content polling or repeated reads", async () => {
  const c = new Collector({ store: {}, contentTimeoutMs: 50 });
  let evaluations = 0;
  const page = {
    goto: async () => ({ status: () => 200 }),
    url: () => "https://newtoki1.org/novel/1/11",
    evaluate: async () => {
      evaluations++;
      return {
        text: "",
        notice: "일일 조회 인증이 필요합니다.",
        challenge: false,
        verificationRequired: true,
        verificationKind: "captcha",
        verificationReason: "일일 조회 인증이 필요합니다.",
      };
    },
  };
  await assert.rejects(
    c.chapterText(page, { url: page.url() }, new AbortController().signal),
    (error) =>
      error.code === "NEEDS_ATTENTION" &&
      error.attentionKind === "captcha" &&
      !error.retryAfterMs,
  );
  assert.equal(evaluations, 1);
});

test("login notices remain authentication and daily wording alone is not a quota CAPTCHA", () => {
  for (const notice of [
    "로그인이 필요합니다.",
    "일일 로그인 인증이 필요합니다.",
  ]) {
    const dom = new JSDOM(
      `<div data-theme-novel-content><div class="wr-none">${notice}</div></div>`,
    );
    const reader = readReaderDocument(dom.window.document);
    assert.equal(reader.verificationRequired, true);
    assert.equal(reader.verificationKind, "authentication");
    assert.equal(reader.challenge, false);
    dom.window.close();
  }
});
test("ordinary missing-body notice remains a chapter failure and does not demand authentication", () => {
  const d = new JSDOM(
    '<div data-theme-novel-content><div class="wr-none">본문이 아직 준비되지 않았습니다.</div></div>',
  );
  const reader = readReaderDocument(d.window.document);
  assert.equal(reader.verificationRequired, false);
  assert.equal(reader.challenge, false);
  d.window.close();
});
