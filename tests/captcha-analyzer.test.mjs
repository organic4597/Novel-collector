import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCaptchaAnalyzer } from "../src/captcha-analyzer.mjs";

const python = new URL("../.venv-captcha/bin/python", import.meta.url).pathname;
const challenge = () => JSON.parse(execFileSync(python, ["-c",
  'import sys,json; sys.path.insert(0,"tests"); from captcha_position_test import fixture; print(json.dumps(fixture()))',
], { cwd: new URL("../", import.meta.url), encoding: "utf8" }));

test("OpenCV subprocess returns original coordinates with a test-only evaluated profile", async () => {
  const result = await createCaptchaAnalyzer({ profile: { minScore: .85, minMargin: .12 } })(challenge());
  assert.ok(Math.abs(result.targetX - 117) <= .5);
  assert.equal(result.targetY, 51);
  assert.equal(result.decision, "accept");
});

test("default uncalibrated analyzer abstains and image size mismatch is structured", async () => {
  const c = challenge();
  const analyze = createCaptchaAnalyzer();
  assert.equal((await analyze(c)).reason, "UNCALIBRATED");
  await assert.rejects(analyze({ ...c, width: 319 }), { code: "IMAGE_SIZE_MISMATCH" });
});

test("unavailable Python, subprocess timeout and cancellation do not expose process output", async () => {
  const c = challenge();
  await assert.rejects(createCaptchaAnalyzer({ python: "/not-installed/private-path" })(c), { code: "ANALYZER_UNAVAILABLE" });
  await assert.rejects(createCaptchaAnalyzer({ timeoutMs: 1 })(c), { code: "ANALYSIS_TIMEOUT" });
  const controller = new AbortController();
  const pending = createCaptchaAnalyzer()(c, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: "CANCELLED" });
});
