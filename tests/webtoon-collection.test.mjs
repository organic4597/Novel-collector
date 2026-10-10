import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore, validateJob } from "../src/store.mjs";
import { makeBookId, Collector } from "../src/collector.mjs";
import { normalizeDiscoveryQuery, Discovery } from "../src/discovery.mjs";
import { normalizeDiscoveryUrl } from "../src/discovery-document.mjs";
import { chromium } from "playwright";
import JSZip from "jszip";
import { webtoonPreset, webtoonListing, readWebtoonPageState } from "../src/webtoon-runtime.mjs";
import { LibraryDownloads } from "../src/library-downloads.mjs";
import { webtoonImageInfo, verifyWebtoonChapter } from "../src/webtoon-images.mjs";
import { createApp } from "../src/server.mjs";
import { Scheduler } from "../src/queue.mjs";
import { SiteAttention } from "../src/site-attention.mjs";
import { presetHash } from "../src/preset-runtime.mjs";
import { ExtractionPresets } from "../src/extraction-presets.mjs";
import { JSDOM } from "jsdom";
import { readNormalListState, clickNormalListControl, normalSearchUrl } from "../src/normal-discovery.mjs";
import { evaluatePresetPage } from "../src/preset-runtime.mjs";
import { webtoonSource } from "../src/webtoon-source.mjs";

const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","base64");
const gif=Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7","base64");

test("webtoon discovery retains its type and admits public ongoing/completed pages",()=>{
  assert.equal(normalizeDiscoveryQuery({contentType:"webtoon"}).contentType,"webtoon");
  for(const path of ["/ing","/end","/webtoon/work-alpha"])
    assert.equal(normalizeDiscoveryUrl("https://sbxh9.com"+path).pathname,path);
  assert.throws(()=>normalizeDiscoveryQuery({contentType:"other"}),{status:400});
});
test("webtoon work IDs preserve real percent-encoded Korean slugs while rejecting escaped path separators",()=>{
  const url="https://sbxh9.com/webtoon/"+encodeURIComponent("합성-작품");
  assert.equal(validateJob({url,format:"cbz"}).url,url);assert.match(makeBookId(url),/^webtoon-[a-f0-9]{32}$/);
  assert.equal(normalizeDiscoveryUrl(url).href,url);
  assert.throws(()=>validateJob({url:"https://sbxh9.com/webtoon/a%2Fb",format:"cbz"}),{status:400});
});
test("webtoon genre/platform controls read icon labels and search retains title/author/status/sort",async()=>{
  const dom=new JSDOM('<div class="filter"><div class="filter-row"><span class="label">장르</span><div class="chips"><button>액션</button></div></div><div class="filter-row"><span class="label">플랫폼</span><div class="chips"><button aria-label="네이버"><img src="https://toki.peertrk.com/platforms/naver.png"></button></div></div></div><div class="toolbar"><span class="count">총 1개</span><div class="sort-tabs"><button class="active">최신순</button><button>평점순</button></div></div><div class="work-card-grid"><a class="card" href="/webtoon/fixture"><span class="subject">합성 작품</span><span class="genre">액션</span><img class="platform-icon" src="https://toki.peertrk.com/platforms/naver.png"><span class="ep-no">12화</span></a></div>',{url:"https://sbxh9.com/ing"});
  try{
    const doc=dom.window.document;for(const button of doc.querySelectorAll("button"))button.addEventListener("click",()=>{for(const node of button.parentElement.children)node.classList.remove("active");button.classList.add("active");});
    assert.equal(clickNormalListControl({kind:"genre",value:"액션"},doc).changed,true);
    assert.equal(clickNormalListControl({kind:"platform",value:"네이버"},doc).changed,true);
    assert.equal(clickNormalListControl({kind:"sort",value:"평점순"},doc).changed,true);
    assert.deepEqual(readNormalListState(doc).labels.find(row=>row.label==="플랫폼").active,["네이버"]);
    assert.equal(readNormalListState(doc).sort,"평점순");
    const selected=doc.querySelector('button[aria-label="네이버"]');selected.querySelector("img").alt="네이버";selected.setAttribute("aria-label","네이버 포함");
    assert.deepEqual(readNormalListState(doc).labels.find(row=>row.label==="플랫폼").active,["네이버"]);
    assert.deepEqual(readWebtoonPageState(doc).filters.platforms,["네이버"]);
    const page={url:()=>doc.URL,evaluate:async(fn,arg)=>fn===evaluatePresetPage?fn(arg,doc):fn(doc)};
    const parsed=await webtoonListing({transportUrl:()=>"https://sbxh9.com/novel"},page,{publication:"ongoing"});
    assert.equal(parsed.items[0].platform,"네이버");assert.equal(parsed.items[0].episodeCount,12);
    for(const field of ["title","author"]){const query=normalizeDiscoveryQuery({contentType:"webtoon",[field==="title"?"query":"author"]:"합성",publication:"completed",sort:"views"});
      const url=new URL(normalSearchUrl(query));assert.equal(url.searchParams.get("kind"),"webtoon");assert.equal(url.searchParams.get("field"),field);assert.equal(url.searchParams.get("status"),"completed");assert.equal(url.searchParams.get("sort"),"views");}
  }finally{dom.window.close();}
});
test("webtoon search combines genre and platform across every source page before dashboard pagination",async t=>{
  const root=await mkdtemp(join(tmpdir(),"webtoon-filters-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const discovery=new Discovery({rootDir:root}),calls=[];
  discovery.webtoonPlatforms={"https://sbxh9.com":{naver:"네이버"}};
  const item=(name,genre)=>({...webtoonSource("https://sbxh9.com/webtoon/"+name),title:name,genres:[genre],platform:"naver",episodeCount:12});
  discovery.sourceList=async query=>{normalizeDiscoveryQuery(query);calls.push(query);return{items:query.query?(query.page===1?[item("first","액션"),item("other","드라마")]:[item("last","액션")]):[],page:query.page||1,maxPage:query.query?2:1,total:3,cacheHit:true,cachedAt:new Date().toISOString(),filters:{genres:["액션","드라마"],platforms:["네이버"]}};};
  const result=await discovery.list({contentType:"webtoon",query:"합성",genre:"액션",platform:"네이버",publication:"completed",sort:"views"});
  assert.deepEqual(result.items.map(item=>item.title),["first","last"]);assert.equal(result.total,2);assert.equal(result.maxPage,1);
  assert.equal(calls.filter(query=>query.query).length,2);assert.equal(calls.filter(query=>query.query).every(query=>!query.genre&&!query.platform&&query.sort==="views"),true);
  assert.equal(result.filters.genre,"액션");assert.equal(result.filters.platform,"네이버");
});
test("webtoon dashboard sends all selected filters and supports title/author search without dead sort choices",async t=>{
  const dom=new JSDOM(await readFile(new URL("../public/index.html",import.meta.url),"utf8"),{url:"http://localhost/",runScripts:"outside-only",pretendToBeVisual:true});t.after(()=>dom.window.close());
  const window=dom.window,calls=[];window.HTMLElement.prototype.scrollIntoView=function(){};
  window.eval(await readFile(new URL("../public/performance.js",import.meta.url),"utf8"));
  window.CollectorUI={...window.CollectorPerformance,authenticated:()=>true,generation:()=>1,view:()=>"discover",toast(){},batch:async()=>({jobs:[]}),api:async path=>{
    const query=Object.fromEntries(new URL(path,"http://localhost").searchParams);calls.push(query);
    return{items:[],page:1,maxPage:1,total:0,filters:{...query,genres:["액션"],platforms:["네이버"]}};
  }};
  window.eval(await readFile(new URL("../public/discovery.js",import.meta.url),"utf8"));
  const doc=window.document,tick=()=>new Promise(resolve=>setTimeout(resolve,20)),set=(id,value,event="change")=>{doc.getElementById(id).value=value;doc.getElementById(id).dispatchEvent(new window.Event(event,{bubbles:true}));};
  window.document.dispatchEvent(new window.CustomEvent("collector:view",{detail:"discover"}));await tick();
  set("discover-content-type","webtoon");await tick();
  assert.equal(doc.getElementById("discover-sort").options.length,6);
  set("discover-genre","액션");set("discover-platform","네이버");set("discover-publication","completed");set("discover-sort","views");set("discover-query","합성 제목","input");
  assert.deepEqual([...doc.getElementById("discover-sort").options].map(node=>node.value),["updated","bookmarks","views","episodes"]);
  doc.getElementById("discover-form").dispatchEvent(new window.Event("submit",{cancelable:true}));await tick();
  assert.deepEqual(calls.at(-1),{contentType:"webtoon",page:"1",query:"합성 제목",author:"",genre:"액션",platform:"네이버",publication:"completed",sort:"views"});
  set("discover-search-type","author");set("discover-query","합성 작가","input");doc.getElementById("discover-form").dispatchEvent(new window.Event("submit",{cancelable:true}));await tick();
  assert.equal(calls.at(-1).author,"합성 작가");assert.equal(calls.at(-1).query,"");
  set("discover-query","","input");assert.equal(doc.getElementById("discover-sort").options.length,6);
});
async function imageFixture(t,{broken=false}={}){
  const source={broken};
  const root=await mkdtemp(join(tmpdir(),"webtoon-pipeline-")),store=await new FolderStore(root).init();
  const browser=await chromium.launch({executablePath:process.env.BROWSER_PATH,headless:true});
  t.after(async()=>{await browser.close();await rm(root,{recursive:true,force:true});});
  const selected=webtoonPreset(null,"https://sbxh9.com");
  const job=await store.createJob({url:"https://sbxh9.com/webtoon/fixture",format:"cbz",...selected});
  const collector=new Collector({store,delayMs:0,contentTimeoutMs:1000,launchContext:async()=>{
    const context=await browser.newContext({serviceWorkers:"block"});
    await context.route("https://sbxh9.com/**",async route=>{
      const url=new URL(route.request().url());
      if(url.pathname==="/pages/a.png")return route.fulfill({contentType:"image/png",body:png});
      if(url.pathname==="/pages/b.gif")return source.broken?route.fulfill({status:404,body:"missing"}):route.fulfill({contentType:"application/octet-stream",body:gif});
      const html=url.pathname==="/webtoon/fixture"?
        '<h1 class="hero-v2-title">합성 웹툰</h1><div class="hero-v2-author">첫 작가, 둘째 작가</div><span class="ep-section-count">총 2회차</span><ul id="webtoon-episode-list">'+
        ["episode-B","episode-A"].map((id,index)=>`<li class="ep-row-v2"><a class="ep-row-v2-link" href="/webtoon/fixture/${id}"><span class="ep-row-v2-no">${2-index}화</span><div class="ep-row-v2-title">합성 ${id}</div></a></li>`).join("")+"</ul>":
        '<div class="vw-imgs"><img src="/pages/a.png?token=private-image-token"><img src="/pages/b.gif?token=private-image-token"><img src="/pages/a.png?token=private-image-token"></div>';
      return route.fulfill({contentType:"text/html; charset=utf-8",body:'<!doctype html><meta charset="utf-8">'+html});
    });return context;
  }});
  collector.installNetworkGuard=async(_context,options)=>assert.equal(options.allowImages,true);
  const hooks={report:patch=>store.patchJob(job.id,patch),event:(level,message)=>store.appendEvent(job.id,{level,message}),requestSuccess:async()=>{}};
  return{root,store,job,collector,hooks,source,browser};
}
test("image signatures determine format independently of MIME and reject oversized or non-image bytes",()=>{
  assert.equal(webtoonImageInfo(png).mimeType,"image/png");assert.equal(webtoonImageInfo(gif).mimeType,"image/gif");
  assert.equal(webtoonImageInfo(png).width,1);
  assert.throws(()=>webtoonImageInfo(Buffer.from("not an image")),{code:"IMAGE_SIGNATURE_INVALID"});
  assert.throws(()=>webtoonImageInfo(Buffer.alloc(8*1024**2+1)),{code:"IMAGE_SIZE_LIMIT"});
});
test("webtoon collection stores original ordered duplicate images, authors and CBZ/ZIP bytes",async t=>{
  const f=await imageFixture(t),result=await f.collector.run(f.job,f.hooks,new AbortController().signal);
  assert.equal(result.status,"completed");assert.equal(result.completed,2);
  const book=await f.store.getBook(result.bookId);assert.equal(book.contentType,"webtoon");assert.deepEqual(book.authors,["첫 작가","둘째 작가"]);
  const chapters=await f.store.listChapters(book.id);assert.equal(chapters.length,2);assert.match(chapters[0].title,/episode-A/);
  assert.equal(Object.hasOwn(chapters[0],"images"),false);
  const chapter=await f.store.readChapter(book.id,chapters[0].id);
  assert.equal(chapter.images.length,3);assert.equal(chapter.images[0].sha256,chapter.images[2].sha256);
  assert.notEqual(chapter.images[0].sha256,chapter.images[1].sha256);
  assert.ok(!JSON.stringify(chapter).includes("private-image-token"));assert.ok(await verifyWebtoonChapter(f.store,book.id,chapter));
  const downloads=new LibraryDownloads({store:f.store,rootDir:join(f.root,"downloads")});t.after(()=>downloads.close());
  const cbz=await JSZip.loadAsync(await readFile((await downloads.chapterCbz(book.id,chapter.id)).path));
  assert.deepEqual(Object.keys(cbz.files),["0001.png","0002.gif","0003.png"]);
  assert.deepEqual(await cbz.file("0001.png").async("nodebuffer"),png);
  assert.deepEqual(await cbz.file("0002.gif").async("nodebuffer"),gif);
  const zip=await JSZip.loadAsync(await readFile((await downloads.bookZip(book.id)).path));assert.deepEqual(Object.keys(zip.files),chapters.map(c=>`${String(c.number).padStart(4,"0")}_${c.id}.cbz`));
  const replay=await f.collector.run({...f.job,resumeCatalog:true},f.hooks,new AbortController().signal);
  assert.equal(replay.skipped,2);assert.equal(replay.completed,0);
  await writeFile(f.store.path("books",book.id,"chapters",chapter.id,chapter.images[0].filename),gif);
  await assert.rejects(downloads.chapterCbz(book.id,chapter.id),{code:"CHAPTER_INCOMPLETE"});
});
test("missing image responses leave partial checkpoints and never create complete chapters or CBZ",async t=>{
  const f=await imageFixture(t,{broken:true}),result=await f.collector.run(f.job,f.hooks,new AbortController().signal);
  assert.equal(result.status,"failed");assert.equal(result.failed,2);assert.equal((await f.store.listChapters(result.bookId)).length,0);
  const catalog=await f.store.readCatalog(result.bookId),partial=await f.store.json(f.store.path("books",result.bookId,"chapters",catalog.chapters[0].id,"partial.json"));
  assert.equal(partial.complete,false);assert.equal(partial.savedImages,1);assert.ok(!JSON.stringify(partial).includes("private-image-token"));
  assert.equal(partial.failedImages[0].index,2);
  f.source.broken=false;
  const resumed=await f.collector.run({...f.job,retryOnlyFailed:true},f.hooks,new AbortController().signal);
  assert.equal(resumed.status,"completed");assert.equal(resumed.completed,2);assert.equal((await f.store.listFailures(result.bookId)).length,0);
});
test("manual cancellation preserves an image checkpoint without counting it as a source failure, and resumes",async t=>{
  const f=await imageFixture(t),controller=new AbortController();let failures=0;
  const hooks={...f.hooks,requestFailure:async()=>{failures++;},report:async patch=>{await f.hooks.report(patch);if(patch.savedImages===1)controller.abort();}};
  await assert.rejects(f.collector.run(f.job,hooks,controller.signal),{name:"AbortError"});assert.equal(failures,0);
  const bookId=makeBookId(f.job.url),catalog=await f.store.readCatalog(bookId),partial=await f.store.json(f.store.path("books",bookId,"chapters",catalog.chapters[0].id,"partial.json"));
  assert.equal(partial.savedImages,1);assert.equal(partial.complete,false);assert.equal((await f.store.listChapters(bookId)).length,0);
  const resumed=await f.collector.run(f.job,f.hooks,new AbortController().signal);assert.equal(resumed.completed,2);
});
test("a new preset hash cannot reuse old catalog or image checkpoints without explicit overwrite",async t=>{
  const f=await imageFixture(t,{broken:true}),first=await f.collector.run(f.job,f.hooks,new AbortController().signal);
  const catalog=await f.store.readCatalog(first.bookId),path=f.store.path("books",first.bookId,"chapters",catalog.chapters[0].id,"partial.json"),before=await f.store.json(path);
  const config=structuredClone(f.job.presetSnapshot);config.catalogOrder="oldest-first";
  const job={...f.job,presetSnapshot:config,presetHash:presetHash(config),resumeCatalog:true};f.source.broken=false;
  const conflict=await f.collector.run(job,f.hooks,new AbortController().signal);assert.equal(conflict.status,"failed");
  assert.equal((await f.store.listFailures(first.bookId)).every(row=>row.code==="CHECKPOINT_CONFLICT"),true);assert.deepEqual(await f.store.json(path),before);
  const rewritten=await f.collector.run({...job,overwrite:true},f.hooks,new AbortController().signal);assert.equal(rewritten.status,"completed");
});
test("webtoon defaults are editable configuration copies and never activate bindings automatically",async t=>{
  const root=await mkdtemp(join(tmpdir(),"webtoon-default-")),store=await new FolderStore(root).init();t.after(()=>rm(root,{recursive:true,force:true}));
  const presets=await new ExtractionPresets({store}).load(),saved=await presets.addDefault("sbxh9-webtoon-v3");
  assert.equal(saved.config.version,3);assert.equal(saved.config.contentType,"webtoon");assert.equal(saved.config.pages.reader.fields.images.relativeTo,"root");
  assert.equal(presets.listBindings().bindings.length,0);await assert.rejects(presets.bind(saved.id),{status:409});
});
test("mixed novel/webtoon reservations share two slots and retain origin-specific attention state",async t=>{
  const root=await mkdtemp(join(tmpdir(),"webtoon-slots-")),store=await new FolderStore(root).init();t.after(()=>rm(root,{recursive:true,force:true}));
  const selected=webtoonPreset(null,"https://sbxh9.com");
  await store.createJobs([{url:"https://newtoki1.org/novel/1"},{url:"https://sbxh9.com/webtoon/1",...selected},
    {url:"https://sbxh9.com/webtoon/2",...selected}]);
  let current=0,maximum=0;const finishes=[];
  const scheduler=new Scheduler({store,collector:{delayMs:0},collectorFactory:()=>({delayMs:0,close:async()=>{},run:async()=>{
    current++;maximum=Math.max(maximum,current);await new Promise(resolve=>finishes.push(()=>{current--;resolve();}));return{status:"completed"};}}),intervalMs:60000});
  t.after(()=>scheduler.stop());await scheduler.start();await scheduler.tick();await new Promise(r=>setTimeout(r,20));
  assert.equal(maximum,2);assert.equal(scheduler.activeJobIds.length,2);finishes.shift()();await new Promise(r=>setTimeout(r,30));
  assert.equal(maximum,2);while(finishes.length)finishes.shift()();await new Promise(r=>setTimeout(r,30));
  while(finishes.length)finishes.shift()();await scheduler.stop();
  const attention=new SiteAttention({store});await attention.load();await attention.holdSite("sbxh9.com",{kind:"site_blocked",reason:"fixture HTTP403",jobIds:[],requiredSlots:[1]});
  const restored=new SiteAttention({store});await restored.load();assert.equal(restored.isHeld("sbxh9.com"),true);assert.equal(restored.isHeld("toki32.com"),false);
});
test("authenticated webtoon dashboard shows type-specific reservations, stored images and real downloads",async t=>{
  const f=await imageFixture(t),collected=await f.collector.run(f.job,f.hooks,new AbortController().signal);
  await f.store.patchJob(f.job.id,collected);
  await f.store.upsertBook("novel-fixture",{title:"합성 소설",storedChapterCount:0});
  const downloads=new LibraryDownloads({store:f.store,rootDir:join(f.root,"downloads")});
  const webtoon={...(await f.store.getBook(collected.bookId)),url:f.job.url,contentType:"webtoon",episodeCount:2};
  const discovery={list:async query=>({items:query.contentType==="webtoon"?[webtoon]:[],page:1,maxPage:1,total:query.contentType==="webtoon"?1:0,filters:{genres:[],platforms:[]}}),
    overviewState:async()=>({status:"completed",item:webtoon}),requestDetail:async()=>({status:"completed",item:webtoon}),detailState:async()=>({status:"completed",item:webtoon})};
  const app=createApp({store:f.store,scheduler:{},downloads,discovery,adminPassword:"fixture-password"});await new Promise(r=>app.listen(0,"127.0.0.1",r));
  t.after(async()=>{await downloads.close();app.closeAllConnections();await new Promise(r=>app.close(r));});
  const base="http://127.0.0.1:"+app.address().port,context=await f.browser.newContext(),page=await context.newPage(),errors=[];
  page.on("pageerror",e=>errors.push(e.message));await page.goto(base);
  await page.locator("#login-password").fill("fixture-password");await page.locator("#login-form button[type=submit]").click();
  await page.locator("#nav-discover").click();await page.locator("#discover-content-type").selectOption("webtoon");
  await page.locator("#discover-list .discover-title-link").click();await page.locator("#work-dialog").waitFor({state:"visible"});
  assert.equal(await page.locator("#work-source").getAttribute("href"),f.job.url);assert.equal(await page.locator("#work-format").inputValue(),"cbz");
  await page.locator("#work-add").click();await page.waitForFunction(()=>document.querySelector("#work-add").disabled===false);
  const registered=(await f.store.listJobs()).find(job=>job.id!==f.job.id);assert.equal(registered.contentType,"webtoon");assert.equal(registered.presetSnapshot.version,3);
  await page.keyboard.press("Escape");
  await page.locator("#nav-library").click();await page.locator("#library-content-type").selectOption("webtoon");
  await page.locator("#books-list .library-card").waitFor();assert.equal(await page.locator("#books-list .library-card").count(),1);
  await page.locator("#books-list .library-card").click();const zipLink=page.locator("#library-profile-download");assert.equal(await zipLink.innerText(),"작품 ZIP 받기");
  assert.equal((await page.request.get(base+await zipLink.getAttribute("href"))).status(),200);
  await page.locator("#library-content-tab").click();
  await page.locator("#reader-text .webtoon-reader-image").first().waitFor();assert.equal(await page.locator("#reader-text .webtoon-reader-image").count(),3);
  assert.equal((await page.request.get(base+await page.locator("#reader-text a").getAttribute("href"))).status(),200);
  await page.waitForFunction(()=>[...document.querySelectorAll(".webtoon-reader-image")].every(image=>image.complete&&image.naturalWidth>0));
  await page.keyboard.press("Escape");assert.equal(await page.locator("#reader-dialog").evaluate(n=>n.open),false);
  for(const width of [1280,390]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  await page.locator("#library-content-type").selectOption("novel");assert.equal(await page.locator("#books-list .library-card").count(),1);
  assert.deepEqual(errors,[]);assert.equal((await fetch(base+"/api/books/"+collected.bookId+"/export/zip")).status,401);
  await context.close();
});
test("authenticated reservation APIs create server-owned webtoon snapshots and reject forged snapshots",async t=>{
  const root=await mkdtemp(join(tmpdir(),"webtoon-api-")),store=await new FolderStore(root).init(),app=createApp({store,scheduler:{},adminPassword:"fixture-password"});
  await new Promise(r=>app.listen(0,"127.0.0.1",r));t.after(async()=>{app.closeAllConnections();await new Promise(r=>app.close(r));await rm(root,{recursive:true,force:true});});
  const base="http://127.0.0.1:"+app.address().port,login=await fetch(base+"/api/login",{method:"POST",headers:{"content-type":"application/json",origin:base},body:JSON.stringify({password:"fixture-password"})});
  const headers={"content-type":"application/json",origin:base,cookie:login.headers.get("set-cookie").split(";")[0]};
  const value={url:"https://sbxh9.com/webtoon/fixture",format:"cbz"};
  const response=await fetch(base+"/api/jobs",{method:"POST",headers,body:JSON.stringify(value)});assert.equal(response.status,201);
  const job=await response.json();assert.equal(job.presetSnapshot.contentType,"webtoon");assert.match(job.presetHash,/^[a-f0-9]{64}$/);
  assert.equal((await fetch(base+"/api/jobs",{method:"POST",headers,body:JSON.stringify({...value,presetHash:"forged"})})).status,400);
});
test("webtoon registration preserves origin, snapshots and slug identity without changing novel IDs",async t=>{
  const root=await mkdtemp(join(tmpdir(),"webtoon-store-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=await new FolderStore(root).init();
  const input={url:"https://sbxh9.com/webtoon/work-alpha",contentType:"webtoon",format:"cbz"};
  const job=await store.createJob(input);
  assert.equal(job.url,input.url);assert.equal(job.contentType,"webtoon");
  assert.match(makeBookId(job.url),/^webtoon-[a-f0-9]{32}$/);
  assert.notEqual(makeBookId(job.url),makeBookId(job.url.replace("sbxh9.com","toki32.com")));
  assert.equal(makeBookId("https://newtoki1.org/novel/12"),"newtoki1_org-12");
  assert.throws(()=>validateJob({...input,format:"txt"}),{status:400});
  assert.throws(()=>validateJob({...input,executor:"browser"}),{status:400});
  assert.throws(()=>validateJob({...input,url:input.url+"?token=private"}),{status:400});
});
