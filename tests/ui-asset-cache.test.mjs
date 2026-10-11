import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {chromium} from "playwright";
import {createApp} from "../src/server.mjs";
import {releaseHistory} from "../src/release-history.mjs";

async function fixture(t,html){
  const publicDir=await mkdtemp(join(tmpdir(),"ui-asset-cache-"));
  await writeFile(join(publicDir,"index.html"),html);
  await writeFile(join(publicDir,"release-history.js"),await readFile(new URL("../public/release-history.js",import.meta.url)));
  await writeFile(join(publicDir,"styles.css"),"body { color: black; }");
  const app=createApp({store:{},scheduler:{},adminPassword:"fixture-password",publicDir,updates:{history:()=>releaseHistory("1.0.1")}});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));await rm(publicDir,{recursive:true,force:true});});
  return{publicDir,base:"http://127.0.0.1:"+app.address().port};
}
const scriptUrl=html=>html.match(/src="([^"]*release-history\.js[^"]*)"/)[1];
test("HTML asset URLs and validators change when JavaScript changes even without an app version bump",async t=>{
  const f=await fixture(t,'<!doctype html><script src="/release-history.js" defer></script><link rel="stylesheet" href="/styles.css"><a href="/api/health">health</a>');
  const first=await fetch(f.base),html=await first.text(),before=scriptUrl(html),etag=first.headers.get("etag");
  assert.ok(new URL(before,f.base).searchParams.get("v"));assert.match(html,/href="\/styles\.css\?v=/);assert.ok(html.includes('href="/api/health"'));
  assert.equal((await fetch(f.base,{headers:{"if-none-match":etag}})).status,304);
  await writeFile(join(f.publicDir,"release-history.js"),'"use strict"; // synthetic replacement');
  const next=await fetch(f.base,{headers:{"if-none-match":etag}}),changed=await next.text();
  assert.equal(next.status,200);assert.notEqual(next.headers.get("etag"),etag);assert.notEqual(scriptUrl(changed),before);
  assert.equal(changed.match(/href="([^"]*styles\.css[^"]*)"/)[1],html.match(/href="([^"]*styles\.css[^"]*)"/)[1]);
  assert.equal((await fetch(f.base+scriptUrl(changed))).status,200);
});
test("cached legacy unversioned history JavaScript cannot hide the current three-part release",async t=>{
  const f=await fixture(t,'<!doctype html><meta charset="utf-8"><script src="/release-history.js" defer></script><button id="update-history-open">내역</button><button id="update-banner-history">알림 내역</button><button id="release-history-refresh">새로고침</button><select id="release-history-version"><option value="">전체 버전</option></select><p id="release-history-status"></p><p id="release-history-error"></p><div id="release-history-list"></div>');
  const current=await readFile(join(f.publicDir,"release-history.js"),"utf8"),old=current.replace('/^\\d+\\.\\d+\\.\\d+(?:\\.\\d+)?$/','/^\\d+\\.\\d+\\.\\d+\\.\\d+$/');
  assert.notEqual(old,current);
  const browser=await chromium.launch({executablePath:process.env.BROWSER_PATH,headless:true});t.after(()=>browser.close());
  const context=await browser.newContext(),page=await context.newPage();let staleLoads=0;const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  await context.route("**/release-history.js*",route=>{
    if(new URL(route.request().url()).searchParams.has("v"))return route.continue();
    staleLoads++;return route.fulfill({contentType:"application/javascript",body:old});
  });
  await context.addInitScript(()=>{
    let view="queue";
    window.CollectorUI={authenticated:()=>true,generation:()=>1,view:()=>view,textError:error=>error.message,
      node:(tag,className,text)=>{const element=document.createElement(tag);element.className=className||"";element.textContent=text||"";return element;},
      api:async path=>{const response=await fetch(path);if(!response.ok)throw Error("HTTP "+response.status);return response.json();},
      navigate:value=>{view=value;document.dispatchEvent(new CustomEvent("collector:view",{detail:value}));}};
  });
  assert.equal((await context.request.post(f.base+"/api/login",{data:{password:"fixture-password"}})).status(),200);
  await page.goto(f.base);await page.locator("#update-history-open").click();
  await page.waitForFunction(()=>document.querySelectorAll(".release-record").length>0||document.getElementById("release-history-error").textContent);
  assert.equal(await page.locator("#release-history-error").textContent(),"");assert.equal(staleLoads,0);
  await page.locator("#release-history-version").selectOption("1.0.1");assert.equal(await page.locator(".release-record").count(),1);
  assert.match(await page.locator(".release-record").textContent(),/작품제목-시작회차-끝회차/);
  await page.locator("#release-history-refresh").click();await page.waitForFunction(()=>!document.getElementById("release-history-refresh").disabled);
  assert.equal(await page.locator(".release-record").count(),1);assert.deepEqual(errors,[]);
});
