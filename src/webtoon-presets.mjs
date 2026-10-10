import { validateRunnablePreset, presetHash } from "./preset-runtime.mjs";

const locator=(selector,options={})=>({selector,shadowPath:[],attribute:"text",multiple:false,...options});
export function defaultWebtoonPreset(origin="https://sbxh9.com",contentType="webtoon") {
  const manhwa=contentType==="manhwa";
  return validateRunnablePreset({version:3,contentType,name:manhwa?"만화 기본 연결":"웹툰 기본 연결",origin,catalogOrder:"newest-first",pages:{
    listing:{pagePatterns:manhwa?["/manhwa","/search"]:["/ing","/end","/search"],sources:{ongoing:manhwa?"/manhwa":"/ing",completed:manhwa?"/manhwa":"/end",search:"/search"},fields:{
      items:locator(".work-card-grid a.card, .search-results-grid a.card",{multiple:true}),
      title:locator(".subject",{relativeTo:"items"}),url:locator(":scope",{attribute:"href",relativeTo:"items"}),
      genres:locator(".genre",{relativeTo:"items"}),thumbnail:locator(".thumb > img:not(.platform-icon)",{attribute:"imageUrl",relativeTo:"items"}),
      ...(manhwa?{publication:locator(".thumb .badge",{relativeTo:"items"})}:{}),
      platform:locator(".platform-icon",{relativeTo:"items"}),episodeCount:locator(".ep-no, .ep",{relativeTo:"items"}),updatedLabel:locator(".ep-date",{relativeTo:"items"}),rating:locator(".card-rating-badge",{relativeTo:"items"})}},
    detail:{pagePatterns:["/"+contentType+"/{workId}"],fields:{title:locator(".hero-v2-title"),authors:locator(".hero-v2-author"),
      platform:locator(".hero-v2-badges .pill-plat"),
      synopsis:locator(".hero-v2-desc"),tags:locator(".hero-v2-tag",{multiple:true}),thumbnail:locator(".hero-v2-thumb img",{attribute:"imageUrl"}),
      expectedChapters:locator(".ep-section-count"),rows:locator(manhwa?".ep-section .ep-list-v2 .ep-row-v2":"#webtoon-episode-list .ep-row-v2",{multiple:true}),
      chapterUrl:locator("a.ep-row-v2-link",{attribute:"href",relativeTo:"rows"}),chapterTitle:locator(".ep-row-v2-title",{relativeTo:"rows"}),
      chapterLabel:locator(".ep-row-v2-no",{relativeTo:"rows"})}},
    reader:{pagePatterns:["/"+contentType+"/{workId}/{episodeId}"],fields:{root:locator(".vw-imgs"),images:locator("img",{attribute:"imageUrl",multiple:true,relativeTo:"root"})}}
  }});
}
export function webtoonPreset(presets,origin,presetId=null,contentType="webtoon") {
  if(presetId&&!presets)throw Object.assign(Error("선택한 웹툰 프리셋을 사용할 수 없습니다."),{status:400});
  return presets?.snapshot({origin,contentType,presetId})||(()=>{const config=defaultWebtoonPreset(origin,contentType);return{contentType,presetSnapshot:config,presetHash:presetHash(config)};})();
}
