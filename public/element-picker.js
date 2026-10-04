"use strict";
(() => {
  // Intentionally self-contained: the bookmarklet embeds this function in full.
  // Hover, highlighting, selector preview and copying all run on the source page.
  function startPicker(options = {}) {
    if (location.protocol !== "https:" || window.CollectorUI) {
      alert("원본 HTTPS 작품 페이지에서 이 북마크를 실행하세요."); return;
    }
    window.__NC_ELEMENT_PICKER__?.close?.();
    const definitions = {
      listing: [["items","작품 카드 (반복)","text",true],["title","제목"],["author","작가"],["genres","장르","text",true],["tags","태그","text",true],["platform","공급처"],["episodeCount","회차 수"],["publication","연재 상태"],["thumbnail","표지","src"],["url","작품 링크","href"],["updatedLabel","업데이트 표시"],["nextPageButton","다음 페이지 버튼"]],
      detail: [["title","제목"],["author","작가"],["genres","장르","text",true],["tags","태그","text",true],["platform","공급처"],["episodeCount","회차 수"],["publication","연재 상태"],["synopsis","작품 소개"],["thumbnail","표지","src"]],
      catalog: [["rows","회차 행 (반복)","text",true],["number","회차 번호"],["title","회차 제목"],["url","회차 링크","href"],["notReady","준비중 표시"],["expectedChapters","전체 회차 수"],["moreButton","이전 회차 더 보기"]],
      reader: [["root","본문 루트"],["text","본문 텍스트"],["notice","로딩·오류 안내"]],
    };
    const labels = {listing:"작품 목록",detail:"작품 소개",catalog:"회차 목차",reader:"회차 본문"};
    const host=document.createElement("div"); host.id="nc-element-picker";
    host.style.cssText="position:fixed;right:16px;top:16px;width:350px;max-width:calc(100vw - 32px);z-index:2147483647;";
    const ui=host.attachShadow({mode:"open"});
    ui.innerHTML=`<style>
      *{box-sizing:border-box}section{font:13px/1.5 system-ui,sans-serif;color:#edf4fb;background:#142131;border:1px solid #58708a;border-radius:12px;padding:14px;max-height:calc(100vh - 32px);overflow:auto;box-shadow:0 16px 48px #0008}header{display:flex;justify-content:space-between;align-items:center}h2{font-size:15px;margin:0}label{display:block;margin-top:8px}input,select,textarea,button{font:inherit}input,select,textarea{color:#edf4fb;background:#22364b;border:1px solid #50657b;border-radius:6px;padding:6px;width:100%}button{color:#edf4fb;background:#2c4964;border:1px solid #698399;border-radius:6px;padding:6px 8px;cursor:pointer}button:disabled{opacity:.45;cursor:default}.row{display:flex;gap:6px;align-items:center;margin:8px 0}.row label{margin:0}.row input[type=checkbox]{width:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;font:12px/1.4 ui-monospace,monospace;background:#0d1722;padding:8px;border-radius:6px;max-height:160px;overflow:auto}.muted{color:#a7bbcf;font-size:12px}.error{color:#ffc3c7;margin:8px 0}ol{padding-left:20px;margin:8px 0}li{margin:4px 0;overflow-wrap:anywhere}li button{float:right;padding:0 5px}textarea{height:130px}
      </style><section aria-label="수집 요소 선택 도구"><header><h2>수집 영역 선택</h2><button id="close" aria-label="선택 도구 닫기">×</button></header>
      <p class="muted">마우스 오버로 강조 → 클릭으로 지정. 반복 영역을 먼저 선택하면 필드는 상대 선택자로 저장됩니다.</p>
      <label>프리셋 이름<input id="name" maxlength="80"></label><label>페이지 유형<select id="kind"></select></label><label>페이지 패턴<input id="pattern" maxlength="300"></label>
      <label>지정할 항목<select id="field"></select></label><div class="row"><select id="attribute"><option value="text">텍스트</option><option value="href">링크 href</option><option value="src">이미지 src</option><option value="data-src">이미지 data-src</option></select><label><input id="multiple" type="checkbox">여러 요소</label></div>
      <div class="row"><button id="mode">선택 중</button><button id="parent" disabled>부모 요소</button><button id="assign" disabled>이 요소 지정</button></div>
      <pre id="hover">페이지 위에 마우스를 올리세요.</pre><p id="error" class="error" role="status"></p><ol id="fields"></ol>
      <div class="row"><button id="preview">전체 미리보기</button><button id="copy">프리셋 JSON 복사</button></div><pre id="result" hidden></pre>
      <textarea id="export" readonly hidden aria-label="복사할 프리셋 JSON"></textarea><p class="muted">저장 JSON에는 선택자만 포함합니다. 쿠키·입력값·본문 미리보기는 포함하지 않습니다. Esc로 종료합니다.</p></section>`;
    document.documentElement.append(host);
    const outline=document.createElement("div");
    outline.style.cssText="position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #58e2bb;background:#58e2bb19;display:none;";
    document.documentElement.append(outline);
    const $=id=>ui.getElementById(id), drafts={listing:{},detail:{},catalog:{},reader:{}};
    let target=null, selected=null, selecting=true, frame=null, point=null, closed=false;
    const originalCursor=document.documentElement.style.cursor;
    function error(message=""){$("error").textContent=message;}
    function shadow(el){try{const root=el.shadowRoot||el.__novelShadow;return root?.nodeType===11&&root.host===el?root:null;}catch{return null;}}
    function composedParent(el){return el.parentElement||el.getRootNode()?.host||null;}
    function forbidden(el){return !el||el===host||el===outline||/^(SCRIPT|STYLE|NOSCRIPT|INPUT|TEXTAREA|SELECT|FORM|META|LINK)$/.test(el.tagName)||el.isContentEditable;}
    function isTool(event){return event.composedPath?.().includes(host)||event.target===host||event.target===outline;}
    function deepest(x,y){
      let el=document.elementFromPoint(x,y);
      for(let i=0;i<8&&el;i++){const root=shadow(el);if(!root?.elementFromPoint)break;const next=root.elementFromPoint(x,y);if(!next||next===el||next.getRootNode()!==root)break;el=next;}
      return el;
    }
    function safeText(node){
      let visits=0,length=0;
      function read(n){
        if(++visits>2000||length>2048)return"";
        if(n.nodeType===3){const text=n.textContent.slice(0,2048-length);length+=text.length;return text;}
        if(n.nodeType===1){if(forbidden(n)||n.classList.contains("wr-none"))return"";if(n.tagName==="BR")return"\n";const root=shadow(n);if(root)return read(root);}
        return [...(n.childNodes||[])].map(read).join("");
      }
      return read(node).trim().slice(0,2048);
    }
    function value(el,attribute){
      if(forbidden(el))return"[입력·스크립트 요소 제외]";
      if(attribute==="text")return safeText(el);
      const raw=el.getAttribute(attribute)||"";
      if(!raw)return"";
      try{const url=new URL(raw,location.href);if(!["https:","http:"].includes(url.protocol))return"[URL 아닌 값 생략]";
        url.username="";url.password="";url.hash="";
        for(const key of [...url.searchParams.keys()])if(/token|cookie|nonce|proof|password|pin|authorization|api.?key/i.test(key))url.searchParams.delete(key);
        return url.href.slice(0,1000);
      }catch{return"";}
    }
    function part(el){
      const tag=el.localName||"*";
      if(el.hasAttribute("data-theme-novel-content"))return"[data-theme-novel-content]";
      if(el.id&&!/\d|@/.test(el.id)&&el.id.length<80)return`#${CSS.escape(el.id)}`;
      const classes=[...el.classList].filter(c=>c.length<80&&!/\d{4}|__[a-zA-Z0-9]{5,}$/.test(c)).slice(0,2);
      if(classes.length)return tag+classes.map(c=>"."+CSS.escape(c)).join("");
      const aria=el.getAttribute("aria-label");
      if(aria&&aria.length<60&&!/@|\d{4}/.test(aria))return`${tag}[aria-label=${JSON.stringify(aria)}]`;
      return tag;
    }
    function matches(scope,selector){try{return [...scope.querySelectorAll(selector)];}catch{return[];}}
    function selector(el,scope,multiple){
      if(el===scope)return":scope";
      const initial=part(el);
      if(multiple){
        if(initial!==el.localName)return initial;
        const parent=el.parentElement;
        if(parent&&parent!==scope)return`${selector(parent,scope,false)} > ${initial}`;
        return initial;
      }
      if(matches(scope,initial).length===1)return initial;
      let current=el,path=[];
      for(let depth=0;current&&current!==scope&&depth<16;depth++){
        let piece=part(current);
        const siblings=[...(current.parentElement?.children||[])].filter(n=>n.localName===current.localName);
        if(siblings.length>1)piece+=`:nth-of-type(${siblings.indexOf(current)+1})`;
        path.unshift(piece);
        const result=path.join(" > ");
        if(matches(scope,result).length===1)return result;
        current=current.parentElement;
      }
      return path.join(" > ")||initial;
    }
    function locator(el){
      const hosts=[];let root=el.getRootNode();
      for(let i=0;root?.host&&i<8;i++){hosts.unshift(root.host);root=root.host.getRootNode();}
      let scope=document;const shadowPath=[];
      for(const h of hosts){shadowPath.push(selector(h,scope,false));scope=shadow(h);if(!scope)throw Error("이 Shadow DOM은 현재 접근할 수 없습니다.");}
      const kind=$("kind").value,key=$("field").value,parentKey=kind==="listing"?"items":kind==="catalog"?"rows":null;
      const parentLocator=parentKey&&drafts[kind][parentKey];
      let relativeTo;
      if(parentLocator&&key!==parentKey&&JSON.stringify(parentLocator.shadowPath)===JSON.stringify(shadowPath)){
        try{const parent=el.closest(parentLocator.selector);if(parent){scope=parent;shadowPath.length=0;relativeTo=parentKey;}}catch{}
      }
      return{selector:selector(el,scope,$("multiple").checked),shadowPath,attribute:$("attribute").value,multiple:$("multiple").checked,...(relativeTo?{relativeTo}:{})};
    }
    function highlight(el){
      if(!el||forbidden(el)){outline.style.display="none";return;}
      const box=el.getBoundingClientRect();
      Object.assign(outline.style,{display:"block",left:box.left+"px",top:box.top+"px",width:box.width+"px",height:box.height+"px"});
      $("hover").textContent=`${el.localName}${el.id?" #"+el.id:""}\n${value(el,$("attribute").value).slice(0,220)}`;
    }
    function move(event){
      if(!selecting||isTool(event)||selected)return;
      point={x:event.clientX,y:event.clientY};
      if(frame!==null)return;
      frame=requestAnimationFrame(()=>{frame=null;const el=deepest(point.x,point.y);if(el&&el!==host&&el!==outline){target=el;highlight(el);$("parent").disabled=!composedParent(el);$("assign").disabled=forbidden(el);}});
    }
    function block(event){if(selecting&&!isTool(event)){event.preventDefault();event.stopImmediatePropagation();}}
    function click(event){
      if(!selecting||isTool(event))return;
      event.preventDefault();event.stopImmediatePropagation();
      const el=deepest(event.clientX,event.clientY)||target;
      if(!el||forbidden(el)){error("입력칸·스크립트 대신 공개 작품 정보 영역을 선택하세요.");return;}
      target=selected=el;highlight(el);assign();
    }
    function assign(){
      const el=selected||target;if(!el||forbidden(el))return;
      try{const kind=$("kind").value,key=$("field").value;
        if(key==="items"||key==="rows")$("multiple").checked=true;
        drafts[kind][key]=locator(el);error();renderFields();
        $("hover").textContent=JSON.stringify(drafts[kind][key],null,2)+"\n미리보기: "+value(el,$("attribute").value).slice(0,220);
      }catch(e){error(e.message);}
    }
    function renderFields(){
      $("fields").replaceChildren();
      const kind=$("kind").value;
      for(const [key,l] of Object.entries(drafts[kind])){
        const row=document.createElement("li");row.textContent=(definitions[kind].find(f=>f[0]===key)?.[1]||key)+": "+l.selector;
        const remove=document.createElement("button");remove.textContent="×";remove.setAttribute("aria-label",key+" 제거");
        remove.onclick=()=>{delete drafts[kind][key];renderFields();};row.append(remove);$("fields").append(row);
      }
    }
    function pattern(kind){
      if(/^\/novel\/\d+\/\d+\/?$/.test(location.pathname))return"/novel/{workId}/{episodeId}";
      if(/^\/novel\/\d+\/?$/.test(location.pathname))return"/novel/{workId}";
      return location.pathname;
    }
    function kindChanged(){
      const kind=$("kind").value;$("field").replaceChildren();
      for(const [key,label] of definitions[kind]){const option=document.createElement("option");option.value=key;option.textContent=label;$("field").append(option);}
      $("pattern").value=pattern(kind);fieldChanged();renderFields();
    }
    function fieldChanged(){
      const f=definitions[$("kind").value].find(f=>f[0]===$("field").value);
      $("attribute").value=f[2]||"text";$("multiple").checked=!!f[3];selected=null;
      if(target)highlight(target);
    }
    function exportPreset(){
      const fields=drafts[$("kind").value];
      if(!Object.keys(fields).length)throw Error("추출 항목을 한 개 이상 지정하세요.");
      const name=$("name").value.trim(),pagePattern=$("pattern").value.trim();
      if(!name||name.length>80||!pagePattern.startsWith("/")||/[?#]/.test(pagePattern))throw Error("이름과 쿼리 없는 페이지 패턴을 확인하세요.");
      for(const field of Object.values(fields))if(field.relativeTo&&!fields[field.relativeTo])throw Error("상대 항목의 반복 영역을 다시 지정하세요.");
      return{version:1,name,origin:location.origin,pagePattern,kind:$("kind").value,fields:JSON.parse(JSON.stringify(fields))};
    }
    function resolve(scope,l){
      for(const s of l.shadowPath||[]){const h=scope.querySelector(s);scope=h&&shadow(h);if(!scope)return[];}
      const nodes=l.selector===":scope"&&scope.nodeType===1?[scope]:[...scope.querySelectorAll(l.selector)];
      return l.multiple?nodes.slice(0,20):nodes.slice(0,1);
    }
    function previewPreset(){
      const preset=exportPreset(),result={};
      for(const [key,l] of Object.entries(preset.fields)){
        try{const scopes=l.relativeTo?resolve(document,preset.fields[l.relativeTo]):[document];
          result[key]=scopes.slice(0,5).flatMap(s=>resolve(s,l)).slice(0,5).map(el=>value(el,l.attribute).slice(0,300));
        }catch{result[key]=["선택자 오류"]};
      }
      return result;
    }
    function close(){
      if(closed)return;closed=true;if(frame!==null)cancelAnimationFrame(frame);
      document.removeEventListener("pointermove",move,true);document.removeEventListener("pointerdown",block,true);document.removeEventListener("click",click,true);document.removeEventListener("keydown",key,true);
      document.documentElement.style.cursor=originalCursor;host.remove();outline.remove();target=selected=null;
      if(window.__NC_ELEMENT_PICKER__===controller)delete window.__NC_ELEMENT_PICKER__;
    }
    function key(event){if(event.key==="Escape"){event.preventDefault();close();}}
    const header=ui.querySelector("header");header.style.cursor="move";header.title="끌어서 도구 위치 이동";
    let drag=null;
    header.addEventListener("pointerdown",event=>{
      if(event.target.closest("button"))return;
      event.preventDefault();const box=host.getBoundingClientRect();drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:box.left,top:box.top};header.setPointerCapture(event.pointerId);
    });
    header.addEventListener("pointermove",event=>{
      if(!drag||drag.id!==event.pointerId)return;
      host.style.right="auto";host.style.left=Math.max(0,Math.min(innerWidth-host.offsetWidth,drag.left+event.clientX-drag.x))+"px";
      host.style.top=Math.max(0,Math.min(innerHeight-40,drag.top+event.clientY-drag.y))+"px";
    });
    header.addEventListener("pointerup",event=>{if(drag?.id===event.pointerId){header.releasePointerCapture(event.pointerId);drag=null;}});
    $("close").onclick=close;$("parent").onclick=()=>{const parent=composedParent(selected||target);if(parent&&parent!==host){target=selected=parent;highlight(parent);$("assign").disabled=forbidden(parent);}};
    $("assign").onclick=assign;$("kind").onchange=kindChanged;$("field").onchange=fieldChanged;
    $("mode").onclick=()=>{selecting=!selecting;selected=null;outline.style.display="none";$("mode").textContent=selecting?"선택 중":"페이지 탐색";document.documentElement.style.cursor=selecting?"crosshair":originalCursor;};
    $("preview").onclick=()=>{try{$("result").hidden=false;$("result").textContent=JSON.stringify(previewPreset(),null,2);error();}catch(e){error(e.message);}};
    $("copy").onclick=async()=>{
      try{const text=JSON.stringify(exportPreset(),null,2);$("export").value=text;
        try{await navigator.clipboard.writeText(text);error("프리셋 JSON을 복사했습니다. 대시보드의 추출 프리셋에 붙여 넣으세요.");}
        catch{$("export").hidden=false;$("export").focus();$("export").select();error("아래 JSON을 Ctrl+C로 복사하세요.");}
      }catch(e){error(e.message);}
    };
    for(const [kind,label] of Object.entries(labels)){const o=document.createElement("option");o.value=kind;o.textContent=label;$("kind").append(o);}
    const existing=options.preset;
    $("kind").value=existing?.origin===location.origin&&definitions[existing.kind]?existing.kind:definitions[options.kind]?options.kind:"listing";
    $("name").value=options.name||`${location.hostname} ${labels[$("kind").value]}`;kindChanged();
    if(existing?.origin===location.origin&&definitions[existing.kind]){
      $("name").value=existing.name;$("pattern").value=existing.pagePattern;
      for(const [field,l] of Object.entries(existing.fields||{}))if(definitions[existing.kind].some(f=>f[0]===field))drafts[existing.kind][field]=l;
      renderFields();
    }
    document.documentElement.style.cursor="crosshair";
    document.addEventListener("pointermove",move,true);document.addEventListener("pointerdown",block,true);document.addEventListener("click",click,true);document.addEventListener("keydown",key,true);
    const controller={close,exportPreset,previewPreset};window.__NC_ELEMENT_PICKER__=controller;
    return controller;
  }
  window.CollectorElementPicker = {
    start: startPicker,
    bookmarklet(options = {}) { return "javascript:" + encodeURIComponent(`void (${startPicker.toString()})(${JSON.stringify(options)})`); },
  };
})();
