import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

test('completed webtoon jobs expose the authenticated book ZIP route but empty jobs do not',async t=>{
 const dom=new JSDOM(await readFile(new URL('../public/index.html',import.meta.url),'utf8'),{url:'http://localhost/',runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
 const w=dom.window;w.HTMLDialogElement.prototype.close=function(){};
 const jobs=[{id:'ready',bookId:'webtoon-'+ 'a'.repeat(32),contentType:'webtoon',url:'https://sbxh9.com/webtoon/fixture',status:'completed',completed:2,skipped:0,total:2,exports:[]},
 {id:'empty',bookId:'webtoon-'+ 'b'.repeat(32),contentType:'webtoon',url:'https://sbxh9.com/webtoon/empty',status:'completed_with_errors',completed:0,skipped:0,failed:2,total:2,exports:[]}];
 w.fetch=async path=>({ok:true,status:200,json:async()=>path==='/api/session'?{authenticated:true}:path==='/api/jobs'?jobs:path==='/api/status'?{maxConcurrency:2}:[]});
 for(const name of ['performance','queue-ui','app'])w.eval(await readFile(new URL('../public/'+name+'.js',import.meta.url),'utf8'));
 await new Promise(resolve=>setTimeout(resolve,50));w.CollectorUI.navigate('history');
 assert.equal(w.document.querySelector('[data-job-id="ready"] .export-link')?.getAttribute('href'),'/api/books/webtoon-'+ 'a'.repeat(32)+'/export/zip');
 assert.equal(w.document.querySelector('[data-job-id="empty"] .export-link'),null);
});
