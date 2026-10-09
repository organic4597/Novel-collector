"use strict";
(()=>{
  const UI=window.CollectorUI,$=id=>document.getElementById(id);
  let data=null,epoch=0,loading=false;
  const active=()=>UI.authenticated()&&!document.hidden&&UI.view()==="releases";
  function render(){
    if(!active())return;
    $("release-history-refresh").disabled=loading;
    $("release-history-status").textContent=loading?"업데이트 내역을 불러오는 중…":data?`사용 중인 버전 ${data.currentVersion}`:"";
    const selected=$("release-history-version").value;
    const records=(data?.records||[]).filter(record=>!selected||record.version===selected);
    $("release-history-list").replaceChildren(...(records.length?records.map(record=>{
      const article=UI.node("article","release-record"),heading=UI.node("div","release-record-heading");
      heading.append(UI.node("h2","",record.version+" · "+record.title));
      const status={current:"사용 중",available:"게시된 새 버전",previous:"이전 버전",development:"개발 중"}[record.status];
      heading.append(UI.node("p","muted",status+(record.date?" · "+record.date:"")));article.append(heading);
      for(const group of record.groups){const section=UI.node("section"),list=UI.node("ul");section.append(UI.node("h3","",group.title));
        list.append(...group.items.map(item=>UI.node("li","",item)));section.append(list);article.append(section);}
      if(record.url){const link=UI.node("a","export-link","GitHub 릴리스 열기");link.href=record.url;link.target="_blank";link.rel="noopener noreferrer";article.append(link);}
      return article;
    }):[UI.node("p","empty",loading?"내역을 확인하고 있습니다…":"등록된 업데이트 내역이 없습니다.")]));
  }
  function validate(value){
    if(!value||typeof value.currentVersion!=="string"||!Array.isArray(value.records)||value.records.length>100)throw Error("업데이트 내역 형식을 확인하지 못했습니다.");
    for(const record of value.records){
      if(!/^\d+\.\d+\.\d+\.\d+$/.test(record.version)||typeof record.title!=="string"||!Array.isArray(record.groups)||record.groups.length>20||
        !["current","available","previous","development"].includes(record.status)||record.date!=null&&!/^\d{4}-\d{2}-\d{2}$/.test(record.date))throw Error("업데이트 내역 형식을 확인하지 못했습니다.");
      if(record.url){const url=new URL(record.url);if(url.origin!=="https://github.com"||url.username||url.password||url.search||url.hash||!new RegExp("^/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/tag/"+record.version.replace(/\./g,"\\.")+"$").test(url.pathname))throw Error("릴리스 주소 형식을 확인하지 못했습니다.");}
      for(const group of record.groups)if(typeof group.title!=="string"||!Array.isArray(group.items)||group.items.length>100||group.items.some(item=>typeof item!=="string"||item.length>3000))throw Error("업데이트 내역 형식을 확인하지 못했습니다.");
    }return value;
  }
  async function refresh(){
    if(!active()||loading)return;const own=epoch,generation=UI.generation();loading=true;$("release-history-error").textContent="";render();
    try{const result=validate(await UI.api("/api/updates/history"));if(own!==epoch||generation!==UI.generation()||!active())return;
      const selected=$("release-history-version").value;data=result;
      $("release-history-version").replaceChildren(UI.node("option","","전체 버전"),...data.records.map(record=>{const option=UI.node("option","",record.version+(record.status==="development"?" (개발 중)":""));option.value=record.version;return option;}));
      $("release-history-version").firstChild.value="";$("release-history-version").value=data.records.some(record=>record.version===selected)?selected:"";
    }catch(error){if(own===epoch&&active())$("release-history-error").textContent=UI.textError(error);}
    finally{if(own===epoch){loading=false;render();}}
  }
  $("release-history-refresh").onclick=()=>void refresh();$("release-history-version").onchange=render;
  for(const id of ["update-history-open","update-banner-history"])$(id).onclick=()=>UI.navigate("releases");
  document.addEventListener("collector:view",()=>{epoch++;loading=false;if(active()){render();if(!data)void refresh();}});
  document.addEventListener("collector:auth",()=>{epoch++;loading=false;data=null;$("release-history-list").replaceChildren();$("release-history-version").replaceChildren(UI.node("option","","전체 버전"));$("release-history-version").firstChild.value="";$("release-history-status").textContent="";$("release-history-error").textContent="";if(active())void refresh();});
  document.addEventListener("visibilitychange",()=>{epoch++;loading=false;if(active()){render();if(!data)void refresh();}});
})();
