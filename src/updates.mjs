import { fork } from "node:child_process";
import { join } from "node:path";
import { APP_VERSION, UPDATE_REPOSITORY, compareVersions, repositoryName,versionParts } from "./version.mjs";
import { latestRelease } from "./update-network.mjs";
import { atomicJson,readJson,assertWritable,safePath,exists } from "./update-files.mjs";

export const DAY=86400000;
const fail=(message,status=409)=>Object.assign(new Error(message),{status});
export class Updates {
  constructor({rootDir,repository=process.env.UPDATE_REPOSITORY||UPDATE_REPOSITORY,clock=()=>Date.now(),fetcher=fetch,launch=null}={}){
    Object.assign(this,{rootDir,clock,fetcher,launch});this.repository=repositoryName(repository);this.currentVersion=APP_VERSION;this.cached={checkedAt:0,release:null,etag:null,error:null};this.pending=null;this.child=null;this.timer=null;this.stopped=false;this.onReady=null;
  }
  async load(){
    try{await safePath(this.rootDir,".updates");}catch{this.disabled="업데이트 저장 폴더의 링크/권한을 확인하세요.";return this;}
    try{const installed=await readJson(join(this.rootDir,".updates","installed-version.json"));if(installed){versionParts(installed.version);this.currentVersion=installed.version;}}catch{this.disabled="설치 버전 기록이 올바르지 않아 자동 업데이트를 중단했습니다.";}
    try{const cached=await readJson(join(this.rootDir,".updates","release-cache.json"));if(cached?.repository===this.repository&&Number.isFinite(cached.checkedAt)){if(cached.release)versionParts(cached.release.version);this.cached=cached;}}catch{this.cached.error="이전 릴리스 확인 기록을 다시 확인합니다.";}
    return this;
  }
  async status(){
    let job={state:"idle"};if(!this.disabled)try{job=await readJson(join(this.rootDir,".updates","job.json"),job);}catch{job={state:"failed",message:"업데이트 진행 기록을 확인하세요."};}
    if(job.state==="verifying"&&job.version===this.currentVersion&&!await exists(join(this.rootDir,".updates","pending-verification.json")))job={...job,state:"completed",message:"업데이트 완료 · 사용자 저장소 유지"};
    const available=!!this.cached.release&&compareVersions(this.cached.release.version,this.currentVersion)>0;
    return{currentVersion:this.currentVersion,latestVersion:this.cached.release?.version||null,repository:this.repository,releaseUrl:this.cached.release?.url||`https://github.com/${this.repository}/releases`,
      available,installable:!this.disabled&&available&&!!this.cached.release.download,checkedAt:this.cached.checkedAt||null,nextCheckAt:this.cached.checkedAt?this.cached.checkedAt+DAY:null,error:this.disabled||this.cached.error,
      job:{state:job.state,message:job.message||"",version:job.version||null,step:job.step||null,errorCode:job.errorCode||null,exitCode:job.exitCode??null},busy:!!this.child||["preparing","ready","applying","verifying"].includes(job.state)};
  }
  check({force=false}={}){
    if(this.disabled)return this.status();
    if(this.pending)return this.pending;
    const age=this.clock()-this.cached.checkedAt;if(this.cached.checkedAt&&age<(force?300000:DAY))return this.status();
    this.pending=(async()=>{
      try{const result=await latestRelease(this.repository,{etag:this.cached.etag,fetcher:this.fetcher});this.cached={...this.cached,repository:this.repository,checkedAt:this.clock(),release:result.release||this.cached.release,etag:result.etag,error:null};}
      catch{this.cached={...this.cached,repository:this.repository,checkedAt:this.clock(),error:"GitHub 릴리스 확인에 실패했습니다. 기존 버전은 계속 사용할 수 있습니다."};}
      await atomicJson(join(this.rootDir,".updates","release-cache.json"),this.cached);return this.status();
    })().finally(()=>{this.pending=null;});return this.pending;
  }
  start(){const run=async()=>{if(this.stopped)return;try{await this.check();}catch{}if(!this.stopped){this.timer=setTimeout(run,Math.max(60000,this.cached.checkedAt+DAY-this.clock()));this.timer.unref?.();}};void run();}
  async apply(version){
    if(this.child)throw fail("업데이트가 이미 진행 중입니다.");
    await this.check();const status=await this.status();if(status.busy)throw fail("이전 업데이트 상태를 먼저 확인하세요.");
    if(!status.installable||version!==this.cached.release?.version)throw fail("업데이트 가능한 최신 버전을 다시 확인하세요.");
    if(!this.onReady)throw fail("업데이트 재시작 연결을 사용할 수 없습니다.",503);
    if(process.env.INVOCATION_ID&&(process.env.UPDATE_WORKER_SURVIVES_SERVICE!=="1"||!process.env.UPDATE_SERVICE_NAME))throw fail("서비스 업데이트용 KillMode/쓰기 경로/서비스 이름 설정을 먼저 적용하세요.",503);
    try{await assertWritable(this.rootDir);}catch{throw fail("설치 폴더의 쓰기 권한이 없어 자동 업데이트할 수 없습니다.",503);}
    // Acquire the worker lock synchronously before yielding to another POST.
    if(this.child)throw fail("업데이트가 이미 진행 중입니다.");this.child={pending:true};
    try{
      await atomicJson(join(this.rootDir,".updates","job.json"),{state:"preparing",message:"새 버전 다운로드와 환경 준비 중",version});
      const child=this.launch?this.launch(this.cached.release):fork(join(this.rootDir,"tools","update.mjs"),["--root",this.rootDir,"--repository",this.repository,"--version",version],{detached:true,windowsHide:true,stdio:["ignore","ignore","ignore","ipc"],env:process.env});
      this.child=child;child.unref?.();child.on?.("message",message=>{if(message?.type==="ready")void this.onReady().then(()=>child.send?.({type:"stopped"})).catch(()=>{child.send?.({type:"cancel"});});});
      child.on?.("error",()=>{this.child=null;void atomicJson(join(this.rootDir,".updates","job.json"),{state:"failed",message:"업데이트 실행기를 시작하지 못했습니다.",version});});
      child.on?.("exit",code=>{this.child=null;if(code!==0)void readJson(join(this.rootDir,".updates","job.json")).then(job=>{if(job?.state!=="failed")return atomicJson(join(this.rootDir,".updates","job.json"),{state:"failed",message:"업데이트 실행기가 종료됐습니다. 상세 로그를 확인하세요.",version,errorCode:"WORKER_EXIT",exitCode:code});}).catch(()=>{});});
      return{accepted:true,version};
    }catch{this.child=null;await atomicJson(join(this.rootDir,".updates","job.json"),{state:"failed",message:"업데이트 실행을 준비하지 못했습니다.",version});throw fail("업데이트 실행을 준비하지 못했습니다.",503);}
  }
  close(){this.stopped=true;clearTimeout(this.timer);}
}
