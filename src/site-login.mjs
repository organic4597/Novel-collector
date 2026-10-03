import { lookup } from "node:dns/promises";
import { readReaderDocument, isPublicAddress } from "./collector.mjs";
import { siteAccountHost } from "./site-accounts.mjs";
import { parseRetryAfter } from "./retry-after.mjs";

const OWN_ERROR = Symbol("site-login-error");
const LOGIN = '#auth-modal [data-auth-panel="login"]';
const PIN = '#auth-modal [data-auth-panel="pin"]';
const HEADER_LOGIN =
  '.theme-header-login a[href$="#login"]:visible, header a[data-auth-open="login"]:visible, .main-header a[data-auth-open="login"]:visible';
const attention = (kind, message) =>
  Object.assign(new Error(message), {
    code: "NEEDS_ATTENTION",
    status: 409,
    kind,
    attentionKind:
      kind === "captcha"
        ? "captcha"
        : kind === "unsupported"
          ? "site_blocked"
          : "authentication",
    [OWN_ERROR]: true,
  });
const aborted = () =>
  Object.assign(new Error("사이트 로그인 확인이 중단됐습니다."), {
    name: "AbortError",
    code: "ABORTED",
    [OWN_ERROR]: true,
  });

// Only public UI state is returned. Input values, cookies and session storage are never read.
export function readLoginDocument(doc = document) {
  const visible = (element) => {
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      if (
        node.hidden ||
        node.getAttribute("aria-hidden") === "true" ||
        (node.tagName === "DIALOG" && !node.open)
      )
        return false;
      const style = doc.defaultView?.getComputedStyle?.(node);
      if (style?.display === "none" || style?.visibility === "hidden")
        return false;
    }
    return !!element;
  };
  const any = (selector) => [...doc.querySelectorAll(selector)].some(visible);
  const headerGuest = any(
    '.theme-header-login a[href$="#login"], header a[data-auth-open="login"], .main-header a[data-auth-open="login"]',
  );

  const member = any(
    'header .header-user-row, header [data-theme-user-toggle], .main-header [data-theme-user-toggle], .theme-header-user [data-theme-user-toggle], header a[href*="logout"], .main-header a[href*="logout"], header [data-auth-logout], .main-header [data-auth-logout]',
  );
  const modalVisible = visible(doc.querySelector("#auth-modal"));
  const login = doc.querySelector('#auth-modal [data-auth-panel="login"]');
  const pin = doc.querySelector('#auth-modal [data-auth-panel="pin"]');
  const loginVisible = visible(login),
    pinVisible = visible(pin);
  let sameOriginForm = false;
  const form = login?.querySelector("form");
  if (form) {
    try {
      sameOriginForm =
        new URL(form.getAttribute("action"), doc.URL).origin ===
        new URL(doc.URL).origin;
    } catch {}
  }
  const errors = [
    ...doc.querySelectorAll(
      "#auth-modal .auth-error, #auth-modal [data-login-error], #auth-modal [data-pin-error]",
    ),
  ];
  return {
    headerGuest,
    authenticated: member && !headerGuest && !modalVisible,
    loginVisible,
    pinVisible,
    sameOriginForm,
    formSupported:
      !!login?.querySelector('input[name="username"]') &&
      !!login?.querySelector('input[name="password"]') &&
      !!login?.querySelector('button[type="submit"]'),
    error: errors.some(
      (element) => visible(element) && element.textContent.trim(),
    ),
    unsupported:
      any(
        '#auth-modal input[autocomplete="one-time-code"], #auth-modal input[name="otp"], #auth-modal [data-auth-panel="otp"]',
      ) ||
      (pinVisible &&
        /새.{0,5}(?:PIN|비밀번호)|(?:PIN|비밀번호).{0,5}(?:설정|변경)|인증.?코드|OTP/i.test(
          pin.querySelector("[data-pin-title]")?.textContent || "",
        )),
  };
}

function budget(deadline, signal, assertAllowed) {
  return (operation) => {
    assertAllowed();
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (success, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (success) resolve(value);
        else reject(value);
      };
      const onAbort = () => finish(false, aborted());
      const timer = setTimeout(
        () =>
          finish(
            false,
            attention(
              "timeout",
              "사이트 로그인 확인 시간이 지났습니다. 화면에서 직접 확인하세요.",
            ),
          ),
        Math.max(1, deadline - Date.now()),
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(() => {
          assertAllowed();
          return operation();
        })
        .then(
          (value) => finish(true, value),
          (error) => finish(false, error),
        );
    });
  };
}

export async function ensureSiteLoginDom({
  page,
  credentials,
  signal,
  timeoutMs = 20000,
}) {
  try {
    const host = siteAccountHost(credentials?.host);
    if (
      !credentials ||
      typeof credentials.username !== "string" ||
      credentials.username.length < 3 ||
      credentials.username.length > 20 ||
      typeof credentials.password !== "string" ||
      !credentials.password ||
      credentials.password.length > 4096 ||
      !/^\d{4}$/.test(credentials.pin) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 60000
    )
      throw attention("unsupported", "저장된 사이트 계정 설정을 확인하세요.");
    const deadline = Date.now() + timeoutMs;
    const assertAllowed = () => {
      if (signal?.aborted) throw aborted();
      let url;
      try {
        url = new URL(page.url());
      } catch {}
      if (
        !url ||
        url.protocol !== "https:" ||
        url.hostname !== host ||
        url.username ||
        url.password ||
        url.port
      )
        throw attention(
          "unsupported",
          "허용한 사이트에서 로그인 화면을 다시 여세요.",
        );
      if (Date.now() >= deadline)
        throw attention(
          "timeout",
          "사이트 로그인 확인 시간이 지났습니다. 화면에서 직접 확인하세요.",
        );
    };
    const bounded = budget(deadline, signal, assertAllowed);
    const readState = async () => {
      assertAllowed();
      const reader = await bounded(() => page.evaluate(readReaderDocument));
      if (reader.challenge || reader.verificationKind === "captcha")
        throw attention(
          "captcha",
          "사이트 보안 확인이 표시됐습니다. 인증 화면에서 직접 확인하세요.",
        );
      const state = await bounded(() => page.evaluate(readLoginDocument));
      if (state.unsupported)
        throw attention(
          "unsupported",
          "추가 인증이나 PIN 변경은 사이트 화면에서 직접 진행하세요.",
        );
      if (state.error)
        throw attention(
          "login",
          "사이트 로그인이 승인되지 않았습니다. 계정 설정이나 인증 화면을 확인하세요.",
        );
      return state;
    };
    const poll = async (predicate) => {
      while (true) {
        const state = await readState();
        if (predicate(state)) return state;
        await bounded(
          () =>
            new Promise((resolve) =>
              setTimeout(
                resolve,
                Math.min(100, Math.max(1, deadline - Date.now())),
              ),
            ),
        );
      }
    };
    const click = async (locator) => {
      await readState();
      await bounded(() =>
        locator.click({ timeout: Math.max(1, deadline - Date.now()) }),
      );
    };
    let state = await readState();
    if (state.authenticated) return { authenticated: true, reused: true };
    if (!state.loginVisible && !state.pinVisible) {
      if (!state.headerGuest)
        throw attention(
          "unsupported",
          "지원하는 사이트 로그인 버튼을 찾지 못했습니다. 화면에서 직접 확인하세요.",
        );
      await click(page.locator(HEADER_LOGIN).first());
      state = await poll(
        (value) =>
          value.loginVisible || value.pinVisible || value.authenticated,
      );
    }
    if (state.authenticated) return { authenticated: true, reused: false };
    if (state.loginVisible) {
      if (!state.formSupported || !state.sameOriginForm)
        throw attention(
          "unsupported",
          "지원하는 사이트 로그인 입력창을 확인하세요.",
        );
      await readState();
      await bounded(() =>
        page
          .locator(`${LOGIN} input[name="username"]:visible`)
          .fill(credentials.username, {
            timeout: Math.max(1, deadline - Date.now()),
          }),
      );
      await readState();
      await bounded(() =>
        page
          .locator(`${LOGIN} input[name="password"]:visible`)
          .fill(credentials.password, {
            timeout: Math.max(1, deadline - Date.now()),
          }),
      );
      await click(page.locator(`${LOGIN} button[type="submit"]:visible`));
      state = await poll((value) => value.pinVisible || value.authenticated);
    }
    if (state.pinVisible) {
      for (const digit of credentials.pin) {
        await readState();
        const key = page
          .locator(`${PIN} [data-pin-key]:visible`)
          .filter({ hasText: new RegExp(`^\s*${digit}\s*$`) });
        if ((await bounded(() => key.count())) !== 1)
          throw attention(
            "unsupported",
            "사이트 PIN 키패드를 확인하세요. 화면에서 직접 입력할 수 있습니다.",
          );
        await click(key);
      }
    }
    await poll((value) => value.authenticated);
    return { authenticated: true, reused: false };
  } catch (error) {
    if (error[OWN_ERROR]) throw error;
    if (signal?.aborted) throw aborted();
    throw attention(
      "login",
      "사이트 로그인 확인을 완료하지 못했습니다. 계정 설정이나 인증 화면을 확인하세요.",
    );
  }
}

async function publicHost(host) {
  const addresses = await lookup(host, { all: true });
  return (
    addresses.length > 0 &&
    addresses.every(({ address }) => isPublicAddress(address))
  );
}

// Uses the site's explicitly supplied normal login API and the active BrowserContext cookie jar.
// Fresh pending tokens exist only inside this one attempt and are never returned or persisted.
export async function ensureSiteLogin({
  page,
  credentials,
  signal,
  timeoutMs = 20000,
  validateHost = publicHost,
}) {
  try {
    const host = siteAccountHost(credentials?.host);
    if (
      typeof credentials?.username !== "string" ||
      credentials.username.length < 3 ||
      credentials.username.length > 20 ||
      typeof credentials.password !== "string" ||
      !credentials.password ||
      credentials.password.length > 4096 ||
      !/^\d{4}$/.test(credentials.pin) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 60000
    )
      throw attention("unsupported", "저장된 사이트 계정 설정을 확인하세요.");
    const deadline = Date.now() + timeoutMs;
    const assertAllowed = () => {
      if (signal?.aborted) throw aborted();
      let url;
      try {
        url = new URL(page.url());
      } catch {}
      if (
        !url ||
        url.protocol !== "https:" ||
        url.hostname !== host ||
        url.username ||
        url.password ||
        url.port
      )
        throw attention(
          "unsupported",
          "허용한 사이트에서 로그인 화면을 다시 여세요.",
        );
      if (Date.now() >= deadline)
        throw attention(
          "timeout",
          "사이트 로그인 확인 시간이 지났습니다. 화면에서 직접 확인하세요.",
        );
      return url;
    };
    const bounded = budget(deadline, signal, assertAllowed);
    const guard = async () => {
      assertAllowed();
      const reader = await bounded(() => page.evaluate(readReaderDocument));
      if (reader.challenge || reader.verificationKind === "captcha")
        throw attention(
          "captcha",
          "사이트 보안 확인이 표시됐습니다. 인증 화면에서 직접 확인하세요.",
        );
    };
    await guard();
    const state = await bounded(() => page.evaluate(readLoginDocument));
    if (state.authenticated) return { authenticated: true, reused: true };
    if (state.unsupported)
      throw attention(
        "unsupported",
        "추가 인증이나 PIN 변경은 사이트 화면에서 직접 진행하세요.",
      );
    if (!state.headerGuest && !state.loginVisible && !state.pinVisible)
      throw attention(
        "unsupported",
        "사이트 로그인 상태를 확인할 수 없습니다. 인증 화면에서 직접 확인하세요.",
      );
    const request = page.context().request;
    const post = async (path, data, pendingExpiresAt = null) => {
      await guard();
      if (!(await bounded(() => validateHost(host))))
        throw attention(
          "unsupported",
          "사이트 연결 주소를 확인할 수 없습니다. 서버 연결을 확인하세요.",
        );
      const url = assertAllowed();
      if (pendingExpiresAt !== null && Date.now() >= pendingExpiresAt)
        throw attention(
          "timeout",
          "사이트 로그인 확인 시간이 지났습니다. 다시 확인하세요.",
        );
      const response = await bounded(() =>
        request.post(`${url.origin}${path}`, {
          headers: {
            Accept: "application/json",
            Origin: url.origin,
            Referer: url.origin + url.pathname,
          },
          data,
          timeout: Math.min(15000, Math.max(1, deadline - Date.now())),
          signal,
          maxRedirects: 0,
          maxRetries: 0,
          ignoreHTTPSErrors: false,
        }),
      );
      try {
        const status = response.status();
        if (status === 429) {
          const error = attention(
            "rate",
            "사이트 요청 제한이 표시됐습니다. 잠시 대기하거나 인증 화면을 직접 확인하세요.",
          );
          error.httpStatus = 429;
          const headers = await response.headers();
          error.retryAfterMs = Math.min(
            86400000,
            Math.max(600000, parseRetryAfter(headers["retry-after"]) || 600000),
          );
          throw error;
        }
        if (status >= 300 && status < 400)
          throw attention(
            "unsupported",
            "사이트 로그인 주소가 변경됐습니다. 인증 화면에서 직접 확인하세요.",
          );
        if (status < 200 || status >= 300)
          throw attention(
            "login",
            "사이트 로그인이 승인되지 않았습니다. 계정 설정이나 인증 화면을 확인하세요.",
          );
        return await bounded(() => response.json());
      } finally {
        await response.dispose?.();
      }
    };
    const login = await post("/api/auth/login", {
      username: credentials.username,
      password: credentials.password,
      remember: "on",
    });
    if (
      login?.ok !== true ||
      login.next !== "pin-verify" ||
      login.pinLength !== 4 ||
      typeof login.pendingToken !== "string" ||
      !login.pendingToken ||
      login.pendingToken.length > 4096 ||
      !Number.isFinite(login.ttlSec) ||
      login.ttlSec <= 0 ||
      login.ttlSec > 300
    )
      throw attention(
        "login",
        "사이트 로그인이 승인되지 않았습니다. 계정 설정이나 인증 화면을 확인하세요.",
      );
    const expiresAt = Date.now() + login.ttlSec * 1000;
    assertAllowed();
    if (Date.now() >= expiresAt)
      throw attention(
        "timeout",
        "사이트 로그인 확인 시간이 지났습니다. 다시 확인하세요.",
      );
    const pin = await post(
      "/api/auth/login-pin",
      { pendingToken: login.pendingToken, pin: credentials.pin },
      expiresAt,
    );
    if (pin?.ok !== true || !pin.user || typeof pin.user !== "object")
      throw attention(
        "pin",
        "사이트 PIN 인증이 승인되지 않았습니다. 계정 설정이나 인증 화면을 확인하세요.",
      );
    return { authenticated: true, reused: false };
  } catch (error) {
    if (error[OWN_ERROR]) throw error;
    if (signal?.aborted) throw aborted();
    throw attention(
      "login",
      "사이트 로그인 확인을 완료하지 못했습니다. 계정 설정이나 인증 화면을 확인하세요.",
    );
  }
}
