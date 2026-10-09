"use strict";
(() => {
  const UI=window.CollectorUI,$=id=>document.getElementById(id),labels={listing:"소설 목록",detail:"소설 정보·회차 목록",reader:"회차 본문"};
  const patterns={listing:"/novel",detail:"/novel/{workId}",reader:"/novel/{workId}/{episodeId}"};
  let records=[],defaultRecords=[],defaultError="",editing=null,loading=false,saving=false,epoch=0,workspace,storageKey,bridgeToken,updatedAt=null,returnValue=null;
  let bindings=[],bindingAvailable=false,checks={},readRevision=0,dirty=false;
  const pageKinds=["listing","detail","reader"];
  function bindingData(value){
    if(!value||value.version!==1||!Array.isArray(value.bindings)||value.bindings.length>100||value.bindings.some(item=>!item||typeof item.presetId!=="string"||!item.presetId||typeof item.origin!=="string"||!["novel","webtoon"].includes(item.contentType)||(item.validated!==undefined&&typeof item.validated!=="boolean")))throw Error("프리셋 적용 상태를 확인하지 못했습니다.");
    return value.bindings;
  }
  const bound=(id,origin,contentType)=>bindings.find(item=>item.presetId===id&&item.origin===origin&&item.contentType===contentType);
  const active=()=>UI.authenticated()&&UI.view()==="presets"&&!document.hidden;
  const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,"0")).join("");
  const typeOf=config=>config.contentType||"novel";
  const hasFields=()=>Object.values(workspace.pages).some(page=>Object.keys(page.fields).length||Object.keys(page.actions||{}).length);
  const empty=(name="sbxh9 수집 프리셋",origin="https://sbxh9.com",contentType="novel",version=contentType==="webtoon"?3:2)=>{
    if(version===2)return{version:2,name,origin,pages:Object.fromEntries(Object.entries(patterns).map(([kind,pagePattern])=>[kind,{pagePattern,fields:{}}]))};
    const paths=contentType==="webtoon"?{listing:["/ing","/end"],detail:["/webtoon/{workId}"],reader:["/webtoon/{workId}/{episodeId}"]}:Object.fromEntries(Object.entries(patterns).map(([kind,path])=>[kind,[path]]));
    const pages=Object.fromEntries(Object.entries(paths).map(([kind,pagePatterns])=>[kind,{pagePatterns,fields:{}}]));
    pages.listing.sources=contentType==="webtoon"?{ongoing:"/ing",completed:"/end"}:{ongoing:"/novel"};
    return{version:3,contentType,name,origin,catalogOrder:"newest-first",pages};
  };
  const formatError=()=>Error("프리셋 설정 형식을 확인하세요. 허용된 선택자·경로만 저장합니다.");
  function exact(value,keys){if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw formatError();}
  function path(value){if(typeof value!=="string"||!value.startsWith("/")||value.startsWith("//")||value.length>300||/[?#\\\x00-\x1f<>]/.test(value))throw formatError();return value;}
  function validateV3(input){
    exact(input,["version","contentType","name","origin","catalogOrder","pages"]);
    if(!["novel","webtoon"].includes(input.contentType)||typeof input.name!=="string"||!input.name.trim()||input.name.length>80||/[\x00-\x1f]/.test(input.name))throw formatError();
    const origin=new URL(input.origin);if(origin.protocol!=="https:"||origin.username||origin.password||origin.port||origin.pathname!=="/"||origin.search||origin.hash)throw formatError();
    if(!["oldest-first","newest-first"].includes(input.catalogOrder))throw formatError();
    exact(input.pages,["listing","detail","reader"]);const definitions=window.CollectorPresetGuide.definitionsFor(input);
    for(const kind of ["listing","detail","reader"]){
      const page=input.pages[kind],allowed=definitions[kind].fields.map(field=>field[0]);
      exact(page,["pagePatterns","fields","actions",...(kind==="listing"?["sources"]:[])]);
      if(!Array.isArray(page.pagePatterns)||!page.pagePatterns.length||page.pagePatterns.length>8)throw formatError();page.pagePatterns.forEach(path);
      exact(page.fields,allowed.filter(key=>!key.startsWith("actions.")));
      if(page.sources!==undefined){exact(page.sources,["ongoing","completed","search"]);Object.values(page.sources).forEach(path);}
      if(kind==="listing"&&input.contentType==="webtoon"&&page.sources===undefined)throw formatError();
      if(page.actions!==undefined)exact(page.actions,allowed.filter(key=>key.startsWith("actions.")).map(key=>key.slice(8)));
      for(const [key,l] of [...Object.entries(page.fields),...Object.entries(page.actions||{}).map(([key,l])=>["actions."+key,l])]){
        exact(l,["selector","shadowPath","attribute","multiple","relativeTo"]);
        const selectors=[l.selector,...(l.shadowPath||[])];
        if((l.shadowPath!==undefined&&(!Array.isArray(l.shadowPath)||l.shadowPath.length>8))||selectors.some(s=>typeof s!=="string"||!s.trim()||s.length>1024||/[\x00-\x1f]|javascript:|\b(?:cookie|token|nonce|proof|password|authorization)\s*[:=]/i.test(s)||/\[\s*(?:value|password|token|nonce|proof|cookie|authorization)(?:\s|[~|^$*]?=|\])/i.test(s)))throw formatError();
        if(!["text","href","src","data-src","imageUrl"].includes(l.attribute)||typeof l.multiple!=="boolean")throw formatError();
        const attributes=["url","chapterUrl"].includes(key)?["href"]:key==="thumbnail"?["src","data-src","imageUrl"]:key==="images"?["imageUrl"]:["text"];
        if(!key.startsWith("actions.")&&!attributes.includes(l.attribute))throw formatError();
        const parent=kind==="listing"&&!key.startsWith("actions.")&&key!=="items"?"items":kind==="detail"&&["chapterTitle","chapterUrl","chapterLabel","notReady","seasonLabel","seasonNumber"].includes(key)?"rows":kind==="reader"&&key==="images"?"root":null;
        if(l.relativeTo!==undefined&&(l.relativeTo!==parent||!page.fields[parent]))throw formatError();
        if(["items","rows"].includes(key)&&!l.multiple)throw formatError();
        if(kind==="reader"&&key==="root"&&l.multiple)throw formatError();
        if(key==="images"&&(l.attribute!=="imageUrl"||!l.multiple||l.relativeTo!=="root"||!page.fields.root))throw formatError();
      }
    }
    if(new Blob([JSON.stringify(input)]).size>32768)throw formatError();return JSON.parse(JSON.stringify(input));
  }
  function group(input){
    if(input?.version===3)return validateV3(input);
    if(input?.version===2)return JSON.parse(JSON.stringify(input));
    if(input?.version!==1)throw Error("지원하는 프리셋 JSON을 확인하세요.");
    const config=empty(input.name,input.origin),kind=input.kind==="catalog"?"detail":input.kind;if(!Object.hasOwn(config.pages,kind))throw Error("페이지 유형을 확인하세요.");
    config.pages[kind]={pagePattern:input.pagePattern,fields:Object.fromEntries(Object.entries(input.fields).map(([key,l])=>[input.kind==="catalog"?({number:"chapterNumber",title:"chapterTitle",url:"chapterUrl"}[key]||key):key,l]))};return config;
  }
  function message(text="",error=""){$("preset-status").textContent=text;$("preset-error").textContent=error;}
  function grant(){
    if(!UI.authenticated())return;
    try{localStorage.setItem("nc-preset-bridge:"+bridgeToken,JSON.stringify({id:editing,storageKey,origin:workspace.origin,contentType:typeOf(workspace),version:workspace.version,createdAt:Date.now()}));}catch{message("","브라우저 저장 권한이 없어 원본에서 서버로 바로 저장하기를 연결하지 못했습니다. JSON 가져오기는 사용할 수 있습니다.");}
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
      section.append(title,UI.node("p","field-help",workspace.origin+" · "+(workspace.pages[kind].pagePatterns?.join(", ")||workspace.pages[kind].pagePattern)));
      const fields=UI.node("div","preset-tree-fields");
      for(const [key,label] of def.fields){
        const saved=key.startsWith("actions.")?workspace.pages[kind].actions?.[key.slice(8)]:workspace.pages[kind].fields[key],button=UI.node("button","quiet",`${saved?"✓ ":"○ "}${label}`);button.type="button";button.dataset.field=key;
        button.title=saved?"고정됨: "+saved.selector:"미지정";button.onclick=()=>{$("preset-kind").value=kind;$("preset-kind").dispatchEvent(new Event("change"));$("preset-target-field").value=key;$("preset-target-field").dispatchEvent(new Event("change"));};fields.append(button);
      }
      section.append(fields);root.append(section);
    }
  }
  function row(record){
    const el=UI.node("article","preset-card"),identity=UI.node("div");
    identity.append(UI.node("h3","",record.name),UI.node("p","muted",`${record.contentType==="webtoon"?"웹툰":"소설"} · ${record.origin} · ${record.fieldCount}개 고정 항목 · ${record.pages?"3개 페이지 유형":"이전 형식 (불러오면 3개 유형으로 변환)"}`));
    const buttons=UI.node("div","heading-actions");for(const [action,label] of [["load","불러오기"],["export","JSON 보기"],["remove","삭제"]]){
      const applied=bound(record.id,record.origin,record.contentType||"novel");
      const button=UI.node("button",action==="remove"?"danger":"secondary",label);button.type="button";button.disabled=saving||(action==="remove"&&!!applied);if(action==="remove"&&applied)button.title="적용을 해제한 뒤 삭제하세요.";button.onclick=()=>void act(record.id,action);buttons.append(button);
    }el.append(identity,buttons);return el;
  }
  function renderDefaults(){
    const select=$("preset-default"),button=$("preset-add-default"),help=$("preset-default-help");if(!select||!button)return;
    const previous=select.value,available=defaultRecords.filter(record=>(record.contentType||"novel")===typeOf(workspace));
    select.replaceChildren(...(available.length?available.map(record=>{
      const option=UI.node("option","",record.name);option.value=record.id;return option;
    }):[UI.node("option","",loading?"불러오는 중...":"선택할 기본 프리셋이 없습니다.")]));
    if(!available.length)select.options[0].value="";
    else select.value=available.some(record=>record.id===previous)?previous:available[0].id;
    select.disabled=loading||saving||!available.length;
    button.disabled=loading||saving||!select.value||records.length>=100;
    if(help)help.textContent=defaultError||(records.length>=100?"프리셋 100개 한도입니다. 기존 항목을 삭제한 뒤 추가하세요.":
      ((available.find(record=>record.id===select.value)?.description||"이 유형의 기본 프리셋이 아직 없습니다. 원본에서 직접 영역을 지정할 수 있습니다.")+" 추가하면 수정 가능한 복사본을 저장합니다. 현재 수집 설정은 바뀌지 않습니다."));
  }
  function resetDefaults(){
    defaultRecords=[];defaultError="";
    const select=$("preset-default"),button=$("preset-add-default");if(!select||!button)return;
    const option=UI.node("option","","로그인 후 기본 프리셋을 선택하세요.");option.value="";select.replaceChildren(option);select.disabled=button.disabled=true;
    if($("preset-default-help"))$("preset-default-help").textContent="로그인 후 기본 프리셋을 추가할 수 있습니다.";
  }
  function render(){
    if(!active())return;
    $("preset-list").replaceChildren(...(records.length?records.map(row):[UI.node("p","muted","아직 서버에 저장한 프리셋이 없습니다.")]));
    $("preset-count").textContent=`${records.length}개 저장`;$("preset-save").textContent=editing?"프리셋 수정 저장":"프리셋 서버 저장";$("preset-cancel-edit").hidden=!editing&&!hasFields();$("preset-cancel-edit").textContent="새 프리셋";
    for(const id of ["preset-save","preset-json","preset-file","preset-kind","preset-name","preset-cancel-edit"])$(id).disabled=saving;
    $("preset-content-type").disabled=saving||!!editing||hasFields();
    for(const id of ["preset-source-ongoing","preset-source-completed","preset-source-search","preset-catalog-order"])$(id).disabled=saving;
    $("preset-refresh").disabled=saving;tree();renderDefaults();renderActivation();
  }
  function renderActivation(){
    $("preset-activation").hidden=!editing||!bindingAvailable;
    const applied=bound(editing,workspace.origin,typeOf(workspace));
    const checkedAll=!!checks.listing?.presetHash&&pageKinds.every(kind=>checks[kind]?.presetHash===checks.listing.presetHash);
    $("preset-binding-status").textContent=dirty?"편집한 설정을 먼저 저장한 뒤 원본 확인·적용을 진행하세요.":applied?(applied.validated||checkedAll?"적용 중 · 최신 설정 원본 확인 완료":"적용 중 · 설정 변경 후 원본을 다시 확인하세요."):"저장됨 · 아직 수집에 적용하지 않았습니다.";
    for(const kind of pageKinds){
      $("preset-check-"+kind).disabled=saving||dirty||!bindingAvailable||!editing;
      $("preset-check-"+kind+"-url").disabled=saving;
      const checked=checks[kind],names=new Map(window.CollectorPresetGuide.definitions[kind].fields);
      $("preset-check-"+kind+"-status").textContent=checked?"확인 완료 · "+Object.entries(checked.matches).filter(([key,count])=>names.has(key)&&Number.isSafeInteger(count)&&count>=0).map(([key,count])=>names.get(key)+" "+count+"개").join(" · "):"이 화면에서 원본 확인 전";
    }
    $("preset-apply").disabled=saving||dirty||!editing||!bindingAvailable;
    $("preset-unbind").hidden=!applied;$("preset-unbind").disabled=saving||!bindingAvailable;
  }
  function adopt(config,id=null,key=null,token=null,savedAt=null){
    const previous=editing,previousOrigin=workspace?.origin;
    updatedAt=savedAt;
    workspace=group(config);editing=id;storageKey=key||id||random();bridgeToken=token||random();$("preset-name").value=workspace.name;
    $("preset-content-type").value=typeOf(workspace);window.CollectorPresetGuide.setPreset(workspace);
    $("preset-v3-options").hidden=workspace.version!==3;
    for(const key of ["ongoing","completed","search"])$("preset-source-"+key).value=workspace.pages.listing.sources?.[key]||"";
    $("preset-catalog-order").value=workspace.catalogOrder||"newest-first";
    checks={};dirty=false;
    if(previous!==id||previousOrigin!==workspace.origin)for(const kind of pageKinds)$("preset-check-"+kind+"-url").value="";
    const first=workspace.pages.listing.sources?.ongoing||workspace.pages.listing.pagePatterns?.[0]||workspace.pages.listing.pagePattern;
    if(first&&!/[{}]/.test(first)&&!$("preset-check-listing-url").value)$("preset-check-listing-url").value=workspace.origin+first;
    $("preset-json").value=JSON.stringify(workspace,null,2);document.dispatchEvent(new CustomEvent("preset:type"));bookmarklet();render();
  }
  async function refresh(force=false){
    if(!active()||((loading||saving)&&force!==true))return;loading=true;renderDefaults();const own=epoch,generation=UI.generation(),revision=++readRevision;
    try{const [saved,defaults,connected]=await Promise.allSettled([UI.api("/api/extraction-presets"),$("preset-default")?UI.api("/api/extraction-presets/defaults"):Promise.resolve([]),UI.api("/api/extraction-presets/bindings")]);
      if(own!==epoch||generation!==UI.generation()||revision!==readRevision||!active())return;
      if(saved.status==="fulfilled")records=Array.isArray(saved.value)?saved.value:[];else message("",UI.textError(saved.reason));
      if(defaults.status==="fulfilled"){
        defaultRecords=Array.isArray(defaults.value)?defaults.value.filter(record=>record&&typeof record.id==="string"&&typeof record.name==="string"&&record.id.length<=100&&record.name.length<=80):[];defaultError="";
      }else{defaultRecords=[];defaultError=UI.textError(defaults.reason);}
      bindingAvailable=false;
      if(connected.status==="fulfilled")try{bindings=bindingData(connected.value);bindingAvailable=true;}catch{}
    }catch(e){if(own===epoch&&active())message("",UI.textError(e));}finally{if(own===epoch&&revision===readRevision){loading=false;render();}}
  }
  async function addDefault(){
    if(saving||loading||!active())return;
    const defaultId=$("preset-default")?.value;if(!defaultId||records.length>=100)return;
    saving=true;render();const own=epoch,generation=UI.generation();
    try{const result=await UI.api("/api/extraction-presets/defaults",{method:"POST",body:JSON.stringify({defaultId})});
      if(own!==epoch||generation!==UI.generation()||!active())return;
      adopt(result.config,result.id,result.id,null,result.updatedAt||null);
      message("기본 프리셋의 수정 가능한 복사본을 추가했습니다. 현재 수집 설정은 바뀌지 않습니다.");await refresh(true);
    }catch(e){if(own===epoch&&active())message("",UI.textError(e));}finally{if(own===epoch){saving=false;render();}}
  }
  async function save(input){
    if(saving||!active())return;saving=true;render();const own=epoch,generation=UI.generation();
    try{input=group(input);const result=await UI.api(editing?`/api/extraction-presets/${encodeURIComponent(editing)}`:"/api/extraction-presets",{method:editing?"PUT":"POST",body:JSON.stringify(input)});
      if(own!==epoch||generation!==UI.generation())return;adopt(result.config,result.id,storageKey,bridgeToken,result.updatedAt||null);
      message("세 페이지의 지정 항목을 서버에 저장했습니다. 저장만으로 수집에 적용되지는 않습니다.");await refresh(true);
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
  async function sourceOperation(action,kind=null){
    if(saving||!active()||!editing||!bindingAvailable)return;
    if(dirty&&action!=="unbind"){message("","변경한 프리셋을 먼저 저장하세요.");return;}
    const id=editing,own=epoch,generation=UI.generation();saving=true;render();
    try{
      let result;
      if(action==="validate"){
        const raw=$("preset-check-"+kind+"-url").value.trim();let url;
        try{url=new URL(raw);}catch{throw Error("확인할 원본 HTTPS 주소를 입력하세요.");}
        if(raw.length>2000||url.protocol!=="https:"||url.origin!==workspace.origin||url.username||url.password||url.hash||[...url.searchParams.keys()].some(key=>/token|cookie|nonce|proof|password|pin|authorization|api.?key/i.test(key)))throw Error("프리셋과 같은 원본의 주소를 입력하고 인증값은 제외하세요.");
        result=await UI.api(`/api/extraction-presets/${encodeURIComponent(id)}/validate`,{method:"POST",body:JSON.stringify({pageKind:kind,url:url.href})});
      }else result=await UI.api(`/api/extraction-presets/${encodeURIComponent(id)}/binding`,{method:action==="apply"?"PUT":"DELETE",body:JSON.stringify({})});
      if(own!==epoch||generation!==UI.generation()||!active()||editing!==id)return;
      if(action==="validate"){
        if(!result||result.valid!==true||result.pageKind!==kind||typeof result.presetHash!=="string"||!result.matches||typeof result.matches!=="object"||Array.isArray(result.matches))throw Error("원본 확인 결과를 확인하지 못했습니다.");
        checks={...checks,[kind]:result};message("원본 확인을 완료했습니다. 수집 적용은 별도 버튼으로 진행하세요.");
      }else{
        const next=bindingData(result),applied=next.find(item=>item.presetId===id);
        if(action==="apply"&&(!applied||applied.origin!==workspace.origin||applied.contentType!==typeOf(workspace))||action==="unbind"&&applied)throw Error("프리셋 적용 결과를 확인하지 못했습니다.");
        bindings=next;readRevision++;loading=false;message(action==="apply"?"이 사이트·유형의 수집 프리셋을 적용했습니다.":"기본 프리셋 적용을 해제했습니다.");
      }
    }catch(e){if(own===epoch&&generation===UI.generation()&&active())message("",UI.textError(e));}
    finally{if(own===epoch){saving=false;render();}}
  }
  function acceptReturn(){
    if(!returnValue||!UI.authenticated()||document.hidden)return;const returned=returnValue;returnValue=null;
    try{
      const stored=JSON.parse(localStorage.getItem("nc-preset-bridge:"+returned.token));
      if(!stored||!Number.isFinite(stored.createdAt)||Date.now()-stored.createdAt>86400000||stored.origin!==returned.config.origin||(stored.contentType||"novel")!==typeOf(returned.config)||(stored.version!==undefined&&stored.version!==returned.config.version))throw Error("원본 저장 연결이 만료되었거나 다른 프리셋입니다. 대시보드에서 북마크를 다시 등록하거나 설정 JSON을 가져오세요.");
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
  $("preset-cancel-edit").onclick=()=>{adopt(empty());message();};$("preset-refresh").onclick=()=>void refresh();
  for(const kind of pageKinds)$("preset-check-"+kind).onclick=()=>void sourceOperation("validate",kind);
  $("preset-apply").onclick=()=>void sourceOperation("apply");$("preset-unbind").onclick=()=>void sourceOperation("unbind");
  $("preset-content-type").onchange=()=>{
    const contentType=$("preset-content-type").value;
    if(editing||hasFields()){$("preset-content-type").value=typeOf(workspace);message("","다른 유형은 새 프리셋에서 지정하세요.");return;}
    adopt(empty(contentType==="webtoon"?"sbxh9 웹툰 프리셋":"sbxh9 소설 프리셋",workspace.origin,contentType,3));message();
  };
  function settingsChanged(){
    if(workspace.version!==3)return;
    try{
      const sources=Object.fromEntries(["ongoing","completed","search"].map(key=>[key,$("preset-source-"+key).value.trim()]).filter(([,value])=>value));
      Object.values(sources).forEach(path);
      const previous=Object.values(workspace.pages.listing.sources||{}),retained=workspace.pages.listing.pagePatterns.filter(value=>!previous.includes(value));
      const pagePatterns=[...new Set([...Object.values(sources),...retained])];
      const next={...workspace,catalogOrder:$("preset-catalog-order").value,pages:{...workspace.pages,listing:{...workspace.pages.listing,sources,pagePatterns:pagePatterns.length?pagePatterns:workspace.pages.listing.pagePatterns}}};
      workspace=validateV3(next);dirty=!!editing;$("preset-json").value=JSON.stringify(workspace,null,2);bookmarklet();render();message();
    }catch(e){message("",UI.textError(e));}
  }
  for(const id of ["preset-source-ongoing","preset-source-completed","preset-source-search","preset-catalog-order"])$(id).addEventListener("change",settingsChanged);
  for(const id of ["preset-name","preset-json"])$(id).addEventListener("input",()=>{dirty=!!editing;renderActivation();});
  if($("preset-add-default"))$("preset-add-default").onclick=()=>void addDefault();
  if($("preset-default"))$("preset-default").addEventListener("change",renderDefaults);
  $("preset-bookmarklet").onclick=event=>{event.preventDefault();message("이 링크를 북마크바로 끌어 등록한 뒤 원본 페이지에서 실행하세요.");};
  $("preset-kind").addEventListener("change",bookmarklet);$("preset-name").addEventListener("change",bookmarklet);document.addEventListener("preset:guide",bookmarklet);
  document.addEventListener("preset:source",event=>{
    const url=new URL(event.detail),sourceType=/^\/(?:webtoon(?:\/|$)|ing\/?$|end\/?$)/.test(url.pathname)?"webtoon":/^\/novel(?:\/|$)/.test(url.pathname)?"novel":null;
    if((editing||hasFields())&&((sourceType&&sourceType!==typeOf(workspace))||url.origin!==workspace.origin)){
      event.preventDefault();message("","원본의 유형·사이트가 다릅니다. 새 프리셋을 만들어 지정하세요.");return;
    }
    if(!editing&&!hasFields()){
      if(sourceType&&sourceType!==typeOf(workspace))adopt(empty("sbxh9 "+(sourceType==="webtoon"?"웹툰":"소설")+" 프리셋",url.origin,sourceType,3));
      else{workspace={...workspace,origin:url.origin};$("preset-json").value=JSON.stringify(workspace,null,2);render();}
    }
    bookmarklet();
  });
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
    resetDefaults();
    records=[];bindings=[];bindingAvailable=false;checks={};editing=null;loading=saving=false;$("preset-activation").hidden=true;for(const kind of pageKinds){$("preset-check-"+kind+"-url").value="";$("preset-check-"+kind+"-status").textContent="";}$("preset-binding-status").textContent="";$("preset-json").value="";$("preset-list").replaceChildren();$("preset-bookmarklet-code").value="";$("preset-bookmarklet-code").hidden=true;$("preset-file").value="";
    workspace=empty();dirty=false;storageKey=random();bridgeToken=random();updatedAt=null;returnValue=null;$("preset-name").value=workspace.name;$("preset-content-type").value="novel";$("preset-content-type").disabled=false;$("preset-v3-options").hidden=true;for(const key of ["ongoing","completed","search"])$("preset-source-"+key).value="";$("preset-catalog-order").value="newest-first";window.CollectorPresetGuide.setPreset(workspace);$("preset-page-tree").replaceChildren();bookmarklet();
    try{for(const key of Object.keys(localStorage))if(key.startsWith("nc-preset-bridge:"))localStorage.removeItem(key);}catch{}
  }else{bookmarklet();acceptReturn();}});
  workspace=empty();storageKey=random();bridgeToken=random();$("preset-name").value=workspace.name;window.CollectorPresetGuide.setPreset(workspace);bookmarklet();readReturn();
  window.addEventListener("hashchange",readReturn);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)acceptReturn();});
})();
