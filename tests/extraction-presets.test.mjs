import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtractionPresets, validatePreset, groupPreset, PRESET_PAGE_FIELDS } from "../src/extraction-presets.mjs";
import { FolderStore } from "../src/store.mjs";
import { createApp } from "../src/server.mjs";
const config=()=>({version:1,name:"테스트 소개",origin:"https://example.com",pagePattern:"/novel/{workId}",kind:"detail",
  fields:{title:{selector:"h1",attribute:"text",multiple:false,shadowPath:[]},tags:{selector:".tags a",attribute:"text",multiple:true}}});
async function fixture(t){const root=await mkdtemp(join(tmpdir(),"presets-test-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=await new FolderStore(root).init();const presets=await new ExtractionPresets({store}).load();return{store,presets};}

test("only selector configuration is accepted; raw previews, credentials and script attributes are rejected",()=>{
  assert.equal(validatePreset(config()).fields.title.attribute,"text");
  for(const patch of [{sample:"private body"},{cookies:"private-cookie"},{origin:"http://example.com"},{origin:"https://localhost"},{origin:"https://127.0.0.1"},{origin:"https://example.com/path"},{pagePattern:"/page?token=private"},{version:2}])
    assert.throws(()=>validatePreset({...config(),...patch}),{status:400});
  assert.throws(()=>validatePreset({...config(),fields:{title:{selector:"h1",attribute:"value",multiple:false}}}),{status:400});
  assert.throws(()=>validatePreset({...config(),fields:{title:{selector:"h1",attribute:"text",multiple:false,sample:"body"}}}),{status:400});
});

test("one preset stores three page types, separating novel title and chapter title across restarts",async t=>{
  const group=groupPreset(config());group.pages.detail.fields.rows={selector:".episode",attribute:"text",multiple:true};
  group.pages.detail.fields.chapterTitle={selector:".episode-name",attribute:"text",multiple:false,relativeTo:"rows"};
  group.pages.reader.fields.text={selector:".body",attribute:"text",multiple:false};
  assert.deepEqual(Object.keys(group.pages),Object.keys(PRESET_PAGE_FIELDS));validatePreset(group);
  const {store,presets}=await fixture(t);const saved=await presets.save(group),restored=await new ExtractionPresets({store}).load();
  assert.equal(restored.get(saved.id).config.pages.detail.fields.title.selector,"h1");
  assert.equal(restored.get(saved.id).config.pages.detail.fields.chapterTitle.selector,".episode-name");assert.equal(restored.list()[0].pages.length,3);
  const invalid=structuredClone(group);delete invalid.pages.detail.fields.rows;assert.throws(()=>validatePreset(invalid),{status:400});
});

test("legacy catalogs migrate into the information page without conflating chapter title with novel title",()=>{
  const old={...config(),kind:"catalog",fields:{rows:{selector:".row",attribute:"text",multiple:true},title:{selector:"a",attribute:"text",multiple:false,relativeTo:"rows"}}};
  const group=groupPreset(old);assert.equal(group.pages.detail.fields.chapterTitle.relativeTo,"rows");assert.equal(group.pages.detail.fields.title,undefined);
  assert.throws(()=>validatePreset({...group,pages:{...group.pages,catalog:{pagePattern:"/",fields:{}}}}),{status:400});
});

test("relative fields require their repeated parent and preserve shadow locator chains",()=>{
  const c={...config(),kind:"listing",fields:{items:{selector:"a.card",attribute:"text",multiple:true},title:{selector:".title",attribute:"text",multiple:false,relativeTo:"items",shadowPath:[]}}};
  assert.equal(validatePreset(c).fields.title.relativeTo,"items");delete c.fields.items;assert.throws(()=>validatePreset(c),{status:400});
  const shadow=config();shadow.fields.title.shadowPath=[".host"];
  assert.deepEqual(validatePreset(shadow).fields.title.shadowPath,[".host"]);
});

test("presets survive restart, concurrent saves serialize and updates/deletion keep other records",async t=>{
  const f=await fixture(t);const [a,b]=await Promise.all([f.presets.save(config()),f.presets.save({...config(),name:"second"})]);
  assert.equal(f.presets.list().length,2);
  await f.presets.save({...config(),name:"edited"},a.id);
  const restored=await new ExtractionPresets({store:f.store}).load();assert.equal(restored.get(a.id).config.name,"edited");
  await restored.remove(a.id);assert.equal(restored.get(b.id).config.name,"second");assert.equal(restored.list().length,1);
});

test("failed atomic persistence never publishes a saved preset",async t=>{
  const f=await fixture(t);f.store.atomic=async()=>{throw Error("disk failure");};
  await assert.rejects(f.presets.save(config()));assert.equal(f.presets.list().length,0);
});

test("preset APIs require administrator auth and same-origin writes",async t=>{
  const {presets}=await fixture(t);const app=createApp({store:{},scheduler:{},adminPassword:"fixture-password",extractionPresets:presets});
  await new Promise(r=>app.listen(0,"127.0.0.1",r));t.after(()=>new Promise(r=>app.close(r)));
  const origin=`http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(origin+"/api/extraction-presets")).status,401);
  const login=await fetch(origin+"/api/login",{method:"POST",body:JSON.stringify({password:"fixture-password"})});
  const cookie=login.headers.get("set-cookie").split(";")[0];
  const write=src=>fetch(origin+"/api/extraction-presets",{method:"POST",headers:{cookie,origin:src,"content-type":"application/json"},body:JSON.stringify(config())});
  assert.equal((await write("https://foreign.test")).status,403);assert.equal(presets.list().length,0);
  const saved=await write(origin);assert.equal(saved.status,201);const record=await saved.json();
  assert.equal((await fetch(origin+`/api/extraction-presets/${record.id}`,{headers:{cookie}})).status,200);
});
