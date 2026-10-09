"use strict";
(() => {
  const key = "collector.theme";
  const root = document.documentElement;
  const icons = {
    light: '<path d="M20.5 13a8.5 8.5 0 0 1-9.5-9.5A8.5 8.5 0 1 0 20.5 13Z"/>',
    dark: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  };
  function apply(value) {
    const mode = value === "dark" ? "dark" : "light";
    root.dataset.theme = mode;
    for (const button of document.querySelectorAll("[data-theme-toggle]")) {
      const label = mode === "dark" ? "라이트 모드로 전환" : "다크 모드로 전환";
      button.setAttribute("aria-pressed", String(mode === "dark"));
      button.setAttribute("aria-label", label);
      button.title = label;
      button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[mode]}</svg><span class="sr-only">${label}</span>`;
    }
  }
  let saved;
  try {
    saved = localStorage.getItem(key);
  } catch {
    // Theme selection still works when browser storage is unavailable.
  }
  apply(saved);
  function connect() {
    apply(root.dataset.theme);
    for (const button of document.querySelectorAll("[data-theme-toggle]"))
      button.addEventListener("click", () => {
        apply(root.dataset.theme === "dark" ? "light" : "dark");
        try {
          localStorage.setItem(key, root.dataset.theme);
        } catch {
          // Keep the chosen appearance for this page.
        }
      });
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", connect, { once: true });
  else connect();
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) apply(event.newValue);
  });
})();
