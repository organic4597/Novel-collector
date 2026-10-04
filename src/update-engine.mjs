import JSZip from "jszip";
import { mkdir,writeFile,readFile,readdir,rm,cp,lstat } from "node:fs/promises";
import { join,dirname,resolve,relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash,randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { sourcePath,safePath,atomicJson,readJson,renameRetry,exists,MANAGED_SOURCE } from "./update-files.mjs";
const exec=promisify(execFile);
const runtimePaths=new Set(["node_modules",".venv-captcha","profile/playwright-browsers"]);
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
export async function extractSource(bytes,destination){
  const zip=await JSZip.loadAsync(bytes),entries=Object.values(zip.files);if(entries.length>3000)throw Error("업데이트 파일이 너무 많습니다.");
  const paths=[],seen=new Set();let prefix=null;
  for(const entry of entries){
    const original=entry.unsafeOriginalName||entry.name;
    if(original.startsWith("/")||original.includes("\\")||original.split("/").some(p=>p===".."||p===".")||original.includes(":"))throw Error("ZIP 경로가 올바르지 않습니다.");
    const type=(Number(entry.unixPermissions)||0)&0o170000;if(type&&type!==0o100000&&type!==0o40000)throw Error("ZIP 링크/특수 파일은 설치하지 않습니다.");
    if(entry.dir)continue;
    const cut=entry.name.indexOf("/");if(cut<1)throw Error("릴리스의 단일 최상위 폴더가 필요합니다.");
    const top=entry.name.slice(0,cut);if(prefix&&prefix!==top)throw Error("릴리스 폴더가 혼합되어 있습니다.");prefix=top;
    const path=sourcePath(entry.name.slice(cut+1)),key=path.toLowerCase();if(seen.has(key))throw Error("중복 업데이트 경로입니다.");seen.add(key);paths.push({entry,path});
  }
  for(const required of ["run.mjs","package.json","package-lock.json","src/server.mjs","src/updates.mjs","tools/update.mjs"])if(!paths.some(p=>p.path===required))throw Error("자동 업데이트를 지원하는 전체 소스 ZIP이 필요합니다.");
  let total=0;const files={};await mkdir(destination,{recursive:true,mode:0o700});
  for(const {entry,path} of paths){
    const chunks=[];let size=0;for await(const chunk of new Readable().wrap(entry.nodeStream("nodebuffer"))){size+=chunk.length;total+=chunk.length;if(size>4*1024*1024||total>64*1024*1024)throw Error("압축 해제 크기를 초과했습니다.");chunks.push(chunk);}
    const contents=Buffer.concat(chunks),target=await safePath(destination,path);await mkdir(dirname(target),{recursive:true});await writeFile(target,contents,{flag:"wx",mode:path.endsWith(".sh")?0o755:0o644});files[path]=hash(contents);
  }
  const manifest=JSON.parse(await readFile(join(destination,"package.json"),"utf8"));if(manifest.name!=="novel-collector")throw Error("Novel Collector 패키지가 아닙니다.");return files;
}
export async function sourceManifest(root){
  const saved=await readJson(join(root,".updates","managed-source.json"));if(saved?.files){for(const p of Object.keys(saved.files))sourcePath(p);return saved;}
  const files={};
  async function walk(dir=""){
    for(const entry of await readdir(join(root,dir),{withFileTypes:true})){
      const path=dir?dir+"/"+entry.name:entry.name;
      if(entry.isDirectory()&&["src","public","tests","tools","docs","deploy","tests/fixtures","docs/assets"].includes(path))await walk(path);
      else if(entry.isFile()&&MANAGED_SOURCE.test(path))files[path]=hash(await readFile(join(root,path)));
    }
  }await walk();return{files,observed:true};
}
export async function assertUnmodified(root,manifest){
  if(await exists(join(root,".git"))){
    await exec("git",["diff","--cached","--quiet"],{cwd:root,timeout:15000}).catch(()=>{throw Error("스테이징한 로컬 변경이 있어 자동 업데이트를 중단했습니다.");});
    if(manifest.observed){const result=await exec("git",["status","--porcelain","--untracked-files=normal"],{cwd:root,timeout:15000});if(result.stdout.trim())throw Error("로컬 소스 변경이 있어 자동 업데이트를 중단했습니다.");}
  }
  for(const [path,digest] of Object.entries(manifest.files)){await safePath(root,sourcePath(path));if(await exists(join(root,path))&&hash(await readFile(join(root,path)))!==digest)throw Error("설치 소스의 로컬 변경을 보존하기 위해 중단했습니다.");}
}
export async function privateBackup(root,backup){
  for(const path of ["data","secrets","profile"]){
    const source=await safePath(root,path);if(!await exists(source))continue;
    await cp(source,join(backup,"private",path),{recursive:true,dereference:false,preserveTimestamps:true,filter:p=>{const rel=relative(source,p).replaceAll("\\","/");return path!=="profile"||!(rel==="playwright-browsers"||rel.startsWith("playwright-browsers/"));}});
  }
}
export async function restorePrivate(root,id){
  const backup=join(root,".updates","backups",id);if(!/^[0-9]+-[a-f0-9-]+$/.test(id))throw Error("복구 식별자 오류");
  for(const path of ["data","secrets","profile"]){
    const copy=await safePath(root,`.updates/backups/${id}/private/${path}`);if(!await exists(copy))continue;
    const target=await safePath(root,path),failed=join(backup,"failed-private",path);await mkdir(dirname(failed),{recursive:true,mode:0o700});
    if(await exists(target))await renameRetry(target,failed);
    await cp(copy,target,{recursive:true,dereference:false,preserveTimestamps:true});
    if(path==="profile"&&await exists(join(failed,"playwright-browsers")))await renameRetry(join(failed,"playwright-browsers"),join(target,"playwright-browsers"));
  }
}
function validOperation(path){if(runtimePaths.has(path))return path;return sourcePath(path);}
export async function rollback(root,journal,{move=renameRetry}={}){
  if(!/^[0-9]+-[a-f0-9-]+$/.test(journal.id))throw Error("복구 식별자가 올바르지 않습니다.");
  for(const item of [...journal.operations].reverse()){
    const path=validOperation(item.path),target=await safePath(root,path),backup=await safePath(root,`.updates/backups/${journal.id}/source/${path}`);
    if(await exists(backup)){
      if(await exists(target))await rm(target,{recursive:true,force:true});await mkdir(dirname(target),{recursive:true});await move(backup,target);
    }else if(!item.existed&&await exists(target)&&!await exists(join(root,".updates",journal.id,"source",path))){await rm(target,{recursive:true,force:true});}
  }
  for(const [name,value] of Object.entries(journal.previousMetadata||{})){
    if(!["installed-version.json","managed-source.json"].includes(name))throw Error("복구 메타데이터가 올바르지 않습니다.");
    const target=join(root,".updates",name);if(value===null)await rm(target,{force:true});else await atomicJson(target,value);
  }
  await rm(join(root,".updates","transaction.json"),{force:true});
}
export async function activate(root,{id,stage,files,runtimes=[],version},{move=renameRetry,onStep=()=>{}}={}){
  const previous=await sourceManifest(root);await assertUnmodified(root,previous);
  const removes=previous.observed?[]:Object.keys(previous.files).filter(p=>!Object.hasOwn(files,p));
  const operations=[];
  for(const path of [...new Set([...Object.keys(files),...removes,...runtimes])]){
    validOperation(path);const target=await safePath(root,path),existed=await exists(target);
    if(!runtimePaths.has(path)&&existed&&!Object.hasOwn(previous.files,path))throw Error("기존 사용자 파일과 새 소스 경로가 충돌합니다.");
    operations.push({path,existed,install:Object.hasOwn(files,path)||runtimes.includes(path)});
  }
  const journal={id,operations,previousMetadata:{"installed-version.json":await readJson(join(root,".updates","installed-version.json")),"managed-source.json":await readJson(join(root,".updates","managed-source.json"))}};
  await atomicJson(join(root,".updates","transaction.json"),journal);
  try{
    for(const item of operations){
      const target=await safePath(root,item.path),backup=await safePath(root,`.updates/backups/${id}/source/${item.path}`);
      if(item.existed){await mkdir(dirname(backup),{recursive:true,mode:0o700});await move(target,backup);}
      if(item.install){await mkdir(dirname(target),{recursive:true});await move(join(stage,item.path),target);}
      await onStep(item.path);
    }
    await atomicJson(join(root,".updates","installed-version.json"),{version});await atomicJson(join(root,".updates","managed-source.json"),{files});return journal;
  }catch(e){await rollback(root,journal);throw e;}
}
export function transactionId(){return Date.now()+"-"+randomUUID();}
