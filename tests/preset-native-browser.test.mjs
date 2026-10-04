import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createApp } from "../src/server.mjs";
import { FolderStore } from "../src/store.mjs";
import { ExtractionPresets } from "../src/extraction-presets.mjs";

test("illustrated guide opens a native source window with existing browser login and a local bookmarklet, fitting mobile",async t=>{
  const bundled=fileURLToPath(new URL(process.platform==="win32"?"../browser/chrome-win64/chrome.exe":"../browser/chrome-linux64/chrome",import.meta.url));
  const browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_PATH||(existsSync(bundled)?bundled:undefined)});
  const root=await mkdtemp(join(tmpdir(),"preset-return-")),store=await new FolderStore(root).init(),presets=await new ExtractionPresets({store}).load();
  const app=createApp({store,scheduler:{},adminPassword:"fixture-password",extractionPresets:presets});await new Promise(r=>app.listen(0,"127.0.0.1",r));
  t.after(async()=>{await browser.close();await new Promise(r=>app.close(r));await rm(root,{recursive:true,force:true});});
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),base=`http://127.0.0.1:${app.address().port}`,errors=[],requests=[];
  page.on("pageerror",e=>errors.push(e.message));context.on("request",r=>requests.push(r.url()));
  await context.addCookies([{name:"fixture_login",value:"FAKE_BROWSER_SESSION",domain:"example.test",path:"/",secure:true}]);
  await context.route("https://example.test/**",route=>route.fulfill({contentType:"text/html",body:'<!doctype html><h1>합성 작품</h1><p id="synopsis">PREVIEW_ONLY_SYNOPSIS</p>'}));
  assert.equal((await page.request.post(base+"/api/login",{data:{password:"fixture-password"}})).status(),200);
  await context.route("**/api/**",route=>{
    const path=new URL(route.request().url()).pathname;if(path==="/api/session"||path.startsWith("/api/extraction-presets"))return route.continue();
    return route.fulfill({contentType:"application/json",body:JSON.stringify(path==="/api/jobs"||path==="/api/extraction-presets"?[]:path==="/api/status"?{maxConcurrency:2,siteAttention:[]}:{})});
  });
  await page.goto(base);await page.locator("#nav-presets").click();
  await page.locator("#preset-kind").selectOption("detail");await page.locator("#preset-target-field").selectOption("synopsis");
  assert.equal(await page.locator("#preset-field-gallery svg").count(),16);
  const bookmark=await page.locator("#preset-bookmarklet").getAttribute("href");
  await page.locator("#preset-source-url").fill("https://example.test/novel/1");
  const next=context.waitForEvent("page");await page.locator("#preset-connect").click();const source=await next;await source.waitForLoadState();
  assert.equal(source.url(),"https://example.test/novel/1");assert.equal(await source.evaluate(()=>window.opener),null);
  assert.match(await source.evaluate(()=>document.cookie),/FAKE_BROWSER_SESSION/);
  assert.equal(await source.locator("#nc-element-picker").count(),0,"websites do not automatically execute bookmarks on another origin");
  await source.evaluate(url=>{location.href=url;},bookmark);await source.locator("#nc-element-picker").waitFor();
  assert.equal(await source.locator("#nc-element-picker #field").inputValue(),"synopsis");await source.locator("#synopsis").click();
  await source.locator("#nc-element-picker #assign").click();
  const preset=await source.evaluate(()=>window.__NC_ELEMENT_PICKER__.exportPreset());assert.equal(preset.pages.detail.fields.synopsis.selector,"#synopsis");
  assert.ok(!/PREVIEW_ONLY|FAKE_BROWSER_SESSION/.test(JSON.stringify(preset)));
  const returning=context.waitForEvent("page");await source.locator("#nc-element-picker #save-preset").click();const returned=await returning;
  returned.on("pageerror",e=>errors.push(e.message));
  await returned.waitForFunction(()=>document.getElementById("preset-status").textContent.includes("서버에 저장했습니다"));
  assert.equal(presets.list().length,1);const saved=presets.get(presets.list()[0].id).config;
  assert.equal(saved.pages.detail.fields.synopsis.selector,"#synopsis");assert.equal(saved.version,2);
  assert.equal(await returned.locator(".preset-tree-page").count(),3);assert.match(await returned.locator("#preset-page-tree").textContent(),/✓ 줄거리/);
  assert.equal(await returned.evaluate(()=>location.hash),"");
  assert.ok(!requests.some(url=>url.includes("/api/preset-picker/")),"native opening/selection needs no capture or remote browser API");
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:844});await page.locator("#preset-field-gallery").locator("..").evaluate(el=>{el.open=true;});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  }
  assert.deepEqual(errors,[]);
});
