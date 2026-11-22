import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { captureReaderRoots, installReaderSupport } from "../src/reader-shadow.mjs";
import { readReaderDocument } from "../src/collector.mjs";

function reader(t, url = "https://sbxh9.com/novel/123/456") {
  const dom = new JSDOM('<article class="novel-viewer"><div id="body"></div></article><section id="comments-anchor"><div id="comments"></div></section>',
    { url, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  dom.window.eval(`(${captureReaderRoots.toString()})()`);
  return dom.window.document;
}

test("reader captures a displayed closed root without changing its closed mode or including comments", t => {
  const doc = reader(t), host = doc.getElementById("body");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = "<style>ignore</style><p>합성 첫 문단<br>다음 줄</p><p>둘째 문단</p>";
  const comments = doc.getElementById("comments").attachShadow({ mode: "closed" });
  comments.innerHTML = "<p>" + "본문이 아닌 댓글 ".repeat(100) + "</p>";
  assert.equal(host.shadowRoot, null);
  assert.equal(root.mode, "closed");
  assert.equal(readReaderDocument(doc).text, "합성 첫 문단\n다음 줄\n\n둘째 문단");
});

test("reader capture is limited to supported chapter pages and never invents an absent body", t => {
  for (const url of ["https://untrusted.example/novel/123/456", "https://sbxh9.com/novel/123", "https://sbxh9.com/login"]) {
    const doc = reader(t, url), host = doc.getElementById("body");
    host.attachShadow({ mode: "closed" }).innerHTML = "<p>unrelated</p>";
    assert.equal(host.__novelShadow, undefined);
    assert.equal(readReaderDocument(doc).text, "");
  }
  const doc = reader(t);
  doc.getElementById("comments").attachShadow({ mode: "closed" }).innerHTML = "<p>댓글뿐</p>";
  assert.equal(readReaderDocument(doc).text, "");
});

test("hidden reader bodies remain hidden and visible verification stays a blocker", t => {
  const doc = reader(t), host = doc.getElementById("body");
  host.attachShadow({ mode: "closed" }).innerHTML = "<p>숨긴 합성 본문</p>";
  host.hidden = true;
  assert.equal(readReaderDocument(doc).text, "");
  host.hidden = false;
  const slider = doc.createElement("button");
  slider.setAttribute("aria-label", "퍼즐 슬라이더");
  doc.body.append(slider);
  assert.equal(readReaderDocument(doc).challenge, true);
});

test("reader support registers exactly once per real context and preserves native attachment errors", async t => {
  let installed = 0;
  const context = { addInitScript: async fn => { assert.equal(fn, captureReaderRoots); installed++; } };
  await installReaderSupport(context);
  await installReaderSupport(context);
  assert.equal(installed, 1);
  const doc = reader(t), host = doc.getElementById("body");
  host.attachShadow({ mode: "closed" });
  assert.throws(() => host.attachShadow({ mode: "closed" }));
});
