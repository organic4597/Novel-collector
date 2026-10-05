"use strict";
(() => {
  const UI = window.CollectorUI,
    $ = (id) => document.getElementById(id);
  let signature = "",
    preference = "true",
    version = 0,
    request = null,
    renderedId = null,
    rows = new Map(),
    errorRow = null;
  try {
    preference = localStorage.getItem("collector.logsCollapsed") || "true";
  } catch {
    /* Preferences remain optional. */
  }
  function visible() {
    return UI.authenticated() && !document.hidden && !$("events-panel").hidden;
  }
  function live(task) {
    return (
      visible() &&
      task.generation === UI.generation() &&
      task.id === UI.selectedJob() &&
      task.version === version
    );
  }
  function stop() {
    version++;
    request?.controller.abort();
    request = null;
  }
  function setOpen(open, persist = true) {
    if (!open) stop();
    $("events-panel").hidden = !open;
    $("app-view").classList.toggle("logs-open", open);
    $("logs-toggle").setAttribute("aria-expanded", String(open));
    $("logs-toggle").textContent = open ? "로그 접기" : "수집 로그";
    if (persist)
      try {
        localStorage.setItem("collector.logsCollapsed", String(!open));
      } catch {
        /* Preferences remain optional. */
      }
  }
  function eventRow(event) {
    const level = ["info", "warn", "error", "debug"].includes(event.level)
      ? event.level
      : "info";
    const row = UI.node("div", `event-row ${level}`);
    row.append(
      UI.node(
        "span",
        "event-time",
        UI.date(
          event.time || event.at || event.timestamp || event.createdAt,
          true,
        ),
      ),
      UI.node("span", "event-level", level.toUpperCase()),
      UI.node("span", "event-message", UI.sourceNotice(event.message)),
    );
    return row;
  }
  function render(list) {
    errorRow?.remove();
    errorRow = null;
    const next = JSON.stringify([renderedId, list]);
    if (next === signature) return;
    signature = next;
    const panel = $("events-list"),
      scroll = panel.scrollTop,
      atBottom = panel.scrollHeight - scroll - panel.clientHeight < 50,
      seen = new Map(),
      desired = [],
      retained = new Map();
    for (const event of list) {
      const value = JSON.stringify(event),
        occurrence = seen.get(value) || 0;
      seen.set(value, occurrence + 1);
      const key = `${value}:${occurrence}`,
        row = rows.get(key) || eventRow(event);
      retained.set(key, row);
      desired.push(row);
    }
    if (!desired.length)
      desired.push(
        rows.get("empty") ||
          UI.node("p", "muted", "아직 수집 로그가 없습니다."),
      );
    for (const [index, row] of desired.entries())
      if (panel.children[index] !== row)
        panel.insertBefore(row, panel.children[index] || null);
    const keep = new Set(desired);
    for (const row of [...panel.children]) if (!keep.has(row)) row.remove();
    rows = retained;
    if (!list.length) rows.set("empty", desired[0]);
    panel.scrollTop = atBottom ? panel.scrollHeight : scroll;
  }
  async function fetchEvents(task) {
    try {
      const events = await UI.api(
        `/api/jobs/${encodeURIComponent(task.id)}/events`,
        { signal: task.controller.signal },
      );
      if (live(task)) render(Array.isArray(events) ? events : []);
    } catch (error) {
      if (!live(task) || task.controller.signal.aborted || error.cancelled)
        return;
      errorRow?.remove();
      errorRow = UI.node("p", "error-text", UI.textError(error));
      $("events-list").prepend(errorRow);
    } finally {
      if (request?.version === task.version) request = null;
    }
  }
  function refresh() {
    const id = UI.selectedJob(),
      generation = UI.generation();
    if (!id || !visible()) return Promise.resolve();
    if (request?.id === id && request.generation === generation)
      return request.promise;
    stop();
    const task = { id, generation, version, controller: new AbortController() },
      promise = fetchEvents(task);
    request = { ...task, promise };
    return promise;
  }
  function open(job) {
    UI.selectJob(job.id);
    if (renderedId !== job.id) {
      stop();
      renderedId = job.id;
      signature = "";
      rows = new Map();
      errorRow = null;
      $("events-list").replaceChildren(
        UI.node("p", "muted", "로그를 불러오는 중…"),
      );
    }
    $("events-title").textContent = `${job.title || "작품"} · 수집 로그`;
    setOpen(true);
    return refresh();
  }
  function close() {
    setOpen(false);
  }
  $("close-events").addEventListener("click", close);
  $("logs-toggle").addEventListener("click", () => {
    const opening = $("events-panel").hidden;
    setOpen(opening);
    if (opening) {
      if (UI.selectedJob()) refresh();
      else
        $("events-list").replaceChildren(
          UI.node("p", "muted", "예약 또는 수집 기록에서 로그를 선택하세요."),
        );
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else refresh();
  });
  document.addEventListener("collector:auth", (event) => {
    if (!event.detail) {
      setOpen(false, false);
      renderedId = null;
      signature = "";
      rows = new Map();
      errorRow = null;
      $("events-list").replaceChildren();
      $("events-title").textContent = "수집 로그";
    }
  });
  setOpen(preference === "false", false);
  if (preference === "false")
    $("events-list").replaceChildren(
      UI.node("p", "muted", "예약 또는 수집 기록에서 로그를 선택하세요."),
    );
  window.CollectorLogs = { open, close, refresh };
})();
