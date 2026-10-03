import test from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfter } from "../src/retry-after.mjs";
test("Retry-After respects numeric seconds and future HTTP dates", () => {
  const now = Date.parse("2026-10-03T00:00:00Z");
  assert.equal(parseRetryAfter("900", now), 900000);
  assert.equal(parseRetryAfter("Sat, 03 Oct 2026 00:20:00 GMT", now), 1200000);
  assert.equal(parseRetryAfter("Fri, 02 Oct 2026 00:00:00 GMT", now), 0);
  for (const value of [undefined, "", "nope", "999999999999999999999999"])
    assert.equal(parseRetryAfter(value, now), 0);
});
