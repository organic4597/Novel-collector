import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const themePath = new URL("../public/theme.js", import.meta.url);
const controls = `
  <button id="theme-toggle" type="button" data-theme-toggle>테마</button>
  <button id="login-theme-toggle" type="button" data-theme-toggle>테마</button>`;

async function fixture({ stored, blocked = false, beforeBody = false } = {}) {
  const source = await readFile(themePath, "utf8");
  const dom = new JSDOM(beforeBody ? "<html><head></head></html>" : controls, {
    url: "https://collector.example.test/",
    runScripts: "outside-only",
  });
  const { window } = dom;
  const requests = [];
  window.fetch = (...args) => requests.push(args);
  window.XMLHttpRequest = function () {
    requests.push("XMLHttpRequest");
  };
  if (stored !== undefined)
    window.localStorage.setItem("collector.theme", stored);
  if (blocked) {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new window.DOMException(
          "Storage is unavailable",
          "SecurityError",
        );
      },
    });
  }
  window.eval(source);
  const initialMode = window.document.documentElement.dataset.theme;
  if (beforeBody) window.document.body.innerHTML = controls;
  return { dom, window, requests, initialMode };
}

function ready(window) {
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
}

function assertMode(window, mode) {
  assert.equal(window.document.documentElement.dataset.theme, mode);
  for (const button of window.document.querySelectorAll(
    "[data-theme-toggle]",
  )) {
    assert.equal(button.type, "button");
    assert.equal(button.getAttribute("aria-pressed"), String(mode === "dark"));
    assert.ok(
      button.getAttribute("aria-label")?.trim(),
      "theme toggle has an accessible name",
    );
  }
}

test("theme applies before page content and preserves a valid saved choice", async () => {
  const { dom, window, requests, initialMode } = await fixture({
    stored: "dark",
    beforeBody: true,
  });
  try {
    assert.equal(initialMode, "dark");
    ready(window);
    assertMode(window, "dark");
    assert.deepEqual(
      requests,
      [],
      "theme initialization does not call server APIs",
    );
  } finally {
    dom.window.close();
  }
});

test("new users and invalid stored themes start in light mode", async () => {
  for (const stored of [undefined, "", "system", "blue", "DARK", "<script>"]) {
    const { dom, window } = await fixture({ stored });
    try {
      ready(window);
      assertMode(window, "light");
    } finally {
      dom.window.close();
    }
  }
});

test("either theme button changes both controls and the saved preference", async () => {
  const { dom, window, requests } = await fixture();
  try {
    ready(window);
    window.document.getElementById("login-theme-toggle").click();
    assertMode(window, "dark");
    assert.equal(window.localStorage.getItem("collector.theme"), "dark");
    window.document.getElementById("theme-toggle").click();
    assertMode(window, "light");
    assert.equal(window.localStorage.getItem("collector.theme"), "light");
    assert.deepEqual(requests, [], "switching the theme is entirely local");
  } finally {
    dom.window.close();
  }
});

test("theme switching still works when browser storage is blocked", async () => {
  const { dom, window } = await fixture({ blocked: true });
  try {
    ready(window);
    assertMode(window, "light");
    window.document.getElementById("theme-toggle").click();
    assertMode(window, "dark");
    window.document.getElementById("login-theme-toggle").click();
    assertMode(window, "light");
  } finally {
    dom.window.close();
  }
});

test("readable preferences remain usable when storage writes are rejected", async () => {
  const { dom, window } = await fixture({ stored: "dark" });
  try {
    ready(window);
    window.Storage.prototype.setItem = () => {
      throw new window.DOMException(
        "Storage quota is exhausted",
        "QuotaExceededError",
      );
    };
    window.document.getElementById("theme-toggle").click();
    assertMode(window, "light");
  } finally {
    dom.window.close();
  }
});

test("saved theme changes in another tab update both controls without network requests", async () => {
  const { dom, window, requests } = await fixture();
  try {
    ready(window);
    const sync = (key, newValue) =>
      window.dispatchEvent(
        new window.StorageEvent("storage", {
          key,
          newValue,
          storageArea: window.localStorage,
        }),
      );
    sync("collector.theme", "dark");
    assertMode(window, "dark");
    sync("unrelated.setting", "light");
    assertMode(window, "dark");
    sync("collector.theme", "invalid");
    assertMode(window, "light");
    sync("collector.theme", "dark");
    sync("collector.theme", null);
    assertMode(window, "light");
    assert.deepEqual(requests, []);
  } finally {
    dom.window.close();
  }
});

test("login and dashboard both expose native theme controls and load the script before styles", async () => {
  const html = await readFile(
    new URL("../public/index.html", import.meta.url),
    "utf8",
  );
  const dom = new JSDOM(html);
  try {
    for (const id of ["theme-toggle", "login-theme-toggle"]) {
      const button = dom.window.document.getElementById(id);
      assert.ok(button, id + " exists");
      assert.equal(button.tagName, "BUTTON");
      assert.equal(button.type, "button");
      assert.ok(button.hasAttribute("data-theme-toggle"));
    }
    const script = dom.window.document.querySelector('script[src="/theme.js"]');
    assert.ok(script, "theme script is loaded");
    assert.equal(
      script.hasAttribute("defer"),
      false,
      "the initial theme is selected before painting",
    );
    assert.equal(script.hasAttribute("async"), false);
    const firstStylesheet = dom.window.document.querySelector(
      'link[rel="stylesheet"]',
    );
    assert.ok(
      script.compareDocumentPosition(firstStylesheet) &
        dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    );
  } finally {
    dom.window.close();
  }
});
