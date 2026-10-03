import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
async function fixture(
  t,
  {
    configured = false,
    saveFailure = false,
    deferredSave = false,
    testState = "success",
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
  let authenticated = true,
    generation = 1,
    resolveSave;
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.startsWith("/api/site-account?")) {
      if (options.method === "DELETE") return { deleted: true };
      return {
        host: "newtoki1.org",
        configured,
        enabled: false,
        username: configured ? "existing-user" : "",
      };
    }
    if (path === "/api/site-account" && options.method === "PUT") {
      if (saveFailure) throw Error("계정 정보를 저장하지 못했습니다.");
      if (deferredSave)
        return new Promise((resolve) => {
          resolveSave = () =>
            resolve({
              host: "newtoki1.org",
              configured: true,
              enabled: true,
              username: "user",
            });
        });
      return {
        host: "newtoki1.org",
        configured: true,
        ...JSON.parse(options.body),
        password: undefined,
        pin: undefined,
      };
    }
    if (path === "/api/site-account/test")
      return {
        host: "newtoki1.org",
        state: "running",
        phase: "정상 로그인 확인 중",
        id: "test-1",
      };
    if (path.startsWith("/api/site-account/test?"))
      return {
        host: "newtoki1.org",
        state: testState,
        phase: testState === "success" ? "로그인 완료" : "요청 대기 중",
        id: "test-1",
        retryAt:
          testState === "deferred"
            ? new Date(Date.now() + 60000).toISOString()
            : null,
      };
    throw Error("unexpected " + path);
  };
  w.CollectorUI = {
    api,
    authenticated: () => authenticated,
    generation: () => generation,
    textError: (error) => error.message,
    toast: () => {},
    refresh: () => {},
  };
  w.eval(
    await readFile(
      new URL("../public/site-account.js", import.meta.url),
      "utf8",
    ),
  );
  w.document.getElementById("settings-view").hidden = false;
  w.document.dispatchEvent(
    new w.CustomEvent("collector:view", { detail: "settings" }),
  );
  await tick();
  return {
    w,
    calls,
    resolveSave: () => resolveSave?.(),
    expire: () => {
      authenticated = false;
      generation++;
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
function credentials(w) {
  w.document.getElementById("site-account-username").value = "user";
  w.document.getElementById("site-account-password").value = "private-password";
  w.document.getElementById("site-account-pin").value = "0123";
}
function submit(w) {
  w.document
    .getElementById("site-account-form")
    .dispatchEvent(new w.Event("submit", { cancelable: true }));
}
test("New account requires password and exact PIN and explicit enabled choice; secrets immediately cleared", async (t) => {
  const { w, calls } = await fixture(t);
  w.document.getElementById("site-account-username").value = "user";
  submit(w);
  await tick();
  assert.ok(!calls.some((call) => call.options.method === "PUT"));
  credentials(w);
  w.document.getElementById("site-account-pin").value = "123";
  submit(w);
  await tick();
  assert.ok(!calls.some((call) => call.options.method === "PUT"));
  credentials(w);
  w.document.getElementById("site-account-enabled").checked = true;
  submit(w);
  assert.equal(w.document.getElementById("site-account-password").value, "");
  assert.equal(w.document.getElementById("site-account-pin").value, "");
  await tick();
  const request = calls.find((call) => call.options.method === "PUT");
  assert.deepEqual(JSON.parse(request.options.body), {
    host: "newtoki1.org",
    username: "user",
    password: "private-password",
    pin: "0123",
    enabled: true,
  });
  assert.equal(w.localStorage.length, 0);
});
test("Existing blank password and PIN preserve credentials; failed save never restores secrets", async (t) => {
  const { w, calls } = await fixture(t, { configured: true });
  submit(w);
  await tick();
  const body = JSON.parse(
    calls.find((call) => call.options.method === "PUT").options.body,
  );
  assert.ok(!("password" in body));
  assert.ok(!("pin" in body));
  const failed = await fixture(t, { saveFailure: true });
  credentials(failed.w);
  submit(failed.w);
  await tick();
  assert.equal(
    failed.w.document.getElementById("site-account-password").value,
    "",
  );
  assert.equal(failed.w.document.getElementById("site-account-pin").value, "");
  assert.match(
    failed.w.document.getElementById("site-account-error").textContent,
    /저장하지 못/,
  );
});
test("Login test polls once to terminal and delete requires explicit card confirmation", async (t) => {
  const { w, calls } = await fixture(t, { configured: true });
  click(w, "site-account-test");
  await tick();
  assert.match(
    w.document.getElementById("site-account-result").textContent,
    /확인 중/,
  );
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.match(
    w.document.getElementById("site-account-result").textContent,
    /완료/,
  );
  click(w, "site-account-delete");
  assert.ok(!calls.some((call) => call.options.method === "DELETE"));
  click(w, "site-account-delete-confirm");
  await tick();
  assert.ok(calls.some((call) => call.options.method === "DELETE"));
  assert.match(
    w.document.getElementById("site-account-config-state").textContent,
    /저장되지/,
  );
});
test("Late save after logout does not show account result or recover secret fields", async (t) => {
  const { w, expire, resolveSave } = await fixture(t, { deferredSave: true });
  credentials(w);
  submit(w);
  expire();
  resolveSave();
  await tick();
  assert.equal(w.document.getElementById("site-account-password").value, "");
  assert.equal(w.document.getElementById("site-account-pin").value, "");
  assert.ok(
    !w.document
      .getElementById("site-account-config-state")
      .textContent.includes("저장됨"),
  );
});
test("Leaving settings stops login polling; deferred result shows retry time without auto retry", async (t) => {
  const { w, calls } = await fixture(t, {
    configured: true,
    testState: "deferred",
  });
  const initialReads = calls.filter((call) =>
    call.path.startsWith("/api/site-account/test?"),
  ).length;
  click(w, "site-account-test");
  await tick();
  w.document.getElementById("settings-view").hidden = true;
  w.document.dispatchEvent(
    new w.CustomEvent("collector:view", { detail: "queue" }),
  );
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal(
    calls.filter((call) => call.path.startsWith("/api/site-account/test?"))
      .length,
    initialReads,
  );
  w.document.getElementById("settings-view").hidden = false;
  w.document.dispatchEvent(
    new w.CustomEvent("collector:view", { detail: "settings" }),
  );
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.match(
    w.document.getElementById("site-account-result").textContent,
    /다음 확인 가능 시각/,
  );
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal(
    calls.filter((call) => call.path === "/api/site-account/test").length,
    1,
  );
  assert.equal(
    calls.filter((call) => call.path.startsWith("/api/site-account/test?"))
      .length,
    initialReads + 1,
  );
});
