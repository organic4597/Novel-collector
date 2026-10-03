"use strict";
(() => {
  const UI = window.CollectorUI,
    $ = (id) => document.getElementById(id);
  let signature = "",
    preference = "true",
    refreshing = false;
  try {
    preference = localStorage.getItem("collector.logsCollapsed") || "true";
  } catch {
    /* Preferences remain optional. */
  }
  function setOpen(open, persist = true) {
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
  async function refresh() {
    const id = UI.selectedJob(),
      generation = UI.generation();
    if (
      !id ||
      $("events-panel").hidden ||
      !UI.authenticated() ||
      document.hidden ||
      refreshing
    )
      return;
    refreshing = true;
    try {
      const events = await UI.api(`/api/jobs/${encodeURIComponent(id)}/events`);
      if (
        generation !== UI.generation() ||
        id !== UI.selectedJob() ||
        $("events-panel").hidden
      )
        return;
      const list = Array.isArray(events) ? events : [];
      const next = JSON.stringify(list);
      if (next === signature) return;
      signature = next;
      const panel = $("events-list"),
        atBottom =
          panel.scrollHeight - panel.scrollTop - panel.clientHeight < 50;
      const fragment = document.createDocumentFragment();
      if (!list.length)
        fragment.append(UI.node("p", "muted", "아직 수집 로그가 없습니다."));
      for (const event of list) {
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
        fragment.append(row);
      }
      panel.replaceChildren(fragment);
      if (atBottom) panel.scrollTop = panel.scrollHeight;
    } finally {
      refreshing = false;
    }
  }
  async function open(job) {
    UI.selectJob(job.id);
    signature = "";
    $("events-title").textContent = `${job.title || "작품"} · 수집 로그`;
    $("events-list").replaceChildren(
      UI.node("p", "muted", "로그를 불러오는 중…"),
    );
    setOpen(true);
    try {
      await refresh();
    } catch (error) {
      UI.error(UI.textError(error));
    }
  }
  function close() {
    setOpen(false);
  }
  $("close-events").addEventListener("click", close);
  $("logs-toggle").addEventListener("click", () => {
    const opening = $("events-panel").hidden;
    setOpen(opening);
    if (opening) {
      if (UI.selectedJob())
        refresh().catch((error) => UI.error(UI.textError(error)));
      else
        $("events-list").replaceChildren(
          UI.node("p", "muted", "예약 또는 수집 기록에서 로그를 선택하세요."),
        );
    }
  });
  document.addEventListener("collector:auth", (event) => {
    if (!event.detail) setOpen(false, false);
  });
  setOpen(preference === "false", false);
  if (preference === "false")
    $("events-list").replaceChildren(
      UI.node("p", "muted", "예약 또는 수집 기록에서 로그를 선택하세요."),
    );
  window.CollectorLogs = { open, close, refresh };
})();
