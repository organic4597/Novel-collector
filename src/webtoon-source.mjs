import { createHash } from "node:crypto";

export function webtoonSource(value) {
  let url;
  try { url=new URL(value); } catch { throw Object.assign(Error("웹툰 작품 주소를 확인하세요."),{status:400}); }
  const parts=url.pathname.replace(/\/$/,"").split("/");let ids=[];
  try{ids=parts.slice(2).map(value=>decodeURIComponent(value));}catch{}
  const valid=parts[1]==="webtoon"&&[3,4].includes(parts.length)&&ids.length===parts.length-2&&ids.every(value=>/^[\p{L}\p{N}_-]{1,100}$/u.test(value));
  if(url.protocol!=="https:"||url.username||url.password||url.port||url.search||url.hash||
    !["sbxh9.com","toki32.com"].includes(url.hostname)||!valid)
    throw Object.assign(Error("허용된 HTTPS 웹툰 작품·회차 주소를 입력하세요."),{status:400});
  url.pathname="/webtoon/"+ids.map(value=>encodeURIComponent(value)).join("/");
  const workUrl=url.origin+"/webtoon/"+encodeURIComponent(ids[0]);
  return {id:"webtoon-"+createHash("sha256").update(workUrl).digest("hex").slice(0,32),sourceId:ids[0],
    url:workUrl,chapterUrl:url.href,episodeId:ids[1]||null,contentType:"webtoon"};
}
export const isWebtoonUrl=value=>{try{return new URL(value).pathname.startsWith("/webtoon/");}catch{return false;}};
export const validDiscoveryId=value=>/^(?:\d{1,15}|webtoon-[a-f0-9]{32})$/.test(String(value));
