import http from "node:http";
import * as fs from "node:fs/promises";
import {join,resolve,isAbsolute,dirname} from "node:path";
import {homedir} from "node:os";
import {fileURLToPath,pathToFileURL} from "node:url";
import {randomUUID} from "node:crypto";
import {TetherGateway} from "./tether-gateway.mjs";
const OWNER="novel-collector-tether-broker",HOST=new Set(["prepare","connect","status"]),PHONE=new Set(["status","prepare","on","off"]);
const fail=(code,status=503)=>Object.assign(Error("테더링 관리자 연결을 확인하세요."),{code,status});
const safeCode=value=>typeof value==="string"&&/^(?:TETHER|PHONE|HERMES|COLLECTION)_[A-Z0-9_]{1,70}$/.test(value)?value:"TETHER_BROKER_UNAVAILABLE";
const bools=["ready","prepared","closed","usbConnected","tethering","cellular","validated","wifiChanged","egressVerified"];
const identity=info=>({ino:info.ino,dev:info.dev,uid:info.uid});
const same=(a,b)=>!!a&&!!b&&a.ino===b.ino&&a.dev===b.dev&&a.uid===b.uid;
export function publicTetherState(value){
 if(!value||typeof value!=="object"||Array.isArray(value))throw fail("TETHER_BROKER_RESPONSE");
 const out={ok:true};
 for(const key of bools)if(value[key]!==undefined){if(typeof value[key]!=="boolean")throw fail("TETHER_BROKER_RESPONSE");out[key]=value[key];}
 if(value.locked===null||typeof value.locked==="boolean")out.locked=value.locked;
 if(typeof value.phase==="string"&&/^(?:ready|offline|cooldown|reconnecting|verifying|needs_attention)$/.test(value.phase))out.phase=value.phase;
 if(typeof value.reason==="string"&&/^[a-z][a-z0-9_]{0,40}$/.test(value.reason))out.reason=value.reason;
 return out;
}
export class TetherBroker {
 constructor({runtimeDir="/run/novel-collector-tether-broker",gateway=null,...config}={}){
  if(typeof runtimeDir!=="string"||!isAbsolute(runtimeDir)||Buffer.byteLength(join(runtimeDir,"control.sock"))>100||runtimeDir.includes("\0"))throw fail("TETHER_BROKER_CONFIG");
  this.runtimeDir=runtimeDir;this.socketPath=join(runtimeDir,"control.sock");this.ownerPath=join(runtimeDir,"broker-owner.json");
  this.gateway=gateway||new TetherGateway({...config,runtimeDir:join(runtimeDir,"export"),controlSocket:this.socketPath});
  if(!["start","isReady","close","runHost","runPhone"].every(name=>typeof this.gateway[name]==="function"))throw fail("TETHER_BROKER_CONFIG");
  this.server=null;this.sockets=new Set();this.controls=new Set();this.socketIdentity=null;this.claim=randomUUID();
  this.closed=false;this.mutationBusy=false;this.readers=0;this.startWork=null;this.closeWork=null;this.forwardWork=null;this.monitor=null;
 }
 async owner(){
  const info=await fs.lstat(this.ownerPath);
  if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o077)||info.nlink!==1||info.size>8192)throw fail("TETHER_BROKER_OWNERSHIP");
  const value=JSON.parse(await fs.readFile(this.ownerPath,"utf8"));if(value.schema!==1||value.owner!==OWNER)throw fail("TETHER_BROKER_OWNERSHIP");return value;
 }
 async saveOwner(value){
  const temp=this.ownerPath+"."+randomUUID()+".tmp";
  try{await fs.writeFile(temp,JSON.stringify({schema:1,owner:OWNER,...value}),{mode:0o600,flag:"wx"});await fs.rename(temp,this.ownerPath);}
  finally{await fs.unlink(temp).catch(e=>{if(e.code!=="ENOENT")throw e;});}
 }
 async prepare(){
  let fresh=false;
  try{const info=await fs.lstat(this.runtimeDir);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o077))throw fail("TETHER_BROKER_OWNERSHIP");}
  catch(e){if(e.code!=="ENOENT")throw e;await fs.mkdir(this.runtimeDir,{mode:0o700});fresh=true;}
  if(!fresh){
   const names=await fs.readdir(this.runtimeDir);
   if(names.length){
    let owner;try{owner=await this.owner();}catch{throw fail("TETHER_BROKER_OWNERSHIP");}
    if(names.some(n=>!["broker-owner.json","control.sock","export"].includes(n)))throw fail("TETHER_BROKER_OWNERSHIP");
    if(owner.pid){let alive=true;try{process.kill(owner.pid,0);}catch(e){if(e.code==="ESRCH")alive=false;}if(alive)throw fail("TETHER_BROKER_BUSY");}
    try{const old=await fs.lstat(this.socketPath);if(!old.isSocket()||!same(identity(old),owner.socket))throw fail("TETHER_BROKER_OWNERSHIP");await fs.unlink(this.socketPath);}catch(e){if(e.code!=="ENOENT")throw e;}
   }
  }
  await this.saveOwner({pid:process.pid,claim:this.claim,socket:null});
 }
 ensureForward(){
  if(this.closed)return Promise.resolve(false);if(this.forwardWork)return this.forwardWork;
  const task=(async()=>{try{if(!await this.gateway.isReady())await this.gateway.start();return!this.closed&&await this.gateway.isReady();}catch{return false;}})();
  const tracked=task.finally(()=>{if(this.forwardWork===tracked)this.forwardWork=null;});this.forwardWork=tracked;return tracked;
 }
 send(res,status,value){if(!res.destroyed&&!res.writableEnded)res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",Connection:"close"}).end(JSON.stringify(value));}
 async handle(req,res){
  let mutation=false,reader=false,abort;
  try{
   if(this.closed)throw fail("TETHER_BROKER_CLOSED");
   if(req.method!=="POST")throw fail("TETHER_CONTROL_METHOD",405);
   const match=/^\/(host|phone)\/([a-z]+)$/.exec(req.url||"");
   if(!match||!(match[1]==="host"?HOST:PHONE).has(match[2]))throw fail("TETHER_CONTROL_ACTION",404);
   if(req.headers["content-length"]!=="0"||req.headers["transfer-encoding"])throw fail("TETHER_CONTROL_BODY",400);
   const[,kind,action]=match;
   if(action!=="status"){if(this.mutationBusy)throw fail("TETHER_CONTROL_BUSY",409);this.mutationBusy=true;mutation=true;}
   else{if(this.readers>=4)throw fail("TETHER_CONTROL_BUSY",429);this.readers++;reader=true;}
   abort=new AbortController();this.controls.add(abort);
   res.once("close",()=>{if(!res.writableFinished)abort.abort();});
   let result;
   if(kind==="host"&&action==="status"&&!await this.gateway.isReady())result={ready:false,reason:"gateway_offline"};
   else{
    if(mutation&&!await this.ensureForward())throw fail("TETHER_GATEWAY_FORWARD");
    if(this.closed||abort.signal.aborted)throw fail("TETHER_BROKER_CLOSED");
    result=await this.gateway[kind==="host"?"runHost":"runPhone"](action,{signal:abort.signal});
   }
   if(this.closed||abort.signal.aborted)return;
   if(kind==="host"&&action==="prepare"&&result?.prepared!==true)throw fail("TETHER_BROKER_RESPONSE");
   this.send(res,200,publicTetherState(result));
  }catch(e){this.send(res,Number.isSafeInteger(e.status)?e.status:503,{ok:false,code:safeCode(e.code),message:"테더링 제어를 확인하지 못했습니다. 수집을 대기합니다."});}
  finally{if(abort)this.controls.delete(abort);if(mutation)this.mutationBusy=false;if(reader)this.readers--;}
 }
 start(){
  if(this.closed)return Promise.reject(fail("TETHER_BROKER_CLOSED"));if(this.startWork)return this.startWork;
  this.startWork=(async()=>{
   await this.prepare();if(this.closed)throw fail("TETHER_BROKER_CLOSED");
   this.server=http.createServer({maxHeaderSize:4096,requestTimeout:5000,headersTimeout:3000},(req,res)=>{void this.handle(req,res);});
   this.server.maxRequestsPerSocket=1;
   this.server.on("connection",socket=>{this.sockets.add(socket);socket.on("error",()=>{});socket.once("close",()=>this.sockets.delete(socket));});
   await new Promise((done,reject)=>{this.server.once("error",reject);const old=process.umask(0o077);try{this.server.listen(this.socketPath,done);}finally{process.umask(old);}});
   if(this.closed)throw fail("TETHER_BROKER_CLOSED");
   await fs.chmod(this.socketPath,0o600);this.socketIdentity=identity(await fs.lstat(this.socketPath));
   await this.saveOwner({pid:process.pid,claim:this.claim,socket:this.socketIdentity});
   void this.ensureForward();
   this.monitor=setInterval(()=>{void this.ensureForward();},10000);this.monitor.unref();
   return this;
  })();return this.startWork;
 }
 close(){
  if(this.closeWork)return this.closeWork;this.closed=true;clearInterval(this.monitor);
  for(const controller of this.controls)controller.abort();for(const socket of this.sockets)socket.destroy();
  this.closeWork=(async()=>{
   await this.gateway.close();await this.startWork?.catch(()=>{});
   if(this.server?.listening){
    let bound;try{bound=await fs.lstat(this.socketPath);}catch(e){if(e.code!=="ENOENT")throw e;}
    if(bound&&(!bound.isSocket()||!same(identity(bound),this.socketIdentity)))throw fail("TETHER_BROKER_OWNERSHIP");
    await new Promise(resolve=>this.server.close(resolve));
   }
   try{const current=await fs.lstat(this.socketPath);if(current.isSocket()&&same(identity(current),this.socketIdentity))await fs.unlink(this.socketPath);}catch(e){if(e.code!=="ENOENT")throw e;}
   const owner=await this.owner().catch(()=>null);if(owner?.claim===this.claim)await this.saveOwner({pid:null,claim:null,socket:null});
  })();return this.closeWork;
 }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const rootDir=process.env.NC_TETHER_HELPER_ROOT||dirname(dirname(fileURLToPath(import.meta.url)));
 let broker;
 Promise.resolve().then(()=>{
  if(process.getuid?.()!==0)throw fail("TETHER_BROKER_PRIVILEGES");
  broker=new TetherBroker({rootDir,target:process.env.NC_TETHER_EXPORT_TARGET||"",remoteGroup:process.env.NC_TETHER_EXPORT_GROUP||"novelcollector",
   serial:process.env.NC_TETHER_PHONE_SERIAL,python:process.env.NC_TETHER_PYTHON||join(homedir(),".hermes","android_agent",".venv","bin","python"),node:process.execPath});
  process.once("SIGTERM",()=>{void broker.close().then(()=>process.exit(0),()=>process.exit(1));});process.once("SIGINT",()=>{void broker.close().then(()=>process.exit(0),()=>process.exit(1));});
  return broker.start();
 }).then(()=>console.log("TETHER_BROKER_STARTED")).catch(()=>{console.error("TETHER_BROKER_START_FAILED");process.exitCode=1;});
}
