import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimePaths, runtimeEnvironment, parseArguments, npmCliPath, pythonCandidates, prepareRuntime, runCommand } from "../run.mjs";

test("Windows and Linux select their native Python paths and preserve explicit service settings",()=>{
  const windows=runtimePaths("C:\\Novel Collector","win32");
  assert.equal(windows.python,"C:\\Novel Collector\\.venv-captcha\\Scripts\\python.exe");
  assert.equal(runtimePaths("/opt/novel collector","linux").python,"/opt/novel collector/.venv-captcha/bin/python");
  const env=runtimeEnvironment("C:\\Novel Collector",{HOST:"127.0.0.1",PORT:"9000",PROFILE_DIR:"custom profile"},"win32");
  assert.equal(env.PORT,"9000");assert.equal(env.PROFILE_DIR,"C:\\Novel Collector\\custom profile");
  assert.equal(pythonCandidates("win32")[0][0],"py");
});

test("npm on Windows uses its JavaScript CLI rather than a cmd shell, including spaces",()=>{
  const expected="C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  assert.equal(npmCliPath({nodePath:"C:\\Program Files\\nodejs\\node.exe",platform:"win32",env:{},exists:p=>p===expected}),expected);
});

test("an existing legacy standalone browser profile is reused instead of replacing its session",()=>{
  const root="/opt/novel-collector",legacy=root+"/data/browser-profile";
  const env=runtimeEnvironment(root,{},"linux",file=>file===legacy);
  assert.equal(env.PROFILE_DIR,legacy);
  assert.equal(runtimeEnvironment(root,{PROFILE_DIR:"custom"},"linux",()=>true).PROFILE_DIR,root+"/custom");
});

test("mode parsing makes check and service execution read-only and rejects ambiguous setup",()=>{
  assert.deepEqual(parseArguments(["--check"]),{mode:"check",setup:false});
  assert.deepEqual(parseArguments(["--no-setup"]),{mode:"start",setup:false});
  assert.deepEqual(parseArguments(["--setup"]),{mode:"setup",setup:true});
  assert.throws(()=>parseArguments(["--setup","--no-setup"]),{code:"ARGUMENT_INVALID"});
  assert.throws(()=>parseArguments(["--unknown"]),{code:"ARGUMENT_INVALID"});
});

function harness(platform="linux") {
  const rootDir=platform==="win32"?"C:\\Novel Collector":"/tmp/novel collector";
  const paths=runtimePaths(rootDir,platform),calls=[],logs=[];
  let dependencies=true,python=true,browser=true;
  const hooks={exists:file=>file===paths.bundledBrowser?browser:true,dependenciesReady:async()=>dependencies,
    checkWindowsBrowser:async executable=>{calls.push({command:"headless-probe",args:[executable]});},
    run:async(command,args)=>{
      calls.push({command,args});
      if(args.includes("-c"))return python?{code:0,stdout:JSON.stringify({executable:paths.python,version:[3,11,1],opencv:"4.12.0",numpy:"2.0.2"})}:{code:1,stdout:""};
      if(args.includes("ci")){dependencies=true;return{code:0,stdout:""};}
      return{code:0,stdout:"Chromium test"};
    }};
  return{rootDir,platform,hooks,calls,logs,paths,setDependencies:value=>{dependencies=value;},setPython:value=>{python=value;},setBrowser:value=>{browser=value;},log:message=>logs.push(message)};
}

for(const platform of ["linux","win32"])test(`ready ${platform} preflight starts no installers and passes paths as individual arguments`,async()=>{
  const f=harness(platform);
  const result=await prepareRuntime({...f,nodeVersion:"22.22.2",setup:false,supplied:{PORT:"9000"}});
  assert.equal(result.env.CAPTCHA_PYTHON,f.paths.python);
  assert.equal(result.env.BROWSER_PATH,f.paths.bundledBrowser);
  assert.equal(f.calls.length,2);
  assert.ok(!f.calls.some(c=>c.args.includes("ci")||c.args.includes("install")));
});

test("no-setup fails on missing dependencies without modifying the runtime",async()=>{
  const f=harness();f.setDependencies(false);
  await assert.rejects(prepareRuntime({...f,setup:false,supplied:{}}),{code:"DEPENDENCIES_MISSING"});
  assert.equal(f.calls.length,0);
});

test("normal first-run preparation installs runtime npm packages once and rechecks them",async()=>{
  const f=harness("win32");f.setDependencies(false);
  await prepareRuntime({...f,nodePath:"C:\\Program Files\\nodejs\\node.exe",setup:true,supplied:{}});
  assert.equal(f.calls[0].command,"C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(f.calls[0].args.slice(1),["ci","--omit=dev","--no-audit","--no-fund"]);
  f.calls.length=0;await prepareRuntime({...f,setup:true,supplied:{}});
  assert.equal(f.calls.length,2,"subsequent runs only probe Python and Chromium");
});

test("explicit Python overrides are checked and never installed into automatically",async()=>{
  const f=harness();f.setPython(false);
  await assert.rejects(prepareRuntime({...f,setup:true,supplied:{CAPTCHA_PYTHON:"/custom/python"}}),{code:"PYTHON_MISSING"});
  assert.equal(f.calls.length,1);
});

test("argument arrays retain spaces and shell metacharacters without invoking a shell",async t=>{
  const root=await mkdtemp(join(tmpdir(),"launcher args "));t.after(()=>rm(root,{recursive:true,force:true}));
  const value="path with spaces & literal $(text)";
  const result=await runCommand(process.execPath,["-e","process.stdout.write(JSON.stringify(process.argv[1]))",value],{cwd:root,capture:true});
  assert.equal(result.code,0);assert.equal(JSON.parse(result.stdout),value);
});

test("old Node versions fail before checking or installing packages",async()=>{
  const f=harness();await assert.rejects(prepareRuntime({...f,nodeVersion:"20.0.0"}),{code:"NODE_VERSION"});assert.equal(f.calls.length,0);
});

test("fresh Windows setup creates an isolated uv environment and installs Chromium through Node arguments",async()=>{
  const rootDir="C:\\Novel Collector",paths=runtimePaths(rootDir,"win32"),calls=[];
  const browser="C:\\Novel Collector\\profile\\playwright-browsers\\chromium\\chrome.exe";
  let pythonExists=false,modules=false,browserExists=false;
  const hooks={dependenciesReady:async()=>true,browserPath:async()=>browser,playwrightCli:"C:\\Novel Collector\\node_modules\\playwright\\cli.js",
    checkWindowsBrowser:async executable=>{calls.push({command:"headless-probe",args:[executable]});},
    exists:file=>file===paths.python?pythonExists:file===browser?browserExists:false,
    run:async(command,args)=>{
      calls.push({command,args});
      if(args.includes("-c"))return modules?{code:0,stdout:JSON.stringify({executable:paths.python,version:[3,11,1]})}:{code:1,stdout:""};
      if(args[0]==="venv")pythonExists=true;
      if(args[0]==="pip")modules=true;
      if(args.includes("chromium"))browserExists=true;
      return{code:0,stdout:"ready"};
    }};
  const result=await prepareRuntime({rootDir,platform:"win32",nodePath:"C:\\node\\node.exe",supplied:{},hooks,log:()=>{}});
  assert.equal(result.env.CAPTCHA_PYTHON,paths.python);assert.equal(result.env.BROWSER_PATH,browser);
  assert.ok(calls.some(c=>c.command==="uv.exe"&&c.args[0]==="venv"));
  assert.ok(calls.some(c=>c.command==="uv.exe"&&c.args[0]==="pip"&&c.args.includes(paths.python)));
  assert.ok(calls.some(c=>c.command==="C:\\node\\node.exe"&&c.args[0]===hooks.playwrightCli&&c.args[1]==="install"));
  assert.ok(calls.some(c=>c.command==="headless-probe"&&c.args[0]===browser));
});

test("missing Chromium is reported without downloading anything in no-setup mode",async()=>{
  const f=harness();
  f.hooks.exists=file=>file===f.paths.python;
  f.hooks.browserPath=async()=>"/not-installed/chrome";
  await assert.rejects(prepareRuntime({...f,supplied:{},setup:false}),{code:"BROWSER_MISSING"});
  assert.ok(!f.calls.some(c=>c.args.includes("install")));
});
