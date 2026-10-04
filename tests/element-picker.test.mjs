import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { validatePreset } from "../src/extraction-presets.mjs";

async function fixture(t){
  const bundled=fileURLToPath(new URL(process.platform==="win32"?"../browser/chrome-win64/chrome.exe":"../browser/chrome-linux64/chrome",import.meta.url));
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_PATH||(existsSync(bundled)?bundled:undefined)});
  t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1280,height:900}});
  const requests=[];
  await page.route("**/*",route=>{requests.push(route.request().url());return route.fulfill({contentType:"text/html",body:`<!doctype html><style>body{margin:20px}.card{display:block;box-sizing:border-box;width:280px;height:110px;margin-bottom:20px;padding:12px;border:1px solid}.title,.author{display:block;height:22px;width:170px}.reader-host{display:block;width:500px;height:120px;margin-top:50px}</style>
    <a class="card" href="/novel/1?token=NEVER_EXPORT_TOKEN"><span class="title">PREVIEW_ONLY_TITLE_ONE</span><span class="author">PREVIEW_ONLY_AUTHOR_ONE</span></a><a class="card" href="/novel/2"><span class="title">PREVIEW_ONLY_TITLE_TWO</span><span class="author">PREVIEW_ONLY_AUTHOR_TWO</span></a>
    <input type="password" value="NEVER_EXPORT_PASSWORD"><script>window.originalClicks=0;document.querySelectorAll('.card').forEach(a=>a.addEventListener('click',e=>{window.originalClicks++;e.preventDefault();}));window.secretCanary='NEVER_EXPORT_SCRIPT';</script><div class="reader-host"></div>`});});
  await page.goto("https://example.test/novel/1");
  await page.addScriptTag({content:await readFile(new URL("../public/element-picker.js",import.meta.url),"utf8")});
  return{page,requests};
}
async function start(page,kind="listing"){
  const url=await page.evaluate(kind=>window.CollectorElementPicker.bookmarklet({kind}),kind);
  assert.ok(url.startsWith("javascript:"));
  // Exercise Chromium's actual javascript: URL, as used by a bookmark.
  // javascript: runs in the current document; it is not a network navigation.
  await page.evaluate(url=>{window.location.href=url;},url);
  await page.locator("#nc-element-picker").waitFor();return page.locator("#nc-element-picker");
}

test("bookmarklet highlights locally, assigns repeated relative fields and exports selectors without source values",async t=>{
  const {page,requests}=await fixture(t);const tool=await start(page);
  await page.locator(".card").first().hover({position:{x:250,y:90}});
  await page.waitForFunction(()=>document.getElementById("nc-element-picker").shadowRoot.getElementById("hover").textContent.includes("a"));
  await page.locator(".card").first().click({position:{x:250,y:90}});
  await tool.locator("#field").selectOption("title");await page.locator(".title").first().click();
  await tool.locator("#field").selectOption("url");await page.locator(".card").first().click({position:{x:250,y:90}});
  const data=await page.evaluate(()=>({preset:window.__NC_ELEMENT_PICKER__.exportPreset(),preview:window.__NC_ELEMENT_PICKER__.previewPreset(),originalClicks:window.originalClicks}));
  assert.equal(data.originalClicks,0);assert.equal(data.preset.fields.items.multiple,true);
  assert.equal(data.preset.fields.title.relativeTo,"items");assert.equal(data.preset.fields.url.selector,":scope");
  assert.deepEqual(data.preview.title,["PREVIEW_ONLY_TITLE_ONE","PREVIEW_ONLY_TITLE_TWO"]);
  assert.equal(data.preview.url[0],"https://example.test/novel/1");
  const raw=JSON.stringify(data.preset);assert.ok(!/PREVIEW_ONLY|NEVER_EXPORT/.test(raw));
  assert.equal(validatePreset(data.preset).kind,"listing");assert.equal(requests.length,1,"picker starts no image stream or server request");
  await page.keyboard.press("Escape");assert.equal(await page.locator("#nc-element-picker").count(),0);
});

test("closed renderer shadow roots can be inspected through their DOM reference without exporting body text",async t=>{
  const {page}=await fixture(t);
  await page.evaluate(()=>{const host=document.querySelector('.reader-host');host.__novelShadow=host.attachShadow({mode:'closed'});host.__novelShadow.innerHTML='<div style="padding:12px"><p class="paragraph">PREVIEW_ONLY_SHADOW_BODY</p></div>';});
  await start(page,"reader");await page.locator(".reader-host").click({position:{x:30,y:30}});
  const data=await page.evaluate(()=>({preset:window.__NC_ELEMENT_PICKER__.exportPreset(),preview:window.__NC_ELEMENT_PICKER__.previewPreset()}));
  assert.ok(data.preview.root[0].includes("PREVIEW_ONLY_SHADOW_BODY"));
  assert.ok(!JSON.stringify(data.preset).includes("PREVIEW_ONLY_SHADOW_BODY"));
  assert.equal(validatePreset(data.preset).kind,"reader");
});

test("browse mode permits original actions and re-running the bookmarklet replaces the old tool",async t=>{
  const {page}=await fixture(t);let tool=await start(page,"detail");
  await tool.locator("#mode").click();await page.locator(".title").first().click();
  assert.equal(await page.evaluate(()=>window.originalClicks),1);
  tool=await start(page,"detail");assert.equal(await page.locator("#nc-element-picker").count(),1);
  await tool.locator("#close").click();
  assert.equal(await page.evaluate(()=>window.__NC_ELEMENT_PICKER__===undefined),true);
});

test("picker header can move the panel without selecting page fields",async t=>{
  const {page}=await fixture(t);const tool=await start(page,"detail");
  const before=await tool.boundingBox();const header=await tool.locator("h2").boundingBox();
  await page.mouse.move(header.x+30,header.y+10);await page.mouse.down();
  await page.mouse.move(header.x-170,header.y+100,{steps:5});await page.mouse.up();
  const after=await tool.boundingBox();assert.ok(after.x<before.x-150);assert.ok(after.y>before.y+60);
  assert.equal(await tool.locator("#fields li").count(),0);
  await tool.locator("#close").click();assert.equal(await tool.count(),0);
});

test("clipboard denial falls back to selector JSON and stored presets can reopen for local preview",async t=>{
  const {page}=await fixture(t);let tool=await start(page,"detail");
  await page.locator(".title").first().click();
  await page.evaluate(()=>Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async()=>{throw Error("denied");}}}));
  await tool.locator("#copy").click();await tool.locator("#export").waitFor({state:"visible"});
  const raw=await tool.locator("#export").inputValue();const preset=JSON.parse(raw);
  assert.ok(!/PREVIEW_ONLY|NEVER_EXPORT/.test(raw));validatePreset(preset);
  await tool.locator("#close").click();
  await page.evaluate(preset=>window.CollectorElementPicker.start({preset}),preset);
  tool=page.locator("#nc-element-picker");assert.match(await tool.locator("#fields").textContent(),/제목/);
  await tool.locator("#preview").click();assert.match(await tool.locator("#result").textContent(),/PREVIEW_ONLY_TITLE_ONE/);
});
