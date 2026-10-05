"use strict";
(() => {
  const UI=window.CollectorUI,$=id=>document.getElementById(id);
  const states={idle:"대기",preparing:"준비 중",ready:"정상 종료 대기",applying:"적용 중",verifying:"재시작 확인 중",completed:"완료",failed:"실패"};
  const steps={CHECK_VERSION:"업데이트 버전 확인",CHECK_RESTART:"재시작 연결 확인",CHECK_SERVICE_CONFIG:"서비스 설정 확인",CHECK_WRITE_PERMISSION:"쓰기 권한 확인",
    LOCK:"작업 잠금",CHECK_SOURCE:"설치 소스 확인",CHECK_RELEASE:"GitHub 릴리스 확인",DOWNLOAD:"릴리스 다운로드",EXTRACT:"압축 해제",
    SETUP_NPM:"독립 npm 패키지 준비",SETUP_RUNTIME:"Python·Chromium 환경 준비",CHECK_RUNTIME:"실행 환경 확인",CHECK_SERVER:"서버 모듈 확인",
    CHECK_STAGED_RUNTIME:"교체 원본 확인",WAIT_STOP:"기존 프로그램 종료 대기",BACKUP:"로컬 백업",ACTIVATE:"프로그램 교체",
    CHECK_INSTALLED_RUNTIME:"설치 경로 환경 확인",START_SERVER:"새 서버 시작",VERIFY:"새 버전 확인",ROLLBACK:"이전 버전 복구",COMPLETED:"업데이트 완료",REQUEST_APPLY:"업데이트 요청"};
  let state=null,busy=false,epoch=0,timer=null,restarting=false,reconnecting=false,requestError=null;
  let logTimer=null,logBusy=false,logEpoch=0,cursor=0,logHasMore=false;
  const alive=()=>UI.authenticated()&&!document.hidden;
  const logsVisible=()=>alive()&&UI.view?.()==="settings"&&$("update-log-panel").open;
  function render(){
    if(!alive()||!state)return;
    $("update-current").textContent=state.currentVersion;$("update-latest").textContent=state.latestVersion||"확인 중";
    $("update-repository").textContent=state.repository;$("update-checked").textContent=state.checkedAt?new Date(state.checkedAt).toLocaleString():"아직 확인하지 않음";
    $("update-notice").hidden=!state.available&&!state.busy&&!restarting;
    $("update-notice-text").textContent=state.busy?state.job.message:state.available?`새 버전 ${state.latestVersion}이 있습니다. 현재 ${state.currentVersion}`:"재시작 완료";
    $("update-error").textContent=requestError?.message||state.error||(state.job.state==="failed"?state.job.message:"");
    $("update-progress").textContent=reconnecting?"서버 연결을 다시 확인하고 있습니다. 마지막 로그는 유지됩니다.":state.job.message;
    $("update-task-state").textContent=requestError?.action==="apply"&&!state.busy?"시작 실패":reconnecting&&restarting?"재시작 연결 확인 중":states[state.job.state]||state.job.state;
    $("update-task-step").textContent=state.job.step?(steps[state.job.step]||state.job.step):"아직 시작하지 않음";
    for(const id of ["update-apply","update-banner-apply"])$(id).disabled=busy||state.busy||!state.installable;
    $("update-check").disabled=busy||state.busy;
    $("update-release-link").href=state.releaseUrl;
  }
  function schedule(){clearTimeout(timer);if(alive())timer=setTimeout(()=>void refresh(),state?.busy||restarting||requestError?2000:60000);}
  function stopLogs(){clearTimeout(logTimer);logTimer=null;logEpoch++;logBusy=false;}
  function scheduleLogs(){clearTimeout(logTimer);if(logsVisible())logTimer=setTimeout(()=>void refreshLogs(),logHasMore?100:1000);}
  function appendLogs(rows){
    const box=$("update-log"),atBottom=box.scrollTop+box.clientHeight>=box.scrollHeight-24;
    for(const entry of rows){
      if(!Number.isSafeInteger(entry.id)||entry.id<=cursor)continue;
      if(!box.querySelector(".update-log-row"))box.replaceChildren();
      const row=document.createElement("div"),time=document.createElement("time"),text=document.createElement("p");
      row.className="update-log-row";row.dataset.level=entry.level||"info";
      time.textContent=entry.time?new Date(entry.time).toLocaleTimeString():"";
      if(entry.time)time.dateTime=entry.time;
      const detail=entry.details||{},level={error:"오류",warn:"경고",info:"정보",debug:"진단"}[entry.level]||"정보";
      text.textContent=`${level}${detail.step?" · "+(steps[detail.step]||detail.step):""} · ${entry.message||""}${detail.exitCode!=null?" · 종료 코드 "+detail.exitCode:""}`;
      row.append(time,text);box.append(row);cursor=entry.id;
      $("update-log-status").textContent=entry.time?"최근 로그: "+new Date(entry.time).toLocaleString():"작업 로그를 받았습니다.";
    }
    while(box.querySelectorAll(".update-log-row").length>200)box.firstElementChild.remove();
    if(atBottom)box.scrollTop=box.scrollHeight;
  }
  async function refreshLogs(){
    if(logBusy||!logsVisible())return;logBusy=true;const own=logEpoch,generation=UI.generation();
    try{
      const result=await UI.api("/api/updates/log?after="+cursor);
      if(own!==logEpoch||generation!==UI.generation()||!logsVisible())return;
      appendLogs(Array.isArray(result.items)?result.items:[]);logHasMore=!!result.hasMore;
      if(!cursor)$("update-log-status").textContent="아직 기록된 업데이트 로그가 없습니다.";
    }catch{
      if(own===logEpoch&&logsVisible())$("update-log-status").textContent=restarting?"서버 재시작 중 · 마지막 로그 유지 · 연결 재시도 중":"작업 로그 연결을 확인 중입니다. 표시된 로그는 유지합니다.";
    }finally{if(own===logEpoch){logBusy=false;scheduleLogs();}}
  }
  async function refresh(path="/api/updates/status",options={}){
    if(busy||!alive())return;busy=true;const own=epoch,generation=UI.generation();
    try{
      const result=await UI.api(path,options);
      if(own!==epoch||generation!==UI.generation()||!alive())return;
      requestError=null;reconnecting=false;
      if(result.accepted){restarting=true;state={...state,busy:true,job:{state:"preparing",version:state.latestVersion,step:"CHECK_RELEASE",message:"업데이트 준비 중"}};}
      else{
        if(typeof result.currentVersion!=="string"||!result.job||typeof result.job.state!=="string")throw Error("업데이트 상태 형식을 확인하세요.");
        state=result;
        if(restarting&&["completed","failed","idle"].includes(state.job.state)){restarting=false;if(state.job.state==="completed")location.reload();}
      }
      render();void refreshLogs();
    }catch(error){
      if(own===epoch&&alive()){
        requestError={action:path.endsWith("/apply")?"apply":path.endsWith("/check")?"check":"status",message:UI.textError?UI.textError(error):error.message};
        if(requestError.action==="apply")restarting=false;
        else if(restarting)reconnecting=true;
        render();void refreshLogs();
      }
    }finally{if(own===epoch){busy=false;render();schedule();}}
  }
  const apply=()=>{if(state?.installable&&!state.busy){requestError=null;void refresh("/api/updates/apply",{method:"POST",body:JSON.stringify({version:state.latestVersion})});}};
  $("update-apply").onclick=apply;$("update-banner-apply").onclick=apply;$("update-check").onclick=()=>void refresh("/api/updates/check",{method:"POST",body:"{}"});
  document.addEventListener("collector:auth",()=>{
    epoch++;busy=false;clearTimeout(timer);stopLogs();
    if(UI.authenticated())void refresh();
    else{state=null;restarting=reconnecting=false;requestError=null;cursor=0;logHasMore=false;$("update-log").replaceChildren();$("update-log-status").textContent="로그인 후 작업 로그를 확인할 수 있습니다.";$("update-notice").hidden=true;$("update-error").textContent="";$("update-progress").textContent="";}
  });
  document.addEventListener("collector:view",()=>{stopLogs();if(logsVisible())void refreshLogs();});
  $("update-log-panel").addEventListener("toggle",()=>{stopLogs();if(logsVisible())void refreshLogs();});
  document.addEventListener("visibilitychange",()=>{clearTimeout(timer);stopLogs();if(alive()){void refresh();if(logsVisible())void refreshLogs();}});
  if(UI.authenticated())void refresh();
})();
