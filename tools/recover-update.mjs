// Standalone built-ins only: usable even if node_modules was interrupted mid-swap.
import { readFile,rename,rm,mkdir,lstat,writeFile,cp } from "node:fs/promises";
import { join,dirname,resolve } from "node:path";
import { pathToFileURL } from "node:url";
const allowed=/^(?:LICENSE|README\.md|\.gitignore|package(?:-lock)?\.json|requirements-captcha\.txt|run\.mjs|(?:install|start)\.(?:sh|ps1)|src\/[^/]+\.mjs|public\/[^/]+\.(?:js|html|css)|tests\/[^/]+\.(?:test\.mjs|py)|tests\/fixtures\/[^/]+\.(?:html|mjs)|tools\/[^/]+\.(?:mjs|py)|docs\/(?:[A-Z]+\.md|assets\/[^/]+\.svg)|deploy\/novel-collector\.service|node_modules|\.venv-captcha|profile\/playwright-browsers)$/;
async function present(path){try{return await lstat(path);}catch(e){if(e.code!=="ENOENT")throw e;return null;}}
async function safe(root,path){
  if(path.includes("\\")||path.includes(":")||path.split("/").some(p=>!p||p===".."||p==="."))throw Error("복구 경로 오류");
  let cur=root;for(const part of path.split("/")){cur=join(cur,part);if((await present(cur))?.isSymbolicLink())throw Error("복구 링크 경로 오류");}return cur;
}
export async function recover(root){
  root=resolve(root);const path=join(root,".updates","transaction.json");if(!await present(path))return;
  const journal=JSON.parse(await readFile(path,"utf8"));if(!/^[0-9]+-[a-f0-9-]+$/.test(journal.id)||!Array.isArray(journal.operations)||journal.operations.length>4000)throw Error("복구 기록 오류");
  for(const item of [...journal.operations].reverse()){
    if(!allowed.test(item.path))throw Error("복구 대상 오류");const target=await safe(root,item.path),backup=await safe(root,`.updates/backups/${journal.id}/source/${item.path}`);
    if(await present(backup)){await rm(target,{force:true,recursive:true});await mkdir(dirname(target),{recursive:true});await rename(backup,target);}
    else if(!item.existed&&await present(target)&&!await present(join(root,".updates",journal.id,"source",item.path)))await rm(target,{force:true,recursive:true});
  }
  for(const [name,value] of Object.entries(journal.previousMetadata||{})){
    if(!["installed-version.json","managed-source.json"].includes(name))throw Error("복구 기록 오류");
    const target=join(root,".updates",name);if(value===null)await rm(target,{force:true});else await writeFile(target,JSON.stringify(value),{mode:0o600});
  }
  if(await present(join(root,".updates","pending-verification.json"))){
    for(const name of ["data","secrets","profile"]){
      const snapshot=await safe(root,`.updates/backups/${journal.id}/private/${name}`);if(!await present(snapshot))continue;
      const target=await safe(root,name),failed=await safe(root,`.updates/backups/${journal.id}/recovery-private/${name}`);await mkdir(dirname(failed),{recursive:true,mode:0o700});
      if(await present(target))await rename(target,failed);await cp(snapshot,target,{recursive:true,dereference:false,preserveTimestamps:true});
      if(name==="profile"&&await present(join(failed,"playwright-browsers")))await rename(join(failed,"playwright-browsers"),join(target,"playwright-browsers"));
    }
    await rm(join(root,".updates","pending-verification.json"),{force:true});
  }
  await rm(path,{force:true});
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)recover(process.argv[2]).catch(()=>{process.exitCode=1;});
