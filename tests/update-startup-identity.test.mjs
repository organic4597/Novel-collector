import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStartupIdentity } from "../run.mjs";
import { createApp } from "../src/server.mjs";
import { APP_VERSION } from "../src/version.mjs";
import { healthMatches,parseUpdateArguments } from "../tools/update.mjs";

test("health reports startup code identity even when installed metadata later changes",async t=>{
  const root=await mkdtemp(join(tmpdir(),"startup-identity-"));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,".updates"));const record=join(root,".updates","installed-version.json");
  const identity={version:APP_VERSION,channel:"hotfix",commit:"a".repeat(40),baseVersion:APP_VERSION};
  await writeFile(record,JSON.stringify(identity));const loaded=await readStartupIdentity(root,APP_VERSION);
  const app=createApp({store:{},scheduler:{},adminPassword:"fixture-password",updates:{currentVersion:"99.0.0.0"},startupIdentity:loaded});
  await new Promise(r=>app.listen(0,"127.0.0.1",r));t.after(()=>new Promise(r=>app.close(r)));
  await writeFile(record,JSON.stringify({...identity,commit:"b".repeat(40)}));loaded.commit="c".repeat(40);
  const health=await fetch(`http://127.0.0.1:${app.address().port}/api/health`).then(r=>r.json());
  assert.deepEqual(health,{ok:true,version:APP_VERSION,channel:"hotfix",commit:"a".repeat(40)});
  assert.equal(healthMatches(health,identity),true);
  assert.equal(healthMatches(health,{...identity,commit:"b".repeat(40)}),false);
  assert.equal(healthMatches({...health,channel:"develop"},identity),false);
});

test("legacy installed records and mismatched code versions report stable loaded identity",async t=>{
  const root=await mkdtemp(join(tmpdir(),"startup-legacy-"));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,".updates"));const record=join(root,".updates","installed-version.json");
  const stable={version:APP_VERSION,channel:"stable",commit:null,baseVersion:APP_VERSION};
  assert.deepEqual(await readStartupIdentity(root,APP_VERSION),stable);
  await writeFile(record,JSON.stringify({version:APP_VERSION}));assert.deepEqual(await readStartupIdentity(root,APP_VERSION),stable);
  await writeFile(record,JSON.stringify({version:"99.0.0.0",channel:"develop",commit:"a".repeat(40)}));
  assert.deepEqual(await readStartupIdentity(root,APP_VERSION),stable);
  assert.equal(healthMatches({version:APP_VERSION},stable),true);
  assert.equal(healthMatches({version:APP_VERSION},{...stable,channel:"hotfix",commit:"a".repeat(40)}),false);
});

test("updater CLI keeps stable defaults and validates channel and pinned commit",()=>{
  const base=["--root","/collector","--repository","example/repo","--version",APP_VERSION];
  assert.deepEqual(parseUpdateArguments(base),{root:"/collector",repository:"example/repo",version:APP_VERSION,channel:"stable",commit:null,offline:false});
  assert.equal(parseUpdateArguments([...base,"--channel","develop","--commit","a".repeat(40)]).channel,"develop");
  for(const args of [[...base,"--channel","other"],[...base,"--channel","hotfix"],[...base,"--channel","develop","--commit","short"],[...base,"--commit","a".repeat(40)],[...base,"--unknown"],[...base,"--root"]])assert.throws(()=>parseUpdateArguments(args));
});
