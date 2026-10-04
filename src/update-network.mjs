import { createHash } from "node:crypto";
import { repositoryName, versionParts } from "./version.mjs";

const hosts=new Set(["api.github.com","github.com","objects.githubusercontent.com","release-assets.githubusercontent.com","codeload.github.com"]);
export async function githubBytes(url,{fetcher=fetch,headers={},limit=2*1024*1024,timeoutMs=15000}={}){
  const signal=AbortSignal.timeout(timeoutMs);
  for(let hop=0;hop<6;hop++){
    const parsed=new URL(url);if(parsed.protocol!=="https:"||parsed.port||parsed.username||parsed.password||!hosts.has(parsed.hostname))throw Error("허용되지 않은 GitHub 다운로드 주소입니다.");
    const response=await fetcher(parsed.href,{headers:{"User-Agent":"Novel-Collector-Updater",...headers},redirect:"manual",signal});
    if([301,302,303,307,308].includes(response.status)){url=new URL(response.headers.get("location"),parsed).href;continue;}
    if(response.status===304)return{status:304,headers:response.headers,bytes:Buffer.alloc(0)};
    if(!response.ok)throw Error("GitHub 요청에 실패했습니다.");
    if(Number(response.headers.get("content-length"))>limit)throw Error("다운로드 크기 한도를 초과했습니다.");
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>limit){await response.body.cancel?.().catch(()=>{});throw Error("다운로드 크기 한도를 초과했습니다.");}chunks.push(chunk);}
    return{status:response.status,headers:response.headers,bytes:Buffer.concat(chunks)};
  }throw Error("GitHub 리디렉션이 너무 많습니다.");
}
export function parseRelease(data,repository){
  const repo=repositoryName(repository);if(!data||data.draft||data.prerelease)throw Error("공개 정식 릴리스가 아닙니다.");versionParts(data.tag_name);
  const url=`https://github.com/${repo}/releases/tag/${encodeURIComponent(data.tag_name)}`;
  const asset=(data.assets||[]).find(a=>typeof a.name==="string"&&a.name.endsWith(".zip")&&a.state==="uploaded"&&/^sha256:[a-f0-9]{64}$/.test(a.digest||""));
  let download=null;if(asset){const prefix=`https://github.com/${repo}/releases/download/${encodeURIComponent(data.tag_name)}/`;
    if(!asset.browser_download_url?.startsWith(prefix)||!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>64*1024*1024)throw Error("릴리스 ZIP 주소나 크기를 확인하세요.");
    download={url:asset.browser_download_url,sha256:asset.digest.slice(7),size:asset.size};}
  return{version:data.tag_name,url,download};
}
export async function latestRelease(repository,{etag=null,fetcher=fetch}={}){
  const repo=repositoryName(repository),result=await githubBytes(`https://api.github.com/repos/${repo}/releases/latest`,{fetcher,headers:{Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28",...(etag?{"If-None-Match":etag}:{})}});
  return{etag:result.headers.get("etag")||etag,release:result.status===304?null:parseRelease(JSON.parse(result.bytes),repo)};
}
export async function releaseZip(release,{fetcher=fetch}={}){
  if(!release.download)throw Error("SHA256이 제공된 릴리스 ZIP이 필요합니다.");
  const result=await githubBytes(release.download.url,{fetcher,limit:64*1024*1024,timeoutMs:120000});
  if(result.bytes.length!==release.download.size||createHash("sha256").update(result.bytes).digest("hex")!==release.download.sha256)throw Error("릴리스 ZIP 무결성 확인에 실패했습니다.");return result.bytes;
}
