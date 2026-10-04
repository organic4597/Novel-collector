import { createServer,createConnection } from "node:net";
import { realpath,mkdir,rm } from "node:fs/promises";
import { createHash,randomBytes,timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { tmpdir,userInfo } from "node:os";
import { atomicJson,readJson,exists,safePath } from "./update-files.mjs";
const failure=(code,message)=>Object.assign(Error(message),{code});
export async function instanceIdentity(root,platform=process.platform){
  const canonical=await realpath(root),name=platform==="win32"?canonical.toLowerCase():canonical;
  const fingerprint=createHash("sha256").update(name+"\0"+userInfo().username).digest("hex");
  const local=join(canonical,".updates","control.sock");
  return{fingerprint,address:platform==="win32"?"\\\\.\\pipe\\novel-collector-"+fingerprint:Buffer.byteLength(local)<100?local:join(tmpdir(),"nc-"+fingerprint.slice(0,32)+".sock")};
}
function same(a,b){if(typeof a!=="string"||typeof b!=="string")return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export async function controlRequest(record,action,{timeoutMs=10000}={}){
  return new Promise((yes,no)=>{
    const socket=createConnection(record.address);let data="",done=false;const fail=()=>{if(done)return;done=true;socket.destroy();no(failure("INSTANCE_CONNECT","기존 인스턴스 종료 연결을 확인하세요."));};socket.setTimeout(timeoutMs,fail);socket.on("error",fail);socket.on("end",()=>{if(!done)fail();});
    socket.on("connect",()=>socket.write(JSON.stringify({token:record.token,action})+"\n"));socket.on("data",chunk=>{data+=chunk;if(data.length>8192)return fail();const cut=data.indexOf("\n");if(cut<0)return;try{const response=JSON.parse(data.slice(0,cut));if(response.fingerprint!==record.fingerprint||response.id!==record.id||!response.ok)return fail();done=true;socket.end();yes(response);}catch{fail();}});
  });
}
export async function stopExisting(root,{timeoutMs=45000}={}){
  const identity=await instanceIdentity(root);await safePath(root,".updates");const record=await readJson(join(root,".updates","instance.json"));
  if(!record){
    const legacy=await readJson(join(root,".updates","server.json"));if(Number.isSafeInteger(legacy?.pid)&&legacy.pid>0){let live=false;try{process.kill(legacy.pid,0);live=true;}catch{}if(live)throw failure("INSTANCE_LEGACY","이전 버전은 정상 종료 연결이 없습니다. 기존 실행 창에서 Ctrl+C로 한 번 종료한 뒤 다시 시작하세요.");}return false;
  }
  if(record.fingerprint!==identity.fingerprint||record.address!==identity.address||!Number.isSafeInteger(record.pid)||record.pid<1)throw failure("INSTANCE_IDENTITY","다른 설치 또는 잘못된 인스턴스 기록은 종료하지 않습니다.");
  try{await controlRequest(record,"identify");}catch(e){let live=false;try{process.kill(record.pid,0);live=true;}catch{}if(live)throw e;await rm(join(root,".updates","instance.json"),{force:true});return false;}
  await controlRequest(record,"stop");
  const started=Date.now();while(Date.now()-started<timeoutMs){
    const current=await readJson(join(root,".updates","instance.json"));if(!current||current.id!==record.id)return true;
    await new Promise(r=>setTimeout(r,100));
  }throw failure("INSTANCE_STOP_TIMEOUT","기존 인스턴스가 정상 종료되지 않아 새 서버 시작을 중단했습니다.");
}
export class InstanceControl{
  constructor({root,onStop,log=()=>{}}){Object.assign(this,{root,onStop,log});this.stopping=false;}
  async listen(){
    await safePath(this.root,".updates");await mkdir(join(this.root,".updates"),{recursive:true,mode:0o700});
    this.record={...await instanceIdentity(this.root),id:randomBytes(16).toString("hex"),token:randomBytes(32).toString("hex"),pid:process.pid};
    const address=this.record.address;
    if(process.platform!=="win32"&&await exists(address)){
      const live=await new Promise(yes=>{const probe=createConnection(address);probe.on("connect",()=>{probe.destroy();yes(true);});probe.on("error",()=>yes(false));});
      if(live)throw failure("INSTANCE_RUNNING","같은 설치의 인스턴스가 이미 실행 중입니다.");await rm(address,{force:true});
    }
    this.server=createServer(socket=>{
      let input="";socket.setTimeout(10000,()=>socket.destroy());socket.on("error",()=>{});socket.on("data",chunk=>{
        input+=chunk;if(input.length>4096)return socket.destroy();const end=input.indexOf("\n");if(end<0)return;
        let request;try{request=JSON.parse(input.slice(0,end));}catch{return socket.destroy();}input="";
        if(!same(request.token,this.record.token)||!["identify","stop"].includes(request.action))return socket.destroy();
        socket.end(JSON.stringify({ok:true,fingerprint:this.record.fingerprint,id:this.record.id,pid:this.record.pid})+"\n");
        if(request.action==="stop"&&!this.stopping){this.stopping=true;this.log({scope:"instance",message:"같은 설치의 기존 인스턴스 정상 종료 요청"});setImmediate(()=>void this.onStop().catch(()=>this.log({scope:"instance",level:"error",message:"기존 인스턴스 정상 종료 실패"})));}
      });
    });
    await new Promise((yes,no)=>{this.server.once("error",no);this.server.listen(address,yes);});
    if(process.platform!=="win32"){const {chmod}=await import("node:fs/promises");await chmod(address,0o600);}
    await atomicJson(join(this.root,".updates","instance.json"),this.record);return this;
  }
  async close(){
    if(this.server)await new Promise(r=>this.server.close(r));
    const current=await readJson(join(this.root,".updates","instance.json"));if(current?.id===this.record?.id){await rm(join(this.root,".updates","instance.json"),{force:true});if(process.platform!=="win32")await rm(this.record.address,{force:true});}
  }
}
