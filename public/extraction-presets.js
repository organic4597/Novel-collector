"use strict";
(() => {
  const UI=window.CollectorUI,$=id=>document.getElementById(id),labels={listing:"소설 목록",detail:"소설 정보·회차 목록",reader:"회차 본문"};
  const patterns={listing:"/novel",detail:"/novel/{workId}",reader:"/novel/{workId}/{episodeId}"};
  let records=[],editing=null,loading=false,saving=false,epoch=0,workspace,storageKey,bridgeToken,updatedAt=null,returnValue=null;
  const active=()=>UI.authenticated()&&UI.view()==="presets"&&!document.hidden;
  const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,"0")).join("");
  const empty=(name="sbxh9 수집 프리셋",origin="https://sbxh9.com")=>({version:2,name,origin,pages:Object.fromEntries(Object.entries(patterns).map(([kind,pagePattern])=>[kind,{pagePattern,fields:{}}]))});
  function group(input){
    if(input?.version===2)return JSON.parse(JSON.stringify(input));
    if(input?.version!==1)throw Error("지원하는 프리셋 JSON을 확인하세요.");
    const config=empty(input.name,input.origin),kind=input.kind==="catalog"?"detail":input.kind;if(!Object.hasOwn(config.pages,kind))throw Error("페이지 유형을 확인하세요.");
    config.pages[kind]={pagePattern:input.pagePattern,fields:Object.fromEntries(Object.entries(input.fields).map(([key,l])=>[input.kind==="catalog"?({number:"chapterNumber",title:"chapterTitle",url:"chapterUrl"}[key]||key):key,l]))};return config;
  }
  function message(text="",error=""){$("preset-status").textContent=text;$("preset-error").textContent=error;}
  function grant(){
    if(!UI.authenticated())return;
    try{localStorage.setItem("nc-preset-bridge:"+bridgeToken,JSON.stringify({id:editing,storageKey,origin:workspace.origin,createdAt:Date.now()}));}catch{message("","브라우저 저장 권한이 없어 원본에서 서버로 바로 저장하기를 연결하지 못했습니다. JSON 가져오기는 사용할 수 있습니다.");}
  }
  function bookmarklet(){
    workspace.name=$("preset-name").value.trim()||workspace.name;grant();
    $("preset-bookmarklet").href=window.CollectorElementPicker.bookmarklet({preset:workspace,storageKey,bridgeToken,updatedAt,dashboardUrl:new URL("/",location.origin).href,
      kind:$("preset-kind").value,field:$("preset-target-field").value,attribute:$("preset-target-attribute").value,multiple:$("preset-target-multiple").checked});
    $("preset-bookmarklet").textContent=`${workspace.name} · 수집 영역 선택`;
  }
  function tree(){
    const root=$("preset-page-tree");root.replaceChildren();
    for(const [kind,def] of Object.entries(window.CollectorPresetGuide.definitions)){
      const section=UI.node("section","preset-tree-page"),title=UI.node("button","secondary",def.label);title.type="button";
      title.onclick=()=>{$("preset-kind").value=kind;$("preset-kind").dispatchEvent(new Event("change"));};
      section.append(title,UI.node("p","field-help",workspace.origin+workspace.pages[kind].pagePattern));
      const fields=UI.node("div","preset-tree-fields");
      for(const [key,label] of def.fields){
        const saved=workspace.pages[kind].fields[key],button=UI.node("button","quiet",`${saved?"✓ ":"○ "}${label}`);button.type="button";button.dataset.field=key;
        button.title=saved?"고정됨: "+saved.selector:"미지정";button.onclick=()=>{$("preset-kind").value=kind;$("preset-kind").dispatchEvent(new Event("change"));$("preset-target-field").value=key;$("preset-target-field").dispatchEvent(new Event("change"));};fields.append(button);
      }
      section.append(fields);root.append(section);
    }
  }
  function row(record){
    const el=UI.node("article","preset-card"),identity=UI.node("div");
    identity.append(UI.node("h3","",record.name),UI.node("p","muted",`${record.origin} · ${record.fieldCount}개 고정 항목 · ${record.pages?"3개 페이지 유형":"이전 형식 (불러오면 3개 유형으로 변환)"}`));
    const buttons=UI.node("div","heading-actions");for(const [action,label] of [["load","불러오기"],["export","JSON 보기"],["remove","삭제"]]){
      const button=UI.node("button",action==="remove"?"danger":"secondary",label);button.type="button";button.disabled=saving;button.onclick=()=>void act(record.id,action);buttons.append(button);
    }el.append(identity,buttons);return el;
  }
  function render(){
    if(!active())return;
    $("preset-list").replaceChildren(...(records.length?records.map(row):[UI.node("p","muted","아직 서버에 저장한 프리셋이 없습니다.")]));
    $("preset-count").textContent=`${records.length}개 저장`;$("preset-save").textContent=editing?"프리셋 수정 저장":"프리셋 서버 저장";$("preset-cancel-edit").hidden=!editing;
    for(const id of ["preset-save","preset-json","preset-file","preset-kind","preset-name","preset-cancel-edit"])$(id).disabled=saving;
    tree();
  }
  function adopt(config,id=null,key=null,token=null,savedAt=null){
    updatedAt=savedAt;
    workspace=group(config);editing=id;storageKey=key||id||random();bridgeToken=token||random();$("preset-name").value=workspace.name;
    $("preset-json").value=JSON.stringify(workspace,null,2);window.CollectorPresetGuide.render();bookmarklet();render();
  }
  async function refresh(){
    if(!active()||loading)return;loading=true;const own=epoch,generation=UI.generation();
    try{const result=await UI.api("/api/extraction-presets");if(own!==epoch||generation!==UI.generation()||!active())return;records=Array.isArray(result)?result:[];render();}
    catch(e){if(own===epoch&&active())message("",UI.textError(e));}finally{if(own===epoch)loading=false;}
  }
  async function save(input){
    if(saving||!active())return;saving=true;render();const own=epoch,generation=UI.generation();
    try{input=group(input);const result=await UI.api(editing?`/api/extraction-presets/${encodeURIComponent(editing)}`:"/api/extraction-presets",{method:editing?"PUT":"POST",body:JSON.stringify(input)});
      if(own!==epoch||generation!==UI.generation())return;workspace=group(result.config);editing=result.id;updatedAt=result.updatedAt||null;$("preset-name").value=workspace.name;$("preset-json").value=JSON.stringify(workspace,null,2);bookmarklet();
      message("세 페이지의 고정 항목을 서버에 저장했습니다. 실제 수집기의 활성 프리셋 연결은 아직 별도 단계입니다.");await refresh();
    }catch(e){if(own===epoch&&active())message("",UI.textError(e));}finally{if(own===epoch){saving=false;render();}}
  }
  async function act(id,action){
    if(saving||!active())return;saving=true;render();const own=epoch,generation=UI.generation();
    try{if(action==="remove"){
        await UI.api(`/api/extraction-presets/${encodeURIComponent(id)}`,{method:"DELETE"});if(own!==epoch||generation!==UI.generation())return;
        records=records.filter(r=>r.id!==id);if(editing===id)adopt(empty());message("프리셋을 삭제했습니다.");
      }else{const record=await UI.api(`/api/extraction-presets/${encodeURIComponent(id)}`);if(own!==epoch||generation!==UI.generation())return;
        adopt(record.config,action==="load"?id:null,id,null,record.updatedAt);message("프리셋과 세 페이지의 고정 항목을 불러왔습니다. 원본 도구에서도 항목을 선택해 고정 영역을 확인할 수 있습니다.");}
    }catch(e){if(own===epoch&&active())message("",UI.textError(e));}finally{if(own===epoch){saving=false;render();}}
  }
  function acceptReturn(){
    if(!returnValue||!UI.authenticated()||document.hidden)return;const returned=returnValue;returnValue=null;
    try{
      const stored=JSON.parse(localStorage.getItem("nc-preset-bridge:"+returned.token));
      if(!stored||!Number.isFinite(stored.createdAt)||Date.now()-stored.createdAt>86400000||stored.origin!==returned.config.origin)throw Error("원본 저장 연결이 만료되었거나 다른 프리셋입니다. 대시보드에서 북마크를 다시 등록하거나 설정 JSON을 가져오세요.");
      UI.navigate("presets");adopt(returned.config,stored.id,stored.storageKey,returned.token);void save(workspace);
    }catch(e){UI.navigate("presets");message("",UI.textError(e));}
  }
  function readReturn(){
    if(!location.hash.startsWith("#preset-return="))return;
    try{const raw=decodeURIComponent(location.hash.slice("#preset-return=".length));if(raw.length>40000)throw Error();returnValue=JSON.parse(raw);}
    catch{message("","원본에서 반환한 설정 형식을 확인하세요.");}
    history.replaceState(null,"",location.pathname+location.search);acceptReturn();
  }
  $("preset-save").onclick=()=>{let input;try{input=JSON.parse($("preset-json").value);}catch{message("","저장할 고정 항목이나 설정 JSON을 먼저 가져오세요.");return;}input.name=$("preset-name").value.trim()||input.name;void save(input);};
  $("preset-cancel-edit").onclick=()=>{adopt(empty());message();};$("preset-refresh").onclick=refresh;
  $("preset-bookmarklet").onclick=event=>{event.preventDefault();message("이 링크를 북마크바로 끌어 등록한 뒤 원본 페이지에서 실행하세요.");};
  $("preset-kind").addEventListener("change",bookmarklet);$("preset-name").addEventListener("change",bookmarklet);document.addEventListener("preset:guide",bookmarklet);
  document.addEventListener("preset:source",event=>{const url=new URL(event.detail);if(!editing&&!Object.values(workspace.pages).some(p=>Object.keys(p.fields).length))workspace.origin=url.origin;bookmarklet();});
  for(const [button,input,isBookmark] of [["preset-copy-bookmarklet","preset-bookmarklet-code",true],["preset-copy-json","preset-json",false]])$(button).onclick=async()=>{
    if(!active())return;const own=epoch,generation=UI.generation(),text=isBookmark?$("preset-bookmarklet").href:$(input).value;
    try{await navigator.clipboard.writeText(text);if(own===epoch&&generation===UI.generation()&&active())message("복사했습니다.");}
    catch{if(own!==epoch||generation!==UI.generation()||!active())return;$(input).hidden=false;$(input).value=text;$(input).focus();$(input).select();message("표시된 내용을 Ctrl+C로 복사하세요.");}
  };
  $("preset-file").onchange=async()=>{
    const file=$("preset-file").files?.[0];if(!file)return;if(file.size>32768){message("","설정 파일은 최대 32KiB입니다.");return;}const own=epoch,generation=UI.generation();
    try{const input=JSON.parse(await file.text());if(own!==epoch||generation!==UI.generation())return;adopt(input);message("설정을 가져왔습니다. 서버 저장 버튼으로 확정하세요.");}catch(e){if(own===epoch&&active())message("",UI.textError(e));}
  };
  document.addEventListener("collector:view",()=>{epoch++;loading=saving=false;if(active()){render();void refresh();}});
  document.addEventListener("collector:auth",()=>{epoch++;if(!UI.authenticated()){
    records=[];editing=null;loading=saving=false;$("preset-json").value="";$("preset-list").replaceChildren();$("preset-bookmarklet-code").value="";$("preset-bookmarklet-code").hidden=true;$("preset-file").value="";
    workspace=empty();storageKey=random();bridgeToken=random();updatedAt=null;returnValue=null;$("preset-name").value=workspace.name;$("preset-page-tree").replaceChildren();bookmarklet();
    try{for(const key of Object.keys(localStorage))if(key.startsWith("nc-preset-bridge:"))localStorage.removeItem(key);}catch{}
  }else{bookmarklet();acceptReturn();}});
  workspace=empty();storageKey=random();bridgeToken=random();$("preset-name").value=workspace.name;bookmarklet();readReturn();
  window.addEventListener("hashchange",readReturn);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)acceptReturn();});
})();
