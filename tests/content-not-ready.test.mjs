import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JSDOM } from "jsdom";
import { chromium } from "playwright";
import { Collector, readReaderDocument } from "../src/collector.mjs";
import { webtoonNavigate, defaultWebtoonPreset } from "../src/webtoon-runtime.mjs";
import { extractWebtoonImages } from "../src/webtoon-images.mjs";
import { presetHash } from "../src/preset-runtime.mjs";
import { FolderStore } from "../src/store.mjs";

const heading = "본문이 아직 준비되지 않았습니다";
const panel = `<section><h3>${heading}</h3><p>이 회의 본문은 곧 업데이트될 예정입니다. 다른 회차부터 먼저 읽어보세요.</p><a href="https://example.org/">원문 사이트에서 보기 →</a></section>`;
const url = type => `https://sbxh9.com/${type}/123/456`;
function document(t, html, type = "novel") {
  const dom = new JSDOM(html, { url: url(type) });
  t.after(() => dom.window.close());
  return dom.window.document;
}

test("visible unavailable panels are distinct from CAPTCHA and never become body text", t => {
  for (const type of ["novel", "webtoon", "manhwa"]) {
    for (const html of [panel, `<div data-theme-novel-content>${panel}</div>`, `<div class="vw-imgs">${panel}</div>`]) {
      const reader = readReaderDocument(document(t, html, type));
      assert.equal(reader.contentNotReady, true, `${type}: ${html}`);
      assert.equal(reader.text, "");
      assert.equal(reader.challenge, false);
      assert.equal(reader.verificationRequired, false);
      assert.match(reader.notice, /본문이 아직 준비되지/);
    }
  }
  assert.equal(readReaderDocument(document(t, `<div id="novel_content"><div class="wr-none">${heading}.</div></div>`)).contentNotReady, true);
});

test("the complete notice as direct text in known reader containers is unavailable", t => {
  const text = `${heading}<br>이 회의 본문은 곧 업데이트될 예정입니다. 다른 회차부터 먼저 읽어보세요.<br><a>원문 사이트에서 보기 →</a>`;
  for (const html of [`<div id="novel_content"><div class="wr-none">${text}</div></div>`, `<div class="vw-imgs">${text}</div>`])
    assert.equal(readReaderDocument(document(t, html, "webtoon")).contentNotReady, true);
});

test("hidden panels, actual body quotations and loading images are not unavailable content", t => {
  for (const hidden of ['hidden', 'aria-hidden="true"', 'style="display:none"', 'style="visibility:hidden"']) {
    const doc = document(t, `<div ${hidden}>${panel}</div>`);
    assert.equal(readReaderDocument(doc).contentNotReady, false);
    const shadowHost = doc.createElement("div");
    shadowHost.setAttribute(hidden.split("=")[0], hidden.includes("=") ? hidden.split('"')[1] : "");
    shadowHost.attachShadow({mode:"open"}).innerHTML = `<div data-theme-novel-content>${panel}</div>`;
    doc.body.append(shadowHost);
    const reader = readReaderDocument(doc);
    assert.equal(reader.contentNotReady, false);
    assert.equal(reader.text, "");
  }
  const quote = `${heading}. 이 회의 본문은 곧 업데이트될 예정입니다. 다른 회차부터 먼저 읽어보세요. 라는 안내를 보고 주인공이 웃었다.`;
  assert.equal(readReaderDocument(document(t, `<div id="novel_content"><p>${quote}</p></div>`)).text, quote);
  assert.equal(readReaderDocument(document(t, `<div id="novel_content"><p>${quote}</p></div>`)).contentNotReady, false);
  assert.equal(readReaderDocument(document(t, `<div class="vw-imgs"><img src="https://example.org/loading.png"></div>${panel}`, "webtoon")).contentNotReady, false);
  assert.equal(readReaderDocument(document(t, "")).contentNotReady, false);
});

test("real security and login notices retain priority over unavailable panels", t => {
  const challenged = readReaderDocument(document(t, `${panel}<div class="cf-turnstile"></div>`));
  assert.equal(challenged.challenge, true);
  assert.equal(challenged.contentNotReady, false);
  const login = readReaderDocument(document(t, `${panel}<div id="novel_content"><div class="wr-none">로그인이 필요합니다.</div></div>`));
  assert.equal(login.verificationRequired, true);
  assert.equal(login.contentNotReady, false);
});

test("all visible authentication notices and Shadow DOM challenges take precedence", t => {
  for (const barrier of ["로그인이 필요합니다.", "일일 조회 인증이 필요합니다."]) {
    for (const body of [`<div class="wr-none">${heading}.</div>`, panel]) {
      const reader = readReaderDocument(document(t, `<div id="novel_content">${body}<div class="wr-none">${barrier}</div></div>`));
      assert.equal(reader.verificationRequired, true);
      assert.equal(reader.contentNotReady, false);
    }
  }
  const doc = document(t, '<div id="shadow-host"></div>');
  doc.querySelector("#shadow-host").attachShadow({mode:"open"}).innerHTML = panel + '<div aria-label="퍼즐 슬라이더"></div>';
  const reader = readReaderDocument(doc);
  assert.equal(reader.challenge, true);
  assert.equal(reader.novelCaptcha, true);
  assert.equal(reader.contentNotReady, false);
});

test("novel unavailable panel raises typed failure before login or content timeout", async t => {
  const doc = document(t, panel);
  let authCalls = 0;
  const collector = new Collector({store:{}, contentTimeoutMs:30});
  collector.authenticateNavigation = async () => { authCalls++; };
  const page = { url: () => "https://newtoki1.org/novel/123/456", goto: async () => ({status:()=>200}), evaluate: async fn => fn(doc) };
  await assert.rejects(collector.chapterText(page, {url:page.url()}, new AbortController().signal), {code:"CONTENT_NOT_READY"});
  assert.equal(authCalls, 0);
  collector.navigate = async () => {};
  await assert.rejects(collector.readChapterText(page, {url:page.url()}, new AbortController().signal), {code:"CONTENT_NOT_READY"});
});

test("image navigation skips unavailable chapters but preserves HTTP and CAPTCHA barriers", async t => {
  const doc = document(t, panel, "webtoon");
  const page = {url:()=>url("webtoon"), goto:async()=>({}), evaluate:async fn=>fn(doc)};
  const owner = {responseProblem:async()=>null, authenticateNavigation:async()=>assert.fail("unavailable body must not trigger login")};
  await assert.rejects(webtoonNavigate.call(owner,page,page.url()), {code:"CONTENT_NOT_READY"});
  for (const status of [401,403,429]) {
    const barrier = Object.assign(Error("HTTP barrier"), {code:`HTTP_${status}`,httpStatus:status});
    await assert.rejects(webtoonNavigate.call({...owner,responseProblem:async()=>barrier},page,page.url()), error=>error===barrier);
  }
  doc.body.insertAdjacentHTML("beforeend", '<div class="cf-turnstile"></div>');
  await assert.rejects(webtoonNavigate.call(owner,page,page.url()), {code:"NEEDS_ATTENTION",attentionKind:"captcha"});
});

test("late unavailable panel during image polling exits without successful or partial chapter data", async t => {
  const root = await mkdtemp(join(tmpdir(), "unavailable-image-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store = await new FolderStore(root).init(), doc = document(t,"","webtoon");
  const config = defaultWebtoonPreset(), chapter = {id:"abcdef123456",url:url("webtoon")};
  const page = new EventEmitter();
  page.evaluate = async (fn,arg)=>arg ? fn(arg,doc) : fn(doc);
  page.waitForTimeout = async ()=>{doc.body.innerHTML=panel;};
  const owner = {store,contentTimeoutMs:30,webtoonNavigate:async()=>{}};
  await assert.rejects(extractWebtoonImages.call(owner,page,{bookId:"fixture",presetSnapshot:config,presetHash:presetHash(config)},chapter), {code:"CONTENT_NOT_READY"});
  assert.equal(await store.json(store.path("books","fixture","chapters",chapter.id,"partial.json")),null);
  assert.equal(page.listenerCount("response"),0);
});


test("Chromium skips an unavailable reader and reads the next normal chapter", async t => {
  const browser = await chromium.launch({headless:true,executablePath:process.env.BROWSER_PATH || undefined});
  t.after(()=>browser.close());
  const page = await browser.newPage();
  await page.route("**/*", route=>route.fulfill({contentType:"text/html; charset=utf-8",body:route.request().url().endsWith("/456")?`<div id="novel_content">${panel}</div>`:'<div id="novel_content"><p>정상 회차 첫 줄</p><p>마지막 문단</p></div>'}));
  const collector = new Collector({store:{},contentTimeoutMs:500});
  collector.navigate = async (page,url)=>page.goto(url);
  await assert.rejects(collector.readChapterText(page,{url:url("novel")},new AbortController().signal),{code:"CONTENT_NOT_READY"});
  assert.equal(await collector.readChapterText(page,{url:url("novel").replace("/456","/457")},new AbortController().signal),"정상 회차 첫 줄\n\n마지막 문단");
});
