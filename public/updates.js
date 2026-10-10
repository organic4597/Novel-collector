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
  let channel="stable",selectedId="",awaitingCheck=false,pendingAction=null;
  const channels={stable:"정식",develop:"실험판",hotfix:"핫픽스"};
  const hints={stable:"검증된 정식 릴리스를 선택합니다.",develop:"실험판은 개발 중인 코드이며 불안정할 수 있습니다. 확인된 소스 커밋을 선택하세요.",hotfix:"현재 정식 버전의 수정본을 선택합니다. 프로그램 버전은 유지되고 수정 커밋이 바뀝니다."};
  const alive=()=>UI.authenticated()&&!document.hidden;
  const logsVisible=()=>alive()&&UI.view?.()==="settings"&&$("update-log-panel").open;
  const label=target=>`${target.version} · ${channels[target.channel]||target.channel}${typeof target.commit==="string"&&target.commit?" · "+target.commit.slice(0,7):""}`;
  function candidates(){
    if(!state||awaitingCheck)return [];
    if(Array.isArray(state.candidates))return state.candidates.filter(c=>c&&c.channel===channel&&typeof c.version==="string"&&typeof c.id==="string"&&(channel==="stable"||typeof c.commit==="string"&&/^[a-f0-9]{40}$/i.test(c.commit)));
    return channel==="stable"&&state.installable&&state.latestVersion?[{id:"stable:"+state.latestVersion,channel,version:state.latestVersion,commit:null,url:state.releaseUrl}]:[];
  }
  const selected=()=>candidates().find(c=>c.id===selectedId);
  function renderOptions(){
    const items=candidates(),select=$("update-candidate");
    if(!items.some(c=>c.id===selectedId))selectedId=items[0]?.id||"";
    select.replaceChildren();
    if(!items.length){const option=document.createElement("option");option.value="";option.textContent=awaitingCheck||!state?.checkedAt?"먼저 업데이트를 확인하세요.":"적용할 업데이트가 없습니다.";select.append(option);}
    for(const item of items){const option=document.createElement("option");option.value=item.id;option.textContent=label(item);select.append(option);}
    select.value=selectedId;select.disabled=busy||!!state?.busy||!items.length;
    $("update-channel").value=channel;$("update-channel").disabled=!!state?.busy||restarting||pendingAction==="apply";
    $("update-channel-help").textContent=hints[channel];$("update-channel-help").dataset.warning=String(channel==="develop");
    const target=selected();$("update-candidate-summary").textContent=target?.summary||"";
    $("update-check").textContent=target?"선택한 업데이트 적용":"지금 확인";
    $("update-check").disabled=busy||!!state?.busy||restarting||(!!target&&!state.installable)||(!target&&!!state?.candidates?.length);
    if(target?.url)$("update-release-link").href=target.url;
  }
  function render(){
    if(!alive()||!state)return;
    $("update-current").textContent=state.installed?label(state.installed):state.currentVersion;$("update-latest").textContent=state.latestVersion||"아직 확인하지 않음";
    $("update-repository").textContent=state.repository;$("update-checked").textContent=state.checkedAt?new Date(state.checkedAt).toLocaleString():"아직 확인하지 않음";
    $("update-notice").hidden=!state.available&&!state.busy&&!restarting;
    const target=selected()||candidates()[0];
    $("update-notice-text").textContent=state.busy?state.job.message:state.available?`업데이트 ${target?label(target):state.latestVersion}이 있습니다. 현재 ${state.currentVersion}`:"재시작 완료";
    $("update-error").textContent=requestError?.message||state.error||(state.job.state==="failed"?state.job.message:"");
    $("update-progress").textContent=reconnecting?"서버 연결을 다시 확인하고 있습니다. 마지막 로그는 유지됩니다.":state.job.message;
    $("update-task-state").textContent=requestError?.action==="apply"&&!state.busy?"시작 실패":reconnecting&&restarting?"재시작 연결 확인 중":states[state.job.state]||state.job.state;
    $("update-task-step").textContent=state.job.step?(steps[state.job.step]||state.job.step):"아직 시작하지 않음";
    for(const id of ["update-apply","update-banner-apply"])$(id).disabled=false;
    $("update-release-link").href=state.releaseUrl;
    renderOptions();
  }
  function schedule(){clearTimeout(timer);if(alive()&&!awaitingCheck)timer=setTimeout(()=>void refresh(),state?.busy||restarting||requestError?2000:60000);}
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
    if(busy||!alive()||(awaitingCheck&&path==="/api/updates/status"))return;
    const action=path.endsWith("/apply")?"apply":path.endsWith("/check")?"check":"status";
    busy=true;pendingAction=action;render();const own=epoch,generation=UI.generation();
    try{
      const result=await UI.api(action==="status"?path+"?channel="+channel:path,options);
      if(own!==epoch||generation!==UI.generation()||!alive())return;
      requestError=null;reconnecting=false;
      if(result.accepted){restarting=true;state={...state,busy:true,job:{state:"preparing",version:selected()?.version||state.latestVersion,step:"CHECK_RELEASE",message:"업데이트 준비 중"}};}
      else{
        if(typeof result.currentVersion!=="string"||!result.job||typeof result.job.state!=="string")throw Error("업데이트 상태 형식을 확인하세요.");
        if(result.channel&&result.channel!==channel)throw Error("선택한 업데이트 모드의 상태를 다시 확인하세요.");
        awaitingCheck=false;state=result;
        if(restarting&&["completed","failed","idle"].includes(state.job.state)){restarting=false;if(state.job.state==="completed")location.reload();}
      }
      render();void refreshLogs();
    }catch(error){
      if(own===epoch&&alive()){
        requestError={action,message:UI.textError?UI.textError(error):error.message};
        if(requestError.action==="apply")restarting=false;
        else if(restarting)reconnecting=true;
        render();void refreshLogs();
      }
    }finally{if(own===epoch){busy=false;pendingAction=null;render();schedule();}}
  }
  function openOptions(fromBanner=false){
    if(fromBanner)UI.navigate?.("settings");
    const open=fromBanner||$("update-options").hidden;$("update-options").hidden=!open;
    for(const id of ["update-apply","update-banner-apply"])$(id).setAttribute("aria-expanded",String(open));
    if(open)$("update-channel").focus();
  }
  $("update-apply").onclick=()=>openOptions();$("update-banner-apply").onclick=()=>openOptions(true);
  $("update-channel").onchange=()=>{
    if(state?.busy||restarting||pendingAction==="apply")return;
    channel=$("update-channel").value;if(!channels[channel])channel="stable";
    epoch++;busy=false;pendingAction=null;clearTimeout(timer);selectedId="";awaitingCheck=true;requestError=null;
    if(state)state={...state,channel,available:false,installable:false,latestVersion:null,candidates:[],checkedAt:null,error:null};
    render();
  };
  $("update-candidate").onchange=()=>{if(busy||state?.busy||restarting)return;selectedId=$("update-candidate").value;epoch++;render();schedule();};
  $("update-check").onclick=()=>{
    if(busy||state?.busy||restarting||!alive())return;
    const target=selected();
    if(target){
      if(!state.installable||!window.confirm(`${label(target)}을 적용할까요?${channel==="develop"?"\n실험판은 불안정할 수 있습니다.":""}\n로컬 백업 후 교체·재시작합니다. DB·계정·프로필은 유지됩니다.`))return;
      requestError=null;void refresh("/api/updates/apply",{method:"POST",body:JSON.stringify({channel,version:target.version,commit:target.commit||null})});
    }else void refresh("/api/updates/check",{method:"POST",body:JSON.stringify({channel})});
  };
  $("update-options").addEventListener("keydown",event=>{if(event.key==="Escape"){openOptions();$("update-apply").focus();}});
  document.addEventListener("collector:auth",()=>{
    epoch++;busy=false;pendingAction=null;clearTimeout(timer);stopLogs();
    if(UI.authenticated())void refresh();
    else{state=null;channel="stable";selectedId="";awaitingCheck=false;restarting=reconnecting=false;requestError=null;cursor=0;logHasMore=false;$("update-log").replaceChildren();$("update-log-status").textContent="로그인 후 작업 로그를 확인할 수 있습니다.";$("update-notice").hidden=true;$("update-options").hidden=true;for(const id of ["update-apply","update-banner-apply"])$(id).setAttribute("aria-expanded","false");$("update-error").textContent="";$("update-progress").textContent="";}
  });
  document.addEventListener("collector:view",()=>{stopLogs();if(logsVisible())void refreshLogs();});
  $("update-log-panel").addEventListener("toggle",()=>{stopLogs();if(logsVisible())void refreshLogs();});
  document.addEventListener("visibilitychange",()=>{clearTimeout(timer);stopLogs();if(alive()){void refresh();if(logsVisible())void refreshLogs();}});
  if(UI.authenticated())void refresh();
})();
