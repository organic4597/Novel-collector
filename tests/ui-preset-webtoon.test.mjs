import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const tick = () => new Promise(resolve => setTimeout(resolve, 30));
const fields = () => ({ root: { selector: ".vw-imgs", shadowPath: [], attribute: "text", multiple: false }, images: { selector: "img", shadowPath: [], attribute: "imageUrl", multiple: true, relativeTo: "root" } });
const config = () => ({ version: 3, contentType: "webtoon", name: "Synthetic webtoon", origin: "https://sbxh9.com", catalogOrder: "newest-first", pages: {
  listing: { pagePatterns: ["/ing", "/end"], sources: { ongoing: "/ing", completed: "/end" }, fields: {} },
  detail: { pagePatterns: ["/webtoon/{workId}"], fields: {} },
  reader: { pagePatterns: ["/webtoon/{workId}/{episodeId}"], fields: fields() },
} });

async function fixture(t, saved = [], initialBindings = []) {
  const dom = new JSDOM(await readFile(new URL("../public/index.html", import.meta.url), "utf8"), { url: "https://dashboard.example/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, calls = [], opened = [];
  let bindings = initialBindings;
  w.eval(await readFile(new URL("../public/performance.js", import.meta.url), "utf8"));
  w.CollectorUI = { node: w.CollectorPerformance.node, authenticated: () => true, view: () => "presets", generation: () => 1,
    textError: error => error.message, api: async (path, options = {}) => {
      calls.push({ path, ...options });
      if (path.endsWith("/bindings")) return { version: 1, bindings };
      if (path.endsWith("/validate")) return { valid: true, pageKind: JSON.parse(options.body).pageKind, presetHash: "fixture-hash", matches: { root: 1, images: 21 } };
      if (path.endsWith("/binding")) { bindings = options.method === "DELETE" ? [] : [{ presetId: "webtoon", origin: "https://sbxh9.com", contentType: "webtoon", validated: true }]; return { version: 1, bindings }; }
      if (options.method === "POST" || options.method === "PUT") return { id: "saved", config: JSON.parse(options.body) };
      if (path.endsWith("/defaults")) return [{ id: "novel-default", name: "Novel" }, { id: "webtoon-default", name: "Webtoon", contentType: "webtoon" }];
      if (path === "/api/extraction-presets") return saved.map(record => ({ id: record.id, name: record.config.name, origin: record.config.origin, contentType: record.config.contentType, fieldCount: 2, pages: [] }));
      return saved.find(record => path.endsWith("/" + record.id));
    } };
  w.open = (...args) => { opened.push(args); return null; };
  for (const file of ["element-picker.js", "preset-guide.js", "preset-connection.js", "extraction-presets.js"])
    w.eval(await readFile(new URL("../public/" + file, import.meta.url), "utf8"));
  w.document.dispatchEvent(new w.CustomEvent("collector:view")); await tick();
  return { w, d: w.document, calls, opened };
}

test("webtoon type builds the v3 contract, supports imageUrl, and filters defaults without activating collection", async t => {
  const { w, d, calls } = await fixture(t);
  d.getElementById("preset-content-type").value = "webtoon";
  d.getElementById("preset-content-type").dispatchEvent(new w.Event("change"));
  d.getElementById("preset-kind").value = "reader";
  d.getElementById("preset-kind").dispatchEvent(new w.Event("change"));
  d.getElementById("preset-target-field").value = "images";
  d.getElementById("preset-target-field").dispatchEvent(new w.Event("change"));
  assert.equal(d.getElementById("preset-target-attribute").value, "imageUrl");
  assert.equal(d.getElementById("preset-target-multiple").checked, true);
  assert.deepEqual([...d.getElementById("preset-default").options].map(o => o.value), ["webtoon-default"]);
  const code = decodeURIComponent(d.getElementById("preset-bookmarklet").getAttribute("href").slice(11));
  assert.ok(code.includes('"version":3'));
  assert.ok(code.includes('"contentType":"webtoon"'));
  assert.ok(code.includes('"pagePatterns":["/ing","/end"]'));
  assert.ok(!calls.some(call => call.method === "POST"));
});

test("a webtoon source URL selects its page type and the right v3 source without downloading content", async t => {
  const { w, d, opened, calls } = await fixture(t);
  const url = "https://sbxh9.com/webtoon/u-work/goodtoon-42";
  d.getElementById("preset-source-url").value = url;
  d.getElementById("preset-connect-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  assert.equal(d.getElementById("preset-content-type").value, "webtoon");
  assert.equal(d.getElementById("preset-kind").value, "reader");
  assert.equal(opened[0][0], url);
  assert.ok(!calls.some(call => call.method === "POST"));
});

test("load and explicit save preserve v3 sources, actions, order, and relative image selectors", async t => {
  const original = config();
  original.pages.detail.actions = { loadMore: { selector: "button.more", shadowPath: [], attribute: "text", multiple: false } };
  const { d, calls } = await fixture(t, [{ id: "webtoon", config: original }]);
  [...d.querySelectorAll("#preset-list button")].find(button => button.textContent === "불러오기").click(); await tick();
  assert.equal(d.getElementById("preset-content-type").value, "webtoon");
  assert.equal(d.getElementById("preset-content-type").disabled, true);
  assert.match(d.getElementById("preset-page-tree").textContent, /웹툰 이미지/);
  d.getElementById("preset-save").click(); await tick();
  const write = calls.find(call => call.method === "PUT");
  assert.deepEqual(JSON.parse(write.body), original);
  assert.ok(!calls.some(call => ["POST", "PUT", "DELETE"].includes(call.method) && /apply|activate|bindings|validate/.test(call.path)));
});

test("wrong-content source cannot silently overwrite a loaded novel preset", async t => {
  const legacy = { version: 2, name: "Existing novel", origin: "https://sbxh9.com", pages: { listing: { pagePattern: "/novel", fields: {} }, detail: { pagePattern: "/novel/{workId}", fields: { title: { selector: "h1", attribute: "text", multiple: false } } }, reader: { pagePattern: "/novel/{workId}/{episodeId}", fields: {} } } };
  const { w, d, opened } = await fixture(t, [{ id: "novel", config: legacy }]);
  [...d.querySelectorAll("#preset-list button")].find(button => button.textContent === "불러오기").click(); await tick();
  d.getElementById("preset-source-url").value = "https://sbxh9.com/webtoon/1/2";
  d.getElementById("preset-connect-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  assert.equal(opened.length, 0);
  assert.deepEqual(JSON.parse(d.getElementById("preset-json").value), legacy);
  assert.match(d.getElementById("preset-error").textContent, /새 프리셋|유형/);
});

test("v3 import rejects source values and executable options before generating a source bookmark", async t => {
  const { d, calls } = await fixture(t);
  const bad = config(); bad.cookies = "NEVER_EXPORT";
  d.getElementById("preset-json").value = JSON.stringify(bad);
  d.getElementById("preset-save").click(); await tick();
  assert.ok(!calls.some(call => ["POST", "PUT"].includes(call.method)));
  assert.match(d.getElementById("preset-error").textContent, /형식|허용|설정/);
});

test("same-type source changes update visible JSON as well as the bookmark", async t => {
  const { w, d } = await fixture(t);
  d.getElementById("preset-content-type").value = "webtoon";
  d.getElementById("preset-content-type").dispatchEvent(new w.Event("change"));
  d.getElementById("preset-source-url").value = "https://another.example/webtoon/work/ep";
  d.getElementById("preset-connect-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  assert.equal(JSON.parse(d.getElementById("preset-json").value).origin, "https://another.example");
  assert.match(d.getElementById("preset-page-tree").textContent, /another\.example/);
});

test("v3 authoring requires an explicit catalog order and webtoon listing sources", async t => {
  const { d, calls } = await fixture(t);
  for (const missing of ["catalogOrder", "sources"]) {
    const input = config();
    if (missing === "catalogOrder") delete input.catalogOrder;
    else delete input.pages.listing.sources;
    d.getElementById("preset-json").value = JSON.stringify(input);
    d.getElementById("preset-save").click(); await tick();
  }
  assert.ok(!calls.some(call => ["POST", "PUT"].includes(call.method)));
});

test("a custom v3 source path keeps the page type selected by the user", async t => {
  const { w, d } = await fixture(t);
  d.getElementById("preset-content-type").value = "webtoon";
  d.getElementById("preset-content-type").dispatchEvent(new w.Event("change"));
  d.getElementById("preset-kind").value = "reader";
  d.getElementById("preset-kind").dispatchEvent(new w.Event("change"));
  d.getElementById("preset-source-url").value = "https://another.example/comics/work/chapter";
  d.getElementById("preset-connect-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
  assert.equal(d.getElementById("preset-kind").value, "reader");
});

test("validation and binding are explicit separate actions and bound presets must be unbound before deletion", async t => {
  const { w, d, calls } = await fixture(t, [{ id: "webtoon", config: config() }]);
  [...d.querySelectorAll("#preset-list button")].find(button => button.textContent === "불러오기").click(); await tick();
  assert.equal(d.getElementById("preset-activation").hidden, false);
  const urls = { listing: "https://sbxh9.com/ing", detail: "https://sbxh9.com/webtoon/work", reader: "https://sbxh9.com/webtoon/work/ep" };
  for (const [kind, url] of Object.entries(urls)) {
    d.getElementById(`preset-check-${kind}-url`).value = url;
    d.getElementById(`preset-check-${kind}`).click(); await tick();
    assert.match(d.getElementById(`preset-check-${kind}-status`).textContent, /확인 완료/);
  }
  assert.equal(calls.filter(call => call.path.endsWith("/validate")).length, 3);
  assert.equal(calls.filter(call => call.path.endsWith("/binding")).length, 0);
  d.getElementById("preset-apply").click(); await tick();
  const apply = calls.find(call => call.path.endsWith("/binding") && call.method === "PUT");
  assert.deepEqual(JSON.parse(apply.body), {});
  assert.match(d.getElementById("preset-binding-status").textContent, /적용 중/);
  assert.equal([...d.querySelectorAll("#preset-list button")].find(button => button.textContent === "삭제").disabled, true);
  d.getElementById("preset-unbind").click(); await tick();
  assert.equal(calls.filter(call => call.path.endsWith("/binding") && call.method === "DELETE").length, 1);
  assert.equal([...d.querySelectorAll("#preset-list button")].find(button => button.textContent === "삭제").disabled, false);
});

test("validation refuses foreign-origin or authenticated URLs before any server request", async t => {
  const { d } = await fixture(t, [{ id: "webtoon", config: config() }]);
  [...d.querySelectorAll("#preset-list button")].find(button => button.textContent === "불러오기").click(); await tick();
  for (const url of ["https://foreign.example/ing", "https://sbxh9.com/ing?token=NEVER_SEND", "http://sbxh9.com/ing"]) {
    d.getElementById("preset-check-listing-url").value = url;
    d.getElementById("preset-check-listing").click(); await tick();
    assert.match(d.getElementById("preset-error").textContent, /원본|주소|인증/);
  }
});

test("unsaved selector or source edits cannot validate or apply the old saved configuration", async t => {
  const { w, d, calls } = await fixture(t, [{ id: "webtoon", config: config() }]);
  [...d.querySelectorAll("#preset-list button")].find(button => button.textContent === "불러오기").click(); await tick();
  d.getElementById("preset-source-completed").value = "/finished";
  d.getElementById("preset-source-completed").dispatchEvent(new w.Event("change"));
  assert.equal(d.getElementById("preset-apply").disabled, true);
  assert.equal(d.getElementById("preset-check-listing").disabled, true);
  d.getElementById("preset-apply").click();
  assert.ok(!calls.some(call => call.method === "PUT" && call.path.endsWith("/binding")));
});

test("a late validation reply after logout restores neither validation data nor the selected content type", async t => {
  const { w, d } = await fixture(t, [{ id: "webtoon", config: config() }]);
  [...d.querySelectorAll("#preset-list button")].find(button => button.textContent === "불러오기").click(); await tick();
  const api = w.CollectorUI.api; let finish;
  w.CollectorUI.api = (path, options) => path.endsWith("/validate") ? new Promise(resolve => { finish = resolve; }) : api(path, options);
  d.getElementById("preset-check-listing-url").value = "https://sbxh9.com/ing";
  d.getElementById("preset-check-listing").click(); await tick();
  w.CollectorUI.authenticated = () => false; w.CollectorUI.generation = () => 2;
  d.dispatchEvent(new w.CustomEvent("collector:auth"));
  finish({ valid: true, pageKind: "listing", presetHash: "fixture-hash", matches: { title: 7 } }); await tick();
  assert.equal(d.getElementById("preset-activation").hidden, true);
  assert.equal(d.getElementById("preset-check-listing-status").textContent, "");
  assert.equal(d.getElementById("preset-content-type").value, "novel");
  assert.ok(!d.getElementById("preset-guide-description").textContent.includes("웹툰"));
});

test("binding status requires matching preset id, origin and content type", async t => {
  const { d } = await fixture(t, [{ id: "webtoon", config: config() }], [{ presetId: "webtoon", origin: "https://old.example", contentType: "novel", validated: true }]);
  [...d.querySelectorAll("#preset-list button")].find(button => button.textContent === "불러오기").click(); await tick();
  assert.ok(!d.getElementById("preset-binding-status").textContent.includes("적용 중"));
  assert.equal(d.getElementById("preset-unbind").hidden, true);
});

test("malformed validation or binding replies cannot claim successful confirmation or application", async t => {
  const { w, d } = await fixture(t, [{ id: "webtoon", config: config() }]);
  [...d.querySelectorAll("#preset-list button")].find(button => button.textContent === "불러오기").click(); await tick();
  const api = w.CollectorUI.api;
  w.CollectorUI.api = (path, options) => path.endsWith("/binding") ? Promise.resolve({ version: 1, bindings: [{ presetId: "webtoon", origin: "https://foreign.example", contentType: "webtoon", validated: true }] }) : path.endsWith("/validate") ? Promise.resolve({ valid: false, pageKind: "listing" }) : api(path, options);
  d.getElementById("preset-apply").click(); await tick();
  assert.match(d.getElementById("preset-error").textContent, /적용 결과/);
  assert.ok(!d.getElementById("preset-binding-status").textContent.includes("적용 중"));
  d.getElementById("preset-check-listing-url").value = "https://sbxh9.com/ing";
  d.getElementById("preset-check-listing").click(); await tick();
  assert.match(d.getElementById("preset-error").textContent, /원본 확인 결과/);
  assert.ok(!d.getElementById("preset-check-listing-status").textContent.includes("확인 완료"));
});

test("v3 JSON file import selects its type without issuing a save or apply request", async t => {
  const { w, d, calls } = await fixture(t);
  Object.defineProperty(d.getElementById("preset-file"), "files", { value: [{ size: 1000, text: async () => JSON.stringify(config()) }] });
  d.getElementById("preset-file").dispatchEvent(new w.Event("change")); await tick();
  assert.equal(d.getElementById("preset-content-type").value, "webtoon");
  assert.deepEqual(JSON.parse(d.getElementById("preset-json").value), config());
  assert.ok(!calls.some(call => ["POST", "PUT", "DELETE"].includes(call.method)));
});

test("deleting an unbound preset preserves the other saved preset and resets only the current draft", async t => {
  const another = { ...config(), name: "Another preset" };
  const { d, calls } = await fixture(t, [{ id: "webtoon", config: config() }, { id: "another", config: another }]);
  d.querySelector("#preset-list article button").click(); await tick();
  [...d.querySelectorAll("#preset-list article button")].find(button => button.textContent === "삭제").click(); await tick();
  assert.equal(d.querySelectorAll("#preset-list article").length, 1);
  assert.match(d.getElementById("preset-list").textContent, /Another preset/);
  assert.equal(d.getElementById("preset-activation").hidden, true);
  assert.equal(calls.filter(call => call.method === "DELETE").length, 1);
});
