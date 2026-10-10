import {createHash} from 'node:crypto';
import {APP_VERSION,compareVersions,repositoryName,versionParts} from './version.mjs';
import {githubBytes,latestRelease,parseRelease} from './update-network.mjs';

const sha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const bad=()=>Object.assign(Error('업데이트 채널 또는 고정된 패치 정보를 확인하세요.'),{status:400});
export function updateChannel(value='stable'){
  if(!['stable','develop','hotfix'].includes(value))throw bad();return value;
}
export function installedIdentity(data=null,fallbackVersion=APP_VERSION){
  const version=data?.version??fallbackVersion,channel=updateChannel(data?.channel),commit=data?.commit??null,baseVersion=data?.baseVersion??version;
  versionParts(version);versionParts(baseVersion);
  if(commit!==null&&!sha(commit)||channel!=='stable'&&!sha(commit))throw bad();
  return {version,channel,commit,baseVersion};
}
function assetDownload(asset,release,repo,limit){
  const prefix=`https://github.com/${repo}/releases/download/${encodeURIComponent(release.tag_name)}/`;
  if(!asset||asset.state!=='uploaded'||!/^sha256:[a-f0-9]{64}$/.test(asset.digest||'')||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>limit||asset.browser_download_url!==prefix+encodeURIComponent(asset.name))throw bad();
  return {url:asset.browser_download_url,sha256:asset.digest.slice(7),size:asset.size};
}
async function tagCommit(repo,tag,fetcher){
  let object=JSON.parse((await githubBytes(`https://api.github.com/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`,{fetcher})).bytes).object;
  for(let hop=0;hop<5;hop++){
    if(!sha(object?.sha))throw bad();if(object.type==='commit')return object.sha;if(object.type!=='tag')throw bad();
    object=JSON.parse((await githubBytes(`https://api.github.com/repos/${repo}/git/tags/${object.sha}`,{fetcher})).bytes).object;
  }throw bad();
}
async function manifestCandidate(asset,release,repo,channel,baseVersion,baseCommit,fetcher){
  const json=assetDownload(asset,release,repo,64*1024),result=await githubBytes(json.url,{fetcher,limit:64*1024});
  if(result.bytes.length!==json.size||createHash('sha256').update(result.bytes).digest('hex')!==json.sha256)throw bad();
  const m=JSON.parse(result.bytes),expectedName=channel==='develop'?`develop-${m.commit}.zip`:`hotfix-${m.baseVersion}-${m.commit}.zip`;
  if(m.schema!==1||m.channel!==channel||m.repository!==repo||!sha(m.commit)||!sha(m.baseCommit)||m.sourceSha!==m.commit||!/^\d{1,20}$/.test(String(m.runId))||m.zipName!==expectedName||asset.name!==expectedName.replace(/zip$/,'json')||!/^sha256:[a-f0-9]{64}$/.test(`sha256:${m.zipSha256}`)||typeof m.summary!=='string'||m.summary.length>10000||typeof m.publishedAt!=='string'||m.publishedAt.length>40||!Number.isFinite(Date.parse(m.publishedAt)))throw bad();
  versionParts(m.version);versionParts(m.baseVersion);
  if(m.baseCommit!==baseCommit||compareVersions(m.baseVersion,release.tag_name)!==0||channel==='hotfix'&&(compareVersions(m.version,m.baseVersion)!==0||compareVersions(m.baseVersion,baseVersion)!==0))throw bad();
  const download=assetDownload(release.assets.find(a=>a.name===m.zipName),release,repo,64*1024*1024);
  if(download.sha256!==m.zipSha256)throw bad();
  const run=JSON.parse((await githubBytes(`https://api.github.com/repos/${repo}/actions/runs/${m.runId}`,{fetcher})).bytes);
  if(String(run.id)!==String(m.runId)||run.event!=='push'||run.path!=='.github/workflows/delivery.yml'||run.head_sha!==m.commit||run.repository?.full_name!==repo||run.head_repository?.full_name!==repo||run.head_branch!==(channel==='develop'?'develop':`hotfix/${m.baseVersion}`))throw bad();
  if(run.status!=='completed'||run.conclusion!=='success')return null;
  return {id:`${channel}:${m.version}:${m.commit}`,channel,version:m.version,commit:m.commit,baseVersion:m.baseVersion,baseCommit:m.baseCommit,summary:m.summary,publishedAt:m.publishedAt,url:`https://github.com/${repo}/releases/tag/${encodeURIComponent(release.tag_name)}`,download};
}
export async function channelCandidates(repository,{channel='stable',baseVersion=APP_VERSION,fetcher=fetch}={}){
  const repo=repositoryName(repository);updateChannel(channel);versionParts(baseVersion);
  if(channel==='stable'){
    const {release}=await latestRelease(repo,{fetcher});return release?[{...release,id:`stable:${release.version}:`,channel,commit:null,baseVersion:release.version,summary:'',publishedAt:null}]:[];
  }
  const endpoint=channel==='hotfix'?`tags/${encodeURIComponent(baseVersion)}`:'latest';
  const release=JSON.parse((await githubBytes(`https://api.github.com/repos/${repo}/releases/${endpoint}`,{fetcher})).bytes);parseRelease(release,repo);
  const pattern=channel==='develop'?/^develop-[a-f0-9]{40}\.json$/:/^hotfix-v?\d+(?:\.\d+){2,3}-[a-f0-9]{40}\.json$/;
  const observed=release.assets.filter(a=>pattern.test(a.name));
  if(observed.some(a=>!Number.isSafeInteger(a.id)||a.id<1||typeof a.created_at!=='string'||!Number.isFinite(Date.parse(a.created_at))))throw bad();
  const assets=observed.sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)||b.id-a.id).slice(0,10);
  const baseCommit=assets.length?await tagCommit(repo,release.tag_name,fetcher):null;
  const candidates=[];for(const asset of assets){const candidate=await manifestCandidate(asset,release,repo,channel,baseVersion,baseCommit,fetcher);if(candidate)candidates.push(candidate);}
  return candidates.sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)||a.commit.localeCompare(b.commit));
}
export function validateUpdateTarget(release,{channel='stable',version,commit=null,installed=installedIdentity()}={}){
  updateChannel(channel);versionParts(version);const current=installedIdentity(installed);
  if(channel==='stable'&&commit!==null)throw bad();
  if(!release||release.version!==version||channel!=='stable'&&(release.channel!==channel||!sha(commit)||release.commit!==commit))throw bad();
  if(channel==='stable'){
    const comparison=compareVersions(version,current.channel==='stable'?current.version:current.baseVersion);
    if(comparison<0||comparison===0&&current.channel==='stable')throw Error('새 정식 버전이 아닙니다.');
  }else{
    if(current.commit===commit&&current.channel===channel)throw Error('이미 설치된 패치입니다.');
    if(channel==='hotfix'&&(compareVersions(release.baseVersion,current.baseVersion)!==0||compareVersions(version,current.baseVersion)!==0))throw bad();
  }
  return release;
}
export async function resolveUpdateRelease(repository,{channel='stable',version,commit=null,installed=installedIdentity(),fetcher=fetch}={}){
  const candidates=await channelCandidates(repository,{channel,baseVersion:installed.baseVersion||installed.version,fetcher});
  const release=candidates.find(c=>c.version===version&&(channel==='stable'||c.commit===commit));
  return {release:validateUpdateTarget(release,{channel,version,commit,installed})};
}
