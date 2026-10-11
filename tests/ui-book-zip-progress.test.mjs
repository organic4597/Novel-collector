import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {JSDOM} from "jsdom";

test("image book ZIP click shows chapter preparation, merges duplicate clicks and downloads the ready cached file",async t=>{
  const dom=new JSDOM(await readFile(new URL("../public/index.html",import.meta.url),"utf8"),{url:"http://localhost/",runScripts:"outside-only",pretendToBeVisual:true});t.after(()=>dom.window.close());
  const w=dom.window;w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  const timeout=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...args)=>timeout(fn,ms===2000?20:ms,...args);
  w.eval(await readFile(new URL("../public/performance.js",import.meta.url),"utf8"));let posts=0,reads=0,downloaded=0;
  const progress=[];new w.MutationObserver(()=>progress.push(w.document.getElementById("bundle-progress").textContent)).observe(w.document.getElementById("bundle-progress"),{childList:true});
  const book={id:"book",contentType:"webtoon",title:"합성 웹툰",storedChapterCount:2,metadataStatus:"completed"};
  w.CollectorUI={...w.CollectorPerformance,authenticated:()=>true,generation:()=>1,view:()=>"library",preferences:()=>({libraryPageSize:24}),toast(){},api:async(path,options={})=>{
    if(path==="/api/books")return[book];
    if(path==="/api/books/book/export/zip"){posts++;assert.equal(options.method,"POST");assert.deepEqual(JSON.parse(options.body),{});return{id:"job-one",kind:"book-zip",bookId:"book",status:"preparing",phase:"catalog",processed:0,total:0};}
    if(path==="/api/downloads/job-one"){reads++;return{id:"job-one",kind:"book-zip",bookId:"book",status:reads<3?"preparing":"ready",phase:reads===1?"chapters":reads===2?"zip":"ready",percent:reads===2?42:null,processed:reads===1?1:2,total:2,filename:"합성 웹툰-1-2.zip"};}
    throw Error("unexpected API "+path);
  }};
  w.document.getElementById("bundle-download-link").addEventListener("click",event=>{event.preventDefault();downloaded++;});
  w.eval(await readFile(new URL("../public/library.js",import.meta.url),"utf8"));await w.CollectorLibrary.refresh();
  w.document.querySelector(".library-card").click();w.document.getElementById("library-profile-download").click();
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(w.document.getElementById("bundle-dialog").open,true);assert.match(w.document.getElementById("bundle-progress").textContent,/1 \/ 2회차/);
  w.document.getElementById("library-profile-download").click();assert.equal(posts,1);
  for(let checks=0;checks<100&&downloaded===0;checks++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(progress.some(text=>/ZIP 파일 저장 중.*42%/.test(text)));
  assert.match(w.document.getElementById("bundle-progress").textContent,/2회차.*준비 완료/);assert.equal(downloaded,1);
  assert.equal(w.document.getElementById("bundle-download-link").getAttribute("href"),"/api/downloads/job-one/file");
});
