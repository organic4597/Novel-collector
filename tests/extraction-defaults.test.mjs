import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import {
  ExtractionPresets,
  validatePreset,
} from "../src/extraction-presets.mjs";
import { FolderStore } from "../src/store.mjs";
import { createApp } from "../src/server.mjs";
const fixtureCredential = "fixture-password";

const legacy = () => ({
  version: 1,
  name: "기존 사용자 소개",
  origin: "https://custom.example",
  pagePattern: "/works/{workId}",
  kind: "detail",
  fields: {
    title: { selector: "h2.user-title", attribute: "text", multiple: false },
  },
});
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "preset-defaults-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(root).init();
  const presets = await new ExtractionPresets({ store, ...options }).load();
  return { store, presets };
}

test("built-in summaries have stable identities and do not populate or replace saved presets", async (t) => {
  const { store, presets } = await fixture(t);
  const defaults = presets.defaults();
  assert.deepEqual(
    defaults.map((preset) => preset.id),
    ["sbxh9-novel-v1", "toki32-novel-v1", "sbxh9-webtoon-v3", "toki32-webtoon-v3"],
  );
  assert.deepEqual(
    defaults.map((preset) => preset.origin),
    ["https://sbxh9.com", "https://toki32.com", "https://sbxh9.com", "https://toki32.com"],
  );
  assert.equal(
    defaults.every(
      (preset) =>
        preset.pages.length === 3 &&
        preset.fieldCount > 0 &&
        preset.description,
    ),
    true,
  );
  defaults[0].name = "changed";
  defaults[0].pages[0].kind = "changed";
  assert.notEqual(presets.defaults()[0].name, "changed");
  assert.equal(presets.defaults()[0].pages[0].kind, "listing");
  assert.deepEqual(presets.list(), []);
  assert.equal(await store.json(presets.path), null);
});

test("adding a default creates independent editable copies and preserves legacy source settings across restart", async (t) => {
  const { store, presets } = await fixture(t);
  const previous = await presets.save(legacy());
  const before = presets.get(previous.id);
  const [first, second] = await Promise.all([
    presets.addDefault("sbxh9-novel-v1"),
    presets.addDefault("sbxh9-novel-v1"),
  ]);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.config.name, second.config.name);
  assert.match(second.config.name, /복사본 2/);
  assert.equal(first.config.version, 2);
  assert.deepEqual(Object.keys(first.config.pages), [
    "listing",
    "detail",
    "reader",
  ]);
  assert.deepEqual(validatePreset(first.config), first.config);
  first.config.pages.detail.fields.title.selector = "h1.edited-copy";
  await presets.save(first.config, first.id);
  assert.notEqual(
    presets.get(second.id).config.pages.detail.fields.title.selector,
    "h1.edited-copy",
  );
  const reopened = await new ExtractionPresets({ store }).load();
  assert.deepEqual(reopened.get(previous.id), before);
  assert.equal(
    reopened.get(first.id).config.pages.detail.fields.title.selector,
    "h1.edited-copy",
  );
  assert.notEqual(
    (await reopened.addDefault("sbxh9-novel-v1")).config.pages.detail.fields
      .title.selector,
    "h1.edited-copy",
  );
});

test("default fields address the current public rendered DOM without embedding previews or authentication state", async (t) => {
  const { presets } = await fixture(t);
  for (const id of ["sbxh9-novel-v1", "toki32-novel-v1"]) {
    const { config } = await presets.addDefault(id);
    const dom = new JSDOM(
      '<ul class="novel-list"><li><a class="novel-card" href="/novel/21104"><span class="nv-title">작품</span><span class="nv-author">작가</span><div class="nv-thumb"><img src="/cover.jpg"></div></a></li></ul><section class="novel-detail"><div class="nd-info"><h1>작품</h1><div class="nd-meta"><a href="/search?q=작가&field=author">작가</a> · 376화</div><div class="nd-desc">소개</div><div class="nd-thumb"><img src="/cover.jpg"></div></div></section><ul class="novel-eps"><li class="novel-ep-row"><a class="novel-ep-link" href="/novel/21104/3001372"><span class="ne-num">1화</span><span class="ne-title">첫 회차</span></a></li></ul><div id="novel_content"><p>PREVIEW_BODY_ONLY</p></div>',
      { url: config.origin + "/novel/21104" },
    );
    t.after(() => dom.window.close());
    const doc = dom.window.document;
    for (const page of Object.values(config.pages))
      for (const locator of Object.values(page.fields)) {
        assert.doesNotThrow(() => doc.querySelectorAll(locator.selector));
        assert.deepEqual(locator.shadowPath, []);
        assert.equal(
          ["text", "href", "src", "data-src"].includes(locator.attribute),
          true,
        );
      }
    const card = doc.querySelector(config.pages.listing.fields.items.selector);
    assert.equal(
      card.querySelector(config.pages.listing.fields.title.selector)
        .textContent,
      "작품",
    );
    assert.equal(
      doc.querySelector(config.pages.detail.fields.title.selector).textContent,
      "작품",
    );
    const row = doc.querySelector(config.pages.detail.fields.rows.selector);
    assert.equal(
      row.querySelector(config.pages.detail.fields.chapterTitle.selector)
        .textContent,
      "첫 회차",
    );
    assert.equal(
      doc.querySelector(config.pages.reader.fields.text.selector).textContent,
      "PREVIEW_BODY_ONLY",
    );
    assert.equal(JSON.stringify(config).includes("PREVIEW_BODY_ONLY"), false);
    assert.equal(Object.hasOwn(config, "cookies"), false);
    assert.equal(Object.hasOwn(config, "script"), false);
  }
});

test("unknown defaults, storage failures and preset limits never replace existing configurations", async (t) => {
  const { presets } = await fixture(t, { maxPresets: 1 });
  const previous = await presets.save(legacy());
  await assert.rejects(presets.addDefault("sbxh9-novel-v1"), { status: 409 });
  await assert.rejects(presets.addDefault("unknown"), { status: 404 });
  assert.deepEqual(presets.get(previous.id).config, validatePreset(legacy()));
  const failed = await fixture(t);
  failed.store.atomic = async () => {
    throw Error("fixture disk error");
  };
  await assert.rejects(failed.presets.addDefault("sbxh9-novel-v1"));
  assert.equal(failed.presets.list().length, 0);
  assert.equal(
    new ExtractionPresets({ store: failed.store, maxPresets: 200 }).maxPresets,
    100,
  );
  assert.throws(
    () => new ExtractionPresets({ store: failed.store, maxPresets: NaN }),
    { status: 400 },
  );
});

test("defaults API requires auth, creates a copy only after an explicit same-origin request and rejects extra input", async (t) => {
  const { presets } = await fixture(t);
  const app = createApp({
    store: {},
    scheduler: {},
    adminPassword: fixtureCredential,
    extractionPresets: presets,
  });
  await new Promise((done) => app.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => app.close(done)));
  const origin = `http://127.0.0.1:${app.address().port}`;
  const path = origin + "/api/extraction-presets/defaults";
  assert.equal((await fetch(path)).status, 401);
  const login = await fetch(origin + "/api/login", {
    method: "POST",
    body: JSON.stringify({ password: fixtureCredential }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const list = await fetch(path, { headers: { cookie } });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).length, 4);
  assert.equal(presets.list().length, 0);
  const post = (body, source = origin) =>
    fetch(path, {
      method: "POST",
      headers: { cookie, origin: source, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post({ defaultId: "sbxh9-novel-v1" }, "https://foreign.example"))
      .status,
    403,
  );
  for (const body of [
    {},
    { defaultId: "sbxh9-novel-v1", origin: "https://other.example" },
    { defaultId: "sbxh9-novel-v1", cookies: "fake" },
    { defaultId: ["sbxh9-novel-v1"] },
  ])
    assert.equal((await post(body)).status, 400);
  assert.equal((await post({ defaultId: "missing" })).status, 404);
  assert.equal(presets.list().length, 0);
  const saved = await post({ defaultId: "sbxh9-novel-v1" });
  assert.equal(saved.status, 201);
  const record = await saved.json();
  assert.equal(record.config.origin, "https://sbxh9.com");
  assert.equal(presets.list().length, 1);
  const updated = await fetch(origin + "/api/extraction-presets/" + record.id, {
    method: "PUT",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ ...record.config, name: "사용자 수정본" }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).config.name, "사용자 수정본");
  assert.equal(
    (await fetch(path, { method: "DELETE", headers: { cookie, origin } }))
      .status,
    405,
  );
  assert.equal(presets.list().length, 1);
  assert.equal(
    (
      await fetch(origin + "/api/extraction-presets/" + record.id, {
        method: "DELETE",
        headers: { cookie, origin },
      })
    ).status,
    200,
  );
  assert.equal(presets.list().length, 0);
  assert.equal(presets.defaults().length, 4);
  assert.equal(
    (
      await fetch(path + "?origin=https://other.example", {
        headers: { cookie },
      })
    ).status,
    400,
  );
});
