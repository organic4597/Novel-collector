import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {Collector,readReaderDocument} from '../src/collector.mjs';
import {SourceRequestGate} from '../src/source-request-gate.mjs';
import {Scheduler} from '../src/queue.mjs';
import {fetchThumbnail} from '../src/thumbnail-cache.mjs';
import {LibraryMetadata} from '../src/library-metadata.mjs';

const unavailable=()=>Object.assign(Error('tether offline'),{code:'COLLECTION_NETWORK_PAUSED',status:503});
const offline={enabled:true,snapshot:()=>({active:true,phase:'offline'}),assertAvailable(){throw unavailable();}};
const ready={enabled:true,snapshot:()=>({active:false,phase:'ready'}),assertAvailable(){}};
const panel='<main><h1>Access denied</h1><section><h2>Block reason</h2><code>NGINX_CIDR_REALIP</code><p>Client IP range is blocked by site security policy.</p></section></main>';
function reader(html){const dom=new JSDOM(html,{url:'https://sbxh9.com/novel/100/200'});try{return readReaderDocument(dom.window.document);}finally{dom.window.close();}}

test('visible exact IP block is separate from CAPTCHA',()=>{
 const state=reader(panel);assert.equal(state.ipBlockCode,'NGINX_CIDR_REALIP');assert.equal(state.challenge,false);
});
test('hidden block and quoted normal body never trigger tether recovery',()=>{
 assert.equal(reader(`<div hidden>${panel}</div>`).ipBlockCode,null);
 assert.equal(reader(`<div id="novel_content"><p>작중 인물은 NGINX_CIDR_REALIP 차단 메시지를 설명했다.</p>${panel}</div>`).ipBlockCode,null);
 assert.equal(reader('<h1>Access denied</h1><p>HTTP 403</p>').ipBlockCode,null);
});
test('offline collector never launches a browser; fork retains tether controls',async()=>{
 let launched=0;const transport={enabled:true};const collector=new Collector({store:{},profileDir:'/synthetic/profile',network:offline,transport,launchContext:async()=>{launched++;}});
 await assert.rejects(collector.openContext(),{code:'COLLECTION_NETWORK_PAUSED'});assert.equal(launched,0);
 const fork=collector.fork(1);assert.equal(fork.network,offline);assert.equal(fork.transport,transport);
});
test('source listing gate blocks offline before upstream work',()=>{
 const gate=new SourceRequestGate({owner:{network:offline,checkOpen(){}},normalizeUrl:()=>{}});
 assert.throws(()=>gate.assertAvailable('sbxh9.com'),{code:'COLLECTION_NETWORK_PAUSED'});
});
test('offline scheduler starts neither server jobs nor external workers',async()=>{
 let listed=0;const scheduler=new Scheduler({store:{async listJobs(){listed++;return[];}},collector:{},network:offline});scheduler.enabled=true;
 await scheduler.fillSlots();assert.equal(listed,0);assert.deepEqual(await scheduler.claim('synthetic-agent'),{job:null});
});
test('external workers cannot bypass the server tether even when connected',async()=>{
 let listed=0;const scheduler=new Scheduler({store:{async listJobs(){listed++;return[];}},collector:{},network:ready});
 assert.deepEqual(await scheduler.claim('synthetic-agent'),{job:null});assert.equal(listed,0);
});
test('network hold preserves saved progress and manual pause state',async()=>{
 const jobs=new Map([['a',{id:'a',status:'running',currentChapterId:'c2',completed:4}],['b',{id:'b',status:'paused',completed:8}]]);
 const store={async getJob(id){return jobs.get(id);},async locked(_,fn){return fn();},async patchJob(id,patch){const current=jobs.get(id);const value=typeof patch==='function'?patch(current):patch;if(value)jobs.set(id,{...current,...value});return jobs.get(id);},async appendJobEvent(){}};
 const scheduler=new Scheduler({store,collector:{},network:offline});const controller=new AbortController();scheduler.active.set('a',{job:jobs.get('a'),controller});scheduler.active.set('b',{job:jobs.get('b'),controller:new AbortController()});
 await scheduler.holdNetwork();assert.equal(controller.signal.aborted,true);assert.equal(jobs.get('a').status,'queued');assert.equal(jobs.get('a').completed,4);assert.equal(jobs.get('a').backoffResumeChapterId,'c2');assert.equal(jobs.get('b').status,'paused');assert.equal(scheduler.queuePaused,false);
});
test('offline thumbnail does not resolve or request via the wired connection',async()=>{
 let calls=0;await assert.rejects(fetchThumbnail('https://sbxh9.com/cover.png',{network:offline,lookup:async()=>{calls++;return[];},request:async()=>{calls++;}}),{code:'COLLECTION_NETWORK_PAUSED'});assert.equal(calls,0);
});
test('tether thumbnail uses proxy transport without host DNS',async()=>{
 let dns=0,forwarded=false;const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(12)]),agent={};
 const out=await fetchThumbnail('https://sbxh9.com/cover.png',{network:ready,transport:{enabled:true,agent},lookup:async()=>{dns++;throw Error('host DNS forbidden');},request:async(url,address,options)=>{forwarded=true;assert.equal(address,null);assert.equal(options.agent,agent);return{status:200,bytes:png,mimeType:'image/png'};}});
 assert.equal(dns,0);assert.equal(forwarded,true);assert.equal(out.mimeType,'image/png');
});
test('temporary tether failures defer metadata rather than corrupt it',()=>{
 const owner={states:new Map(),now:()=>10};const result=LibraryMetadata.prototype.defer.call(owner,'book',unavailable());assert.equal(result?.status,'deferred');assert.equal(result.code,'COLLECTION_NETWORK_PAUSED');
});
