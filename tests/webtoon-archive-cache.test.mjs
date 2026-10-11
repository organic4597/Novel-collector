import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,mkdir,readFile,writeFile,stat,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import JSZip from "jszip";
import {FolderStore} from "../src/store.mjs";
import {LibraryDownloads} from "../src/library-downloads.mjs";
import {webtoonImageInfo} from "../src/webtoon-images.mjs";
import {createApp} from "../src/server.mjs";

const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","base64");
const gif=Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7","base64");
const hash=value=>createHash("sha256").update(value).digest("hex");
async function saveImage(store,number,bytes=png,metadataOverride={}){
  const id="chapter-"+number,info=webtoonImageInfo(bytes),extension=info.mimeType==="image/png"?"png":"gif",filename=`0001-${info.sha256.slice(0,16)}.${extension}`;
  const directory=store.path("books","book","chapters",id);await mkdir(directory,{recursive:true});await writeFile(join(directory,filename),bytes);
  const images=[{index:1,filename,...info,...metadataOverride}];
  await store.writeWebtoonChapter("book",id,{number,title:number+"화",url:`https://sbxh9.com/webtoon/book/${id}`,contentType:"webtoon",complete:true,expectedImages:1,savedImages:1,images,hash:hash(JSON.stringify(images)),size:bytes.length});
  return store.readChapter("book",id);
}
async function fixture(t,numbers=[1,2]){
  const root=await mkdtemp(join(tmpdir(),"webtoon-archive-cache-")),store=await new FolderStore(join(root,"data")).init(),rootDir=join(root,"downloads");
  await store.upsertBook("book",{title:"합성 웹툰",contentType:"webtoon",storedChapterCount:0});
  for(const number of numbers)await saveImage(store,number);
  const downloads=new LibraryDownloads({store,rootDir});t.after(async()=>{await downloads.close();await rm(root,{recursive:true,force:true});});
  return{root,rootDir,store,downloads};
}
test("completed image records are packaged without repeating image byte hash validation",async t=>{
  const f=await fixture(t,[1]);await saveImage(f.store,1,png,{sha256:"0".repeat(64)});
  const file=await f.downloads.chapterCbz("book","chapter-1"),zip=await JSZip.loadAsync(await readFile(file.path));
  assert.deepEqual(await zip.file("0001.png").async("nodebuffer"),png);
});
test("prepared CBZ survives reopen and downloads without reading the original images again",async t=>{
  const f=await fixture(t,[1]),chapter=await f.store.readChapter("book","chapter-1"),first=await f.downloads.chapterCbz("book",chapter.id),before=await stat(first.path);
  await rm(f.store.path("books","book","chapters",chapter.id,chapter.images[0].filename));
  const reopened=new LibraryDownloads({store:f.store,rootDir:f.rootDir});t.after(()=>reopened.close());
  const next=await reopened.chapterCbz("book",chapter.id);assert.equal(next.path,first.path);assert.equal((await stat(next.path)).mtimeMs,before.mtimeMs);
  assert.deepEqual(await(await JSZip.loadAsync(await readFile(next.path))).file("0001.png").async("nodebuffer"),png);
});
test("legacy prepared CBZ is reused without copying or requiring original images",async t=>{
  const f=await fixture(t,[1]),chapter=await f.store.readChapter("book","chapter-1"),directory=join(f.rootDir,"webtoon","book");
  await mkdir(directory,{recursive:true});const legacy=join(directory,`${chapter.id}-${chapter.hash}.cbz`),zip=new JSZip();zip.file("0001.png",png);
  await writeFile(legacy,await zip.generateAsync({type:"nodebuffer",compression:"STORE"}));
  await rm(f.store.path("books","book","chapters",chapter.id,chapter.images[0].filename));
  assert.equal((await f.downloads.chapterCbz("book",chapter.id)).path,legacy);
});
test("missing and empty caches rebuild once, while cached ZIP still obeys the size limit",async t=>{
  const f=await fixture(t,[1]),chapter=await f.store.readChapter("book","chapter-1"),file=await f.downloads.chapterCbz("book",chapter.id);
  await writeFile(file.path,"");assert.ok((await stat((await f.downloads.chapterCbz("book",chapter.id)).path)).size>0);
  const first=await f.downloads.bookZip("book");await rm(first.path);assert.equal((await f.downloads.bookZip("book")).filename,"합성 웹툰-1-1.zip");
  f.downloads.maxArchiveBytes=16;await assert.rejects(f.downloads.bookZip("book"),{code:"ARCHIVE_SIZE_LIMIT"});
});
test("same-book concurrent ZIP requests build once and a ready ZIP is reused across reopen without chapter reads",async t=>{
  const f=await fixture(t);let generated=0;const generate=JSZip.prototype.generateNodeStream;
  t.mock.method(JSZip.prototype,"generateNodeStream",function(...args){generated++;return generate.apply(this,args);});
  const files=await Promise.all([f.downloads.bookZip("book"),f.downloads.bookZip("book"),f.downloads.bookZip("book")]);
  assert.equal(generated,3);assert.ok(files.every(file=>file.path===files[0].path));
  const before=await stat(files[0].path),reopened=new LibraryDownloads({store:f.store,rootDir:f.rootDir});t.after(()=>reopened.close());
  t.mock.method(f.store,"readChapter",async()=>{throw Error("ready ZIP must not reopen chapter manifests");});
  const cached=await reopened.bookZip("book");assert.equal(generated,3);assert.equal(cached.path,files[0].path);assert.equal((await stat(cached.path)).mtimeMs,before.mtimeMs);
});
test("new image content rebuilds only its CBZ and the ZIP while preserving range filenames",async t=>{
  const f=await fixture(t);await f.downloads.bookZip("book");let generated=0;const generate=JSZip.prototype.generateNodeStream;
  t.mock.method(JSZip.prototype,"generateNodeStream",function(...args){generated++;return generate.apply(this,args);});
  await saveImage(f.store,2,gif);const file=await f.downloads.bookZip("book");assert.equal(generated,2);assert.equal(file.filename,"합성 웹툰-1-2.zip");
  const zip=await JSZip.loadAsync(await readFile(file.path)),cbz=await JSZip.loadAsync(await zip.file("합성 웹툰 0002.cbz").async("nodebuffer"));
  assert.deepEqual(await cbz.file("0001.gif").async("nodebuffer"),gif);
});
test("same-book preparation returns one job immediately and ready file points at the cached ZIP",async t=>{
  const f=await fixture(t);let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});const original=f.downloads.bookZip.bind(f.downloads);let calls=0;
  t.mock.method(f.downloads,"bookZip",async(...args)=>{calls++;entered();await gate;return original(...args);});
  const first=await f.downloads.requestBookZip("book");await started;const second=await f.downloads.requestBookZip("book");
  assert.equal(first.id,second.id);assert.equal(first.status,"preparing");assert.equal(first.kind,"book-zip");
  release();await f.downloads.running;const state=await f.downloads.getBundle(first.id);assert.equal(state.status,"ready");assert.equal(state.total,2);assert.equal(state.processed,2);assert.equal(calls,1);
  const file=await f.downloads.bundleFile(first.id);assert.equal(file.filename,"합성 웹툰-1-2.zip");assert.match(file.path,/webtoon\/book\/.*\.zip$/);
  const reopened=new LibraryDownloads({store:f.store,rootDir:f.rootDir});t.after(()=>reopened.close());assert.equal((await reopened.bundleFile(first.id)).path,file.path);
});
test("book ZIP prepare API is authenticated, same-origin and provides a direct ready archive",async t=>{
  const f=await fixture(t,[1]),app=createApp({store:f.store,scheduler:{},downloads:f.downloads,adminPassword:"fixture-password"});
  await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));t.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));});
  const base="http://127.0.0.1:"+app.address().port,path=base+"/api/books/book/export/zip",body="{}";
  assert.equal((await fetch(path,{method:"POST",body})).status,401);
  const login=await fetch(base+"/api/login",{method:"POST",body:JSON.stringify({password:"fixture-password"})}),cookie=login.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(path,{method:"POST",body,headers:{cookie,origin:"https://other.example"}})).status,403);
  assert.equal((await fetch(path,{method:"POST",body:'{"path":"../private"}',headers:{cookie,origin:base}})).status,400);
  const accepted=await fetch(path,{method:"POST",body,headers:{cookie,origin:base}});assert.equal(accepted.status,202);const state=await accepted.json();await f.downloads.running;
  const response=await fetch(base+"/api/downloads/"+state.id+"/file",{headers:{cookie}});assert.equal(response.status,200);
  const zip=await JSZip.loadAsync(await response.arrayBuffer());assert.deepEqual(Object.keys(zip.files),["합성 웹툰 0001.cbz"]);
});
