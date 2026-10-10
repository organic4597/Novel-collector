import { fork } from "node:child_process";
import { join } from "node:path";
import { APP_VERSION, UPDATE_REPOSITORY, compareVersions, repositoryName,versionParts } from "./version.mjs";
import { latestRelease } from "./update-network.mjs";
import { channelCandidates,installedIdentity,updateChannel,validateUpdateTarget } from "./update-channels.mjs";
import { atomicJson,readJson,assertUpdatePermissions,safePath,exists } from "./update-files.mjs";
import { redactDiagnostic } from "./activity-log.mjs";
import { releaseHistory } from "./release-history.mjs";

export const DAY=86400000;
const fail=(message,status=409)=>Object.assign(new Error(message),{status});
export class Updates {
  constructor({rootDir,repository=process.env.UPDATE_REPOSITORY||UPDATE_REPOSITORY,clock=()=>Date.now(),fetcher=fetch,launch=null}={}){
    Object.assign(this,{rootDir,clock,fetcher,launch});this.repository=repositoryName(repository);this.currentVersion=APP_VERSION;this.installed=installedIdentity();this.caches={stable:{checkedAt:0,release:null,etag:null,error:null},develop:{checkedAt:0,candidates:[],error:null},hotfix:{checkedAt:0,candidates:[],error:null}};this.pending={};this.child=null;this.timer=null;this.stopped=false;this.onReady=null;
  }
  get cached(){return this.caches.stable;}
  set cached(value){this.caches.stable=value;}
  async load(){
    try{await safePath(this.rootDir,".updates");}catch{this.disabled="업데이트 저장 폴더의 링크/권한을 확인하세요.";return this;}
    try{this.installed=installedIdentity(await readJson(join(this.rootDir,".updates","installed-version.json")));this.currentVersion=this.installed.version;}catch{this.disabled="설치 버전 기록이 올바르지 않아 자동 업데이트를 중단했습니다.";}
    try{const cached=await readJson(join(this.rootDir,".updates","release-cache.json"));if(cached?.repository===this.repository&&Number.isFinite(cached.checkedAt)){if(cached.release)versionParts(cached.release.version);this.cached=cached;}}catch{this.cached.error="이전 릴리스 확인 기록을 다시 확인합니다.";}
    return this;
  }
  async status({channel='stable'}={}){
    updateChannel(channel);const cached=this.caches[channel];
    let job={state:"idle"};if(!this.disabled)try{job=await readJson(join(this.rootDir,".updates","job.json"),job);}catch{job={state:"failed",message:"업데이트 진행 기록을 확인하세요."};}
    if(job.state==="verifying"&&job.version===this.currentVersion&&(job.channel||'stable')===this.installed.channel&&(job.commit??null)===this.installed.commit&&!await exists(join(this.rootDir,".updates","pending-verification.json")))job={...job,state:"completed",message:"업데이트 완료 · 사용자 저장소 유지"};
    const raw=channel==='stable'?(cached.release?[{...cached.release,id:`stable:${cached.release.version}:`,channel,commit:null,baseVersion:cached.release.version,summary:'',publishedAt:null}]:[]):cached.candidates;
    const candidates=raw.filter(candidate=>{
      if(channel==='stable'){const comparison=compareVersions(candidate.version,this.installed.channel==='stable'?this.currentVersion:this.installed.baseVersion);return comparison>0||comparison===0&&this.installed.channel!=='stable';}
      return candidate.channel!==this.installed.channel||candidate.commit!==this.installed.commit;
    }).map(({download,...candidate})=>candidate);
    const target=candidates[0]||null,available=!!target;
    return{channel,installed:{...this.installed},candidates,target,currentVersion:this.currentVersion,latestVersion:target?.version||cached.release?.version||null,repository:this.repository,releaseUrl:target?.url||cached.release?.url||`https://github.com/${this.repository}/releases`,
      available,installable:!this.disabled&&available&&!!raw.find(c=>c.id===target.id)?.download,checkedAt:cached.checkedAt||null,nextCheckAt:cached.checkedAt?cached.checkedAt+DAY:null,error:this.disabled||cached.error,
      job:{state:job.state,message:job.message||"",version:job.version||null,channel:job.channel||'stable',commit:job.commit??null,step:job.step||null,errorCode:job.errorCode||null,exitCode:job.exitCode??null},busy:!!this.child||["preparing","ready","applying","verifying"].includes(job.state)};
  }
  check({force=false,channel='stable'}={}){
    updateChannel(channel);const cached=this.caches[channel];
    if(this.disabled)return this.status({channel});
    if(this.pending[channel])return this.pending[channel];
    const age=this.clock()-cached.checkedAt;if(cached.checkedAt&&age<(force?300000:DAY))return this.status({channel});
    this.pending[channel]=(async()=>{
      try{
        if(channel==='stable'){const result=await latestRelease(this.repository,{etag:cached.etag,fetcher:this.fetcher});this.cached={...cached,repository:this.repository,checkedAt:this.clock(),release:result.release||cached.release,etag:result.etag,error:null};}
        else this.caches[channel]={repository:this.repository,checkedAt:this.clock(),candidates:await channelCandidates(this.repository,{channel,baseVersion:this.installed.baseVersion,fetcher:this.fetcher}),error:null};
      }
      catch{this.caches[channel]={...cached,repository:this.repository,checkedAt:this.clock(),...(channel==='stable'?{}:{candidates:[]}),error:"GitHub 릴리스 확인에 실패했습니다. 기존 버전은 계속 사용할 수 있습니다."};}
      await atomicJson(join(this.rootDir,".updates",channel==='stable'?"release-cache.json":`${channel}-cache.json`),this.caches[channel]);return this.status({channel});
    })().finally(()=>{delete this.pending[channel];});return this.pending[channel];
  }
  start(){const run=async()=>{if(this.stopped)return;try{await this.check();}catch{}if(!this.stopped){this.timer=setTimeout(run,Math.max(60000,this.cached.checkedAt+DAY-this.clock()));this.timer.unref?.();}};void run();}
  async apply(input){
    const {channel='stable',version,commit=null}=typeof input==='string'?{version:input}:input||{};updateChannel(channel);
    if(this.child)throw fail("업데이트가 이미 진행 중입니다.");
    if(channel==='stable')await this.check();const status=await this.status({channel});if(status.busy)throw fail("이전 업데이트 상태를 먼저 확인하세요.");
    const cached=this.caches[channel],target=channel==='stable'?cached.release:cached.candidates.find(c=>c.version===version&&c.commit===commit);
    let step="CHECK_VERSION",errorCode="VERSION_NOT_AVAILABLE";
    try{
      if(!status.installable||version!==target?.version)throw fail("업데이트 가능한 최신 버전 또는 패치를 다시 확인하세요.");
      try{validateUpdateTarget(target,{channel,version,commit,installed:this.installed});}catch{throw fail("업데이트 가능한 최신 버전 또는 패치를 다시 확인하세요.");}
      step="CHECK_RESTART";errorCode="RESTART_UNAVAILABLE";
      if(!this.onReady)throw fail("업데이트 재시작 연결을 사용할 수 없습니다.",503);
      step="CHECK_SERVICE_CONFIG";errorCode="SERVICE_CONFIG_REQUIRED";
      if(process.env.INVOCATION_ID&&(process.env.UPDATE_WORKER_SURVIVES_SERVICE!=="1"||!process.env.UPDATE_SERVICE_NAME))throw fail("서비스 업데이트용 KillMode/쓰기 경로/서비스 이름 설정을 먼저 적용하세요.",503);
      step="CHECK_WRITE_PERMISSION";errorCode="INSTALL_NOT_WRITABLE";
      try{await assertUpdatePermissions(this.rootDir);}catch(error){
        if(error.code==="PRIVATE_NOT_READABLE"){step="CHECK_BACKUP_PERMISSION";errorCode=error.code;}
        throw fail(error.message,503);
      }
    }catch(error){
      await atomicJson(join(this.rootDir,".updates","job.json"),{state:"failed",message:"업데이트 시작 실패: "+redactDiagnostic(error.message),
        version:target?.version||null,channel,commit,step,errorCode}).catch(()=>{});
      throw Object.assign(error,{step,errorCode});
    }
    // Acquire the worker lock synchronously before yielding to another POST.
    if(this.child)throw fail("업데이트가 이미 진행 중입니다.");this.child={pending:true};
    try{
      await atomicJson(join(this.rootDir,".updates","job.json"),{state:"preparing",message:"새 버전 다운로드와 환경 준비 중",version,channel,commit});
      const child=this.launch?this.launch({...target,channel,commit}):fork(join(this.rootDir,"tools","update.mjs"),["--root",this.rootDir,"--repository",this.repository,"--version",version,"--channel",channel,...(commit?["--commit",commit]:[])],{detached:true,windowsHide:true,stdio:["ignore","ignore","ignore","ipc"],env:process.env});
      this.child=child;child.unref?.();child.on?.("message",message=>{if(message?.type==="ready")void this.onReady().then(()=>child.send?.({type:"stopped"})).catch(()=>{child.send?.({type:"cancel"});});});
      child.on?.("error",()=>{this.child=null;void atomicJson(join(this.rootDir,".updates","job.json"),{state:"failed",message:"업데이트 실행기를 시작하지 못했습니다.",version});});
      child.on?.("exit",code=>{this.child=null;if(code!==0)void readJson(join(this.rootDir,".updates","job.json")).then(job=>{if(job?.state!=="failed")return atomicJson(join(this.rootDir,".updates","job.json"),{state:"failed",message:"업데이트 실행기가 종료됐습니다. 상세 로그를 확인하세요.",version,errorCode:"WORKER_EXIT",exitCode:code});}).catch(()=>{});});
      return{accepted:true,version,channel,commit};
    }catch{this.child=null;await atomicJson(join(this.rootDir,".updates","job.json"),{state:"failed",message:"업데이트 실행을 준비하지 못했습니다.",version});throw fail("업데이트 실행을 준비하지 못했습니다.",503);}
  }
  close(){this.stopped=true;clearTimeout(this.timer);}
  history(){return releaseHistory(this.currentVersion,this.repository);}
}
