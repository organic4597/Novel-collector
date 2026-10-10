import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { webtoonCatalog, webtoonNavigate, defaultWebtoonPreset } from '../src/webtoon-runtime.mjs';
import { presetHash } from '../src/preset-runtime.mjs';

const url = 'https://sbxh9.com/webtoon/fixture';
function fixture({ expected = 391, badLink = false, drift = false } = {}) {
  let dom; const visits = [];
  const page = {
    url: () => dom.window.location.href,
    evaluate: async (fn, arg) => dom.window.eval('(' + fn.toString() + ')')(arg),
    waitForTimeout: async () => {},
  };
  const owner = { async webtoonNavigate(_page, target) {
    visits.push(target); dom?.window.close();
    const current = Number(new URL(target).searchParams.get('epage') || 1);
    const start = (current - 1) * 100;
    const rows = Array.from({ length: Math.max(0, Math.min(100, 391 - start)) }, (_, index) => {
      const ordinal = 391 - start - index;
      return `<li class="ep-row-v2"><a class="ep-row-v2-link" href="/webtoon/fixture/episode-${ordinal}"><span class="ep-row-v2-title">Synthetic ${ordinal}</span><span class="ep-row-v2-no">${ordinal}화</span></a></li>`;
    }).join('');
    const links = [1,2,3,4].filter(n => n !== current).map(n => `<a href="${badLink && n===2 ? 'https://foreign.example/webtoon/fixture?epage=2' : '/webtoon/fixture?epage='+n}">${n}</a>`).join('');
    dom = new JSDOM(`<h1 class="hero-v2-title">Synthetic</h1><span class="ep-section-count">총 ${drift && current===2 ? 390 : expected}회차</span><ul id="webtoon-episode-list">${rows}</ul><div class="ep-section"><nav class="episode-pager">${links}</nav><nav class="episode-pager">${links}</nav></div>`, {url:target,runScripts:'outside-only'});
  }};
  const config = defaultWebtoonPreset();
  return {page,owner,visits,job:{url,presetSnapshot:config,presetHash:presetHash(config)},close:()=>dom?.window.close()};
}
test('legacy default snapshot scans all four epage links and preserves 391 unique ordered episodes', async t => {
  const f=fixture();t.after(f.close);
  const data=await webtoonCatalog.call(f.owner,f.page,f.job,{},new AbortController().signal);
  assert.deepEqual(f.visits,[url,url+'?epage=2',url+'?epage=3',url+'?epage=4']);
  assert.equal(data.catalogComplete,true);assert.equal(data.expectedChapters,391);assert.equal(data.chapters.length,391);
  assert.match(data.chapters[0].url,/episode-1$/);assert.match(data.chapters.at(-1).url,/episode-391$/);
});
test('pagination keeps the total/count integrity check and never accepts a partial catalog', async t => {
  const f=fixture({expected:392});t.after(f.close);
  await assert.rejects(webtoonCatalog.call(f.owner,f.page,f.job,{},new AbortController().signal),/목차가 일치하지/);
});
test('a catalog total changing between pages is rejected', async t => {
  const f=fixture({drift:true});t.after(f.close);
  await assert.rejects(webtoonCatalog.call(f.owner,f.page,f.job,{},new AbortController().signal),/회차.*변경/);
});
test('catalog pagination cannot navigate to another origin', async t => {
  const f=fixture({badLink:true});t.after(f.close);
  await assert.rejects(webtoonCatalog.call(f.owner,f.page,f.job,{},new AbortController().signal),/목차.*주소/);
  assert.deepEqual(f.visits,[url]);
});
test('only a bounded epage query on a work page is accepted for navigation', async () => {
  let visited;
  const page={goto:async target=>{visited=target;return{};},url:()=>visited,evaluate:async()=>({})};
  const owner={responseProblem:async()=>null,authenticateNavigation:async()=>null};
  await webtoonNavigate.call(owner,page,url+'?epage=2',new AbortController().signal);
  assert.equal(visited,url+'?epage=2');
  for(const suffix of ['?epage=0','?epage=1001','?epage=2&token=x','?other=2','/chapter?epage=2']) {
    visited=null;await assert.rejects(webtoonNavigate.call(owner,page,url+suffix,new AbortController().signal));assert.equal(visited,null);
  }
});
