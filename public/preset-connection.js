"use strict";
(() => {
  const UI=window.CollectorUI,$=id=>document.getElementById(id);
  const example=()=>window.CollectorPresetGuide.definitions[$("preset-kind").value].example;
  $("preset-source-url").value=example();
  $("preset-kind").addEventListener("change",()=>{$("preset-source-url").value=example();});
  document.addEventListener("preset:type",()=>{$("preset-source-url").value=example();});
  $("preset-connect-form").addEventListener("submit",event=>{
    event.preventDefault();if(!UI.authenticated()||UI.view()!=="presets")return;
    const link=$("preset-source-open-link");link.removeAttribute("href");link.hidden=true;$("preset-connection-status").textContent="";
    let url;try{
      const input=$("preset-source-url").value.trim();url=new URL(input);
      if(input.length>2000||url.protocol!=="https:"||url.username||url.password)throw Error();
    }catch{$("preset-connection-error").textContent="인증정보가 포함되지 않은 원본 HTTPS 링크를 입력하세요.";return;}
    const selected=new CustomEvent("preset:source",{detail:url.href,cancelable:true});
    if(!document.dispatchEvent(selected))return;
    link.href=url.href;link.hidden=false;
    const kind=/^\/(?:novel|webtoon|manhwa)\/[^/]+\/[^/]+\/?$/.test(url.pathname)?"reader":/^\/(?:novel|webtoon|manhwa)\/[^/]+\/?$/.test(url.pathname)?"detail":/^\/(?:novel|ing|end|manhwa)\/?$/.test(url.pathname)?"listing":$("preset-kind").value;
    if($("preset-kind").value!==kind){$("preset-kind").value=kind;$("preset-kind").dispatchEvent(new Event("change"));$("preset-source-url").value=url.href;}
    $("preset-connection-error").textContent="";
    window.open(url.href,"_blank","noopener,noreferrer");
    $("preset-connection-status").textContent="열린 원본 탭에서 등록한 ‘수집 영역 선택’ 북마크를 클릭하세요. 북마크바가 안 보이면 Ctrl+Shift+B (Mac: ⌘+Shift+B)로 표시하세요. 탭이 열리지 않으면 아래 원본 링크를 누르세요.";
  });
  document.addEventListener("collector:auth",()=>{if(!UI.authenticated()){
    $("preset-source-url").value="";$("preset-source-open-link").removeAttribute("href");$("preset-source-open-link").hidden=true;
    $("preset-connection-status").textContent="";$("preset-connection-error").textContent="";
  }});
})();
