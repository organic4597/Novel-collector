import test from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {validatePreset,groupPreset,ExtractionPresets} from "../src/extraction-presets.mjs";
import {compilePreset,evaluatePresetPage,validateRunnablePreset,clickPresetAction,matchesPresetPage,presetHash} from "../src/preset-runtime.mjs";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {FolderStore} from "../src/store.mjs";
import {createApp} from "../src/server.mjs";
import {chromium} from "playwright";
const locator=(selector,options={})=>({selector,shadowPath:[],attribute:"text",multiple:false,...options});
const config=()=>({version:3,contentType:"webtoon",name:"합성 웹툰",origin:"https://sbxh9.com",catalogOrder:"newest-first",pages:{
  listing:{pagePatterns:["/ing","/end"],sources:{ongoing:"/ing",completed:"/end"},fields:{items:locator(".card",{multiple:true}),title:locator("h2",{relativeTo:"items"}),url:locator("a",{relativeTo:"items",attribute:"href"})}},
  detail:{pagePatterns:["/webtoon/{workId}"],fields:{title:locator("h1"),rows:locator(".episode",{multiple:true}),chapterUrl:locator("a",{relativeTo:"rows",attribute:"href"})}},
  reader:{pagePatterns:["/webtoon/{workId}/{episodeId}"],fields:{root:locator(".vw-imgs"),images:locator("img",{relativeTo:"root",attribute:"imageUrl",multiple:true})}}
}});
test("v3 webtoon presets validate while legacy presets compile without changing their original config",()=>{
  const value=validatePreset(config());assert.equal(value.contentType,"webtoon");validateRunnablePreset(value);
  const old={version:1,name:"기존 소설",origin:"https://sbxh9.com",pagePattern:"/novel/{workId}",kind:"detail",fields:{author:locator(".author")}};
  const before=structuredClone(old),compiled=compilePreset(groupPreset(old));assert.deepEqual(old,before);assert.equal(compiled.contentType,"novel");assert.ok(compiled.pages.detail.fields.authors);
  const broken=config();delete broken.pages.reader.fields.root;assert.throws(()=>validatePreset(broken),{status:400});
});
test("common evaluator preserves row scope, ordered duplicate images and transient image URLs",()=>{
  const dom=new JSDOM('<h1>합성 작품</h1><div class="vw-imgs"><img src="/first.jpg"><img data-src="https://cdn.example/second.png"><img src="/first.jpg"></div><img src="/banner.jpg">',{url:"https://sbxh9.com/webtoon/1/nv-1"});
  const result=evaluatePresetPage(config().pages.reader,dom.window.document);assert.equal(result.images.length,3);assert.deepEqual(result.images.map(image=>image.index),[1,2,3]);assert.equal(result.images[0].url,result.images[2].url);dom.window.close();
});
test("required runtime fields cannot silently fall back when a selected preset is incomplete",()=>{
  const value=config();delete value.pages.reader.fields.images;assert.throws(()=>validateRunnablePreset(validatePreset(value)),{status:400});
});
test("an empty v3 authoring draft can be saved and restored but cannot validate or activate",async t=>{
  const {presets,store}=await stored(t),draft=config();for(const page of Object.values(draft.pages))page.fields={};
  const saved=await presets.save(draft);assert.equal(presets.list()[0].fieldCount,0);
  const restored=await new ExtractionPresets({store}).load();assert.equal(restored.get(saved.id).config.version,3);
  assert.throws(()=>validateRunnablePreset(restored.get(saved.id).config),{status:400});
  await assert.rejects(restored.bind(saved.id),{status:400});
  const url="https://sbxh9.com/ing";
  await assert.rejects(restored.validatePage(saved.id,{pageKind:"listing",url},{url:()=>url,evaluate:async()=>{throw Error("must not evaluate");}}),{status:400});
});
test("webtoon image locators cannot collect outside the declared reader root",()=>{
  const value=config();delete value.pages.reader.fields.images.relativeTo;assert.throws(()=>validatePreset(value),{status:400});
});
test("v3 drafts keep explicit catalog order and webtoon listing sources even with no extraction fields",()=>{
  for(const edit of [value=>{delete value.catalogOrder;},value=>{delete value.pages.listing.sources;},value=>{delete value.pages.listing.sources.completed;}]){
    const value=config();edit(value);assert.throws(()=>validatePreset(value),{status:400});
  }
});
test("scope links and relative novel text work without mixing other cards or script contents",()=>{
  const dom=new JSDOM('<a class="card" href="/novel/1"><h2>첫 작품</h2></a><a class="card" href="/novel/2"><h2>둘째 작품</h2></a><div id="body"><p>첫 문단<br>다음 줄</p><script>PRIVATE_SCRIPT</script><p>둘째 문단</p></div>',{url:"https://sbxh9.com/novel"});
  const list=evaluatePresetPage({fields:{items:locator("a.card",{multiple:true}),title:locator("h2",{relativeTo:"items"}),url:locator(":scope",{relativeTo:"items",attribute:"href"})}},dom.window.document);
  assert.deepEqual(list.items.map(item=>item.url),["https://sbxh9.com/novel/1","https://sbxh9.com/novel/2"]);
  const body=evaluatePresetPage({fields:{root:locator("#body"),text:locator(":scope",{relativeTo:"root"})}},dom.window.document);
  assert.match(body.text,/첫 문단\n다음 줄/);assert.doesNotMatch(body.text,/PRIVATE_SCRIPT/);dom.window.close();
});
async function stored(t){
  const root=await mkdtemp(join(tmpdir(),"preset runtime "));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=await new FolderStore(root).init(),presets=await new ExtractionPresets({store}).load();return{store,presets};
}
async function validateAll(presets,id){
  for(const[pageKind,path]of [["listing","/ing"],["detail","/webtoon/1"],["reader","/webtoon/1/nv-1"]]){
    const url="https://sbxh9.com"+path,dom=new JSDOM('<h1>합성 작품</h1><div class="card"><h2>카드 제목</h2><a href="/webtoon/1">정보</a></div><div class="episode"><a href="/webtoon/1/nv-1">회차</a></div><div class="vw-imgs"><img src="https://cdn.example/image.jpg"></div>',{url});
    try{await presets.validatePage(id,{pageKind,url},{url:()=>url,evaluate:async(fn,page)=>fn(page,dom.window.document)});}finally{dom.window.close();}
  }
}
test("saved presets are not automatically active; source validation, binding and frozen snapshots survive restart",async t=>{
  const {presets,store}=await stored(t),saved=await presets.save(config());
  assert.equal(presets.snapshot({origin:"https://sbxh9.com",contentType:"webtoon"}),null);
  await assert.rejects(presets.bind(saved.id),{status:409});await validateAll(presets,saved.id);await presets.bind(saved.id);
  const snapshot=presets.snapshot({origin:"https://sbxh9.com",contentType:"webtoon"});assert.equal(snapshot.presetId,saved.id);assert.equal(snapshot.presetHash.length,64);
  const restored=await new ExtractionPresets({store}).load();assert.equal(restored.snapshot({origin:"https://sbxh9.com",contentType:"webtoon"}).presetHash,snapshot.presetHash);
  const changed=config();changed.pages.reader.fields.images.selector="img.changed";await presets.save(changed,saved.id);
  assert.equal(snapshot.presetSnapshot.pages.reader.fields.images.selector,"img");assert.throws(()=>presets.snapshot({origin:"https://sbxh9.com",contentType:"webtoon"}),{status:409});
  await assert.rejects(presets.remove(saved.id),{status:409});await presets.unbind(saved.id);await presets.remove(saved.id);
});
test("binding storage failures do not publish a default and validation results contain no preview values",async t=>{
  const {presets,store}=await stored(t),saved=await presets.save(config());await validateAll(presets,saved.id);
  const atomic=store.atomic.bind(store);store.atomic=async(path,value)=>{if(path===presets.bindingPath)throw Error("write denied");return atomic(path,value);};
  await assert.rejects(presets.bind(saved.id));assert.equal(presets.listBindings().bindings.length,0);
  const diagnostics=await store.json(presets.validationPath);assert.doesNotMatch(JSON.stringify(diagnostics),/image\.jpg|카드 제목|합성|cookie/);
});
test("binding APIs remain authenticated and reject unknown input and unvalidated presets",async t=>{
  const {presets}=await stored(t),saved=await presets.save(config()),app=createApp({store:{},scheduler:{},adminPassword:"synthetic-preset-api",extractionPresets:presets});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));t.after(()=>{app.closeAllConnections();return new Promise(resolve=>app.close(resolve));});
  const origin=`http://127.0.0.1:${app.address().port}`,path=`/api/extraction-presets/${saved.id}/binding`;
  assert.equal((await fetch(origin+"/api/extraction-presets/bindings")).status,401);
  const login=await fetch(origin+"/api/login",{method:"POST",body:JSON.stringify({password:"synthetic-preset-api"})}),cookie=login.headers.get("set-cookie").split(";")[0];
  const request=(body={},source=origin)=>fetch(origin+path,{method:"PUT",headers:{cookie,origin:source},body:JSON.stringify(body)});
  assert.equal((await request({},"https://foreign.example")).status,403);assert.equal((await request({preview:"private"})).status,400);assert.equal((await request()).status,409);
  await validateAll(presets,saved.id);assert.equal((await request()).status,200);
  const invalid=await fetch(origin+`/api/extraction-presets/${saved.id}/validate`,{method:"POST",headers:{cookie,origin},body:JSON.stringify({pageKind:"reader",url:"https://127.0.0.1/"})});assert.equal(invalid.status,400);
});
test("the DOM evaluator runs in Chromium without module-scope dependencies and validation returns only diagnostics",{skip:!process.env.BROWSER_PATH},async t=>{
  const {presets}=await stored(t),saved=await presets.save(config()),browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER_PATH});
  t.after(()=>browser.close());const page=await browser.newPage();
  await page.route("https://sbxh9.com/**",route=>route.fulfill({contentType:"text/html",body:'<div class="vw-imgs"><img src="https://cdn.example/a.jpg"><img src="https://cdn.example/a.jpg"></div>'}));
  await page.route("https://cdn.example/**",route=>route.abort());
  const url="https://sbxh9.com/webtoon/1/nv-1";await page.goto(url);
  const result=await presets.validatePage(saved.id,{pageKind:"reader",url},page);
  assert.equal(result.matches.images,2);assert.doesNotMatch(JSON.stringify(result),/a\.jpg|src=|cookie/);
});
test("incorrect scalar cardinality, field attributes and unknown path variables fail before activation",()=>{
  for(const modify of [value=>{value.pages.reader.fields.root.multiple=true;},value=>{value.pages.reader.fields.images.attribute="text";},value=>{value.pages.reader.pagePatterns=["/webtoon/{secret}"];},value=>{value.preview="PRIVATE_BODY";}]){
    const value=config();modify(value);assert.throws(()=>validatePreset(value),{status:400});
  }
});
test("page matching accepts checked slugs and exact origins while hashes ignore object key order",()=>{
  const value=compilePreset(config());assert.equal(matchesPresetPage(value,"reader","https://sbxh9.com/webtoon/123/kp-123-456"),true);
  for(const url of ["https://sbxh9.com.evil/webtoon/123/456","https://toki32.com/webtoon/123/456","https://sbxh9.com/webtoon/123/456/extra","https://sbxh9.com/webtoon/123/456#private"])
    assert.equal(matchesPresetPage(value,"reader",url),false);
  const reverse=Object.fromEntries(Object.entries(config()).reverse());assert.equal(presetHash(config()),presetHash(reverse));
});
test("declarative page actions click one enabled element and never imply completion on their own",()=>{
  const dom=new JSDOM('<button id="more">더 보기</button>');let clicks=0;dom.window.document.getElementById("more").onclick=()=>clicks++;
  assert.deepEqual(clickPresetAction(locator("#more"),dom.window.document),{changed:true});assert.equal(clicks,1);
  dom.window.document.getElementById("more").disabled=true;assert.deepEqual(clickPresetAction(locator("#more"),dom.window.document),{changed:false});assert.equal(clicks,1);dom.window.close();
});
