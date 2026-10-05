"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const cancelled = (stale = false) =>
    Object.assign(new Error("요청을 취소했습니다."), {
      name: "AbortError",
      cancelled: true,
      stale,
    });
  function createApi({ generation, onUnauthorized, onMutated }) {
    const reads = new Map();
    function abort(entry, stale = false) {
      entry.stale = stale;
      entry.controller.abort();
      if (reads.get(entry.key) === entry) reads.delete(entry.key);
    }
    function invalidate(reason = "stale") {
      for (const entry of reads.values()) abort(entry, reason !== "session");
    }
    async function result(response, entry, onProgress) {
      if (
        !response.ok ||
        !response.headers?.get("Content-Type")?.includes("application/x-ndjson")
      )
        return response.json().catch(() => null);
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "",
        data,
        completed = false;
      const line = (text) => {
        if (!text.trim()) return;
        let event;
        try {
          event = JSON.parse(text);
        } catch {
          throw new Error("목록 응답 형식이 올바르지 않습니다.");
        }
        if (event.type === "error")
          throw new Error(
            event.data?.error || "작품 목록을 불러오지 못했습니다.",
          );
        if (
          event.type === "progress" &&
          entry.generation === generation() &&
          !entry.controller.signal.aborted
        )
          onProgress?.(event.data);
        if (event.type === "result") {
          data = event.data;
          completed = true;
        }
      };
      try {
        while (true) {
          const chunk = await reader.read();
          buffer += decoder.decode(chunk.value, { stream: !chunk.done });
          if (buffer.length > 2 * 1024 * 1024)
            throw new Error("목록 응답 크기가 너무 큽니다.");
          let newline;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            line(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
          }
          if (chunk.done) break;
        }
        if (buffer) line(buffer);
        if (!completed)
          throw new Error("목록 전송이 중단됐습니다. 다시 검색해 주세요.");
        return data;
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    function subscribe(entry, signal) {
      entry.subscribers++;
      return new Promise((resolve, reject) => {
        let finished = false;
        const done = (callback, value) => {
          if (finished) return;
          finished = true;
          signal?.removeEventListener("abort", cancel);
          entry.controller.signal.removeEventListener("abort", sharedCancel);
          entry.subscribers--;
          callback(value);
          if (!entry.subscribers && !entry.settled) abort(entry);
        };
        const cancel = () => done(reject, cancelled());
        const sharedCancel = () =>
          done(
            reject,
            entry.timedOut
              ? new Error(
                  "서버 응답이 지연되고 있습니다. 잠시 후 다시 확인합니다.",
                )
              : cancelled(entry.stale),
          );
        signal?.addEventListener("abort", cancel, { once: true });
        entry.controller.signal.addEventListener("abort", sharedCancel, {
          once: true,
        });
        entry.promise.then(
          (value) => done(resolve, value),
          (error) => done(reject, error),
        );
        if (signal?.aborted) cancel();
        else if (entry.controller.signal.aborted) sharedCancel();
      });
    }
    async function run(path, options, timeoutMs, onProgress, entry, mutation) {
      const timer = setTimeout(() => {
        entry.timedOut = true;
        entry.controller.abort();
      }, timeoutMs);
      try {
        const response = await fetch(path, {
          credentials: "same-origin",
          cache: "no-store",
          ...options,
          signal: entry.controller.signal,
          headers: {
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...options.headers,
          },
        });
        const data = await result(response, entry, onProgress);
        if (
          entry.controller.signal.aborted ||
          entry.generation !== generation()
        )
          throw cancelled(entry.stale);
        if (!response.ok) {
          if (response.status === 401 && path !== "/api/login")
            onUnauthorized?.();
          throw new Error(data?.error || `서버 요청 실패 (${response.status})`);
        }
        if (mutation) {
          invalidate();
          onMutated?.(path);
        }
        return data;
      } catch (error) {
        if (entry.timedOut)
          throw new Error(
            "서버 응답이 지연되고 있습니다. 잠시 후 다시 확인합니다.",
          );
        if (
          entry.controller.signal.aborted ||
          entry.generation !== generation()
        )
          throw cancelled(entry.stale);
        if (error instanceof TypeError)
          throw new Error(
            "서버에 연결할 수 없습니다. 네트워크 연결을 확인하세요.",
          );
        throw error;
      } finally {
        clearTimeout(timer);
        entry.settled = true;
        if (reads.get(entry.key) === entry) reads.delete(entry.key);
      }
    }
    function request(path, options = {}, timeoutMs = 12000, onProgress = null) {
      if (options.signal?.aborted) return Promise.reject(cancelled());
      for (const entry of reads.values())
        if (entry.generation !== generation()) abort(entry);
      const method = (options.method || "GET").toUpperCase(),
        mutation = !["GET", "HEAD"].includes(method);
      const shared = !mutation && !onProgress && options.body == null;
      const headers = Object.entries(options.headers || {}).sort(([a], [b]) =>
        a.localeCompare(b),
      );
      const key = JSON.stringify([
        generation(),
        path,
        method,
        timeoutMs,
        headers,
      ]);
      let entry = shared ? reads.get(key) : null;
      if (entry && options.force) {
        abort(entry, true);
        entry = null;
      }
      if (!entry) {
        entry = {
          key,
          generation: generation(),
          controller: new AbortController(),
          subscribers: 0,
          settled: false,
          stale: false,
          timedOut: false,
        };
        const { signal, force, ...networkOptions } = options;
        entry.promise = run(
          path,
          networkOptions,
          timeoutMs,
          onProgress,
          entry,
          mutation,
        );
        if (shared) reads.set(key, entry);
      }
      return subscribe(entry, options.signal);
    }
    request.invalidate = invalidate;
    return request;
  }
  function renderSummary(state) {
    const finalStatuses = new Set([
      "completed",
      "completed_with_errors",
      "cancelled",
    ]);
    const jobs = state.jobs;
    const running = jobs.filter((job) => job.status === "running");
    const waiting = jobs.filter((job) => job.status === "queued");
    const runner = state.status.runner;
    const available =
      state.status.collector?.available !== false &&
      (typeof runner === "object"
        ? runner?.available !== false
        : runner !== false);
    const concurrency = Math.max(
      1,
      Math.min(2, number(state.status.maxConcurrency) || 2),
    );
    $("active-summary").textContent =
      `${count(running.length)} / ${concurrency}`;
    $("waiting-summary").textContent = count(waiting.length);
    $("saved-summary").textContent = count(
      jobs.reduce((sum, job) => sum + number(job.completed), 0),
    );
    $("runner-summary").textContent = state.status.queuePaused
      ? "전체 수집 일시정지 (자동 재개 없음)"
      : !available
        ? safeString(state.status.collector?.lastError || runner?.lastError) ||
          "서버 수집기 확인 필요"
        : state.status.backoff?.active
          ? "서버 요청 제한으로 대기 중"
          : running.length
            ? `${count(running.length)}개 작품 수집 중 · 최대 ${concurrency}개`
            : "다음 예약을 기다리고 있습니다";
    $("agent-summary").textContent = "서버";
    $("agent-note").textContent = "PC 없이 자동 실행";
    $("queue-start-all").disabled = state.queueActionBusy;
    $("queue-pause-all").disabled = state.queueActionBusy;
    $("queue-pause-all").setAttribute(
      "aria-pressed",
      String(Boolean(state.status.queuePaused)),
    );
    const queuedCount = jobs.filter(
      (job) => !finalStatuses.has(job.status),
    ).length;
    $("queue-badge").textContent = count(queuedCount);
    $("jobs-count").textContent = count(queuedCount);
    $("history-badge").textContent = count(
      jobs.filter((job) => finalStatuses.has(job.status)).length,
    );
    updateExecutorHelp();
    window.CollectorQueueUI?.renderBackoff(state.status, {
      node,
      count,
      date,
      safeString,
      number,
    });
  }

  function node(tag, className, value) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (value !== undefined && value !== null) el.textContent = String(value);
    return el;
  }
  function patchElement(previous, next) {
    if (
      previous.nodeType !== next.nodeType ||
      previous.nodeName !== next.nodeName ||
      previous.id !== next.id
    ) {
      previous.replaceWith(next);
      return next;
    }
    if (previous.nodeType === 3) {
      if (previous.nodeValue !== next.nodeValue)
        previous.nodeValue = next.nodeValue;
      return previous;
    }
    for (const attribute of [...previous.attributes])
      if (!next.hasAttribute(attribute.name))
        previous.removeAttribute(attribute.name);
    for (const attribute of next.attributes)
      if (previous.getAttribute(attribute.name) !== attribute.value)
        previous.setAttribute(attribute.name, attribute.value);
    const children = [...next.childNodes];
    for (const [index, child] of children.entries()) {
      if (previous.childNodes[index])
        patchElement(previous.childNodes[index], child);
      else previous.append(child);
    }
    while (previous.childNodes.length > children.length)
      previous.lastChild.remove();
    return previous;
  }
  function number(value) {
    return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  }
  function titleCover(element,value){
    const title=safeString(value).trim()||"제목 미확인";
    if(element.dataset.coverTitle===title)return;
    element.dataset.coverTitle=title;element.classList.add("cover-title");element.removeAttribute("aria-hidden");
    const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
    svg.setAttribute("viewBox","0 0 160 224");svg.setAttribute("role","img");svg.setAttribute("aria-label","대체 표지: "+title);
    const rect=document.createElementNS(svg.namespaceURI,"rect");rect.setAttribute("width","160");rect.setAttribute("height","224");rect.setAttribute("fill","#17212a");svg.append(rect);
    const characters=Array.from(title),lines=[];for(let index=0;index<characters.length&&lines.length<6;index+=8)lines.push(characters.slice(index,index+8).join(""));
    if(characters.length>48)lines[5]=lines[5].slice(0,7)+"…";
    for(const [index,line] of lines.entries()){
      const text=document.createElementNS(svg.namespaceURI,"text");text.setAttribute("x","80");text.setAttribute("y",String(106-(lines.length-1)*10+index*20));
      text.setAttribute("text-anchor","middle");text.setAttribute("font-family","system-ui, sans-serif");text.setAttribute("font-size","14");text.setAttribute("fill","#eceef4");text.textContent=line;svg.append(text);
    }
    const label=document.createElementNS(svg.namespaceURI,"text");label.setAttribute("x","80");label.setAttribute("y","204");label.setAttribute("text-anchor","middle");
    label.setAttribute("font-family","system-ui, sans-serif");label.setAttribute("font-size","10");label.setAttribute("fill","#929caf");label.textContent="대체 표지";svg.append(label);
    element.replaceChildren(svg);
  }
  function count(value) {
    return number(value).toLocaleString("ko-KR");
  }
  function safeString(value) {
    if (value === null || value === undefined) return "";
    return typeof value === "object"
      ? String(value.title || value.name || value.id || "")
      : String(value);
  }
  const dateFormat = new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Seoul",
    hour12: false,
  });
  const timeFormat = new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Seoul",
    hour12: false,
  });
  function date(value, timeOnly = false) {
    if (!value) return "—";
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return "—";
    return (timeOnly ? timeFormat : dateFormat).format(parsed);
  }
  function sourceNotice(value) {
    const text = safeString(value);
    return /일일\s*조회\s*인증|captcha_required_daily_quota/i.test(text)
      ? "CAPTCHA 확인 대기"
      : text;
  }
  function textError(error) {
    if (error?.cancelled) return "";
    return error instanceof Error
      ? error.message
      : "요청을 처리하지 못했습니다.";
  }
  function episodeInput(id) {
    const value = document.getElementById(id).value.trim();
    if (!value) return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0)
      throw new Error("회차는 0 이상의 정수로 입력하세요.");
    return parsed;
  }
  function updateExecutorHelp() {
    document.getElementById("executor-help").textContent =
      "서버에서 수집합니다. PC를 꺼도 예약이 실행됩니다.";
  }
  function safeURL(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" ? url.href : null;
    } catch {
      return null;
    }
  }
  function exportFormats(job) {
    const exports = job.exports;
    if (Array.isArray(exports))
      return ["txt", "epub"].filter((format) =>
        exports.some((item) => item === format || item?.format === format),
      );
    if (exports && typeof exports === "object")
      return ["txt", "epub"].filter((format) => Boolean(exports[format]));
    return [];
  }
  function reconcileCards(list, cards) {
    for (const [index, card] of cards.entries()) {
      if (list.children[index] !== card)
        list.insertBefore(card, list.children[index] || null);
    }
    const wanted = new Set(cards);
    for (const node of [...list.children]) if (!wanted.has(node)) node.remove();
  }

  const activeStatuses = new Set(["queued", "running", "paused"]);
  const finalStatuses = new Set([
    "completed",
    "completed_with_errors",
    "cancelled",
  ]);
  const attentionStatuses = new Set([
    "failed",
    "needs_attention",
    "completed_with_errors",
  ]);

  function filterJob(job, filter) {
    if (finalStatuses.has(job.status)) return false;
    if (filter === "active") return activeStatuses.has(job.status);
    if (filter === "attention") return attentionStatuses.has(job.status);
    return true;
  }

  function empty(title, message) {
    const wrapper = node("div", "empty-state");
    wrapper.append(node("strong", "", title), node("p", "", message));
    return wrapper;
  }

  const defaults = {
    refreshIntervalMs: 5000,
    libraryPageSize: 24,
    thumbnailFit: "contain",
    displayDensity: "comfortable",
  };
  let current = { ...defaults };
  function applyPreferences(settings = {}) {
    const next = { ...current };
    if (
      Number.isSafeInteger(settings.refreshIntervalMs) &&
      settings.refreshIntervalMs >= 2000 &&
      settings.refreshIntervalMs <= 30000
    )
      next.refreshIntervalMs = settings.refreshIntervalMs;
    if ([12, 24, 48, 96].includes(settings.libraryPageSize))
      next.libraryPageSize = settings.libraryPageSize;
    if (["contain", "cover"].includes(settings.thumbnailFit))
      next.thumbnailFit = settings.thumbnailFit;
    const density = settings.displayDensity ?? settings.density;
    if (["comfortable", "compact"].includes(density))
      next.displayDensity = density;
    document.documentElement.dataset.thumbnailFit = next.thumbnailFit;
    document.documentElement.dataset.density = next.displayDensity;
    const changed = JSON.stringify(next) !== JSON.stringify(current);
    current = next;
    if (changed)
      document.dispatchEvent(
        new CustomEvent("collector:preferences", { detail: { ...current } }),
      );
    return { ...current };
  }
  window.CollectorPerformance = {
    createApi,
    renderSummary,
    patchElement,
    safeURL,
    exportFormats,
    reconcileCards,
    filterJob,
    empty,
    node,
    titleCover,
    number,
    count,
    safeString,
    sourceNotice,
    date,
    textError,
    episodeInput,
    updateExecutorHelp,
    preferences: () => ({ ...current }),
    applyPreferences,
    debounce(fn, delay = 250) {
      let timer;
      const handler = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
      };
      handler.cancel = () => clearTimeout(timer);
      return handler;
    },
  };
  applyPreferences(defaults);
})();
