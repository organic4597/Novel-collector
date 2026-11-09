import http from "node:http";
import {lstat} from "node:fs/promises";
import {isAbsolute} from "node:path";
const HOST=new Set(["prepare","connect","status"]),PHONE=new Set(["status","prepare","on","off"]);
const fail=code=>Object.assign(Error("테더링 관리자 연결을 확인하세요. ("+code+")"),{code,status:503});
const safeCode=value=>typeof value==="string"&&/^(?:TETHER|PHONE|HERMES|COLLECTION)_[A-Z0-9_]{1,70}$/.test(value);
export class TetherControl {
 constructor({socketPath="/run/novel-collector-tether/control.sock",ownerUid=0}={}){
  if(typeof socketPath!=="string"||!isAbsolute(socketPath)||Buffer.byteLength(socketPath)>100||socketPath.includes("\0")||
   !Number.isSafeInteger(ownerUid)||ownerUid<0)throw fail("TETHER_CONTROL_CONFIG");
  Object.assign(this,{socketPath,ownerUid});this.closed=false;this.requests=new Set();
 }
 async call(kind,action){
  if(this.closed)throw fail("TETHER_CONTROL_CLOSED");
  if(!(kind==="host"?HOST:PHONE).has(action))throw fail("TETHER_CONTROL_ACTION");
  let info;try{info=await lstat(this.socketPath);}catch{throw fail("TETHER_CONTROL_SOCKET");}
  if(!info.isSocket()||info.isSymbolicLink()||info.uid!==this.ownerUid||(info.mode&0o007))throw fail("TETHER_CONTROL_SOCKET");
  if(this.closed)throw fail("TETHER_CONTROL_CLOSED");
  const timeout=action==="status"?15000:kind==="host"?120000:1900000;
  return new Promise((resolve,reject)=>{
   let settled=false;
   const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);this.requests.delete(req);error?reject(error):resolve(value);};
   const req=http.request({socketPath:this.socketPath,path:"/"+kind+"/"+action,method:"POST",
    headers:{"Content-Length":"0",Accept:"application/json"},agent:false},res=>{
     let size=0;const chunks=[];
     if(!String(res.headers["content-type"]||"").startsWith("application/json")||Number(res.headers["content-length"]||0)>65536){
      res.destroy();finish(fail("TETHER_CONTROL_RESPONSE"));return;
     }
     res.on("data",chunk=>{size+=chunk.length;if(size>65536){res.destroy();finish(fail("TETHER_CONTROL_RESPONSE"));}else chunks.push(chunk);});
     res.on("error",()=>finish(fail(this.closed?"TETHER_CONTROL_CLOSED":"TETHER_CONTROL_UNAVAILABLE")));
     res.on("end",()=>{
      if(this.closed){finish(fail("TETHER_CONTROL_CLOSED"));return;}
      let value;try{value=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{finish(fail("TETHER_CONTROL_RESPONSE"));return;}
      if(!value||typeof value!=="object"||Array.isArray(value)||value.ok!==true||res.statusCode!==200){
       finish(fail(safeCode(value?.code)?value.code:"TETHER_CONTROL_RESPONSE"));return;
      }
      finish(null,value);
     });
    });
   this.requests.add(req);
   const timer=setTimeout(()=>{req.destroy();finish(fail("TETHER_CONTROL_TIMEOUT"));},timeout);timer.unref();
   req.on("error",()=>finish(fail(this.closed?"TETHER_CONTROL_CLOSED":"TETHER_CONTROL_UNAVAILABLE")));
   req.end();
  });
 }
 callHost(action){return this.call("host",action);}
 callPhone(action){return this.call("phone",action);}
 close(){this.closed=true;for(const request of this.requests)request.destroy();this.requests.clear();}
}
