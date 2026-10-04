// Preloaded only for update verification; built-ins work without node_modules.
import { appendFileSync,existsSync,statSync,renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const root=process.env.UPDATER_DIAGNOSTICS_ROOT;
function record(message,code){
  if(!root||!existsSync(join(root,".updates","pending-verification.json")))return;
  const path=join(root,".updates","dashboard-events.jsonl"),safe=String(message||"")
    .replace(/https?:\/\/[^\s]+/g,"[사이트 주소]")
    .replace(/\bBearer\s+[\w.~-]+/gi,"Bearer [생략]")
    .replace(/\b(?:cookie|token|nonce|proof|password|pin|authorization|api[_-]?key|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,"[인증값 생략]")
    .replace(/\b[A-Za-z]:[\\/][^\r\n"'<>]*/g,"[로컬 경로]").replace(/\/(?:home|home1|root|Users)\/[^\s"'<>]+/g,"[로컬 경로]").slice(0,1200);
  try{if(existsSync(path)&&statSync(path).size>2*1024*1024)renameSync(path,path+".previous");appendFileSync(path,JSON.stringify({scope:"update",level:"error",message:safe,details:{step:"START_SERVER",eventId:randomUUID(),...(/^[A-Z0-9_]{1,60}$/.test(code||"")?{errorCode:code}:{})},time:new Date().toISOString()})+"\n",{mode:0o600});}catch{}
}
for(const method of ["error","warn"]){const original=console[method].bind(console);console[method]=(...args)=>{record(args.map(v=>v instanceof Error?v.message:typeof v==="string"?v:"[객체]").join(" "));original(...args);};}
process.on("uncaughtExceptionMonitor",e=>record(e.message,e.code));
