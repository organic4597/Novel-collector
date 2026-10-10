import {createHash} from 'node:crypto';
import {webtoonSource} from './webtoon-source.mjs';
import {normalizeWorkSource} from './source-metadata.mjs';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {watchListingThumbnails} from './thumbnail-cache.mjs';

export function rankingQuery(input={}){
  const kind=input.kind||'all',period=input.period||'hour',page=Number(input.page||1);
  if(!['all','webtoon','manhwa','novel'].includes(kind)||!['hour','day','week','month'].includes(period)||!Number.isSafeInteger(page)||page<1||page>(kind==='all'?3:1))
    throw Object.assign(Error('랭킹 카테고리·기간·페이지를 확인하세요.'),{status:400});
  return{kind,period,page};
}
export function readRankingDocument(doc=document){
  const base=new URL(doc.URL),kind=base.searchParams.get('kind');
  const items=[];
  for(const card of doc.querySelectorAll('a.rank-v2-champion,a.rank-v2-runner,a.rank-v2-row')){
    const url=new URL(card.getAttribute('href'),base),type=url.pathname.split('/')[1];
    if(url.origin!==base.origin||url.search||url.hash||type!==kind||!['webtoon','manhwa','novel'].includes(type))throw Error('랭킹 작품 링크가 선택한 원천·유형과 다릅니다.');
    const rank=Number(card.querySelector('.rank-v2-runner-rank,.rank-v2-row-rank,.rank-v2-champion-kicker')?.textContent.match(/^\s*(\d+)/)?.[1]);
    if(!Number.isSafeInteger(rank)||rank<1||rank>50)throw Error('원본 랭킹 순위를 확인하지 못했습니다.');
    const titleNode=card.querySelector('h2,.rank-v2-runner-body > strong,.rank-v2-row-title > strong,.rank-v2-row-title');
    const clone=titleNode?.cloneNode(true);clone?.querySelectorAll('span').forEach(n=>n.remove());
    const title=clone?.textContent.trim();if(!title)throw Error('랭킹 작품 제목을 확인하지 못했습니다.');
    const meta=card.querySelector('.rank-v2-meta')?.textContent||'';
    const authorNode=card.querySelector('.rank-v2-champion-body > p,.rank-v2-row-sub');const author=authorNode?.cloneNode(true);author?.querySelectorAll('.rank-v2-meta').forEach(n=>n.remove());
    const image=card.querySelector('.rank-v2-cover img');let thumbnailUrl=null;
    const raw=image?.getAttribute('data-src')||image?.getAttribute('src');if(raw){const cover=new URL(raw,base);if(cover.protocol==='https:'&&!cover.username&&!cover.password&&!cover.port)thumbnailUrl=cover.href;}
    items.push({rank,title,url:url.href,contentType:type,author:author?.textContent.trim()||'',thumbnailUrl,
      genres:(card.querySelector('.rank-v2-genre-text,.rank-v2-runner-body > small')?.textContent||'').split(/[,·/]/).map(v=>v.trim()).filter(Boolean),tags:[],
      publication:/완결/.test(meta)?'completed':/연재/.test(meta)?'ongoing':'unknown',episodeCount:null,rating:null});
  }
  items.sort((a,b)=>a.rank-b.rank);
  if(new Set(items.map(item=>item.rank)).size!==items.length||items.some((item,index)=>item.rank!==index+1))throw Error('랭킹 순위가 중복되거나 누락됐습니다.');
  return items;
}
export async function discoveryRankings(owner,input={}){
  const query=rankingQuery(input),origin=new URL(owner.transportUrl('https://newtoki1.org/novel')).origin;
  const kinds=query.kind==='all'?['webtoon','manhwa','novel']:[query.kind];const lists=[];
  for(const kind of kinds){
    const key=createHash('sha256').update(JSON.stringify({schema:2,origin,kind,period:query.period})).digest('hex');
    await owner.init();const path=owner.rootDir+'/pages/rank-'+key+'.json';let saved;
    try{saved=JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(saved&&owner.now()-saved.savedAt<5*60*1000){lists.push({...saved,cacheHit:true});continue;}
    const result=await owner.dedupe('rank:'+key,()=>owner.exclusive(async()=>{
      const page=await (await owner.openContext()).newPage();let covers;
      try{
        if(typeof page.route==='function')covers=await watchListingThumbnails(page,{assertAvailable:()=>owner.sourceGate.assertAvailable()});
        const url=new URL('/rank',origin);url.searchParams.set('kind',kind);if(query.period!=='hour')url.searchParams.set('period',query.period);
        await owner.navigate(page,url.href);const rows=await page.evaluate(readRankingDocument),items=[];
        for(const row of rows){const source=row.contentType==='novel'?normalizeWorkSource(row.url):webtoonSource(row.url);
          const item={...row,id:source.id,url:source.url};await owner.registerWork(item.id,item);const {thumbnailUrl,...publicItem}=item;
          items.push({...publicItem,thumbnail:thumbnailUrl?'/api/discover/'+item.id+'/thumbnail':null});}
        await covers?.save(rows.map((row,index)=>({...row,id:items[index].id})),(id,image)=>owner.storeThumbnail(id,image));
        const value={items,savedAt:owner.now(),cachedAt:new Date(owner.now()).toISOString(),cacheHit:false};
        const temporary=path+'.tmp';await writeFile(temporary,JSON.stringify(value),{mode:0o600});await rename(temporary,path);return value;
      }finally{await covers?.close();await page.close();}
    }));lists.push(result);
  }
  const items=lists.flatMap(list=>list.items),maxPage=Math.max(1,Math.ceil(items.length/50));
  if(query.page>maxPage)throw Object.assign(Error('랭킹의 마지막 페이지를 초과했습니다.'),{status:400});
  return{items:items.slice((query.page-1)*50,query.page*50),page:query.page,maxPage,pageSize:50,total:items.length,ranking:true,
    kind:query.kind,period:query.period,cacheHit:lists.every(list=>list.cacheHit),cachedAt:lists[0]?.cachedAt,loadedCount:Math.min(50,Math.max(0,items.length-(query.page-1)*50)),filters:{}};
}
