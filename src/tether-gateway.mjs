import {execFile,spawn as spawnProcess} from "node:child_process";
import {promisify} from "node:util";
import {createHash,randomUUID} from "node:crypto";
import * as fs from "node:fs/promises";
import {join,posix} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
const execute=promisify(execFile),OWNER="novel-collector-tether-export";
const HOST_ACTIONS=new Set(["prepare","connect","status","close"]),PHONE_ACTIONS=new Set(["status","prepare","on","off"]);
const fail=code=>Object.assign(Error("테더링 관리자 연결을 확인하세요. ("+code+")"),{code,status:503});
const validPath=value=>typeof value==="string"&&value.length<500&&value!=="/"&&/^\/[A-Za-z0-9_./-]+$/.test(value)&&
 posix.normalize(value)===value&&!value.endsWith("/")&&!value.split("/").some(p=>p==="."||p==="..");
const alive=child=>!!child&&child.exitCode===null&&child.signalCode===null;
const identity=info=>({ino:info.ino,dev:info.dev,uid:info.uid});
const same=(a,b)=>!!a&&!!b&&a.ino===b.ino&&a.dev===b.dev&&a.uid===b.uid;
const uid=()=>process.getuid?.()??0;
const runningPid=pid=>{if(!Number.isSafeInteger(pid)||pid<2)throw fail("TETHER_GATEWAY_OWNERSHIP");try{process.kill(pid,0);return true;}catch(e){return e.code!=="ESRCH";}};

export const REMOTE_SOCKET_ADMIN=String.raw`import os,sys,stat,json,grp
base="/run/novel-collector-tether"
try:
 action,group=sys.argv[1:]
 if action not in ("preflight","activate"):raise ValueError()
 gid=grp.getgrnam(group).gr_gid
 parent=os.lstat(base)
 if not stat.S_ISDIR(parent.st_mode) or parent.st_uid!=0 or parent.st_gid!=gid or stat.S_IMODE(parent.st_mode)!=0o2750:raise ValueError()
 if action=="preflight":
  for name in ("control.sock","proxy.sock"):
   if os.path.lexists(base+"/"+name):raise ValueError()
  result={"ready":True,"gid":gid}
 else:
  result={"ready":True,"gid":gid,"sockets":[]}
  for name in ("control.sock","proxy.sock"):
   path=base+"/"+name;fd=os.open(path,os.O_PATH|os.O_NOFOLLOW)
   try:
    before=os.fstat(fd)
    if not stat.S_ISSOCK(before.st_mode) or before.st_uid!=0 or before.st_gid!=gid or before.st_nlink!=1:raise ValueError()
    os.chmod("/proc/self/fd/"+str(fd),0o660)
    after=os.lstat(path)
    if (after.st_dev,after.st_ino)!=(before.st_dev,before.st_ino) or stat.S_IMODE(after.st_mode)!=0o660:raise ValueError()
    result["sockets"].append({"name":name,"ino":after.st_ino,"dev":after.st_dev,"uid":after.st_uid,"gid":after.st_gid,"mode":stat.S_IMODE(after.st_mode)})
   finally:os.close(fd)
 print(json.dumps(result))
except Exception:
 print(json.dumps({"ready":False,"code":"TETHER_GATEWAY_REMOTE_SOCKET_UNSAFE"}));sys.exit(1)
`;
const shellQuote=value=>"'"+value.replace(/'/g,"'\\''")+"'";

export class TetherGateway {
 constructor({target="",remoteGroup="novelcollector",rootDir,serial,python,node,run=execute,spawn=spawnProcess,
  runtimeDir="/run/novel-collector-tether/broker/export",controlSocket="/run/novel-collector-tether/broker/control.sock",
  proxySocket="/run/novel-collector-tether/proxy.sock"}={}) {
  if(typeof target!=="string"||(target&&!/^(?:[A-Za-z_][A-Za-z0-9_-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/.test(target))||
   ![rootDir,python,node,runtimeDir,controlSocket,proxySocket].every(validPath)||! /^[A-Za-z0-9_-]{4,64}$/.test(serial||"")||
   typeof run!=="function"||typeof spawn!=="function"||! /^[a-z_][a-z0-9_-]{0,31}$/.test(remoteGroup))throw fail("TETHER_GATEWAY_CONFIG");
  Object.assign(this,{target,remoteGroup,rootDir,serial,python,node,run,spawn,runtimeDir,controlSocket,proxySocket});
  this.socketPath=proxySocket;this.masterPath=join(runtimeDir,"ssh-control.sock");this.ownerPath=join(runtimeDir,"gateway-owner.json");
  if([this.masterPath,controlSocket,proxySocket].some(p=>Buffer.byteLength(p)>100))throw fail("TETHER_GATEWAY_CONFIG");
  this.fingerprint=createHash("sha256").update(JSON.stringify([target,remoteGroup,rootDir,serial,python,node,controlSocket,proxySocket])).digest("hex");
  this.claim=randomUUID();this.child=null;this.masterIdentity=null;this.closed=false;this.epoch=0;
  this.startWork=null;this.closeWork=null;this.commands=new Set();this.forwardError=null;this.exportReady=false;
 }
 check(epoch=this.epoch){if(this.closed||epoch!==this.epoch)throw fail("TETHER_GATEWAY_CLOSED");}
 async command(file,args,timeout,signal){
  this.check();if(signal?.aborted)throw fail("TETHER_GATEWAY_CANCELLED");const epoch=this.epoch,abort=new AbortController();this.commands.add(abort);
  try{const result=await this.run(file,args,{timeout,maxBuffer:65536,encoding:"utf8",windowsHide:true,signal:signal?AbortSignal.any([abort.signal,signal]):abort.signal,
   env:{...process.env,NC_TETHER_PHONE_SERIAL:this.serial}});this.check(epoch);return result;}
  catch(e){this.check(epoch);throw e;}finally{this.commands.delete(abort);}
 }
 async control(kind,action,{signal}={}){
  this.check();if(!(kind==="host"?HOST_ACTIONS:PHONE_ACTIONS).has(action))throw fail("TETHER_GATEWAY_ACTION");
  const binary=kind==="host"?this.node:this.python,script=this.rootDir+"/src/"+(kind==="host"?"tether-host.mjs":"hermes-tether.py");
  let result;
  try{result=await this.command(binary,[script,action],action==="status"?15000:kind==="host"?120000:1900000,signal);}
  catch(error){if(error.code==="TETHER_GATEWAY_CLOSED")throw error;let value;try{value=JSON.parse(error.stdout);}catch{}
   throw fail(typeof value?.code==="string"&&/^(?:TETHER|PHONE|HERMES|COLLECTION)_[A-Z0-9_]{1,70}$/.test(value.code)?value.code:"TETHER_GATEWAY_COMMAND");}
  let value;try{value=JSON.parse(result.stdout);}catch{throw fail("TETHER_GATEWAY_RESPONSE");}
  if(!value||typeof value!=="object"||Array.isArray(value))throw fail("TETHER_GATEWAY_RESPONSE");
  if(value.ok===false)throw fail(typeof value.code==="string"&&/^(?:TETHER|PHONE|HERMES|COLLECTION)_[A-Z0-9_]{1,70}$/.test(value.code)?value.code:"TETHER_GATEWAY_RESPONSE");
  if(kind==="host"&&action==="prepare"&&value.prepared!==true)throw fail("TETHER_GATEWAY_RESPONSE");
  return value;
 }
 async remoteAdmin(action){
  if(!["preflight","activate"].includes(action))throw fail("TETHER_GATEWAY_ACTION");
  const cmd=["python3","-c",REMOTE_SOCKET_ADMIN,action,this.remoteGroup].map(shellQuote).join(" ");
  let result;try{result=await this.command("ssh",["-T","-o","BatchMode=yes","-o","ConnectTimeout=8",this.target,cmd],15000);}
  catch(e){if(e.code==="TETHER_GATEWAY_CLOSED")throw e;throw fail("TETHER_GATEWAY_REMOTE_SOCKET_UNSAFE");}
  let value;try{value=JSON.parse(result.stdout);}catch{throw fail("TETHER_GATEWAY_RESPONSE");}
  if(value?.ready!==true||!Number.isSafeInteger(value.gid)||value.gid<0)throw fail("TETHER_GATEWAY_REMOTE_SOCKET_UNSAFE");
  if(action==="activate"){
   if(value.gid!==this.remoteGid||!Array.isArray(value.sockets)||value.sockets.length!==2||
    new Set(value.sockets.map(s=>s?.name)).size!==2||value.sockets.some(s=>!["control.sock","proxy.sock"].includes(s?.name)||
     !Number.isSafeInteger(s.ino)||s.ino<1||!Number.isSafeInteger(s.dev)||s.dev<0||s.uid!==0||s.gid!==value.gid||s.mode!==0o660))
     throw fail("TETHER_GATEWAY_REMOTE_SOCKET_UNSAFE");
  }
  return value;
 }
 runHost(action,options){return this.control("host",action,options);}
 runPhone(action,options){return this.control("phone",action,options);}
 async readOwner(){
  const info=await fs.lstat(this.ownerPath);
  if(!info.isFile()||info.isSymbolicLink()||info.uid!==uid()||(info.mode&0o077)||info.nlink!==1||info.size>8192)throw fail("TETHER_GATEWAY_OWNERSHIP");
  const owner=JSON.parse(await fs.readFile(this.ownerPath,"utf8"));
  if(owner.schema!==1||owner.owner!==OWNER||owner.fingerprint!==this.fingerprint)throw fail("TETHER_GATEWAY_OWNERSHIP");
  return owner;
 }
 async writeOwner(value){
  const temp=this.ownerPath+"."+randomUUID()+".tmp";
  try{await fs.writeFile(temp,JSON.stringify({schema:1,owner:OWNER,fingerprint:this.fingerprint,...value}),{mode:0o600,flag:"wx"});await fs.rename(temp,this.ownerPath);}
  finally{await fs.unlink(temp).catch(e=>{if(e.code!=="ENOENT")throw e;});}
 }
 async masterInfo(){try{return await fs.lstat(this.masterPath);}catch(e){if(e.code==="ENOENT")return null;throw e;}}
 async prepareRuntime(){
  let existing=true;
  try{const info=await fs.lstat(this.runtimeDir);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==uid()||(info.mode&0o077))throw fail("TETHER_GATEWAY_OWNERSHIP");}
  catch(e){if(e.code!=="ENOENT")throw e;await fs.mkdir(this.runtimeDir,{mode:0o700});existing=false;}
  if(existing){
   let owner;try{owner=await this.readOwner();}catch{throw fail("TETHER_GATEWAY_OWNERSHIP");}
   if((await fs.readdir(this.runtimeDir)).some(n=>!["gateway-owner.json","ssh-control.sock"].includes(n)))throw fail("TETHER_GATEWAY_OWNERSHIP");
   if((owner.pid&&runningPid(owner.pid))||(owner.claim&&owner.claim!==this.claim&&runningPid(owner.parentPid)))throw fail("TETHER_GATEWAY_BUSY");
   const socket=await this.masterInfo();if(socket){if(!socket.isSocket()||!same(identity(socket),owner.socket))throw fail("TETHER_GATEWAY_OWNERSHIP");await fs.unlink(this.masterPath);}
  }
  await this.writeOwner({pid:null,socket:null,claim:this.claim,parentPid:process.pid});
 }
 start(){
  this.check();if(!this.target)return Promise.resolve(this);if(this.startWork)return this.startWork;
  const epoch=this.epoch;
  const task=(async()=>{try{
   if(await this.isReady())return this;
   if(process.platform!=="linux")throw fail("TETHER_GATEWAY_PLATFORM");
   await this.prepareRuntime();this.check(epoch);
   this.remoteGid=(await this.remoteAdmin("preflight")).gid;this.check(epoch);
   const args=["-T","-N","-M","-S",this.masterPath,"-o","ControlPersist=no","-o","BatchMode=yes","-o","ConnectTimeout=8",
    "-o","ExitOnForwardFailure=yes","-o","ServerAliveInterval=10","-o","ServerAliveCountMax=2","-o","StreamLocalBindUnlink=no",
    "-o","StreamLocalBindMask=0117","-R","/run/novel-collector-tether/proxy.sock:"+this.proxySocket,
    "-R","/run/novel-collector-tether/control.sock:"+this.controlSocket,this.target];
   const child=this.spawn("ssh",args,{stdio:"ignore",windowsHide:true});this.child=child;this.forwardError=null;this.exportReady=false;
   child.on("error",()=>{this.forwardError=true;this.exportReady=false;});child.on("exit",()=>{this.forwardError=true;this.exportReady=false;});
   for(let attempt=0;attempt<120;attempt++){
    this.check(epoch);if(this.forwardError||!alive(child))throw fail("TETHER_GATEWAY_FORWARD");
    const socket=await this.masterInfo();
    if(socket){
     if(!socket.isSocket()||socket.uid!==uid()||(socket.mode&0o077))throw fail("TETHER_GATEWAY_OWNERSHIP");
     this.masterIdentity=identity(socket);
     try{await this.command("ssh",["-T","-S",this.masterPath,"-O","check",this.target],2000);}
     catch(e){if(e.code==="TETHER_GATEWAY_CLOSED")throw e;await delay(100);continue;}
     this.check(epoch);if(this.forwardError||!alive(child))throw fail("TETHER_GATEWAY_FORWARD");
     const remote=await this.remoteAdmin("activate");this.check(epoch);
     if(this.forwardError||!alive(child))throw fail("TETHER_GATEWAY_FORWARD");
     await this.writeOwner({pid:child.pid,socket:this.masterIdentity,claim:this.claim,parentPid:process.pid,remote:remote.sockets});this.exportReady=true;return this;
    }
    await delay(100);
   }
   throw fail("TETHER_GATEWAY_FORWARD");
  }catch(e){await this.stopChild();await this.removeMaster();await this.releaseClaim();throw e.code?.startsWith("TETHER_GATEWAY_")?e:fail("TETHER_GATEWAY_FORWARD");}})();
  const tracked=task.finally(()=>{if(this.startWork===tracked)this.startWork=null;});this.startWork=tracked;return tracked;
 }
 async isReady(){
  if(this.closed)return false;if(!this.target)return true;
  if(this.forwardError||!this.exportReady||!alive(this.child)||!this.masterIdentity)return false;
  const socket=await this.masterInfo().catch(()=>null);return !!socket?.isSocket()&&same(identity(socket),this.masterIdentity);
 }
 async stopChild(){
  const child=this.child;if(!alive(child))return;let timer;
  const stopped=new Promise(resolve=>{child.once("exit",resolve);timer=setTimeout(resolve,1500);});
  child.kill("SIGTERM");await stopped;clearTimeout(timer);if(alive(child))child.kill("SIGKILL");
 }
 async removeMaster(){const socket=await this.masterInfo();if(socket?.isSocket()&&same(identity(socket),this.masterIdentity))await fs.unlink(this.masterPath);this.masterIdentity=null;}
 async releaseClaim(){const owner=await this.readOwner().catch(()=>null);if(owner?.claim===this.claim)await this.writeOwner({pid:null,socket:null,claim:null,parentPid:null});}
 close(){
  if(this.closeWork)return this.closeWork;this.closed=true;++this.epoch;this.exportReady=false;
  for(const command of this.commands)command.abort();
  this.closeWork=(async()=>{await this.stopChild();await this.startWork?.catch(()=>{});await this.removeMaster();await this.releaseClaim().catch(()=>{});})();return this.closeWork;
 }
}
