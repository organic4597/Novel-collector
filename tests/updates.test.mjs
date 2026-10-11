import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,writeFile,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { APP_VERSION,versionParts,compareVersions,repositoryName } from "../src/version.mjs";
import { Updates,DAY } from "../src/updates.mjs";
import { githubBytes,parseRelease,releaseZip } from "../src/update-network.mjs";
import { createApp } from "../src/server.mjs";
const repository="example/Novel-collector";
const nextParts=versionParts(APP_VERSION);nextParts[3]++;
const tag=nextParts.join(".");
const release=()=>({tag_name:tag,draft:false,prerelease:false,assets:[{name:"source.zip",state:"uploaded",size:1,digest:"sha256:"+"a".repeat(64),browser_download_url:`https://github.com/${repository}/releases/download/${tag}/source.zip`}]});
async function root(t){const dir=await mkdtemp(join(tmpdir(),"updates-test-"));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test("four-component versions compare numerically and repository input cannot redirect to arbitrary hosts",()=>{
  assert.equal(compareVersions("1.0.0.10","1.0.0.9"),1);assert.equal(compareVersions("v1.0.0","1.0.0.0"),0);
  assert.equal(repositoryName("https://github.com/example/Novel-collector.git"),repository);
  for(const value of ["1.0.0-beta","1.0","1.0.0.0.1"])assert.throws(()=>compareVersions(value,"1.0.0.0"));
  assert.throws(()=>repositoryName("https://private.test/example/repo"));
});
test("semantic releases upgrade legacy installations without accepting a downgrade",()=>{
  for(const version of ["1.0.1","1.1.0","2.0.0"])assert.equal(compareVersions(version,"1.0.0.17"),1);
  assert.equal(compareVersions("1.1.0","1.0.99"),1);
  assert.equal(compareVersions("1.0.0.17","1.0.1"),-1);
  const value={...release(),tag_name:"1.1.0",assets:[]};
  assert.equal(parseRelease(value,repository).version,"1.1.0");
});
test("daily checks coalesce, persist across restart and use conditional requests without downloading code",async t=>{
  const dir=await root(t);let now=100000,calls=0;
  const fetcher=async(url,options)=>{calls++;assert.match(url,/api.github.com/);if(calls>1){assert.equal(options.headers["If-None-Match"],"fixture-etag");return new Response(null,{status:304});}return new Response(JSON.stringify(release()),{headers:{etag:"fixture-etag"}});};
  const updates=await new Updates({rootDir:dir,repository,clock:()=>now,fetcher}).load();
  const results=await Promise.all(Array.from({length:10},()=>updates.check()));assert.equal(calls,1);assert.equal(results[0].available,true);
  const restored=await new Updates({rootDir:dir,repository,clock:()=>now,fetcher}).load();await restored.check();assert.equal(calls,1);
  now+=DAY;await restored.check();assert.equal(calls,2);assert.equal((await restored.status()).latestVersion,tag);
});
test("network errors expose a generic notice, retain the known release and never mutate private DB",async t=>{
  const dir=await root(t);await mkdir(join(dir,"data"));await writeFile(join(dir,"data","db.json"),"PRIVATE_CANARY");let now=100000;
  const updates=await new Updates({rootDir:dir,repository,clock:()=>now,fetcher:async()=>new Response(JSON.stringify(release()))}).load();await updates.check();
  now+=DAY;updates.fetcher=async()=>{throw Error("RAW_PRIVATE_TOKEN");};const state=await updates.check();
  assert.equal(state.available,true);assert.ok(state.error);assert.ok(!JSON.stringify(state).includes("RAW_PRIVATE_TOKEN"));assert.equal(await readFile(join(dir,"data","db.json"),"utf8"),"PRIVATE_CANARY");
});

test("the current released version is never offered as another update", async t=>{
  const dir=await root(t),current={...release(),tag_name:APP_VERSION,assets:[]};
  const updates=await new Updates({rootDir:dir,repository,fetcher:async()=>new Response(JSON.stringify(current))}).load();
  const state=await updates.check();
  assert.equal(state.available,false);assert.equal(state.installable,false);
  await assert.rejects(updates.apply(APP_VERSION));
});
test("untrusted redirects, prereleases, mismatched checksums and credential URLs are rejected",async()=>{
  let calls=0;await assert.rejects(githubBytes("https://api.github.com/fixture",{fetcher:async()=>{calls++;return new Response(null,{status:302,headers:{location:"http://127.0.0.1/private"}});}}));assert.equal(calls,1);
  assert.throws(()=>parseRelease({...release(),prerelease:true},repository));
  const wrong=release();wrong.assets[0].browser_download_url="https://github.com/other/repo/releases/download/1/source.zip";assert.throws(()=>parseRelease(wrong,repository));
  await assert.rejects(releaseZip(parseRelease(release(),repository),{fetcher:async()=>new Response("x")}));
});
test("update APIs require admin authentication and same-origin writes; duplicate clicks start one worker",async t=>{
  const dir=await root(t);let launched=0;const child=new EventEmitter();child.unref=()=>{};
  const updates=await new Updates({rootDir:dir,repository,fetcher:async()=>new Response(JSON.stringify(release())),launch:()=>{launched++;return child;}}).load();updates.onReady=async()=>{};await updates.check();
  const app=createApp({store:{},scheduler:{},adminPassword:"fixture-password",updates});await new Promise(r=>app.listen(0,"127.0.0.1",r));t.after(()=>new Promise(r=>app.close(r)));const origin=`http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(origin+"/api/updates/status")).status,401);assert.equal((await fetch(origin+"/api/health")).status,200);
  const login=await fetch(origin+"/api/login",{method:"POST",body:JSON.stringify({password:"fixture-password"})}),cookie=login.headers.get("set-cookie").split(";")[0];
  const apply=(src=origin)=>fetch(origin+"/api/updates/apply",{method:"POST",headers:{cookie,origin:src},body:JSON.stringify({version:tag})});
  assert.equal((await apply("https://foreign.test")).status,403);
  const responses=await Promise.all([apply(),apply()]);assert.deepEqual(responses.map(r=>r.status).sort(),[202,409]);assert.equal(launched,1);
});
