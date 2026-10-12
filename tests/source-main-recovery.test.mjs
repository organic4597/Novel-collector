import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {JSDOM} from "jsdom";
import {FolderStore} from "../src/store.mjs";
import {SiteAttention} from "../src/site-attention.mjs";
import {Collector,readReaderDocument} from "../src/collector.mjs";
import {sourceGateHost} from "../src/source-site.mjs";
import {createSourceAuthentication,activeSourceStatus} from "../src/source-runtime.mjs";
import {SiteBrowser} from "../src/site-browser.mjs";
import {AutoRecovery} from "../src/auto-recovery.mjs";

test("actual source hosts are their own gates and legacy identity routes to the main source",()=>{
  assert.equal(sourceGateHost("sbxh9.com"),"sbxh9.com");assert.equal(sourceGateHost("newtoki1.org"),"sbxh9.com");
  assert.equal(sourceGateHost("toki32.com"),"toki32.com");
  assert.equal(activeSourceStatus({originFor:()=>"https://toki32.com"}).host,"sbxh9.com");
});
test("migration merges legacy and actual source holds without accepting an old released proof",async t=>{
  const root=await mkdtemp(join(tmpdir(),"main-source-attention-"));t.after(()=>rm(root,{recursive:true,force:true}));const store=await new FolderStore(root).init();
  await store.atomic(store.path("site-attention.json"),{sites:[
    {host:"newtoki1.org",held:false,kind:"captcha",reason:"old",jobIds:["old-job"],requiredSlots:[1,2],verifiedSlots:[1,2],proofOrigin:"https://sbxh9.com"},
    {host:"sbxh9.com",held:true,kind:"authentication",reason:"current",jobIds:["image-job"],requiredSlots:[1,2],verifiedSlots:[]}
  ]});
  const attention=new SiteAttention({store});await attention.load();const sites=attention.snapshot().sites;
  assert.equal(sites.length,1);assert.equal(sites[0].host,"sbxh9.com");assert.equal(sites[0].held,true);assert.deepEqual(sites[0].verifiedSlots,[]);
  assert.deepEqual(sites[0].jobIds,["image-job"]);assert.equal(attention.isHeld("newtoki1.org"),true);
  await attention.verifySlot("sbxh9.com",1,{viewerOrigin:"https://sbxh9.com"});assert.equal(attention.isHeld("sbxh9.com"),true);
  await attention.verifySlot("sbxh9.com",2,{viewerOrigin:"https://sbxh9.com"});assert.equal(attention.isHeld("sbxh9.com"),false);
});
test("stale failed retry selections skip recovered chapters and still retry current failures",async()=>{
  const events=[],rows=[{id:"saved",number:1,url:"https://newtoki1.org/novel/1/1"},{id:"failed",number:2,url:"https://newtoki1.org/novel/1/2"}];
  const collector=new Collector({store:{readCatalog:async()=>({title:"fixture",chapters:rows,expectedChapters:2}),listFailures:async()=>[{id:"failed"}],readChapter:async(_book,id)=>id==="saved"?{text:"stored"}:null}});
  const plan=await collector.collectionPlan({}, {url:"https://newtoki1.org/novel/1",retryOnlyFailed:true,retryChapterIds:["saved","failed"]},{event:async(_level,message)=>events.push(message)},new AbortController().signal,"book");
  assert.deepEqual(plan.chapters.map(row=>row.id),["failed"]);assert.ok(events.some(message=>/제외/.test(message)));
});
test("all recovered explicit retry targets become no work instead of aborting the job",async()=>{
  const row={id:"saved",number:1,url:"https://newtoki1.org/novel/1/1"};
  const collector=new Collector({store:{readCatalog:async()=>({chapters:[row],expectedChapters:1}),listFailures:async()=>[],readChapter:async()=>({text:"stored"})}});
  const plan=await collector.collectionPlan({}, {url:"https://newtoki1.org/novel/1",retryOnlyFailed:true,retryChapterIds:["saved"]},{event:async()=>{}},new AbortController().signal,"book");
  assert.deepEqual(plan.chapters,[]);
});
test("image reader proof uses decoded images and does not invent novel text",()=>{
  for(const type of ["webtoon","manhwa"]){const dom=new JSDOM('<div class="vw-imgs"><img src="/page.png"></div>',{url:`https://sbxh9.com/${type}/work/episode`});
    const image=dom.window.document.querySelector("img");Object.defineProperties(image,{complete:{value:true},naturalWidth:{value:100}});
    const state=readReaderDocument(dom.window.document);assert.equal(state.imageReady,true);assert.equal(state.text,"");dom.window.close();}
});
test("image current chapter links are accepted as site proof targets",async()=>{
  for(const type of ["webtoon","manhwa"]){const row={id:"episode",url:`https://sbxh9.com/${type}/work/episode`};
    const browser=new SiteBrowser({store:{getJob:async()=>({url:`https://sbxh9.com/${type}/work`,bookId:"book",currentChapterId:row.id}),readCatalog:async()=>({chapters:[row]})},scheduler:{},attention:{}});
    assert.equal(await browser.probeFor({host:"sbxh9.com",jobIds:["job"]}),row.url);}
});
test("decoded image proof releases only after both profiles and never writes empty novel chapters",async t=>{
  const site={host:"sbxh9.com",held:true,jobIds:["job"],requiredSlots:[1,2],verifiedSlots:[]},row={id:"episode",url:"https://sbxh9.com/manhwa/work/episode"};let url="",textWrites=0,releases=0;
  const page={url:()=>url,goto:async value=>{url=value;return{status:()=>200};},evaluate:async reader=>{const dom=new JSDOM('<div class="vw-imgs"><img src="/page.png"></div>',{url});Object.defineProperties(dom.window.document.querySelector("img"),{complete:{value:true},naturalWidth:{value:100}});try{return reader(dom.window.document);}finally{dom.window.close();}}};
  const browser=new SiteBrowser({store:{getJob:async()=>({url:"https://sbxh9.com/manhwa/work",bookId:"book",currentChapterId:row.id}),readCatalog:async()=>({chapters:[row]})},profileDir:"fixture/profile",launchContext:async()=>({route:async()=>{},newPage:async()=>page,close:async()=>{}}),
    scheduler:{reserveManualSlot:async()=>true,releaseManualSlot:async()=>{},releaseSite:async()=>{releases++;}},attention:{get:()=>site,snapshot:()=>({sites:[site]}),verifySlot:async(_host,slot)=>{site.verifiedSlots.push(slot);site.held=site.verifiedSlots.length<2;}},onVerified:async()=>{textWrites++;}});
  t.after(()=>browser.close());await browser.open({host:site.host,slot:1});assert.equal((await browser.check({reload:false})).verified,true);assert.equal(site.held,true);assert.equal(releases,0);
  await browser.open({host:site.host,slot:2});assert.equal((await browser.check({reload:false})).siteReleased,true);assert.equal(releases,1);assert.equal(textWrites,0);assert.ok(url.startsWith("https://sbxh9.com/"));
});
test("main-source automatic authentication looks up the actual held gate and both slot profiles",async()=>{
  const site={host:"sbxh9.com",held:true,requiredSlots:[1,2],verifiedSlots:[]},opened=[],lookups=[];let current=null;
  const auth=createSourceAuthentication({viewerOrigins:{resolve:value=>value},accounts:{status:()=>({enabled:true,configured:true}),getCredentials:async host=>({host})},attention:{get:host=>{lookups.push(host);return host===site.host?site:null;}},scheduler:{},
    login:async()=>({authenticated:true,reused:true}),siteBrowser:{
      open:async target=>{current=target;opened.push(target);return{viewerHost:site.host};},
      authenticate:async callback=>{let url="https://sbxh9.com/webtoon/work/episode";return callback({url:()=>url,goto:async value=>{url=value;return{status:()=>200};}},{...current,viewerHost:site.host});},
      check:async()=>{site.verifiedSlots.push(current.slot);if(site.verifiedSlots.length===2)site.held=false;current=null;return{verified:true};},status:async()=>({open:!!current,...current}),close:async()=>{current=null;}
    }});
  await auth.start(site.host);const result=await auth.wait(site.host);assert.equal(result.state,"ready");assert.deepEqual(opened.map(row=>row.host),[site.host,site.host]);assert.ok(lookups.every(host=>host===site.host));
});
test("automatic image proof checks decoded images and retains the hold until explicit verification",async t=>{
  let url="",challenge=false,disposed=0,released=0;
  const page={url:()=>url,goto:async value=>{url=value;return{status:()=>200};},evaluate:async()=>({text:"",imageReady:true,challenge,verificationRequired:false})};
  const site={host:"sbxh9.com",held:true,requiredSlots:[1,2],verifiedSlots:[],jobIds:["job"]};
  const browser=new SiteBrowser({store:{getJob:async()=>({url:"https://sbxh9.com/webtoon/work/episode"})},profileDir:"fixture/profile",
    launchContext:async()=>({route:async()=>{},newPage:async()=>page,close:async()=>{}}),
    scheduler:{reserveManualSlot:async()=>true,releaseManualSlot:async()=>{}},attention:{get:()=>site},
    captchaSupport:{attach:async()=>({settle:async()=>false,dispose:async()=>{disposed++;}}),release:async()=>{released++;}}});
  t.after(()=>browser.close());await browser.open({host:site.host,slot:1});
  assert.deepEqual(await browser.retryAutomatic(),{ready:true});assert.equal(site.held,true);assert.deepEqual(site.verifiedSlots,[]);
  challenge=true;await assert.rejects(browser.retryAutomatic(),error=>error.attentionKind==="captcha");
  assert.equal(site.held,true);assert.equal(disposed,2);assert.equal(released,3);
});
test("transient site access failures are automatically checked again after a delay",{timeout:3000},async()=>{
  let count=0,state={state:"needs_attention",failureKind:"site_blocked"};const recovery=new AutoRecovery({scheduler:{active:new Map()},accounts:{status:()=>({enabled:true,configured:true})},pollMs:1,accessRetryMs:10,
    autoAuth:{status:()=>state,start:async()=>{count++;state={state:"running"};},wait:async()=>{state=count===1?{state:"needs_attention",failureKind:"site_blocked"}:{state:"ready"};return state;}}});
  try{recovery.request({host:"sbxh9.com",kind:"site_blocked",held:true});for(let checks=0;checks<100&&recovery.status("sbxh9.com").state!=="ready";checks++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(recovery.status("sbxh9.com").state,"ready");assert.equal(count,2);}finally{recovery.close();}
});
