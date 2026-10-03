import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const automatic = (state, extra = {}) => ({
  configured: true,
  enabled: true,
  state,
  error: null,
  retryAt: null,
  ...extra,
});
const banner = (w) => w.document.getElementById("site-attention-banner");
const action = (w, value) =>
  [...w.document.querySelectorAll("#site-attention-actions button")].find(
    (button) => button.dataset.action === value,
  );
async function fixture(
  t,
  {
    kind = "authentication",
    autoLogin,
    deferredTest = false,
    testError = null,
    sessionHandler = null,
    frameError = false,
  } = {},
) {
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
    calls = [];
  let generation = 1,
    authenticated = true,
    resolveTest,
    refreshes = 0,
    frameRequests = 0;
  const dialog = w.document.getElementById("captcha-session-dialog"),
    frame = w.document.getElementById("captcha-session-frame");
  dialog.showModal = () => {
    dialog.open = true;
  };
  dialog.close = () => {
    dialog.open = false;
    dialog.dispatchEvent(new w.Event("close"));
  };
  Object.defineProperty(frame, "naturalWidth", { value: 1280 });
  Object.defineProperty(frame, "naturalHeight", { value: 900 });
  frame.getBoundingClientRect = () => ({
    left: 10,
    top: 20,
    width: 640,
    height: 450,
  });
  w.URL.createObjectURL = () => "blob:frame-" + frameRequests;
  w.URL.revokeObjectURL = () => {};
  w.fetch = async () => {
    frameRequests++;
    setTimeout(
      () => frame.dispatchEvent(new w.Event(frameError ? "error" : "load")),
      5,
    );
    return {
      ok: true,
      blob: async () => new w.Blob(["jpeg"], { type: "image/jpeg" }),
    };
  };
  const snapshot = {
    siteAttention: [
      {
        host: "newtoki1.org",
        kind,
        autoLogin,
        held: true,
        reason:
          "일일 조회 인증이 필요합니다. 서버 브라우저 1·2에서 직접 인증 후 확인하세요.",
        requiredSlots: [1, 2],
        verifiedSlots: [],
      },
    ],
  };
  w.CollectorUI = {
    status: () => snapshot,
    authenticated: () => authenticated,
    generation: () => generation,
    api: async (path, options = {}) => {
      calls.push({ path, options });
      if (path.startsWith("/api/captcha-session/")) {
        if (sessionHandler) return sessionHandler(path, options);
        return {
          open: true,
          host: "newtoki1.org",
          width: 1280,
          height: 900,
          slot: 1,
          pendingSlots: [1, 2],
        };
      }
      if (path !== "/api/site-account/test") throw Error("unexpected " + path);
      if (testError) throw Error(testError);
      if (deferredTest)
        return new Promise((resolve) => {
          resolveTest = () => resolve({ state: "running" });
        });
      return { state: "running" };
    },
    textError: (error) => error.message,
    refresh: () => refreshes++,
  };
  w.eval(
    await readFile(
      new URL("../public/site-verification.js", import.meta.url),
      "utf8",
    ),
  );
  await tick();
  return {
    w,
    calls,
    snapshot,
    refreshes: () => refreshes,
    frameRequests: () => frameRequests,
    hide: (hidden) => {
      Object.defineProperty(w.document, "hidden", {
        configurable: true,
        value: hidden,
      });
      w.document.dispatchEvent(new w.Event("visibilitychange"));
    },
    resolveTest: () => resolveTest?.(),
    update: () =>
      w.document.dispatchEvent(new w.CustomEvent("collector:status")),
    expire: () => {
      authenticated = false;
      generation++;
      w.document.dispatchEvent(
        new w.CustomEvent("collector:auth", { detail: false }),
      );
    },
  };
}
test("CAPTCHA offers a server session action for the current site", async (t) => {
  const { w, calls } = await fixture(t, {
    kind: "captcha",
    autoLogin: automatic("ready"),
  });
  assert.equal(
    w.document.getElementById("site-attention-heading").textContent,
    "CAPTCHA 확인 중",
  );
  assert.match(banner(w).textContent, /서버.*세션/);
  assert.doesNotMatch(
    banner(w).textContent,
    /일일 조회|브라우저\s*[12]|직접 인증|재로그인.*해제되지/,
  );
  assert.equal(
    w.document.querySelectorAll("#site-attention-actions button").length,
    1,
  );
  assert.equal(
    calls.length,
    0,
    "Rendering never triggers source navigation or login",
  );
  assert.equal(
    w.document.querySelectorAll("#site-attention-actions a").length,
    0,
  );
  assert.equal(action(w, "captcha").textContent, "CAPTCHA 풀기");
});
test("Product uses a CAPTCHA popup while preserving account and reader features", async (t) => {
  const { w } = await fixture(t, { kind: "captcha" });
  assert.equal(w.document.querySelector('[id^="site-browser-"]'), null);
  const script = await readFile(
    new URL("../public/site-verification.js", import.meta.url),
    "utf8",
  );
  assert.match(script, /\/api\/captcha-session/);
  assert.ok(w.document.getElementById("captcha-session-dialog"));
  assert.ok(w.document.getElementById("site-account-form"));
  assert.ok(w.document.getElementById("reader-dialog"));
  assert.doesNotMatch(
    w.document.querySelector(".site-account-intro").textContent,
    /직접 인증해야/,
  );
});

test("Exhausted automatic checks show CAPTCHA waiting without claiming active checks", async (t) => {
  const { w, snapshot, update } = await fixture(t, {
    kind: "captcha",
    autoLogin: automatic("needs_attention", { attempts: 3, maxAttempts: 3 }),
  });
  assert.equal(
    w.document.getElementById("site-attention-heading").textContent,
    "CAPTCHA 대기",
  );
  assert.doesNotMatch(
    banner(w).textContent,
    /확인 중|확인하고 있습니다|자동으로 확인합니다/,
  );
  assert.equal(action(w, "retry"), undefined);
  snapshot.siteAttention[0].autoLogin = automatic("waiting");
  update();
  assert.equal(
    w.document.getElementById("site-attention-heading").textContent,
    "CAPTCHA 확인 중",
  );
});

test("Login status reporting CAPTCHA overrides old authentication hold controls", async (t) => {
  const { w } = await fixture(t, {
    autoLogin: automatic("needs_attention", { failureKind: "captcha" }),
  });
  assert.equal(
    w.document.getElementById("site-attention-heading").textContent,
    "CAPTCHA 대기",
  );
  assert.equal(action(w, "retry"), undefined);
  assert.equal(
    w.document.querySelectorAll("#site-attention-actions button").length,
    1,
  );
});
test("CAPTCHA details expose source-specific login errors without obsolete warning", async (t) => {
  const { w, snapshot, update } = await fixture(t, {
    kind: "captcha",
    autoLogin: automatic("needs_attention", {
      error: "sbxh9.com 로그인 세션이 만료되었습니다.",
    }),
  });
  assert.match(banner(w).textContent, /sbxh9\.com 로그인 세션이 만료/);
  assert.doesNotMatch(
    banner(w).textContent,
    /일일 조회|브라우저\s*[12]|직접 인증/,
  );
  assert.equal(action(w, "retry"), undefined);
  snapshot.siteAttention[0].autoLogin = automatic("needs_attention", {
    error: snapshot.siteAttention[0].reason,
  });
  update();
  assert.doesNotMatch(
    banner(w).textContent,
    /일일 조회|브라우저\s*[12]|직접 인증/,
  );
});
for (const state of ["idle", "waiting", "running", "ready"]) {
  test(`Automatic authentication ${state} reports progress without requests`, async (t) => {
    const { w, calls } = await fixture(t, { autoLogin: automatic(state) });
    assert.match(banner(w).textContent, /자동 로그인|로그인 상태.*확인/);
    assert.doesNotMatch(
      banner(w).textContent,
      /직접|일일 조회|브라우저\s*[12]/,
    );
    assert.equal(action(w, "retry"), undefined);
    assert.equal(calls.length, 0);
  });
}
test("Authentication failure has settings and one explicit deduplicated retry", async (t) => {
  const { w, calls, resolveTest, update } = await fixture(t, {
    deferredTest: true,
    autoLogin: automatic("needs_attention", {
      error: "로그인 정보를 확인하세요.",
    }),
  });
  let settingsClicks = 0;
  w.document
    .getElementById("nav-settings")
    .addEventListener("click", () => settingsClicks++);
  action(w, "settings").click();
  assert.equal(settingsClicks, 1);
  const retry = action(w, "retry");
  retry.click();
  retry.click();
  update();
  action(w, "retry")?.click();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/site-account/test");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), { host: "newtoki1.org" });
  resolveTest();
  await tick();
});
test("Missing and disabled accounts offer settings and explain automatic login", async (t) => {
  const { w, snapshot, update } = await fixture(t, {
    autoLogin: automatic("idle", { configured: false }),
  });
  assert.ok(action(w, "settings"));
  assert.equal(action(w, "retry"), undefined);
  assert.match(banner(w).textContent, /저장된 계정.*자동 로그인/);
  snapshot.siteAttention[0].autoLogin = automatic("idle", { enabled: false });
  update();
  assert.ok(action(w, "settings"));
  assert.equal(action(w, "retry"), undefined);
});
test("Site access block is nonintrusive and never offers manual or login retry controls", async (t) => {
  const { w, calls } = await fixture(t, {
    kind: "site_blocked",
    autoLogin: automatic("needs_attention"),
  });
  assert.equal(
    w.document.getElementById("site-attention-heading").textContent,
    "사이트 접근 확인 필요",
  );
  assert.equal(banner(w).getAttribute("role"), "status");
  assert.equal(
    w.document.querySelectorAll("#site-attention-actions button").length,
    0,
  );
  assert.doesNotMatch(banner(w).textContent, /일일 조회|브라우저\s*[12]|직접/);
  assert.equal(calls.length, 0);
});
test("Cooldown blocks retries and CAPTCHA never offers auth retry after state changes", async (t) => {
  const { w, calls, snapshot, update } = await fixture(t, {
    autoLogin: automatic("failed", {
      retryAt: new Date(Date.now() + 60000).toISOString(),
    }),
  });
  assert.equal(action(w, "retry").disabled, true);
  action(w, "retry").click();
  assert.equal(calls.length, 0);
  snapshot.siteAttention[0].kind = "captcha";
  update();
  assert.equal(action(w, "retry"), undefined);
});
test("Automatic completion clears all text and actions only when server removes hold", async (t) => {
  const { w, snapshot, update } = await fixture(t, {
    kind: "captcha",
    autoLogin: automatic("ready"),
  });
  assert.equal(banner(w).hidden, false);
  assert.doesNotMatch(
    banner(w).textContent,
    /해제되었습니다|인증을 확인했습니다|수집.*재개/,
  );
  snapshot.siteAttention[0].held = false;
  update();
  assert.equal(banner(w).hidden, true);
  assert.equal(banner(w).textContent.trim(), "");
  snapshot.siteAttention = [];
  update();
  assert.equal(
    w.document.getElementById("site-attention-actions").children.length,
    0,
  );
});
test("Retry errors display as text and late logout responses cannot restore banner", async (t) => {
  const { w } = await fixture(t, {
    testError: "<img src=x onerror=alert(1)> 서버 오류",
    autoLogin: automatic("failed"),
  });
  action(w, "retry").click();
  await tick();
  assert.match(banner(w).textContent, /서버 오류/);
  assert.equal(banner(w).querySelector("img"), null);
  const late = await fixture(t, {
    deferredTest: true,
    autoLogin: automatic("failed"),
  });
  action(late.w, "retry").click();
  await tick();
  late.expire();
  late.resolveTest();
  await tick();
  assert.equal(banner(late.w).hidden, true);
  assert.equal(banner(late.w).textContent.trim(), "");
});
test("Status refresh after authentication retry uses current backend state", async (t) => {
  const { w, snapshot, update } = await fixture(t, {
    autoLogin: automatic("failed"),
  });
  action(w, "retry").click();
  await tick();
  snapshot.siteAttention[0].autoLogin = automatic("ready");
  update();
  assert.match(banner(w).textContent, /로그인 상태.*확인/);
  assert.equal(action(w, "retry"), undefined);
});

async function openSession(f) {
  action(f.w, "captcha").click();
  await tick();
  await tick();
  return f.w.document.getElementById("captcha-session-frame");
}
function pointer(w, frame, type, x, y) {
  const event = new w.Event(type, { bubbles: true, cancelable: true });
  for (const [name, value] of Object.entries({
    clientX: x,
    clientY: y,
    pointerId: 7,
    button: 0,
  }))
    Object.defineProperty(event, name, { value });
  frame.dispatchEvent(event);
}
test("CAPTCHA opens current site through the server and permits only two reader origins", async (t) => {
  const f = await fixture(t, { kind: "captcha" });
  await openSession(f);
  assert.deepEqual(JSON.parse(f.calls[0].options.body), {
    host: "newtoki1.org",
    viewerOrigin: "https://sbxh9.com",
  });
  assert.equal(f.calls[0].path, "/api/captcha-session/open");
  const select = f.w.document.getElementById("captcha-session-viewer");
  assert.deepEqual(
    [...select.options].map((x) => x.value),
    ["https://sbxh9.com", "https://toki32.com"],
  );
  const option = f.w.document.createElement("option");
  option.value = "https://evil.example";
  select.append(option);
  select.value = option.value;
  select.dispatchEvent(new f.w.Event("change"));
  await tick();
  assert.equal(f.calls.filter((x) => x.path.endsWith("/open")).length, 1);
  assert.match(
    f.w.document.getElementById("captcha-session-error").textContent,
    /지원하는/,
  );
});
test("Drag scales and clamps coordinates, coalesces moves, and sends up after final move", async (t) => {
  let release;
  const f = await fixture(t, {
    kind: "captcha",
    sessionHandler: async (path, options) => {
      if (path.endsWith("/input") && JSON.parse(options.body).phase === "down")
        await new Promise((resolve) => {
          release = resolve;
        });
      return { open: true, width: 1280, height: 900 };
    },
  });
  const frame = await openSession(f);
  pointer(f.w, frame, "pointerdown", 110, 120);
  await tick();
  pointer(f.w, frame, "pointermove", 210, 220);
  pointer(f.w, frame, "pointermove", 3000, -100);
  pointer(f.w, frame, "pointerup", 3000, -100);
  assert.equal(f.calls.filter((x) => x.path.endsWith("/input")).length, 1);
  release();
  await tick();
  const inputs = f.calls
    .filter((x) => x.path.endsWith("/input"))
    .map((x) => JSON.parse(x.options.body));
  assert.deepEqual(inputs, [
    { type: "pointer", phase: "down", x: 200, y: 200 },
    { type: "pointer", phase: "move", x: 1279, y: 0 },
    { type: "pointer", phase: "up", x: 1279, y: 0 },
  ]);
});
test("Invalid screen disables all input and never submits apply", async (t) => {
  const f = await fixture(t, { kind: "captcha", frameError: true });
  const frame = await openSession(f);
  pointer(f.w, frame, "pointerdown", 100, 100);
  f.w.document.getElementById("captcha-session-apply").click();
  await tick();
  assert.equal(
    f.calls.some((x) => /\/(input|apply)$/.test(x.path)),
    false,
  );
  assert.equal(
    f.w.document.getElementById("captcha-session-apply").disabled,
    true,
  );
});
test("Apply keeps CAPTCHA hold visible until verified real source release", async (t) => {
  const f = await fixture(t, {
    kind: "captcha",
    sessionHandler: async (path) =>
      path.endsWith("/apply")
        ? { verified: false, pendingSlots: [1, 2], siteReleased: false }
        : { open: true, width: 1280, height: 900 },
  });
  await openSession(f);
  f.w.document.getElementById("captcha-session-apply").click();
  await tick();
  assert.equal(
    f.w.document.getElementById("captcha-session-dialog").open,
    true,
  );
  assert.equal(banner(f.w).hidden, false);
  assert.equal(f.refreshes(), 0);
  assert.match(
    f.w.document.getElementById("captcha-session-error").textContent,
    /아직 확인하지/,
  );
});
test("Verified partial result opens remaining session; final release closes and refreshes", async (t) => {
  let applied = 0;
  const f = await fixture(t, {
    kind: "captcha",
    sessionHandler: async (path) =>
      path.endsWith("/apply")
        ? ++applied === 1
          ? {
              verified: true,
              pendingSlots: [2],
              siteReleased: false,
              status: { open: true, slot: 2, width: 1280, height: 900 },
            }
          : { verified: true, pendingSlots: [], siteReleased: true }
        : { open: true, width: 1280, height: 900 },
  });
  await openSession(f);
  f.w.document.getElementById("captcha-session-apply").click();
  await tick();
  assert.match(
    f.w.document.getElementById("captcha-session-status").textContent,
    /남은 인증 확인/,
  );
  assert.equal(f.calls.filter((x) => x.path.endsWith("/open")).length, 1);
  // New slot waits for its own fresh frame, with no more than one request per second.
  assert.equal(
    f.w.document.getElementById("captcha-session-apply").disabled,
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 1030));
  f.w.document.getElementById("captcha-session-apply").click();
  await tick();
  assert.equal(
    f.w.document.getElementById("captcha-session-dialog").open,
    false,
  );
  assert.equal(f.refreshes(), 1);
  assert.equal(f.calls.at(-1).path, "/api/captcha-session/close");
});
test("Frames are at most once per second; hidden tabs stop input and rendering", async (t) => {
  const f = await fixture(t, { kind: "captcha" });
  const frame = await openSession(f);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(f.frameRequests(), 1);
  f.hide(true);
  pointer(f.w, frame, "pointerdown", 100, 100);
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal(f.frameRequests(), 1);
  assert.equal(
    f.calls.some((x) => x.path.endsWith("/input")),
    false,
  );
  f.hide(false);
  await tick();
  await tick();
  assert.equal(f.frameRequests(), 2);
  f.w.document.getElementById("captcha-session-close").click();
  await tick();
  assert.equal(frame.hasAttribute("src"), false);
  assert.equal(f.calls.at(-1).path, "/api/captcha-session/close");
});
test("Closing a deferred open disposes late server session and cannot reopen dialog", async (t) => {
  let resolveOpen;
  const f = await fixture(t, {
    kind: "captcha",
    sessionHandler: async (path) => {
      if (path.endsWith("/open"))
        return new Promise((resolve) => {
          resolveOpen = resolve;
        });
      return {};
    },
  });
  action(f.w, "captcha").click();
  await tick();
  f.w.document.getElementById("captcha-session-close").click();
  resolveOpen({ open: true, width: 1280, height: 900 });
  await tick();
  assert.equal(
    f.w.document.getElementById("captcha-session-dialog").open,
    false,
  );
  assert.equal(f.frameRequests(), 0);
  assert.equal(f.calls.at(-1).path, "/api/captcha-session/close");
});
test("Logout drops queued input and late responses; text field clears before sending", async (t) => {
  let release;
  const f = await fixture(t, {
    kind: "captcha",
    sessionHandler: async (path, options) => {
      if (path.endsWith("/input")) {
        assert.equal(
          f.w.document.getElementById("captcha-session-text").value,
          "",
        );
        if (JSON.parse(options.body).phase === "down")
          await new Promise((resolve) => {
            release = resolve;
          });
      }
      return { open: true, width: 1280, height: 900 };
    },
  });
  const frame = await openSession(f);
  f.w.document.getElementById("captcha-session-text").value =
    "human typed text";
  f.w.document
    .getElementById("captcha-session-text-form")
    .dispatchEvent(new f.w.Event("submit", { cancelable: true }));
  await tick();
  pointer(f.w, frame, "pointerdown", 100, 100);
  await tick();
  pointer(f.w, frame, "pointerup", 200, 100);
  f.expire();
  release();
  await tick();
  assert.equal(f.calls.filter((x) => x.path.endsWith("/input")).length, 2);
  assert.equal(
    f.w.document.getElementById("captcha-session-dialog").open,
    false,
  );
  assert.equal(frame.hasAttribute("src"), false);
});
