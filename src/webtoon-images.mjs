import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, rename, rm, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import JSZip from "jszip";
import { validateRunnablePreset, matchesPresetPage, evaluatePresetPage } from "./preset-runtime.mjs";
import { isImageType } from "./webtoon-source.mjs";

export const WEBTOON_LIMITS=Object.freeze({imageBytes:8*1024**2,chapterBytes:512*1024**2,images:1000});
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
const fail=(message,code="WEBTOON_IMAGE_ERROR")=>Object.assign(Error(message),{code});
const extensions={"image/png":"png","image/jpeg":"jpg","image/gif":"gif","image/webp":"webp"};
async function imageBody(response,signal,timeout){
  let timer,onAbort;
  try{return await Promise.race([response.body(),new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(fail("웹툰 이미지 응답 시간이 초과됐습니다.","IMAGE_RESPONSE_TIMEOUT")),timeout);
    onAbort=()=>reject(signal.reason||Object.assign(Error("작업 중단"),{name:"AbortError"}));
    signal?.addEventListener("abort",onAbort,{once:true});if(signal?.aborted)onAbort();
  })]);}finally{clearTimeout(timer);signal?.removeEventListener("abort",onAbort);}
}
export function webtoonImageInfo(bytes) {
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>WEBTOON_LIMITS.imageBytes)throw fail("웹툰 이미지가 8 MiB 상한을 초과하거나 비어 있습니다.","IMAGE_SIZE_LIMIT");
  let mimeType,width,height;
  if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){mimeType="image/png";width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);}
  else if(bytes.length>=10&&/^GIF8[79]a$/.test(bytes.subarray(0,6).toString())){mimeType="image/gif";width=bytes.readUInt16LE(6);height=bytes.readUInt16LE(8);}
  else if(bytes.length>=30&&bytes.subarray(0,4).toString()==="RIFF"&&bytes.subarray(8,12).toString()==="WEBP"){
    mimeType="image/webp";const kind=bytes.subarray(12,16).toString();
    if(kind==="VP8X"){width=bytes.readUIntLE(24,3)+1;height=bytes.readUIntLE(27,3)+1;}
    else if(kind==="VP8L"&&bytes[20]===0x2f){const bits=bytes.readUInt32LE(21);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;}
    else if(kind==="VP8 "&&bytes.subarray(23,26).equals(Buffer.from([0x9d,1,0x2a]))){width=bytes.readUInt16LE(26)&0x3fff;height=bytes.readUInt16LE(28)&0x3fff;}
  }else if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff){
    mimeType="image/jpeg";
    for(let i=2;i+8<bytes.length;){if(bytes[i]!==0xff){i++;continue;}const marker=bytes[i+1];if(marker===0xda||marker===0xd9)break;
      if(marker===0xd8||marker===1||(marker>=0xd0&&marker<=0xd7)){i+=2;continue;}
      const size=bytes.readUInt16BE(i+2);if(size<2||i+size+2>bytes.length)break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){height=bytes.readUInt16BE(i+5);width=bytes.readUInt16BE(i+7);break;}i+=size+2;}
  }
  if(!mimeType||!width||!height)throw fail("웹툰 이미지의 실제 형식·크기를 확인하지 못했습니다.","IMAGE_SIGNATURE_INVALID");
  return{mimeType,width,height,bytes:bytes.length,sha256:digest(bytes)};
}
export function webtoonImageState({reader,index=null,scroll=false},doc=document){
  const resolve=(scope,locator)=>{for(const key of locator.shadowPath||[]){const host=scope.querySelector(key);scope=host?.shadowRoot||(host?.__novelShadow?.host===host?host.__novelShadow:null);if(!scope)return[];}return [...scope.querySelectorAll(locator.selector)];};
  const roots=resolve(doc,reader.fields.root);if(roots.length!==1)return{count:0,rootCount:roots.length};
  const images=resolve(roots[0],reader.fields.images),image=index==null?null:images[index];
  if(scroll&&image)image.scrollIntoView({block:"center"});
  let url="";try{url=image?new URL(image.currentSrc||image.getAttribute("data-src")||image.getAttribute("src"),doc.URL).href:"";}catch{}
  return{count:images.length,rootCount:roots.length,url,ready:!!image?.complete&&image.naturalWidth>0};
}
export async function extractWebtoonImages(page,job,chapter,signal,onProgress=()=>{}){
  const config=validateRunnablePreset(job.presetSnapshot),bookId=job.bookId;
  if(!matchesPresetPage(config,"reader",chapter.url))throw fail("웹툰 회차 주소가 프리셋의 본문 경로와 다릅니다.","PRESET_PATH_MISMATCH");
  const directory=this.store.path("books",bookId,"chapters",chapter.id),partialPath=directory+"/partial.json";
  const scratch=directory+"/responses-"+randomUUID();await mkdir(scratch,{recursive:true,mode:0o700});
  const old=await this.store.json(partialPath);
  const captures=new Map(),pending=new Set();let activeIndex=0;
  const received=response=>{
    if(response.request().resourceType()!=="image")return;
    const task=(async()=>{try{
      const problem=await this.responseProblem(response);if(problem)throw problem;
      if(Number(await response.headerValue("content-length"))>WEBTOON_LIMITS.imageBytes)throw fail("웹툰 이미지 크기 상한을 초과했습니다.","IMAGE_SIZE_LIMIT");
      const bytes=await imageBody(response,signal,this.contentTimeoutMs),info=webtoonImageInfo(bytes),path=scratch+"/"+randomUUID();
      signal?.throwIfAborted();
      await writeFile(path,bytes,{mode:0o600,flag:"wx"});return{...info,path};
    }catch(error){return{error};}})();
    for(let request=response.request();request;request=request.redirectedFrom?.())captures.set(request.url(),task);
    pending.add(task);task.finally(()=>pending.delete(task));
  };
  page.on("response",received);
  try{
    if(old&&old.presetHash!==job.presetHash&&!job.overwrite)throw fail("저장 중인 웹툰 회차와 프리셋이 다릅니다.","CHECKPOINT_CONFLICT");
    await this.webtoonNavigate(page,chapter.url,signal);
    const deadline=Date.now()+this.contentTimeoutMs;
    let state=await page.evaluate(webtoonImageState,{reader:config.pages.reader});
    while(!state.count&&Date.now()<deadline){signal?.throwIfAborted();await page.waitForTimeout(150);state=await page.evaluate(webtoonImageState,{reader:config.pages.reader});}
    if(state.rootCount!==1||!state.count)throw fail("웹툰 본문 루트·이미지를 찾지 못했습니다.","IMAGE_ROOT_MISSING");
    if(state.count>WEBTOON_LIMITS.images)throw fail("웹툰 회차 이미지가 1,000장 상한을 초과했습니다.","IMAGE_COUNT_LIMIT");
    if(old&&!job.overwrite&&old.expectedImages!==state.count)throw fail("웹툰 이미지 목록이 저장 중인 회차와 다릅니다.","CHECKPOINT_CONFLICT");
    if(!old)await this.store.atomic(partialPath,{version:1,presetHash:job.presetHash,expectedImages:state.count,savedImages:0,complete:false,images:[]});
    const images=[],observed=[];let totalBytes=0;
    for(let index=0;index<state.count;index++){
      activeIndex=index+1;
      signal?.throwIfAborted();let item=await page.evaluate(webtoonImageState,{reader:config.pages.reader,index,scroll:true});
      const until=Date.now()+this.contentTimeoutMs;
      while((!item.ready||!captures.has(item.url))&&Date.now()<until){signal?.throwIfAborted();await page.waitForTimeout(100);item=await page.evaluate(webtoonImageState,{reader:config.pages.reader,index});
        if(captures.has(item.url)&&(await captures.get(item.url)).error)break;}
      if(!captures.has(item.url))throw fail("브라우저의 웹툰 원본 이미지 응답을 확인하지 못했습니다.","IMAGE_RESPONSE_MISSING");
      const captured=await captures.get(item.url);if(captured.error)throw captured.error;
      observed.push(item.url);
      if(!item.ready||item.count!==state.count)throw fail("웹툰 이미지 목록이 수집 중 변경됐습니다.","CHECKPOINT_CONFLICT");
      const previous=old?.images?.[index];if(previous&&!job.overwrite&&previous.sha256!==captured.sha256)throw fail("저장 중인 웹툰 이미지 내용이 변경됐습니다.","CHECKPOINT_CONFLICT");
      totalBytes+=captured.bytes;if(totalBytes>WEBTOON_LIMITS.chapterBytes)throw fail("웹툰 회차가 512 MiB 상한을 초과했습니다.","CHAPTER_SIZE_LIMIT");
      const filename=`${String(index+1).padStart(4,"0")}-${captured.sha256.slice(0,16)}.${extensions[captured.mimeType]}`;
      const target=directory+"/"+filename;
      const bytes=await readFile(captured.path);signal?.throwIfAborted();await writeFile(target,bytes,{mode:0o600});
      const {path:ignore,...info}=captured;images.push({index:index+1,filename,...info});
      const checkpoint=[...images,...(!job.overwrite?old?.images?.slice(images.length)||[]:[])];
      await this.store.atomic(partialPath,{version:1,presetHash:job.presetHash,expectedImages:state.count,savedImages:checkpoint.length,complete:false,images:checkpoint});
      await onProgress({expectedImages:state.count,savedImages:images.length,imageBytes:totalBytes});
    }
    const final=await page.evaluate(webtoonImageState,{reader:config.pages.reader});if(final.count!==images.length)throw fail("웹툰 이미지 목록이 변경됐습니다.","CHECKPOINT_CONFLICT");
    const finalImages=(await page.evaluate(evaluatePresetPage,config.pages.reader)).images;
    if(JSON.stringify(finalImages.map(image=>image.url))!==JSON.stringify(observed))throw fail("웹툰 이미지 순서가 수집 중 변경됐습니다.","CHECKPOINT_CONFLICT");
    return{contentType:job.contentType,version:1,presetHash:job.presetHash,expectedImages:images.length,savedImages:images.length,complete:true,images,
      hash:digest(JSON.stringify(images)),size:totalBytes};
  }catch(error){
    if(!signal?.aborted&&error.code!=="CHECKPOINT_CONFLICT"){
      const partial=await this.store.json(partialPath);
      if(partial)await this.store.atomic(partialPath,{...partial,failedImages:[{index:activeIndex||null,code:error.code||"IMAGE_ERROR"}]});
    }throw error;
  }finally{page.off("response",received);await Promise.allSettled([...pending]);await rm(scratch,{recursive:true,force:true});}
}
export async function verifyWebtoonChapter(store,bookId,chapter){
  if(!chapter?.complete||!isImageType(chapter.contentType)||!Array.isArray(chapter.images)||!chapter.images.length||
    chapter.images.length!==chapter.expectedImages||chapter.images.length>WEBTOON_LIMITS.images||chapter.hash!==digest(JSON.stringify(chapter.images)))return false;
  let total=0;
  for(const [index,image]of chapter.images.entries()){
    if(image.index!==index+1||!/^\d{4}-[a-f0-9]{16}\.(png|jpg|gif|webp)$/.test(image.filename)||!extensions[image.mimeType])return false;
    let bytes;try{bytes=await readFile(store.path("books",bookId,"chapters",chapter.id,image.filename));}catch(error){if(error.code==="ENOENT")return false;throw error;}
    const info=webtoonImageInfo(bytes);if(info.sha256!==image.sha256||info.bytes!==image.bytes||info.width!==image.width||info.height!==image.height||info.mimeType!==image.mimeType)return false;
    total+=bytes.length;if(total>WEBTOON_LIMITS.chapterBytes)return false;
  }
  return total===chapter.size;
}
async function writeZip(zip,path,signal){
  await mkdir(path.slice(0,path.lastIndexOf("/")),{recursive:true,mode:0o700});const temporary=path+"."+randomUUID()+".tmp";
  try{await pipeline(zip.generateNodeStream({streamFiles:true,compression:"STORE"}),createWriteStream(temporary,{mode:0o600,flags:"wx"}),{signal});await rename(temporary,path);}
  catch(error){await rm(temporary,{force:true});throw error;}
}
export async function webtoonCbz(store,rootDir,bookId,chapter,signal){
  if(!await verifyWebtoonChapter(store,bookId,chapter))throw fail("완전히 저장되고 해시 검증된 웹툰 회차만 내려받을 수 있습니다.","CHAPTER_INCOMPLETE");
  const path=`${rootDir}/webtoon/${bookId}/${chapter.id}-${chapter.hash}.cbz`,zip=new JSZip();
  for(const image of chapter.images)zip.file(`${String(image.index).padStart(4,"0")}.${extensions[image.mimeType]}`,
    createReadStream(store.path("books",bookId,"chapters",chapter.id,image.filename)),{binary:true});
  await writeZip(zip,path,signal);
  return{path,mimeType:"application/vnd.comicbook+zip",filename:`${String(chapter.number).padStart(4,"0")}_${chapter.id}.cbz`,etag:`"${chapter.hash}"`};
}
export async function webtoonZip(store,rootDir,bookId,signal,maxBytes=3*1024**3){
  const book=await store.getBook(bookId),chapters=await store.listChapters(bookId);
  if(!book||!isImageType(book.contentType)||!chapters.length)throw fail("저장된 이미지 회차가 없습니다.","NO_STORED_IMAGES");
  const zip=new JSZip();let size=0;
  for(const meta of chapters){signal?.throwIfAborted();const chapter=await store.readChapter(bookId,meta.id);if(chapter?.hash!==meta.hash)throw fail("웹툰 회차가 다운로드 준비 중 변경됐습니다.","CHECKPOINT_CONFLICT");const file=await webtoonCbz(store,rootDir,bookId,chapter,signal);
    size+=(await stat(file.path)).size+512;if(size>maxBytes)throw fail("웹툰 작품 ZIP이 3 GB 상한을 초과했습니다.","ARCHIVE_SIZE_LIMIT");
    zip.file(file.filename,createReadStream(file.path),{binary:true});}
  const revision=digest(JSON.stringify(chapters.map(c=>[c.id,c.hash]))),path=`${rootDir}/webtoon/${bookId}/${revision}.zip`;
  await writeZip(zip,path,signal);
  return{path,filename:`${String(book.title||"웹툰").replace(/[<>:"/\\|?*\x00-\x1f]/g,"_").slice(0,100)}_[${bookId}].zip`,mimeType:"application/zip",etag:`"${revision}"`};
}
