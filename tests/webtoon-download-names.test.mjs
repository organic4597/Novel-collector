import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,mkdir,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import JSZip from "jszip";
import {FolderStore} from "../src/store.mjs";
import {LibraryDownloads} from "../src/library-downloads.mjs";
import {webtoonImageInfo} from "../src/webtoon-images.mjs";
import {createApp} from "../src/server.mjs";

const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","base64");
const hash=value=>createHash("sha256").update(value).digest("hex");
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),"webtoon-download-names-")),store=await new FolderStore(join(root,"data")).init();
  const downloads=new LibraryDownloads({store,rootDir:join(root,"downloads")});
  t.after(async()=>{await downloads.close();await rm(root,{recursive:true,force:true});});
  t.mock.timers.enable({apis:["Date"],now:new Date(2026,9,11,12).getTime()});
  return{store,downloads};
}
async function addBook(store,id,{title="합성 웹툰",numbers=[10,1,3],contentType="webtoon"}={}){
  await store.upsertBook(id,{title,contentType,storedChapterCount:numbers.length});
  for(const number of numbers){
    const chapterId="source-"+number,info=webtoonImageInfo(png),filename="0001-"+info.sha256.slice(0,16)+".png";
    const directory=store.path("books",id,"chapters",chapterId);await mkdir(directory,{recursive:true});await writeFile(join(directory,filename),png);
    const images=[{index:1,filename,...info}];
    await store.writeWebtoonChapter(id,chapterId,{number,title:number+"화",url:`https://sbxh9.com/${contentType}/${id}/${chapterId}`,contentType,complete:true,expectedImages:1,savedImages:1,images,hash:hash(JSON.stringify(images)),size:png.length});
  }
}
const downloadName=response=>decodeURIComponent(response.headers.get("content-disposition").split("filename*=UTF-8''")[1]);

test("webtoon ZIP names use the actual stored episode range without dates and keep padded CBZ numbers",async t=>{
  const {store,downloads}=await fixture(t);await addBook(store,"internal-book-id");
  const file=await downloads.bookZip("internal-book-id");assert.equal(file.filename,"합성 웹툰-1-10.zip");
  const zip=await JSZip.loadAsync(await readFile(file.path));
  assert.deepEqual(Object.keys(zip.files),["합성 웹툰 0001.cbz","합성 웹툰 0003.cbz","합성 웹툰 0010.cbz"]);
  const cbz=await JSZip.loadAsync(await zip.file("합성 웹툰 0001.cbz").async("nodebuffer"));
  assert.deepEqual(Object.keys(cbz.files),["0001.png"]);assert.deepEqual(await cbz.file("0001.png").async("nodebuffer"),png);
  assert.equal((await downloads.chapterCbz("internal-book-id","source-3")).filename,"합성 웹툰 0003.cbz");
  const saved=await store.readChapter("internal-book-id","source-3");assert.match(saved.images[0].filename,/^[0-9]{4}-[a-f0-9]{16}\.png$/);
  t.mock.timers.setTime(new Date(2026,9,12,12).getTime());
  assert.equal((await downloads.bookZip("internal-book-id")).filename,"합성 웹툰-1-10.zip");
  await addBook(store,"later-range",{numbers:[143,7]});
  assert.equal((await downloads.bookZip("later-range")).filename,"합성 웹툰-7-143.zip");
});
test("title changes update archive entry names and ETag without changing saved image identifiers",async t=>{
  const {store,downloads}=await fixture(t);await addBook(store,"book",{numbers:[1]});const first=await downloads.bookZip("book");
  await store.upsertBook("book",{title:"바뀐 제목"});const next=await downloads.bookZip("book");
  assert.notEqual(next.etag,first.etag);assert.equal(next.filename,"바뀐 제목-1-1.zip");
  assert.deepEqual(Object.keys((await JSZip.loadAsync(await readFile(next.path))).files),["바뀐 제목 0001.cbz"]);
  const chapter=await store.readChapter("book","source-1");await store.writeWebtoonChapter("book","source-1",{...chapter,number:2});
  const renumbered=await downloads.bookZip("book");assert.notEqual(renumbered.etag,next.etag);assert.equal(renumbered.filename,"바뀐 제목-2-2.zip");
  assert.deepEqual(Object.keys((await JSZip.loadAsync(await readFile(renumbered.path))).files),["바뀐 제목 0002.cbz"]);
});
test("duplicate saved episode numbers fail explicitly instead of overwriting a CBZ entry",async t=>{
  const {store,downloads}=await fixture(t);await addBook(store,"book",{numbers:[1]});
  const chapter=await store.readChapter("book","source-1"),directory=store.path("books","book","chapters","other-source");
  await mkdir(directory,{recursive:true});await writeFile(join(directory,chapter.images[0].filename),png);
  await store.writeWebtoonChapter("book","other-source",{...chapter,id:"other-source",url:"https://sbxh9.com/webtoon/book/other-source"});
  await assert.rejects(downloads.bookZip("book"),{code:"ARCHIVE_NAME_CONFLICT"});
});
test("same-title image books stay distinct in selected bundles using readable collision suffixes",async t=>{
  const {store,downloads}=await fixture(t);
  for(const [id,number,contentType]of [["one",1,"webtoon"],["two",1,"manhwa"],["three",2,"webtoon"]])await addBook(store,id,{title:"../동명/작품\r\n",numbers:[number],contentType});
  const requested=await downloads.requestBundle(["one","two","three"]);await downloads.running;
  assert.equal((await downloads.getBundle(requested.id)).status,"ready");
  const zip=await JSZip.loadAsync(await readFile((await downloads.bundleFile(requested.id)).path)),names=Object.keys(zip.files);
  assert.equal(names.length,3);assert.ok(!names.some(name=>/[\/\\\r\n]/.test(name)||name.startsWith(".")));
  assert.equal(names[1],names[0].replace(/\.zip$/," (2).zip"));
  assert.equal(names[2],names[0].replace(/-1-1\.zip$/,"-2-2.zip"));
  for(const [index,name]of names.entries()){
    const bookZip=await JSZip.loadAsync(await zip.file(name).async("nodebuffer"));
    assert.match(Object.keys(bookZip.files)[0],new RegExp("000"+(index===2?2:1)+"\\.cbz$"));
  }
});
test("authenticated ZIP and CBZ responses advertise clean UTF-8 download filenames",async t=>{
  const {store,downloads}=await fixture(t);await addBook(store,"private-book-id",{numbers:[1]});
  const app=createApp({store,scheduler:{},downloads,adminPassword:"fixture-password"});await new Promise(resolve=>app.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));});
  const base="http://127.0.0.1:"+app.address().port;
  assert.equal((await fetch(base+"/api/books/private-book-id/export/zip")).status,401);
  const login=await fetch(base+"/api/login",{method:"POST",body:JSON.stringify({password:"fixture-password"})}),cookie=login.headers.get("set-cookie").split(";")[0];
  for(const [path,name]of [["export/zip","합성 웹툰-1-1.zip"],["chapters/source-1/cbz","합성 웹툰 0001.cbz"]]){
    const response=await fetch(base+"/api/books/private-book-id/"+path,{headers:{cookie}});
    assert.equal(response.status,200);assert.equal(downloadName(response),name);assert.ok((await response.arrayBuffer()).byteLength>0);
  }
});
