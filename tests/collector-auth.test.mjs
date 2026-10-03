import test from "node:test";
import assert from "node:assert/strict";
import { Collector } from "../src/collector.mjs";
const url = "https://newtoki1.org/novel/1/10";
function fakePage(reader, options = {}) {
  const visits = [];
  return {
    visits,
    goto: async (target) => {
      visits.push(target);
      return { status: () => options.status || 200 };
    },
    url: () => url,
    evaluate: async () => (typeof reader === "function" ? reader() : reader),
  };
}
test("configured preflight authenticates once and reloads the original trusted page", async () => {
  let authenticated = false,
    attempts = 0;
  const events = [];
  const page = fakePage(() =>
    authenticated
      ? { text: "정상 본문", challenge: false }
      : {
          verificationRequired: true,
          verificationReason: "로그인이 필요합니다.",
          challenge: false,
        },
  );
  const collector = new Collector({
    profileDir: "unused",
    authenticatePage: async () => {
      attempts++;
      authenticated = true;
      return { authenticated: true, reused: false };
    },
    onAuthEvent: async (message) => events.push(message),
  });
  assert.equal(await collector.chapterText(page, { url }), "정상 본문");
  assert.deepEqual(page.visits, [url, url]);
  assert.equal(attempts, 1);
  assert.ok(events.length);
  await collector.navigate(page, url);
  assert.equal(attempts, 1);
  assert.equal(page.visits.length, 3);
});
test("existing member sessions are reused without an extra browser navigation", async () => {
  let attempts = 0;
  const page = fakePage({ text: "이미 로그인한 본문", challenge: false });
  const collector = new Collector({
    profileDir: "unused",
    authenticatePage: async () => {
      attempts++;
      return { authenticated: true, reused: true };
    },
  });
  await collector.navigate(page, url);
  await collector.navigate(page, url);
  assert.equal(attempts, 1);
  assert.equal(page.visits.length, 2);
});
test("CAPTCHA is checked before any configured login callback", async () => {
  let attempts = 0;
  const page = fakePage({ challenge: true });
  const collector = new Collector({
    profileDir: "unused",
    authenticatePage: async () => {
      attempts++;
      return { authenticated: true };
    },
  });
  await assert.rejects(
    collector.navigate(page, url),
    (problem) =>
      problem.code === "NEEDS_ATTENTION" && problem.attentionKind === "captcha",
  );
  assert.equal(attempts, 0);
  assert.equal(page.visits.length, 1);
});
test("login failures and unchanged authentication notices never loop or expose callback secrets", async () => {
  let attempts = 0;
  const page = fakePage({ verificationRequired: true, notice: "인증 필요" });
  const collector = new Collector({
    profileDir: "unused",
    authenticatePage: async () => {
      attempts++;
      throw new Error("private password and PIN");
    },
  });
  await assert.rejects(
    collector.navigate(page, url),
    (problem) =>
      problem.attentionKind === "authentication" &&
      !/password|PIN/.test(problem.message),
  );
  assert.equal(attempts, 1);
  assert.equal(page.visits.length, 1);
  const unchanged = new Collector({
    profileDir: "unused",
    authenticatePage: async () => ({ authenticated: true, reused: false }),
  });
  await assert.rejects(
    unchanged.navigate(page, url),
    (problem) => problem.attentionKind === "authentication",
  );
  assert.equal(page.visits.length, 3);
});
test("a session expiring later in body polling can authenticate once for that navigation", async () => {
  let member = true,
    reads = 0,
    attempts = 0;
  const page = fakePage(() => {
    reads++;
    if (reads < 2) return { text: "", challenge: false };
    return member
      ? { text: "세션 복구 본문", challenge: false }
      : {
          verificationRequired: true,
          notice: "로그인 후 다시 이용하세요",
          challenge: false,
        };
  });
  const collector = new Collector({
    profileDir: "unused",
    authenticatePage: async () => {
      attempts++;
      member = true;
      return { authenticated: true, reused: false };
    },
  });
  collector.authenticationChecked = true;
  member = false;
  assert.equal(await collector.chapterText(page, { url }), "세션 복구 본문");
  assert.equal(attempts, 1);
  assert.deepEqual(page.visits, [url, url]);
});
test("null disabled callbacks skip login and aborts stop before authenticated reload", async () => {
  let attempts = 0;
  const page = fakePage({ verificationRequired: true, notice: "인증 필요" });
  const disabled = new Collector({
    profileDir: "unused",
    authenticatePage: async () => {
      attempts++;
      return null;
    },
  });
  await assert.rejects(
    disabled.navigate(page, url),
    (problem) => problem.attentionKind === "authentication",
  );
  assert.equal(attempts, 1);
  const controller = new AbortController();
  const aborted = new Collector({
    profileDir: "unused",
    authenticatePage: async () => {
      controller.abort();
      return { authenticated: true, reused: false };
    },
  });
  await assert.rejects(
    aborted.navigate(page, url, controller.signal),
    (problem) => problem.name === "AbortError",
  );
  assert.equal(page.visits.length, 2);
});
test("forked workers retain auth hooks and opening a new context resets the one-time budget", async () => {
  let attempts = 0;
  const authenticatePage = async () => {
    attempts++;
    return { authenticated: true, reused: true };
  };
  const collector = new Collector({
    profileDir: "unused",
    authenticatePage,
    launchContext: async () => ({ close: async () => {} }),
  });
  const fork = collector.fork(1);
  assert.equal(fork.authenticatePage, authenticatePage);
  const page = fakePage({ text: "본문", challenge: false });
  await collector.navigate(page, url);
  await collector.openContext();
  await collector.navigate(page, url);
  assert.equal(attempts, 2);
});
test("late authentication success that leaves an unchanged login notice cannot try login twice", async () => {
  let reads = 0,
    attempts = 0;
  const page = fakePage(() =>
    ++reads === 1
      ? { challenge: false, text: "" }
      : {
          verificationRequired: true,
          verificationKind: "authentication",
          notice: "로그인 인증 필요",
          challenge: false,
        },
  );
  const collector = new Collector({
    profileDir: "unused",
    authenticatePage: async () => {
      attempts++;
      return { authenticated: true, reused: false };
    },
  });
  collector.authenticationChecked = true;
  await assert.rejects(
    collector.chapterText(page, { url }),
    (error) => error.attentionKind === "authentication",
  );
  assert.equal(attempts, 1);
  assert.equal(page.visits.length, 2);
});
test("late daily quota CAPTCHA stops body polling before any login attempt or reload", async () => {
  let reads = 0,
    attempts = 0;
  const page = fakePage(() =>
    ++reads === 1
      ? { challenge: false, text: "" }
      : {
          text: "",
          challenge: false,
          verificationRequired: true,
          verificationKind: "captcha",
          verificationReason: "일일 조회 인증이 필요합니다.",
        },
  );
  const collector = new Collector({
    profileDir: "unused",
    authenticatePage: async () => {
      attempts++;
      return { authenticated: true, reused: false };
    },
  });
  collector.authenticationChecked = true;
  await assert.rejects(
    collector.chapterText(page, { url }),
    (error) =>
      error.code === "NEEDS_ATTENTION" &&
      error.attentionKind === "captcha" &&
      !error.retryAfterMs,
  );
  assert.equal(attempts, 0);
  assert.equal(page.visits.length, 1);
  assert.equal(reads, 2);
});
test("initial daily quota CAPTCHA skips configured authentication and cooldown", async () => {
  let attempts = 0;
  const page = fakePage({
    text: "",
    challenge: false,
    verificationRequired: true,
    verificationKind: "captcha",
    verificationReason: "일일 조회 인증이 필요합니다.",
  });
  const collector = new Collector({
    profileDir: "unused",
    authenticatePage: async () => {
      attempts++;
      return { authenticated: true, reused: false };
    },
  });
  await assert.rejects(
    collector.navigate(page, url),
    (error) =>
      error.code === "NEEDS_ATTENTION" &&
      error.attentionKind === "captcha" &&
      !error.retryAfterMs,
  );
  assert.equal(attempts, 0);
  assert.equal(page.visits.length, 1);
});
test("plain HTTP429 keeps its cooldown and never invokes authentication", async () => {
  let attempts = 0;
  const collector = new Collector({
    profileDir: "unused",
    authenticatePage: async () => {
      attempts++;
    },
  });
  for (const header of [null, "900"]) {
    const page = fakePage({ challenge: false }, { status: 429 });
    page.goto = async (target) => {
      page.visits.push(target);
      return { status: () => 429, headerValue: async () => header };
    };
    await assert.rejects(
      collector.navigate(page, url),
      (error) =>
        error.httpStatus === 429 &&
        error.retryAfterMs === (header ? 900000 : 600000),
    );
    assert.equal(page.visits.length, 1);
  }
  assert.equal(attempts, 0);
});
test("login endpoint rate limits preserve Retry-After and API CAPTCHA errors remain CAPTCHA", async () => {
  const page = fakePage({
    verificationRequired: true,
    notice: "로그인 필요",
    challenge: false,
  });
  const rate = new Collector({
    profileDir: "unused",
    authenticatePage: async () => {
      throw Object.assign(new Error("private response body"), {
        httpStatus: 429,
        retryAfterMs: 900000,
      });
    },
  });
  await assert.rejects(
    rate.navigate(page, url),
    (error) =>
      error.httpStatus === 429 &&
      error.retryAfterMs === 900000 &&
      !/private/.test(error.message),
  );
  const captcha = new Collector({
    profileDir: "unused",
    authenticatePage: async () => {
      throw Object.assign(new Error("private CAPTCHA payload"), {
        kind: "captcha",
      });
    },
  });
  await assert.rejects(
    captcha.navigate(page, url),
    (error) => error.attentionKind === "captcha",
  );
});
test("HTTP401 authenticates before failing the reader, while HTTP403 CAPTCHA stays manual", async () => {
  let member = false,
    attempts = 0;
  const page = fakePage(() => ({
    challenge: false,
    text: member ? "로그인 후 본문" : "",
    verificationRequired: !member,
  }));
  page.goto = async (target) => {
    page.visits.push(target);
    return { status: () => (member ? 200 : 401) };
  };
  const collector = new Collector({
    profileDir: "unused",
    authenticatePage: async () => {
      member = true;
      attempts++;
      return { authenticated: true, reused: false };
    },
  });
  assert.equal(await collector.chapterText(page, { url }), "로그인 후 본문");
  assert.equal(attempts, 1);
  assert.equal(page.visits.length, 2);
  const blocked = fakePage({ challenge: true }, { status: 403 });
  await assert.rejects(
    collector.navigate(blocked, url),
    (error) => error.attentionKind === "captcha",
  );
  assert.equal(attempts, 1);
});
test("an unsuccessful callback stays authentication attention while shared cooldown remains a deferral", async () => {
  const page = fakePage({ challenge: false, text: "" });
  const rejected = new Collector({
    profileDir: "unused",
    authenticatePage: async () => ({ authenticated: false }),
  });
  await assert.rejects(
    rejected.navigate(page, url),
    (error) => error.attentionKind === "authentication",
  );
  const cooldown = new Collector({
    profileDir: "unused",
    authenticatePage: async () => {
      throw Object.assign(new Error("원본 요청 대기 중"), {
        code: "REQUEST_BACKOFF",
        status: 503,
      });
    },
  });
  await assert.rejects(
    cooldown.navigate(page, url),
    (error) => error.code === "REQUEST_BACKOFF" && error.status === 503,
  );
});
