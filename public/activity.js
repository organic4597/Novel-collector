"use strict";
(() => {
  const UI = window.CollectorUI, $ = id => document.getElementById(id);
  let timer, epoch = 0, loading = false, paused = false, rows = [], latest = 0, hasMore = false;
  const active = () => UI.authenticated() && UI.view() === "activity" && !document.hidden;
  function params() {
    const p = new URLSearchParams({ limit: "100", level: $("activity-level").value, scope: $("activity-scope").value });
    return p;
  }
  function render() {
    const filter = $("activity-search").value.trim().toLowerCase();
    const fragment = document.createDocumentFragment();
    const visible = rows.filter(r => !filter || `${r.message} ${r.scope} ${r.jobId || ""} ${JSON.stringify(r.details)}`.toLowerCase().includes(filter));
    for (const r of visible) {
      const row = UI.node("article", `activity-row ${r.level}`);
      const heading = UI.node("div", "activity-meta");
      heading.append(UI.node("time", "", UI.date(r.time, true)), UI.node("strong", "", r.level.toUpperCase()),
        UI.node("span", "", r.scope), UI.node("span", "muted", r.jobId ? r.jobId.slice(0, 8) : "서비스"));
      row.append(heading, UI.node("p", "", r.message));
      if (Object.keys(r.details || {}).length) row.append(UI.node("pre", "activity-details", JSON.stringify(r.details, null, 2)));
      fragment.append(row);
    }
    if (!visible.length) fragment.append(UI.node("p", "muted", "조건에 맞는 상세 로그가 없습니다."));
    const list = $("activity-list"), scroll = list.scrollTop;
    list.replaceChildren(fragment);
    list.scrollTop = scroll;
    $("activity-count").textContent = `${visible.length}개 표시 · 최근 ${rows.length}개 보관`;
    $("activity-older").disabled = loading || !hasMore;
  }
  async function refresh({ reset = false, older = false } = {}) {
    if (!active() || loading || (!reset && !older && paused)) return;
    loading = true;
    const own = epoch, generation = UI.generation();
    const p = params();
    if (older && rows.length) p.set("before", String(Math.min(...rows.map(r => r.id))));
    else if (!reset && latest) p.set("after", String(latest));
    try {
      const result = await UI.api("/api/activity?" + p);
      if (!active() || own !== epoch || generation !== UI.generation()) return;
      const items = result.items || [];
      if (reset) rows = [];
      const indexed = new Map(rows.map(r => [r.id, r]));
      for (const r of items) indexed.set(r.id, r);
      rows = [...indexed.values()].sort((a,b) => b.id - a.id).slice(0, 500);
      if (!older) latest = items.length ? Math.max(latest, ...items.map(r => r.id)) : Math.max(latest, result.latestId || 0);
      if (reset || older) hasMore = Boolean(result.hasMore);
      $("activity-error").textContent = "";
      if (reset || items.length) render();
    } catch (e) { if (own === epoch && active()) $("activity-error").textContent = UI.textError(e); }
    finally {
      loading = false;
      clearTimeout(timer);
      if (active() && !paused) timer = setTimeout(refresh, Math.max(3000, UI.preferences().refreshIntervalMs));
    }
  }
  function reset() { epoch++; latest = 0; rows = []; hasMore = false; clearTimeout(timer); refresh({reset:true}); }
  $("activity-level").addEventListener("change", reset);
  $("activity-scope").addEventListener("change", reset);
  $("activity-search").addEventListener("input", window.CollectorPerformance.debounce(render, 200));
  $("activity-refresh").addEventListener("click", () => refresh({reset:true}));
  $("activity-older").addEventListener("click", () => refresh({older:true}));
  $("activity-pause").addEventListener("click", () => {
    paused = !paused; clearTimeout(timer);
    $("activity-pause").textContent = paused ? "실시간 갱신 재개" : "실시간 갱신 멈춤";
    if (!paused) refresh();
  });
  document.addEventListener("collector:view", () => { clearTimeout(timer); epoch++; if (active()) refresh({reset:true}); });
  document.addEventListener("visibilitychange", () => { clearTimeout(timer); if (active()) refresh(); });
  document.addEventListener("collector:auth", () => {
    epoch++; clearTimeout(timer);
    if (!UI.authenticated()) { rows = []; latest = 0; $("activity-list").replaceChildren(); }
  });
})();
