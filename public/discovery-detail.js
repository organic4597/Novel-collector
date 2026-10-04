"use strict";
(() => {
  const UI = window.CollectorUI, $ = id => document.getElementById(id);
  const cache = new Map(), origins = new Set(["https://sbxh9.com", "https://toki32.com"]);
  const originalTitle = document.title;
  let item = null, epoch = 0, loading = false, submitting = false, timer = null, finishWait = null;
  function cancelWait() { clearTimeout(timer); finishWait?.(); finishWait=null; }
  const valid = id => /^\d{1,15}$/.test(String(id));
  const current = own => own === epoch && UI.authenticated() && UI.view() === "work" && !document.hidden;
  function show(work) {
    if (!work || !valid(work.id)) return;
    item = { ...item, ...work, id: String(work.id) };
    $("work-title").textContent = item.title || "작품 정보";
    document.title = `${item.title || "작품 정보"} · Novel Collector`;
    $("work-author").textContent = item.author || "작가 정보 없음";
    $("work-platform").textContent = item.platform || "공급처 정보 없음";
    $("work-publication").textContent = {ongoing:"연재 중",completed:"완결"}[item.publication] || item.publicationRaw || "연재 상태 미확인";
    $("work-episodes").textContent = Number.isSafeInteger(item.episodeCount) && item.episodeCount >= 0 ? `총 ${UI.count(item.episodeCount)}화` : "회차 수 미확인";
    $("work-synopsis").textContent = item.synopsis || (loading ? "작품 소개를 확인하고 있습니다…" : "사이트에서 제공한 작품 소개가 없습니다.");
    for (const [id, values, prefix, fallback] of [
      ["work-genres", item.genres, "", "장르 정보 없음"],
      ["work-tags", item.tags, "#", "태그 정보 없음"],
    ]) {
      const labels = Array.isArray(values) ? values.filter(v=>typeof v === "string" && v.trim()).slice(0,30) : [];
      $(id).replaceChildren(...(labels.length ? labels.map(v=>UI.node("span","work-chip",prefix+v.replace(/^#/,""))) : [UI.node("span","muted",fallback)]));
    }
    const cover = $("work-cover");
    if (typeof item.thumbnail === "string" && /^\/api\/discover\/\d{1,15}\/thumbnail$/.test(item.thumbnail)) {
      if (cover.getAttribute("src") !== item.thumbnail) { cover.src = item.thumbnail; cover.hidden = false; }
    } else { cover.removeAttribute("src"); cover.hidden = true; }
    const origin = origins.has(UI.status?.().source?.origin) ? UI.status().source.origin : "https://sbxh9.com";
    $("work-source").href = new URL(`/novel/${item.id}`, origin).href;
    $("work-refresh").disabled = loading;
    $("work-add").disabled = submitting;
    $("work-select").disabled = loading || submitting;
  }
  function remember(work) {
    if (!work || !valid(work.id)) return;
    cache.set(String(work.id), { item: work, at: Date.now() });
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    window.DiscoveryCatalog?.update(work);
  }
  async function load(own) {
    if (!current(own) || !item) return;
    loading = true;
    $("work-error").textContent = "";
    $("work-status").textContent = "저장된 작품 정보를 확인하는 중…";
    show(item);
    const id = item.id, generation = UI.generation();
    try {
      let result = await UI.api(`/api/discover/${id}/overview`);
      if (!current(own) || generation !== UI.generation()) return;
      if (result.item) show(result.item);
      if (!["completed", "pending"].includes(result.status))
        result = await UI.api(`/api/discover/${id}/overview`, { method:"POST", body:"{}" });
      for (let checks = 0; result.status === "pending" && checks < 60; checks++) {
        $("work-status").textContent = "사이트의 작품 소개 페이지를 확인하는 중…";
        await new Promise(resolve => { finishWait=resolve; timer = setTimeout(()=>{finishWait=null;resolve();}, 1000); });
        if (!current(own) || generation !== UI.generation()) return;
        result = await UI.api(`/api/discover/${id}/overview`);
      }
      if (!current(own) || generation !== UI.generation()) return;
      if (result.status !== "completed" || !result.item)
        throw new Error(result.error || "작품 정보 조회가 지연되고 있습니다. 잠시 후 다시 확인하세요.");
      remember(result.item);
      loading = false;
      show(result.item);
      $("work-status").textContent = "작품 정보 확인 완료 · 소개 페이지 기준";
    } catch (error) {
      if (current(own)) { loading = false; show(item); $("work-error").textContent = UI.textError(error); $("work-status").textContent = "저장된 정보를 표시합니다. 소개를 다시 확인할 수 있습니다."; }
    } finally { if (own === epoch) { loading = false; show(item); } }
  }
  function open(work, { push = true } = {}) {
    if (!UI.authenticated() || !work || !valid(work.id)) return;
    const id = String(work.id), own = ++epoch;
    cancelWait(); loading = false; submitting = false; item = { ...work, id };
    const cached = cache.get(id);
    if (cached && Date.now() - cached.at < 30*60*1000) item = { ...item, ...cached.item };
    if (push) {
      const url = new URL(location.href); url.searchParams.set("work",id);
      history.pushState({ work:id }, "", url);
    }
    UI.navigate("work");
    $("work-error").textContent = "";
    show(item); $("work-back").focus({preventScroll:true});
    if (cached && Date.now() - cached.at < 30*60*1000) $("work-status").textContent = "저장된 작품 소개";
    else void load(own);
  }
  function back() {
    if (history.state?.work === item?.id) history.back();
    else {
      const url = new URL(location.href); url.searchParams.delete("work"); history.replaceState({},"",url);
      UI.navigate("discover");
    }
  }
  $("work-back").addEventListener("click",back);
  $("work-refresh").addEventListener("click",()=>{ if (!loading) void load(++epoch); });
  $("work-cover").addEventListener("error",()=>{ $("work-cover").hidden=true; });
  $("work-select").addEventListener("click",()=>{
    if (item) window.DiscoveryCatalog?.select(item);
    back();
  });
  $("work-add").addEventListener("click",async()=>{
    if (!item || submitting || !UI.authenticated()) return;
    submitting=true;show(item);
    const own=epoch,generation=UI.generation();
    try {
      const result=await UI.batch([{url:`https://newtoki1.org/novel/${item.id}`,title:item.title || "",
        format:$("work-format").value,executor:"server",startAt:null,startEpisode:null,endEpisode:null,overwrite:false}]);
      if (own!==epoch || generation!==UI.generation())return;
      UI.toast(result.jobs?.length ? "작품을 수집 대기열에 등록했습니다." : "이미 등록된 작품입니다.");
    }catch(error){ if(own===epoch)$("work-error").textContent=UI.textError(error); }
    finally{if(own===epoch){submitting=false;show(item);}}
  });
  function fromURL() {
    const id=new URL(location.href).searchParams.get("work");
    if(valid(id))open(cache.get(id)?.item || {id,title:"작품 정보"},{push:false});
    else if(UI.view()==="work")UI.navigate("discover");
  }
  window.addEventListener("popstate",fromURL);
  document.addEventListener("collector:auth",()=>{
    if(UI.authenticated())fromURL();else{epoch++;cancelWait();item=null;cache.clear();document.title=originalTitle;$("work-synopsis").textContent="";}
  });
  document.addEventListener("collector:view",()=>{
    if(UI.view()!=="work"){
      epoch++;cancelWait();loading=false;document.title=originalTitle;
      const url=new URL(location.href);url.searchParams.delete("work");history.replaceState({},"",url);
    }
  });
  document.addEventListener("visibilitychange",()=>{
    if(document.hidden){epoch++;cancelWait();loading=false;}
    else if(UI.view()==="work" && item)void load(++epoch);
  });
  window.DiscoveryDetails={open};
  if(UI.authenticated())fromURL();
})();
