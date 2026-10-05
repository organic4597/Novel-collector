import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function fixture(t) {
  const dom = new JSDOM(
    await readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    {
      url: "https://localhost/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    calls = [],
    notices = [],
    responses = new Map();
  let selected = null,
    generation = 1,
    authenticated = true;
  w.eval(
    await readFile(
      new URL("../public/performance.js", import.meta.url),
      "utf8",
    ),
  );
  w.CollectorUI = {
    ...w.CollectorPerformance,
    authenticated: () => authenticated,
    generation: () => generation,
    selectedJob: () => selected,
    selectJob: (id) => {
      selected = id;
    },
    error: (message) => notices.push(message),
    api: (path, options = {}) => {
      calls.push({ path, options });
      return new Promise((resolve, reject) =>
        responses.set(path, { resolve, reject }),
      );
    },
  };
  w.eval(
    (await readFile(new URL("../public/logs.js", import.meta.url), "utf8")) +
      "\n//# sourceURL=" +
      new URL("../public/logs.js", import.meta.url).href,
  );
  const data = (message) => [
    { id: message, level: "info", message, time: "2026-10-05T00:00:00Z" },
  ];
  return {
    w,
    calls,
    notices,
    responses,
    data,
    expire: () => {
      authenticated = false;
      generation++;
      w.document.dispatchEvent(
        new w.CustomEvent("collector:auth", { detail: false }),
      );
    },
  };
}

test("Selecting B immediately requests its logs while A is pending; late A cannot overwrite B", async (t) => {
  const f = await fixture(t),
    first = f.w.CollectorLogs.open({ id: "A", title: "작품 A" });
  await tick();
  const second = f.w.CollectorLogs.open({ id: "B", title: "작품 B" });
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/B/events")).length,
    1,
  );
  assert.equal(f.calls[0].options.signal.aborted, true);
  f.responses.get("/api/jobs/B/events").resolve(f.data("B 최신 로그"));
  await second;
  f.responses.get("/api/jobs/A/events").resolve(f.data("A 오래된 로그"));
  await first;
  assert.match(
    f.w.document.getElementById("events-list").textContent,
    /B 최신/,
  );
  assert.doesNotMatch(
    f.w.document.getElementById("events-list").textContent,
    /A 오래된/,
  );
});

test("Same selected logs dedupe concurrent refreshes and late errors never show a global notice", async (t) => {
  const f = await fixture(t),
    first = f.w.CollectorLogs.open({ id: "A", title: "작품 A" });
  f.w.CollectorLogs.refresh();
  f.w.CollectorLogs.refresh();
  assert.equal(f.calls.length, 1);
  const second = f.w.CollectorLogs.open({ id: "B", title: "작품 B" });
  f.responses.get("/api/jobs/B/events").resolve(f.data("B 로그"));
  await second;
  f.responses.get("/api/jobs/A/events").reject(new Error("오래된 실패"));
  await first;
  assert.deepEqual(f.notices, []);
  assert.doesNotMatch(
    f.w.document.getElementById("events-list").textContent,
    /실패/,
  );
});

test("Log append preserves existing rows and scroll position; unchanged responses do not rebuild", async (t) => {
  const f = await fixture(t),
    first = f.w.CollectorLogs.open({ id: "A", title: "작품 A" });
  f.responses.get("/api/jobs/A/events").resolve(f.data("첫 로그"));
  await first;
  const list = f.w.document.getElementById("events-list"),
    row = list.firstElementChild;
  Object.defineProperty(list, "scrollHeight", {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(list, "clientHeight", {
    configurable: true,
    value: 200,
  });
  list.scrollTop = 123;
  const next = f.w.CollectorLogs.refresh();
  f.responses
    .get("/api/jobs/A/events")
    .resolve([...f.data("첫 로그"), ...f.data("두번째 로그")]);
  await next;
  assert.equal(list.firstElementChild, row);
  assert.equal(list.scrollTop, 123);
  const newest = list.lastElementChild,
    unchanged = f.w.CollectorLogs.refresh();
  f.responses
    .get("/api/jobs/A/events")
    .resolve([...f.data("첫 로그"), ...f.data("두번째 로그")]);
  await unchanged;
  assert.equal(list.lastElementChild, newest);
});

test("Logout aborts pending logs, clears private rows and ignores late responses", async (t) => {
  const f = await fixture(t),
    pending = f.w.CollectorLogs.open({ id: "A", title: "작품 A" });
  f.expire();
  assert.equal(f.calls[0].options.signal.aborted, true);
  f.responses.get("/api/jobs/A/events").resolve(f.data("비공개 지연 로그"));
  await pending;
  assert.equal(f.w.document.getElementById("events-list").children.length, 0);
  assert.deepEqual(f.notices, []);
});
