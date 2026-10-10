"use strict";
(() => {
  let definitions={
    listing:{label:"작품 목록",description:"여러 작품이 카드로 나오는 검색·목록 페이지입니다. 카드 한 개의 바깥 영역을 먼저 선택하고 그 안의 제목·링크를 지정하세요.",fields:[
      ["items","작품 카드 (먼저)","한 작품의 표지·제목·작가·링크를 함께 감싸는 카드 한 개. 모든 카드를 한 번에 감싼 목록 전체는 선택하지 마세요.","text",true],
      ["title","제목","카드 안의 작품 이름만 선택합니다."],["author","작가","작가명만 선택합니다."],["genres","장르","판타지·로맨스 등 장르 표시를 선택합니다.","text",true],["tags","태그","회귀·성장 등 여러 태그를 선택합니다.","text",true],["platform","공급처","출판사·연재 플랫폼 표시를 선택합니다."],["episodeCount","회차 수","총 120화 등 회차 수 표시를 선택합니다."],["publication","연재 상태","연재중·완결 표시를 선택합니다."],["thumbnail","표지","표지 이미지 자체를 선택합니다. 지연 로딩이면 data-src를 사용하세요.","src"],["url","작품 링크","작품 소개로 이동하는 링크나 링크가 걸린 카드 자체를 선택합니다.","href"],["updatedLabel","업데이트 표시","최신 업데이트 시간·날짜 표시를 선택합니다."],["nextPageButton","다음 페이지 버튼","목록의 다음 페이지로 이동하는 버튼입니다. 작품 카드 안의 항목이 아닙니다."]]},
    detail:{label:"작품 소개",description:"작품 하나의 표지·작가·태그·줄거리가 나오는 소개 페이지입니다. 회차 목록이나 실제 본문과 구분하세요.",fields:[
      ["title","제목","소개 페이지의 작품 제목만 선택합니다."],["author","작가","작가명만 선택합니다."],["genres","장르","작품 장르 표시를 선택합니다.","text",true],["tags","태그","작품에 붙은 태그들을 선택합니다.","text",true],["platform","공급처","출판사·연재 플랫폼 이름입니다."],["episodeCount","회차 수","이 작품의 전체 화수 표시입니다."],["publication","연재 상태","연재중·완결 표시입니다."],["synopsis","작품 소개","소개·줄거리 문단 전체입니다. 실제 회차 본문은 여기서 선택하지 마세요."],["thumbnail","표지","작품 표지 이미지 자체를 선택합니다.","src"]]},
    catalog:{label:"회차 목차",description:"1화·2화처럼 회차가 줄마다 나오는 목차 페이지입니다. 회차 행 하나를 먼저 고른 뒤 번호·제목·링크를 지정하세요.",fields:[
      ["rows","회차 행 (먼저)","한 회차의 번호·제목·링크를 함께 감싸는 행 하나입니다. 목차 전체는 선택하지 마세요.","text",true],["number","회차 번호","1화·2화 등 번호 표시입니다."],["title","회차 제목","행 안의 회차 이름입니다. 작품 전체 제목과 구분하세요."],["url","회차 링크","해당 회차 본문으로 이동하는 링크입니다.","href"],["notReady","준비중 표시","미업로드·준비중으로 표시된 행의 안내입니다."],["expectedChapters","전체 회차 수","목차 위에 표시되는 전체 화수입니다."],["moreButton","더 보기 버튼","이전 회차를 추가로 펼치는 버튼입니다."]]},
    reader:{label:"회차 본문",description:"실제로 소설을 읽는 회차 페이지입니다. 광고·메뉴를 제외한 본문 영역을 선택하세요.",fields:[
      ["root","본문 루트","본문 문단 전체를 감싸는 바깥 영역입니다. 페이지 전체나 광고를 포함하지 마세요."],["text","본문 텍스트","실제 소설 문단 영역입니다. 제목·광고·메뉴는 제외합니다."],["notice","로딩·오류 안내","본문 대신 표시되는 로딩·오류·준비중 안내입니다. 정상 소설 문장을 지정하지 마세요."]]}
  };
  definitions.listing.label="소설 목록";definitions.listing.example="https://sbxh9.com/novel";
  definitions.listing.description="/novel — 여러 소설이 나열된 목록 페이지입니다. 소설 카드 한 개를 먼저 저장하고, 그 카드 안의 제목·작가·정보 페이지 링크를 지정합니다. 회차 번호나 본문은 이 페이지의 항목이 아닙니다.";
  definitions.detail.label="소설 정보·회차 목록";definitions.detail.example="https://sbxh9.com/novel/58387";
  definitions.detail.description="/novel/{소설 ID} — 소설 하나의 정보 페이지입니다. 위쪽 제목·작가·줄거리와 아래쪽 회차 목록을 같은 페이지 유형에서 지정합니다. 소설 제목과 회차 제목을 구분하세요.";
  definitions.detail.fields[0][1]="소설 제목";definitions.detail.fields[7][1]="줄거리";
  definitions.detail.fields.push(...definitions.catalog.fields.map(([key,...rest])=>[({number:"chapterNumber",title:"chapterTitle",url:"chapterUrl"}[key]||key),...rest]));
  delete definitions.catalog;
  definitions.reader.example="https://sbxh9.com/novel/58387/8837326";
  definitions.reader.description="/novel/{소설 ID}/{회차 ID} — 특정 회차를 읽는 본문 페이지입니다. 소설 정보·회차 목록이 아닌 실제 소설 문단을 지정합니다. 메뉴·광고·댓글은 제외하세요.";
  const legacyDefinitions=definitions;
  function v3Definitions(contentType){
    const webtoon=contentType!=="novel",name=contentType==="manhwa"?"만화":webtoon?"웹툰":"소설",path=webtoon?contentType:"novel";
    const keys={listing:["items","title","url","authors","genres","tags","platform","thumbnail","publication","episodeCount","updatedLabel","rating","actions.nextPage","actions.loadMore"],detail:["title","authors","genres","tags","platform","synopsis","thumbnail","publication","episodeCount","rows","chapterTitle","chapterUrl","chapterLabel","notReady","expectedChapters","seasonLabel","seasonNumber","actions.loadMore","actions.nextPage"],reader:["root",webtoon?"images":"text","notice"]};
    const additions={authors:["authors","작가","작가·그림 작가 등 이름 요소를 각각 선택합니다.","text",true],rating:["rating","평점","작품의 별점·평점 원문 표시를 선택합니다."],chapterLabel:["chapterLabel","회차 표시","외전·프롤로그·12화 등 회차 원문 문구를 선택합니다. 숫자로 바꾸지 않습니다."],seasonLabel:["seasonLabel","시즌 이름","회차가 속한 시즌의 원문 이름이나 제목을 선택합니다."],seasonNumber:["seasonNumber","시즌 번호","회차가 속한 시즌의 번호 표시를 선택합니다."],images:["images","웹툰 이미지","본문 루트를 먼저 저장하고 그 루트 안의 img 이미지 요소를 여러 개 선택하세요. 표시되는 이미지 주소를 사용합니다.","imageUrl",true]};
    return Object.fromEntries(Object.entries(keys).map(([kind,fields])=>{
      const source=legacyDefinitions[kind];
      const tuples=fields.map(key=>{
        if(additions[key])return [...additions[key]];
        const oldKey=({"actions.nextPage":"nextPageButton","actions.loadMore":"moreButton"}[key]||key);
        const field=source.fields.find(field=>field[0]===oldKey)||legacyDefinitions[oldKey==="moreButton"?"detail":"listing"].fields.find(field=>field[0]===oldKey);
        if(kind==="listing"&&key==="actions.loadMore")return [key,"더 보기 버튼","다음 작품들을 같은 목록에 추가로 펼치는 버튼입니다."];
        if(kind==="detail"&&key==="actions.nextPage")return [key,"다음 페이지 버튼","회차 목록의 다음 페이지로 이동하는 버튼입니다."];
        const [,label,description,...options]=field;
        return [key,label.replace(/소설/g,name),description.replace(/소설/g,name),...options];
      });
      if(kind==="reader"&&webtoon)tuples[0]=["root","웹툰 본문 루트 (먼저)","웹툰 이미지 전체를 감싸는 본문 루트를 먼저 저장합니다. 광고·메뉴·댓글을 제외하세요."];
      const label=kind==="listing"?`${name} 목록`:kind==="detail"?`${name} 정보·회차 목록`:`${name} 회차 본문`;
      const example=`https://example.com/${kind==="listing"?"ing":`${path}/58387${kind==="reader"?"/8837326":""}`}`;
      const description=kind==="listing"?`/ing · /end — 연재중·완결 ${name} 목록입니다. 작품 카드 한 개를 먼저 저장하고 카드 안의 정보와 목록의 다음 페이지 동작을 지정하세요.`:kind==="detail"?`/${path}/{workId} — ${name} 정보와 회차 목록입니다. 작품 제목·작가·줄거리와 회차 행을 구분하고 시즌 표시와 더 보기 동작을 지정하세요.`:`/${path}/{workId}/{episodeId} — ${name} 회차 본문입니다. ${webtoon?"본문 루트를 먼저 저장한 뒤 루트 안의 여러 img 이미지를 선택하세요.":"실제 소설 문단을 선택하세요."} 광고·메뉴·댓글을 제외합니다.`;
      return [kind,{label,description,example,fields:tuples}];
    }));
  }
  const slots={title:[100,77,146,22],author:[100,106,110,18],genres:[100,131,120,18],tags:[36,163,200,20],platform:[36,191,100,16],episodeCount:[151,191,90,16],publication:[36,215,90,16],thumbnail:[36,77,53,70],url:[24,60,238,183],updatedLabel:[141,215,102,16],items:[24,60,238,183],nextPageButton:[92,290,105,27],synopsis:[24,258,238,59],rows:[24,98,238,34],number:[30,104,40,22],notReady:[183,148,67,23],expectedChapters:[166,68,87,20],moreButton:[75,278,145,28],root:[24,80,238,190],text:[36,96,214,154],notice:[24,286,238,28]};
  function illustration(kind,key){
    const def=definitions[kind],label=def.fields.find(f=>f[0]===key)[1];let content="";
    const type=kind==="detail"&&["rows","chapterNumber","chapterTitle","chapterUrl","chapterLabel","notReady","expectedChapters","seasonLabel","seasonNumber","moreButton","actions.loadMore","actions.nextPage"].includes(key)?"catalog":kind;
    const slotKey=({authors:"author",rating:"episodeCount",chapterNumber:"number",chapterTitle:"title",chapterUrl:"url",chapterLabel:"number","actions.nextPage":"nextPageButton","actions.loadMore":"moreButton"}[key]||key);
    const text=(x,y,value)=>`<text x="${x}" y="${y}" font-size="11" fill="#b7c7dc">${value}</text>`;
    if(type==="listing"||type==="detail"){
      content=`<rect x="24" y="60" width="238" height="183" rx="8" fill="#26374e"/><rect x="36" y="77" width="53" height="70" rx="5" fill="#496484"/>${text(44,114,"표지")}${text(104,92,"별빛 여행기")}${text(104,119,"작가 · 김별빛")}${text(104,145,"판타지 · 모험")}${text(38,177,"#성장  #우정  #여행")}${text(38,203,"별빛 출판")}${text(155,203,key!=="episodeCount"&&def.fields.some(field=>field[0]==="rating")?"평점 4.8":"총 120화")}${text(38,227,"연재중")}${text(145,227,"오늘 업데이트")}`;
      if(kind==="listing")content+=`<rect x="24" y="251" width="238" height="29" rx="6" fill="#26374e"/>${text(40,270,"다음 작품 카드 …")}<rect x="92" y="290" width="105" height="27" rx="6" fill="#405a78"/>${text(112,308,key==="actions.loadMore"?"작품 더 보기":"다음 페이지 →")}`;
      else content+=`<rect x="24" y="258" width="238" height="59" rx="6" fill="#26374e"/>${text(36,276,"작품 소개")}${text(36,294,"작은 마을을 떠난 주인공이")}${text(36,309,"새로운 세계를 만나는 이야기 …")}`;
    }else if(type==="catalog"){
      content=text(24,61,`↑ 같은 ${def.label.includes("웹툰")?"웹툰":"소설"} 정보 페이지의 아래 영역`)+text(30,82,key.startsWith("season")?"시즌 2 · 봄의 여정":"회차 목록")+text(171,82,"총 120화");
      for(let i=0;i<4;i++)content+=`<rect x="24" y="${98+i*43}" width="238" height="34" rx="5" fill="#26374e"/>${text(32,119+i*43,`${i+1}화`)}${text(79,119+i*43,i===1?"다음 이야기":"모험의 시작")}${text(191,119+i*43,i===1?"준비중":"읽기 →")}`;
      content+=`<rect x="75" y="278" width="145" height="28" rx="6" fill="#405a78"/>${text(103,297,key==="actions.nextPage"?"다음 페이지 →":"이전 회차 더 보기")}`;
    }else{
      content=text(30,66,"1화 · 모험의 시작")+`<rect x="24" y="80" width="238" height="190" rx="6" fill="#26374e"/>`;
      if(def.fields.some(field=>field[0]==="images")){
        for(let i=0;i<3;i++)content+=`<rect data-image-panel="${i+1}" x="36" y="${87+i*59}" width="214" height="53" rx="4" fill="${["#496484","#405a78","#34465f"][i]}"/>${text(47,118+i*59,`웹툰 이미지 ${i+1}`)}`;
      }else for(let i=0;i<7;i++)content+=text(38,112+i*21,["새벽빛이 창문을 두드렸다.","그는 오래된 지도를 펼쳤다.","산 너머에는 무엇이 있을까.","첫 걸음이 길을 만들었다."][i%4]);
      content+=`<rect x="24" y="286" width="238" height="28" rx="5" fill="#26374e"/>${text(36,304,"로딩·오류 때 나타나는 안내")}`;
    }
    let box=slots[slotKey];if(type==="catalog"&&slotKey==="title")box=[76,104,106,22];if(type==="catalog"&&slotKey==="url")box=[188,104,67,22];
    if(slotKey==="images")box=[36,87,214,171];if(slotKey==="seasonLabel")box=[87,68,75,20];if(slotKey==="seasonNumber")box=[27,68,59,20];
    if(kind==="listing"&&key==="actions.loadMore")box=slots.nextPageButton;if(type==="catalog"&&key==="actions.nextPage")box=slots.moreButton;
    const [x,y,width,height]=box;
    const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");svg.setAttribute("viewBox","0 0 286 340");svg.setAttribute("role","img");svg.setAttribute("aria-label",`${def.label}: ${label} 선택 영역 예시`);
    svg.innerHTML=`<title>${def.label} · ${label}</title><rect width="286" height="340" rx="10" fill="#172336"/><rect x="16" y="15" width="254" height="26" rx="5" fill="#34465f"/>${text(25,33,"example.com · 합성 페이지 예시")}${content}<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="4" fill="#58e2bb" fill-opacity="0.16" stroke="#58e2bb" stroke-width="3"/><rect x="16" y="322" width="254" height="16" rx="4" fill="#172336"/>${text(25,334,"초록 테두리: 지금 선택할 영역")}`;
    return svg;
  }
  const $=id=>document.getElementById(id);
  function select(notify=true){
    const kind=$("preset-kind").value,key=$("preset-target-field").value;
    $("preset-guide-focus").replaceChildren(illustration(kind,key));
    const field=definitions[kind].fields.find(f=>f[0]===key);
    $("preset-field-help").textContent=field[2];$("preset-target-attribute").value=field[3]||"text";$("preset-target-multiple").checked=!!field[4];
    for(const card of $("preset-field-gallery").children)card.setAttribute("aria-pressed",String(card.dataset.field===key));
    if(notify)document.dispatchEvent(new CustomEvent("preset:guide"));
  }
  function render(){
    const kind=$("preset-kind").value,def=definitions[kind];
    $("preset-guide-description").textContent=def.description+" 예: "+def.example;$("preset-target-field").replaceChildren();$("preset-field-gallery").replaceChildren();
    for(const [key,label,description] of def.fields){
      const option=document.createElement("option");option.value=key;option.textContent=label;$("preset-target-field").append(option);
      const card=document.createElement("button");card.type="button";card.className="preset-field-card";card.dataset.field=key;
      const title=document.createElement("strong");title.textContent=label;const p=document.createElement("p");p.textContent=description;
      card.append(illustration(kind,key),title,p);card.onclick=()=>{$("preset-target-field").value=key;select();};$("preset-field-gallery").append(card);
    }
    select(false);
  }
  $("preset-kind").addEventListener("change",render);$("preset-target-field").addEventListener("change",()=>select());
  for(const id of ["preset-target-attribute","preset-target-multiple"])$(id).addEventListener("change",()=>document.dispatchEvent(new CustomEvent("preset:guide")));
  function setPreset(config){
    definitions=config?.version===3?v3Definitions(config.contentType):legacyDefinitions;
    const imageOption=$("preset-target-attribute").querySelector('option[value="imageUrl"]');
    if(imageOption){imageOption.disabled=config?.version!==3;imageOption.hidden=imageOption.disabled;}
    for(const option of $("preset-kind").options)if(definitions[option.value])option.textContent=definitions[option.value].label;
    render();
  }
  window.CollectorPresetGuide={get definitions(){return definitions;},definitionsFor:config=>config?.version===3?v3Definitions(config.contentType):legacyDefinitions,render,setPreset};render();
})();
