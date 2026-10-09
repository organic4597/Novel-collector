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
export function nextVersion(values){
  const versions=values.filter(value=>/^\d+\.\d+\.\d+\.\d+$/.test(value)).sort(compareVersions);
  if(!versions.length)throw Error("기준 버전이 필요합니다.");const parts=versionParts(versions.at(-1));parts[3]++;return parts.join(".");
}
export function releaseFiles(files){return files.filter(path=>MANAGED_SOURCE.test(path)&&path!=="tests/cicd.test.mjs");}
async function api(path){return JSON.parse((await exec("gh",["api",path],{maxBuffer:16*1024*1024})).stdout);}
async function envValue(name,value){await appendFile(process.env.GITHUB_ENV,`${name}=${value}\n`);}
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
  await git("push","origin","HEAD:refs/heads/develop");
  await envValue("CANDIDATE_VERSION",version);await envValue("CANDIDATE_COMMIT",await git("rev-parse","HEAD"));
}
async function publish(){
  const version=process.env.CANDIDATE_VERSION,commit=process.env.CANDIDATE_COMMIT;
  if(!/^\d+\.\d+\.\d+\.\d+$/.test(version||"")||await git("rev-parse","HEAD")!==commit)throw Error("검증 커밋과 버전이 일치하지 않습니다.");
  const summary=releaseNotesFor(version);
  const paths=releaseFiles((await git("ls-files")).split("\n"));
  const out=resolve(".ci-local","release");await mkdir(out,{recursive:true});
  const base=`Novel-collector-${version}`,zip=join(out,base+".zip"),tar=join(out,base+".tar.gz");
  for(const [format,target]of [["zip",zip],["tar.gz",tar]])await git("archive",`--format=${format}`,`--prefix=${base}/`,`--output=${target}`,commit,"--",...paths);
  const digest=async path=>createHash("sha256").update(await readFile(path)).digest("hex");
  const zipSha256=await digest(zip),tarSha256=await digest(tar),sums=join(out,base+"-SHA256SUMS.txt"),manifestPath=join(out,"pipeline.json");
  await writeFile(sums,`${zipSha256}  ${base}.zip\n${tarSha256}  ${base}.tar.gz\n`);
  await writeFile(manifestPath,JSON.stringify({schema:1,channel:"develop-validation",version,commit,sourceSha:process.env.GITHUB_SHA,runId:Number(process.env.GITHUB_RUN_ID),zipSha256}));
  await git("tag","-a",version,"-m",`Novel Collector develop validation ${version}`);await git("push","origin",`refs/tags/${version}`);
  const notes=(summary?summary+"\n\n":"")+`검증용 develop 게시본입니다. 운영 검증 성공 후 같은 커밋을 main·release로 승격하고 최신 정식 릴리스로 지정합니다.\n\n커밋: ${commit}\nCI: ${process.env.GITHUB_RUN_ID}`;
  await exec("gh",["release","create",version,zip,tar,sums,manifestPath,"--repo",repo,"--verify-tag","--draft","--title",`Novel Collector ${version} develop validation`,"--notes",notes]);
  const releases=await api(`repos/${repo}/releases`),release=releases.find(value=>value.tag_name===version);
  const asset=release?.assets.find(value=>value.name===base+".zip");if(asset?.digest!=="sha256:"+zipSha256)throw Error("게시된 ZIP 체크섬이 일치하지 않습니다.");
  await exec("gh",["release","edit",version,"--repo",repo,"--draft=false","--latest=false"]);
  console.info(`운영 검증 대기: ${version} (${commit})`);
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const command=process.argv[2];(command==="prepare"?prepare():command==="publish"?publish():Promise.reject(Error("prepare 또는 publish를 지정하세요."))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
