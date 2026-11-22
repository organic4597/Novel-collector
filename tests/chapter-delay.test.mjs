import test from "node:test";
import assert from "node:assert/strict";
import { pauseBetweenChapters } from "../src/chapter-delay.mjs";

test("chapter delay chooses inclusive 10..60 seconds for each gap", async () => {
  const observed = [], notices = [];
  for (const seconds of [10, 60, 35]) {
    await pauseBetweenChapters(undefined, value => { notices.push(value); }, {
      choose: (min, max) => { assert.equal(min, 10); assert.equal(max, 61); return seconds; },
      wait: async (ms, value, options) => { observed.push(ms); assert.equal(value, undefined); assert.equal(options.signal, undefined); },
    });
  }
  assert.deepEqual(observed, [10000, 60000, 35000]);
  assert.deepEqual(notices, [10, 60, 35]);
});

test("an already cancelled chapter wait never draws a delay or reports progress", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(pauseBetweenChapters(controller.signal, () => assert.fail("no notice"), {
    choose: () => assert.fail("no random choice"), wait: () => assert.fail("no wait"),
  }), { name: "AbortError" });
});

test("cancelling a real scheduled 60 second wait interrupts it immediately", async () => {
  const controller = new AbortController();
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const work = pauseBetweenChapters(controller.signal, () => entered(), { choose: () => 60 });
  await ready;
  controller.abort();
  await assert.rejects(work, { name: "AbortError" });
});
