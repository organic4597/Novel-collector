import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {JSDOM} from "jsdom";
test("title covers render a labelled SVG without treating title text as markup or loading an image URL",async t=>{
  const dom=new JSDOM("<span id='cover'></span>",{runScripts:"outside-only"});t.after(()=>dom.window.close());
  dom.window.eval(await readFile(new URL("../public/performance.js",import.meta.url),"utf8"));
  const cover=dom.window.document.getElementById("cover"),title="합성 작품 <script>alert(1)</script>";
  dom.window.CollectorPerformance.titleCover(cover,title);
  const svg=cover.querySelector("svg");assert.ok(svg);assert.equal(svg.getAttribute("aria-label"),"대체 표지: "+title);
  assert.equal(cover.querySelectorAll("script,img,foreignObject").length,0);assert.match(svg.textContent,/대체 표지/);
  dom.window.CollectorPerformance.titleCover(cover,title);assert.equal(cover.querySelector("svg"),svg);
  dom.window.CollectorPerformance.titleCover(cover,"변경된 제목");assert.match(cover.textContent,/변경된 제목/);
});
