import { mkdir,writeFile,rename,rm,readdir,lstat,chown,chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join,dirname,resolve } from "node:path";
import { fileURLToPath,pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createHash,randomUUID } from "node:crypto";
import { prepareRuntime,npmCliPath,runCommand } from "../run.mjs";
import { githubBytes } from "../src/update-network.mjs";
import { atomicJson,exists,MANAGED_SOURCE,assertUpdatePermissions } from "../src/update-files.mjs";
import { APP_VERSION } from "../src/version.mjs";
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const exec=promisify(execFile);
export async function prepareInstallPermissions(root,{uid,gid}){
  if(!Number.isSafeInteger(uid)||uid<=0||!Number.isSafeInteger(gid)||gid<0)throw Error("일반 사용자 또는 서비스 전용 계정을 지정하세요.");
  const directories=new Set(["src","public","tools","tests","docs","deploy",".runtime","node_modules",".venv-captcha","data","secrets","profile",".updates"]);
  async function own(path,privatePath=false){
    const info=await lstat(path);if(info.isSymbolicLink())return;
    await chown(path,privatePath?uid:info.uid,gid);
    const mode=privatePath?(info.mode&0o700):(info.mode&0o7777)|((info.mode&0o700)>>3);
    await chmod(path,mode|(info.isDirectory()?0o2000:0));
    if(info.isDirectory())for(const entry of await readdir(path))await own(join(path,entry),privatePath);
  }
  if((await lstat(root)).isSymbolicLink())throw Error("실제 설치 폴더에서 실행하세요.");
  const info=await lstat(root);await chown(root,info.uid,gid);await chmod(root,(info.mode&0o7777)|0o2070);
  for(const entry of await readdir(root))if(directories.has(entry)||MANAGED_SOURCE.test(entry))await own(join(root,entry),["data","secrets","profile",".updates"].includes(entry));
}
async function installAccount(root,serviceUser){
  if(process.platform!=="linux"){if(serviceUser)throw Error("--service-user는 Linux 설치 옵션입니다.");return null;}
  if(!serviceUser&&process.geteuid?.()===0){
    try{
      const {stdout}=await exec("systemctl",["show","novel-collector.service","--property=User,WorkingDirectory"]);
      const fields=Object.fromEntries(stdout.trim().split("\n").map(line=>{const cut=line.indexOf("=");return[line.slice(0,cut),line.slice(cut+1)];}));
      if(resolve(fields.WorkingDirectory||"/")===resolve(root))serviceUser=fields.User;
    }catch{}
    serviceUser||=process.env.SUDO_USER;
    if(!serviceUser||serviceUser==="root")throw Error("실행 계정을 먼저 준비한 뒤 --service-user <계정>으로 설치하세요.");
  }
  if(!serviceUser)return null;
  if(!/^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$/.test(serviceUser))throw Error("서비스 계정 이름을 확인하세요.");
  const uid=Number((await exec("id",["-u",serviceUser])).stdout.trim()),gid=Number((await exec("id",["-g",serviceUser])).stdout.trim());
  if(uid===0)throw Error("수집기는 root 대신 일반 사용자 또는 서비스 전용 계정으로 실행하세요.");
  if(process.geteuid?.()!==0&&uid!==process.geteuid?.())throw Error("다른 실행 계정의 소유권 준비에는 root 설치 권한이 필요합니다.");
  return{user:serviceUser,uid,gid};
}
export function uvAsset(platform=process.platform,arch=process.arch){
  if(!["x64","arm64"].includes(arch))throw Error("x64/arm64 시스템을 사용하세요.");
  if(platform==="win32")return `uv-${arch==="x64"?"x86_64":"aarch64"}-pc-windows-msvc.zip`;
  if(platform==="linux")return `uv-${arch==="x64"?"x86_64":"aarch64"}-unknown-linux-gnu.tar.gz`;
  throw Error("Windows/Linux 설치만 지원합니다.");
}
export function linuxDependencyCommand(os,platform=process.platform,cli=null,node=process.execPath){
  if(platform!=="linux")return null;
  if(/(?:debian|ubuntu)/i.test(os))return[node,[cli,"install-deps","chromium"]];
  if(/(?:rhel|rocky|almalinux|centos|fedora)/i.test(os))return[os.includes("fedora")?"dnf":"dnf",["install","-y","alsa-lib","atk","at-spi2-atk","cups-libs","libdrm","libXcomposite","libXdamage","libXext","libXfixes","libXrandr","libX11","libxcb","libxkbcommon","mesa-libgbm","nss","nspr","pango","cairo","glib2","libxshmfence","libXScrnSaver","libXtst","fontconfig","freetype","xorg-x11-server-Xvfb","google-noto-sans-cjk-fonts"]];
  throw Error("자동 설치는 Debian/Ubuntu 및 RHEL/Rocky/AlmaLinux/Fedora를 지원합니다.");
}
async function execute(command,args,options){const result=await runCommand(command,args,options);if(result.code!==0)throw Error("설치 명령이 실패했습니다.");}
export async function installRuntime({rootDir=ROOT,skipOsDeps=false,serviceUser=null,env={...process.env}}={}){
  const account=await installAccount(rootDir,serviceUser);
  const runtime=join(rootDir,".runtime"),uvDir=join(runtime,"uv"),uvExe=join(uvDir,process.platform==="win32"?"uv.exe":"uv");await mkdir(runtime,{recursive:true,mode:0o700});
  const available=await runCommand(process.platform==="win32"?"uv.exe":"uv",["--version"],{capture:true,env}).catch(()=>null);
  if(!available||available.code!==0){
    if(!await exists(uvExe)){
      const name=uvAsset(),data=JSON.parse((await githubBytes("https://api.github.com/repos/astral-sh/uv/releases/latest")).bytes),asset=data.assets.find(a=>a.name===name);
      if(!asset||!/^sha256:[a-f0-9]{64}$/.test(asset.digest||""))throw Error("uv 공식 패키지 무결성 정보를 확인하지 못했습니다.");
      const bytes=(await githubBytes(asset.browser_download_url,{limit:64*1024*1024,timeoutMs:120000})).bytes;
      if(createHash("sha256").update(bytes).digest("hex")!==asset.digest.slice(7))throw Error("uv 패키지 무결성 오류");
      const temporary=join(runtime,"uv-install-"+randomUUID());await mkdir(temporary);const archive=join(temporary,name);await writeFile(archive,bytes);
      try{
        if(process.platform==="win32"){
          const quote=value=>"'"+value.replaceAll("'","''")+"'",script="Expand-Archive -LiteralPath "+quote(archive)+" -DestinationPath "+quote(join(temporary,"unpacked"));
          await execute("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")],{cwd:rootDir,env});
        }
        else{await mkdir(join(temporary,"unpacked"));await execute("tar",["-xzf",archive,"-C",join(temporary,"unpacked")],{cwd:rootDir,env});}
        const unpacked=process.platform==="win32"?join(temporary,"unpacked"):join(temporary,"unpacked",name.replace(/\.tar\.gz$/,""));
        await mkdir(uvDir,{recursive:true});await rename(join(unpacked,process.platform==="win32"?"uv.exe":"uv"),uvExe);
      }finally{await rm(temporary,{recursive:true,force:true});}
    }
    env.PATH=uvDir+(process.platform==="win32"?";":":")+env.PATH;
  }
  env.UV_PYTHON_INSTALL_DIR=env.UV_PYTHON_INSTALL_DIR||join(runtime,"python");
  await execute(process.execPath,[npmCliPath({env}),"ci","--omit=dev","--no-audit","--no-fund"],{cwd:rootDir,env});
  if(process.platform==="linux"&&!skipOsDeps){
    const {readFile}=await import("node:fs/promises"),os=await readFile("/etc/os-release","utf8"),require=createRequire(join(rootDir,"package.json")),cli=join(dirname(require.resolve("playwright/package.json")),"cli.js");
    const [command,args]=linuxDependencyCommand(os,"linux",cli);
    if(process.geteuid?.()===0)await execute(command,args,{cwd:rootDir,env});else await execute("sudo",["-n",command,...args],{cwd:rootDir,env});
  }
  await prepareRuntime({rootDir,supplied:env});
  const {sourceManifest}=await import("../src/update-engine.mjs");
  if(!await exists(join(rootDir,".updates","managed-source.json")))await atomicJson(join(rootDir,".updates","managed-source.json"),await sourceManifest(rootDir));
  if(!await exists(join(rootDir,".updates","installed-version.json")))await atomicJson(join(rootDir,".updates","installed-version.json"),{version:APP_VERSION});
  if(account&&process.geteuid?.()===0){
    await prepareInstallPermissions(rootDir,account);
    await exec("runuser",["-u",account.user,"--",process.execPath,join(rootDir,"tools","install-runtime.mjs"),"--check-permissions"],{cwd:rootDir,env});
  }else await assertUpdatePermissions(rootDir);
  console.info("실행 계정의 백업 읽기·소스 및 런타임 교체 권한 확인 완료.");
  console.info("설치 완료. start.sh / start.ps1로 실행하세요.");
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const args=process.argv.slice(2),index=args.indexOf("--service-user");
  const run=async()=>{
    if(args.includes("--check-permissions")){await assertUpdatePermissions(ROOT);console.info("백업·교체 권한 확인 완료.");return;}
    if(index>=0&&(!args[index+1]||args[index+1].startsWith("--")))throw Error("--service-user 뒤에 실행 계정을 지정하세요.");
    await installRuntime({skipOsDeps:args.includes("--skip-os-deps"),serviceUser:index>=0?args[index+1]:null});
  };
  run().catch(error=>{console.error("설치 실패: "+error.message);process.exitCode=1;});
}
