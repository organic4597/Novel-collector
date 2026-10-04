"use strict";
(() => {
  const UI=window.CollectorUI,$=id=>document.getElementById(id),labels={listing:"작품 목록",detail:"작품 소개",catalog:"회차 목차",reader:"회차 본문"};
  let records=[],editing=null,loading=false,saving=false,epoch=0;
  const active=()=>UI.authenticated()&&UI.view()==="presets"&&!document.hidden;
  function message(text="",error=""){$("preset-status").textContent=text;$("preset-error").textContent=error;}
  function bookmarklet(config=null){
    const link=$("preset-bookmarklet"),options=config?{preset:config}:{kind:$("preset-kind").value};
    link.setAttribute("href",window.CollectorElementPicker.bookmarklet(options));
    link.textContent=config?`${config.name} · 요소 선택`:`수집 영역 선택 · ${labels[$("preset-kind").value]}`;
  }
  function row(record){
    const el=UI.node("article","preset-card"),identity=UI.node("div");
    identity.append(UI.node("h3","",record.name),UI.node("p","muted",`${labels[record.kind]} · ${record.origin}${record.pagePattern} · ${record.fieldCount}개 항목`));
    const buttons=UI.node("div","heading-actions");
    for(const [action,label] of [["load","불러오기"],["export","JSON 보기"],["remove","삭제"]]){
      const button=UI.node("button",action==="remove"?"danger":"secondary",label);button.type="button";button.dataset.action=action;
      button.disabled=saving;button.onclick=()=>act(record.id,action);buttons.append(button);
    }
    el.append(identity,buttons);return el;
  }
  function render(){
    if(!active())return;
    $("preset-list").replaceChildren(...(records.length?records.map(row):[UI.node("p","muted","저장한 프리셋이 없습니다. 북마크릿으로 요소를 선택한 뒤 JSON을 가져오세요.")]));
    $("preset-count").textContent=`${records.length}개 저장`;
    $("preset-save").disabled=saving;$("preset-save").textContent=editing?"이 프리셋 수정 저장":"새 프리셋 저장";
    $("preset-cancel-edit").hidden=!editing;
    for(const id of ["preset-json","preset-file","preset-kind","preset-cancel-edit"])$(id).disabled=saving;
  }
  async function refresh(){
    if(!active()||loading)return;loading=true;const own=epoch,generation=UI.generation();
    try{const result=await UI.api("/api/extraction-presets");if(!active()||own!==epoch||generation!==UI.generation())return;
      records=Array.isArray(result)?result:[];render();
    }catch(e){if(own===epoch&&active())message("",UI.textError(e));}finally{if(own===epoch)loading=false;}
  }
  async function act(id,action){
    if(saving||!active())return;const own=epoch,generation=UI.generation();
    saving=true;render();
    try{
      if(action==="remove"){
        await UI.api(`/api/extraction-presets/${encodeURIComponent(id)}`,{method:"DELETE"});
        if(own!==epoch||generation!==UI.generation())return;
        if(editing===id){editing=null;$("preset-json").value="";bookmarklet();}
        records=records.filter(r=>r.id!==id);message("프리셋을 삭제했습니다.");
      }else{
        const record=await UI.api(`/api/extraction-presets/${encodeURIComponent(id)}`);
        if(own!==epoch||generation!==UI.generation())return;
        editing=action==="load"?id:null;$("preset-json").value=JSON.stringify(record.config,null,2);
        $("preset-kind").value=record.config.kind;bookmarklet(record.config);
        message(action==="load"?"수정할 프리셋을 불러왔습니다. 갱신된 북마크를 원본 페이지에서 실행할 수 있습니다.":"내보낼 JSON을 표시했습니다. 복사하거나 파일로 저장할 수 있습니다.");
      }
    }catch(e){if(own===epoch&&active())message("",UI.textError(e));}
    finally{if(own===epoch){saving=false;render();}}
  }
  $("preset-bookmarklet").addEventListener("click",event=>{event.preventDefault();message("이 링크를 북마크바로 끌어 등록한 뒤 원본 사이트에서 실행하세요.");});
  $("preset-kind").addEventListener("change",()=>bookmarklet());
  $("preset-copy-bookmarklet").addEventListener("click",async()=>{
    if(!active())return;const own=epoch,generation=UI.generation();
    const current=()=>own===epoch&&generation===UI.generation()&&active();
    const value=$("preset-bookmarklet").getAttribute("href");
    try{await navigator.clipboard.writeText(value);if(current())message("북마크릿 코드를 복사했습니다. 새 북마크의 URL에 붙여 넣으세요.");}
    catch{if(!current())return;$("preset-bookmarklet-code").hidden=false;$("preset-bookmarklet-code").value=value;$("preset-bookmarklet-code").focus();$("preset-bookmarklet-code").select();message("아래 코드를 Ctrl+C로 복사해 북마크 URL에 붙여 넣으세요.");}
  });
  $("preset-file").addEventListener("change",async()=>{
    const file=$("preset-file").files?.[0];if(!file)return;
    if(file.size>32768){message("","JSON 파일은 최대 32KiB입니다.");return;}
    const own=epoch,generation=UI.generation();
    try{const text=await file.text();if(own!==epoch||generation!==UI.generation())return;JSON.parse(text);$("preset-json").value=text;editing=null;render();message("JSON을 읽었습니다. 저장 버튼으로 검증·등록하세요.");}
    catch{if(own===epoch&&generation===UI.generation()&&active())message("","올바른 JSON 파일을 선택하세요.");}
  });
  $("preset-save").addEventListener("click",async()=>{
    if(saving||!active())return;
    let input;try{input=JSON.parse($("preset-json").value);}catch{message("","북마크릿에서 복사한 JSON을 붙여 넣으세요.");return;}
    saving=true;render();const own=epoch,generation=UI.generation();
    try{
      const result=await UI.api(editing?`/api/extraction-presets/${encodeURIComponent(editing)}`:"/api/extraction-presets",{method:editing?"PUT":"POST",body:JSON.stringify(input)});
      if(own!==epoch||generation!==UI.generation())return;
      editing=result.id;$("preset-json").value=JSON.stringify(result.config,null,2);bookmarklet(result.config);
      message("선택자 프리셋을 저장했습니다. 원본에서 미리보기·수정에 다시 사용할 수 있습니다.");
      await refresh();
    }catch(e){if(own===epoch&&active())message("",UI.textError(e));}finally{if(own===epoch){saving=false;render();}}
  });
  $("preset-cancel-edit").addEventListener("click",()=>{editing=null;$("preset-json").value="";bookmarklet();render();message();});
  $("preset-refresh").addEventListener("click",refresh);
  $("preset-copy-json").addEventListener("click",async()=>{
    if(!active())return;const own=epoch,generation=UI.generation();
    const current=()=>own===epoch&&generation===UI.generation()&&active();
    const text=$("preset-json").value;if(!text)return;
    try{await navigator.clipboard.writeText(text);if(current())message("프리셋 JSON을 복사했습니다.");}catch{if(!current())return;$("preset-json").focus();$("preset-json").select();message("JSON을 Ctrl+C로 복사하세요.");}
  });
  document.addEventListener("collector:view",()=>{epoch++;loading=saving=false;if(active()){render();void refresh();}});
  document.addEventListener("collector:auth",()=>{epoch++;if(!UI.authenticated()){
    records=[];editing=null;loading=saving=false;$("preset-json").value="";$("preset-list").replaceChildren();bookmarklet();
    $("preset-bookmarklet-code").value="";$("preset-bookmarklet-code").hidden=true;$("preset-file").value="";
  }});
  bookmarklet();
})();
