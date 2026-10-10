import { createHash } from "node:crypto";
export const isImageType=value=>["webtoon","manhwa"].includes(value);

export function webtoonSource(value) {
  let url;
  try { url=new URL(value); } catch { throw Object.assign(Error("웹툰 작품 주소를 확인하세요."),{status:400}); }
  const parts=url.pathname.replace(/\/$/,"").split("/");let ids=[];
  try{ids=parts.slice(2).map(value=>decodeURIComponent(value));}catch{}
  const valid=isImageType(parts[1])&&[3,4].includes(parts.length)&&ids.length===parts.length-2&&ids.every(value=>/^[\p{L}\p{N}_-]{1,100}$/u.test(value));
  if(url.protocol!=="https:"||url.username||url.password||url.port||url.search||url.hash||
    !["sbxh9.com","toki32.com"].includes(url.hostname)||!valid)
    throw Object.assign(Error("허용된 HTTPS 웹툰 작품·회차 주소를 입력하세요."),{status:400});
  const contentType=parts[1];url.pathname="/"+contentType+"/"+ids.map(value=>encodeURIComponent(value)).join("/");
  const workUrl=url.origin+"/"+contentType+"/"+encodeURIComponent(ids[0]);
  return {id:contentType+"-"+createHash("sha256").update(workUrl).digest("hex").slice(0,32),sourceId:ids[0],
    url:workUrl,chapterUrl:url.href,episodeId:ids[1]||null,contentType};
}
export const isWebtoonUrl=value=>{try{return /^\/(?:webtoon|manhwa)\//.test(new URL(value).pathname);}catch{return false;}};
export const validDiscoveryId=value=>/^(?:\d{1,15}|(?:webtoon|manhwa)-[a-f0-9]{32})$/.test(String(value));
