import {execFile,fork} from "node:child_process";
import {promisify} from "node:util";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {resolve,join} from "node:path";
import {pathToFileURL,fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
const exec=promisify(execFile);
const api=async path=>JSON.parse((await exec("gh",["api",path],{maxBuffer:16*1024*1024})).stdout);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function validCandidate(manifest,run){
  const metadataOk=manifest?.schema===1&&manifest.channel==="develop-validation"&&/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(manifest.version||"")&&
    /^[a-f0-9]{40}$/.test(manifest.commit||"")&&/^[a-f0-9]{40}$/.test(manifest.sourceSha||"")&&/^[a-f0-9]{64}$/.test(manifest.zipSha256||"");
  const runOk=run?.head_branch==="develop"&&run.head_sha===manifest?.sourceSha&&run.status==="completed"&&run.conclusion==="success"&&run.path===".github/workflows/delivery.yml";
  return metadataOk&&runOk&&(run.event==="push"||run.event==="workflow_dispatch");
}
async function workerLauncher(root,repo,version){
  const child=fork(fileURLToPath(import.meta.url),["--update-worker",root,repo,version],{detached:true,stdio:["ignore","ignore","ignore","ipc"]});
  child.unref();child.on("message",message=>{if(message?.type==="ready")process.send?.({type:"ready"});});
  child.on("exit",code=>{process.send?.({type:"worker-exit",code});process.exit(code||0);});
  process.on("message",message=>{if(message?.type==="stopped")child.send({type:"stopped"},()=>process.exit(75));else if(message?.type==="cancel")child.send(message);});
}
async function updateWorker(root,repo,version){
  const {update}=await import(pathToFileURL(join(root,"tools","update.mjs")).href);
  const {githubBytes,parseRelease,releaseZip}=await import(pathToFileURL(join(root,"src","update-network.mjs")).href);
  await update({root,repository:repo,version,hooks:{latest:async()=>({release:parseRelease(JSON.parse((await githubBytes(`https://api.github.com/repos/${repo}/releases/tags/${version}`)).bytes),repo)}),download:releaseZip}});
}
async function deployment(cfg,manifest){
  const root=cfg.installRoot,unit=cfg.service;
  const pid=Number((await exec("systemctl",["show",unit,"--property=MainPID","--value"])).stdout.trim());if(!pid)throw Error("운영 서비스가 실행 중이지 않습니다.");
  const env=Object.fromEntries((await readFile(`/proc/${pid}/environ`,"utf8")).split("\0").filter(Boolean).map(value=>{const cut=value.indexOf("=");return[value.slice(0,cut),value.slice(cut+1)];}));
  const uid=Number((await exec("id",["-u",cfg.serviceUser])).stdout.trim()),gid=Number((await exec("id",["-g",cfg.serviceUser])).stdout.trim());
  const child=fork(fileURLToPath(import.meta.url),["--launcher",root,cfg.repository,manifest.version],{uid,gid,cwd:root,env,stdio:["ignore","ignore","ignore","ipc"]});
  let stopped=false,restarted=false,started=false,problem;
  child.on("error",error=>{problem=error;});
  child.on("exit",code=>{if(code!==75&&code!==0)problem=Error("업데이트 실행기 종료");});
  child.on("message",message=>{if(message?.type==="ready")void exec("systemctl",["stop",unit],{timeout:120000}).then(()=>{stopped=true;child.send({type:"stopped"});}).catch(error=>{problem=error;child.send({type:"cancel"});});});
  for(let count=0;count<7200;count++){
    const job=JSON.parse(await readFile(join(root,".updates","job.json"),"utf8").catch(()=>"{}"));
    if(job.version===manifest.version&&["preparing","ready","applying","verifying"].includes(job.state))started=true;
    if(started&&job.state==="verifying"&&!restarted){await exec("systemctl",["start",unit],{timeout:120000});restarted=true;}
    if(started&&job.state==="completed")return;
    if(problem||(started&&job.state==="failed")){if(stopped)await exec("systemctl",["start",unit],{timeout:120000});throw problem||Error(job.message);}
    await pause(250);
  }
  throw Error("운영 업데이트 완료 대기 시간 초과");
}
async function verifyOperating(cfg,manifest){
  const state=(await exec("systemctl",["show",cfg.service,"--property=ActiveState","--value"])).stdout.trim();if(state!=="active")throw Error("운영 서비스가 정상 상태가 아닙니다.");
  const health=await fetch(cfg.healthUrl,{signal:AbortSignal.timeout(10000)}).then(response=>response.json());if(!health.ok||health.version!==manifest.version)throw Error("운영 버전이 검증 대상과 다릅니다.");
  const {files}=JSON.parse(await readFile(join(cfg.installRoot,".updates","managed-source.json"),"utf8"));
  for(const[path,digest]of Object.entries(files))if(createHash("sha256").update(await readFile(join(cfg.installRoot,path))).digest("hex")!==digest)throw Error("운영 파일 체크섬이 일치하지 않습니다.");
  const {chromium}=await import(pathToFileURL(cfg.playwrightModule).href),browser=await chromium.launch({headless:true,executablePath:cfg.browserPath});
  try{for(const width of [1280,390]){const page=await browser.newPage({viewport:{width,height:844}}),errors=[];page.on("pageerror",error=>errors.push(error.message));const response=await page.goto(cfg.dashboardUrl,{waitUntil:"networkidle"});if(response.status()!==200||errors.length||await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error("운영 화면 스모크 검증 실패");await page.close();}}finally{await browser.close();}
}
async function promote(cfg,manifest){
  const branch=await api(`repos/${cfg.repository}/git/ref/heads/develop`);if(branch.object.sha!==manifest.commit)throw Error("검증 이후 develop이 변경돼 main 승격을 중단합니다.");
  const bare=join(cfg.stateDirectory,"promotion.git"),url=`git@github.com:${cfg.repository}.git`;await mkdir(cfg.stateDirectory,{recursive:true,mode:0o700});
  await exec("git",["init","--bare",bare]);
  const git=async(...args)=>(await exec("git",["--git-dir",bare,...args],{maxBuffer:16*1024*1024})).stdout.trim();
  await git("fetch",url,"main:refs/heads/main","develop:refs/heads/develop","release:refs/heads/release");
  for(const branch of ["main","release"])await git("merge-base","--is-ancestor",branch,manifest.commit);
  await git("push","--atomic",url,`${manifest.commit}:refs/heads/main`,`${manifest.commit}:refs/heads/release`);
  await exec("gh",["release","edit",manifest.version,"--repo",cfg.repository,"--latest","--title",`Novel Collector ${manifest.version}`]);
}
async function poll(configPath){
  const cfg=JSON.parse(await readFile(configPath,"utf8"));if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cfg.repository)||!/^[-\w.@]+\.service$/.test(cfg.service))throw Error("배포 설정을 확인하세요.");
  await mkdir(cfg.stateDirectory,{recursive:true,mode:0o700});const statePath=join(cfg.stateDirectory,"state.json");
  const state=JSON.parse(await readFile(statePath,"utf8").catch(()=>"{\"versions\":{}}"));
  const releases=await api(`repos/${cfg.repository}/releases?per_page=30`);
  for(const release of [...releases].reverse()){
    const asset=release.assets?.find(value=>value.name==="pipeline.json");if(release.draft||release.prerelease||!asset||state.versions[release.tag_name]?.status==="promoted"||state.versions[release.tag_name]?.status==="failed")continue;
    if(!asset.browser_download_url.startsWith(`https://github.com/${cfg.repository}/releases/download/${encodeURIComponent(release.tag_name)}/`)||asset.size>1024*1024)throw Error("검증 메타데이터 출처가 올바르지 않습니다.");
    const manifest=await fetch(asset.browser_download_url,{signal:AbortSignal.timeout(15000)}).then(async response=>{if(!response.ok)throw Error("검증 메타데이터 다운로드 실패");const bytes=await response.arrayBuffer();if(bytes.byteLength>1024*1024)throw Error("검증 메타데이터 크기 초과");return JSON.parse(Buffer.from(bytes));});
    const run=await api(`repos/${cfg.repository}/actions/runs/${manifest.runId}`);if(!validCandidate(manifest,run)||manifest.version!==release.tag_name)continue;
    const zip=release.assets.find(value=>value.name===`Novel-collector-${manifest.version}.zip`);if(zip?.digest!=="sha256:"+manifest.zipSha256)throw Error("릴리스 출처 체크섬이 일치하지 않습니다.");
    try{
      const branch=await api(`repos/${cfg.repository}/git/ref/heads/develop`);if(branch.object.sha!==manifest.commit)continue;
      const installed=JSON.parse(await readFile(join(cfg.installRoot,".updates","installed-version.json"),"utf8"));
      if(installed.version!==manifest.version)await deployment(cfg,manifest);
      await verifyOperating(cfg,manifest);await promote(cfg,manifest);
      state.versions[manifest.version]={status:"promoted",commit:manifest.commit,verifiedAt:new Date().toISOString()};
      console.info(`운영 검증 및 정식 승격 완료: ${manifest.version}`);
    }catch(error){state.versions[manifest.version]={status:"failed",commit:manifest.commit,error:error.message,time:new Date().toISOString()};console.error(`운영 검증 또는 승격 실패: ${manifest.version}`);}
    await writeFile(statePath,JSON.stringify(state),{mode:0o600});
  }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const[mode,...args]=process.argv.slice(2);
  (mode==="--launcher"?workerLauncher(...args):mode==="--update-worker"?updateWorker(...args):mode==="--config"?poll(args[0]):Promise.reject(Error("배포 실행 모드를 지정하세요."))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
