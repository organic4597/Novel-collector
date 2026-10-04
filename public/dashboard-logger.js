"use strict";
(() => {
  const nativeFetch=window.fetch.bind(window),queue=[];let timer=null,sending=false,epoch=0;
  const ui=()=>window.CollectorUI;
  const redact=text=>String(text).replace(/https?:\/\/[^\s]+/g,"[사이트 주소]").replace(/\bBearer\s+[\w.~-]+/gi,"Bearer [생략]").replace(/\b(?:cookie|token|nonce|proof|password|pin|authorization|api[_-]?key|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,"[인증값 생략]");
  function add(kind,level,message,element=""){
    queue.push({kind,level,message:redact(message).slice(0,4000),element});if(queue.length>100)queue.splice(0,queue.length-100);
    if(ui()?.authenticated()&&!timer)timer=setTimeout(flush,250);
  }
  async function flush(){
    clearTimeout(timer);timer=null;if(sending||!ui()?.authenticated()||!queue.length)return;
    sending=true;const own=epoch,events=queue.splice(0,20);let retry=false;
    try{const response=await nativeFetch("/api/dashboard-log",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({events}),credentials:"same-origin"});if(!response.ok)throw Error("log delivery failed");}
    catch{if(own===epoch&&ui()?.authenticated()){queue.unshift(...events);if(queue.length>100)queue.length=100;retry=true;}}
    finally{sending=false;if(own===epoch&&ui()?.authenticated()&&queue.length)timer=setTimeout(flush,retry?5000:500);}
  }
  const describe=value=>value instanceof Error?value.message:["string","number","boolean"].includes(typeof value)?String(value):"[객체]";
  for(const [method,level] of [["debug","debug"],["log","info"],["info","info"],["warn","warn"],["error","error"]]){
    const original=console[method].bind(console);console[method]=(...args)=>{original(...args);add("console",level,args.map(describe).join(" "));};
  }
  window.addEventListener("error",event=>{
    if(event.target&&event.target!==window)add("resource","error","대시보드 리소스 로딩 실패",event.target.id||event.target.tagName||"resource");
    else add("error","error",event.message||"대시보드 JavaScript 오류");
  },true);
  window.addEventListener("unhandledrejection",event=>add("rejection","error",describe(event.reason)));
  window.fetch=async(...args)=>{try{return await nativeFetch(...args);}catch(e){add("error","error","대시보드 네트워크 요청 실패: "+describe(e));throw e;}};
  document.addEventListener("click",event=>{const el=event.target.closest?.("button,a");if(!el)return;const id=el.id||el.dataset?.action||"control";add("action","info","대시보드 조작: "+id,/^[\w-]{1,80}$/.test(id)?id:"control");},true);
  document.addEventListener("collector:view",event=>add("navigation","info","화면 이동: "+String(event.detail||ui()?.view()||"unknown")));
  document.addEventListener("collector:auth",()=>{epoch++;if(ui()?.authenticated())void flush();else{queue.length=0;clearTimeout(timer);timer=null;}});
  window.CollectorDashboardLog={add,flush};
})();
