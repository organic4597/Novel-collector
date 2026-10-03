import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../src/store.mjs";
import { SiteAttention } from "../src/site-attention.mjs";

test("authentication and CAPTCHA reasons stay distinct after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-attention-kind-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(root).init();
  const a = new SiteAttention({ store });
  await a.load();
  await a.holdSite("newtoki1.org", {
    requiredSlots: [1],
    kind: "authentication",
  });
  const b = new SiteAttention({ store });
  await b.load();
  assert.equal(b.get("newtoki1.org").kind, "authentication");
  await b.holdSite("newtoki1.org", { requiredSlots: [1], kind: "captcha" });
  assert.equal(b.get("newtoki1.org").kind, "captcha");
});

test("persisted daily quota notices migrate to CAPTCHA without releasing the held slots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "daily-quota-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(root).init();
  await store.atomic(store.path("site-attention.json"), {
    sites: [
      {
        host: "newtoki1.org",
        reason:
          "일일 조회 인증이 필요합니다. 일반 소설 뷰어에서 인증 후 다시 열어주세요.",
        kind: "authentication",
        jobIds: ["job1"],
        requiredSlots: [1, 2],
        verifiedSlots: [1],
        held: true,
        createdAt: new Date().toISOString(),
      },
    ],
  });
  const attention = new SiteAttention({ store });
  await attention.load();
  const site = attention.get("newtoki1.org");
  assert.equal(site.kind, "captcha");
  assert.equal(
    (await store.json(store.path("site-attention.json"))).sites[0].kind,
    "captcha",
  );
  assert.equal(site.held, true);
  assert.deepEqual(site.verifiedSlots, [1]);
  assert.deepEqual(site.requiredSlots, [1, 2]);
});

test("daily quota holds override stale login classification while real login stays authentication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "daily-quota-kind-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(root).init();
  const attention = new SiteAttention({ store });
  await attention.holdSite("newtoki1.org", {
    reason: "일일 조회 인증이 필요합니다.",
    kind: "authentication",
    requiredSlots: [1],
  });
  assert.equal(attention.get("newtoki1.org").kind, "captcha");
  await attention.holdSite("newtoki2.org", {
    reason: "로그인이 필요합니다.",
    kind: "authentication",
    requiredSlots: [1],
  });
  assert.equal(attention.get("newtoki2.org").kind, "authentication");
});

test("site attention survives restart and only releases after all original slots are verified", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-site-attention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(root).init();
  let now = 10000;
  const attention = new SiteAttention({ store, clock: () => now });
  await attention.load();
  await attention.holdSite("newtoki1.org", {
    reason: "일일 인증 필요",
    jobIds: ["job1", "job2"],
    requiredSlots: [1, 2],
  });
  assert.equal(attention.isHeld("newtoki1.org"), true);
  const first = await attention.verifySlot("newtoki1.org", 1);
  assert.equal(first.held, true);
  now += 3600000;
  const restored = new SiteAttention({ store, clock: () => now });
  await restored.load();
  assert.equal(restored.isHeld("newtoki1.org"), true);
  assert.deepEqual(restored.get("newtoki1.org").verifiedSlots, [1]);
  assert.equal((await restored.verifySlot("newtoki1.org", 2)).held, false);
  assert.equal(restored.isHeld("newtoki1.org"), false);
  assert.deepEqual(restored.get("newtoki1.org").requiredSlots, [1, 2]);
  await assert.rejects(restored.verifySlot("newtoki1.org", 3));
});

test("concurrent attention changes serialize and snapshots cannot mutate verification state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-site-attention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(root).init();
  const attention = new SiteAttention({ store });
  await attention.load();
  await Promise.all([
    attention.holdSite("newtoki1.org", {
      reason: "인증 필요",
      jobIds: ["job1"],
      requiredSlots: [1],
    }),
    attention.holdSite("newtoki1.org", {
      reason: "인증 필요",
      jobIds: ["job2"],
      requiredSlots: [2],
    }),
  ]);
  assert.deepEqual(attention.get("newtoki1.org").requiredSlots, [1, 2]);
  const snapshot = attention.snapshot();
  snapshot.sites[0].requiredSlots.length = 0;
  assert.deepEqual(attention.get("newtoki1.org").requiredSlots, [1, 2]);
  await assert.rejects(
    attention.holdSite("../secret", { requiredSlots: [1], jobIds: [] }),
  );
});
