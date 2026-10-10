import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readNormalListState,clickNormalListControl} from '../src/normal-discovery.mjs';
import {rankingQuery,readRankingDocument,discoveryRankings} from '../src/discovery-rankings.mjs';
import {webtoonSource} from '../src/webtoon-source.mjs';
import {webtoonPreset} from '../src/webtoon-presets.mjs';
import {validateJob,FolderStore} from '../src/store.mjs';
import {chromium} from 'playwright';
import {Collector} from '../src/collector.mjs';
import {createApp} from '../src/server.mjs';
import {validateThumbnailUrl,isListingThumbnail,validateImage,readListingCoverSources} from '../src/thumbnail-cache.mjs';

test('adult category controls admit a genuine zero-result page and keep category separate from genre',()=>{
  const dom=new JSDOM('<div class="toolbar"><span class="count">총 0개</span></div><div class="filter"><div class="filter-row"><span class="label">분류</span><div class="chips"><button>전체</button></div></div></div>');
  try{assert.equal(readNormalListState(dom.window.document).ready,true);assert.equal(clickNormalListControl({kind:'category',value:'전체'},dom.window.document).changed,true);}finally{dom.window.close();}
});
test('manhwa reservations preserve type, namespace and image preset while rejecting cross-type requests',()=>{
  const url='https://sbxh9.com/manhwa/fixture';const selected=webtoonPreset(null,'https://sbxh9.com',null,'manhwa');
  assert.equal(validateJob({url,...selected}).contentType,'manhwa');assert.equal(selected.presetSnapshot.pages.reader.fields.images.relativeTo,'root');
  assert.match(webtoonSource(url).id,/^manhwa-[a-f0-9]{32}$/);assert.notEqual(webtoonSource(url).id,webtoonSource(url.replace('/manhwa/','/webtoon/')).id);
  assert.throws(()=>validateJob({url,contentType:'webtoon'}),{status:400});
});
test('manhwa cover hosts accept only observed image paths and support rendered-response reuse',()=>{
  for(const url of ['https://mana.apihost93.com/board_uploads/2026/05/19/synthetic.webp','https://11toon8.com/data/toon_category/3217.webp']){
    assert.equal(validateThumbnailUrl(url).href,url);assert.equal(isListingThumbnail(url),true);
  }
  for(const url of ['https://mana.apihost93.com/private/file.webp','https://11toon8.com/api/file.png','https://evil.example/data/toon_category/1.webp'])assert.throws(()=>validateThumbnailUrl(url));
});
test('cover source metadata survives a source image error and known mislabeled raster headers are normalized',()=>{
  const dom=new JSDOM('<a class="card" href="/manhwa/fixture"><div class="thumb"><img src="https://mana.apihost93.com/board_uploads/2026/05/19/synthetic.webp"></div></a>',{url:'https://sbxh9.com/manhwa'});
  try{const config=webtoonPreset(null,'https://sbxh9.com',null,'manhwa').presetSnapshot.pages.listing;
    config.fields.items.selector='a.card';assert.equal(readListingCoverSources(config,dom.window.document)[0].url,'https://sbxh9.com/manhwa/fixture');
    const webp=Buffer.from('52494646000000005745425056503820','hex');assert.throws(()=>validateImage(webp,'image/gif'));
    assert.equal(validateImage(webp,'image/gif',{allowHeaderMismatch:true}),'image/webp');
    assert.throws(()=>validateImage(Buffer.from('<script>not an image</script>'),'image/gif',{allowHeaderMismatch:true}));
  }finally{dom.window.close();}
});
test('manhwa uses the existing image collection, complete manifests and shared archive storage',async t=>{
  const root=await mkdtemp(join(tmpdir(),'manhwa-collect-')),store=await new FolderStore(root).init();
  const browser=await chromium.launch({executablePath:process.env.BROWSER_PATH,headless:true});t.after(async()=>{await browser.close();await rm(root,{recursive:true,force:true});});
  const selected=webtoonPreset(null,'https://sbxh9.com',null,'manhwa'),job=await store.createJob({url:'https://sbxh9.com/manhwa/fixture',...selected});
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
  const collector=new Collector({store,delayMs:0,contentTimeoutMs:1000,launchContext:async()=>{
    const context=await browser.newContext();await context.route('https://sbxh9.com/**',route=>{
      const path=new URL(route.request().url()).pathname;if(path==='/page.png')return route.fulfill({contentType:'image/png',body:png});
      const html=path==='/manhwa/fixture'?'<h1 class="hero-v2-title">합성 만화</h1><span class="ep-section-count">총 1회차</span><div class="ep-section"><ul class="ep-list-v2"><li class="ep-row-v2"><a class="ep-row-v2-link" href="/manhwa/fixture/first"><span class="ep-row-v2-title">첫 회차</span></a></li></ul></div>':'<div class="vw-imgs"><img src="/page.png"></div>';
      return route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset=utf-8>'+html});
    });return context;
  }});collector.installNetworkGuard=async(_ctx,options)=>assert.equal(options.allowImages,true);
  const result=await collector.run(job,{report:patch=>store.patchJob(job.id,patch),event:async()=>{}},new AbortController().signal);
  assert.equal(result.status,'completed');const book=await store.getBook(result.bookId);assert.equal(book.contentType,'manhwa');
  const chapters=await store.listChapters(book.id),chapter=await store.readChapter(book.id,chapters[0].id);assert.equal(chapter.contentType,'manhwa');assert.equal(chapter.complete,true);assert.equal(chapter.savedImages,1);
});
test('rank cards preserve actual source ranks and type, and refuse mixed or missing ranks',()=>{
  const html='<a class="rank-v2-champion" href="/manhwa/one"><div class="rank-v2-champion-kicker">1위만화</div><h2>첫 작품</h2></a><a class="rank-v2-runner" href="/manhwa/two"><span class="rank-v2-runner-rank">2</span><span class="rank-v2-runner-body"><strong>둘째 작품</strong></span></a>';
  const dom=new JSDOM(html,{url:'https://sbxh9.com/rank?kind=manhwa&period=week'});
  try{const rows=readRankingDocument(dom.window.document);assert.deepEqual(rows.map(row=>[row.rank,row.title,row.contentType]),[[1,'첫 작품','manhwa'],[2,'둘째 작품','manhwa']]);
    dom.window.document.querySelector('.rank-v2-runner-rank').textContent='4';assert.throws(()=>readRankingDocument(dom.window.document),/누락/);
    assert.throws(()=>rankingQuery({kind:'unsupported'}),{status:400});assert.throws(()=>rankingQuery({period:'year'}),{status:400});
  }finally{dom.window.close();}
});
test('rank fetch uses public rendered pages, separate period caches, and per-category TOP50 for all',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ranking-cache-'));t.after(()=>rm(root,{recursive:true,force:true}));let count=0;
  const owner={rootDir:root,now:()=>Date.now(),transportUrl:()=> 'https://sbxh9.com/novel',init:async()=>{const {mkdir}=await import('node:fs/promises');await mkdir(root+'/pages',{recursive:true});},
    dedupe:(_key,fn)=>fn(),exclusive:fn=>fn(),registerWork:async()=>{},navigate:async(page,url)=>{count++;page.url=url;},openContext:async()=>({newPage:async()=>({evaluate:async function(){const kind=new URL(this.url).searchParams.get('kind');return[{rank:1,title:'합성',url:`https://sbxh9.com/${kind}/1`,contentType:kind,thumbnailUrl:null}];},close:async()=>{}})})};
  const first=await discoveryRankings(owner,{kind:'all',period:'week'});assert.equal(first.items.length,3);assert.deepEqual(first.items.map(row=>row.contentType),['webtoon','manhwa','novel']);
  await discoveryRankings(owner,{kind:'all',period:'week'});assert.equal(count,3);await discoveryRankings(owner,{kind:'novel',period:'month'});assert.equal(count,4);
});
test('ranking stored-work lookup is authenticated and returns local downloaded metadata without source fetch',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ranking-saved-')),store=await new FolderStore(root).init(),source=webtoonSource('https://sbxh9.com/manhwa/fixture');
  await store.upsertBook(source.id,{title:'저장 만화',url:source.url,contentType:'manhwa',storedChapterCount:1});let requested=0;
  const app=createApp({store,scheduler:{},adminPassword:'fixture-password',discovery:{overviewState:async()=>({status:'idle',item:source}),requestOverview:async()=>{requested++;}}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));t.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));await rm(root,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+app.address().port,path=base+'/api/discover/'+source.id+'/saved';assert.equal((await fetch(path)).status,401);
  const login=await fetch(base+'/api/login',{method:'POST',body:JSON.stringify({password:'fixture-password'})}),cookie=login.headers.get('set-cookie').split(';')[0];
  const response=await fetch(path,{headers:{cookie}});assert.equal(response.status,200);assert.equal((await response.json()).book.title,'저장 만화');assert.equal(requested,0);
  await store.upsertBook(source.id,{storedChapterCount:0});assert.equal((await(await fetch(path,{headers:{cookie}})).json()).book,null);
});
test('library card opens stored metadata synchronously, chapter tab loads lazily, checkboxes remain separate',async t=>{
  const dom=new JSDOM(await readFile(new URL('../public/index.html',import.meta.url),'utf8'),{url:'http://localhost/',runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
  const w=dom.window,calls=[],book={id:'book-one',title:'저장 작품',author:'작가',synopsis:'저장 소개',storedChapterCount:1,expectedChapterCount:2,failedChapterCount:1,metadataStatus:'completed'};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  w.eval(await readFile(new URL('../public/performance.js',import.meta.url),'utf8'));w.CollectorUI={...w.CollectorPerformance,authenticated:()=>true,generation:()=>1,view:()=> 'library',preferences:()=>({libraryPageSize:24}),toast(){},api:async(path)=>{
    calls.push(path);return path==='/api/books'?[book]:path.endsWith('/chapters/chapter-one')?{text:'저장 본문',title:'첫 회차'}:{book,chapters:[{id:'chapter-one',number:1,title:'첫 회차'}]};}};
  w.eval(await readFile(new URL('../public/library.js',import.meta.url),'utf8'));await w.CollectorLibrary.refresh();
  const card=w.document.querySelector('.library-card'),check=card.querySelector('input');check.click();assert.equal(w.document.getElementById('reader-dialog').open,false);
  card.click();assert.equal(w.document.getElementById('reader-dialog').open,true);assert.equal(w.document.getElementById('library-profile-synopsis').textContent,'저장 소개');assert.deepEqual(calls,['/api/books']);
  assert.equal(card.querySelector('.book-actions button'),null);assert.equal(w.document.getElementById('library-profile-download').getAttribute('href'),'/api/books/book-one/export/txt');
  w.document.getElementById('library-content-tab').click();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(w.document.getElementById('reader-text').textContent,'저장 본문');
});
