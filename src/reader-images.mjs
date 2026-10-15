import { createHash } from "node:crypto";
import { readFile, writeFile, open, mkdir, mkdtemp, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { safeId } from "./store.mjs";
import { safePath, renameRetry } from "./update-files.mjs";
import { webtoonImageInfo } from "./webtoon-images.mjs";
import { isImageType } from "./webtoon-source.mjs";
import { renderViewerImage } from "./reader-image-processor.mjs";

export const READER_PROFILE="v1-w1280-h2048-q90";
const hashPattern=/^[a-f0-9]{64}$/;
const filenamePattern=/^\d{4}-[a-f0-9]{16}\.(png|jpg|gif|webp)$/;
const fail=(message,status=503)=>Object.assign(new Error(message),{status,code:"READER_IMAGE_ERROR"});
const fingerprint=info=>({size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs});
const same=(a,b)=>a?.size===b?.size&&a?.mtimeMs===b?.mtimeMs&&a?.ctimeMs===b?.ctimeMs;

function geometry(image){
  const width=Math.min(1280,image.width),height=Math.max(1,Math.round(image.height*width/image.width));
  const parts=Array.from({length:Math.ceil(height/2048)},(_,index)=>({width,height:Math.min(2048,height-index*2048)}));
  return{width,height,parts};
}
function validImage(image){
  return image&&hashPattern.test(image.sha256)&&filenamePattern.test(image.filename)&&
    Number.isSafeInteger(image.width)&&image.width>0&&Number.isSafeInteger(image.height)&&image.height>0&&
    Number.isSafeInteger(image.bytes)&&image.bytes>0&&image.bytes<=8*1024**2;
}
function candidate(image){
  return ["image/jpeg","image/png","image/webp"].includes(image.mimeType)&&
    (image.width>1280||image.height>4096)&&image.width*image.height<=100000000&&
    Math.ceil(Math.round(image.height*Math.min(1,1280/image.width))/2048)<=128;
}
function supportedHeader(bytes,mime){
  if(mime==="image/webp")return bytes.length>=30&&bytes.toString("ascii",0,4)==="RIFF"&&bytes.toString("ascii",8,12)==="WEBP"&&
    (bytes.toString("ascii",12,16)!=="VP8X"||!(bytes[20]&0x2a));
  if(mime==="image/png"){
    if(bytes.length<33||bytes[24]!==8)return false;
    for(let at=8;at+8<=bytes.length;){
      const length=bytes.readUInt32BE(at),type=bytes.toString("ascii",at+4,at+8);
      if(["acTL","iCCP","cICP","eXIf"].includes(type))return false;
      if(type==="IDAT")return true;
      if(length>bytes.length-at-12)return false;
      at+=length+12;
    }
    return false;
  }
  if(mime==="image/jpeg"){
    if(bytes[0]!==255||bytes[1]!==216)return false;
    for(let at=2;at+4<=bytes.length;){
      if(bytes[at]!==255)return false;
      const marker=bytes[at+1];if(marker===0xda)return true;
      if([0xe1,0xe2].includes(marker))return false;
      if(marker===0xff){at++;continue;}
      const length=bytes.readUInt16BE(at+2);if(length<2||length>bytes.length-at-2)return false;at+=length+2;
    }
  }
  return false;
}

export class ReaderImages {
  constructor({store,render=renderViewerImage,timeoutMs=20000}){
    Object.assign(this,{store,render,timeoutMs});
    this.pending=new Map();this.headers=new Map();this.tail=Promise.resolve();this.closed=false;
  }
  async source(bookId,chapter,image){
    const relative=join("books",safeId(bookId),"chapters",safeId(chapter.id),image.filename);
    const path=await safePath(this.store.rootDir,relative);
    let info;try{info=await lstat(path);}catch(error){if(error.code==="ENOENT")throw fail("저장된 이미지를 찾을 수 없습니다.",404);throw error;}
    if(!info.isFile()||info.isSymbolicLink()||info.size!==image.bytes)throw fail("저장된 이미지 정보가 변경되었습니다.",409);
    return{path,info:fingerprint(info)};
  }
  async eligible(bookId,chapter,image){
    if(!candidate(image))return false;
    const source=await this.source(bookId,chapter,image),key=source.path;
    const cached=this.headers.get(key);if(cached&&same(cached.info,source.info))return cached.eligible;
    const file=await open(source.path,"r");let bytes;
    try{const buffer=Buffer.alloc(Math.min(65536,source.info.size));const {bytesRead}=await file.read(buffer,0,buffer.length,0);bytes=buffer.subarray(0,bytesRead);}finally{await file.close();}
    const eligible=supportedHeader(bytes,image.mimeType);
    this.headers.set(key,{info:source.info,eligible});if(this.headers.size>256)this.headers.delete(this.headers.keys().next().value);
    return eligible;
  }
  async manifest(bookId,chapter){
    safeId(bookId);safeId(chapter.id);
    if(!chapter.complete||!isImageType(chapter.contentType)||!Array.isArray(chapter.images)||chapter.images.length>1000)
      throw fail("저장 완료된 이미지 회차가 아닙니다.",409);
    const prefix=`/api/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapter.id)}`;
    const images=[];let total=0;
    for(const [index,image]of chapter.images.entries()){
      if(!validImage(image))throw fail("저장된 이미지 정보를 확인할 수 없습니다.",409);
      const originalUrl=`${prefix}/images/${index+1}?v=${image.sha256}`;
      let transform=false;try{transform=await this.eligible(bookId,chapter,image);}catch(error){if(![404,409].includes(error.status))throw error;}
      const g=transform?geometry(image):null;
      const parts=g&&total+g.parts.length<=2000?g.parts.map((part,i)=>({...part,url:`${prefix}/viewer/${image.sha256}/${READER_PROFILE}/${i+1}.webp`})):
        [{url:originalUrl,width:image.width,height:image.height}];
      total+=parts.length;images.push({index:index+1,originalUrl,parts});
    }
    return{revision:chapter.hash,profile:READER_PROFILE,images};
  }
  async current(bookId,chapter,image){
    const book=await this.store.getBook(bookId),latest=await this.store.readChapter(bookId,chapter.id);
    if(!book||!latest)throw fail("작품 또는 회차가 삭제되었습니다.",404);
    if(!isImageType(book.contentType)||!latest.complete||!latest.images?.some(row=>row.sha256===image.sha256&&row.filename===image.filename&&row.width===image.width&&row.height===image.height))
      throw fail("이미지가 변경되었습니다. 회차를 다시 열어주세요.",409);
  }
  async cached(directory,source,image,g,partNumber){
    const metaPath=await safePath(this.store.rootDir,join(directory,"manifest.json"));
    let data;try{const info=await lstat(metaPath);if(!info.isFile()||info.size>256*1024)return null;data=JSON.parse(await readFile(metaPath,"utf8"));}
    catch(error){if(error.code==="ENOENT"||error instanceof SyntaxError)return null;throw error;}
    if(data.profile!==READER_PROFILE||data.sourceSha!==image.sha256||!same(data.source,source.info)||!Array.isArray(data.parts)||data.parts.length!==g.parts.length)return null;
    if(data.parts.some((part,index)=>part.filename!==`${index+1}.webp`||part.width!==g.parts[index].width||part.height!==g.parts[index].height||!hashPattern.test(part.sha256)||!Number.isSafeInteger(part.bytes)||part.bytes<1||part.bytes>8*1024**2))return null;
    const part=data.parts[partNumber-1],path=await safePath(this.store.rootDir,join(directory,part.filename));
    try{const info=await lstat(path);if(!info.isFile()||info.size!==part.bytes||(info.mtimeMs!==part.mtimeMs||info.ctimeMs!==part.ctimeMs))return null;}
    catch(error){if(error.code==="ENOENT")return null;throw error;}
    return{path,mimeType:"image/webp",etag:`"${part.sha256}"`,size:part.bytes};
  }
  async file(bookId,chapter,sourceSha,profile,partNumber){
    if(this.closed)throw fail("이미지 준비가 종료되었습니다.");
    safeId(bookId);safeId(chapter.id);
    if(profile!==READER_PROFILE||!hashPattern.test(sourceSha)||!Number.isSafeInteger(partNumber)||partNumber<1)throw fail("잘못된 이미지 주소입니다.",400);
    const image=chapter.complete&&chapter.images?.find(row=>row.sha256===sourceSha);
    if(!validImage(image))throw fail("이미지가 변경되었습니다. 회차를 다시 열어주세요.",409);
    if(!candidate(image)||!await this.eligible(bookId,chapter,image))throw fail("보기용 이미지를 사용할 수 없습니다.",404);
    const g=geometry(image);if(partNumber>g.parts.length)throw fail("보기용 이미지를 사용할 수 없습니다.",404);
    await this.current(bookId,chapter,image);
    const source=await this.source(bookId,chapter,image),directory=join("books",bookId,"chapters",chapter.id,".viewer",READER_PROFILE,sourceSha);
    const hit=await this.cached(directory,source,image,g,partNumber);if(hit)return hit;
    const key=directory;let pending=this.pending.get(key);
    if(!pending){
      if(this.pending.size>=9)throw fail("이미지 준비가 밀려 있습니다. 원본으로 다시 시도하세요.");
      const controller=new AbortController();let timer;
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail("이미지 준비 시간이 초과됐습니다."));},this.timeoutMs);controller.signal.addEventListener("abort",()=>reject(fail("이미지 준비가 취소됐습니다.")),{once:true});});
      const work=this.tail.catch(()=>{}).then(()=>this.build(bookId,chapter,image,source,g,directory,controller.signal));
      this.tail=work.catch(()=>{});
      const promise=Promise.race([work,timeout]).finally(()=>{clearTimeout(timer);if(this.pending.get(key)?.promise===promise)this.pending.delete(key);});
      pending={promise,controller};this.pending.set(key,pending);
    }
    await pending.promise;
    await this.current(bookId,chapter,image);
    const latestSource=await this.source(bookId,chapter,image),file=await this.cached(directory,latestSource,image,g,partNumber);
    if(!file)throw fail("보기용 이미지 확인에 실패했습니다.");return file;
  }
  async build(bookId,chapter,image,source,g,directory,signal){
    signal.throwIfAborted();await this.current(bookId,chapter,image);
    const original=webtoonImageInfo(await readFile(source.path));
    if(original.sha256!==image.sha256||original.width!==image.width||original.height!==image.height||original.bytes!==image.bytes)throw fail("원본 이미지가 변경되었습니다.",409);
    const parent=join("books",bookId,"chapters",chapter.id),folders=[join(parent,".viewer"),join(parent,".viewer",READER_PROFILE)];
    for(const relative of folders){const path=await safePath(this.store.rootDir,relative);try{await mkdir(path,{mode:0o700});}catch(error){if(error.code!=="EEXIST")throw error;}await safePath(this.store.rootDir,relative);}
    const profile=await safePath(this.store.rootDir,folders[1]),temporary=await mkdtemp(join(profile,".tmp-"));
    try{
      const parts=await this.render({source:source.path,directory:temporary,image,geometry:g},{signal});signal.throwIfAborted();
      if(!Array.isArray(parts)||parts.length!==g.parts.length)throw fail("보기용 이미지 개수가 맞지 않습니다.");
      const checked=[];let total=0;
      for(const [index,part]of parts.entries()){
        if(part.filename!==`${index+1}.webp`)throw fail("잘못된 보기용 이미지 파일입니다.");
        const path=await safePath(temporary,part.filename),bytes=await readFile(path),info=webtoonImageInfo(bytes),stat=await lstat(path);
        if(info.mimeType!=="image/webp"||info.width!==g.parts[index].width||info.height!==g.parts[index].height||info.sha256!==part.sha256||info.bytes!==part.bytes)throw fail("보기용 이미지 결과가 맞지 않습니다.");
        total+=info.bytes;if(total>32*1024**2)throw fail("보기용 이미지 크기 상한을 초과했습니다.");
        checked.push({...part,width:info.width,height:info.height,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs});
      }
      signal.throwIfAborted();await this.current(bookId,chapter,image);
      const latest=await this.source(bookId,chapter,image);if(!same(latest.info,source.info))throw fail("원본 이미지가 준비 중 변경되었습니다.",409);
      await writeFile(join(temporary,"manifest.json"),JSON.stringify({profile:READER_PROFILE,sourceSha:image.sha256,source:source.info,parts:checked}),{mode:0o600,flag:"wx"});
      const target=await safePath(this.store.rootDir,directory);await rm(target,{recursive:true,force:true});signal.throwIfAborted();await renameRetry(temporary,target);
    }finally{await rm(temporary,{recursive:true,force:true});}
  }
  close(){this.closed=true;for(const task of this.pending.values())task.controller.abort();}
}
