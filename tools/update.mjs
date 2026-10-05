import { spawn,execFile } from "node:child_process";
import { open,mkdir,rm,cp,realpath } from "node:fs/promises";
import { join,resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { latestRelease,releaseZip } from "../src/update-network.mjs";
import { APP_VERSION,compareVersions,repositoryName } from "../src/version.mjs";
import { atomicJson,readJson,exists,safePath,assertUpdatePermissions } from "../src/update-files.mjs";
import { extractSource,sourceManifest,assertUnmodified,activate,rollback,privateBackup,restorePrivate,transactionId,validateStagedRuntime } from "../src/update-engine.mjs";
import { updateLog,updateEvent,redactDiagnostic } from "../src/activity-log.mjs";
import { npmCliPath } from "../run.mjs";

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
export async function command(args,cwd,env,{log,step="PREPARE"}={}){
  const tail=[];let lines=0;
  await new Promise((yes,no)=>{
    const child=spawn(process.execPath,args,{cwd,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    const emit=(line,level)=>{const text=redactDiagnostic(line.trim());if(!text)return;tail.push(text);if(tail.length>8)tail.shift();if(lines++<200&&log)updateEvent(log,step,text,{level,component:"command"});};
    for(const [stream,level] of [[child.stdout,"info"],[child.stderr,"warn"]]){let carry="";stream.setEncoding("utf8");stream.on("data",chunk=>{carry+=chunk;const chunks=carry.split(/\r?\n/);carry=chunks.pop();for(const line of chunks)emit(line,level);if(carry.length>8192){emit(carry,level);carry="";}});stream.on("end",()=>{if(carry)emit(carry,level);});}
    const timer=setTimeout(()=>{child.kill();no(Object.assign(Error("환경 준비 시간 초과"),{code:"COMMAND_TIMEOUT",step}));},20*60*1000);
    child.once("error",e=>{clearTimeout(timer);no(Object.assign(Error("준비 명령을 시작하지 못했습니다."),{code:e.code||"COMMAND_START_FAILED",step}));});
    child.once("close",code=>{clearTimeout(timer);if(code===0)yes();else no(Object.assign(Error(tail.at(-1)||"환경 준비 명령 실패"),{code:"COMMAND_FAILED",exitCode:code,step}));});
  });
}
async function parentExit(pid){for(let i=0;i<450;i++){try{process.kill(pid,0);}catch{return;}await new Promise(r=>setTimeout(r,200));}throw Error("기존 수집기 종료를 기다리는 중 시간 초과했습니다.");}
function launch(root,env,log){
  const preload=join(root,".updates","startup-diagnostics.mjs"),args=log?["--import",pathToFileURL(preload).href]:[];
  const child=spawn(process.execPath,[...args,join(root,"run.mjs"),"--no-setup"],{cwd:root,env:{...env,UPDATER_DIAGNOSTICS_ROOT:root},detached:true,windowsHide:true,stdio:"ignore"});
  child.on("error",e=>{if(log)updateEvent(log,"START_SERVER","새 서버 프로세스를 시작하지 못했습니다.",{level:"error",errorCode:e.code});});
  child.on("exit",code=>{if(log&&code!==0)updateEvent(log,"START_SERVER","새 서버 프로세스 종료",{level:"error",exitCode:code});});child.unref();return child;
}
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
  await safePath(root,".updates");await mkdir(base,{recursive:true,mode:0o700});const log=await updateLog(root);let step="LOCK";
  const report=async(state,message,details={})=>{updateEvent(log,step,message,{targetVersion:version,...details,level:state==="failed"?"error":"info"});await atomicJson(join(base,"job.json"),{state,message,version,step,...details});};
  let locked=false;
  try{
    const lock=await open(join(base,"lock.json"),"wx",0o600);await lock.writeFile(JSON.stringify({pid:process.pid,id,startedAt:Date.now()}));await lock.close();locked=true;
    updateEvent(log,step,"업데이트 시작",{targetVersion:version});
    if(offline){const server=await readJson(join(base,"server.json"));if(server?.pid){let alive=false;try{process.kill(server.pid,0);alive=true;}catch{}if(alive)throw Error("실행 중인 프로그램은 먼저 종료하세요.");}}
    const installed=await readJson(join(base,"installed-version.json")),current=installed?.version||APP_VERSION;if(compareVersions(version,current)<=0)throw Error("새 버전이 아닙니다.");
    step="CHECK_SOURCE";await report("preparing","설치 버전과 로컬 소스 변경 검사");await assertUnmodified(root,await sourceManifest(root));
    step="CHECK_PERMISSIONS";await report("preparing","백업 읽기와 소스·런타임 교체 권한 검사");await assertUpdatePermissions(root);
    step="CHECK_RELEASE";await report("preparing","GitHub 릴리스 확인");
    const {release}=await (hooks.latest||latestRelease)(repository);if(!release||release.version!==version)throw Error("릴리스가 변경됐습니다.");
    step="DOWNLOAD";await report("preparing","릴리스 ZIP 다운로드와 SHA256 확인");const archive=await(hooks.download||releaseZip)(release);
    step="EXTRACT";await report("preparing","업데이트 소스 압축 해제");const files=await extractSource(archive,stage),runtime=stageEnvironment(root,stage);
    step="SETUP_NPM";await report("preparing","준비 폴더에 독립 npm 패키지 설치");await command([npmCliPath({env:runtime.env}),"ci","--omit=dev","--no-audit","--no-fund"],stage,runtime.env,{log,step});
    step="SETUP_RUNTIME";await report("preparing","npm·Python/OpenCV·Chromium 준비");await command([join(stage,"run.mjs"),"--setup"],stage,runtime.env,{log,step});
    step="CHECK_RUNTIME";await report("preparing","새 실행 환경 점검");await command([join(stage,"run.mjs"),"--check"],stage,runtime.env,{log,step});
    step="CHECK_SERVER";await report("preparing","서버 모듈 점검");await command(["--input-type=module","-e","import(process.argv[1])",pathToFileURL(join(stage,"src","server.mjs")).href],stage,runtime.env,{log,step});
    step="CHECK_STAGED_RUNTIME";await report("preparing","소스와 모든 런타임 교체 원본 존재 확인");await validateStagedRuntime(stage,{files,runtimes:runtime.runtimes});
    await cp(join(root,"tools","recover-update.mjs"),join(base,"recover.mjs"));
    await cp(new URL("./startup-diagnostics.mjs",import.meta.url),join(base,"startup-diagnostics.mjs"));
    await atomicJson(join(base,"managed-source.json"),await sourceManifest(root));
    step="WAIT_STOP";await report("ready","준비 완료 · 기존 프로그램 정상 종료 대기");
    if(!offline){
      if(!process.send)throw Error("실행 중인 수집기는 대시보드에서 업데이트하세요.");
      await new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error("종료 연결 시간 초과")),120000);process.on("message",message=>{if(message?.type==="stopped"){clearTimeout(timer);yes();}else if(message?.type==="cancel"){clearTimeout(timer);no(Error("수집기 종료 실패"));}});process.send({type:"ready"});});
      await parentExit(parent);
    }stopped=true;
    step="BACKUP";await report("applying","개인정보 로컬 백업");await privateBackup(root,join(base,"backups",id));
    step="ACTIVATE";await report("applying","프로그램 소스·런타임 교체");
    journal=await activate(root,{id,stage,files,runtimes:runtime.runtimes,version});
    const restartEnv={...process.env};if(runtime.runtimes.includes(".venv-captcha"))delete restartEnv.CAPTCHA_PYTHON;if(runtime.runtimes.includes("profile/playwright-browsers"))delete restartEnv.BROWSER_PATH;
    step="CHECK_INSTALLED_RUNTIME";await report("applying","교체 후 실제 설치 경로의 실행 환경 점검");await command([join(root,"run.mjs"),"--check"],root,restartEnv,{log,step});
    step="VERIFY";await atomicJson(join(base,"pending-verification.json"),{version,pid:process.pid});await report("verifying","새 버전 시작 확인");await rm(join(base,"lock.json"),{force:true});
    if(!offline){if(!process.env.INVOCATION_ID)newProcess=launch(root,restartEnv,log);if(!await healthy(restartEnv,version))throw Error("새 버전 시작 후 로컬 서버에 연결하지 못했습니다. START_SERVER 상세 로그를 확인하세요.");}
    step="COMPLETED";await rm(join(base,"pending-verification.json"),{force:true});await rm(join(base,"transaction.json"),{force:true});await report("completed","업데이트 완료 · 사용자 저장소 유지");
  }catch(e){
    const failedStep=step,errorCode=/^[A-Z0-9_]{1,60}$/.test(e.code||"")?e.code:"UPDATE_FAILED",reason=redactDiagnostic(e.message);
    updateEvent(log,failedStep,reason,{level:"error",errorCode,exitCode:e.exitCode});
    if(!locked&&e.code==="EEXIST")throw e;
    if(journal){
      step="ROLLBACK";await report("applying","이전 프로그램·개인정보 보존본 복구");
      await atomicJson(join(base,"lock.json"),{pid:process.pid,id,startedAt:Date.now()});
      if(newProcess){newProcess.kill("SIGTERM");await parentExit(newProcess.pid);}
      if(process.env.INVOCATION_ID)await stopService(root);
      await rollback(root,journal);await restorePrivate(root,id);await rm(join(base,"pending-verification.json"),{force:true});
    }
    step=failedStep;await report("failed",`업데이트 실패 [${failedStep}/${errorCode}]: ${reason}`,{errorCode,exitCode:e.exitCode});
    if(locked)await rm(join(base,"lock.json"),{force:true});if(stopped&&!offline&&!process.env.INVOCATION_ID)launch(root,process.env);
    throw e;
  }finally{if(locked&&(!journal||offline))await rm(join(base,"lock.json"),{force:true});await log.close();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const args=process.argv.slice(2),get=key=>args[args.indexOf(key)+1];
  update({root:get("--root"),repository:get("--repository"),version:get("--version"),offline:args.includes("--offline")}).catch(()=>{process.exitCode=1;});
}
