import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../src/store.mjs";

test("folder DB survives restart and saves chapter text/hash and exports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(root).init();
  const job = await store.createJob({
    url: "https://newtoki1.org/novel/21104",
  });
  await store.upsertBook("21104", { title: "책" });
  await store.writeChapter("21104", "123", {
    number: 1,
    title: "첫 화",
    url: "https://newtoki1.org/novel/21104/123",
    text: "문장\n다음 문장",
  });
  await store.appendEvent(job.id, { level: "info", message: "저장 완료" });
  await store.writeExport(job.id, "txt", Buffer.from("문장"), "책.txt");
  const reopened = await new FolderStore(root).init();
  assert.equal((await reopened.getJob(job.id)).status, "queued");
  const chapter = await reopened.readChapter("21104", "123");
  assert.equal(chapter.text, "문장\n다음 문장");
  assert.equal(chapter.hash.length, 64);
  assert.equal((await reopened.listChapters("21104")).length, 1);
  assert.equal((await reopened.readEvents(job.id)).length, 1);
  assert.equal((await reopened.getExport(job.id, "txt")).filename, "책.txt");
});
test("folder DB rejects unsafe paths and URLs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(root).init();
  for (const id of ["../secret", "a/b", "..", "", "a\\b"])
    await assert.rejects(store.getJob(id));
  for (const url of [
    "http://newtoki1.org/novel/1",
    "https://root@newtoki1.org/novel/1",
    "https://127.0.0.1/novel/1",
    "https://newtoki1.org.evil.com/novel/1",
  ])
    await assert.rejects(store.createJob({ url }));
  await assert.rejects(
    store.createJob({ url: "https://newtoki1.org/novel/1", format: "zip" }),
  );
});
test("concurrent job patches persist and events redact credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "novel-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new FolderStore(root).init();
  const job = await store.createJob({
    url: "https://newtoki1.org/novel/1",
    startEpisode: 1,
    endEpisode: 2,
    startAt: new Date().toISOString(),
    overwrite: true,
    executor: "browser",
    format: "epub",
  });
  await Promise.all([
    store.patchJob(job.id, { completed: 2 }),
    store.patchJob(job.id, { total: 2 }),
  ]);
  const updated = await store.getJob(job.id);
  assert.equal(updated.total, 2);
  assert.equal(updated.completed, 2);
  await store.appendEvent(job.id, {
    level: "error",
    message: "Bearer token-secret https://x/?password=password-secret",
  });
  assert.doesNotMatch(
    JSON.stringify(await store.readEvents(job.id)),
    /token-secret|password-secret/,
  );
  assert.deepEqual(await store.readEvents("missing"), []);
  assert.equal(await store.getExport(job.id, "epub"), null);
  assert.equal(await store.getBook("missing"), null);
  assert.equal(await store.readChapter("1", "1"), null);
  await assert.rejects(
    store.createJob({ url: job.url, startEpisode: 2, endEpisode: 1 }),
  );
  await assert.rejects(store.createJob({ url: job.url, startAt: "invalid" }));
  await assert.rejects(store.createJob({ url: job.url, overwrite: "true" }));
  await assert.rejects(store.createJob({ url: job.url, title: 2 }));
  await assert.rejects(
    store.writeChapter("1", "1", {
      number: 1,
      title: "empty",
      url: "https://newtoki1.org/novel/1/1",
      text: "",
    }),
  );
});
