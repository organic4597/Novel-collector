import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {readFile,writeFile,mkdir,appendFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {resolve,join} from "node:path";
import {pathToFileURL} from "node:url";
import {MANAGED_SOURCE} from "../src/update-files.mjs";
import {versionParts,compareVersions,repositoryName} from "../src/version.mjs";
import {releaseNotesFor} from "../src/release-history.mjs";
const exec=promisify(execFile);
const repo=repositoryName(process.env.GITHUB_REPOSITORY);
const git=async(...args)=>(await exec("git",args,{maxBuffer:16*1024*1024})).stdout.trim();
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function nextVersion(values){
  const versions=values.filter(value=>/^\d+\.\d+\.\d+\.\d+$/.test(value)).sort(compareVersions);
  if(!versions.length)throw Error("기준 버전이 필요합니다.");const parts=versionParts(versions.at(-1));parts[3]++;return parts.join(".");
}
export function releaseFiles(files){return files.filter(path=>MANAGED_SOURCE.test(path)&&path!=="tests/cicd.test.mjs");}
export function channelNameForBranch(branch){
  if(branch==="develop")return "develop";
  if(/^hotfix\/\d+\.\d+\.\d+\.\d+$/.test(branch||""))return "hotfix";
  throw Error("업데이트 채널 브랜치를 확인하세요.");
}
export function channelArtifactNames({channel,baseVersion,commit}){
  if(!/^[a-f0-9]{40}$/i.test(commit||""))throw Error("채널 커밋 형식이 올바르지 않습니다.");
  if(channel==="develop")return {zipName:`develop-${commit}.zip`,manifestName:`develop-${commit}.json`};
  if(channel==="hotfix"){
    if(!/^\d+\.\d+\.\d+\.\d+$/.test(baseVersion||""))throw Error("hotfix baseVersion이 필요합니다.");
    return {zipName:`hotfix-${baseVersion}-${commit}.zip`,manifestName:`hotfix-${baseVersion}-${commit}.json`};
  }
  throw Error("업데이트 채널을 확인하세요.");
}
export function channelPublishedAt(commitTimestamp){
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(commitTimestamp||""))throw Error("커밋 시각 형식이 올바르지 않습니다.");
  return commitTimestamp;
}
export function buildChannelManifest({channel,version,commit,baseVersion,baseCommit,runId,repository,sourceSha,zipName,zipSha256,summary,publishedAt}){
  if(!["develop","hotfix"].includes(channel))throw Error("업데이트 채널을 확인하세요.");
  if(!/^\d+\.\d+\.\d+\.\d+$/.test(version||"")||!/^\d+\.\d+\.\d+\.\d+$/.test(baseVersion||""))throw Error("업데이트 버전을 확인하세요.");
  for(const [name,value]of Object.entries({commit,baseCommit,sourceSha}))if(!/^[a-f0-9]{40}$/i.test(value||""))throw Error(`${name} 형식이 올바르지 않습니다.`);
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository||""))throw Error("저장소 형식이 올바르지 않습니다.");
  if(!/^[a-f0-9]{64}$/i.test(zipSha256||""))throw Error("ZIP 체크섬 형식이 올바르지 않습니다.");
  return {schema:1,channel,version,commit,baseVersion,baseCommit,runId:Number(runId),repository,sourceSha,zipName,zipSha256,summary:String(summary||"").slice(0,300),publishedAt};
}
export function plannedCandidateEnv({version,commit,sourceSha,sourceRef}){
  if(!/^\d+\.\d+\.\d+\.\d+$/.test(version||"")||!/^[a-f0-9]{40}$/i.test(commit||"")||!/^[a-f0-9]{40}$/i.test(sourceSha||""))throw Error("검증 후보 정보를 확인하세요.");
  if(sourceRef!=="refs/heads/develop")throw Error("정식 릴리스는 develop에서만 준비할 수 있습니다.");
  return {CANDIDATE_VERSION:version,CANDIDATE_COMMIT:commit,CANDIDATE_SOURCE_SHA:sourceSha,CANDIDATE_SOURCE_REF:sourceRef};
}
export function sourceBranchRef(env){
  if(env?.CANDIDATE_SOURCE_REF!=="refs/heads/develop")throw Error("정식 릴리스는 develop에만 게시할 수 있습니다.");
  return "HEAD:refs/heads/develop";
}
export async function verifyPublishedAssetDigest(readReleases,{version,assetName,expectedDigest,attempts=15,delayMs=2000,delay=wait}){
  for(let attempt=1;attempt<=attempts;attempt++){
    const releases=await readReleases();
    const release=(Array.isArray(releases)?releases:[]).find(value=>value?.tag_name===version);
    const asset=release?.assets?.find(value=>value?.name===assetName);
    if(asset?.digest===expectedDigest)return;
    if(asset?.digest)throw Error("게시된 ZIP 체크섬이 일치하지 않습니다.");
    if(attempt<attempts)await delay(delayMs);
  }
  throw Error("게시된 ZIP 체크섬을 확인하지 못했습니다.");
}
async function api(path){return JSON.parse((await exec("gh",["api",path],{maxBuffer:16*1024*1024})).stdout);}
async function latestStableRelease(){
  const releases=await api(`repos/${repo}/releases?per_page=100`),release=releases.find(value=>!value.draft&&!value.prerelease&&/^\d+\.\d+\.\d+\.\d+$/.test(value.tag_name||""));
  if(!release)throw Error("기준 안정 릴리스를 찾지 못했습니다.");
  return release;
}
async function releaseByTag(tag){
  const release=await api(`repos/${repo}/releases/tags/${tag}`);
  if(release.draft||release.prerelease)throw Error("기준 릴리스가 안정 릴리스가 아닙니다.");
  return release;
}
async function uploadAssetOnce(tag,release,path,name,sha256){
  const expectedDigest="sha256:"+sha256,readReleases=async()=>[await releaseByTag(tag)];
  if(release.assets?.some(value=>value.name===name)){await verifyPublishedAssetDigest(readReleases,{version:tag,assetName:name,expectedDigest});return;}
  try{await exec("gh",["release","upload",tag,path,"--repo",repo]);}
  catch(error){await verifyPublishedAssetDigest(readReleases,{version:tag,assetName:name,expectedDigest});return;}
  await verifyPublishedAssetDigest(readReleases,{version:tag,assetName:name,expectedDigest});
}
async function envValue(name,value){await appendFile(process.env.GITHUB_ENV,`${name}=${value}\n`);}
async function envValues(values){for(const [name,value]of Object.entries(values))await envValue(name,value);}
async function prepare(){
  await git("fetch","origin","--tags");
  if(await git("rev-parse","origin/develop")!==process.env.GITHUB_SHA)throw Error("새 develop 커밋이 있어 이전 실행을 중단합니다.");
  await git("merge","--no-edit","origin/main");
  const text=await readFile("src/version.mjs","utf8"),current=text.match(/APP_VERSION = "([\d.]+)"/)?.[1];
  const version=nextVersion([current,...(await git("tag","--list")).split("\n")]);
  await writeFile("src/version.mjs",text.replace(`APP_VERSION = "${current}"`,`APP_VERSION = "${version}"`));
  for(const file of ["README.md","docs/UPDATE.md"]){const content=await readFile(file,"utf8");await writeFile(file,content.replace(`**${current}**`,`**${version}**`));}
  await git("add","src/version.mjs","README.md","docs/UPDATE.md");
  await git("commit","-m",`Prepare develop validation ${version} [skip ci]`);
  await envValues(plannedCandidateEnv({version,commit:await git("rev-parse","HEAD"),sourceSha:process.env.GITHUB_SHA,sourceRef:process.env.GITHUB_REF}));
}
async function channel(){
  if(process.env.GITHUB_EVENT_NAME!=="push")throw Error("채널 게시에는 push 이벤트가 필요합니다.");
  const branch=process.env.GITHUB_REF_NAME,channel=channelNameForBranch(branch),sourceHead=await git("rev-parse","HEAD"),eventSha=process.env.GITHUB_SHA;
  if(sourceHead!==eventSha)throw Error("체크아웃 커밋이 이벤트 커밋과 다릅니다.");
  await git("fetch","origin","--tags");
  const version=(await readFile("src/version.mjs","utf8")).match(/APP_VERSION = "([\d.]+)"/)?.[1];
  if(!/^\d+\.\d+\.\d+\.\d+$/.test(version||""))throw Error("APP_VERSION을 확인하세요.");
  const release=channel==="develop"?await latestStableRelease():await releaseByTag(branch.slice("hotfix/".length));
  const baseVersion=release.tag_name,baseCommit=await git("rev-list","-n","1",baseVersion);
  if(channel==="hotfix"){
    if(version!==baseVersion)throw Error("hotfix APP_VERSION이 기준 안정 버전과 다릅니다.");
    await git("merge-base","--is-ancestor",baseCommit,sourceHead);
  }
  const names=channelArtifactNames({channel,baseVersion,commit:sourceHead});
  const out=resolve(".ci-local","channel");await mkdir(out,{recursive:true});
  const zip=join(out,names.zipName),manifestPath=join(out,names.manifestName),paths=releaseFiles((await git("ls-files")).split("\n"));
  await git("archive","--format=zip",`--prefix=Novel-collector-${version}/`,`--output=${zip}`,sourceHead,"--",...paths);
  const zipSha256=createHash("sha256").update(await readFile(zip)).digest("hex"),summary=await git("log","-1","--pretty=%s");
  const manifest=buildChannelManifest({channel,version,commit:sourceHead,baseVersion,baseCommit,runId:process.env.GITHUB_RUN_ID,repository:repo,sourceSha:eventSha,zipName:names.zipName,zipSha256,summary,publishedAt:channelPublishedAt(await git("log","-1","--pretty=%cI"))});
  await writeFile(manifestPath,JSON.stringify(manifest,null,2));
  const manifestSha256=createHash("sha256").update(await readFile(manifestPath)).digest("hex");
  await uploadAssetOnce(baseVersion,release,zip,names.zipName,zipSha256);
  await uploadAssetOnce(baseVersion,release,manifestPath,names.manifestName,manifestSha256);
  console.info(`업데이트 채널 게시 완료: ${names.zipName}`);
}
async function publish(){
  const version=process.env.CANDIDATE_VERSION,commit=process.env.CANDIDATE_COMMIT;
  if(!/^\d+\.\d+\.\d+\.\d+$/.test(version||"")||await git("rev-parse","HEAD")!==commit)throw Error("검증 커밋과 버전이 일치하지 않습니다.");
  await git("fetch","origin","develop");
  if(await git("rev-parse","origin/develop")!==process.env.CANDIDATE_SOURCE_SHA)throw Error("검증 중 develop이 변경돼 게시를 중단합니다.");
  if(process.env.CANDIDATE_SOURCE_REF!=="refs/heads/develop")throw Error("검증 후보 브랜치가 develop이 아닙니다.");
  const summary=releaseNotesFor(version);
  const paths=releaseFiles((await git("ls-files")).split("\n"));
  const out=resolve(".ci-local","release");await mkdir(out,{recursive:true});
  const base=`Novel-collector-${version}`,zip=join(out,base+".zip"),tar=join(out,base+".tar.gz");
  for(const [format,target]of [["zip",zip],["tar.gz",tar]])await git("archive",`--format=${format}`,`--prefix=${base}/`,`--output=${target}`,commit,"--",...paths);
  const digest=async path=>createHash("sha256").update(await readFile(path)).digest("hex");
  const zipSha256=await digest(zip),tarSha256=await digest(tar),sums=join(out,base+"-SHA256SUMS.txt"),manifestPath=join(out,"pipeline.json");
  await writeFile(sums,`${zipSha256}  ${base}.zip\n${tarSha256}  ${base}.tar.gz\n`);
  await writeFile(manifestPath,JSON.stringify({schema:1,channel:"develop-validation",version,commit,sourceSha:process.env.GITHUB_SHA,runId:Number(process.env.GITHUB_RUN_ID),zipSha256}));
  await git("push","origin",sourceBranchRef(process.env));
  await git("tag","-a",version,"-m",`Novel Collector develop validation ${version}`);await git("push","origin",`refs/tags/${version}`);
  const notes=(summary?summary+"\n\n":"")+`검증용 develop 게시본입니다. 운영 검증 성공 후 같은 커밋을 main·release로 승격하고 최신 정식 릴리스로 지정합니다.\n\n커밋: ${commit}\nCI: ${process.env.GITHUB_RUN_ID}`;
  await exec("gh",["release","create",version,zip,tar,sums,manifestPath,"--repo",repo,"--verify-tag","--draft","--title",`Novel Collector ${version} develop validation`,"--notes",notes]);
  await verifyPublishedAssetDigest(()=>api(`repos/${repo}/releases?per_page=100`),{version,assetName:base+".zip",expectedDigest:"sha256:"+zipSha256});
  await exec("gh",["release","edit",version,"--repo",repo,"--draft=false","--latest=false"]);
  console.info(`운영 검증 대기: ${version} (${commit})`);
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const command=process.argv[2];(command==="prepare"?prepare():command==="publish"?publish():command==="channel"?channel():Promise.reject(Error("prepare, publish 또는 channel을 지정하세요."))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
