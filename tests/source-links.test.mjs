import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore, validateJob, validateUrl } from "../src/store.mjs";
import { normalizeWorkSource } from "../src/source-metadata.mjs";
import { makeBookId } from "../src/collector.mjs";
import { ViewerOrigins } from "../src/viewer-origins.mjs";

test("normal site links register the existing canonical work without trusting the submitted origin", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "source-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(root).init();
  const batch = await store.createJobs([
    { url: "https://sbxh9.com/novel/21104/3001372" },
    { url: "https://newtoki1.org/novel/21104" },
    { url: "https://toki32.com/novel/21104?epage=3" },
  ]);
  assert.equal(batch.jobs.length, 1);
  assert.equal(batch.skipped.length, 2);
  assert.equal(batch.jobs[0].url, "https://newtoki1.org/novel/21104/3001372");
  assert.equal(makeBookId(batch.jobs[0].url), "newtoki1_org-21104");
  assert.deepEqual(
    normalizeWorkSource("https://toki32.com/novel/21104/3001372"),
    {
      id: "21104",
      url: "https://newtoki1.org/novel/21104",
    },
  );
  const origins = new ViewerOrigins({ store });
  await origins.load();
  assert.equal(origins.get("newtoki1.org"), null);
  assert.equal(await store.json(store.path("viewer-origins.json")), null);
  // Internal storage/auth APIs remain canonical-only.
  assert.throws(() => validateUrl("https://sbxh9.com/novel/21104"));
});

test("alias registration keeps strict HTTPS, path and query validation", () => {
  for (const url of [
    "",
    "not a URL",
    null,
    "http://sbxh9.com/novel/1",
    "https://user:secret@sbxh9.com/novel/1",
    "https://sbxh9.com:444/novel/1",
    "https://sbxh9.com.evil.test/novel/1",
    "https://toki32.com/other/1",
    "https://sbxh9.com/novel/1?token=private",
    "https://toki32.com/novel/1#secret",
    "https://127.0.0.1/novel/1",
  ])
    assert.throws(() => validateJob({ url }), { status: 400 });
  assert.equal(
    validateJob({ url: "https://toki32.com/novel/1?epage=2" }).url,
    "https://newtoki1.org/novel/1?epage=2",
  );
});
