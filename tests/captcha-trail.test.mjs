import test from "node:test";
import assert from "node:assert/strict";
import { validateTrail } from "../src/captcha-trail.mjs";

const challenge = { challengeId: "local", width: 320, pieceWidth: 60, y: 51 };
const answer = { x: 117 };
const payload = (t) => ({ challengeId: "local", x: 117, y: 51,
  trail: [{ x: 0, y: 696, t: 0 }, { x: 117.448, y: 693, t }] });

test("real trail duration includes both bounds, rejects the old 1342ms sample", () => {
  for (const ms of [1800, 2400, 4500]) assert.equal(validateTrail(payload(ms), challenge, answer).at(-1).t, ms);
  for (const ms of [1342.3, 1799.99, 4500.01])
    assert.throws(() => validateTrail(payload(ms), challenge, answer), { code: "TRAIL_DURATION_OUT_OF_RANGE" });
});

test("trail coordinates, monotonic time and challenge association are checked independently", () => {
  for (const patch of [
    { challengeId: "previous" }, { x: 118 }, { y: 52 },
    { trail: [{ x: 0, y: 1, t: 0 }, { x: 117, y: NaN, t: 2400 }] },
    { trail: [{ x: 0, y: 1, t: 100 }, { x: 117, y: 1, t: 2400 }] },
    { trail: [{ x: 0, y: 1, t: 0 }, { x: 100, y: 1, t: 2500 }, { x: 117, y: 1, t: 2400 }] },
  ]) assert.throws(() => validateTrail({ ...payload(2400), ...patch }, challenge, answer), { code: "TRAIL_INVALID" });
});
