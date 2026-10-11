import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {readFile} from "node:fs/promises";
import {promisify} from "node:util";
import {nextVersion,releaseFiles,verifyPublishedAssetDigest,channelNameForBranch,channelArtifactNames,buildChannelManifest,sourceBranchRef,plannedCandidateEnv,channelPublishedAt} from "../tools/ci-release.mjs";
import {validCandidate} from "../tools/deploy-verified-release.mjs";
import {sourcePath} from "../src/update-files.mjs";
const exec=promisify(execFile);
const zipAssetName="Novel-collector-1.0.0.14.zip";
const expectedZipDigest="sha256:"+"a".repeat(64);
const releaseWithDigest=digest=>[{tag_name:"1.0.0.14",assets:[{name:zipAssetName,digest}]}];

test("candidate versions use semantic major minor patch bumps and migrate legacy revisions",()=>{
  assert.equal(nextVersion(["1.0.0.7","1.0.0.9","1.0.0.17"]),"1.0.1");
  assert.equal(nextVersion(["1.0.0.17"],"minor"),"1.1.0");
  assert.equal(nextVersion(["1.0.0.17"],"major"),"2.0.0");
  assert.equal(nextVersion(["1.2.9","1.2.10"],"patch"),"1.2.11");
  assert.equal(nextVersion(["1.2.9"],"minor"),"1.3.0");
  assert.equal(nextVersion(["1.2.9"],"major"),"2.0.0");
  assert.equal(nextVersion(["1.0.0.17","1.0.1"]),"1.0.2");
  assert.equal(nextVersion(["1.0.0.7","invalid","v1.0.0.100"]),"1.0.1");
  assert.throws(()=>nextVersion(["1.0.1"],"revision"));
  assert.throws(()=>nextVersion([]));
});
test("three-part release candidates and hotfix artifacts retain the same provenance checks",()=>{
  const commit="a".repeat(40),sourceSha="b".repeat(40);
  assert.equal(channelNameForBranch("hotfix/1.1.0"),"hotfix");
  assert.equal(channelArtifactNames({channel:"hotfix",baseVersion:"1.1.0",commit}).zipName,`hotfix-1.1.0-${commit}.zip`);
  assert.equal(plannedCandidateEnv({version:"1.1.0",commit,sourceSha,sourceRef:"refs/heads/develop"}).CANDIDATE_VERSION,"1.1.0");
  const manifest={schema:1,channel:"develop-validation",version:"1.1.0",commit,sourceSha,zipSha256:"c".repeat(64)};
  const run={event:"workflow_dispatch",head_branch:"develop",head_sha:sourceSha,status:"completed",conclusion:"success",path:".github/workflows/delivery.yml"};
  assert.equal(validCandidate(manifest,run),true);
  assert.equal(validCandidate({...manifest,version:"1.1.0-beta.1"},run),false);
  assert.equal(buildChannelManifest({channel:"develop",version:"1.1.0",commit,baseVersion:"1.0.0.17",baseCommit:sourceSha,runId:1,repository:"owner/repo",sourceSha:commit,zipName:`develop-${commit}.zip`,zipSha256:"c".repeat(64),summary:"fixture",publishedAt:"2026-01-01T00:00:00Z"}).version,"1.1.0");
});
test("release files exclude automation, local rules and private state while remaining valid for the installed updater",()=>{
  const files=releaseFiles(["run.mjs","src/server.mjs",".github/workflows/delivery.yml","tools/ci-release.mjs","tools/deploy-verified-release.mjs","tests/cicd.test.mjs","AGENTS.md","PATCH-WORKFLOW.md",".ci-local/state.json","data/private.json","secrets/private.txt"]);
  assert.deepEqual(files,["run.mjs","src/server.mjs"]);for(const path of files)assert.equal(sourcePath(path),path);
});
test("only a successful develop push from the correct workflow can authorize operating validation",()=>{
  const manifest={schema:1,channel:"develop-validation",version:"1.0.0.8",commit:"a".repeat(40),sourceSha:"b".repeat(40),zipSha256:"c".repeat(64)};
  const run={event:"push",head_branch:"develop",head_sha:manifest.sourceSha,status:"completed",conclusion:"success",path:".github/workflows/delivery.yml"};
  assert.equal(validCandidate(manifest,run),true);
  for(const patch of [{head_branch:"main"},{conclusion:"failure"},{status:"in_progress"},{head_sha:"d".repeat(40)},{event:"pull_request"},{path:"other.yml"}])assert.equal(validCandidate(manifest,{...run,...patch}),false);
  assert.equal(validCandidate({...manifest,commit:"../escape"},run),false);
});
test("local patch instructions and deployment state are explicitly ignored",async()=>{
  const {stdout}=await exec("git",["check-ignore","AGENTS.md","PATCH-WORKFLOW.md",".ci-local/state.json"]);
  assert.deepEqual(stdout.trim().split("\n"),["AGENTS.md","PATCH-WORKFLOW.md",".ci-local/state.json"]);
});

test("published ZIP digest check waits for GitHub to populate a matching digest",async()=>{
  const waits=[];let calls=0;
  await verifyPublishedAssetDigest(async()=>{
    calls++;
    return calls<3?releaseWithDigest(null):releaseWithDigest(expectedZipDigest);
  },{version:"1.0.0.14",assetName:zipAssetName,expectedDigest:expectedZipDigest,attempts:3,delayMs:5,delay:async ms=>waits.push(ms)});
  assert.equal(calls,3);
  assert.deepEqual(waits,[5,5]);
});

test("published ZIP digest check rejects a concrete mismatch without retrying",async()=>{
  let calls=0;
  await assert.rejects(verifyPublishedAssetDigest(async()=>{
    calls++;
    return releaseWithDigest("sha256:"+"b".repeat(64));
  },{version:"1.0.0.14",assetName:zipAssetName,expectedDigest:expectedZipDigest,attempts:3,delayMs:5,delay:async()=>{throw Error("should not wait");}}),/일치하지 않습니다/);
  assert.equal(calls,1);
});

test("published ZIP digest check fails after bounded missing digest retries",async()=>{
  const waits=[];let calls=0;
  await assert.rejects(verifyPublishedAssetDigest(async()=>{
    calls++;
    return [];
  },{version:"1.0.0.14",assetName:zipAssetName,expectedDigest:expectedZipDigest,attempts:3,delayMs:5,delay:async ms=>waits.push(ms)}),/확인하지 못했습니다/);
  assert.equal(calls,3);
  assert.deepEqual(waits,[5,5]);
});
test("push update channels use immutable source commit artifacts without a formal version bump",()=>{
  const commit="1".repeat(40);
  const channel=channelNameForBranch("develop");
  const names=channelArtifactNames({channel,commit});
  const manifest=buildChannelManifest({channel,version:"1.0.0.16",commit,baseVersion:"1.0.0.15",baseCommit:"2".repeat(40),runId:123,repository:"owner/repo",sourceSha:commit,zipName:names.zipName,zipSha256:"3".repeat(64),summary:"test change",publishedAt:"2026-10-10T00:00:00.000Z"});
  assert.equal(names.zipName,"develop-"+commit+".zip");
  assert.equal(names.manifestName,"develop-"+commit+".json");
  assert.equal(manifest.channel,"develop");
  assert.equal(manifest.version,"1.0.0.16");
  assert.equal(manifest.baseVersion,"1.0.0.15");
});

test("hotfix update channels are tied to the exact stable base version",()=>{
  const commit="4".repeat(40);
  const channel=channelNameForBranch("hotfix/1.0.0.15");
  const names=channelArtifactNames({channel,baseVersion:"1.0.0.15",commit});
  assert.equal(channel,"hotfix");
  assert.equal(names.zipName,"hotfix-1.0.0.15-"+commit+".zip");
  assert.equal(names.manifestName,"hotfix-1.0.0.15-"+commit+".json");
  assert.throws(()=>channelArtifactNames({channel,commit}),/baseVersion/);
});

test("delivery workflow keeps push channels separate from explicit formal releases",async()=>{
  const workflow=await readFile(new URL("../.github/workflows/delivery.yml",import.meta.url),"utf8");
  assert.match(workflow,/branches:\s*\[develop, hotfix\/\*\*\]/);
  assert.match(workflow,/workflow_dispatch:/);
  assert.match(workflow,/node tools\/ci-release\.mjs channel/);
  assert.match(workflow,/if: github\.event_name == 'push'/);
  assert.match(workflow,/if: github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow,/options: \[patch, minor, major\]/);
  assert.match(workflow,/RELEASE_BUMP: \$\{\{ inputs\.bump \}\}/);
});
test("formal validation accepts explicit release dispatch but rejects channel manifests",()=>{
  const manifest={schema:1,channel:"develop-validation",version:"1.0.0.17",commit:"a".repeat(40),sourceSha:"b".repeat(40),zipSha256:"c".repeat(64)};
  const dispatchRun={event:"workflow_dispatch",head_branch:"develop",head_sha:manifest.sourceSha,status:"completed",conclusion:"success",path:".github/workflows/delivery.yml"};
  assert.equal(validCandidate(manifest,dispatchRun),true);
  assert.equal(validCandidate({...manifest,channel:"develop"},dispatchRun),false);
  assert.equal(validCandidate({...manifest,channel:"hotfix",baseVersion:"1.0.0.16"},dispatchRun),false);
  assert.equal(validCandidate(manifest,{...dispatchRun,head_branch:"hotfix/1.0.0.16"}),false);
  assert.equal(validCandidate(manifest,{...dispatchRun,status:"in_progress"}),false);
});
test("channel manifests stay byte-stable across reruns for the same source commit",()=>{
  const commit="5".repeat(40),publishedAt=channelPublishedAt("2026-10-10T01:02:03+09:00");
  const names=channelArtifactNames({channel:"develop",commit});
  const common={channel:"develop",version:"1.0.0.16",commit,baseVersion:"1.0.0.15",baseCommit:"6".repeat(40),runId:456,repository:"owner/repo",sourceSha:commit,zipName:names.zipName,zipSha256:"7".repeat(64),summary:"stable rerun",publishedAt};
  assert.equal(JSON.stringify(buildChannelManifest(common)),JSON.stringify(buildChannelManifest({...common,publishedAt:channelPublishedAt("2026-10-10T01:02:03+09:00")})));
  assert.equal(buildChannelManifest(common).publishedAt,"2026-10-10T01:02:03+09:00");
  assert.throws(()=>channelPublishedAt(new Date().toDateString()),/커밋 시각/);
});

test("formal release prepare records the local candidate without pushing before validation",()=>{
  const env=plannedCandidateEnv({version:"1.0.0.18",commit:"8".repeat(40),sourceSha:"9".repeat(40),sourceRef:"refs/heads/develop"});
  assert.deepEqual(env,{CANDIDATE_VERSION:"1.0.0.18",CANDIDATE_COMMIT:"8".repeat(40),CANDIDATE_SOURCE_SHA:"9".repeat(40),CANDIDATE_SOURCE_REF:"refs/heads/develop"});
  assert.equal(sourceBranchRef(env),"HEAD:refs/heads/develop");
  assert.throws(()=>sourceBranchRef({...env,CANDIDATE_SOURCE_REF:"refs/heads/main"}),/develop/);
});
