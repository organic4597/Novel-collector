"use strict";
(() => {
  let revision = 0;
  document.addEventListener("collector:auth", async ({ detail: authenticated }) => {
    const current = ++revision;
    document.getElementById("owner-hub-return")?.remove();
    if (!authenticated) return;
    try {
      const result = await window.CollectorUI.api("/api/owner-navigation");
      if (current !== revision || !window.CollectorUI.authenticated() || !result?.href) return;
      const url = new URL(result.href);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return;
      const link = document.createElement("a");
      link.id = "owner-hub-return";
      link.className = "nav-item";
      link.href = url.href;
      link.textContent = "Hub로 돌아가기";
      document.querySelector(".management-nav")?.append(link);
    } catch {
      // Optional owner navigation must not interrupt the collector dashboard.
    }
  });
})();
