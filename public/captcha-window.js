"use strict";
(() => {
  let standaloneOpened = false;
  function showTestConnection() {
    const label = document.getElementById("captcha-session-network");
    if (!label) return;
    const network = window.CollectorUI?.status?.()?.testConnection;
    label.textContent = network?.active
      ? "테스트 경로 · SpoofDPI (IP 그대로)"
      : "기본 연결";
  }
  document.addEventListener("collector:status", showTestConnection);
  function standalone({ authenticated, sites, open }) {
    if (!authenticated) {
      standaloneOpened = false;
      return;
    }
    if (
      standaloneOpened ||
      new URLSearchParams(location.search).get("captcha") !== "1"
    )
      return;
    const site = sites.find((item) => item.held !== false);
    if (!site) return;
    standaloneOpened = true;
    document.body.classList.add("captcha-standalone");
    open(site.host);
  }
  showTestConnection();
  window.CaptchaWindow = { standalone };
})();
