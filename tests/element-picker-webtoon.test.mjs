import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

async function fixture(t, path = "/webtoon/mixed-Work_42/episode_A-7") {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const requests = [];
  await page.route("**/*", route => {
    requests.push(route.request().url());
    return route.request().resourceType() === "document"
      ? route.fulfill({ contentType: "text/html", body: `<!doctype html><style>body{margin:20px}.pages{width:400px;padding:10px}img{display:block;width:320px;height:30px;margin:3px}.title,.next,.more{display:block;width:300px;height:30px}.card,.chapter{display:block;width:400px;padding:10px}.shadow-host{display:block;width:420px;height:200px}</style>
        <h1 class="title">PREVIEW_ONLY_WEBTOON_TITLE</h1><img class="episode-image ad" src="/advertisement.css"><div class="pages">${Array.from({ length: 20 }, (_, i) => `<img class="episode-image" src="/source-${i}.css?token=NEVER_EXPORT_TOKEN" data-src="/lazy-${i}.woff?cookie=NEVER_EXPORT_COOKIE">`).join("")}</div>
        <a class="card" href="/webtoon/work"><span class="work-title">PREVIEW_ONLY_CARD</span></a><div class="chapter"><span class="season">Season 2</span><a class="chapter-link" href="/webtoon/work/ep">Episode 1</a></div><button class="next">Next</button><button class="more">More</button><div class="shadow-host"></div>` })
      : route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="30"/>' });
  });
  await page.goto("https://example.test" + path);
  await page.evaluate(() => { document.cookie = "private=NEVER_EXPORT_COOKIE"; });
  await page.addScriptTag({ content: await readFile(new URL("../public/element-picker.js", import.meta.url), "utf8") });
  return { page, requests };
}
async function start(page, options = {}) {
  const bookmarklet = await page.evaluate(options => window.CollectorElementPicker.bookmarklet(options), options);
  await page.evaluate(url => { window.location.href = url; }, bookmarklet);
  const tool = page.locator("#nc-element-picker"); await tool.waitFor(); return tool;
}
async function assign(page, tool, field, selector, position) {
  await tool.locator("#field").selectOption(field);
  await page.locator(selector).first().click(position ? { position } : {});
  if(await tool.locator("#assign").isEnabled())await tool.locator("#assign").click();
}
const locator = (selector, attribute = "text", multiple = false, relativeTo) => ({ selector, shadowPath: [], attribute, multiple, ...(relativeTo ? { relativeTo } : {}) });
const legacyNovel = { version: 2, name: "Novel original", origin: "https://example.test", pages: { detail: { pagePattern: "/novel/{workId}", fields: { title: locator(".title") } } } };
const v3 = (pages = {}, contentType = "webtoon") => ({ version: 3, contentType, name: "V3 preset", origin: "https://example.test", catalogOrder: "oldest-first", pages });

test("webtoon v3 exports root-relative image selectors and previews five of twenty images in DOM order without ads or source values", async t => {
  const { page, requests } = await fixture(t), tool = await start(page);
  assert.equal(await tool.locator("#kind").inputValue(), "reader");
  assert.equal(await tool.locator("#field").inputValue(), "images");
  assert.equal(await tool.locator("#attribute").inputValue(), "imageUrl");
  assert.equal(await tool.locator("#multiple").isChecked(), true);
  const empty = await page.evaluate(() => window.__NC_ELEMENT_PICKER__.exportPreset());
  assert.equal(empty.version, 3); assert.equal(empty.catalogOrder, "newest-first");
  assert.deepEqual(empty.pages.listing.sources, { ongoing: "/ing", completed: "/end" });
  await assign(page, tool, "root", ".pages", { x: 390, y: 10 });
  await page.evaluate(() => { document.querySelector(".pages img").id="unique-image"; });
  await assign(page, tool, "images", ".pages img");
  const data = await page.evaluate(() => ({ preset: window.__NC_ELEMENT_PICKER__.exportPreset(), preview: window.__NC_ELEMENT_PICKER__.previewPreset(), pinned: document.querySelectorAll('[data-nc-pinned=true]').length }));
  assert.equal(data.preset.contentType, "webtoon");
  assert.deepEqual(data.preset.pages.reader.fields.images, locator("img", "imageUrl", true, "root"));
  assert.equal(data.pinned, 20);
  assert.deepEqual(data.preview.images, Array.from({ length: 5 }, (_, i) => `https://example.test/source-${i}.css`));
  assert.ok(!/source-|lazy-|advertisement|PREVIEW_ONLY|NEVER_EXPORT/.test(JSON.stringify(data.preset)));
  const before = requests.length;
  await page.evaluate(()=>document.querySelectorAll(".pages img").forEach(img=>Object.defineProperty(img,"currentSrc",{configurable:true,value:""})));
  assert.deepEqual(await page.evaluate(() => window.__NC_ELEMENT_PICKER__.previewPreset().images), Array.from({ length: 5 }, (_, i) => `https://example.test/lazy-${i}.woff`));
  await page.evaluate(()=>document.querySelectorAll(".pages img").forEach(img=>img.removeAttribute("data-src")));
  assert.deepEqual(await page.evaluate(() => window.__NC_ELEMENT_PICKER__.previewPreset().images), Array.from({ length: 5 }, (_, i) => `https://example.test/source-${i}.css`));
  assert.equal(requests.length, before);
  await page.evaluate(()=>document.querySelectorAll(".pages img").forEach((img,i)=>{img.removeAttribute("class");img.removeAttribute("id");img.setAttribute("aria-label","Page "+i);}));
  await assign(page,tool,"images",".pages img");
  assert.equal(await page.evaluate(()=>window.__NC_ELEMENT_PICKER__.exportPreset().pages.reader.fields.images.selector),"img");
  assert.deepEqual(await page.evaluate(()=>window.__NC_ELEMENT_PICKER__.previewPreset().images),Array.from({length:5},(_,i)=>`https://example.test/source-${i}.css`));
});

test("v3 image assignment rejects missing root, containers, outside images and unsupported attributes or multiplicity", async t => {
  const { page } = await fixture(t), tool = await start(page);
  await assign(page, tool, "images", ".pages img");
  assert.equal(await tool.locator("#fields li").count(), 0);
  assert.match(await tool.locator("#error").textContent(), /루트|root/);
  await assign(page, tool, "root", ".pages", { x: 390, y: 10 });
  await assign(page, tool, "images", ".pages", { x: 390, y: 10 });
  assert.equal(await tool.locator("#fields li").count(), 1);
  await assign(page, tool, "images", ".ad");
  assert.equal(await tool.locator("#fields li").count(), 1);
  for(const attribute of ["text","href","src","data-src"]){
    await tool.locator("#attribute").selectOption(attribute);
    await page.locator(".pages img").first().click(); await tool.locator("#assign").click();
    assert.equal(await tool.locator("#fields li").count(), 1,attribute+" must not be saved as reader images");
  }
  await tool.locator("#attribute").selectOption("imageUrl"); await tool.locator("#multiple").uncheck();
  await tool.locator("#assign").click(); assert.equal(await tool.locator("#fields li").count(), 1);
  await tool.locator("#multiple").check(); await tool.locator("#assign").click();
  assert.equal(await tool.locator("#fields li").count(), 2);
});

test("export validates imported image locators and the single reader container", async t => {
  const { page } = await fixture(t);
  for (const [root, images] of [
    [locator(".pages"), locator(":scope", "imageUrl", true, "root")],
    [locator(".pages"), locator("img", "href", true, "root")],
    [locator(".pages"), locator("img", "imageUrl", false, "root")],
    [locator(".pages"), locator("img", "imageUrl", true)],
    [locator(".pages"), locator("img", "src", true, "root")],
    [locator(".pages"), locator("img", "data-src", true, "root")],
    [locator(".pages", "text", true), locator("img", "imageUrl", true, "root")],
    [locator("img"), locator("img", "imageUrl", true, "root")],
    [locator(".missing-root"), locator("img", "imageUrl", true, "root")],
    [locator(".pages"), locator(".missing-image", "imageUrl", true, "root")],
  ]) {
    await page.evaluate(() => { window.__NC_ELEMENT_PICKER__?.close(); localStorage.clear(); });
    await start(page, { preset: v3({ reader: { pagePatterns: ["/webtoon/{workId}/{episodeId}"], fields: { root, images } } }) });
    await assert.rejects(page.evaluate(() => window.__NC_ELEMENT_PICKER__.exportPreset()), /img|이미지|src|반복|여러|루트|root|컨테이너/);
  }
});

test("v3 round trip preserves sources, catalog order, pattern arrays and actions separately from fields", async t => {
  const { page } = await fixture(t, "/end");
  const preset = v3({ listing: { pagePatterns: ["/ing", "/end", "/search"], sources: { ongoing: "/ing", completed: "/end", search: "/search" }, fields: {}, actions: { nextPage: locator(".next") } } });
  const tool = await start(page, { preset });
  assert.equal(await tool.locator("#pattern").inputValue(), "/ing\n/end\n/search");
  assert.equal(await tool.locator("#catalog-order").inputValue(), "oldest-first");
  await tool.locator("#pattern").fill("/ing\n/end\n/search\n/category/{workId}");
  await assign(page, tool, "items", ".card", { x: 390, y: 10 });
  await assign(page, tool, "title", ".work-title");
  await assign(page, tool, "episodeCount", ".work-title");
  await assign(page, tool, "actions.nextPage", ".next");
  await assign(page, tool, "actions.loadMore", ".more");
  const output = await page.evaluate(() => window.__NC_ELEMENT_PICKER__.exportPreset());
  assert.deepEqual(output.pages.listing.sources, preset.pages.listing.sources);
  assert.deepEqual(output.pages.listing.pagePatterns, ["/ing", "/end", "/search", "/category/{workId}"]);
  assert.equal(output.catalogOrder, "oldest-first");
  assert.equal(output.pages.listing.fields.title.relativeTo, "items");
  assert.equal(output.pages.listing.fields.episodeCount.relativeTo, "items");
  assert.ok(output.pages.listing.actions.nextPage); assert.ok(!output.pages.listing.fields["actions.nextPage"]);
  assert.ok(output.pages.listing.actions.loadMore);
  await page.evaluate(() => { window.__NC_ELEMENT_PICKER__.close(); history.replaceState({}, "", "/webtoon/work"); });
  const detail = await start(page, { preset: output });
  await assign(page, detail, "episodeCount", ".title");
  await assign(page, detail, "rows", ".chapter", { x: 390, y: 10 });
  await assign(page, detail, "seasonLabel", ".season");
  await assign(page, detail, "chapterUrl", ".chapter-link");
  await assign(page, detail, "actions.loadMore", ".more");
  await assign(page, detail, "actions.nextPage", ".next");
  const result = await page.evaluate(() => window.__NC_ELEMENT_PICKER__.exportPreset());
  assert.equal(result.pages.detail.fields.seasonLabel.relativeTo, "rows");
  assert.equal(result.pages.detail.fields.chapterUrl.relativeTo, "rows"); assert.ok(result.pages.detail.actions.loadMore);
  assert.ok(result.pages.detail.fields.episodeCount);assert.ok(result.pages.detail.actions.nextPage);
});

test("v3 root-relative images inside a closed renderer shadow root keep a usable shadow locator", async t => {
  const { page } = await fixture(t);
  await page.evaluate(() => {
    const host = document.querySelector(".shadow-host"); host.__novelShadow = host.attachShadow({ mode: "closed" });
    host.__novelShadow.innerHTML = '<div class="shadow-pages" style="width:400px;height:180px;padding:10px"><img class="page" style="width:300px;height:60px" data-src="/shadow.woff?token=NEVER_EXPORT_TOKEN"></div>';
  });
  const tool = await start(page);
  await tool.locator("#field").selectOption("root"); await page.locator(".shadow-host").click({ position: { x: 390, y: 10 } }); await tool.locator("#assign").click();
  await tool.locator("#field").selectOption("images"); await page.locator(".shadow-host").click({ position: { x: 30, y: 30 } }); await tool.locator("#assign").click();
  const data = await page.evaluate(() => ({ preset: window.__NC_ELEMENT_PICKER__.exportPreset(), preview: window.__NC_ELEMENT_PICKER__.previewPreset() }));
  assert.equal(data.preset.pages.reader.fields.root.shadowPath.length, 1);
  assert.equal(data.preset.pages.reader.fields.images.relativeTo, "root");
  assert.deepEqual(data.preview.images, ["https://example.test/shadow.woff"]);
  await page.evaluate(()=>{window.__NC_ELEMENT_PICKER__.close();localStorage.clear();});
  const hostRoot=v3({reader:{pagePatterns:["/webtoon/{workId}/{episodeId}"],fields:{root:locator(".shadow-host")}}});
  const nested=await start(page,{preset:hostRoot});
  await nested.locator("#field").selectOption("images");await page.locator(".shadow-host").click({position:{x:30,y:30}});await nested.locator("#assign").click();
  const nestedData=await page.evaluate(()=>({preset:window.__NC_ELEMENT_PICKER__.exportPreset(),preview:window.__NC_ELEMENT_PICKER__.previewPreset()}));
  assert.deepEqual(nestedData.preset.pages.reader.fields.images.shadowPath,[":scope"]);
  assert.deepEqual(nestedData.preview.images,["https://example.test/shadow.woff"]);
});

test("v3 actions reject script locators and script payloads", async t => {
  const { page } = await fixture(t,"/ing");
  for(const action of [locator("script"), {...locator(".next"),script:"fetch('/private')"}]){
    await page.evaluate(()=>{window.__NC_ELEMENT_PICKER__?.close();localStorage.clear();});
    await page.evaluate(()=>{if(!document.querySelector("script")){const script=document.createElement("script");script.type="application/json";document.body.append(script);}});
    await start(page,{preset:v3({listing:{pagePatterns:["/ing"],fields:{},actions:{nextPage:action}}})});
    await assert.rejects(page.evaluate(()=>window.__NC_ELEMENT_PICKER__.exportPreset()),/스크립트/);
  }
});

test("known webtoon paths detect mixed slugs while novel v1/v2 retain legacy output shape", async t => {
  const { page } = await fixture(t);
  for (const [path, kind, pattern] of [["/ing", "listing", "/ing"], ["/end", "listing", "/end"], ["/webtoon/Work-Ab_42", "detail", "/webtoon/{workId}"], ["/webtoon/Work-Ab_42/episode_X-7", "reader", "/webtoon/{workId}/{episodeId}"], ["/novel/42", "detail", "/novel/{workId}"], ["/novel/42/7", "reader", "/novel/{workId}/{episodeId}"]]) {
    await page.evaluate(path => { window.__NC_ELEMENT_PICKER__?.close(); localStorage.clear(); history.replaceState({}, "", path); }, path);
    const tool = await start(page); assert.equal(await tool.locator("#kind").inputValue(), kind);
    assert.equal((await tool.locator("#pattern").inputValue()).split("\n")[0], pattern);
  }
  for (const preset of [legacyNovel, { version: 1, name: "Legacy catalog", origin: "https://example.test", kind: "catalog", pagePattern: "/novel/{workId}", fields: { title: locator(".title") } }]) {
    await page.evaluate(() => { window.__NC_ELEMENT_PICKER__?.close(); localStorage.clear(); history.replaceState({}, "", "/novel/42"); });
    await start(page, { preset }); const output = await page.evaluate(() => window.__NC_ELEMENT_PICKER__.exportPreset());
    assert.equal(output.version, 2); assert.ok(!Object.hasOwn(output, "contentType")); assert.ok(!Object.hasOwn(output, "catalogOrder"));
    assert.equal(output.pages.detail.pagePattern, "/novel/{workId}"); assert.ok(!Object.hasOwn(output.pages.detail, "pagePatterns"));
  }
});

test("type mismatch stops before overwriting and caches never mix types or versions", async t => {
  const { page } = await fixture(t); const dialogs = [];
  page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.evaluate(() => localStorage.setItem("nc-preset-v2:default", "existing-cache"));
  await page.evaluate(preset => window.CollectorElementPicker.start({ preset }), legacyNovel);
  assert.equal(await page.locator("#nc-element-picker").count(), 0);
  assert.match(dialogs[0], /소설|novel/); assert.match(dialogs[0], /웹툰|webtoon/);
  assert.equal(await page.evaluate(() => localStorage.getItem("nc-preset-v2:default")), "existing-cache");
  await page.evaluate(preset => localStorage.setItem("nc-preset-v2:default", JSON.stringify({ savedAt: Date.now(), config: preset })), legacyNovel);
  let tool = await start(page); assert.equal(await tool.locator("#fields li").count(), 0);
  assert.notEqual(await tool.locator("#name").inputValue(), legacyNovel.name);
  await assign(page, tool, "root", ".pages", { x: 390, y: 10 });
  await page.evaluate(() => { window.__NC_ELEMENT_PICKER__.close(); history.replaceState({}, "", "/novel/42"); });
  tool = await start(page, { preset: legacyNovel });
  assert.equal(await tool.locator("#name").inputValue(), legacyNovel.name); assert.equal(await tool.locator("#fields li").count(), 1);
  await page.evaluate(preset => { window.__NC_ELEMENT_PICKER__.close(); localStorage.setItem("nc-preset-v2:default", JSON.stringify({ savedAt: Date.now(), config: preset })); }, legacyNovel);
  await start(page, { preset: v3({}, "novel") });
  const upgraded = await page.evaluate(() => window.__NC_ELEMENT_PICKER__.exportPreset());
  assert.equal(upgraded.version, 3); assert.deepEqual(upgraded.pages.detail.fields, {});
});

test("one loaded image class cannot narrow the root image selector to a single page", async t => {
  const { page } = await fixture(t), tool = await start(page);
  await assign(page, tool, "root", ".pages", { x: 390, y: 10 });
  await page.evaluate(() => document.querySelector(".pages img").classList.add("loaded"));
  await assign(page, tool, "images", ".pages img");
  assert.equal(await page.locator("[data-nc-pinned=true]").count(), 20);
});

test("custom v3 page paths use the requested kind while known routes retain automatic detection", async t => {
  const {page}=await fixture(t,"/comic/work/chapter");
  const preset=v3({reader:{pagePatterns:["/comic/{workId}/{episodeId}"],fields:{}}});
  const tool=await start(page,{preset,kind:"reader"});
  assert.equal(await tool.locator("#kind").inputValue(),"reader");
  assert.equal(await tool.locator("#pattern").inputValue(),"/comic/{workId}/{episodeId}");
  await assign(page,tool,"root",".pages",{x:390,y:10});
  await assign(page,tool,"images",".pages img");
  assert.equal(await page.evaluate(()=>window.__NC_ELEMENT_PICKER__.previewPreset().images.length),5);
  await page.evaluate(()=>{window.__NC_ELEMENT_PICKER__.close();localStorage.clear();history.replaceState({},"","/webtoon/work");});
  const known=await start(page,{preset,kind:"reader"});
  assert.equal(await known.locator("#kind").inputValue(),"detail");
});
