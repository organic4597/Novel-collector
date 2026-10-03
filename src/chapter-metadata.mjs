import { stat } from "node:fs/promises";

export async function writeChapterMetadata(store, bookId, chapterId, chapter) {
  const { text, ...metadata } = chapter;
  const info = await stat(
    store.path("books", bookId, "chapters", chapterId, "chapter.json"),
  );
  await store.atomic(
    store.path("books", bookId, "chapters", chapterId, "metadata.json"),
    {
      version: 1,
      fileSize: info.size,
      fileMtimeMs: info.mtimeMs,
      metadata,
    },
  );
  return metadata;
}

async function readMetadata(store, bookId, chapterId) {
  const path = store.path(
    "books",
    bookId,
    "chapters",
    chapterId,
    "chapter.json",
  );
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile()) return null;
  let cached;
  try {
    cached = await store.json(
      store.path("books", bookId, "chapters", chapterId, "metadata.json"),
    );
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (
    cached?.version === 1 &&
    cached.fileSize === info.size &&
    cached.fileMtimeMs === info.mtimeMs &&
    cached.metadata?.id === chapterId &&
    !Object.hasOwn(cached.metadata, "text") &&
    Number.isSafeInteger(cached.metadata.size) &&
    cached.metadata.size >= 0 &&
    typeof cached.metadata.hash === "string"
  )
    return cached.metadata;
  const chapter = await store.readChapter(bookId, chapterId);
  if (!chapter) return null;
  return writeChapterMetadata(store, bookId, chapterId, chapter);
}

export async function listChapterMetadata(store, bookId) {
  const ids = await store.ids(store.path("books", bookId, "chapters"));
  const rows = [];
  // Older libraries are migrated in bounded batches; never load every body at once.
  for (let index = 0; index < ids.length; index += 8) {
    rows.push(
      ...(await Promise.all(
        ids
          .slice(index, index + 8)
          .map((chapterId) =>
            store.locked("chapter:" + bookId + ":" + chapterId, () =>
              readMetadata(store, bookId, chapterId),
            ),
          ),
      )),
    );
  }
  return rows
    .filter(Boolean)
    .sort(
      (a, b) => (a.number ?? 0) - (b.number ?? 0) || a.id.localeCompare(b.id),
    );
}
