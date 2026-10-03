"use strict";
(() => {
  let standaloneOpened = false;
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
  window.CaptchaWindow = { standalone };
})();
