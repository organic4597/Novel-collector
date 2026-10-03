import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderStore } from "../src/store.mjs";
import { Discovery } from "../src/discovery.mjs";
import { LibraryMetadata } from "../src/library-metadata.mjs";
import { JobProfiles } from "../src/job-profiles.mjs";

async function runtime(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "job-profiles-"));
  const store = await new FolderStore(join(root, "store")).init();
  let visits = [],
    images = 0,
    held = false,
    active = 0,
    maximumActive = 0;
  const discovery = new Discovery({
    rootDir: join(root, "discovery"),
    delayMs: 0,
    attention: { isHeld: () => held, snapshot: () => ({ sites: [] }) },
    fetchImage: async () => {
      images++;
      if (options.imageFailure) throw new Error("cover unavailable");
      return {
        bytes: Buffer.from([255, 216, 255, 224, 1]),
        mimeType: "image/jpeg",
      };
    },
    launchContext: async () => ({
      route: async () => {},
      close: async () => {},
      newPage: async () => {
        let url;
        return {
          goto: async (value) => {
            active++;
            maximumActive = Math.max(maximumActive, active);
            url = value;
            visits.push(value);
            await options.gate;
            if (options.profileFailure) throw new Error("profile unavailable");
            return { status: () => 200 };
          },
          url: () => url,
          close: async () => {
            active--;
          },
          evaluate: async (fn) =>
            fn.name === "readReaderDocument"
              ? { challenge: false }
              : fn.name === "readWorkMetadata"
                ? {
                    title: "원본 작품",
                    author: "원본 작가",
                    synopsis: "소개",
                    thumbnailUrl: "https://apitk.peertrk.com/a.jpg",
                  }
                : { maxPage: 7, chapters: [{ url: "/chapter/1" }] },
        };
      },
    }),
  });
  const metadata = new LibraryMetadata({ store, discovery });
  const profiles = new JobProfiles({
    store,
    metadata,
    maxPending: options.maxPending ?? 1000,
  });
  t.after(async () => {
    await profiles.close();
    await metadata.close();
    await discovery.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    store,
    discovery,
    metadata,
    profiles,
    visits,
    maximumActive: () => maximumActive,
    images: () => images,
    hold: (value) => {
      held = value;
    },
  };
}
const input = (id, title = "") => ({
  url: `https://newtoki1.org/novel/${id}/99?epage=2`,
  title,
});

test("registration saves zero-chapter profiles and book association while the network remains pending", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { store, profiles, visits } = await runtime(t, { gate });
  t.after(() => release());
  const job = await store.createJob(input(1, "등록 제목"));
  const [registered] = await profiles.registerJobs([job]);
  assert.equal(registered.bookId, "newtoki1_org-1");
  assert.equal((await store.getJob(job.id)).bookId, registered.bookId);
  const book = await store.getBook(registered.bookId);
  assert.equal(book.title, "등록 제목");
  assert.equal(book.url, "https://newtoki1.org/novel/1");
  assert.equal(book.storedChapterCount, 0);
  assert.equal(book.expectedChapterCount, null);
  assert.equal(book.metadataVersion, undefined);
  assert.deepEqual(profiles.state(registered.bookId), { status: "pending" });
  release();
  await profiles.wait();
  assert.deepEqual(visits, ["https://newtoki1.org/novel/1"]);
});

test("successful profile and cover persist through duplicate registration and a later restart", async (t) => {
  const { store, profiles, metadata, discovery, visits, images } =
    await runtime(t);
  const job = await store.createJob(input(2));
  const [registered] = await profiles.registerJobs([job]);
  await profiles.wait();
  await store.upsertBook(registered.bookId, {
    storedChapterCount: 12,
    expectedChapterCount: 50,
  });
  await profiles.registerJobs([registered]);
  await profiles.wait();
  const later = new LibraryMetadata({
    store,
    discovery,
    now: () => Date.now() + 30 * 86400000,
  });
  const restarted = new JobProfiles({ store, metadata: later });
  t.after(async () => {
    await restarted.close();
    await later.close();
  });
  await restarted.registerJobs([registered]);
  await restarted.wait();
  assert.equal((await later.request(registered.bookId)).status, "completed");
  assert.equal((await later.state(registered.bookId)).status, "completed");
  const book = await store.getBook(registered.bookId);
  assert.equal(book.title, "원본 작품");
  assert.equal(book.author, "원본 작가");
  assert.equal(book.storedChapterCount, 12);
  assert.equal(book.expectedChapterCount, 50);
  assert.equal(visits.length, 1);
  assert.equal(images(), 1);
  assert.equal((await metadata.state(registered.bookId)).status, "completed");
});

test("100-work batch serializes metadata and does not exceed the metadata pending limit", async (t) => {
  const { store, profiles, visits, images, maximumActive } = await runtime(t);
  const result = await store.createJobs(
    Array.from({ length: 100 }, (_, n) => input(n + 100)),
  );
  const jobs = await profiles.registerJobs(result.jobs);
  assert.equal((await store.listBooks()).length, 100);
  assert.equal(
    jobs.every((job) => job.bookId),
    true,
  );
  await profiles.wait();
  assert.equal(visits.length, 100);
  assert.equal(images(), 100);
  assert.equal(maximumActive(), 1);
  assert.equal(
    (await store.listBooks()).every((book) => book.metadataVersion === 1),
    true,
  );
});

test("pending duplicate registrations are deduplicated and preserve collector state", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { store, profiles, visits } = await runtime(t, { gate });
  t.after(() => release());
  const job = await store.createJob(input(6));
  const [registered] = await profiles.registerJobs([job]);
  await store.patchJob(job.id, {
    status: "running",
    title: "수집 제목",
    completed: 12,
  });
  await store.upsertBook(registered.bookId, {
    title: "보존할 제목",
    author: "기존 작가",
    expectedChapterCount: 500,
    storedChapterCount: 12,
  });
  const [duplicate] = await profiles.registerJobs([job]);
  assert.equal(duplicate.status, "running");
  assert.equal(duplicate.title, "수집 제목");
  assert.equal(duplicate.completed, 12);
  assert.equal((await store.getBook(registered.bookId)).title, "보존할 제목");
  assert.equal(
    (await store.getBook(registered.bookId)).expectedChapterCount,
    500,
  );
  release();
  await profiles.wait();
  assert.equal(visits.length, 1);
});

test("bounded queue defers overflow without rejecting accepted jobs", async () => {
  const jobs = new Map([
    ["one", { id: "one", ...input(1), bookId: null }],
    ["two", { id: "two", ...input(2), bookId: null }],
  ]);
  const books = new Map();
  const store = {
    upsertBook: async (id, patch) =>
      books.set(id, {
        ...books.get(id),
        ...(typeof patch === "function" ? patch(books.get(id) || {}) : patch),
        id,
      }),
    getBook: async (id) => books.get(id),
    patchJob: async (id, patch) => {
      const next = { ...jobs.get(id), ...patch(jobs.get(id)) };
      jobs.set(id, next);
      return next;
    },
  };
  let release,
    requests = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const metadata = {
    request: async () => {
      requests++;
      await gate;
      return { status: "deferred" };
    },
  };
  const profiles = new JobProfiles({ store, metadata, maxPending: 1 });
  await profiles.registerJobs([jobs.get("one")]);
  const [second] = await profiles.registerJobs([jobs.get("two")]);
  assert.equal(second.bookId, "newtoki1_org-2");
  assert.equal(books.size, 2);
  assert.equal(profiles.state(second.bookId).status, "deferred");
  const restarted = new LibraryMetadata({ store, discovery: {} });
  assert.equal(
    (await restarted.state(second.bookId)).code,
    "PROFILE_QUEUE_FULL",
  );
  await profiles.close();
  release();
  await profiles.wait().catch(() => {});
  assert.equal(requests, 1);
  await assert.rejects(
    profiles.registerJobs([jobs.get("two")]),
    (error) => error.status === 503,
  );
});

test("closing stops queued profile requests and unsupported preview domains remain registered", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { store, profiles, visits } = await runtime(t, { gate });
  const jobs = await store.createJobs([input(7), input(8)]);
  await profiles.registerJobs(jobs.jobs);
  while (!visits.length) await new Promise((resolve) => setImmediate(resolve));
  await profiles.close();
  release();
  await profiles.wait();
  assert.equal(visits.length, 1);
  const metadata = new LibraryMetadata({ store, discovery: {} });
  const later = new JobProfiles({ store, metadata });
  t.after(async () => {
    await later.close();
    await metadata.close();
  });
  const unsupported = await store.createJob({
    url: "https://newtoki1.io/novel/9",
    title: "등록 작품",
  });
  const [registered] = await later.registerJobs([unsupported]);
  assert.equal(registered.bookId, "newtoki1_io-9");
  await later.wait();
  assert.equal((await store.getJob(unsupported.id)).status, "queued");
  assert.equal((await metadata.state(registered.bookId)).status, "failed");
});

test("profile failures preserve the seeded library and leave chapter jobs queued", async (t) => {
  const { store, profiles, metadata } = await runtime(t, {
    profileFailure: true,
  });
  const [job] = await profiles.registerJobs([await store.createJob(input(3))]);
  await profiles.wait();
  const book = await store.getBook(job.bookId);
  assert.equal(book.storedChapterCount, 0);
  assert.equal((await metadata.state(book.id)).status, "failed");
  assert.equal((await store.getJob(job.id)).status, "queued");
});

test("cover failure preserves successful metadata and leaves chapter jobs queued", async (t) => {
  const { store, profiles, metadata, images } = await runtime(t, {
    imageFailure: true,
  });
  const [job] = await profiles.registerJobs([await store.createJob(input(4))]);
  await profiles.wait();
  assert.equal((await metadata.state(job.bookId)).status, "completed");
  assert.equal((await store.getBook(job.bookId)).author, "원본 작가");
  assert.equal((await store.getJob(job.id)).status, "queued");
  assert.equal(images(), 1);
});

test("site hold defers the profile without a retry spin or persisted failure", async (t) => {
  const { store, profiles, metadata, visits, hold } = await runtime(t);
  hold(true);
  const [job] = await profiles.registerJobs([await store.createJob(input(5))]);
  await profiles.wait();
  assert.equal((await metadata.state(job.bookId)).status, "deferred");
  assert.equal(visits.length, 0);
  assert.equal(
    (await store.getBook(job.bookId)).metadataFetchFailedAt,
    undefined,
  );
  hold(false);
  await profiles.registerJobs([job]);
  await profiles.wait();
  assert.equal(visits.length, 1);
});

test("full queue preserves completed profiles and cover storage errors preserve metadata", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { store, profiles, metadata } = await runtime(t, {
    gate,
    maxPending: 1,
  });
  t.after(() => release());
  const first = await store.createJob(input(10));
  await profiles.registerJobs([first]);
  const second = await store.createJob(input(11));
  await store.upsertBook("newtoki1_org-11", {
    url: "https://newtoki1.org/novel/11",
    title: "저장 작품",
    metadataVersion: 1,
    metadataFetchedAt: "2000-01-01T00:00:00.000Z",
    expectedChapterCount: 20,
  });
  await profiles.registerJobs([second]);
  assert.equal(profiles.state("newtoki1_org-11"), null);
  assert.equal((await metadata.state("newtoki1_org-11")).status, "completed");
  metadata.thumbnail = async () => {
    throw new Error("image cache cannot be written");
  };
  release();
  await profiles.wait();
  const book = await store.getBook("newtoki1_org-10");
  assert.equal((await metadata.state(book.id)).status, "completed");
  assert.equal(book.metadataFetchFailedAt, null);
  assert.equal(book.author, "원본 작가");
});

test("unexpected profile rejection records a safe failure and the serial queue continues", async (t) => {
  const { store, metadata } = await runtime(t);
  let requests = 0;
  const profiles = new JobProfiles({
    store,
    metadata: {
      request: async () => {
        requests++;
        if (requests === 1)
          throw Object.assign(new Error("허용하지 않는 원본 주소입니다."), {
            status: 400,
          });
        return { status: "deferred" };
      },
    },
  });
  t.after(() => profiles.close());
  const jobs = await store.createJobs([input(12), input(13)]);
  const registered = await profiles.registerJobs(jobs.jobs);
  await profiles.wait();
  assert.equal(requests, 2);
  assert.equal(
    (await metadata.state(registered[0].bookId)).error,
    "허용하지 않는 원본 주소입니다.",
  );
  assert.equal((await store.getJob(registered[0].id)).status, "queued");
});

test("interrupted shutdown leaves unfinished profiles immediately retryable", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { store, metadata, profiles, discovery, visits } = await runtime(t, {
    gate,
  });
  const [job] = await profiles.registerJobs([await store.createJob(input(14))]);
  while (!visits.length) await new Promise((resolve) => setImmediate(resolve));
  await profiles.close();
  await metadata.close();
  release();
  await profiles.wait();
  assert.equal(
    (await store.getBook(job.bookId)).metadataFetchFailedAt,
    undefined,
  );
  const restarted = new LibraryMetadata({ store, discovery });
  t.after(() => restarted.close());
  assert.equal((await restarted.request(job.bookId)).status, "pending");
  assert.equal((await restarted.wait(job.bookId)).status, "completed");
  assert.equal(visits.length, 2);
});
