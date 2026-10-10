import { evaluatePresetPage, validateRunnablePreset, presetHash, clickPresetAction, matchesPresetPage } from "./preset-runtime.mjs";
import { webtoonSource } from "./webtoon-source.mjs";
import { chapterIdFor, readReaderDocument } from "./collector.mjs";

import { webtoonPreset } from "./webtoon-presets.mjs";
export { defaultWebtoonPreset, webtoonPreset } from "./webtoon-presets.mjs";
export function readWebtoonPageState(doc=document) {
  const active=doc.querySelector(".pager-window--desktop .pager-num.is-active");
  const total=Number(doc.querySelector(".toolbar .count")?.textContent.match(/([\d,]+)\s*개/)?.[1]?.replace(/,/g,""));
  const page=Number(active?.textContent.trim()||new URL(doc.URL).searchParams.get("page")||1);
  const linkPages=[...doc.querySelectorAll('a[href*="/search?"]')].map(node=>{try{const url=new URL(node.getAttribute("href"),doc.URL);return url.origin===new URL(doc.URL).origin?Number(url.searchParams.get("page")||1):1;}catch{return 1;}});
  const maxPage=Math.max(page,...[...doc.querySelectorAll(".pager-window--desktop .pager-num")].map(n=>Number(n.textContent.trim())).filter(Number.isSafeInteger),...linkPages.filter(Number.isSafeInteger));
  const end=doc.querySelector('.pager-window--desktop button[aria-label="끝"]');
  const options=label=>[...doc.querySelectorAll(".filter .filter-row")].filter(n=>n.querySelector(".label")?.textContent.trim()===label)
    .flatMap(n=>[...n.querySelectorAll(".chips > button:not(.ani-more-toggle-chip)")].map(n=>n.textContent.replace(/^[✓✕]\s*/,"").trim()||n.querySelector("img[alt]")?.getAttribute("alt")||n.getAttribute("aria-label")||n.getAttribute("title")||"")).filter(n=>n&&n!=="전체");
  const platformKeys={};
  for(const row of doc.querySelectorAll(".filter .filter-row"))if(row.querySelector(".label")?.textContent.trim()==="플랫폼")
    for(const node of row.querySelectorAll(".chips > button")){
      const label=node.querySelector("img[alt]")?.getAttribute("alt")||node.getAttribute("aria-label")||node.getAttribute("title");
      try{const key=new URL(node.querySelector("img")?.getAttribute("src"),doc.URL).pathname.match(/\/platforms\/([A-Za-z0-9_-]+)\.[A-Za-z0-9]+$/)?.[1];if(key&&label&&label!=="전체")platformKeys[key]=label;}catch{}
    }
  return{page,maxPage,total:Number.isSafeInteger(total)?total:null,paginationUnresolved:!!end&&!end.disabled,normalCatalog:true,
    filters:{genres:options("장르"),platforms:options("플랫폼"),platformKeys}};
}
export async function webtoonListing(owner,page,query) {
  const origin=new URL(owner.transportUrl("https://newtoki1.org/novel")).origin;
  const {presetSnapshot:config}=webtoonPreset(owner.presets,origin);
  if(!matchesPresetPage(config,"listing",page.url()))throw Object.assign(Error("웹툰 목록 주소가 선택한 프리셋 경로와 다릅니다."),{status:400});
  const state=await page.evaluate(readWebtoonPageState);
  owner.webtoonPlatforms||={};owner.webtoonPlatforms[origin]={...owner.webtoonPlatforms[origin],...state.filters.platformKeys};
  if(state.total===0)return{...state,items:[]};
  const data=await page.evaluate(evaluatePresetPage,config.pages.listing);
  const items=[],ids=new Set();
  for(const row of data.items){
    const source=webtoonSource(row.url);
    if(source.episodeId||new URL(source.url).origin!==origin)throw Error("웹툰 목록의 작품 링크가 원천과 다릅니다.");
    if(ids.has(source.id))continue;ids.add(source.id);
    const count=String(row.episodeCount||"").match(/([\d,]+)\s*(?:화|회차)/)?.[1]?.replace(/,/g,"");
    const rating=Number(row.rating);
    items.push({...source,title:row.title,authors:(row.authors||[]).flatMap(v=>v.split(/[,|·]/)).map(v=>v.trim()).filter(Boolean),
      author:(row.authors||[]).join(", "),genres:(row.genres||[]).flatMap(v=>v.split(/[,|·/]/)).map(v=>v.trim()).filter(Boolean),
      tags:row.tags||[],platform:owner.webtoonPlatforms[origin]?.[row.platform]||row.platform||"",thumbnailUrl:row.thumbnail||null,updatedLabel:row.updatedLabel||"",
      publication:query.publication==="completed"?"completed":"ongoing",episodeCount:count?Number(count):null,
      rating:row.rating&&Number.isFinite(rating)&&rating>=0&&rating<=5?rating:null});
  }
  return {...state,items};
}
export async function webtoonMetadata(page,config) {
  const data=await page.evaluate(evaluatePresetPage,config.pages.detail);
  return {title:data.title,authors:(data.authors||[]).flatMap(v=>v.split(/[,|·]/)).map(v=>v.trim()).filter(Boolean),
    synopsis:data.synopsis||"",tags:data.tags||[],genres:data.genres||[],platform:data.platform||"",thumbnailUrl:data.thumbnail||null,
    expectedChapterCount:data.expectedChapters??data.episodeCount,contentType:"webtoon"};
}
export function readWebtoonCatalogPage(doc=document) {
  const current=new URL(doc.URL),page=Number(current.searchParams.get("epage")||1),pages=new Map();
  for(const node of doc.querySelectorAll(".ep-section .episode-pager a[href]")){
    const target=new URL(node.getAttribute("href"),current);
    if(target.origin!==current.origin||target.pathname!==current.pathname||target.hash||
      [...target.searchParams.keys()].some(key=>key!=="epage")||target.searchParams.getAll("epage").length>1)
      throw Error("웹툰 목차 페이지 주소가 작품과 다릅니다.");
    const number=Number(target.searchParams.get("epage")||1);
    if(!Number.isSafeInteger(number)||number<1||number>1000)throw Error("웹툰 목차 페이지 번호가 잘못됐습니다.");
    pages.set(number,target.href);
  }
  const later=[...pages.keys()].filter(number=>number>page).sort((a,b)=>a-b);
  if(later.length&&later[0]!==page+1)throw Error("웹툰 목차의 다음 페이지가 누락됐습니다.");
  return{page,maxPage:Math.max(page,...pages.keys()),nextUrl:later.length?pages.get(later[0]):null};
}
export async function webtoonCatalog(page,job,hooks,signal) {
  const config=validateRunnablePreset(job.presetSnapshot),source=webtoonSource(job.url);
  if(config.origin!==new URL(source.url).origin||job.presetHash!==presetHash(config)||!matchesPresetPage(config,"detail",source.url))throw Error("웹툰 프리셋의 원천·경로·해시가 예약과 다릅니다.");
  await this.webtoonNavigate(page,source.url,signal);
  const unique=new Map(),signatures=new Set();let data,expected;
  for(let turn=0;turn<1000;turn++){
    signal?.throwIfAborted();data=await page.evaluate(evaluatePresetPage,config.pages.detail);
    const count=data.expectedChapters??data.episodeCount;
    if(turn===0)expected=count;
    else if(count!==expected)throw Error("웹툰 전체 회차 수가 조회 중 변경됐습니다. 다시 확인하세요.");
    const signature=JSON.stringify(data.rows.map(row=>row.chapterUrl));
    if(signatures.has(signature))throw Error("웹툰 목차가 같은 회차를 반복합니다.");signatures.add(signature);
    for(const row of data.rows){const chapter=webtoonSource(row.chapterUrl);
      if(chapter.url!==source.url||!chapter.episodeId)throw Error("웹툰 목차의 회차 주소가 작품과 다릅니다.");
      unique.set(chapter.chapterUrl,{id:chapterIdFor(chapter.chapterUrl),url:chapter.chapterUrl,title:row.chapterTitle||row.chapterLabel||"회차",
        chapterLabel:row.chapterLabel||"",seasonLabel:row.seasonLabel||"",seasonNumber:row.seasonNumber??null});}
    if(unique.size>100000)throw Error("웹툰 목차 회차 수가 상한을 초과했습니다.");
    const actions=config.pages.detail.actions||{};let changed=false;
    for(const action of [actions.loadMore,actions.nextPage].filter(Boolean)){
      const available=await page.evaluate(locator=>{let scope=document;for(const key of locator.shadowPath||[])scope=scope.querySelector(key)?.shadowRoot;if(!scope)return false;const node=scope.querySelector(locator.selector);return !!node&&!node.disabled&&!node.hidden&&node.getAttribute("aria-disabled")!=="true";},action);
      if(available){changed=(await page.evaluate(clickPresetAction,action)).changed;if(changed)break;}
    }
    // Older default snapshots have no action locator; use the site's scoped,
    // same-work numeric pager without altering the reservation snapshot.
    if(!changed&&!actions.loadMore&&!actions.nextPage){
      const paging=await page.evaluate(readWebtoonCatalogPage);
      await hooks?.event?.("info",`웹툰 목차 ${paging.page}/${paging.maxPage}페이지 · ${unique.size}/${expected??"미확인"}회차`);
      if(paging.nextUrl){await this.webtoonNavigate(page,paging.nextUrl,signal);changed=true;}
    }
    if(!changed)break;
    if(turn===999)throw Error("웹툰 전체 목차 조회 상한을 초과했습니다.");
    const deadline=Date.now()+15000;let ready=false;
    while(Date.now()<deadline){signal?.throwIfAborted();await page.waitForTimeout(100);
      const next=await page.evaluate(evaluatePresetPage,config.pages.detail);
      if(JSON.stringify(next.rows.map(row=>row.chapterUrl))!==signature){ready=true;break;}}
    if(!ready)throw Error("웹툰 목차 페이지 이동이 완료되지 않았습니다.");
  }
  if(!Number.isSafeInteger(expected)||expected!==unique.size)throw Error(`웹툰 전체 회차 수와 목차가 일치하지 않습니다 (${unique.size}/${expected??"미확인"}). 회차 수·페이지 이동 프리셋을 확인하세요.`);
  const allChapters=[...unique.values()];if(config.catalogOrder==="newest-first")allChapters.reverse();
  allChapters.forEach((chapter,index)=>Object.assign(chapter,{number:index+1,sourceOrdinal:config.catalogOrder==="newest-first"?allChapters.length-index:index+1}));
  return{...(await webtoonMetadata(page,config)),presetSnapshot:config,presetHash:job.presetHash,catalogComplete:true,expectedChapters:allChapters.length,
    allChapters,chapters:allChapters.filter(c=>(job.startEpisode==null||c.number>=job.startEpisode)&&(job.endEpisode==null||c.number<=job.endEpisode))};
}
export async function webtoonNavigate(page,url,signal) {
  signal?.throwIfAborted();const target=new URL(url),query=[...target.searchParams];target.search="";
  const source=webtoonSource(target.href);
  if(query.length&&(source.episodeId||query.length!==1||query[0][0]!=="epage"||
    !/^[1-9]\d{0,3}$/.test(query[0][1])||Number(query[0][1])>1000))
    throw Error("웹툰 목차 페이지 주소가 잘못됐습니다.");
  const navigationUrl=query.length?source.url+"?epage="+query[0][1]:source.chapterUrl;
  if(this.backoff?.snapshot().active)throw Object.assign(Error("사이트 요청 제한 대기 중입니다."),{code:"REQUEST_BACKOFF"});
  const response=await page.goto(navigationUrl,{waitUntil:"domcontentloaded",timeout:45000});
  signal?.throwIfAborted();const problem=await this.responseProblem(response);if(problem)throw problem;
  if(page.url().replace(/\/$/,"")!==navigationUrl.replace(/\/$/,""))throw Error("웹툰 페이지가 다른 주소로 이동했습니다.");
  const status=await page.evaluate(readReaderDocument);
  if(status.challenge||status.verificationRequired)throw Object.assign(Error("웹툰 원본 사이트에서 직접 접근 확인을 완료하세요."),{code:"NEEDS_ATTENTION",attentionKind:status.challenge?"captcha":"authentication"});
  const membership=await this.authenticateNavigation(page,signal);
  if(membership?.authenticated&&!membership.reused){
    const verified=await page.goto(navigationUrl,{waitUntil:"domcontentloaded",timeout:45000}),problem=await this.responseProblem(verified);
    if(problem)throw problem;
    const state=await page.evaluate(readReaderDocument);
    if(page.url()!==navigationUrl||state.challenge||state.verificationRequired)throw Object.assign(Error("웹툰 원본 사이트의 정상 접근 확인이 필요합니다."),{code:"NEEDS_ATTENTION",attentionKind:state.challenge?"captcha":"authentication"});
  }
}
