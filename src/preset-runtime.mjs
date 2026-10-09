import {createHash} from "node:crypto";
import {validatePreset,groupPreset} from "./extraction-presets.mjs";

export const RUNTIME_FIELDS=Object.freeze({
  listing:["items","title","url","authors","genres","tags","platform","thumbnail","publication","updatedLabel","rating","episodeCount"],
  detail:["title","authors","genres","tags","platform","synopsis","thumbnail","publication","episodeCount","rows","chapterTitle","chapterUrl","chapterLabel","notReady","expectedChapters","seasonLabel","seasonNumber"],
  reader:["root","text","images","notice"],
});
const bad=message=>Object.assign(Error(message),{status:400});
const exact=(value,keys)=>{if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw bad("프리셋 실행 규격에 없는 항목입니다.");};
function legacyCommon(input){return validatePreset({version:1,name:input.name,origin:input.origin,pagePattern:"/",kind:"detail",fields:{title:{selector:"h1",attribute:"text",multiple:false}}});}
function pattern(value){
  validatePreset({version:1,name:"경로 검증",origin:"https://example.com",pagePattern:value,kind:"detail",fields:{title:{selector:"h1",attribute:"text",multiple:false}}});
  if(/[{}]/.test(value.replace(/\{(?:workId|episodeId)\}/g,"")))throw bad("허용되지 않은 페이지 경로 변수입니다.");return value;
}
function locator(value){
  exact(value,["selector","shadowPath","attribute","multiple","relativeTo"]);
  if(!["text","href","src","data-src","imageUrl"].includes(value.attribute))throw bad("지원하지 않는 추출 속성입니다.");
  const item=validatePreset({version:1,name:"선택자 검증",origin:"https://example.com",pagePattern:"/",kind:"detail",fields:{title:{selector:value.selector,shadowPath:value.shadowPath,attribute:value.attribute==="imageUrl"?"src":value.attribute,multiple:value.multiple}}}).fields.title;
  return{...item,attribute:value.attribute,...(value.relativeTo!=null?{relativeTo:value.relativeTo}:{})};
}
export function validatePresetV3(input){
  exact(input,["version","contentType","name","origin","catalogOrder","pages"]);
  if(input.version!==3||!["novel","webtoon"].includes(input.contentType)||Buffer.byteLength(JSON.stringify(input))>32768)throw bad("버전 3 콘텐츠 유형과 설정 크기를 확인하세요.");
  if(!["oldest-first","newest-first"].includes(input.catalogOrder))throw bad("목차 순서를 명시적으로 지정하세요.");
  const common=legacyCommon(input);exact(input.pages,Object.keys(RUNTIME_FIELDS));const pages={};
  for(const[kind,allowed]of Object.entries(RUNTIME_FIELDS)){
    const page=input.pages[kind];exact(page,["pagePatterns","fields","sources","actions"]);exact(page.fields,allowed);
    if(!Array.isArray(page.pagePatterns)||!page.pagePatterns.length||page.pagePatterns.length>8)throw bad("페이지 경로를 지정하세요.");
    const fields={};for(const[key,value]of Object.entries(page.fields)){
      const item=locator(value),parent=kind==="listing"?"items":kind==="detail"?"rows":"root";
      const attributes=["url","chapterUrl"].includes(key)?["href"]:key==="thumbnail"?["src","data-src","imageUrl"]:key==="images"?["imageUrl"]:["text"];
      if(!attributes.includes(item.attribute))throw bad(`추출 항목의 속성이 맞지 않습니다: ${key}`);
      if(item.relativeTo!=null&&(item.relativeTo!==parent||key===parent||!page.fields[parent]))throw bad("상대 선택자의 부모 영역을 확인하세요.");
      if(["items","rows","images"].includes(key)&&!item.multiple)throw bad("반복 영역은 multiple true여야 합니다.");
      if(key==="images"&&(kind!=="reader"||input.contentType!=="webtoon"||item.relativeTo!=="root"))throw bad("웹툰 이미지는 지정한 본문 루트 안에서만 추출합니다.");
      if(key==="root"&&item.multiple)throw bad("본문 루트는 하나여야 합니다.");fields[key]=item;
    }
    const clean={pagePatterns:page.pagePatterns.map(pattern),fields};
    if(kind==="listing"&&input.contentType==="webtoon"&&(!page.sources?.ongoing||!page.sources?.completed))throw bad("웹툰 연재·완결 목록 원천을 지정하세요.");
    if(page.sources){if(kind!=="listing")throw bad("목록 원천은 listing에서만 지정합니다.");exact(page.sources,["ongoing","completed","search"]);clean.sources=Object.fromEntries(Object.entries(page.sources).map(([key,value])=>[key,pattern(value)]));}
    if(page.actions){exact(page.actions,["nextPage","loadMore"]);clean.actions=Object.fromEntries(Object.entries(page.actions).map(([key,value])=>{const item=locator(value);if(item.multiple||item.relativeTo)throw bad("페이지 동작은 단일 독립 버튼이어야 합니다.");return[key,item];}));}
    pages[kind]=clean;
  }
  return{version:3,contentType:input.contentType,name:common.name,origin:common.origin,catalogOrder:input.catalogOrder||"oldest-first",pages};
}
export function compilePreset(input){
  if(input.version===3)return validatePresetV3(input);
  const old=groupPreset(input),pages={};
  for(const[kind,page]of Object.entries(old.pages)){
    const fields={},actions={};for(const[key,value]of Object.entries(page.fields)){
      if(["nextPageButton","moreButton"].includes(key)){actions[key==="nextPageButton"?"nextPage":"loadMore"]=structuredClone(value);continue;}
      fields[key==="author"?"authors":key==="chapterNumber"?"chapterLabel":key]=structuredClone(value);
    }
    pages[kind]={pagePatterns:[page.pagePattern],fields,...(Object.keys(actions).length?{actions}:{})};
  }
  return validatePresetV3({version:3,contentType:"novel",name:old.name,origin:old.origin,catalogOrder:"oldest-first",pages});
}
export function validateRunnablePreset(input){
  const config=compilePreset(input);
  const required={listing:["items","title","url"],detail:["title","rows","chapterUrl"],reader:["root",config.contentType==="webtoon"?"images":"text"]};
  for(const[kind,keys]of Object.entries(required))for(const key of keys)if(!config.pages[kind].fields[key])throw bad(`실행 필수 항목이 없습니다: ${kind}.${key}`);
  if(config.pages.listing.fields.url.attribute!=="href"||config.pages.detail.fields.chapterUrl.attribute!=="href")throw bad("작품·회차 링크는 href로 지정하세요.");
  if(config.contentType==="webtoon"&&config.pages.reader.fields.images.attribute!=="imageUrl")throw bad("웹툰 본문 이미지는 imageUrl로 지정하세요.");
  return config;
}
export function presetHash(config){
  const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
  return createHash("sha256").update(JSON.stringify(sorted(compilePreset(config)))).digest("hex");
}
export function matchesPresetPage(config,kind,value){
  const url=new URL(value);if(url.origin!==config.origin||url.username||url.password||url.port||url.hash)return false;
  let path;try{const segments=url.pathname.split("/").map(value=>decodeURIComponent(value));if(segments.some(value=>/[\/\\\x00-\x1f]/.test(value)))return false;path=segments.join("/");}catch{return false;}
  return config.pages[kind]?.pagePatterns.some(value=>{const expression=value.split(/(\{workId\}|\{episodeId\})/).map(part=>/^\{/.test(part)?"[\\p{L}\\p{N}_-]{1,100}":part.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("");return new RegExp("^"+expression+"/?$","u").test(path);})||false;
}

export function evaluatePresetPage(page,doc=document){
  const fail=(code,key)=>{throw Object.assign(Error(`${code}: ${key}`),{code,field:key});};
  const fields=page.fields||{},matches={};
  function resolve(scope,locator,key){
    for(const selector of locator.shadowPath||[]){let host;try{host=scope.querySelector(selector);}catch{fail("PRESET_SELECTOR_INVALID",key);}
      scope=host?.shadowRoot||(host?.__novelShadow?.nodeType===11&&host.__novelShadow.host===host?host.__novelShadow:null);if(!scope)return[];}
    try{return locator.selector===":scope"&&scope.nodeType===1?[scope]:[...scope.querySelectorAll(locator.selector)];}catch{fail("PRESET_SELECTOR_INVALID",key);}
  }
  function text(node){
    if(node.nodeType===3)return node.textContent;if(/^(SCRIPT|STYLE|NOSCRIPT|INPUT|FORM|NAV)$/.test(node.tagName||""))return"";
    if(node.tagName==="BR")return"\n";const root=node.shadowRoot||(node.__novelShadow?.host===node?node.__novelShadow:null);
    if(node.tagName==="TEMPLATE")return node.hasAttribute("shadowrootmode")?text(node.content):"";
    if(root)return text(root);const value=[...(node.childNodes||[])].map(text).join("");return /^(P|DIV|SECTION|ARTICLE|LI)$/.test(node.tagName||"")?value+"\n\n":value;
  }
  function value(node,attribute,key){
    if(attribute==="text"){
      const label=text(node).replace(/\n{3,}/g,"\n\n").trim();if(label||key!=="platform")return label;
      const accessible=node.getAttribute("aria-label")||node.getAttribute("title")||node.getAttribute("alt")||node.querySelector("img[alt]")?.getAttribute("alt");
      if(accessible)return accessible;
      const image=node.tagName==="IMG"?node:node.querySelector("img");
      try{return new URL(image?.getAttribute("src"),doc.URL).pathname.match(/\/platforms\/([A-Za-z0-9_-]+)\.[A-Za-z0-9]+$/)?.[1]||"";}catch{return"";}
    }
    const raw=attribute==="imageUrl"?(node.currentSrc||node.getAttribute("data-src")||node.getAttribute("src")):node.getAttribute(attribute);
    if(!raw)return"";let url;try{url=new URL(raw,doc.URL);}catch{fail("PRESET_URL_INVALID",key);}
    if(url.protocol!=="https:"||url.username||url.password||url.port)fail("PRESET_URL_INVALID",key);return url.href;
  }
  function read(key,scope=doc){const locator=fields[key],nodes=resolve(locator.relativeTo?scope:doc,locator,key);matches[key]=(matches[key]||0)+nodes.length;
    const values=nodes.map(node=>value(node,locator.attribute,key));return locator.multiple||["authors","genres","tags"].includes(key)?values.filter(Boolean):values[0]||"";}
  const parent=fields.items?"items":fields.rows?"rows":fields.root?"root":null,parents=parent?resolve(doc,fields[parent],parent):[];
  if(parent){matches[parent]=parents.length;if(!parents.length)fail("PRESET_MATCH_MISSING",parent);if(parent==="root"&&parents.length!==1)fail("PRESET_ROOT_INVALID",parent);}
  const output={};
  for(const key of Object.keys(fields))if(key!==parent&&!fields[key].relativeTo)output[key]=read(key);
  if(parent==="items"||parent==="rows")output[parent]=parents.map((scope,index)=>{
    const row={sourceOrdinal:index+1};for(const key of Object.keys(fields))if(fields[key].relativeTo===parent)row[key]=read(key,scope);
    for(const key of parent==="items"?["title","url"]:["chapterUrl"])if(fields[key]&&!row[key]&&!output[key])fail("PRESET_MATCH_MISSING",key);return row;
  });
  if(fields.images){
    const images=resolve(fields.images.relativeTo?parents[0]:doc,fields.images,"images");matches.images=images.length;
    output.images=images.map((node,index)=>({index:index+1,url:value(node,fields.images.attribute,"images")}));
    if(!images.length||output.images.some(image=>!image.url))fail("PRESET_MATCH_MISSING","images");
  }
  if(parent==="root")for(const key of Object.keys(fields))if(key!=="images"&&fields[key].relativeTo==="root")output[key]=read(key,parents[0]);
  if(fields.text&&(!output.text||Array.isArray(output.text)))fail("PRESET_MATCH_MISSING","text");
  for(const key of ["episodeCount","expectedChapters","seasonNumber","rating"]){
    if(!Object.hasOwn(output,key))continue;
    const raw=String(output[key]).replace(/,/g,"").trim();
    if(key==="rating"){const number=/^\d(?:\.\d+)?$/.test(raw)?Number(raw):NaN;output[key]=Number.isFinite(number)&&number>=0&&number<=5?number:null;}
    else{const match=key==="seasonNumber"?raw.match(/(?:시즌\s*)?(\d+)$/):raw.match(/^(\d+)$/)||raw.match(/(\d+)\s*(?:화|회차)/);output[key]=match?Number(match[1]):null;}
  }
  output.matches=matches;return output;
}

export async function validatePresetSource(presets,id,input){
  exact(input,["pageKind","url"]);const config=compilePreset(presets.get(id).config);
  if(!["listing","detail","reader"].includes(input.pageKind)||typeof input.url!=="string")throw bad("검증 페이지 종류와 URL을 지정하세요.");
  let url;try{url=new URL(input.url);}catch{throw bad("검증 URL을 확인하세요.");}
  if(!["sbxh9.com","toki32.com"].includes(url.hostname)||!matchesPresetPage(config,input.pageKind,url.href))throw bad("허용된 원천의 프리셋 페이지에서만 검증할 수 있습니다.");
  const {chromium}=await import("playwright"),{Collector,readReaderDocument}=await import("./collector.mjs");
  const browser=await chromium.launch({headless:true,...(process.env.BROWSER_PATH?{executablePath:process.env.BROWSER_PATH}:{})});
  try{
    const context=await browser.newContext({serviceWorkers:"block",acceptDownloads:false});
    await Collector.prototype.installNetworkGuard.call({},context,{allowedMainHost:url.hostname});
    context.on("page",page=>{if(context.pages().length>1)void page.close();});
    const page=await context.newPage(),response=await page.goto(url.href,{waitUntil:"domcontentloaded",timeout:15000});
    if(response?.status()!==200)throw Object.assign(Error("원본 검증 페이지에 접근하지 못했습니다."),{status:409});
    const reader=await page.evaluate(readReaderDocument);if(reader.challenge||reader.verificationRequired)throw Object.assign(Error("원본 페이지의 정상 접근 확인을 먼저 완료하세요."),{status:409});
    return await presets.validatePage(id,{pageKind:input.pageKind,url:url.href},page);
  }finally{await browser.close();}
}

export function clickPresetAction(locator,doc=document){
  let scope=doc;
  for(const selector of locator.shadowPath||[]){const host=scope.querySelector(selector);scope=host?.shadowRoot||(host?.__novelShadow?.host===host?host.__novelShadow:null);if(!scope)throw Error("PRESET_ACTION_MISSING");}
  const matches=[...scope.querySelectorAll(locator.selector)];if(matches.length!==1)throw Error("PRESET_ACTION_MATCH_INVALID");
  const node=matches[0];if(node.disabled||node.hidden||node.getAttribute("aria-disabled")==="true")return{changed:false};
  node.click();return{changed:true};
}
