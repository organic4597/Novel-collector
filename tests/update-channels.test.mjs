import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {Updates} from '../src/updates.mjs';
import {createApp} from '../src/server.mjs';
import {APP_VERSION} from '../src/version.mjs';
import {parseRelease} from '../src/update-network.mjs';
import {channelCandidates,installedIdentity,resolveUpdateRelease,validateUpdateTarget} from '../src/update-channels.mjs';
const repository='example/Novel-collector',commit='a'.repeat(40),baseCommit='b'.repeat(40);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(channel='develop',change={},version=APP_VERSION){
  const zipName=channel==='develop'?`develop-${commit}.zip`:`hotfix-${version}-${commit}.zip`,zip=Buffer.from('fixture zip');
  const manifest={schema:1,channel,version,commit,baseVersion:version,baseCommit,runId:'123',repository,sourceSha:commit,zipName,zipSha256:hash(zip),summary:'검증된 패치',publishedAt:'2026-10-10T00:00:00Z',...change};
  const bytes=Buffer.from(JSON.stringify(manifest)),prefix=`https://github.com/${repository}/releases/download/${version}/`;
  let assetId=0;const asset=(name,data)=>({id:++assetId,created_at:'2026-10-10T00:00:00Z',name,state:'uploaded',size:data.length,digest:`sha256:${hash(data)}`,browser_download_url:prefix+name});
  const release={tag_name:version,assets:[asset(zipName,zip),asset(zipName.replace(/zip$/,'json'),bytes)]};
  const run={id:123,event:'push',status:'completed',conclusion:'success',path:'.github/workflows/delivery.yml',head_sha:commit,head_branch:channel==='develop'?'develop':`hotfix/${version}`,repository:{full_name:repository},head_repository:{full_name:repository}};
  let manifestBytes=bytes;
  const fetcher=async url=>new Response(url.includes('/git/ref/tags/')?JSON.stringify({object:{type:'commit',sha:baseCommit}}):url.includes('/actions/runs/')?JSON.stringify(run):url.endsWith('.json')?manifestBytes:JSON.stringify(release));
  return {fetcher,release,run,manifest,corrupt:()=>{manifestBytes=Buffer.from('{}');}};
}
test('legacy installed identity remains stable and invalid channel or commit is rejected',()=>{
  assert.deepEqual(installedIdentity({version:APP_VERSION}),{version:APP_VERSION,channel:'stable',commit:null,baseVersion:APP_VERSION});
  assert.throws(()=>installedIdentity({version:APP_VERSION,channel:'nightly'}));
  assert.throws(()=>installedIdentity({version:APP_VERSION,channel:'develop',commit:'short'}));
  assert.throws(()=>validateUpdateTarget({version:'99.0.0.0'},{version:'99.0.0.0',commit}));
});
test('stable parsing never selects immutable channel ZIP assets',()=>{
  const f=fixture();assert.equal(parseRelease(f.release,repository).download,null);
});
test('develop and hotfix candidates are pinned to hashed release assets and successful official CI',async()=>{
  for(const channel of ['develop','hotfix']){
    const f=fixture(channel),candidates=await channelCandidates(repository,{channel,baseVersion:APP_VERSION,fetcher:f.fetcher});
    assert.equal(candidates.length,1);assert.equal(candidates[0].commit,commit);assert.equal(candidates[0].download.sha256,f.manifest.zipSha256);
    const result=await resolveUpdateRelease(repository,{channel,version:APP_VERSION,commit,installed:installedIdentity(),fetcher:f.fetcher});
    assert.equal(result.release.id,`${channel}:${APP_VERSION}:${commit}`);
  }
});
test('three-part semantic releases preserve develop and hotfix asset selection and stable return',async()=>{
  const version='1.1.0';
  for(const channel of ['develop','hotfix']){
    const f=fixture(channel,{},version),installed=installedIdentity({version});
    const {release}=await resolveUpdateRelease(repository,{channel,version,commit,installed,fetcher:f.fetcher});
    assert.equal(release.baseVersion,version);assert.equal(release.download.sha256,f.manifest.zipSha256);
    assert.equal(validateUpdateTarget({version},{version,installed:{...installed,channel,commit}}).version,version);
  }
});
test('manifest identity, digest, hotfix base and CI provenance mismatches are rejected',async()=>{
  for(const change of [{sourceSha:baseCommit},{repository:'other/repo'},{zipSha256:'c'.repeat(64)},{commit:'short'},{schema:2},{baseCommit:commit}]){
    const f=fixture('develop',change);await assert.rejects(channelCandidates(repository,{channel:'develop',baseVersion:APP_VERSION,fetcher:f.fetcher}));
  }
  for(const change of [{event:'pull_request'},{head_sha:baseCommit},{head_branch:'main'},{path:'.github/workflows/other.yml'},{head_repository:{full_name:'fork/repo'}}]){
    const f=fixture();Object.assign(f.run,change);await assert.rejects(channelCandidates(repository,{channel:'develop',baseVersion:APP_VERSION,fetcher:f.fetcher}));
  }
  const f=fixture();f.corrupt();await assert.rejects(channelCandidates(repository,{channel:'develop',baseVersion:APP_VERSION,fetcher:f.fetcher}));
  const hotfix=fixture('hotfix',{baseVersion:'1.0.0.1'});await assert.rejects(channelCandidates(repository,{channel:'hotfix',baseVersion:APP_VERSION,fetcher:hotfix.fetcher}));
  const wrongBranch=fixture('hotfix');wrongBranch.run.head_branch='hotfix/other';await assert.rejects(channelCandidates(repository,{channel:'hotfix',baseVersion:APP_VERSION,fetcher:wrongBranch.fetcher}));
  for(const change of [{browser_download_url:'https://github.com/other/repo/manifest.json'},{digest:'sha256:'+'c'.repeat(64)},{size:65537},{state:'new'}]){
    const f=fixture();Object.assign(f.release.assets[1],change);await assert.rejects(channelCandidates(repository,{channel:'develop',baseVersion:APP_VERSION,fetcher:f.fetcher}));
  }
});
function series(count){
  const f=fixture(),manifests=new Map(),runs=new Map(),commits=[];f.release.assets=[];let runRequests=0;
  const prefix=`https://github.com/${repository}/releases/download/${APP_VERSION}/`,zip=Buffer.from('fixture zip');
  for(let index=0;index<count;index++){
    const revision=(index+1).toString(16).padStart(40,'0'),runId=1000+index,zipName=`develop-${revision}.zip`,publishedAt=new Date(Date.parse('2026-10-10T00:00:00Z')+index*1000).toISOString();
    const manifest={...f.manifest,commit:revision,sourceSha:revision,runId,zipName,publishedAt},bytes=Buffer.from(JSON.stringify(manifest));
    for(const [name,data] of [[zipName,zip],[zipName.replace(/zip$/,'json'),bytes]])f.release.assets.push({id:f.release.assets.length+1,created_at:'2026-10-10T00:00:00Z',name,state:'uploaded',size:data.length,digest:`sha256:${hash(data)}`,browser_download_url:prefix+name});
    manifests.set(prefix+zipName.replace(/zip$/,'json'),bytes);runs.set(String(runId),{...f.run,id:runId,head_sha:revision});commits.push(revision);
  }
  const fetcher=async url=>{
    if(manifests.has(url))return new Response(manifests.get(url));
    if(url.includes('/actions/runs/')){runRequests++;return new Response(JSON.stringify(runs.get(url.split('/').at(-1))));}
    return f.fetcher(url);
  };
  return {release:f.release,runs,commits,fetcher,runRequests:()=>runRequests};
}
test('pending or failed official runs are omitted without hiding an older successful patch',async()=>{
  for(const state of [{status:'in_progress',conclusion:null},{status:'completed',conclusion:'failure'}]){
    const f=series(2);Object.assign(f.runs.get('1001'),state);
    const candidates=await channelCandidates(repository,{channel:'develop',fetcher:f.fetcher});assert.deepEqual(candidates.map(c=>c.commit),[f.commits[0]]);
    Object.assign(f.runs.get('1001'),{head_branch:'main'});await assert.rejects(channelCandidates(repository,{channel:'develop',fetcher:f.fetcher}));
  }
});
test('large release history checks only the latest ten observed assets and refuses targets outside that window',async()=>{
  const f=series(105),options={channel:'develop',fetcher:f.fetcher};
  const candidates=await channelCandidates(repository,options);assert.equal(candidates.length,10);assert.deepEqual(candidates.map(c=>c.commit),f.commits.slice(-10).reverse());assert.equal(f.runRequests(),10);
  await assert.rejects(resolveUpdateRelease(repository,{...options,version:APP_VERSION,commit:f.commits[94],installed:installedIdentity()}));
  f.release.assets.at(-1).created_at='invalid';await assert.rejects(channelCandidates(repository,options));
});
test('fixed target rejects stale commits, repeated installed commits and incompatible hotfix bases',async()=>{
  const f=fixture(),options={channel:'develop',version:APP_VERSION,commit,installed:installedIdentity(),fetcher:f.fetcher};
  await assert.rejects(resolveUpdateRelease(repository,{...options,commit:baseCommit}));
  await assert.rejects(resolveUpdateRelease(repository,{...options,installed:{version:APP_VERSION,channel:'develop',commit,baseVersion:APP_VERSION}}));
  const h=fixture('hotfix'),[candidate]=await channelCandidates(repository,{channel:'hotfix',baseVersion:APP_VERSION,fetcher:h.fetcher});
  assert.throws(()=>validateUpdateTarget(candidate,{channel:'hotfix',version:APP_VERSION,commit,installed:{version:'1.0.0.1',channel:'stable',commit:null,baseVersion:'1.0.0.1'}}));
});
test('base tags are peeled safely and invalid or cyclic tag objects cannot authorize a patch',async()=>{
  const f=fixture(),tagSha='c'.repeat(40),options={channel:'develop',baseVersion:APP_VERSION};
  const fetcher=async url=>url.includes('/git/ref/tags/')?new Response(JSON.stringify({object:{type:'tag',sha:tagSha}})):url.includes('/git/tags/')?new Response(JSON.stringify({object:{type:'commit',sha:baseCommit}})):f.fetcher(url);
  assert.equal((await channelCandidates(repository,{...options,fetcher})).length,1);
  for(const object of [{type:'commit',sha:'short'},{type:'tree',sha:baseCommit},{type:'tag',sha:tagSha}]){
    const invalid=async url=>url.includes('/git/')?new Response(JSON.stringify({object})):f.fetcher(url);
    await assert.rejects(channelCandidates(repository,{...options,fetcher:invalid}));
  }
});
async function root(t){const dir=await mkdtemp(join(tmpdir(),'update-channels-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('channel checks stay independent and same-version patch selection is exact and locked',async t=>{
  const dir=await root(t),f=fixture('hotfix');let launches=0,calls=0;
  const child=new EventEmitter();child.unref=()=>{};
  const updates=await new Updates({rootDir:dir,repository,fetcher:async(...args)=>{calls++;return f.fetcher(...args);},clock:()=>100000,launch:target=>{launches++;assert.equal(target.channel,'hotfix');assert.equal(target.commit,commit);return child;}}).load();
  updates.onReady=async()=>{};
  await assert.rejects(updates.apply({channel:'hotfix',version:APP_VERSION,commit}));assert.equal(calls,0);
  const state=await updates.check({channel:'hotfix'});assert.equal(state.available,true);assert.equal(state.installable,true);assert.equal(state.installed.channel,'stable');assert.equal(state.candidates.length,1);
  assert.equal((await updates.status()).available,false);assert.equal(updates.cached.checkedAt,0);
  await assert.rejects(updates.apply({channel:'hotfix',version:APP_VERSION,commit:baseCommit}));
  const results=await Promise.allSettled([updates.apply({channel:'hotfix',version:APP_VERSION,commit}),updates.apply({channel:'hotfix',version:APP_VERSION,commit})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(launches,1);
});
test('already installed patches are excluded while explicit stable return preserves the stable origin floor',async t=>{
  const dir=await root(t),identity={version:APP_VERSION,channel:'hotfix',commit,baseVersion:APP_VERSION};
  await mkdir(join(dir,'.updates'));await writeFile(join(dir,'.updates','installed-version.json'),JSON.stringify(identity));
  const f=fixture('hotfix'),updates=await new Updates({rootDir:dir,repository,fetcher:f.fetcher}).load();
  assert.equal((await updates.check({channel:'hotfix'})).candidates.length,0);
  const stable={version:APP_VERSION};assert.equal(validateUpdateTarget(stable,{version:APP_VERSION,installed:identity}),stable);
  const dev={version:'99.0.0.0',channel:'develop',commit,baseVersion:APP_VERSION};assert.equal(validateUpdateTarget(stable,{version:APP_VERSION,installed:dev}),stable);
  assert.throws(()=>validateUpdateTarget({version:'1.0.0.0'},{version:'1.0.0.0',installed:dev}));
});
test('a refreshed candidate list invalidates an older selected patch and network failure removes patch authorization',async t=>{
  const dir=await root(t),f=fixture();let now=100000;
  const updates=await new Updates({rootDir:dir,repository,clock:()=>now,fetcher:f.fetcher}).load();updates.onReady=async()=>{};
  await updates.check({channel:'develop'});assert.equal((await updates.status({channel:'develop'})).installable,true);
  f.release.assets=[];now+=300000;await updates.check({channel:'develop',force:true});await assert.rejects(updates.apply({channel:'develop',version:APP_VERSION,commit}));
  now+=300000;updates.fetcher=async()=>{throw Error('PRIVATE_CANARY');};const failed=await updates.check({channel:'develop',force:true});
  assert.equal(failed.installable,false);assert.ok(failed.error);assert.ok(!JSON.stringify(failed).includes('PRIVATE_CANARY'));
});
test('update API accepts channel selection and rejects malformed targets without starting workers',async t=>{
  const dir=await root(t),f=fixture(),updates=await new Updates({rootDir:dir,repository,fetcher:f.fetcher}).load();
  const app=createApp({store:{},scheduler:{},adminPassword:'fixture-password',updates});await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.close(r)));
  const origin=`http://127.0.0.1:${app.address().port}`,login=await fetch(origin+'/api/login',{method:'POST',body:JSON.stringify({password:'fixture-password'})}),cookie=login.headers.get('set-cookie').split(';')[0];
  const post=(name,body)=>fetch(origin+'/api/updates/'+name,{method:'POST',headers:{cookie,origin},body:JSON.stringify(body)});
  assert.equal((await post('check',{channel:'develop'})).status,200);
  const state=await fetch(origin+'/api/updates/status?channel=develop',{headers:{cookie}}).then(r=>r.json());assert.equal(state.channel,'develop');assert.equal(state.target.commit,commit);
  for(const body of [{channel:'nightly'},{channel:'develop',version:APP_VERSION,commit:'short'},{version:APP_VERSION,commit},{channel:'hotfix',version:APP_VERSION,commit,unexpected:true}])assert.equal((await post('apply',body)).status,400);
  assert.equal((await post('check',{version:APP_VERSION})).status,400);
  assert.equal((await post('apply',{channel:'develop',version:APP_VERSION,commit:baseCommit})).status,409);
});

for(const channel of ['hotfix','develop'])test(`${channel} restart keeps stable return selectable without announcing the base release again`,async t=>{
  const dir=await root(t),identity={version:APP_VERSION,channel,commit,baseVersion:APP_VERSION};
  await mkdir(join(dir,'.updates'));
  await writeFile(join(dir,'.updates','installed-version.json'),JSON.stringify(identity));
  const release={version:APP_VERSION,url:`https://github.com/${repository}/releases`,download:{url:'fixture'}};
  await writeFile(join(dir,'.updates','release-cache.json'),JSON.stringify({repository,checkedAt:1000,release}));
  let calls=0;const updates=await new Updates({rootDir:dir,repository,clock:()=>1000,fetcher:async()=>{calls++;throw Error('unexpected request');}}).load();
  const state=await updates.check();
  assert.equal(state.available,false);assert.equal(state.installable,true);assert.equal(calls,0);
  assert.equal(state.target.restore,true);assert.equal(state.candidates.length,1);
  assert.equal(validateUpdateTarget(release,{version:APP_VERSION,installed:state.installed}),release);
  updates.cached.release={...release,version:'99.0.0'};
  const newer=await updates.status();assert.equal(newer.available,true);assert.equal(newer.installable,true);assert.notEqual(newer.target.restore,true);
});

for(const channel of ['hotfix','develop'])test(`${channel} newest installed commit does not advertise older selectable patches`,async t=>{
  const dir=await root(t);await mkdir(join(dir,'.updates'));
  await writeFile(join(dir,'.updates','installed-version.json'),JSON.stringify({version:APP_VERSION,channel,commit,baseVersion:APP_VERSION}));
  const updates=await new Updates({rootDir:dir,repository}).load();
  const patch=revision=>({id:`${channel}:${APP_VERSION}:${revision}`,channel,version:APP_VERSION,commit:revision,baseVersion:APP_VERSION,download:{url:'fixture'}});
  updates.caches[channel]={checkedAt:1000,candidates:[patch(commit),patch(baseCommit)],error:null};
  const state=await updates.status({channel});
  assert.equal(state.available,false);assert.equal(state.installable,true);
  assert.deepEqual(state.candidates.map(row=>row.commit),[baseCommit]);
  assert.equal(validateUpdateTarget(patch(baseCommit),{channel,version:APP_VERSION,commit:baseCommit,installed:state.installed}).commit,baseCommit);
  updates.caches[channel].candidates.unshift(patch('c'.repeat(40)));
  const newer=await updates.status({channel});assert.equal(newer.available,true);assert.equal(newer.target.commit,'c'.repeat(40));
});

for(const channel of ['hotfix','develop'])test(`${channel} switching channel at the same source stays manual without a new update notice`,async t=>{
  const dir=await root(t);await mkdir(join(dir,'.updates'));
  await writeFile(join(dir,'.updates','installed-version.json'),JSON.stringify({version:APP_VERSION,channel:channel==='hotfix'?'develop':'hotfix',commit,baseVersion:APP_VERSION}));
  const updates=await new Updates({rootDir:dir,repository}).load();
  updates.caches[channel]={checkedAt:1000,candidates:[{id:`${channel}:${APP_VERSION}:${commit}`,channel,version:APP_VERSION,commit,baseVersion:APP_VERSION,download:{url:'fixture'}}],error:null};
  const state=await updates.status({channel});assert.equal(state.available,false);assert.equal(state.installable,true);assert.equal(state.target.commit,commit);
});
