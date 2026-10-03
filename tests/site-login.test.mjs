import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { getEventListeners } from "node:events";
import { ensureSiteLogin, ensureSiteLoginDom } from "../src/site-login.mjs";

const credentials = {
  host: "newtoki1.org",
  username: "example_user",
  password: "unit-test-only-password",
  pin: "5286",
};
const markup =
  '<header><li class="theme-header-login"><a href="#login" data-auth-open="login">로그인</a></li></header><dialog id="auth-modal"><div data-auth-panel="login"><form action="/api/auth/login"><input name="username"><input name="password" type="password"><input name="remember" type="checkbox" checked><button type="submit">로그인</button></form></div><div data-auth-panel="pin" hidden><h3 data-pin-title>2차 비밀번호 입력</h3><div data-pin-grid></div></div></dialog>';
const visible = (element) => {
  for (let node = element; node?.nodeType === 1; node = node.parentElement)
    if (node.hidden || (node.tagName === "DIALOG" && !node.open)) return false;
  return true;
};
function pageFixture(
  t,
  {
    existing = false,
    badCredentials = false,
    challenge = false,
    unsupportedPin = false,
  } = {},
) {
  const dom = new JSDOM(markup, {
    url: "https://newtoki1.org/novel/21104/111",
  });
  t.after(() => dom.window.close());
  const doc = dom.window.document,
    actions = [],
    digits = [];
  let round = 0,
    currentUrl = doc.URL;
  const member = () => {
    doc.querySelector("header").innerHTML =
      "<button data-theme-user-toggle>회원 메뉴</button>";
    doc.querySelector("dialog").open = false;
  };
  if (existing) member();
  if (challenge) doc.title = "Just a moment...";
  function shuffle() {
    const order = ["7", "0", "8", "3", "1", "9", "6", "4", "2", "5"];
    const rotated = [...order.slice(round), ...order.slice(0, round)];
    doc.querySelector("[data-pin-grid]").innerHTML = rotated
      .map((value) => `<button type="button" data-pin-key>${value}</button>`)
      .join("");
    round = (round + 1) % order.length;
  }
  const page = {
    url: () => currentUrl,
    async evaluate(fn) {
      return fn(doc);
    },
    locator(selector) {
      function locator(regex = null, first = false) {
        const nodes = () =>
          [...doc.querySelectorAll(selector.replaceAll(":visible", ""))]
            .filter((node) => !selector.includes(":visible") || visible(node))
            .filter((node) => !regex || regex.test(node.textContent));
        return {
          first: () => locator(regex, true),
          filter: ({ hasText }) => locator(hasText, first),
          async count() {
            return first ? Math.min(1, nodes().length) : nodes().length;
          },
          async fill(value) {
            const node = nodes()[0];
            assert.ok(node && visible(node));
            node.value = value;
            actions.push(["fill", node.name, value]);
          },
          async click() {
            const node = nodes()[0];
            assert.ok(node && visible(node));
            actions.push(["click", node.textContent]);
            if (node.matches("[data-auth-open]"))
              doc.querySelector("dialog").open = true;
            else if (node.type === "submit") {
              if (badCredentials) {
                const error = doc.createElement("p");
                error.className = "auth-error";
                error.textContent = "서버 상세 오류";
                doc.querySelector("form").appendChild(error);
              } else {
                doc.querySelector("[data-auth-panel=login]").hidden = true;
                doc.querySelector("[data-auth-panel=pin]").hidden = false;
                if (unsupportedPin)
                  doc.querySelector("[data-pin-title]").textContent =
                    "새 PIN 설정";
                shuffle();
              }
            } else if (node.matches("[data-pin-key]")) {
              digits.push(node.textContent);
              shuffle();
              if (digits.length === 4) member();
            }
          },
        };
      }
      return locator();
    },
    setUrl(url) {
      currentUrl = url;
    },
  };
  return { page, doc, actions, digits };
}

test("normal form login uses shuffled digit labels, preserves remember checkbox and returns no secrets", async (t) => {
  const f = pageFixture(t);
  const result = await ensureSiteLoginDom({ page: f.page, credentials });
  assert.deepEqual(result, { authenticated: true, reused: false });
  assert.deepEqual(f.digits, ["5", "2", "8", "6"]);
  assert.equal(f.doc.querySelector("[name=remember]").checked, true);
  assert.equal(f.actions.filter((action) => action[0] === "fill").length, 2);
  assert.ok(!JSON.stringify(result).includes(credentials.password));
});

test("already logged-in member session is reused without entering credentials", async (t) => {
  const f = pageFixture(t, { existing: true });
  assert.deepEqual(await ensureSiteLoginDom({ page: f.page, credentials }), {
    authenticated: true,
    reused: true,
  });
  assert.deepEqual(f.actions, []);
});

test("CAPTCHA or challenge detection prevents every form interaction", async (t) => {
  const f = pageFixture(t, { challenge: true });
  await assert.rejects(
    ensureSiteLoginDom({ page: f.page, credentials }),
    (error) => error.code === "NEEDS_ATTENTION" && error.kind === "captcha",
  );
  assert.deepEqual(f.actions, []);
});

test("expired login remains one attempt; bad credentials and unsupported PIN require human attention", async (t) => {
  const bad = pageFixture(t, { badCredentials: true });
  await assert.rejects(
    ensureSiteLoginDom({ page: bad.page, credentials, timeoutMs: 1000 }),
    { code: "NEEDS_ATTENTION" },
  );
  assert.equal(
    bad.actions.filter(
      (action) => action[0] === "click" && action[1] === "로그인",
    ).length,
    2,
  ); // Header open and one form submission.
  const change = pageFixture(t, { unsupportedPin: true });
  await assert.rejects(
    ensureSiteLoginDom({ page: change.page, credentials }),
    (error) => error.code === "NEEDS_ATTENTION" && error.kind === "unsupported",
  );
  assert.deepEqual(change.digits, []);
});

test("foreign navigation, aborts and raw browser errors never expose runtime passwords or PIN", async (t) => {
  const redirected = pageFixture(t);
  redirected.page.setUrl("https://other.example/login");
  await assert.rejects(
    ensureSiteLoginDom({ page: redirected.page, credentials }),
    { code: "NEEDS_ATTENTION" },
  );
  assert.deepEqual(redirected.actions, []);
  const aborted = pageFixture(t),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    ensureSiteLoginDom({
      page: aborted.page,
      credentials,
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  assert.deepEqual(aborted.actions, []);
  const failure = pageFixture(t);
  failure.page.locator = () => ({
    first() {
      return this;
    },
    async click() {
      throw new Error(`${credentials.password} ${credentials.pin}`);
    },
  });
  await assert.rejects(
    ensureSiteLoginDom({ page: failure.page, credentials }),
    (error) =>
      error.code === "NEEDS_ATTENTION" &&
      !error.message.includes(credentials.password) &&
      !error.message.includes(credentials.pin),
  );
});

function httpFixture(
  t,
  {
    existing = false,
    challenge = false,
    firstStatus = 200,
    secondStatus = 200,
    ttlSec = 300,
    badPin = false,
    requestError = false,
    retryAfter = "600",
  } = {},
) {
  const f = pageFixture(t, { existing, challenge }),
    posts = [],
    dnsChecks = [];
  let pendingSequence = 0;
  f.page.context = () => ({
    request: {
      async post(url, options) {
        posts.push({ url, options });
        if (requestError)
          throw new Error(
            `${credentials.password} ${credentials.pin} cookie=private`,
          );
        const first = url.endsWith("/login");
        return {
          status: () => (first ? firstStatus : secondStatus),
          headers: async () => ({ "retry-after": retryAfter }),
          async json() {
            return first
              ? {
                  ok: true,
                  next: "pin-verify",
                  pendingToken: `test-generated-attempt-${++pendingSequence}`,
                  pinLength: 4,
                  ttlSec,
                }
              : {
                  ok: !badPin,
                  user: badPin ? null : { id: 1, username: "example_user" },
                };
          },
          async dispose() {},
        };
      },
    },
  });
  const validateHost = async (host) => {
    dnsChecks.push(host);
    return true;
  };
  return { ...f, posts, dnsChecks, validateHost };
}

test("daily quota CAPTCHA blocks normal HTTP and DOM login even for an already logged-in member", async (t) => {
  for (const existing of [false, true]) {
    const f = httpFixture(t, { existing });
    const host = f.doc.createElement("div");
    host.setAttribute("data-theme-novel-content", "");
    host.innerHTML =
      '<div class="wr-none">일일 조회 인증이 필요합니다. 일반 소설 뷰어에서 인증 후 다시 열어주세요.</div>';
    f.doc.body.append(host);
    await assert.rejects(
      ensureSiteLogin({
        page: f.page,
        credentials,
        validateHost: f.validateHost,
      }),
      { code: "NEEDS_ATTENTION", attentionKind: "captcha" },
    );
    assert.equal(f.posts.length, 0);
    assert.equal(f.dnsChecks.length, 0);
    await assert.rejects(ensureSiteLoginDom({ page: f.page, credentials }), {
      code: "NEEDS_ATTENTION",
      attentionKind: "captcha",
    });
    assert.deepEqual(f.actions, []);
  }
});

test("default HTTP login uses only two documented endpoints and the same context jar with fresh one-use pending token", async (t) => {
  const f = httpFixture(t);
  const one = await ensureSiteLogin({
    page: f.page,
    credentials,
    validateHost: f.validateHost,
  });
  assert.deepEqual(one, { authenticated: true, reused: false });
  assert.equal(f.posts.length, 2);
  assert.deepEqual(f.posts[0].options.data, {
    username: credentials.username,
    password: credentials.password,
    remember: "on",
  });
  assert.deepEqual(f.posts[1].options.data, {
    pendingToken: "test-generated-attempt-1",
    pin: credentials.pin,
  });
  for (const post of f.posts) {
    assert.equal(post.options.maxRedirects, 0);
    assert.equal(post.options.maxRetries, 0);
    assert.equal(post.options.ignoreHTTPSErrors, false);
    assert.ok(
      !Object.keys(post.options.headers).some((key) =>
        /cookie|user-agent/i.test(key),
      ),
    );
    assert.equal(post.options.headers.Origin, "https://newtoki1.org");
  }
  assert.equal(f.dnsChecks.length, 2);
  await ensureSiteLogin({
    page: f.page,
    credentials,
    validateHost: f.validateHost,
  });
  assert.equal(
    f.posts[3].options.data.pendingToken,
    "test-generated-attempt-2",
  );
  assert.ok(!JSON.stringify(one).includes("pendingToken"));
  assert.deepEqual(f.actions, []);
});

test("HTTP mode skips valid sessions and blocks CAPTCHA, redirect, private DNS and rejected PIN without retry", async (t) => {
  const member = httpFixture(t, { existing: true });
  assert.equal(
    (
      await ensureSiteLogin({
        page: member.page,
        credentials,
        validateHost: member.validateHost,
      })
    ).reused,
    true,
  );
  assert.equal(member.posts.length, 0);
  const captcha = httpFixture(t, { challenge: true });
  await assert.rejects(
    ensureSiteLogin({
      page: captcha.page,
      credentials,
      validateHost: captcha.validateHost,
    }),
    { kind: "captcha" },
  );
  assert.equal(captcha.posts.length, 0);
  const redirect = httpFixture(t, { firstStatus: 302 });
  await assert.rejects(
    ensureSiteLogin({
      page: redirect.page,
      credentials,
      validateHost: redirect.validateHost,
    }),
    { kind: "unsupported" },
  );
  assert.equal(redirect.posts.length, 1);
  const privateDns = httpFixture(t);
  await assert.rejects(
    ensureSiteLogin({
      page: privateDns.page,
      credentials,
      validateHost: async () => false,
    }),
    { kind: "unsupported" },
  );
  assert.equal(privateDns.posts.length, 0);
  const rejected = httpFixture(t, { badPin: true });
  await assert.rejects(
    ensureSiteLogin({
      page: rejected.page,
      credentials,
      validateHost: rejected.validateHost,
    }),
    { kind: "pin" },
  );
  assert.equal(rejected.posts.length, 2);
});

test("HTTP rate limits cap retry delay; raw errors, aborts and expired pending token are sanitized", async (t) => {
  const rate = httpFixture(t, { firstStatus: 429 });
  await assert.rejects(
    ensureSiteLogin({
      page: rate.page,
      credentials,
      validateHost: rate.validateHost,
    }),
    (error) =>
      error.kind === "rate" &&
      error.httpStatus === 429 &&
      error.retryAfterMs === 600000,
  );
  assert.equal(rate.posts.length, 1);
  const failure = httpFixture(t, { requestError: true });
  await assert.rejects(
    ensureSiteLogin({
      page: failure.page,
      credentials,
      validateHost: failure.validateHost,
    }),
    (error) =>
      !error.message.includes(credentials.password) &&
      !error.message.includes(credentials.pin),
  );
  const stopped = httpFixture(t),
    controller = new AbortController();
  controller.abort();
  await assert.rejects(
    ensureSiteLogin({
      page: stopped.page,
      credentials,
      validateHost: stopped.validateHost,
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(stopped.posts.length, 0);
  const expired = httpFixture(t, { ttlSec: 1 });
  let checks = 0;
  await assert.rejects(
    ensureSiteLogin({
      page: expired.page,
      credentials,
      timeoutMs: 4000,
      validateHost: async () => {
        if (++checks === 2)
          await new Promise((resolve) => setTimeout(resolve, 1100));
        return true;
      },
    }),
    { kind: "timeout" },
  );
  assert.equal(expired.posts.length, 1);
});

test("HTTP attempt has a total time budget and cleans abort listeners even if a request never settles", async (t) => {
  const f = httpFixture(t),
    controller = new AbortController();
  f.page.context = () => ({
    request: {
      async post() {
        return new Promise(() => {});
      },
    },
  });
  await assert.rejects(
    ensureSiteLogin({
      page: f.page,
      credentials,
      validateHost: f.validateHost,
      signal: controller.signal,
      timeoutMs: 100,
    }),
    { kind: "timeout" },
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("server Retry-After above ten minutes is respected with a 24-hour maximum guard", async (t) => {
  const longer = httpFixture(t, { firstStatus: 429, retryAfter: "900" });
  await assert.rejects(
    ensureSiteLogin({
      page: longer.page,
      credentials,
      validateHost: longer.validateHost,
    }),
    (error) => error.httpStatus === 429 && error.retryAfterMs === 900000,
  );
  assert.equal(longer.posts.length, 1);
  const extreme = httpFixture(t, { firstStatus: 429, retryAfter: "99999999" });
  await assert.rejects(
    ensureSiteLogin({
      page: extreme.page,
      credentials,
      validateHost: extreme.validateHost,
    }),
    (error) => error.retryAfterMs === 86400000,
  );
});
