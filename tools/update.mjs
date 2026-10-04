import { spawn,execFile } from "node:child_process";
import { open,mkdir,rm,cp,realpath } from "node:fs/promises";
import { join,resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { latestRelease,releaseZip } from "../src/update-network.mjs";
import { APP_VERSION,compareVersions,repositoryName } from "../src/version.mjs";
import { atomicJson,readJson,exists,safePath } from "../src/update-files.mjs";
import { extractSource,sourceManifest,assertUnmodified,activate,rollback,privateBackup,restorePrivate,transactionId } from "../src/update-engine.mjs";

export function stageEnvironment(root,stage,env=process.env){
  const result={...env},runtimes=["node_modules"];
  const python=join(root,".venv-captcha");if(!env.CAPTCHA_PYTHON||resolve(env.CAPTCHA_PYTHON).startsWith(python+"/" )||resolve(env.CAPTCHA_PYTHON).startsWith(python+"\\")){delete result.CAPTCHA_PYTHON;runtimes.push(".venv-captcha");}
  const browsers=join(root,"profile","playwright-browsers");
  if(!env.BROWSER_PATH||resolve(env.BROWSER_PATH).startsWith(browsers+"/")||resolve(env.BROWSER_PATH).startsWith(browsers+"\\")){
    if(env.PROFILE_DIR&&resolve(env.PROFILE_DIR).startsWith(browsers))throw Error("브라우저 캐시와 사용자 프로필 경로를 분리하세요.");
    delete result.BROWSER_PATH;result.PLAYWRIGHT_BROWSERS_PATH=join(stage,"profile","playwright-browsers");runtimes.push("profile/playwright-browsers");
  }
  result.PROFILE_DIR=join(stage,"profile","chromium");result.XDG_CONFIG_HOME=join(stage,"profile","config");result.XDG_CACHE_HOME=join(stage,"profile","cache");
  return{env:result,runtimes};
}
async function command(args,cwd,env){
  await new Promise((yes,no)=>{const child=spawn(process.execPath,args,{cwd,env,windowsHide:true,stdio:"ignore"});const timer=setTimeout(()=>{child.kill();no(Error("환경 준비 시간 초과"));},20*60*1000);
    child.once("error",()=>{clearTimeout(timer);no(Error("환경 준비 실패"));});child.once("exit",code=>{clearTimeout(timer);code===0?yes():no(Error("환경 준비 실패"));});});
}
async function parentExit(pid){for(let i=0;i<450;i++){try{process.kill(pid,0);}catch{return;}await new Promise(r=>setTimeout(r,200));}throw Error("기존 수집기 종료를 기다리는 중 시간 초과했습니다.");}
function launch(root,env){const child=spawn(process.execPath,[join(root,"run.mjs"),"--no-setup"],{cwd:root,env,detached:true,windowsHide:true,stdio:"ignore"});child.unref();return child;}
async function stopService(root){
  const name=process.env.UPDATE_SERVICE_NAME;if(!/^[A-Za-z0-9@_.-]+\.service$/.test(name||""))throw Error("서비스 이름을 확인하세요.");
  const pid=await new Promise((yes,no)=>execFile("systemctl",["show",name,"--property=MainPID","--value"],{timeout:10000},(e,out)=>e?no(e):yes(Number(out.trim()))));
  if(Number.isSafeInteger(pid)&&pid>0){if(await realpath(`/proc/${pid}/cwd`)!==await realpath(root))throw Error("다른 서비스는 종료하지 않습니다.");process.kill(pid,"SIGTERM");await parentExit(pid);}
}
async function healthy(env,version){
  const host=["0.0.0.0","::"].includes(env.HOST)?"127.0.0.1":env.HOST||"127.0.0.1",port=env.PORT||8788;
  for(let i=0;i<60;i++){try{const r=await fetch(`http://${host.includes(":")?"["+host+"]":host}:${port}/api/health`,{signal:AbortSignal.timeout(1000)});if(r.ok&&(await r.json()).version===version)return true;}catch{}await new Promise(r=>setTimeout(r,1000));}return false;
}
export async function update({root,repository,version,offline=false,hooks={}}={}){
  root=resolve(root);repository=repositoryName(repository);const parent=process.ppid,id=transactionId(),base=join(root,".updates"),stage=join(base,id,"source");let journal=null,stopped=false,newProcess=null;
  await safePath(root,".updates");await mkdir(base,{recursive:true,mode:0o700});const lock=await open(join(base,"lock.json"),"wx",0o600);await lock.writeFile(JSON.stringify({pid:process.pid,id,startedAt:Date.now()}));await lock.close();
  const report=(state,message)=>atomicJson(join(base,"job.json"),{state,message,version});
  try{
    if(offline){const server=await readJson(join(base,"server.json"));if(server?.pid){let alive=false;try{process.kill(server.pid,0);alive=true;}catch{}if(alive)throw Error("실행 중인 프로그램은 먼저 종료하세요.");}}
    const installed=await readJson(join(base,"installed-version.json")),current=installed?.version||APP_VERSION;if(compareVersions(version,current)<=0)throw Error("새 버전이 아닙니다.");
    await assertUnmodified(root,await sourceManifest(root));await report("preparing","릴리스 ZIP 무결성과 새 환경을 준비하는 중");
    const {release}=await (hooks.latest||latestRelease)(repository);if(!release||release.version!==version)throw Error("릴리스가 변경됐습니다.");
    const files=await extractSource(await (hooks.download||releaseZip)(release),stage),runtime=stageEnvironment(root,stage);
    await command([join(stage,"run.mjs"),"--setup"],stage,runtime.env);await command([join(stage,"run.mjs"),"--check"],stage,runtime.env);
    await command(["--input-type=module","-e","import(process.argv[1])",pathToFileURL(join(stage,"src","server.mjs")).href],stage,runtime.env);
    await cp(join(root,"tools","recover-update.mjs"),join(base,"recover.mjs"));
    await atomicJson(join(base,"managed-source.json"),await sourceManifest(root));
    await report("ready","준비 완료 · 기존 수집기의 정상 종료를 기다리는 중");
    if(!offline){
      if(!process.send)throw Error("실행 중인 수집기는 대시보드에서 업데이트하세요.");
      await new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error("종료 연결 시간 초과")),120000);process.on("message",message=>{if(message?.type==="stopped"){clearTimeout(timer);yes();}else if(message?.type==="cancel"){clearTimeout(timer);no(Error("수집기 종료 실패"));}});process.send({type:"ready"});});
      await parentExit(parent);
    }stopped=true;
    await report("applying","개인정보 로컬 백업과 프로그램 파일 교체 중");await privateBackup(root,join(base,"backups",id));
    journal=await activate(root,{id,stage,files,runtimes:runtime.runtimes,version});
    const restartEnv={...process.env};if(runtime.runtimes.includes(".venv-captcha"))delete restartEnv.CAPTCHA_PYTHON;if(runtime.runtimes.includes("profile/playwright-browsers"))delete restartEnv.BROWSER_PATH;
    await atomicJson(join(base,"pending-verification.json"),{version,pid:process.pid});await report("verifying","새 버전으로 다시 시작하는 중");await rm(join(base,"lock.json"),{force:true});
    if(!offline){if(!process.env.INVOCATION_ID)newProcess=launch(root,restartEnv);if(!await healthy(restartEnv,version))throw Error("새 버전 시작 확인에 실패했습니다.");}
    await rm(join(base,"pending-verification.json"),{force:true});await rm(join(base,"transaction.json"),{force:true});await report("completed","업데이트 완료 · 사용자 저장소 유지");
  }catch(e){
    if(journal){
      await atomicJson(join(base,"lock.json"),{pid:process.pid,id,startedAt:Date.now()});
      if(newProcess){newProcess.kill("SIGTERM");await parentExit(newProcess.pid);}
      if(process.env.INVOCATION_ID)await stopService(root);
      await rollback(root,journal);await restorePrivate(root,id);await rm(join(base,"pending-verification.json"),{force:true});
    }
    await report("failed","업데이트 실패 · 기존 프로그램/사용자 정보 보존. 설치 권한·로컬 소스 변경·새 버전 환경을 확인하세요.");
    await rm(join(base,"lock.json"),{force:true});if(stopped&&!offline&&!process.env.INVOCATION_ID)launch(root,process.env);
    throw e;
  }finally{if(!journal||offline)await rm(join(base,"lock.json"),{force:true});}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const args=process.argv.slice(2),get=key=>args[args.indexOf(key)+1];
  update({root:get("--root"),repository:get("--repository"),version:get("--version"),offline:args.includes("--offline")}).catch(()=>{process.exitCode=1;});
}
