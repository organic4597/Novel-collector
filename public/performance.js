"use strict";
(() => {
  function node(tag, className, value) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (value !== undefined && value !== null) el.textContent = String(value);
    return el;
  }
  function number(value) {
    return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
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
  function date(value, timeOnly = false) {
    if (!value) return "—";
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return "—";
    const options = timeOnly
      ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
      : {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        };
    return parsed.toLocaleString("ko-KR", {
      ...options,
      timeZone: "Asia/Seoul",
      hour12: false,
    });
  }
  function sourceNotice(value) {
    const text = safeString(value);
    return /일일\s*조회\s*인증|captcha_required_daily_quota/i.test(text)
      ? "CAPTCHA 확인 대기"
      : text;
  }
  function textError(error) {
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
    node,
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
