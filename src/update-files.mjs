import { mkdir,readFile,writeFile,rename,lstat,access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname,join,resolve,relative,isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

export const MANAGED_SOURCE=/^(?:LICENSE|README\.md|\.gitignore|run\.mjs|(?:install|start)\.(?:sh|ps1)|package(?:-lock)?\.json|requirements-captcha\.txt|src\/[^/]+\.mjs|public\/[^/]+\.(?:js|html|css)|tests\/[^/]+\.test\.mjs|tests\/captcha_position_test\.py|tests\/fixtures\/(?:captcha-reader\.html|work-detail-synthetic\.html|discovery-synthetic\.mjs)|tools\/(?:captcha_position\.py|evaluate_captcha\.py|check-publication\.mjs|update\.mjs|recover-update\.mjs|install-runtime\.mjs|startup-diagnostics\.mjs|reset-admin\.mjs)|docs\/(?:CAPTCHA|CONTRACT|TESTING|INSTALL|UPDATE|TROUBLESHOOTING|DASHBOARD|PRESETS)\.md|docs\/assets\/[^/]+\.svg|deploy\/novel-collector\.service)$/;
export function sourcePath(value){
  if(typeof value!=="string"||value.includes("\\")||/[\x00-\x1f:]/.test(value)||value.split("/").some(p=>!p||p==="."||p==="..")||!MANAGED_SOURCE.test(value))throw Error("사용자 데이터 또는 허용되지 않은 업데이트 경로입니다.");return value;
}
export async function safePath(root,path){
  const target=resolve(root,path),rel=relative(resolve(root),target);if(isAbsolute(rel)||rel.startsWith(".."))throw Error("설치 폴더 밖의 경로입니다.");
  let cursor=resolve(root);for(const part of rel.split(/[\\/]/)){cursor=join(cursor,part);try{if((await lstat(cursor)).isSymbolicLink())throw Error("업데이트 대상에 심볼릭 링크가 있습니다.");}catch(e){if(e.code!=="ENOENT")throw e;}}
  return target;
}
export async function readJson(path,fallback=null){try{const info=await lstat(path);if(info.isSymbolicLink()||info.size>1024*1024)throw Error("업데이트 기록 형식/크기를 확인하세요.");return JSON.parse(await readFile(path,"utf8"));}catch(e){if(e.code==="ENOENT")return fallback;throw e;}}
export async function atomicJson(path,value){await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=path+"."+randomUUID()+".tmp";await writeFile(temp,JSON.stringify(value),{mode:0o600});await renameRetry(temp,path);}
export async function renameRetry(from,to,{platform=process.platform,move=rename}={}){
  for(let i=0;;i++)try{return await move(from,to);}catch(e){if(platform!=="win32"||!["EPERM","EACCES","EBUSY"].includes(e.code)||i>=7)throw e;await new Promise(r=>setTimeout(r,10*2**i));}
}
export async function exists(path){try{await lstat(path);return true;}catch(e){if(e.code==="ENOENT")return false;throw e;}}
export async function assertWritable(root){await access(root,constants.W_OK);await safePath(root,".updates");}
