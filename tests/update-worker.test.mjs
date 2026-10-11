import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,writeFile,readFile,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { update } from "../tools/update.mjs";
import { fork } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { APP_VERSION, versionParts } from "../src/version.mjs";
const nextParts=versionParts(APP_VERSION);nextParts[3]++;
const version=nextParts.join("."),repository="example/Novel-collector";
const manifest=JSON.stringify({name:"novel-collector",version:"1.0.0"});
const lockfile=JSON.stringify({name:"novel-collector",version:"1.0.0",lockfileVersion:3,requires:true,packages:{"":{name:"novel-collector",version:"1.0.0"}}});
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),"update worker spaces "));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
  await mkdir(join(root,"tools"));await writeFile(join(root,"run.mjs"),"OLD_SOURCE");await writeFile(join(root,"tools","recover-update.mjs"),await readFile(new URL("../tools/recover-update.mjs",import.meta.url)));
  for(const path of ["data","secrets","profile"]){await mkdir(join(root,path));await writeFile(join(root,path,"private.txt"),"CANARY_"+path);}return root;
}
async function packageZip(fail=false,targetVersion=version,failAfterActivate=false){
  const zip=new JSZip(),run=fail?'process.exit(1);':`import {mkdir,readFile,writeFile} from 'node:fs/promises';import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';const root=dirname(fileURLToPath(import.meta.url));for(const p of ['node_modules','.venv-captcha','profile/playwright-browsers'])await mkdir(join(root,p),{recursive:true});${failAfterActivate?"if(process.argv.includes('--check')&&await readFile(join(root,'.updates','installed-version.json')).catch(()=>null)){await writeFile(join(root,'data','private.txt'),'FAILED_NEW_DATA');process.exit(1);}":""}`;
  for(const [path,value] of Object.entries({"run.mjs":run,"package.json":manifest,"package-lock.json":lockfile,"src/version.mjs":`export const APP_VERSION = "${targetVersion}";`,"src/server.mjs":"export const ready=true;","src/updates.mjs":"export const updates=true;","tools/update.mjs":"export const update=true;"}))zip.file("release/"+path,value);
  return zip.generateAsync({type:"nodebuffer"});
}
test("offline update executes real staged Node preflight in a spaced path and preserves private files",async t=>{
  const root=await fixture(t),bytes=await packageZip();await update({root,repository,version,offline:true,hooks:{latest:async()=>({release:{version}}),download:async()=>bytes}});
  assert.equal(JSON.parse(await readFile(join(root,".updates","job.json"))).state,"completed");assert.equal(JSON.parse(await readFile(join(root,".updates","installed-version.json"))).version,version);
  for(const path of ["data","secrets","profile"])assert.equal(await readFile(join(root,path,"private.txt"),"utf8"),"CANARY_"+path);
});
test("a legacy four-part installation upgrades to a three-part semantic release with private state intact",async t=>{
  const root=await fixture(t),targetVersion="1.1.0";
  await mkdir(join(root,".updates"));await writeFile(join(root,".updates","installed-version.json"),JSON.stringify({version:"1.0.0.17"}));
  const bytes=await packageZip(false,targetVersion);
  await update({root,repository,version:targetVersion,offline:true,hooks:{latest:async()=>({release:{version:targetVersion}}),download:async()=>bytes}});
  assert.deepEqual(JSON.parse(await readFile(join(root,".updates","installed-version.json"))),{version:targetVersion,channel:"stable",commit:null,baseVersion:targetVersion});
  assert.equal(JSON.parse(await readFile(join(root,".updates","job.json"))).state,"completed");
  for(const path of ["data","secrets","profile"])assert.equal(await readFile(join(root,path,"private.txt"),"utf8"),"CANARY_"+path);
});
test("preflight failure does not stop or replace the old installation",async t=>{
  const root=await fixture(t),bytes=await packageZip(true);await assert.rejects(update({root,repository,version,offline:true,hooks:{latest:async()=>({release:{version}}),download:async()=>bytes}}));
  assert.equal(await readFile(join(root,"run.mjs"),"utf8"),"OLD_SOURCE");assert.equal(JSON.parse(await readFile(join(root,".updates","job.json"))).state,"failed");
  for(const path of ["data","secrets","profile"])assert.equal(await readFile(join(root,path,"private.txt"),"utf8"),"CANARY_"+path);
});

test("online worker completes the IPC shutdown, restart health check and private-data-preserving update",async t=>{
  const root=await fixture(t),socket=createServer();await new Promise(r=>socket.listen(0,"127.0.0.1",r));const port=socket.address().port;await new Promise(r=>socket.close(r));
  const target=new JSZip();const run=`import{mkdir,readFile}from'node:fs/promises';import{dirname,join}from'node:path';import{fileURLToPath}from'node:url';import{createServer}from'node:http';const root=dirname(fileURLToPath(import.meta.url));if(process.argv.includes('--setup')||process.argv.includes('--check')){for(const p of['node_modules','.venv-captcha','profile/playwright-browsers'])await mkdir(join(root,p),{recursive:true});}else{const version=JSON.parse(await readFile(join(root,'.updates','installed-version.json'))).version;createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({version,pid:process.pid}));}).listen(Number(process.env.PORT),'127.0.0.1');}`;
  for(const [path,value] of Object.entries({"run.mjs":run,"package.json":manifest,"package-lock.json":lockfile,"src/version.mjs":`export const APP_VERSION = "${version}";`,"src/server.mjs":"export const ready=true;","src/updates.mjs":"export const updates=true;","tools/update.mjs":"export const update=true;"}))target.file("release/"+path,value);
  const bytes=await target.generateAsync({type:"nodebuffer"}),worker=join(root,"worker.mjs"),parent=join(root,"parent.mjs");
  await writeFile(worker,`import {update} from ${JSON.stringify(new URL("../tools/update.mjs",import.meta.url).href)};await update({root:process.argv[2],repository:${JSON.stringify(repository)},version:${JSON.stringify(version)},hooks:{latest:async()=>({release:{version:${JSON.stringify(version)}}}),download:async()=>Buffer.from(${JSON.stringify(bytes.toString("base64"))},'base64')}});`);
  await writeFile(parent,`import{fork}from'node:child_process';const child=fork(process.argv[2],[process.argv[3]],{detached:true,stdio:['ignore','ignore','ignore','ipc']});child.unref();child.on('message',m=>{if(m.type==='ready'){child.send({type:'stopped'});setTimeout(()=>process.exit(75),100);}});`);
  const env={...process.env,HOST:"127.0.0.1",PORT:String(port)};delete env.INVOCATION_ID;delete env.JOURNAL_STREAM;
  const first=fork(parent,[worker,root],{env,stdio:"ignore"});await new Promise((yes,no)=>{first.once("exit",code=>code===75?yes():no(Error("shutdown failed")));});
  let pid;try{
    for(let i=0;i<100;i++){try{const info=await fetch(`http://127.0.0.1:${port}/api/health`).then(r=>r.json());pid=info.pid;const state=JSON.parse(await readFile(join(root,".updates","job.json")));if(state.state==="completed")break;}catch{}await new Promise(r=>setTimeout(r,100));}
    assert.equal(JSON.parse(await readFile(join(root,".updates","job.json"))).state,"completed");for(const path of["data","secrets","profile"])assert.equal(await readFile(join(root,path,"private.txt"),"utf8"),"CANARY_"+path);
  }finally{if(pid)process.kill(pid,"SIGTERM");}
});

test("same-version hotfix and develop commits install once and preserve legacy user state",async t=>{
  const root=await fixture(t),bytes=await packageZip(false,APP_VERSION),first="a".repeat(40),second="b".repeat(40);
  for(const [channel,commit] of [["hotfix",first],["hotfix",second],["develop",first],["develop",second]]){
    const release={version:APP_VERSION,channel,commit,baseVersion:APP_VERSION};
    await update({root,repository,version:APP_VERSION,channel,commit,offline:true,hooks:{latest:async()=>({release}),download:async()=>bytes}});
    assert.deepEqual(JSON.parse(await readFile(join(root,".updates","installed-version.json"))),{version:APP_VERSION,channel,commit,baseVersion:APP_VERSION});
    let downloads=0;
    await assert.rejects(update({root,repository,version:APP_VERSION,channel,commit,offline:true,hooks:{latest:async()=>({release}),download:async()=>{downloads++;return bytes;}}}),/이미 설치/);
    assert.equal(downloads,0);
  }
  for(const path of ["data","secrets","profile"])assert.equal(await readFile(join(root,path,"private.txt"),"utf8"),"CANARY_"+path);
});

test("develop retains the stable origin and can return to stable despite its newer APP_VERSION",async t=>{
  const root=await fixture(t),commit="a".repeat(40),develop={version,channel:"develop",commit,baseVersion:APP_VERSION};
  await update({root,repository,version,channel:"develop",commit,offline:true,hooks:{latest:async()=>({release:develop}),download:async()=>packageZip()}});
  assert.equal(JSON.parse(await readFile(join(root,".updates","installed-version.json"))).baseVersion,APP_VERSION);
  await update({root,repository,version:APP_VERSION,channel:"stable",offline:true,hooks:{latest:async()=>({release:{version:APP_VERSION}}),download:async()=>packageZip(false,APP_VERSION)}});
  assert.deepEqual(JSON.parse(await readFile(join(root,".updates","installed-version.json"))),{version:APP_VERSION,channel:"stable",commit:null,baseVersion:APP_VERSION});
  assert.equal(await readFile(join(root,"data","private.txt"),"utf8"),"CANARY_data");
});

test("a selector commit mismatch and a wrong source APP_VERSION fail before replacing user installation",async t=>{
  const root=await fixture(t),commit="a".repeat(40),release={version:APP_VERSION,channel:"hotfix",commit,baseVersion:APP_VERSION};let downloads=0;
  await assert.rejects(update({root,repository,version:APP_VERSION,channel:"hotfix",commit,offline:true,hooks:{latest:async()=>({release:{...release,commit:"b".repeat(40)}}),download:async()=>{downloads++;}}}));
  assert.equal(downloads,0);
  const bytes=await packageZip(false,version);
  await assert.rejects(update({root,repository,version:APP_VERSION,channel:"hotfix",commit,offline:true,hooks:{latest:async()=>({release}),download:async()=>bytes}}),{code:"STAGED_VERSION_MISMATCH"});
  assert.equal(await readFile(join(root,"run.mjs"),"utf8"),"OLD_SOURCE");
  assert.equal(await readFile(join(root,"data","private.txt"),"utf8"),"CANARY_data");
});

test("post-activation failure restores legacy metadata and user DB changes from the failed startup",async t=>{
  const root=await fixture(t),previous={version:APP_VERSION},commit="a".repeat(40),release={version:APP_VERSION,channel:"hotfix",commit,baseVersion:APP_VERSION};
  await mkdir(join(root,".updates"));await writeFile(join(root,".updates","installed-version.json"),JSON.stringify(previous));
  const bytes=await packageZip(false,APP_VERSION,true);
  await assert.rejects(update({root,repository,version:APP_VERSION,channel:"hotfix",commit,offline:true,hooks:{latest:async()=>({release}),download:async()=>bytes}}),{code:"COMMAND_FAILED"});
  assert.deepEqual(JSON.parse(await readFile(join(root,".updates","installed-version.json"))),previous);
  assert.equal(await readFile(join(root,"run.mjs"),"utf8"),"OLD_SOURCE");
  assert.equal(await readFile(join(root,"data","private.txt"),"utf8"),"CANARY_data");
});
