import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { openNormalDiscovery, readNormalListState } from "../src/normal-discovery.mjs";

async function run(t, knownTotal) {
  const dom = new JSDOM('<div class="toolbar"><span class="count">119개</span></div><ul class="novel-list"><li><a href="/novel/1">합성 작품</a></li></ul><div class="sort-tabs"><button class="active">최신순</button></div><div class="pager-window--desktop"><button class="pager-num is-active">1</button><button class="pager-num">2</button><button aria-label="끝">끝</button><button aria-label="처음">처음</button></div>', { url: "https://sbxh9.com/novel" });
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  let endClicks = 0;
  const go = page => {
    for (const button of doc.querySelectorAll(".pager-num")) button.classList.toggle("is-active", Number(button.textContent) === page);
    if (page === 3) {
      const node = doc.createElement("button"); node.className = "pager-num is-active"; node.textContent = "3";
      doc.querySelector(".pager-window--desktop").append(node);
    }
    doc.querySelector("ul a").href = "/novel/" + page;
    doc.querySelector('[aria-label="끝"]').disabled = page === 3;
  };
  doc.querySelectorAll(".pager-num")[1].onclick = () => go(2);
  doc.querySelector('[aria-label="끝"]').onclick = () => { endClicks++; go(3); };
  doc.querySelector('[aria-label="처음"]').onclick = () => go(1);
  const page = { url: () => doc.URL, evaluate: async (fn, arg) => arg ? fn(arg, doc) : fn(doc) };
  const owner = { navigate: async () => {}, transportUrl: () => doc.URL, sourceGate: { assertAvailable: () => {} } };
  const read = doc => ({ items: [{ id: String(readNormalListState(doc).page) }], normalCatalog: true,
    page: readNormalListState(doc).page, maxPage: 2, paginationUnresolved: true, total: 119 });
  const result = await openNormalDiscovery(owner, page, { page: 2, sort: "updated", publication: "all" }, read, () => ({}), { knownMaxPage: 3, knownTotal });
  return { result, endClicks };
}

test("known page bounds avoid last-page and first-page round trips", async t => {
  const { result, endClicks } = await run(t, 119);
  assert.equal(endClicks, 0); assert.equal(result.page, 2); assert.equal(result.maxPage, 3);
});

test("changed total counts refresh the bounds instead of trusting stale metadata", async t => {
  const { result, endClicks } = await run(t, 120);
  assert.equal(endClicks, 1); assert.equal(result.page, 2);
});
