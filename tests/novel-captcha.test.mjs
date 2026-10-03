import test from "node:test";
import assert from "node:assert/strict";
import { NovelCaptcha, CAPTCHA_REQUIRED, parseChallenge } from "../src/novel-captcha.mjs";

const body = { ok: true, challenge: {
  challengeId: "test-challenge", background: "data:image/png;base64,YQ==",
  width: 320, height: 160, pieceWidth: 60, pieceHeight: 60, y: 51,
} };
const accepted = (c) => ({ challengeId: c.challengeId, targetX: 117.4,
  targetY: c.y, matchScore: 0.9, candidateMargin: 0.3, decision: "accept" });
function fixture(options = {}) {
  const calls = { create: 0, verify: 0, log: [] };
  const service = new NovelCaptcha({ analyze: async (c) => accepted(c),
    log: (event) => calls.log.push(event), ...options });
  const input = { session: { key: "session-a" }, requestId: "request-a",
    event: { source: "response", error: CAPTCHA_REQUIRED }, isCurrent: () => true,
    create: async () => { calls.create++; return { status: 200, body }; },
    verify: async (c, answer) => {
      calls.verify++;
      assert.equal(answer.x, 117);
      assert.equal(answer.y, 51);
      return { status: 200, challengeId: c.challengeId, body: { ok: true, token: "private-token", remaining: 50 } };
    },
  };
  return { service, input, calls };
}

test("ordinary responses and observable UI never start a challenge", async () => {
  const { service, input, calls } = fixture();
  for (const event of [null, { source: "response", error: "rate_limited" },
    { source: "ui", visible: true, responseObservable: true }])
    assert.equal((await service.handle({ ...input, event })).skipped, true);
  assert.equal(calls.create, 0);
  assert.equal(service.state(input.session), "IDLE");
});

test("same-session response and fallback signals share one flight and keep waiter IDs", async () => {
  const { service, input, calls } = fixture();
  const results = await Promise.all([
    service.handle(input),
    service.handle({ ...input, requestId: "request-b", event: { source: "ui", visible: true, responseObservable: false } }),
  ]);
  assert.equal(calls.create, 1);
  assert.equal(calls.verify, 1);
  assert.deepEqual(results.map((r) => r.requestId), ["request-a", "request-b"]);
  assert.ok(results.every((r) => r.ok && r.sessionKey === "session-a" && r.remaining === 50));
  assert.equal(service.state(input.session), "SUCCEEDED");
  assert.deepEqual(calls.log.map((r) => r.stage), ["CREATING", "ANALYZING", "VERIFYING", "SUCCEEDED"]);
  assert.ok(!JSON.stringify(calls.log).includes("private-token"));
});

test("different sessions never share a token or flight", async () => {
  const { service, input, calls } = fixture();
  const b = { ...input, session: { key: "session-b" }, verify: async (c) => ({
    status: 200, challengeId: c.challengeId, body: { ok: true, token: "token-b" },
  }) };
  const [a, other] = await Promise.all([service.handle(input), service.handle(b)]);
  assert.equal(calls.create, 2);
  assert.equal(a.captchaToken, "private-token");
  assert.equal(other.captchaToken, "token-b");
});

test("invalid challenge dimensions, missing fields and boolean values fail closed", () => {
  for (const patch of [{ width: "320" }, { y: -1 }, { y: 140 }, { pieceWidth: 320 }, { background: "bad" }])
    assert.throws(() => parseChallenge({ ...body, challenge: { ...body.challenge, ...patch } }), { code: "CREATE_INVALID_RESPONSE" });
  assert.throws(() => parseChallenge({ ...body, ok: 1 }), { code: "CREATE_INVALID_RESPONSE" });
  assert.equal(Object.isFrozen(parseChallenge(body)), true);
});

test("uncertain, foreign and out-of-bounds positions never submit", async () => {
  for (const patch of [{ decision: "abstain" }, { targetX: 300 }, { targetY: 52 }, { challengeId: "stale" }]) {
    const { service, input, calls } = fixture({ analyze: async (c) => ({ ...accepted(c), ...patch }) });
    assert.equal((await service.handle(input)).error.code, "POSITION_UNCERTAIN");
    assert.equal(calls.verify, 0);
  }
});

test("strict verification rejects malformed success, mismatched challenge and server refusal", async () => {
  for (const [reply, code] of [
    [{ body: { ok: 1, token: "t" } }, "VERIFY_REJECTED"],
    [{ body: { ok: true, token: "  " } }, "VERIFY_INVALID_RESPONSE"],
    [{ challengeId: "other", body: { ok: true, token: "t" } }, "VERIFY_RESULT_UNKNOWN"],
    [{ body: { ok: false, error: "too_fast" } }, "VERIFY_REJECTED"],
  ]) {
    const { service, input } = fixture();
    input.verify = async () => ({ status: 200, challengeId: "test-challenge", ...reply });
    const result = await service.handle(input);
    assert.equal(result.error.code, code);
    assert.equal(result.captchaToken, undefined);
    if (reply.body.error) assert.equal(result.error.serverError, "too_fast");
  }
});

test("timeout after submission is unknown, no retry, and releases single-flight lock", async () => {
  const { service, input, calls } = fixture({ timeoutMs: 20 });
  const verify = input.verify;
  input.verify = async () => { calls.verify++; return new Promise(() => {}); };
  assert.equal((await service.handle(input)).error.code, "VERIFY_RESULT_UNKNOWN");
  assert.equal(calls.verify, 1);
  input.verify = verify;
  assert.equal((await service.handle(input)).ok, true);
  assert.equal(calls.create, 2);
});

test("navigation during verification and stale waiters cannot receive tokens", async () => {
  const { service, input } = fixture();
  let current = true;
  input.isCurrent = () => current;
  const verify = input.verify;
  input.verify = async (...args) => { current = false; return verify(...args); };
  assert.equal((await service.handle(input)).error.code, "CONTEXT_CHANGED");
});

test("abort and expired challenge release locks without submission", async () => {
  const controller = new AbortController();
  const { service, input, calls } = fixture({ clock: () => 100000 });
  input.create = async () => ({ status: 200, body, receivedAt: 1 });
  assert.equal((await service.handle(input)).error.code, "CHALLENGE_EXPIRED");
  controller.abort();
  assert.equal((await service.handle({ ...input, signal: controller.signal })).error.code, "CANCELLED");
  assert.equal(calls.verify, 0);
});

test("missing create response and thrown create/verify failures have stage-specific safe codes", async () => {
  for (const [phase, reply, code] of [
    ["create", null, "CREATE_INVALID_RESPONSE"],
    ["create", new Error("cookie=private-cookie"), "CREATE_INVALID_RESPONSE"],
    ["verify", new Error("token=private-token"), "VERIFY_RESULT_UNKNOWN"],
  ]) {
    const { service, input, calls } = fixture();
    input[phase] = async () => { if (reply instanceof Error) throw reply; return reply; };
    const result = await service.handle(input);
    assert.equal(result.error.code, code);
    assert.equal(service.state(input.session), "FAILED");
    assert.ok(!JSON.stringify([result, calls.log]).includes("private-"));
  }
});

test("session replacement while analyzing cannot label an old token with the new key", async () => {
  const f = fixture({ analyze: async (c) => { f.input.session.key = "replacement"; return accepted(c); } });
  const result = await f.service.handle(f.input);
  assert.equal(result.error.code, "CONTEXT_CHANGED");
  assert.equal(result.sessionKey, "session-a");
  assert.equal(f.calls.verify, 0);
});
