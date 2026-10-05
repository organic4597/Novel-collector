import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import {
  defaultPresetConfig,
  listDefaultPresets,
} from "../src/default-presets.mjs";

const tick = () => new Promise((done) => setTimeout(done, 25));
const previous = {
  id: "existing",
  name: "기존 사용자 설정",
  origin: "https://custom.example",
  fieldCount: 1,
};
async function fixture(t, api) {
  const dom = new JSDOM(
    await readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    {
      url: "http://localhost/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    },
  );
  t.after(() => dom.window.close());
  const w = dom.window,
    d = w.document;
  if (!d.getElementById("preset-default")) {
    const section = d.createElement("div");
    section.innerHTML =
      '<select id="preset-default"><option value="">불러오는 중...</option></select><button id="preset-add-default" type="button" disabled>추가</button><p id="preset-default-help"></p>';
    d.getElementById("presets-view").append(section);
  }
  const state = { view: "presets", auth: true, generation: 1 };
  w.eval(
    await readFile(
      new URL("../public/performance.js", import.meta.url),
      "utf8",
    ),
  );
  w.CollectorUI = {
    node: w.CollectorPerformance.node,
    authenticated: () => state.auth,
    view: () => state.view,
    generation: () => state.generation,
    textError: (error) => error.message,
    api,
    navigate: (view) => {
      state.view = view;
      d.dispatchEvent(new w.CustomEvent("collector:view"));
    },
  };
  for (const file of [
    "element-picker.js",
    "preset-guide.js",
    "preset-connection.js",
    "extraction-presets.js",
  ])
    w.eval(
      await readFile(new URL("../public/" + file, import.meta.url), "utf8"),
    );
  return {
    w,
    d,
    state,
    enter: () => d.dispatchEvent(new w.CustomEvent("collector:view")),
  };
}

test("basic dropdown fetches only on the active view and explicit add creates a new editable copy", async (t) => {
  const calls = [],
    config = defaultPresetConfig("sbxh9-novel-v1");
  let records = [previous];
  const f = await fixture(t, async (path, options = {}) => {
    calls.push({ path, options });
    if (options.method === "POST") {
      records = [
        ...records,
        {
          id: "copied",
          name: config.name,
          origin: config.origin,
          fieldCount: 24,
        },
      ];
      return { id: "copied", config, updatedAt: "2026-10-05T00:00:00Z" };
    }
    return path.endsWith("/defaults") ? listDefaultPresets() : records;
  });
  assert.equal(calls.length, 0);
  f.enter();
  await tick();
  assert.equal(f.d.getElementById("preset-default").options.length, 2);
  assert.equal(f.d.getElementById("preset-list").children.length, 1);
  f.d.getElementById("preset-default").value = "sbxh9-novel-v1";
  f.d.getElementById("preset-default").dispatchEvent(new f.w.Event("change"));
  assert.equal(f.d.getElementById("preset-add-default").disabled, false);
  f.d.getElementById("preset-add-default").click();
  await tick();
  const writes = calls.filter((call) =>
    ["POST", "PUT"].includes(call.options.method),
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/api/extraction-presets/defaults");
  assert.deepEqual(JSON.parse(writes[0].options.body), {
    defaultId: "sbxh9-novel-v1",
  });
  assert.equal(
    JSON.parse(f.d.getElementById("preset-json").value).origin,
    "https://sbxh9.com",
  );
  assert.equal(f.d.getElementById("preset-list").children.length, 2);
  assert.match(f.d.getElementById("preset-status").textContent, /복사본|기본/);
  assert.match(
    f.d.getElementById("preset-page-tree").textContent,
    /✓ 소설 제목/,
  );
  assert.equal(
    f.d.getElementById("preset-save").textContent,
    "프리셋 수정 저장",
  );
});

test("double clicks do not duplicate a pending copy and a late reply after logout restores no preset data", async (t) => {
  let finish,
    posts = 0;
  const f = await fixture(t, async (path, options = {}) => {
    if (options.method === "POST") {
      posts++;
      return new Promise((done) => {
        finish = done;
      });
    }
    return path.endsWith("/defaults") ? listDefaultPresets() : [];
  });
  f.enter();
  await tick();
  const button = f.d.getElementById("preset-add-default");
  button.click();
  button.click();
  await tick();
  assert.equal(posts, 1);
  assert.equal(button.disabled, true);
  f.state.auth = false;
  f.state.generation++;
  f.d.dispatchEvent(new f.w.CustomEvent("collector:auth"));
  finish({ id: "late", config: defaultPresetConfig("sbxh9-novel-v1") });
  await tick();
  assert.equal(f.d.getElementById("preset-json").value, "");
  assert.equal(f.d.getElementById("preset-list").children.length, 0);
  assert.equal(button.disabled, true);
  assert.equal(f.d.getElementById("preset-default").value, "");
});

test("a copy failure preserves the current editor and defaults failure preserves the existing saved list", async (t) => {
  let defaultsFailure = false;
  const f = await fixture(t, async (path, options = {}) => {
    if (options.method === "POST") throw Error("저장 용량을 초과했습니다.");
    if (path.endsWith("/defaults")) {
      if (defaultsFailure) throw Error("기본 목록을 가져오지 못했습니다.");
      return listDefaultPresets();
    }
    return [previous];
  });
  f.enter();
  await tick();
  f.d.getElementById("preset-json").value = "UNCHANGED_CUSTOM_DRAFT";
  f.d.getElementById("preset-add-default").click();
  await tick();
  assert.equal(
    f.d.getElementById("preset-json").value,
    "UNCHANGED_CUSTOM_DRAFT",
  );
  assert.match(f.d.getElementById("preset-error").textContent, /저장 용량/);
  assert.equal(f.d.getElementById("preset-add-default").disabled, false);
  defaultsFailure = true;
  f.enter();
  await tick();
  assert.match(
    f.d.getElementById("preset-list").textContent,
    /기존 사용자 설정/,
  );
  assert.equal(f.d.getElementById("preset-add-default").disabled, true);
  assert.match(
    f.d.getElementById("preset-default-help").textContent,
    /기본 목록/,
  );
});

test("unauthenticated views never fetch defaults and an already full saved list disables add", async (t) => {
  const calls = [];
  const f = await fixture(t, async (path) => {
    calls.push(path);
    return path.endsWith("/defaults")
      ? listDefaultPresets()
      : Array.from({ length: 100 }, (_, i) => ({
          ...previous,
          id: `preset-${i}`,
        }));
  });
  f.state.auth = false;
  f.enter();
  await tick();
  assert.deepEqual(calls, []);
  f.state.auth = true;
  f.enter();
  await tick();
  assert.equal(f.d.getElementById("preset-add-default").disabled, true);
  assert.match(f.d.getElementById("preset-default-help").textContent, /100/);
});
