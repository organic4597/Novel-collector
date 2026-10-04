"use strict";
(() => {
  const UI=window.CollectorUI,$=id=>document.getElementById(id);let state=null,busy=false,epoch=0,timer=null,restarting=false;
  const alive=()=>UI.authenticated()&&!document.hidden;
  function render(){
    if(!alive()||!state)return;
    $("update-current").textContent=state.currentVersion;$("update-latest").textContent=state.latestVersion||"확인 중";
    $("update-repository").textContent=state.repository;$("update-checked").textContent=state.checkedAt?new Date(state.checkedAt).toLocaleString():"아직 확인하지 않음";
    $("update-notice").hidden=!state.available&&!state.busy&&!restarting;
    $("update-notice-text").textContent=state.busy?state.job.message:state.available?`새 버전 ${state.latestVersion}이 있습니다. 현재 ${state.currentVersion}`:"재시작 완료";
    $("update-error").textContent=state.error|| (state.job.state==="failed"?state.job.message:"");
    $("update-progress").textContent=state.job.message;
    for(const id of ["update-apply","update-banner-apply"])$(id).disabled=busy||state.busy||!state.installable;
    $("update-check").disabled=busy||state.busy;
    $("update-release-link").href=state.releaseUrl;
  }
  function schedule(){clearTimeout(timer);if(alive())timer=setTimeout(()=>void refresh(),state?.busy||restarting?2000:60000);}
  async function refresh(path="/api/updates/status",options={}){
    if(busy||!alive())return;busy=true;const own=epoch,generation=UI.generation();
    try{const result=await UI.api(path,options);if(own!==epoch||generation!==UI.generation()||!alive())return;
      if(result.accepted){restarting=true;state={...state,busy:true,job:{state:"preparing",message:"업데이트 준비 중"}};}
      else{state=result;if(restarting&&["completed","failed","idle"].includes(state.job.state)){restarting=false;if(state.job.state==="completed")location.reload();}}
      render();
    }catch(e){if(own===epoch&&alive()){
      $("update-progress").textContent=restarting?"프로그램 재시작 중입니다. 연결을 다시 확인하고 있습니다.":"업데이트 상태를 확인하지 못했습니다.";
    }}finally{if(own===epoch){busy=false;render();schedule();}}
  }
  const apply=()=>{if(state?.installable&&!state.busy)void refresh("/api/updates/apply",{method:"POST",body:JSON.stringify({version:state.latestVersion})});};
  $("update-apply").onclick=apply;$("update-banner-apply").onclick=apply;$("update-check").onclick=()=>void refresh("/api/updates/check",{method:"POST",body:"{}"});
  document.addEventListener("collector:auth",()=>{epoch++;busy=false;clearTimeout(timer);if(UI.authenticated())void refresh();else{state=null;restarting=false;$("update-notice").hidden=true;$("update-error").textContent="";$("update-progress").textContent="";}});
  document.addEventListener("visibilitychange",()=>{clearTimeout(timer);if(alive())void refresh();});
  if(UI.authenticated())void refresh();
})();
