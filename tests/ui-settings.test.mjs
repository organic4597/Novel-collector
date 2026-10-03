import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const defaults = {
  maxConcurrency: 2,
  chapterDelayMs: 1200,
  defaultFormat: "txt",
  refreshIntervalMs: 5000,
  libraryPageSize: 24,
  thumbnailFit: "contain",
  displayDensity: "comfortable",
};
async function fixture(t, { deferLoad = false } = {}) {
  const dom = new JSDOM(
    await readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    {
      url: "http://localhost:8788",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    calls = [],
    preferences = [],
    events = [];
  let generation = 1,
    authenticated = true,
    resolveLoad;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.URL.createObjectURL = () => "blob:settings-export";
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () {};
  w.CollectorUI = {
    authenticated: () => authenticated,
    generation: () => generation,
    defaults: { defaultFormat: "txt" },
    toast: () => {},
    textError: (error) => error.message,
    applyPreferences: (settings) => preferences.push(settings),
    api: async (path, options = {}) => {
      calls.push({ path, options });
      if (path === "/api/settings") {
        if (options.method === "PUT") return JSON.parse(options.body);
        if (deferLoad)
          return new Promise((resolve) => {
            resolveLoad = resolve;
          });
        return { ...defaults };
      }
      if (path === "/api/system/info")
        return {
          bookCount: 7,
          chapterCount: 123,
          bodyBytes: 2048,
          diskFreeBytes: 4096,
          uptimeSeconds: 3661,
          backoff: { threshold: 5, cooldownMs: 600000 },
          maxConcurrency: 2,
        };
      if (path === "/api/settings/password") return { changed: true };
      throw Error("unexpected " + path);
    },
  };
  w.document.addEventListener("collector:settings", (event) =>
    events.push(event.detail),
  );
  w.eval(
    await readFile(new URL("../public/settings.js", import.meta.url), "utf8"),
  );
  await tick();
  const change = (id, value) => {
    const element = w.document.getElementById(id);
    assert.ok(element, "missing " + id);
    element.value = String(value);
    element.dispatchEvent(new w.Event("input", { bubbles: true }));
  };
  return {
    w,
    calls,
    preferences,
    events,
    change,
    resolve: () => resolveLoad?.({ ...defaults }),
    expire: () => {
      generation++;
      authenticated = false;
      w.document.dispatchEvent(
        new w.CustomEvent("collector:auth", { detail: false }),
      );
    },
  };
}
const click = (w, id) => {
  assert.ok(w.document.getElementById(id), "missing " + id);
  w.document.getElementById(id).click();
};
test("New display options apply only after save; presets and reset remain local", async (t) => {
  const { w, calls, change, preferences, events } = await fixture(t);
  assert.equal(w.document.getElementById("settings-refresh").value, "5000");
  change("settings-refresh", 10000);
  change("settings-page-size", 48);
  change("settings-thumbnail", "cover");
  change("settings-density", "compact");
  assert.match(
    w.document.getElementById("settings-save-state").textContent,
    /변경됨/,
  );
  w.document.dispatchEvent(
    new w.CustomEvent("collector:view", { detail: "settings" }),
  );
  await tick();
  assert.equal(w.document.getElementById("settings-refresh").value, "10000");
  assert.equal(
    calls.filter(
      (call) => call.path === "/api/settings" && !call.options.method,
    ).length,
    1,
  );
  w.document
    .getElementById("settings-form")
    .dispatchEvent(new w.Event("submit", { cancelable: true }));
  await tick();
  const body = JSON.parse(
    calls.find((call) => call.options.method === "PUT").options.body,
  );
  assert.equal(body.refreshIntervalMs, 10000);
  assert.equal(body.libraryPageSize, 48);
  assert.equal(body.thumbnailFit, "cover");
  assert.equal(body.displayDensity, "compact");
  assert.equal(preferences.at(-1).displayDensity, "compact");
  assert.equal(events.at(-1).thumbnailFit, "cover");
  assert.match(
    w.document.getElementById("settings-save-state").textContent,
    /저장됨/,
  );
  click(w, "settings-preset-light");
  click(w, "settings-reset");
  assert.equal(calls.filter((call) => call.options.method === "PUT").length, 1);
});
test("Late load cannot overwrite edited form or apply after logout", async (t) => {
  const { w, change, resolve, preferences } = await fixture(t, {
    deferLoad: true,
  });
  change("settings-delay", 2500);
  resolve();
  await tick();
  assert.equal(w.document.getElementById("settings-delay").value, "2500");
  assert.match(
    w.document.getElementById("settings-save-state").textContent,
    /변경됨/,
  );
  const stale = await fixture(t, { deferLoad: true });
  stale.expire();
  stale.resolve();
  await tick();
  assert.equal(stale.preferences.length, 0);
});
test("Settings import preview validates unknown and secret fields before local apply; password toggle accessible", async (t) => {
  const { w, calls, change } = await fixture(t);
  change(
    "settings-import-text",
    JSON.stringify({ ...defaults, refreshIntervalMs: 9000 }),
  );
  click(w, "settings-import-preview");
  assert.match(
    w.document.getElementById("settings-import-summary").textContent,
    /9000/,
  );
  click(w, "settings-import-apply");
  assert.equal(w.document.getElementById("settings-refresh").value, "9000");
  assert.ok(!calls.some((call) => call.options.method === "PUT"));
  change(
    "settings-import-text",
    JSON.stringify({ ...defaults, password: "secret" }),
  );
  click(w, "settings-import-preview");
  assert.match(
    w.document.getElementById("settings-transfer-error").textContent,
    /알 수 없는|허용되지/,
  );
  assert.equal(
    w.document.getElementById("settings-import-apply").disabled,
    true,
  );
  click(w, "password-new-toggle");
  assert.equal(w.document.getElementById("password-new").type, "text");
  assert.equal(
    w.document
      .getElementById("password-new-toggle")
      .getAttribute("aria-pressed"),
    "true",
  );
  click(w, "password-new-toggle");
  assert.equal(w.document.getElementById("password-new").type, "password");
});
test("Server info loads on demand and renders counts, storage and immutable retry limits", async (t) => {
  const { w, calls } = await fixture(t);
  assert.ok(!calls.some((call) => call.path === "/api/system/info"));
  w.document.dispatchEvent(
    new w.CustomEvent("collector:view", { detail: "settings" }),
  );
  await tick();
  assert.match(w.document.getElementById("system-book-count").textContent, /7/);
  assert.match(
    w.document.getElementById("system-chapter-count").textContent,
    /123/,
  );
  assert.match(
    w.document.getElementById("system-backoff").textContent,
    /5회.*10분/,
  );
  w.document.dispatchEvent(
    new w.CustomEvent("collector:view", { detail: "settings" }),
  );
  await tick();
  assert.equal(
    calls.filter((call) => call.path === "/api/system/info").length,
    1,
  );
});
test("Late settings load preserves entered reservation and discovery formats", async (t) => {
  const { w, change, resolve } = await fixture(t, { deferLoad: true });
  w.document.getElementById("job-dialog").open = true;
  change("job-format", "epub");
  change("batch-format", "epub");
  change("discover-format", "epub");
  resolve();
  await tick();
  for (const id of ["job-format", "batch-format", "discover-format"])
    assert.equal(w.document.getElementById(id).value, "epub");
  assert.equal(w.CollectorUI.defaults.defaultFormat, "txt");
});
test("Settings export includes only known configuration and never password form contents", async (t) => {
  const { w } = await fixture(t);
  let exported;
  w.Blob = class {
    constructor(parts) {
      exported = parts.join("");
    }
  };
  w.document.getElementById("password-current").value = "private-current";
  w.document.getElementById("password-new").value = "private-new";
  click(w, "settings-export");
  const settings = JSON.parse(exported);
  assert.deepEqual(Object.keys(settings).sort(), Object.keys(defaults).sort());
  assert.ok(!exported.includes("private"));
  assert.ok(!("password" in settings));
});
test("Successful save invalidates an older pending settings load", async (t) => {
  const { w, change, resolve, preferences } = await fixture(t, {
    deferLoad: true,
  });
  change("settings-delay", 2500);
  w.document
    .getElementById("settings-form")
    .dispatchEvent(new w.Event("submit", { cancelable: true }));
  await tick();
  resolve();
  await tick();
  assert.equal(w.document.getElementById("settings-delay").value, "2500");
  assert.equal(preferences.at(-1).chapterDelayMs, 2500);
  assert.match(
    w.document.getElementById("settings-save-state").textContent,
    /저장됨/,
  );
});
