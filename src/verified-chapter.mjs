import { readFile } from "node:fs/promises";
import { FolderStore, validateUrl } from "./store.mjs";
import { Collector, makeBookId, chapterIdFor } from "./collector.mjs";

const ORIGINS = new Set(["https://sbxh9.com", "https://toki32.com"]);
const fail = () =>
  Object.assign(new Error("확인한 회차를 안전하게 저장할 수 없습니다."), {
    status: 409,
  });
function validateReader({ canonicalProbeUrl, viewerOrigin, slot, text }) {
  let url;
  try {
    url = new URL(validateUrl(canonicalProbeUrl));
  } catch {
    throw fail();
  }
  if (
    !ORIGINS.has(viewerOrigin) ||
    ![1, 2].includes(slot) ||
    url.search ||
    !/^\/novel\/\d+\/\d+$/.test(url.pathname) ||
    typeof text !== "string" ||
    !text.trim() ||
    Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024
  )
    throw fail();
  return url;
}
async function registeredChapter(store, url) {
  const bookId = makeBookId(url.href),
    id = chapterIdFor(url.href);
  const [catalog, book] = await Promise.all([
    store.readCatalog(bookId),
    store.getBook(bookId),
  ]);
  const chapter = catalog?.chapters?.find(
    (row) => row.id === id && row.url === url.href,
  );
  if (
    !book ||
    !chapter ||
    !Number.isSafeInteger(chapter.number) ||
    chapter.number < 1
  )
    throw fail();
  return {
    bookId,
    id,
    chapter,
    book: { ...book, title: book.title || catalog.title },
  };
}
async function verificationJob(store, { book, chapter, bookId }, slot) {
  const url = new URL(chapter.url);
  const value = {
    url: url.origin + "/novel/" + url.pathname.split("/")[2],
    bookId,
    title: book.title,
    startEpisode: chapter.number,
    endEpisode: chapter.number,
    format: "txt",
  };
  const previous = await store.json(store.path("slot-" + slot + ".json"));
  const job = previous?.jobId && (await store.getJob(previous.jobId));
  if (job)
    return store.patchJob(job.id, {
      ...value,
      status: "completed",
      exports: {},
    });
  return store.createJob(value);
}
async function saveCheckpoint(store, registered, slot, text) {
  const { bookId, id, book, chapter } = registered;
  await store.upsertBook(bookId, {
    title: book.title,
    author: book.author,
    tags: book.tags,
    synopsis: book.synopsis,
  });
  const saved = await store.writeChapter(bookId, id, { ...chapter, text });
  const job = await verificationJob(store, registered, slot);
  await new Collector({ store }).exportBook({ ...job, bookId }, [saved]);
  const bytes = await readFile((await store.getExport(job.id, "txt")).path);
  if (!bytes.toString("utf8").includes(text)) throw fail();
  return { saved, job, bytes };
}
/** Save the current reader before its live page changes owners. No authentication values are read. */
export function createVerifiedChapterWriter({ store }) {
  let ready;
  const verification = new FolderStore(store.path("source-verification"));
  return async (input) => {
    const url = validateReader(input),
      registered = await registeredChapter(store, url);
    const { slot, viewerOrigin, text } = input,
      { bookId, id, chapter } = registered;
    ready ||= verification.init();
    await ready;
    const { saved, job, bytes } = await saveCheckpoint(
      verification,
      registered,
      slot,
      text,
    );
    const existing = await store.readChapter(bookId, id);
    if (!existing?.text?.trim())
      await store.writeChapter(bookId, id, { ...chapter, text });
    const proof = {
      origin: viewerOrigin,
      slot,
      bookId,
      chapterId: id,
      number: chapter.number,
      bodyCharacters: text.length,
      bodyHash: saved.hash,
      txtBytes: bytes.length,
      jobId: job.id,
      productionCachePreserved: !!existing?.text?.trim(),
      verifiedAt: new Date().toISOString(),
    };
    await verification.atomic(
      verification.path("slot-" + slot + ".json"),
      proof,
    );
    await verification.atomic(verification.path("latest.json"), proof);
    return proof;
  };
}
