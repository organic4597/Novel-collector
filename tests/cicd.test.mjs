import test from "node:test";
import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {nextVersion,releaseFiles} from "../tools/ci-release.mjs";
import {validCandidate} from "../tools/deploy-verified-release.mjs";
import {sourcePath} from "../src/update-files.mjs";
const exec=promisify(execFile);
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
