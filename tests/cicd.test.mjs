import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {nextVersion,releaseFiles,verifyPublishedAssetDigest} from "../tools/ci-release.mjs";
import {validCandidate} from "../tools/deploy-verified-release.mjs";
import {sourcePath} from "../src/update-files.mjs";
const exec=promisify(execFile);
const zipAssetName="Novel-collector-1.0.0.14.zip";
const expectedZipDigest="sha256:"+"a".repeat(64);
const releaseWithDigest=digest=>[{tag_name:"1.0.0.14",assets:[{name:zipAssetName,digest}]}];

test("candidate versions advance numerically without reusing an existing published tag",()=>{
  assert.equal(nextVersion(["1.0.0.7","1.0.0.9","1.0.0.10"]),"1.0.0.11");
  assert.equal(nextVersion(["1.0.0.7","invalid","v1.0.0.100"]),"1.0.0.8");
  assert.throws(()=>nextVersion([]));
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
