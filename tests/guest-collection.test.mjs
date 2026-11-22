import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.mjs";
import { siteAuthStatus } from "../src/site-auth-status.mjs";

test("guest mode isolates both browser slots and discovery without deleting account profiles", async t => {
  const root=await mkdtemp(join(tmpdir(),"nc-guest-runtime-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const savedProfile=join(root,"data","browser-profile","slot-1");
  await mkdir(savedProfile,{recursive:true});
  await writeFile(join(savedProfile,"profile-sentinel"),"synthetic saved login profile");
  const runtime=await startServer({rootDir:root,host:"127.0.0.1",port:0,runtimeMode:"develop",guestCollection:true});
  t.after(()=>runtime.close());
  assert.equal(runtime.autoAuth.guestOnly,true);
  assert.equal(runtime.scheduler.collector.authenticatePage,null);
  const profile=process.env.PROFILE_DIR??join(root,"data","browser-profile");
  assert.equal(runtime.scheduler.collector.profileDir,join(profile,"guest"));
  assert.equal(runtime.siteBrowser.profileDir,join(profile,"guest"));
  assert.equal(runtime.discovery.profileDir,join(root,"profile","discovery-guest"));
  const status=siteAuthStatus({host:"sbxh9.com",kind:"authentication",held:true},{accounts:runtime.accounts,autoAuth:runtime.autoAuth,recovery:runtime.recovery});
  assert.equal(status.autoLogin.guestOnly,true);
  for(const slot of [1,2])assert.equal(runtime.scheduler.collector.fork(slot).profileDir,join(profile,"guest",`slot-${slot}`));
  assert.equal(await readFile(join(savedProfile,"profile-sentinel"),"utf8"),"synthetic saved login profile");
});

test("direct mobile mode never attaches the host HTTP CAPTCHA retransmitter",async t=>{
  const root=await mkdtemp(join(tmpdir(),"nc-direct-guest-runtime-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const overrides={NC_COLLECTION_TETHER:"1",NC_TETHER_CONTROL_SOCKET:join(root,"absent-control.sock"),NC_TETHER_PROXY_SOCKET:join(root,"absent-proxy.sock"),NC_TETHER_BROWSER_LAUNCHER:"/synthetic/browser-launcher"};
  const before=Object.fromEntries(Object.keys(overrides).map(key=>[key,process.env[key]]));
  Object.assign(process.env,overrides);
  t.after(()=>{for(const[key,value]of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const runtime=await startServer({rootDir:root,host:"127.0.0.1",port:0,runtimeMode:"develop"});
  t.after(()=>runtime.close());
  assert.equal(runtime.scheduler.collector.captchaSupport,null);
  assert.equal(runtime.siteBrowser.captchaSupport,null);
  assert.equal(runtime.scheduler.collector.authenticatePage,null);
  assert.equal(runtime.autoAuth.guestOnly,true);
  const status=siteAuthStatus({host:"sbxh9.com",kind:"captcha",held:true},{accounts:runtime.accounts,autoAuth:runtime.autoAuth,recovery:runtime.recovery});
  assert.equal(status.autoLogin.manualCaptchaOnly,true);
});

test("ordinary browser collection retains its existing login mode by default",async t=>{
  const root=await mkdtemp(join(tmpdir(),"nc-account-runtime-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const runtime=await startServer({rootDir:root,host:"127.0.0.1",port:0,runtimeMode:"develop"});
  t.after(()=>runtime.close());
  assert.equal(runtime.autoAuth.guestOnly,false);
  assert.equal(typeof runtime.scheduler.collector.authenticatePage,"function");
  assert.equal(runtime.siteBrowser.profileDir,process.env.PROFILE_DIR??join(root,"data","browser-profile"));
});
