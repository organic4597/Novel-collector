"use strict";
(() => {
  // Intentionally self-contained: the bookmarklet embeds this function in full.
  // Hover, highlighting, selector preview and copying all run on the source page.
  function startPicker(options = {}) {
    if (location.protocol !== "https:" || window.CollectorUI) {
      alert("원본 HTTPS 작품 페이지에서 이 북마크를 실행하세요."); return;
    }
    const webtoonReader=/^\/(?:webtoon|manhwa)\/[^/]+\/[^/]+\/?$/.test(location.pathname);
    const webtoonDetail=/^\/(?:webtoon|manhwa)\/[^/]+\/?$/.test(location.pathname);
    const webtoonListing=/^\/(ing|end|manhwa)\/?$/.test(location.pathname);
    const novelReader=/^\/novel\/\d+\/\d+\/?$/.test(location.pathname),novelDetail=/^\/novel\/\d+\/?$/.test(location.pathname);
    const sourceType=webtoonReader||webtoonDetail||webtoonListing?location.pathname.startsWith("/manhwa")?"manhwa":"webtoon":novelReader||novelDetail||/^\/novel\/?$/.test(location.pathname)?"novel":null;
    const contentType=options.preset?.contentType||options.contentType||sourceType||"novel";
    if(!["novel","webtoon","manhwa"].includes(contentType)){alert("지원하는 콘텐츠 유형을 선택하세요.");return;}
    if(sourceType&&(contentType!==sourceType||options.preset&&(options.preset.contentType||"novel")!==sourceType)){
      alert("소설(novel)과 웹툰(webtoon) 프리셋의 원본 페이지 유형이 다릅니다. 올바른 원본 페이지에서 다시 실행하세요.");return;
    }
    const version=contentType!=="novel"||options.preset?.version===3?3:2;
    window.__NC_ELEMENT_PICKER__?.close?.();
    const definitions = {
      listing: [["items","작품 카드 (반복)","text",true],["title","제목"],["author","작가"],["genres","장르","text",true],["tags","태그","text",true],["platform","공급처"],["episodeCount","회차 수"],["publication","연재 상태"],["thumbnail","표지","src"],["url","작품 링크","href"],["updatedLabel","업데이트 표시"],["nextPageButton","다음 페이지 버튼"]],
      detail: [["title","소설 제목"],["author","작가"],["genres","장르","text",true],["tags","태그","text",true],["platform","공급처"],["episodeCount","회차 수"],["publication","연재 상태"],["synopsis","줄거리"],["thumbnail","표지","src"],["rows","회차 행 (반복)","text",true],["chapterNumber","회차 번호"],["chapterTitle","회차 제목"],["chapterUrl","본문 링크","href"],["notReady","준비중 표시"],["expectedChapters","전체 회차 수"],["moreButton","이전 회차 더 보기"]],
      reader: [["root","본문 루트"],["text","본문 텍스트"],["notice","로딩·오류 안내"]],
    };
    if(version===3){
      definitions.listing=[["items","작품 카드 (반복)","text",true],["title","제목"],["url","작품 링크","href"],["authors","작가","text",true],["genres","장르","text",true],["tags","태그","text",true],["platform","공급처"],["episodeCount","회차 수"],["thumbnail","표지","imageUrl"],["publication","연재 상태"],["updatedLabel","업데이트 표시"],["rating","평점"],["actions.nextPage","다음 페이지 버튼"],["actions.loadMore","이전 회차 더 보기"]];
      definitions.detail=[["title","작품 제목"],["authors","작가","text",true],["genres","장르","text",true],["tags","태그","text",true],["platform","공급처"],["episodeCount","회차 수"],["synopsis","줄거리"],["thumbnail","표지","imageUrl"],["publication","연재 상태"],["rows","회차 행 (반복)","text",true],["chapterTitle","회차 제목"],["chapterUrl","본문 링크","href"],["chapterLabel","회차 표시"],["notReady","준비중 표시"],["expectedChapters","전체 회차 수"],["seasonLabel","시즌 표시"],["seasonNumber","시즌 번호"],["actions.loadMore","이전 회차 더 보기"],["actions.nextPage","다음 페이지 버튼"]];
      definitions.reader=contentType!=="novel"?[["root","이미지 본문 루트"],["images","본문 이미지 (반복)","imageUrl",true],["notice","로딩·오류 안내"]]:definitions.reader;
    }
    const typeLabel=contentType==="manhwa"?"만화":contentType==="webtoon"?"웹툰":"소설";
    const labels = {listing:typeLabel+" 목록",detail:typeLabel+" 정보·회차 목록",reader:"회차 본문"};
    const patterns=contentType!=="novel"?{listing:contentType==="manhwa"?"/manhwa":location.pathname.replace(/\/$/,"")==="/end"?"/end":"/ing",detail:`/${contentType}/{workId}`,reader:`/${contentType}/{workId}/{episodeId}`}:{listing:"/novel",detail:"/novel/{workId}",reader:"/novel/{workId}/{episodeId}"};
    const detected=webtoonReader||novelReader?"reader":webtoonDetail||novelDetail?"detail":!sourceType&&version===3&&["listing","detail","reader"].includes(options.kind)?options.kind:"listing";
    const storageKey="nc-preset-v2:"+(options.storageKey||"default");
    const host=document.createElement("div"); host.id="nc-element-picker";
    host.style.cssText="position:fixed;right:16px;top:16px;width:350px;max-width:calc(100vw - 32px);z-index:2147483647;";
    const ui=host.attachShadow({mode:"open"});
    ui.innerHTML=`<style>
      *{box-sizing:border-box}section{font:13px/1.5 system-ui,sans-serif;color:#edf4fb;background:#142131;border:1px solid #58708a;border-radius:12px;padding:14px;max-height:calc(100vh - 32px);overflow:auto;box-shadow:0 16px 48px #0008}header{display:flex;justify-content:space-between;align-items:center}h2{font-size:15px;margin:0}label{display:block;margin-top:8px}input,select,textarea,button{font:inherit}input,select,textarea{color:#edf4fb;background:#22364b;border:1px solid #50657b;border-radius:6px;padding:6px;width:100%}button{color:#edf4fb;background:#2c4964;border:1px solid #698399;border-radius:6px;padding:6px 8px;cursor:pointer}button:disabled{opacity:.45;cursor:default}.row{display:flex;gap:6px;align-items:center;margin:8px 0}.row label{margin:0}.row input[type=checkbox]{width:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;font:12px/1.4 ui-monospace,monospace;background:#0d1722;padding:8px;border-radius:6px;max-height:160px;overflow:auto}.muted{color:#a7bbcf;font-size:12px}.error{color:#ffc3c7;margin:8px 0}ol{padding-left:20px;margin:8px 0}li{margin:4px 0;overflow-wrap:anywhere}li button{float:right;padding:0 5px}textarea{height:130px}
      </style><section aria-label="수집 요소 선택 도구"><header><h2>수집 영역 선택</h2><button id="close" aria-label="선택 도구 닫기">×</button></header>
      <p class="muted">항목 선택 → 원본 영역 클릭 → ‘이 항목 저장’으로 고정. 다시 항목을 고르면 고정 영역이 초록색으로 표시됩니다.</p>
      <label>프리셋 이름<input id="name" maxlength="80"></label><label>페이지 유형<select id="kind"></select></label><label>페이지 패턴${version===3?'<textarea id="pattern" maxlength="3000" style="height:70px" aria-label="페이지 패턴 (한 줄에 하나)"></textarea>':'<input id="pattern" maxlength="300">'}</label>
      ${version===3?'<label>회차 목록 순서<select id="catalog-order"><option value="newest-first">최신 회차부터</option><option value="oldest-first">첫 회차부터</option></select></label>':""}
      <label>지정할 항목<select id="field"></select></label><div class="row"><select id="attribute"><option value="text">텍스트</option><option value="href">링크 href</option><option value="src">이미지 src</option><option value="data-src">이미지 data-src</option>${version===3?'<option value="imageUrl">이미지 URL 자동</option>':""}</select><label><input id="multiple" type="checkbox">여러 요소</label></div>
      <div class="row"><button id="mode">선택 중</button><button id="parent" disabled>부모 요소</button><button id="assign" disabled>이 항목 저장</button></div>
      <pre id="hover">페이지 위에 마우스를 올리세요.</pre><p id="error" class="error" role="status"></p><ol id="fields"></ol>
      <div class="row"><button id="preview">선택 항목 미리보기</button><button id="save-preset">프리셋 서버 저장</button></div><div class="row"><button id="copy">설정 JSON 복사</button></div><pre id="result" hidden></pre>
      <textarea id="export" readonly hidden aria-label="복사할 프리셋 JSON"></textarea><p class="muted">저장 JSON에는 선택자만 포함합니다. 쿠키·입력값·본문 미리보기는 포함하지 않습니다. Esc로 종료합니다.</p></section>`;
    document.documentElement.append(host);
    const outline=document.createElement("div");
    outline.style.cssText="position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #58e2bb;background:#58e2bb19;display:none;";
    document.documentElement.append(outline);
    const $=id=>ui.getElementById(id), drafts={listing:{},detail:{},reader:{}}, fixed=[];
    const pagePatterns=Object.fromEntries(Object.entries(patterns).map(([kind,path])=>[kind,version===3?[path]:path]));
    let sources=contentType==="manhwa"?{ongoing:"/manhwa",completed:"/manhwa"}:contentType==="webtoon"?{ongoing:"/ing",completed:"/end"}:undefined,pending=null,restoreFrame=null;
    let target=null, selected=null, selecting=true, frame=null, point=null, closed=false;
    const originalCursor=document.documentElement.style.cursor;
    function error(message=""){$("error").textContent=message;}
    function shadow(el){try{const root=el.shadowRoot||el.__novelShadow;return root?.nodeType===11&&root.host===el?root:null;}catch{return null;}}
    function composedParent(el){return el.parentElement||el.getRootNode()?.host||null;}
    function forbidden(el){return !el||el===host||el===outline||el.dataset?.ncPinned==="true"||/^(SCRIPT|STYLE|NOSCRIPT|INPUT|TEXTAREA|SELECT|FORM|META|LINK)$/.test(el.tagName)||el.isContentEditable;}
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
      const raw=attribute==="imageUrl"?(el.currentSrc||el.getAttribute("data-src")||el.getAttribute("src")||""):el.getAttribute(attribute)||"";
      if(!raw)return"";
      try{const url=new URL(raw,location.href);if(!["https:","http:"].includes(url.protocol))return"[URL 아닌 값 생략]";
        url.username="";url.password="";url.hash="";
        for(const key of [...url.searchParams.keys()])if(/token|cookie|nonce|proof|password|pin|authorization|api.?key|signature|signed|credential|secret/i.test(key))url.searchParams.delete(key);
        return url.href.slice(0,1000);
      }catch{return"";}
    }
    function part(el,repeatedImage=false){
      const tag=el.localName||"*";
      if(el.hasAttribute("data-theme-novel-content"))return"[data-theme-novel-content]";
      if(!repeatedImage&&el.id&&!/\d|@/.test(el.id)&&el.id.length<80)return`#${CSS.escape(el.id)}`;
      const classes=[...el.classList].filter(c=>c.length<80&&!/\d{4}|__[a-zA-Z0-9]{5,}$/.test(c)).slice(0,2);
      if(classes.length)return tag+classes.map(c=>"."+CSS.escape(c)).join("");
      const aria=el.getAttribute("aria-label");
      if(!repeatedImage&&aria&&aria.length<60&&!/@|\d{4}/.test(aria))return`${tag}[aria-label=${JSON.stringify(aria)}]`;
      return tag;
    }
    function matches(scope,selector){try{return [...scope.querySelectorAll(selector)];}catch{return[];}}
    function selector(el,scope,multiple){
      if(el===scope)return":scope";
      const initial=part(el,multiple&&el.tagName==="IMG");
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
      const kind=$("kind").value,key=$("field").value,parentKey=parentField(kind,key);
      const parentLocator=parentKey&&drafts[kind][parentKey];
      let relativeTo;
      if(parentLocator&&key!==parentKey&&JSON.stringify(parentLocator.shadowPath)===JSON.stringify(shadowPath)){
        try{const parent=el.closest(parentLocator.selector);if(parent){scope=parent;shadowPath.length=0;relativeTo=parentKey;}}catch{}
      }
      if(version===3&&parentLocator&&key!==parentKey&&!relativeTo){
        const contains=(parent,node)=>{for(let n=node;n;n=composedParent(n))if(n===parent)return true;return false;};
        const parent=resolve(document,parentLocator).find(n=>contains(n,el));
        if(parent){scope=parent;shadowPath.length=0;relativeTo=parentKey;
          for(const h of hosts.filter(h=>contains(parent,h))){shadowPath.push(selector(h,scope,false));scope=shadow(h);}
        }
      }
      if(version===3&&parentKey&&key!==parentKey&&!relativeTo)throw Error("먼저 "+parentKey+" 루트·반복 영역을 저장하고 그 안의 요소를 선택하세요.");
      const imagePages=version===3&&kind==="reader"&&key==="images";
      return{selector:imagePages?"img":selector(el,scope,$("multiple").checked),shadowPath,attribute:$("attribute").value,multiple:$("multiple").checked,...(relativeTo?{relativeTo}:{})};
    }
    function parentField(kind,key){
      if(key.startsWith("actions."))return null;
      if(kind==="listing"&&key!=="nextPageButton")return"items";
      if(kind==="detail"&&["chapterNumber","chapterTitle","chapterUrl","chapterLabel","notReady","seasonLabel","seasonNumber"].includes(key))return"rows";
      return version===3&&kind==="reader"&&key==="images"?"root":null;
    }
    function checkField(kind,key,l,el){
      if(version!==3)return;
      if(Object.keys(l).some(k=>!["selector","shadowPath","attribute","multiple","relativeTo"].includes(k)))throw Error("선택자 설정에 스크립트나 추가 값을 저장할 수 없습니다.");
      if(!["text","href","src","data-src","imageUrl"].includes(l.attribute))throw Error("지원하는 추출 속성을 선택하세요.");
      const parent=parentField(kind,key);
      if(parent&&key!==parent&&l.relativeTo!==parent)throw Error(parent+" 루트·반복 영역 안의 요소를 지정하세요.");
      if(kind===detected&&nodesFor(l,kind,Infinity).some(forbidden))throw Error("입력칸·스크립트 요소는 저장할 수 없습니다.");
      if(kind!=="reader")return;
      if(key==="root"){
        if(l.multiple!==false)throw Error("본문 루트는 단일 컨테이너여야 합니다.");
        const nodes=el?[el]:detected==="reader"?resolve(document,{...l,multiple:true}):[];
        if(detected==="reader"&&nodes.length!==1||nodes.some(n=>n.tagName==="IMG"||forbidden(n)))throw Error("본문 루트는 이미지 자체가 아닌 단일 컨테이너여야 합니다.");
      }
      if(key==="images"){
        if(l.attribute!=="imageUrl"||l.multiple!==true)throw Error("본문 이미지는 imageUrl 속성과 여러 요소 설정이 필요합니다.");
        if(!drafts.reader.root)throw Error("본문 root 루트를 먼저 저장하세요.");
        const nodes=detected==="reader"?nodesFor(l,kind,Infinity):[];
        if(el&&el.tagName!=="IMG"||detected==="reader"&&!nodes.length||nodes.some(n=>n.tagName!=="IMG"))throw Error("본문 이미지는 root 안의 실제 img 요소를 선택하세요.");
      }
    }
    function highlight(el){
      if(!el||forbidden(el)){outline.style.display="none";return;}
      const box=el.getBoundingClientRect();
      Object.assign(outline.style,{display:"block",left:box.left+"px",top:box.top+"px",width:box.width+"px",height:box.height+"px"});
      $("hover").textContent=`${el.localName}${el.id?" #"+el.id:""}\n${value(el,$("attribute").value).slice(0,220)}`;
    }
    function move(event){
      if(!selecting||isTool(event)||selected||$("kind").value!==detected)return;
      point={x:event.clientX,y:event.clientY};
      if(frame!==null)return;
      frame=requestAnimationFrame(()=>{frame=null;if(selected||!selecting)return;const el=deepest(point.x,point.y);if(el&&el!==host&&el!==outline){target=el;highlight(el);$("parent").disabled=!composedParent(el);$("assign").disabled=true;}});
    }
    function block(event){if(selecting&&!isTool(event)){event.preventDefault();event.stopImmediatePropagation();}}
    function click(event){
      if(!selecting||isTool(event))return;
      event.preventDefault();event.stopImmediatePropagation();
      const el=deepest(event.clientX,event.clientY)||target;
      if(!el||forbidden(el)){error("입력칸·스크립트 대신 공개 작품 정보 영역을 선택하세요.");return;}
      if($("kind").value!==detected){error("이 페이지 유형의 원본 페이지를 먼저 여세요.");return;}
      target=selected=el;candidate();
    }
    function candidate(){
      try{const el=selected||target;if(!el||forbidden(el))return;
        pending=locator(el);highlight(el);outline.style.borderColor="#ffd66b";$("assign").disabled=false;$("parent").disabled=!composedParent(el);
        $("hover").textContent="아직 저장하지 않은 영역\n"+pending.selector;error("‘이 항목 저장’을 눌러 고정하세요.");
      }catch(e){pending=null;$("assign").disabled=true;error(e.message);}
    }
    function assign(){
      const el=selected||target;if(!pending||!el||forbidden(el))return;
      try{const kind=$("kind").value,key=$("field").value;
        if(key==="items"||key==="rows")$("multiple").checked=true;
        const chosen=locator(el);checkField(kind,key,chosen,el);
        const previous=JSON.parse(JSON.stringify(drafts[kind]));drafts[kind][key]=chosen;
        if(key==="items"||key==="rows"||version===3&&kind==="reader"&&key==="root")for(const [child,l] of Object.entries(drafts[kind]))if(l.relativeTo===key)delete drafts[kind][child];
        try{localStorage.setItem(storageKey,JSON.stringify({savedAt:Date.now(),config:exportPreset()}));}catch{drafts[kind]=previous;throw Error("브라우저 저장 공간에 고정하지 못했습니다. 저장 권한을 확인하세요.");}
        pending=null;$("assign").disabled=true;outline.style.display="none";renderFields();showPinned();
        $("hover").textContent="고정됨: "+drafts[kind][key].selector;error("항목을 저장했습니다. 모두 지정하면 ‘프리셋 서버 저장’을 누르세요.");
      }catch(e){error(e.message);}
    }
    function renderFields(){
      $("fields").replaceChildren();
      const kind=$("kind").value;
      for(const [key,l] of Object.entries(drafts[kind])){
        const row=document.createElement("li"),choose=document.createElement("button");choose.textContent="✓ "+(definitions[kind].find(f=>f[0]===key)?.[1]||key);choose.style.float="none";
        choose.onclick=()=>{$("field").value=key;fieldChanged();};row.append(choose,document.createTextNode(" "+l.selector));
        const remove=document.createElement("button");remove.textContent="×";remove.setAttribute("aria-label",key+" 제거");
        remove.onclick=()=>{const previous=JSON.parse(JSON.stringify(drafts[kind]));delete drafts[kind][key];for(const [child,l] of Object.entries(drafts[kind]))if(l.relativeTo===key)delete drafts[kind][child];
          try{localStorage.setItem(storageKey,JSON.stringify({savedAt:Date.now(),config:configValue()}));}catch{drafts[kind]=previous;error("항목 삭제를 저장하지 못했습니다.");return;}
          renderFields();fieldChanged();};row.append(remove);$("fields").append(row);
      }
    }
    function savePattern(kind=$("kind").value){
      const values=$("pattern").value.split(/\r?\n/).map(p=>p.trim()).filter(Boolean);
      if(!values.length||values.some(p=>!p.startsWith("/")||/[?#]/.test(p)))throw Error("쿼리 없는 페이지 패턴을 한 줄에 하나씩 입력하세요.");
      pagePatterns[kind]=version===3?values:values[0];
    }
    function kindChanged(){
      const kind=$("kind").value;$("field").replaceChildren();
      for(const [key,label] of definitions[kind]){const option=document.createElement("option");option.value=key;option.textContent=label;$("field").append(option);}
      $("pattern").value=version===3?pagePatterns[kind].join("\n"):pagePatterns[kind];fieldChanged();renderFields();
      if(kind==="reader"&&contentType!=="novel"){$("field").value="images";fieldChanged();}
      if(kind!==detected)error("이 유형은 다른 원본 페이지에서 지정하세요. 현재 페이지: "+labels[detected]);
    }
    function fieldChanged(){
      const f=definitions[$("kind").value].find(f=>f[0]===$("field").value);
      const saved=drafts[$("kind").value][f[0]];
      $("attribute").value=saved?.attribute||f[2]||"text";$("multiple").checked=saved?.multiple??!!f[3];selected=target=null;pending=null;
      $("assign").disabled=true;$("parent").disabled=true;$("result").hidden=true;$("result").textContent="";outline.style.display="none";
      $("hover").textContent=saved?"고정됨: "+saved.selector:"이 항목의 영역을 클릭한 뒤 저장하세요.";error();showPinned(true);
    }
    function configValue(){return{version,...(version===3?{contentType,catalogOrder:$("catalog-order").value}:{}),name:$("name").value.trim(),origin:location.origin,pages:Object.fromEntries(Object.keys(definitions).map(kind=>{
      const fields=JSON.parse(JSON.stringify(drafts[kind]));
      if(version===2)return[kind,{pagePattern:pagePatterns[kind],fields}];
      const actions={};for(const key of Object.keys(fields))if(key.startsWith("actions.")){actions[key.slice(8)]=fields[key];delete fields[key];}
      return[kind,{pagePatterns:[...pagePatterns[kind]],...(kind==="listing"&&sources?{sources:JSON.parse(JSON.stringify(sources))}:{}),fields,...(Object.keys(actions).length?{actions}:{})}];
    }))};}
    function exportPreset(){
      if(version===2&&!Object.values(drafts).some(fields=>Object.keys(fields).length))throw Error("추출 항목을 한 개 이상 저장하세요.");
      const name=$("name").value.trim();if(!name||name.length>80)throw Error("이름을 확인하세요.");savePattern();
      for(const [kind,fields] of Object.entries(drafts))for(const [key,field] of Object.entries(fields)){
        if(field.relativeTo&&!fields[field.relativeTo])throw Error("상대 항목의 반복 영역을 다시 지정하세요.");
        checkField(kind,key,field);
      }
      const config=configValue();if(JSON.stringify(config).length>32768)throw Error("설정 크기가 너무 큽니다.");return config;
    }
    function resolve(scope,l,limit=20){
      for(const s of l.shadowPath||[]){const h=s===":scope"&&scope.nodeType===1?scope:scope.querySelector(s);scope=h&&shadow(h);if(!scope)return[];}
      const nodes=l.selector===":scope"&&scope.nodeType===1?[scope]:[...scope.querySelectorAll(l.selector)];
      return l.multiple?nodes.slice(0,limit):nodes.slice(0,1);
    }
    function nodesFor(l,kind=$("kind").value,limit=20){const parent=l.relativeTo&&drafts[kind][l.relativeTo];const scopes=l.relativeTo?(parent?resolve(document,parent,limit):[]):[document];return scopes.slice(0,limit).flatMap(s=>resolve(s,l,limit)).slice(0,limit);}
    function previewPreset(key=$("field").value){
      const l=key===$("field").value&&pending?pending:drafts[$("kind").value][key];
      if(!l)throw Error("이 항목의 범위를 선택하거나 저장하세요.");
      if($("kind").value!==detected)throw Error("이 항목의 원본 페이지에서 미리보기하세요.");
      return{[key]:nodesFor(l).slice(0,5).map(el=>value(el,l.attribute).slice(0,300))};
    }
    function showPinned(scroll=false){
      fixed.splice(0).forEach(el=>el.remove());const l=drafts[$("kind").value][$("field").value];
      if(!l||$("kind").value!==detected)return;
      let nodes;try{nodes=nodesFor(l).filter(el=>!forbidden(el));}catch{return;}
      if(scroll&&nodes[0])nodes[0].scrollIntoView({block:"nearest"});
      for(const el of nodes){const r=el.getBoundingClientRect();if(!r.width||!r.height)continue;const box=document.createElement("div");
        box.style.cssText="position:fixed;pointer-events:none;z-index:2147483645;border:2px solid #58e2bb;background:#58e2bb19;";
        Object.assign(box.style,{left:r.left+"px",top:r.top+"px",width:r.width+"px",height:r.height+"px"});box.dataset.ncPinned="true";document.documentElement.append(box);fixed.push(box);}
    }
    function refreshPinned(){if(restoreFrame!==null)return;restoreFrame=requestAnimationFrame(()=>{restoreFrame=null;showPinned();if(selected&&pending)highlight(selected);});}
    function close(){
      if(closed)return;closed=true;if(frame!==null)cancelAnimationFrame(frame);
      if(restoreFrame!==null)cancelAnimationFrame(restoreFrame);observer?.disconnect();fixed.splice(0).forEach(el=>el.remove());
      document.removeEventListener("scroll",refreshPinned,true);window.removeEventListener("resize",refreshPinned);
      document.removeEventListener("load",refreshPinned,true);
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
    $("close").onclick=close;$("parent").onclick=()=>{const parent=composedParent(selected||target);if(parent&&parent!==host){target=selected=parent;candidate();}};
    let activeKind=detected;
    $("assign").onclick=assign;$("kind").onchange=()=>{try{savePattern(activeKind);activeKind=$("kind").value;kindChanged();}catch(e){$("kind").value=activeKind;error(e.message);}};$("field").onchange=fieldChanged;
    $("mode").onclick=()=>{selecting=!selecting;selected=null;outline.style.display="none";$("mode").textContent=selecting?"선택 중":"페이지 탐색";document.documentElement.style.cursor=selecting?"crosshair":originalCursor;};
    $("preview").onclick=()=>{try{$("result").hidden=false;$("result").textContent=JSON.stringify(previewPreset(),null,2);error();}catch(e){error(e.message);}};
    $("attribute").onchange=$("multiple").onchange=()=>{if(selected)candidate();};
    $("save-preset").onclick=()=>{
      try{if(pending)throw Error("선택한 항목을 먼저 저장하세요.");const config=exportPreset();
        if(!options.dashboardUrl||!options.bridgeToken)throw Error("대시보드에서 새 프리셋 북마크를 등록하면 서버 저장을 연결할 수 있습니다. 설정 JSON 복사도 가능합니다.");
        const destination=new URL(options.dashboardUrl);destination.hash="preset-return="+encodeURIComponent(JSON.stringify({token:options.bridgeToken,config}));
        window.open(destination.href,"_blank","noopener,noreferrer");error("대시보드 저장 화면을 열었습니다. 서버 저장 완료 상태를 확인하세요.");
      }catch(e){error(e.message);}
    };
    $("copy").onclick=async()=>{
      try{const text=JSON.stringify(exportPreset(),null,2);$("export").value=text;
        try{await navigator.clipboard.writeText(text);error("프리셋 JSON을 복사했습니다. 대시보드의 추출 프리셋에 붙여 넣으세요.");}
        catch{$("export").hidden=false;$("export").focus();$("export").select();error("아래 JSON을 Ctrl+C로 복사하세요.");}
      }catch(e){error(e.message);}
    };
    for(const [kind,label] of Object.entries(labels)){const o=document.createElement("option");o.value=kind;o.textContent=label;$("kind").append(o);}
    let existing=options.preset;
    try{const cached=JSON.parse(localStorage.getItem(storageKey));if(cached?.config?.origin===location.origin&&(cached.config.contentType||"novel")===contentType&&(cached.config.version===3?3:2)===version&&cached.savedAt>(Date.parse(options.updatedAt)||0))existing=cached.config;}catch{}
    $("kind").value=detected;$("name").value=existing?.origin===location.origin?existing.name:options.name||`${location.hostname} 수집 프리셋`;
    if(version===3)$("catalog-order").value=existing?.catalogOrder==="oldest-first"?"oldest-first":"newest-first";
    if(existing?.origin===location.origin){
      const pages=existing.version>=2?existing.pages:{[existing.kind]:{pagePattern:existing.pagePattern,fields:existing.fields}};
      if(version===3&&pages?.listing?.sources)sources=JSON.parse(JSON.stringify(pages.listing.sources));
      for(const [oldKind,page] of Object.entries(pages||{})){
        const kind=oldKind==="catalog"?"detail":oldKind;if(!definitions[kind])continue;
        if(version===3&&Array.isArray(page.pagePatterns)&&page.pagePatterns.length)pagePatterns[kind]=[...page.pagePatterns];
        else if(version===2&&page.pagePattern)pagePatterns[kind]=page.pagePattern;
        for(const [oldField,l] of Object.entries(page.fields||{})){const field=oldKind==="catalog"?({number:"chapterNumber",title:"chapterTitle",url:"chapterUrl"}[oldField]||oldField):oldField;
          if(definitions[kind].some(f=>f[0]===field))drafts[kind][field]=l;}
        if(version===3)for(const [key,l] of Object.entries(page.actions||{}))if(definitions[kind].some(f=>f[0]==="actions."+key))drafts[kind]["actions."+key]=l;
      }
    }
    kindChanged();
    if(definitions[$("kind").value].some(f=>f[0]===options.field)){
      $("field").value=options.field;fieldChanged();
      if(["text","href","src","data-src",...(version===3?["imageUrl"]:[])].includes(options.attribute))$("attribute").value=options.attribute;
      if(typeof options.multiple==="boolean")$("multiple").checked=options.multiple;
    }
    document.documentElement.style.cursor="crosshair";
    document.addEventListener("pointermove",move,true);document.addEventListener("pointerdown",block,true);document.addEventListener("click",click,true);document.addEventListener("keydown",key,true);
    document.addEventListener("scroll",refreshPinned,true);window.addEventListener("resize",refreshPinned);
    document.addEventListener("load",refreshPinned,true);
    const observer=new MutationObserver(refreshPinned);if(document.body)observer.observe(document.body,{childList:true,attributes:true,attributeFilter:["class","style","hidden"],subtree:true});
    const controller={close,exportPreset,previewPreset};window.__NC_ELEMENT_PICKER__=controller;
    return controller;
  }
  window.CollectorElementPicker = {
    start: startPicker,
    bookmarklet(options = {}) { return "javascript:" + encodeURIComponent(`void (${startPicker.toString()})(${JSON.stringify(options)})`); },
  };
})();
