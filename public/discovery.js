"use strict";
(() => {
  const UI = window.CollectorUI;
  const $ = (id) => document.getElementById(id);
  const pending = new Set();
  const selected = new Map(),
    known = new Map(),
    attempted = new Set();
  let items = [],
    page = 1,
    maxPage = 1,
    loading = false,
    submitting = false;
  let checking = false,
    active = false,
    version = 0,
    observer,
    autoRunning = false,
    sourceAutoPaused = false;
  let workPopup = false;
  let autoQueue = [],
    requestChain = Promise.resolve();
  const pageSnapshots = new Map(), pageTTL = 30 * 60 * 1000;
  let dataEpoch = 0, refreshTimer = null, refreshChecks = 0;
  const cardPool = new Map();
  let renderedCards = new Map(),
    renderedIds = [];
  let pendingLoad = null, interruptedPage = null,
    loadingCards = [], loadingCount = 40, loadedCount = 0, renderedLoadingCount = 0, pageIncomplete = false;
  const genreNames = [
    "판타지",
    "무협",
    "19금",
    "현대",
    "로맨스",
    "로맨스 판타지",
    "BL",
    "라노벨",
    "기타",
  ];
  const platforms = [
    ["user", "유저"],
    ["novelpia", "노벨피아"],
    ["booktoki", "북토끼"],
    ["munpia", "문피아"],
    ["joara", "조아라"],
    ["kakaopage", "카카오페이지"],
    ["series", "네이버 시리즈"],
    ["ridi", "리디"],
    ["etc", "기타"],
  ];
  for (const genre of genreNames)
    $("discover-genre").append(option(genre, genre));
  for (const [value, label] of platforms)
    $("discover-platform").append(option(value, label));
  function option(value, label) {
    const el = UI.node("option", "", label);
    el.value = value;
    return el;
  }
  function notice(message = "", error = "") {
    $("discover-message").textContent = message;
    $("discover-error").textContent = error;
  }
  function stopAuto() {
    version++;
    autoQueue = [];
    observer?.disconnect();
  }
  function authenticated() {
    return UI.authenticated();
  }
  function display(item) {
    return known.get(String(item.id)) || item;
  }
  function metadata(item) {
    const id = String(item.id);
    known.set(id, item);
    if (selected.has(id)) selected.set(id, item);
    items = items.map((entry) => (String(entry.id) === id ? item : entry));
  }
  function bounds() {
    const value = (id) => ($(id).value === "" ? null : Number($(id).value));
    const min = value("discover-min"),
      max = value("discover-max");
    if (
      (min !== null && (!Number.isSafeInteger(min) || min < 0)) ||
      (max !== null && (!Number.isSafeInteger(max) || max < 0)) ||
      (min !== null && max !== null && min > max)
    )
      throw new Error("회차 범위를 확인하세요.");
    return { min, max };
  }
  function visibleItems() {
    const { min, max } = bounds();
    return items.map(display).filter((item) => {
      if (item.episodeCount === null || item.episodeCount === undefined)
        return $("discover-unknown").checked;
      return (
        (min === null || item.episodeCount >= min) &&
        (max === null || item.episodeCount <= max)
      );
    });
  }
  function selectionState() {
    $("discover-selected").textContent = `${UI.count(selected.size)}개 선택`;
    $("discover-add-selected").disabled = !selected.size || submitting;
    $("discover-check-selected").disabled = !selected.size || checking;
    $("discover-clear").disabled = !selected.size || submitting;
    let visible = [];
    try {
      visible = visibleItems();
    } catch {
      /* Range errors are shown by render(). */
    }
    const checked = visible.filter((item) =>
      selected.has(String(item.id)),
    ).length;
    $("discover-select-page").checked =
      visible.length > 0 && checked === visible.length;
    $("discover-select-page").indeterminate =
      checked > 0 && checked < visible.length;
  }
  function render() {
    if (!active || !authenticated() || document.hidden) return;
    observer?.disconnect();
    let visible;
    try {
      visible = visibleItems();
    } catch (error) {
      notice("", UI.textError(error));
      return;
    }
    const ids = visible.map((item) => String(item.id)),
      nextCards = new Map();
    const placeholders = loading ? loadingCards.slice(loadedCount, loadingCount) : [];
    const sameOrder =
      ids.length === renderedIds.length &&
      ids.every((id, index) => id === renderedIds[index]);
    for (const item of visible) {
      const id = String(item.id), entry = cardPool.get(id) || card(item);
      patchCard(entry, item);
      cardPool.delete(id); cardPool.set(id, entry); nextCards.set(id, entry);
    }
    const nodes = visible.map(item => nextCards.get(String(item.id)).node).concat(placeholders);
    reconcile($("discover-list"), nodes.length ? nodes : [UI.empty("조건에 맞는 작품이 없습니다", "검색 조건이나 회차 필터를 변경해 보세요.")]);
    while (cardPool.size > 120) cardPool.delete(cardPool.keys().next().value);
    renderedCards = nextCards;
    renderedIds = ids;
    renderedLoadingCount = placeholders.length;
    $("discover-list").setAttribute("aria-busy", String(loading));
    $("discover-page").textContent = `${page} / ${maxPage}`;
    $("discover-prev").disabled = loading || page <= 1;
    $("discover-next").disabled = loading || pageIncomplete || page >= maxPage;
    $("discover-search").disabled = loading;
    selectionState();
    observeVisible();
  }
  function reconcile(parent, nodes) {
    let cursor = parent.firstChild;
    for (const el of nodes) { if (el !== cursor) parent.insertBefore(el, cursor); cursor = el.nextSibling; }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
  }
  function text(el, value) { value = String(value ?? ""); if (el.textContent !== value) el.textContent = value; }
  function card(item) {
    const id = String(item.id), el = UI.node("article", "discover-card"); el.dataset.id = id;
    const e = { node: el, item, id, cover: UI.node("div", "discover-cover"), check: UI.node("input"),
      link: UI.node("a", "discover-title-link"), author: UI.node("p", "discover-author"), tags: UI.node("div", "discover-tags"),
      count: UI.node("strong", "discover-count"), meta: UI.node("p", "discover-meta"), button: UI.node("button", "quiet") };
    e.cover.append(UI.node("span", "cover-fallback", "▤"));
    const label = UI.node("label", "discover-select"); e.check.type = "checkbox"; label.append(e.check); e.cover.append(label);
    e.check.addEventListener("change", () => {
      if (e.check.checked) { if (selected.size >= 100) { e.check.checked = false; notice("", "한 번에 최대 100개 작품을 선택할 수 있습니다."); return; } selected.set(id, e.item); }
      else selected.delete(id); selectionState();
    });
    e.link.href = "/?work=" + encodeURIComponent(id);
    e.link.addEventListener("click", event => { if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); window.DiscoveryDetails?.open(e.item); });
    const heading = UI.node("h2"); heading.append(e.link);
    const content = UI.node("div", "discover-content"); content.append(heading, e.author, e.tags, e.count, e.meta, e.button);
    e.button.addEventListener("click", async () => {
      if (checking) return; checking = true; render();
      try { await refresh(e.item); notice("회차 정보를 확인했습니다."); }
      catch (error) { if (!error.cancelled) notice("", UI.textError(error)); }
      finally { checking = false; render(); scheduleAuto(); }
    });
    el.append(e.cover, content);
    el.addEventListener("click", event => { if (!event.target.closest("a, button, input, label, select")) window.DiscoveryDetails?.open(e.item); });
    return e;
  }
  function patchCard(e, item) {
    e.item = item; if (selected.has(e.id)) selected.set(e.id, item);
    text(e.link, item.title || "제목 없음"); text(e.author, item.author || "작가 정보 확인 전");
    e.check.checked = selected.has(e.id); e.check.setAttribute("aria-label", (item.title || "작품") + " 선택");
    const values = [...(Array.isArray(item.genres) ? item.genres : []), ...(Array.isArray(item.tags) ? item.tags.slice(0, 4).map(tag => "#" + tag) : []), item.platform].filter(Boolean);
    const tags = values.join("\u001f"); if (tags !== e.tagKey) { e.tagKey = tags; e.tags.replaceChildren(...values.map(value => UI.node("span", "", value))); }
    const knownCount = Number.isSafeInteger(item.episodeCount) && item.episodeCount >= 0;
    text(e.count, pending.has(e.id) ? "회차 확인 중…" : knownCount ? "총 " + UI.count(item.episodeCount) + "화" : "회차 확인 전");
    text(e.meta, ({ ongoing: "연재 중", completed: "완결" }[item.publication] || "연재 상태 미확인") + (item.updatedLabel ? " · " + item.updatedLabel : ""));
    text(e.button, knownCount ? "회차 다시 확인" : "회차 확인"); e.button.disabled = checking || pending.has(e.id);
    const source = typeof item.thumbnail === "string" && /^\/api\/discover\/\d{1,15}\/thumbnail$/.test(item.thumbnail) ? item.thumbnail : null;
    if (source !== e.imageSource) { e.image?.remove(); e.image = null; e.imageSource = source;
      if (source) { const img = UI.node("img"); img.src = source; img.alt = ""; img.loading = "lazy"; img.decoding = "async"; img.width = 160; img.height = 224;
        img.addEventListener("error", () => img.remove(), { once: true }); e.image = img; e.cover.append(img); }
    }
  }
  function queryFor(target) {
    return new URLSearchParams({ page: String(target), query: $("discover-query").value.trim(), genre: $("discover-genre").value,
      platform: $("discover-platform").value, publication: $("discover-publication").value, sort: $("discover-sort").value });
  }
  function rememberPage(key, data, complete) {
    pageSnapshots.delete(key); pageSnapshots.set(key, { data: { ...data, items: [...data.items] }, complete, at: Date.now() });
    while (pageSnapshots.size > 3) pageSnapshots.delete(pageSnapshots.keys().next().value);
  }
  function pageNotice(data) {
    notice(UI.count(items.length) + "개 작품 · " + (data.stale ? data.revalidating ? "저장된 목록 표시 · 최신 목록 갱신 중…" : "저장된 목록 표시 · 갱신 대기" : data.cacheHit ? "저장된 목록" : "최신 목록") +
      (data.cachedAt ? " · " + UI.date(data.cachedAt) : ""), data.refreshError || "");
  }
  function scheduleRefresh(data) {
    clearTimeout(refreshTimer);
    if (!data.revalidating || data.refreshError || !active || !authenticated() || document.hidden || refreshChecks >= 30) return;
    refreshTimer = setTimeout(() => { refreshChecks++; void load(page, { force: true, revalidate: true }); }, 2000);
  }
  async function load(target = 1, options = {}) {
    if (!authenticated() || document.hidden) return;
    const query = queryFor(target), key = query.toString(), cached = pageSnapshots.get(key);
    if (pendingLoad?.key === key) return;
    if (pendingLoad) { pendingLoad.controller.abort(); pendingLoad = null; loading = false; }
    clearTimeout(refreshTimer);
    if (!options.revalidate) refreshChecks = 0;
    const changingPage = target !== page;
    const previous = { items, page, maxPage, pageIncomplete };
    active = true; sourceAutoPaused = false; stopAuto();
    if (cached) {
      pageSnapshots.delete(key); pageSnapshots.set(key, cached);
      items = cached.data.items; page = cached.data.page || target; maxPage = cached.data.maxPage || 1;
      pageIncomplete = !cached.complete; loadedCount = cached.data.loadedCount ?? items.length; loadingCount = 40;
      loading = !cached.complete; render(); pageNotice(cached.data);
      if (changingPage) $("discover-list").firstElementChild?.scrollIntoView({ block: "start", behavior: "instant" });
      if (cached.complete && !cached.dirty && !cached.data.stale && Date.now() - cached.at < pageTTL && !options.force) return;
    }
    const request = { target, key, controller: new AbortController(), generation: UI.generation(), dataEpoch,
      received: false, focused: false, background: !!cached?.complete };
    pendingLoad = request; interruptedPage = null; loading = !request.background;
    const current = () => pendingLoad === request && active && authenticated() && request.generation === UI.generation() && request.dataEpoch === dataEpoch;
    if (!cached) {
      items = []; loadedCount = 0; loadingCount = 40;
      loadingCards = Array.from({ length: 40 }, () => {
        const card = UI.node("article", "discover-card is-loading"); card.setAttribute("aria-hidden", "true"); card.append(UI.node("div", "discover-cover"));
        const content = UI.node("div", "discover-content"); for (let line = 0; line < 4; line++) content.append(UI.node("div", "discover-loading-line")); card.append(content); return card;
      });
    }
    notice(request.background ? "저장된 목록 표시 · 최신 목록을 확인하는 중…" : "작품 목록을 불러오는 중…"); render();
    if (changingPage && !cached && UI.view() === "discover") $("discover-list").firstElementChild?.scrollIntoView({ block: "start", behavior: "instant" });
    const apply = (data, complete = false) => {
      if (!current()) return;
      const received = Array.isArray(data.items) ? data.items : [];
      if (!request.background || complete) {
        items = received.map(item => data.stale && known.has(String(item.id)) ? { ...item, ...known.get(String(item.id)) } : item);
        page = data.page || target; maxPage = Math.max(1, data.maxPage || 1); loadedCount = data.loadedCount ?? items.length;
        loadingCount = Number.isSafeInteger(data.total) ? Math.min(40, Math.max(0, data.total - (page - 1) * 40)) : 40;
        for (const item of items) if (item.episodeCount != null) { known.set(String(item.id), item); if (selected.has(String(item.id))) selected.set(String(item.id), item); }
        rememberPage(key, { ...data, items }, complete);
      }
      request.received ||= received.length > 0;
      if (complete) { loading = false; pageIncomplete = false; pageNotice(data); scheduleRefresh(data); }
      else notice(request.background ? "저장된 목록 표시 · 최신 목록 갱신 중…" : UI.count(loadedCount) + " / " + UI.count(loadingCount) + "개 작품 확인 · 준비된 작품부터 표시 중…");
      render();
      if (changingPage && !request.focused && !workPopup && !document.hidden && UI.view() === "discover") {
        const first = $("discover-list").querySelector(".discover-title-link"); if (first) { first.focus({ preventScroll: true }); request.focused = true; }
      }
    };
    try {
      const data = await UI.api("/api/discover?" + query, { force: !!options.force, headers: { Accept: "application/x-ndjson" }, signal: request.controller.signal }, 60000, data => apply(data));
      apply(data, true);
    } catch (error) {
      if (current() && !request.controller.signal.aborted && !error.cancelled) {
        if (!request.received) { items = previous.items; page = previous.page; maxPage = previous.maxPage; pageIncomplete = previous.pageIncomplete; }
        else if (!request.background) pageIncomplete = true;
        notice(items.length ? UI.count(items.length) + "개 작품 표시 · 목록 갱신 실패" : "", UI.textError(error));
      }
    } finally { if (pendingLoad === request) { pendingLoad = null; loading = false; render(); } }
  }
  function refresh(item) {
    const current = version,
      id = String(item.id);
    const assertCurrent = () => {
      if (
        current !== version ||
        !active ||
        !authenticated() ||
        document.hidden
      ) {
        attempted.delete(id);
        throw new Error("페이지를 이동하거나 숨겨 회차 확인을 멈췄습니다.");
      }
    };
    const task = requestChain
      .catch(() => {})
      .then(async () => {
        assertCurrent();
        pending.add(id);
        render();
        try {
          let response = await UI.api(
            `/api/discover/${encodeURIComponent(id)}/refresh`,
            { method: "POST", body: "{}" },
          );
          while (response.status === "pending") {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            assertCurrent();
            response = await UI.api(
              `/api/discover/${encodeURIComponent(id)}/metadata`,
            );
          }
          assertCurrent();
          if (response.status === "failed")
            throw new Error(
              response.error ||
                "회차 정보를 확인하지 못했습니다. 다시 시도하세요.",
            );
          const result =
            response.status === "completed" ? response.item : response;
          if (
            !result ||
            !Number.isSafeInteger(result.episodeCount) ||
            result.episodeCount < 0
          )
            throw new Error("회차 정보 응답이 올바르지 않습니다.");
          metadata({ ...item, ...result });
          return result;
        } finally {
          pending.delete(id);
          render();
        }
      });
    requestChain = task;
    return task;
  }
  function observeVisible() {
    if (
      loading ||
      !active ||
      workPopup ||
      sourceAutoPaused ||
      !authenticated() ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            const item = items
              .map(display)
              .find((value) => String(value.id) === entry.target.dataset.id);
            if (
              item &&
              item.episodeCount == null &&
              !attempted.has(String(item.id)) &&
              !autoQueue.some((value) => value.id === item.id)
            )
              autoQueue.push(item);
            observer.unobserve(entry.target);
          }
        scheduleAuto();
      },
      { rootMargin: "0px", threshold: 0.15 },
    );
    for (const card of $("discover-list").children)
      if (card.dataset.id) observer.observe(card);
  }
  async function scheduleAuto() {
    if (
      loading ||
      autoRunning ||
      workPopup ||
      sourceAutoPaused ||
      checking ||
      !active ||
      !authenticated() ||
      document.hidden
    )
      return;
    autoRunning = true;
    const current = version;
    try {
      while (
        autoQueue.length &&
        !workPopup &&
        current === version &&
        active &&
        !checking &&
        authenticated() &&
        !document.hidden
      ) {
        const item = autoQueue.shift();
        attempted.add(String(item.id));
        try {
          await refresh(item);
          if (current === version) render();
        } catch (error) {
          if (current === version) notice("", UI.textError(error));
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      autoRunning = false;
      if (
        autoQueue.length &&
        active &&
        !checking &&
        authenticated() &&
        !document.hidden
      )
        scheduleAuto();
    }
  }
  $("discover-form").addEventListener("submit", (event) => {
    event.preventDefault();
    load(1, { force: true });
  });
  $("discover-prev").addEventListener("click", () => load(page - 1));
  $("discover-next").addEventListener("click", () => load(page + 1));
  for (const id of ["discover-min", "discover-max", "discover-unknown"])
    $(id).addEventListener("input", () => render());
  $("discover-select-page").addEventListener("change", () => {
    let visible;
    try {
      visible = visibleItems();
    } catch (error) {
      notice("", UI.textError(error));
      return;
    }
    for (const item of visible)
      if ($("discover-select-page").checked) {
        if (selected.size >= 100 && !selected.has(String(item.id))) break;
        selected.set(String(item.id), item);
      } else selected.delete(String(item.id));
    render();
  });
  $("discover-clear").addEventListener("click", () => {
    selected.clear();
    render();
  });
  $("discover-check-selected").addEventListener("click", async () => {
    if (checking) return;
    checking = true;
    render();
    let done = 0,
      failed = 0;
    const current = version;
    for (const item of [...selected.values()]) {
      if (!active || !authenticated() || current !== version) break;
      try {
        await refresh(item);
        done++;
      } catch (error) {
        failed++;
        notice("", UI.textError(error));
      }
      notice(
        `${done}개 회차 확인${failed ? " · " + failed + "개 확인 실패" : ""}`,
      );
      render();
    }
    checking = false;
    render();
    scheduleAuto();
  });
  $("discover-add-selected").addEventListener("click", async () => {
    if (submitting || !selected.size) return;
    submitting = true;
    selectionState();
    try {
      const jobs = [...selected.values()].map((item) => ({
        url: item.url,
        title: item.title,
        format: $("discover-format").value,
        executor: "server",
        startAt: null,
        startEpisode: null,
        endEpisode: null,
        overwrite: false,
      }));
      const result = await UI.batch(jobs);
      const added = (result.jobs || []).length,
        skipped = (result.skipped || []).length;
      notice(`${added}개 대기 등록 · ${skipped}개 중복 건너뜀`);
      UI.toast(`${added}개 작품을 대기열에 추가했습니다.`);
      selected.clear();
    } catch (error) {
      notice("", UI.textError(error));
    } finally {
      submitting = false;
      render();
    }
  });
  document.addEventListener("collector:view", (event) => {
    active = event.detail === "discover";
    if (active) {
      sourceAutoPaused = false;
      if (interruptedPage !== null) load(interruptedPage);
      else load(page);
    } else {
      if (pendingLoad) {
        interruptedPage = pendingLoad.target;
        pendingLoad.controller.abort();
        pendingLoad = null;
        loading = false;
      }
      clearTimeout(refreshTimer); stopAuto();
    }
  });
  document.addEventListener("collector:work-popup",event=>{
    workPopup=event.detail===true;
    if(workPopup)stopAuto();else if(active)render();
  });
  document.addEventListener("collector:auth", () => {
    clearTimeout(refreshTimer); pageSnapshots.clear(); dataEpoch++;
    pendingLoad?.controller.abort();
    pendingLoad = null;
    interruptedPage = null;
    loading = false;
    pageIncomplete = false;
    active = false;
    stopAuto();
    selected.clear();
    known.clear();
    items = [];
    attempted.clear();
    pending.clear();
    renderedCards.clear();
    cardPool.clear();
    renderedIds = [];
    renderedLoadingCount = 0;
    $("discover-list").setAttribute("aria-busy", "false");
    $("discover-list").replaceChildren();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      sourceAutoPaused = true;
      stopAuto();
    } else if (active) render();
  });

  document.addEventListener("collector:mutated", event => {
    if (!/^\/api\/discover\/\d+\/(overview|refresh)$/.test(event.detail?.path || "")) return;
    dataEpoch++; for (const entry of pageSnapshots.values()) entry.dirty = true;
  });
  $("add-batch-button").addEventListener("click", () => {
    $("batch-error").textContent = "";
    $("batch-result").textContent = "";
    $("batch-dialog").showModal();
  });
  $("batch-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("batch-error").textContent = "";
    $("batch-result").textContent = "";
    $("batch-submit").disabled = true;
    try {
      const urls = $("batch-urls")
        .value.split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      if (!urls.length || urls.length > 100)
        throw new Error("작품 주소를 1개 이상, 최대 100개 입력하세요.");
      const range = (id) => {
        const value = $(id).value;
        if (!value) return null;
        const n = Number(value);
        if (!Number.isSafeInteger(n) || n < 0)
          throw new Error("회차는 0 이상의 정수로 입력하세요.");
        return n;
      };
      const startEpisode = range("batch-from"),
        endEpisode = range("batch-to");
      if (
        startEpisode !== null &&
        endEpisode !== null &&
        startEpisode > endEpisode
      )
        throw new Error("마지막 회차는 시작 회차보다 작을 수 없습니다.");
      const value = $("batch-schedule").value;
      const startAt = value
        ? new Date(
            `${value.length === 16 ? value + ":00" : value}+09:00`,
          ).toISOString()
        : null;
      const result = await UI.batch(
        urls.map((url) => ({
          url,
          format: $("batch-format").value,
          startEpisode,
          endEpisode,
          startAt,
          overwrite: $("batch-overwrite").checked,
          executor: "server",
        })),
      );
      $("batch-result").textContent =
        `${(result.jobs || []).length}개 대기 등록 · ${(result.skipped || []).length}개 중복 건너뜀`;
      for (const skipped of result.skipped || [])
        $("batch-result").append(
          UI.node("span", "batch-skip", `${skipped.url} · ${skipped.reason}`),
        );
      $("batch-urls").value = "";
    } catch (error) {
      $("batch-error").textContent =
        error instanceof RangeError
          ? "예약 시각을 확인하세요."
          : UI.textError(error);
    } finally {
      $("batch-submit").disabled = false;
    }
  });
  window.DiscoveryCatalog = {
    update(item) { metadata(item); render(); },
    select(item) {
      const id=String(item.id);
      if(selected.size>=100 && !selected.has(id)){notice("","한 번에 최대 100개 작품을 선택할 수 있습니다.");return;}
      metadata(item);selected.set(id,item);selectionState();render();
    },
  };
})();
