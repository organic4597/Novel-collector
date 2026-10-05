"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  authenticated: false,
  view: "queue",
  filter: "all",
  historyFilter: "all",
  jobs: [],
  status: {},
  selectedJob: null,
  timer: null,
  polling: false,
  refreshRequested: false,
  queueActionBusy: false,
  generation: 0,
  booksFetchedAt: 0,
  jobSignature: "",
  cardCache: new Map(),
  pendingActions: new Set(),
};
const statuses = {
  queued: "대기 중",
  running: "수집 중",
  paused: "일시 중지",
  needs_attention: "확인 필요",
  completed: "완료",
  completed_with_errors: "일부 실패",
  failed: "실패",
  cancelled: "취소됨",
};
const { phases, actionRules } = window.CollectorQueueUI;
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

const {
  node,
  number,
  count,
  safeString,
  sourceNotice,
  date,
  textError,
  episodeInput,
} = window.CollectorPerformance;
const updateExecutorHelp = window.CollectorPerformance.updateExecutorHelp;
function errorNotice(message = "") {
  $("global-error").textContent = message;
  $("global-error").hidden = !message;
}
let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 3500);
}
async function api(path, options = {}, timeoutMs = 12000, onProgress = null) {
  const authGeneration = state.generation;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
    let data;
    if (response.ok && response.headers?.get("Content-Type")?.includes("application/x-ndjson")) {
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "", completed = false;
      const line = text => {
        if (!text.trim()) return;
        let event;
        try { event = JSON.parse(text); } catch { throw new Error("목록 응답 형식이 올바르지 않습니다."); }
        if (event.type === "error") throw new Error(event.data?.error || "작품 목록을 불러오지 못했습니다.");
        if (event.type === "progress" && authGeneration === state.generation) onProgress?.(event.data);
        if (event.type === "result") { data = event.data; completed = true; }
      };
      try {
        while (true) {
          const chunk = await reader.read();
          buffer += decoder.decode(chunk.value, { stream: !chunk.done });
          if (buffer.length > 2 * 1024 * 1024) throw new Error("목록 응답 크기가 너무 큽니다.");
          let newline;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            line(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
          }
          if (chunk.done) break;
        }
        if (buffer) line(buffer);
        if (!completed) throw new Error("목록 전송이 중단됐습니다. 다시 검색해 주세요.");
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } else data = await response.json().catch(() => null);
    if (!response.ok) {
      if (
        response.status === 401 &&
        path !== "/api/login" &&
        authGeneration === state.generation
      )
        showLogin();
      throw new Error(data?.error || `서버 요청 실패 (${response.status})`);
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError")
      throw new Error(
        "서버 응답이 지연되고 있습니다. 잠시 후 다시 확인합니다.",
      );
    if (error instanceof TypeError)
      throw new Error("서버에 연결할 수 없습니다. 네트워크 연결을 확인하세요.");
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
  }
}

function showLogin() {
  state.authenticated = false;
  state.generation += 1;
  state.cardCache.clear();
  clearTimeout(state.timer);
  $("app-view").hidden = true;
  $("login-view").hidden = false;
  for (const dialog of document.querySelectorAll("dialog[open]"))
    dialog.close();
  document.dispatchEvent(new CustomEvent("collector:auth", { detail: false }));
}
function showApp() {
  state.authenticated = true;
  state.generation += 1;
  state.jobSignature = "";
  state.cardCache.clear();
  state.booksFetchedAt = 0;
  $("login-view").hidden = true;
  $("app-view").hidden = false;
  $("login-password").value = "";
  errorNotice();
  document.dispatchEvent(new CustomEvent("collector:auth", { detail: true }));
  poll();
}
function connection(ok, message) {
  $("connection-dot").className = `status-dot ${ok ? "connected" : "error"}`;
  $("connection-label").textContent = message;
  if (ok)
    $("last-refresh").textContent =
      `${date(new Date().toISOString(), true)} 갱신`;
}
async function poll() {
  clearTimeout(state.timer);
  if (!state.authenticated || document.hidden || state.polling) return;
  state.polling = true;
  state.refreshRequested = false;
  const generation = state.generation;
  try {
    const results = await Promise.allSettled([
      api("/api/status"),
      api("/api/jobs"),
    ]);
    if (
      generation !== state.generation ||
      !state.authenticated ||
      document.hidden
    )
      return;
    const failure = results.find((result) => result.status === "rejected");
    if (results[0].status === "fulfilled")
      state.status = results[0].value || {};
    if (results[1].status === "fulfilled")
      state.jobs = Array.isArray(results[1].value) ? results[1].value : [];
    if (results[1].status === "fulfilled" && state.selectedJob && !state.jobs.some(job => job.id === state.selectedJob)) {
      state.selectedJob = null;
      window.CollectorLogs?.close();
    }
    renderSummary();
    if (["queue", "history"].includes(state.view)) renderJobs();
    if (failure) throw failure.reason;
    connection(
      true,
      state.status.queuePaused
        ? "서버 연결됨 · 전체 일시정지"
        : state.status.backoff?.active
          ? "서버 연결됨 · 요청 대기 중"
          : "서버 연결됨 · 수집 예약 실행 중",
    );
    errorNotice();
    document.dispatchEvent(
      new CustomEvent("collector:status", { detail: { ...state.status } }),
    );
    if (state.selectedJob && !document.hidden)
      loadEvents(state.selectedJob, generation).catch(() => {});
    if (
      state.view === "library" &&
      !$("captcha-session-dialog").open &&
      (!state.booksFetchedAt ||
        Date.now() - state.booksFetchedAt >
          Math.max(8000, window.CollectorUI.preferences().refreshIntervalMs))
    ) {
      loadBooks(generation).catch(error => errorNotice(textError(error)));
    }
  } catch (error) {
    if (generation === state.generation && state.authenticated) {
      connection(false, "연결 확인 필요");
      errorNotice(textError(error));
    }
  } finally {
    state.polling = false;
    if (state.authenticated && !document.hidden)
      state.timer = setTimeout(
        poll,
        state.refreshRequested
          ? 0
          : $("captcha-session-dialog").open ? Math.max(10000, window.CollectorUI.preferences().refreshIntervalMs)
          : window.CollectorUI.preferences().refreshIntervalMs,
      );
  }
}

function renderSummary() {
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
  $("active-summary").textContent = `${count(running.length)} / ${concurrency}`;
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

function empty(title, message) {
  const wrapper = node("div", "empty-state");
  wrapper.append(node("strong", "", title), node("p", "", message));
  return wrapper;
}
function filterJob(job) {
  if (finalStatuses.has(job.status)) return false;
  if (state.filter === "active") return activeStatuses.has(job.status);
  if (state.filter === "attention") return attentionStatuses.has(job.status);
  return true;
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
function renderJobs() {
  if (!["queue", "history"].includes(state.view) || document.hidden) return;
  const signature = JSON.stringify([
    state.jobs,
    state.filter,
    state.historyFilter,
    [...state.pendingActions],
    state.selectedJob,
    Boolean(state.status.backoff?.active),
    state.view,
  ]);
  if (signature === state.jobSignature) return;
  state.jobSignature = signature;
  const focusId =
    $("jobs-list").contains(document.activeElement) ||
    $("history-list").contains(document.activeElement)
      ? document.activeElement.id
      : null;
  const visible = state.jobs.filter(filterJob);
  const fragment = document.createDocumentFragment();
  const queued = state.jobs.filter((job) => job.status === "queued");
  if (!visible.length)
    fragment.append(
      empty(
        state.jobs.length
          ? "이 상태의 예약이 없습니다"
          : "첫 작품을 예약해 보세요",
        "작품 주소를 추가하면 서버가 차례대로 본문을 저장합니다.",
      ),
    );
  if (state.view === "queue") {
    const cards = visible.map(job => cachedCard(job, queued));
    if (!cards.length) $("jobs-list").replaceChildren(fragment);
    else reconcileCards($("jobs-list"), cards);
  }
  const history = state.jobs.filter((job) => {
    if (state.historyFilter === "failed") return job.status === "failed";
    if (!finalStatuses.has(job.status)) return false;
    return (
      state.historyFilter === "all" ||
      job.status ===
        (state.historyFilter === "errors"
          ? "completed_with_errors"
          : state.historyFilter)
    );
  });
  $("history-count").textContent = count(history.length);
  if (state.view === "history")
    reconcileCards($("history-list"),
      (history.length
        ? [...history].reverse().map((job) => cachedCard(job, queued, true))
        : [
            empty(
              "수집 기록이 없습니다",
              "완료·취소한 예약은 이곳에 표시됩니다.",
            ),
          ]),
    );
  if (focusId) $(focusId)?.focus({ preventScroll: true });
}
function reconcileCards(list, cards) {
  for (const [index, card] of cards.entries()) {
    if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
  }
  const wanted = new Set(cards);
  for (const node of [...list.children]) if (!wanted.has(node)) node.remove();
}
function cachedCard(job, queued, history = false) {
  const key = `${history ? "history" : "queue"}:${job.id}`;
  const signature = JSON.stringify([job, state.selectedJob === job.id, state.pendingActions.has(job.id),
    state.status.backoff?.active, queued.findIndex(item => item.id === job.id),
    (state.status.siteAttention || []).map(s => [s.host, s.kind])]);
  const cached = state.cardCache.get(key);
  if (cached?.signature === signature) return cached.node;
  const node = jobCard(job, queued, history);
  state.cardCache.set(key, { signature, node });
  if (state.cardCache.size > 400) state.cardCache.delete(state.cardCache.keys().next().value);
  return node;
}
function jobCard(job, queued, inHistory = false) {
  const captchaPending =
    job.status === "needs_attention" &&
    (sourceNotice(job.error) !== safeString(job.error) ||
      (state.status.siteAttention || []).some((site) => {
        try {
          return (
            site.kind === "captcha" && site.host === new URL(job.url).hostname
          );
        } catch {
          return false;
        }
      }));
  const card = node(
    "article",
    `job-card ${job.status === "running" ? "running" : ""}`,
  );
  if (job.deleting) card.setAttribute("aria-busy", "true");
  const top = node("div", "job-top");
  const identity = node("div", "job-identity");
  const ordinal =
    job.status === "running"
      ? "▶"
      : job.status === "queued"
        ? queued.findIndex((entry) => entry.id === job.id) + 1
        : "▤";
  const title = node("div");
  title.append(node("h3", "job-title", job.title || "제목 확인 대기"));
  const url = safeURL(job.url);
  const link = node(url ? "a" : "span", "job-url", job.url || "");
  if (url) {
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  title.append(link);
  identity.append(node("span", "job-order", ordinal), title);
  top.append(
    identity,
    node(
      "span",
      `status-pill ${captchaPending ? "queued" : job.status}`,
      captchaPending
        ? "CAPTCHA 대기"
        : statuses[job.status] || safeString(job.status),
    ),
  );
  const tags = node("div", "job-tags");
  const range = `${job.startEpisode ?? "처음"} → ${job.endEpisode ?? "끝"} 회차`;
  for (const value of [
    job.executor === "browser" ? "PC 브라우저" : "서버 실행",
    (job.format || "txt").toUpperCase(),
    range,
    job.startAt ? `예약 ${date(job.startAt)}` : "순서대로 바로 실행",
  ])
    tags.append(node("span", "", value));
  const total = number(job.total);
  const done = number(job.completed) + number(job.skipped);
  const settled = done + number(job.failed);
  const percent = total > 0 ? Math.min(100, (settled / total) * 100) : 0;
  const percentLabel =
    percent > 0 && percent < 0.1 ? "<0.1%" : `${percent.toFixed(1)}%`;
  const progressHead = node("div", "job-progress-head");
  progressHead.append(
    node(
      "span",
      "job-phase",
      captchaPending
        ? "CAPTCHA 확인 대기"
        : phases[job.phase] || sourceNotice(job.phase) || statuses[job.status],
    ),
    node("span", "job-percent", percentLabel),
  );
  const track = node("div", "progress-track");
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-label", `${job.title || "작품"} 수집 진행률`);
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", percent.toFixed(1));
  const fill = node("div", "progress-fill");
  fill.style.width = `${percent}%`;
  track.append(fill);
  const detail = node("div", "job-detail");
  for (const value of [
    `저장 ${count(done)} / ${count(total)}`,
    `새 회차 ${count(job.completed)}`,
    `기존 회차 ${count(job.skipped)}`,
    `실패 ${count(job.failed)}`,
  ])
    detail.append(node("span", "", value));
  card.append(top, tags, progressHead, track, detail);
  if (job.captcha?.active) card.append(node("p", "job-current",
    `자동 CAPTCHA ${job.captcha.attempt}/${job.captcha.maxAttempts} · ${job.captcha.stage} · 예상 시간 갱신 중`));
  if (job.status === "running") {
    const seconds = Number(job.estimatedSecondsRemaining);
    const estimated =
      job.timing?.confidence === "low" || number(job.timing?.samples) < 3;
    const duration =
      Number.isFinite(seconds) && job.estimatedSecondsRemaining != null
        ? `${seconds >= 3600 ? Math.floor(seconds / 3600) + "시간 " : ""}${Math.floor((seconds % 3600) / 60)}분 ${Math.round(seconds % 60)}초`
        : null;
    card.append(
      node(
        "p",
        "job-eta",
        state.status.backoff?.active
          ? "예상 완료 시각은 요청 대기 후 다시 계산합니다."
          : duration
            ? `${estimated ? "추정 · " : "예상 · "}남은 시간 ${duration}${job.estimatedCompletionAt ? " · 완료 " + date(job.estimatedCompletionAt) : ""}`
            : "남은 시간 계산 중",
      ),
    );
  }
  const chapter = safeString(job.currentChapter);
  if (chapter) card.append(node("p", "job-current", `현재 회차 · ${chapter}`));
  if (job.error)
    card.append(
      node(
        "p",
        captchaPending ? "muted" : "job-error",
        captchaPending ? "CAPTCHA 확인 대기" : sourceNotice(job.error),
      ),
    );
  const footer = node("div", "job-footer");
  footer.append(
    node(
      "span",
      "job-activity",
      `최근 활동 ${date(job.lastActivity || job.updatedAt)}`,
    ),
  );
  const actions = node("div", "job-actions");
  const logs = node(
    "button",
    "quiet",
    state.selectedJob === job.id ? "로그 보는 중" : "로그",
  );
  logs.id = `${inHistory && job.status === "failed" ? "history-" : ""}logs-${job.id}`;
  logs.addEventListener("click", () => openEvents(job));
  actions.append(logs);
  for (const [action, label] of actionRules[job.status] || []) {
    if (captchaPending && ["resume", "retry"].includes(action)) continue;
    const button = node(
      "button",
      action === "cancel" ? "danger" : "secondary",
      label,
    );
    button.id = `${inHistory && job.status === "failed" ? "history-" : ""}${action}-${job.id}`;
    button.disabled = state.pendingActions.has(job.id) || job.deleting === true;
    button.addEventListener("click", () => jobAction(job, action));
    actions.append(button);
  }
  for (const format of exportFormats(job)) {
    const download = node("a", "export-link", `${format.toUpperCase()} 받기`);
    download.href = `/api/jobs/${encodeURIComponent(job.id)}/export/${format}`;
    download.setAttribute("download", "");
    actions.append(download);
  }
  if (
    ["failed", "completed_with_errors"].includes(job.status) &&
    (number(job.failed) > 0 || job.failedChapters?.length)
  ) {
    const retry = node("button", "secondary", "실패 회차 재수집");
    retry.id = `${inHistory && job.status === "failed" ? "history-" : ""}retry-failed-${job.id}`;
    retry.disabled = state.pendingActions.has(job.id) || job.deleting === true;
    retry.addEventListener("click", () =>
      window.CollectorLibrary.retryJob(job),
    );
    actions.append(retry);
  }
  {
    const remove = node("button", "danger", job.deleting ? "삭제 중…" : inHistory ? "기록 삭제" : "예약 삭제");
    remove.id = `delete-${job.id}`;
    remove.disabled = state.pendingActions.has(job.id) || job.deleting === true;
    remove.addEventListener("click", () => deleteRecord(job));
    actions.append(remove);
  }
  footer.append(actions);
  card.append(footer);
  return card;
}
async function jobAction(job, action) {
  if (state.pendingActions.has(job.id)) return;
  state.pendingActions.add(job.id);
  renderJobs();
  try {
    const updated = await api(
      `/api/jobs/${encodeURIComponent(job.id)}/action`,
      { method: "POST", body: JSON.stringify({ action }) },
    );
    state.jobs = state.jobs.map((entry) =>
      entry.id === job.id ? updated : entry,
    );
    toast(
      action === "pause"
        ? "일시 중지를 요청했습니다. 저장한 회차는 유지됩니다."
        : action === "cancel"
          ? "예약을 취소했습니다. 저장한 회차는 유지됩니다."
          : "수집 대기열에 추가했습니다.",
    );
    renderSummary();
  } catch (error) {
    errorNotice(textError(error));
  } finally {
    state.pendingActions.delete(job.id);
    renderJobs();
  }
}
async function deleteRecord(job) {
  if (state.pendingActions.has(job.id)) return;
  state.pendingActions.add(job.id);
  renderJobs();
  try {
    const result = await api(`/api/jobs/${encodeURIComponent(job.id)}`, { method: "DELETE" });
    if (result?.pending) {
      state.jobs = state.jobs.map(entry => entry.id === job.id ? { ...entry, status: "cancelled", deleting: true, phase: "예약 삭제 중" } : entry);
      state.refreshRequested = true;
      toast("수집 종료를 기다린 뒤 예약을 삭제합니다. 저장한 본문은 유지됩니다.");
      renderSummary();
      return;
    }
    state.jobs = state.jobs.filter((entry) => entry.id !== job.id);
    if (state.selectedJob === job.id) {
      state.selectedJob = null;
      window.CollectorLogs?.close();
    }
    renderSummary();
    toast("예약과 기록을 삭제했습니다. 보관함의 본문은 유지됩니다.");
  } catch (error) {
    errorNotice(textError(error));
  } finally {
    state.pendingActions.delete(job.id);
    renderJobs();
  }
}
function openEvents(job) {
  return window.CollectorLogs.open(job);
}
async function loadEvents() {
  return window.CollectorLogs.refresh();
}
async function loadBooks() {
  await window.CollectorLibrary.refresh();
  state.booksFetchedAt = Date.now();
}
function switchView(view) {
  state.view = view;
  for (const id of ["queue", "library", "history", "discover", "settings", "activity", "presets"])
    $(`${id}-view`).hidden = view !== id;
  for (const button of document.querySelectorAll("[data-view]")) {
    const selected = button.dataset.view === view;
    button.classList.toggle("selected", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (view === "library")
    loadBooks().catch((error) => errorNotice(textError(error)));
  if (["queue", "history"].includes(view)) renderJobs();
  document.dispatchEvent(new CustomEvent("collector:view", { detail: view }));
}
window.CollectorUI = {
  navigate: switchView,
  refresh: poll,
  api,
  node,
  count,
  date,
  toast,
  empty,
  textError,
  sourceNotice,
  authenticated: () => state.authenticated,
  generation: () => state.generation,
  view: () => state.view,
  status: () => ({ ...state.status }),
  preferences: window.CollectorPerformance.preferences,
  applyPreferences: window.CollectorPerformance.applyPreferences,
  defaults: { defaultFormat: "txt" },
  selectedJob: () => state.selectedJob,
  selectJob(id) {
    state.selectedJob = id;
    renderJobs();
  },
  job(id) {
    return state.jobs.find((job) => job.id === id);
  },
  addJob(job) {
    state.jobs = state.jobs.some((item) => item.id === job.id)
      ? state.jobs.map((item) => (item.id === job.id ? job : item))
      : [...state.jobs, job];
    renderSummary();
    renderJobs();
  },
  error: errorNotice,
  async batch(jobs) {
    const result = await api("/api/jobs/batch", {
      method: "POST",
      body: JSON.stringify({ jobs }),
    });
    state.jobs = [...state.jobs, ...(result.jobs || [])];
    renderSummary();
    renderJobs();
    return result;
  },
};
async function queueAction(action) {
  if (state.queueActionBusy) return;
  state.queueActionBusy = true;
  renderSummary();
  try {
    const result = await api(`/api/queue/${action}`, {
      method: "POST",
      body: "{}",
    });
    toast(
      `${action === "pause" ? "전체 수집을 일시정지했습니다" : "전체 수집을 시작했습니다"} · ${count(result.affected)}개 예약`,
    );
    state.refreshRequested = true;
    await poll();
  } catch (error) {
    errorNotice(textError(error));
  } finally {
    state.queueActionBusy = false;
    renderSummary();
  }
}
$("queue-start-all").addEventListener("click", () => queueAction("start"));
$("queue-pause-all").addEventListener("click", () => queueAction("pause"));

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  $("login-error").textContent = "";
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: $("login-password").value }),
    });
    showApp();
  } catch (error) {
    $("login-error").textContent = textError(error);
  } finally {
    button.disabled = false;
  }
});
$("logout-button").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
    showLogin();
  } catch (error) {
    errorNotice(textError(error));
  }
});
for (const button of document.querySelectorAll("[data-view]"))
  button.addEventListener("click", () => switchView(button.dataset.view));
for (const button of document.querySelectorAll("[data-filter]"))
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    for (const filter of document.querySelectorAll("[data-filter]")) {
      const selected = filter === button;
      filter.classList.toggle("selected", selected);
      filter.setAttribute("aria-pressed", String(selected));
    }
    renderJobs();
  });
for (const button of document.querySelectorAll("[data-history-filter]"))
  button.addEventListener("click", () => {
    state.historyFilter = button.dataset.historyFilter;
    for (const filter of document.querySelectorAll("[data-history-filter]")) {
      filter.classList.toggle("selected", filter === button);
      filter.setAttribute("aria-pressed", String(filter === button));
    }
    renderJobs();
  });
for (const button of document.querySelectorAll("[data-close]"))
  button.addEventListener("click", () => $(button.dataset.close).close());
$("add-job-button").addEventListener("click", () => {
  $("job-error").textContent = "";
  updateExecutorHelp();
  $("job-format").value = window.CollectorUI.defaults.defaultFormat;
  $("job-dialog").showModal();
});
$("job-executor").addEventListener("change", updateExecutorHelp);
$("job-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("job-error").textContent = "";
  $("job-submit").disabled = true;
  try {
    const startEpisode = episodeInput("job-from");
    const endEpisode = episodeInput("job-to");
    if (
      startEpisode !== null &&
      endEpisode !== null &&
      endEpisode < startEpisode
    )
      throw new Error("마지막 회차는 시작 회차보다 작을 수 없습니다.");
    const schedule = $("job-schedule").value;
    const startAt = schedule
      ? new Date(
          `${schedule.length === 16 ? `${schedule}:00` : schedule}+09:00`,
        ).toISOString()
      : null;
    const body = {
      url: $("job-url").value.trim(),
      title: $("job-title").value.trim(),
      startEpisode,
      endEpisode,
      startAt,
      format: $("job-format").value,
      executor: "server",
      overwrite: $("job-overwrite").checked,
    };
    const job = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.jobs = [...state.jobs, job];
    renderSummary();
    renderJobs();
    $("job-dialog").close();
    event.target.reset();
    toast("수집 예약을 추가했습니다.");
    switchView("queue");
  } catch (error) {
    $("job-error").textContent =
      error instanceof RangeError
        ? "예약 시각을 확인하세요."
        : textError(error);
  } finally {
    $("job-submit").disabled = false;
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(state.timer);
  else if (state.authenticated) poll();
});
document.addEventListener("collector:preferences", () => {
  clearTimeout(state.timer);
  if (state.authenticated && !document.hidden && !state.polling)
    state.timer = setTimeout(
      poll,
      window.CollectorUI.preferences().refreshIntervalMs,
    );
});
window.addEventListener("focus", () => {
  if (state.authenticated && !document.hidden) {
    state.refreshRequested = true;
    poll();
  }
});
window.addEventListener("online", () => {
  if (state.authenticated) poll();
});
const sessionGeneration = state.generation;
api("/api/session")
  .then((session) => {
    if (sessionGeneration !== state.generation) return;
    if (session?.authenticated) showApp();
    else showLogin();
  })
  .catch((error) => {
    if (sessionGeneration !== state.generation) return;
    showLogin();
    $("login-error").textContent = textError(error);
  });
