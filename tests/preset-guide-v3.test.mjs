import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const legacyFields = {
  listing: ["items", "title", "author", "genres", "tags", "platform", "episodeCount", "publication", "thumbnail", "url", "updatedLabel", "nextPageButton"],
  detail: ["title", "author", "genres", "tags", "platform", "episodeCount", "publication", "synopsis", "thumbnail", "rows", "chapterNumber", "chapterTitle", "chapterUrl", "notReady", "expectedChapters", "moreButton"],
  reader: ["root", "text", "notice"],
};
const v3Fields = {
  listing: ["items", "title", "url", "authors", "genres", "tags", "platform", "thumbnail", "publication", "episodeCount", "updatedLabel", "rating", "actions.nextPage", "actions.loadMore"],
  detail: ["title", "authors", "genres", "tags", "platform", "synopsis", "thumbnail", "publication", "episodeCount", "rows", "chapterTitle", "chapterUrl", "chapterLabel", "notReady", "expectedChapters", "seasonLabel", "seasonNumber", "actions.loadMore", "actions.nextPage"],
  reader: ["root", "text", "notice"],
};
async function fixture(t, { oldAttributeOptions = false } = {}) {
  const dom = new JSDOM(await readFile(new URL("../public/index.html", import.meta.url), "utf8"), { runScripts: "outside-only", url: "http://localhost/" });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  if (!oldAttributeOptions && !d.querySelector('#preset-target-attribute option[value="imageUrl"]')) {
    const option = d.createElement("option"); option.value = "imageUrl"; option.textContent = "이미지 주소";
    d.getElementById("preset-target-attribute").append(option);
  }
  w.eval(await readFile(new URL("../public/preset-guide.js", import.meta.url), "utf8"));
  return { w, d, guide: w.CollectorPresetGuide };
}
function exerciseCards(w, d, fields) {
  for (const [kind, keys] of Object.entries(fields)) {
    d.getElementById("preset-kind").value = kind;
    d.getElementById("preset-kind").dispatchEvent(new w.Event("change"));
    assert.deepEqual([...d.querySelectorAll("#preset-target-field option")].map(option => option.value), keys);
    assert.equal(d.querySelectorAll("#preset-field-gallery svg[role=img]").length, keys.length);
    for (const card of d.getElementById("preset-field-gallery").children) {
      card.click();
      assert.equal(d.getElementById("preset-target-field").value, card.dataset.field);
      assert.equal(card.getAttribute("aria-pressed"), "true");
      assert.ok(d.getElementById("preset-field-help").textContent.length > 10);
      const svg = d.querySelector("#preset-guide-focus svg");
      assert.ok(svg.getAttribute("aria-label"));
      assert.equal(svg.querySelectorAll("title").length, 1);
      for (const rect of svg.querySelectorAll("rect")) {
        const x = Number(rect.getAttribute("x") || 0), y = Number(rect.getAttribute("y") || 0);
        assert.ok(x >= 0 && x + Number(rect.getAttribute("width")) <= 286);
        assert.ok(y >= 0 && y + Number(rect.getAttribute("height")) <= 340);
      }
      assert.equal(svg.querySelector("script, foreignObject"), null);
    }
  }
}

test("guide retains all legacy novel fields when initialized and when switching back from v3", async t => {
  const { w, d, guide } = await fixture(t);
  exerciseCards(w, d, legacyFields);
  const examples = Object.fromEntries(Object.entries(guide.definitions).map(([kind, def]) => [kind, def.example]));
  guide.setPreset({ version: 3, contentType: "webtoon" });
  for (const version of [2, 1]) {
    guide.setPreset({ version });
    exerciseCards(w, d, legacyFields);
    assert.deepEqual(Object.fromEntries(Object.entries(guide.definitions).map(([kind, def]) => [kind, def.example])), examples);
  }
});

test("v3 novel guide exposes every contract field with selectable actions, rating and seasons", async t => {
  const { w, d, guide } = await fixture(t);
  let events = 0; d.addEventListener("preset:guide", () => events++);
  guide.setPreset({ version: 3, contentType: "novel" });
  assert.equal(events, 0, "the manager owns type-change notifications");
  exerciseCards(w, d, v3Fields);
  for (const kind of ["listing", "detail"]) {
    assert.equal(guide.definitions[kind].fields.find(field => field[0] === "authors")[4], true);
    assert.match(guide.definitions[kind].label, /소설/);
    assert.equal(guide.definitions[kind].fields.find(field => field[0] === "episodeCount")[1], "회차 수");
  }
  const currentDefinitions = guide.definitions;
  assert.deepEqual(Object.keys(guide.definitionsFor({ version: 3, contentType: "webtoon" })), ["listing", "detail", "reader"]);
  assert.equal(guide.definitions, currentDefinitions, "reading another preset's definitions must not switch the current guide");
  assert.match(guide.definitions.listing.description, /\/ing.*\/end/);
  assert.match(guide.definitions.detail.fields.find(field => field[0] === "chapterLabel")[2], /원문/);
  assert.match(guide.definitions.reader.example, /\/novel\//);
  assert.ok([...d.getElementById("preset-kind").options].every(option => option.textContent === guide.definitions[option.value].label));
});

test("v3 webtoon guide illustrates three images inside the saved root and chooses imageUrl", async t => {
  const { w, d, guide } = await fixture(t);
  guide.setPreset({ version: 3, contentType: "webtoon" });
  exerciseCards(w, d, { ...v3Fields, reader: ["root", "images", "notice"] });
  assert.match(guide.definitions.detail.example, /\/webtoon\//);
  assert.match(guide.definitions.reader.example, /\/webtoon\/[^/]+\/[^/]+$/);
  assert.ok(Object.values(guide.definitions).every(def => /웹툰/.test(def.label)));
  d.querySelector('#preset-field-gallery [data-field="images"]').click();
  assert.equal(d.getElementById("preset-target-attribute").value, "imageUrl");
  assert.equal(d.getElementById("preset-target-multiple").checked, true);
  assert.match(d.getElementById("preset-field-help").textContent, /루트.*img/);
  assert.equal(d.querySelectorAll("#preset-guide-focus [data-image-panel]").length, 3);
  assert.match(guide.definitions.reader.fields.find(field => field[0] === "root")[2], /먼저/);
});

test("setPreset tolerates older markup without a content type picker or imageUrl option", async t => {
  const { d, guide } = await fixture(t, { oldAttributeOptions: true });
  d.getElementById("preset-content-type")?.remove();
  d.querySelector('#preset-target-attribute option[value="imageUrl"]')?.remove();
  assert.doesNotThrow(() => guide.setPreset({ version: 3, contentType: "webtoon" }));
  assert.equal(d.getElementById("preset-kind").options.length, 3);
});
