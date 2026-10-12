import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {JSDOM} from "jsdom";

test("history retry uses current book failures and recovered selections do not create a retry dialog",async t=>{
  const dom=new JSDOM(await readFile(new URL("../public/index.html",import.meta.url),"utf8"),{url:"http://localhost/",runScripts:"outside-only",pretendToBeVisual:true});t.after(()=>dom.window.close());const w=dom.window,toasts=[],calls=[];let failures=[{id:"failed",number:2}];
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  w.eval(await readFile(new URL("../public/performance.js",import.meta.url),"utf8"));
  w.CollectorUI={...w.CollectorPerformance,authenticated:()=>true,generation:()=>1,view:()=>"history",preferences:()=>({libraryPageSize:24}),toast:message=>toasts.push(message),api:async path=>{calls.push(path);assert.equal(path,"/api/books/book/failures");return failures;}};
  w.eval(await readFile(new URL("../public/library.js",import.meta.url),"utf8"));const job={id:"job",bookId:"book",title:"합성 작품",failedChapters:[{id:"recovered",number:1},{id:"failed",number:2}]};
  await w.CollectorLibrary.retryJob(job);assert.equal(w.document.querySelectorAll("#failures-list input").length,1);assert.equal(w.document.querySelector("#failures-list input").value,"failed");
  w.document.getElementById("failures-dialog").close();failures=[];await w.CollectorLibrary.retryJob(job);assert.equal(w.document.getElementById("failures-dialog").open,false);assert.match(toasts.at(-1),/현재 실패 회차가 없습니다/);assert.equal(calls.length,2);
});
