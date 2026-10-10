import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function fixture(t, { unknown = false } = {}) {
  const dom = new JSDOM(await readFile(new URL("../public/index.html", import.meta.url), "utf8"), { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window, calls = [];
  let view = "discover", auth = true, generation = 1, now = Date.now(), handler;
  w.Date.now = () => now;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.eval(await readFile(new URL("../public/performance.js", import.meta.url), "utf8"));
  const item = (id, count = unknown ? null : 10) => ({ id: String(id), title: `작품 ${id}`, author: "작가", url: `https://newtoki1.org/novel/${id}`, episodeCount: count, genres: ["판타지"], thumbnail: `/api/discover/${id}/thumbnail` });
  w.CollectorUI = { ...w.CollectorPerformance, authenticated: () => auth, generation: () => generation, view: () => view, empty: (_, text) => w.CollectorPerformance.node("p", "empty", text), toast() {}, batch: async () => ({ jobs: [] }), api: async (path, options = {}, _timeout, progress) => { calls.push({ path, options }); if (handler) return handler(path, options, progress); const page = Number(new URL(path, "http://localhost").searchParams.get("page") || 1); return path.endsWith("/refresh") ? { status: "completed", item: item(1, 20) } : { items: [item(page * 2 - 1), item(page * 2)], page, maxPage: 3, total: 6, stale: false, cachedAt: new Date(now).toISOString() }; } };
  w.eval((await readFile(new URL("../public/discovery.js", import.meta.url), "utf8")) + "\n//# sourceURL=" + new URL("../public/discovery.js", import.meta.url).href);
  function navigate(value) { view = value; w.document.dispatchEvent(new w.CustomEvent("collector:view", { detail: value })); }
  navigate("discover"); await tick();
  return { w, calls, item, navigate, setHandler: value => { handler = value; }, expire: () => { now += 31 * 60 * 1000; }, logout: () => { auth = false; generation++; w.document.dispatchEvent(new w.CustomEvent("collector:auth", { detail: false })); } };
}
test("discovery ratings and genre-tag labels use current values without rebuilding cards", async t => {
  const f = await fixture(t), d = f.w.document, card = d.querySelector('[data-id="1"]');
  const meta = card.querySelector(".discover-meta"), image = card.querySelector("img");
  assert.match(meta.textContent, /평점 미확인/);
  f.w.DiscoveryCatalog.update({...f.item(1),genres:["현대","현대"],tags:["현대","액션","액션"],rating:4.7});
  assert.match(meta.textContent, /평점 4\.7 \/ 5/);
  assert.deepEqual(Array.from(card.querySelectorAll(".discover-tags span"),node=>node.textContent),["현대","#액션"]);
  f.w.DiscoveryCatalog.update({...f.item(1),rating:3.2});
  assert.match(meta.textContent, /평점 3\.2 \/ 5/);
  assert.equal(d.querySelector('[data-id="1"]'),card);assert.equal(card.querySelector("img"),image);
  f.w.DiscoveryCatalog.update({...f.item(1),rating:0});assert.match(meta.textContent,/평점 0\.0 \/ 5/);
  for(const rating of [null,undefined,-1,6,"4.8"]){f.w.DiscoveryCatalog.update({...f.item(1),rating});assert.match(meta.textContent,/평점 미확인/);}
});
test("discovery failed covers show the current work title and author searches use the author query field",async t=>{
  const f=await fixture(t),d=f.w.document,card=d.querySelector('[data-id="1"]');
  card.querySelector("img").dispatchEvent(new f.w.Event("error"));
  assert.ok(card.querySelector(".cover-fallback svg"));assert.match(card.querySelector(".cover-fallback").textContent,/작품 1/);
  f.w.DiscoveryCatalog.update({...f.item(1),title:"새 표지 제목",thumbnail:null});assert.match(card.querySelector(".cover-fallback").textContent,/새 표지 제목/);
  d.getElementById("discover-search-type").value="author";d.getElementById("discover-search-type").dispatchEvent(new f.w.Event("change"));
  d.getElementById("discover-query").value="합성 작가";
  d.getElementById("discover-form").dispatchEvent(new f.w.Event("submit",{cancelable:true}));await tick();
  const query=new URL(f.calls.at(-1).path,"http://localhost").searchParams;
  assert.equal(query.get("author"),"합성 작가");assert.equal(query.get("query"),"");
});
test("discovery manual checking and metadata updates patch existing title, controls and covers", async t => {
  const f = await fixture(t), d = f.w.document;
  const first = d.querySelector('[data-id="1"]'), cover = first.querySelector("img"), title = first.querySelector(".discover-title-link"), second = d.querySelector('[data-id="2"]');
  first.querySelector(".discover-content button").click(); await tick();
  assert.equal(d.querySelector('[data-id="1"]'), first);
  assert.equal(first.querySelector("img"), cover);
  assert.equal(first.querySelector(".discover-title-link"), title);
  assert.equal(d.querySelector('[data-id="2"]'), second);
  assert.match(first.querySelector(".discover-count").textContent, /20/);
  f.w.DiscoveryCatalog.update({ ...f.item(1, 25), title: "새 제목" });
  assert.equal(title.textContent, "새 제목");
  assert.equal(first.querySelector("img"), cover);
});
test("three-page navigation reuses completed snapshots and expiry retains cards while refreshing", async t => {
  const f = await fixture(t), d = f.w.document;
  const first = d.querySelector('[data-id="1"]'), cover = first.querySelector("img");
  d.getElementById("discover-next").click(); await tick();
  d.getElementById("discover-prev").click(); await tick();
  assert.equal(f.calls.length, 2);
  assert.equal(d.querySelector('[data-id="1"]'), first);
  assert.equal(first.querySelector("img"), cover);
  f.expire(); let release;
  f.setHandler(async () => new Promise(resolve => { release = resolve; }));
  f.navigate("queue"); f.navigate("discover"); await tick();
  assert.equal(d.querySelector('[data-id="1"]'), first);
  assert.equal(d.querySelectorAll(".is-loading").length, 0);
  release({ items: [{ ...f.item(1, 30), title: "현재 작품" }, f.item(2)], page: 1, maxPage: 3, stale: false }); await tick();
  assert.equal(first.querySelector(".discover-title-link").textContent, "현재 작품");
  assert.equal(first.querySelector("img"), cover);
});
test("stale server snapshots display freshness/error status and never remount after logout", async t => {
  const f = await fixture(t), d = f.w.document;
  f.setHandler(async () => ({ items: [f.item(1), f.item(2)], page: 1, maxPage: 3, stale: true, revalidating: false, refreshError: "접근 확인 대기" }));
  d.getElementById("discover-form").dispatchEvent(new f.w.Event("submit", { cancelable: true })); await tick();
  assert.match(d.getElementById("discover-message").textContent, /저장|갱신/);
  assert.match(d.getElementById("discover-error").textContent, /접근 확인 대기/);
  let release;
  f.setHandler(async () => new Promise(resolve => { release = resolve; }));
  d.getElementById("discover-form").dispatchEvent(new f.w.Event("submit", { cancelable: true })); await tick();
  f.logout();
  release({ items: [f.item(99)], page: 1, maxPage: 1 }); await tick();
  assert.equal(d.getElementById("discover-list").children.length, 0);
});

test("metadata POST invalidation prevents an older background list from replacing a current work", async t => {
  const f=await fixture(t), d=f.w.document;
  f.expire();let release;
  f.setHandler(async()=>new Promise(resolve=>{release=resolve;}));
  f.navigate("queue");f.navigate("discover");await tick();
  d.dispatchEvent(new f.w.CustomEvent("collector:mutated",{detail:{path:"/api/discover/1/overview"}}));
  f.w.DiscoveryCatalog.update({...f.item(1,30),title:"확인한 최신 작품"});
  release({items:[{...f.item(1,10),title:"갱신 전 작품"}],page:1,maxPage:3});await tick();
  assert.equal(d.querySelector('[data-id="1"] .discover-title-link').textContent,"확인한 최신 작품");
});

test("page cache is bounded to three snapshots and selection survives an evicted page", async t => {
  const f=await fixture(t),d=f.w.document;
  d.querySelector('[data-id="1"] input').click();
  f.setHandler(async path=>{const page=Number(new URL(path,"http://localhost").searchParams.get("page"));return{items:[f.item(page*2-1),f.item(page*2)],page,maxPage:5,total:10};});
  for(let page=2;page<=4;page++){d.getElementById("discover-next").click();await tick();}
  for(let page=3;page>=1;page--){d.getElementById("discover-prev").click();await tick();}
  assert.equal(f.calls.length,5,"evicted page one is fetched once; pages two/three return from cache");
  assert.equal(d.querySelector('[data-id="1"] input').checked,true);
});

test("selected unknown-count work submits the latest visible metadata without replacing its checkbox", async t => {
  const f=await fixture(t,{unknown:true}),d=f.w.document;
  const check=d.querySelector('[data-id="1"] input');check.click();
  f.setHandler(async()=>({items:[{...f.item(1),title:"최신 제목",author:"새 작가"},f.item(2)],page:1,maxPage:3}));
  d.getElementById("discover-form").dispatchEvent(new f.w.Event("submit",{cancelable:true}));await tick();
  let submitted;f.w.CollectorUI.batch=async jobs=>{submitted=jobs;return{jobs:[{}]};};
  d.getElementById("discover-add-selected").click();await tick();
  assert.equal(submitted[0].title,"최신 제목");
  assert.equal(submitted[0].url,"https://newtoki1.org/novel/1");
  assert.equal(d.querySelector('[data-id="1"] input'),check);
});

test("invalid bounds retain the cards and metadata selection remains capped at one hundred", async t=>{
  const f=await fixture(t),d=f.w.document,card=d.querySelector('[data-id="1"]');
  d.getElementById("discover-min").value="30";d.getElementById("discover-max").value="10";
  d.getElementById("discover-min").dispatchEvent(new f.w.Event("input"));
  assert.match(d.getElementById("discover-error").textContent,/회차 범위/);
  assert.equal(d.querySelector('[data-id="1"]'),card);
  d.getElementById("discover-min").value="";d.getElementById("discover-max").value="";
  for(let id=1;id<=101;id++)f.w.DiscoveryCatalog.select(f.item(id));
  assert.match(d.getElementById("discover-selected").textContent,/100/);
  assert.match(d.getElementById("discover-error").textContent,/최대 100/);
  d.getElementById("discover-clear").click();
  assert.match(d.getElementById("discover-selected").textContent,/0/);
});

test("revalidating snapshots refresh in the background and keep the original cover node",async t=>{
  const f=await fixture(t),d=f.w.document,img=d.querySelector('[data-id="1"] img');
  const timeout=f.w.setTimeout.bind(f.w);f.w.setTimeout=(fn,ms,...args)=>timeout(fn,ms===2000?1:ms,...args);
  let reads=0;f.setHandler(async()=>++reads===1?{items:[f.item(1),f.item(2)],page:1,maxPage:3,stale:true,revalidating:true}:
    {items:[{...f.item(1,50),title:"갱신 완료"},f.item(2)],page:1,maxPage:3,stale:false});
  d.getElementById("discover-form").dispatchEvent(new f.w.Event("submit",{cancelable:true}));
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(reads,2);
  assert.equal(d.querySelector('[data-id="1"] img'),img);
  assert.match(d.getElementById("discover-message").textContent,/최신 목록/);
  assert.equal(d.querySelector('[data-id="1"] .discover-title-link').textContent,"갱신 완료");
});

test("hiding discovery stops background revalidation without a new source request",async t=>{
  const f=await fixture(t),d=f.w.document;let reads=0;
  f.setHandler(async()=>{reads++;return{items:[f.item(1),f.item(2)],page:1,maxPage:3,stale:true,revalidating:true};});
  d.getElementById("discover-form").dispatchEvent(new f.w.Event("submit",{cancelable:true}));await tick();
  Object.defineProperty(d,"hidden",{value:true,configurable:true});d.dispatchEvent(new f.w.Event("visibilitychange"));
  await tick();assert.equal(reads,1);
  assert.equal(d.querySelector('[data-id="1"] .discover-title-link').textContent,"작품 1");
});

test("ranking shows all fifty source ranks independently of hidden normal-list episode filters",async t=>{
  const f=await fixture(t),d=f.w.document;
  d.getElementById("discover-min").value="100";
  d.getElementById("discover-unknown").checked=false;
  f.setHandler(async()=>({items:Array.from({length:50},(_,index)=>({...f.item(index+1,null),rank:index+1,contentType:"novel"})),page:1,maxPage:1,total:50,ranking:true}));
  d.getElementById("discover-ranking-tab").click();await tick();
  assert.equal(d.querySelectorAll("#discover-list .discover-card").length,50);
  assert.equal(d.getElementById("discover-form").hidden,true);
  assert.equal(d.getElementById("discover-min").value,"100");
  assert.equal(d.getElementById("discover-unknown").checked,false);
});

test("a repeated ranking filter change during a pending load does not leave loading cards stranded",async t=>{
  const f=await fixture(t),d=f.w.document,replies=[];
  f.setHandler(()=>new Promise(resolve=>replies.push(resolve)));
  d.getElementById("discover-ranking-tab").click();await tick();
  d.getElementById("discover-rank-period").dispatchEvent(new f.w.Event("change"));await tick();
  for(const reply of replies)reply({items:[{...f.item(1,null),rank:1,contentType:"novel"}],page:1,maxPage:1,total:1,ranking:true});
  await tick();
  assert.equal(d.querySelectorAll("#discover-list .is-loading").length,0);
  assert.equal(d.querySelector("#discover-list .discover-title-link")?.textContent,"작품 1");
});
