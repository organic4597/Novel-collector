import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "../src/settings.mjs";
const displayDefaults = {
  refreshIntervalMs: 5000,
  libraryPageSize: 24,
  thumbnailFit: "contain",
  displayDensity: "comfortable",
};

async function path(t) {
  const directory = await mkdtemp(join(tmpdir(), "collector-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "settings.json");
}

test("settings defaults and copies cannot expose or mutate private state", async (t) => {
  const settings = new SettingsStore({ path: await path(t) });
  await settings.load();
  assert.deepEqual(settings.get(), {
    maxConcurrency: 2,
    chapterDelayMs: 1000,
    defaultFormat: "txt",
    ...displayDefaults,
  });
  const copy = settings.get();
  copy.maxConcurrency = 99;
  assert.equal(settings.get().maxConcurrency, 2);
  assert.deepEqual(await settings.update({ maxConcurrency: 1 }), {
    maxConcurrency: 1,
    chapterDelayMs: 1000,
    defaultFormat: "txt",
    ...displayDefaults,
  });
});

test("settings accept only validated known fields, persist and reopen", async (t) => {
  const file = await path(t);
  const settings = new SettingsStore({ path: file });
  await settings.load();
  for (const input of [
    { maxConcurrency: 3 },
    { maxConcurrency: 1.5 },
    { chapterDelayMs: 499 },
    { chapterDelayMs: 10001 },
    { defaultFormat: "pdf" },
    { password: "sensitive" },
    { refreshIntervalMs: 1999 },
    { refreshIntervalMs: 30001 },
    { refreshIntervalMs: 5000.5 },
    { libraryPageSize: 13 },
    { libraryPageSize: "24" },
    { thumbnailFit: "stretch" },
    { displayDensity: "dense" },
    null,
    [],
  ]) {
    await assert.rejects(settings.update(input), { status: 400 });
  }
  await settings.update({
    maxConcurrency: 1,
    chapterDelayMs: 500,
    defaultFormat: "epub",
    ...displayDefaults,
  });
  const reopened = new SettingsStore({ path: file });
  await reopened.load();
  assert.deepEqual(reopened.get(), {
    maxConcurrency: 1,
    chapterDelayMs: 500,
    defaultFormat: "epub",
    ...displayDefaults,
  });
  assert.deepEqual(JSON.parse(await readFile(file)), reopened.get());
});

test("legacy three-field settings migrate atomically while preserving all existing choices", async (t) => {
  const file = await path(t);
  await writeFile(
    file,
    JSON.stringify({
      maxConcurrency: 1,
      chapterDelayMs: 2500,
      defaultFormat: "epub",
    }),
  );
  const settings = new SettingsStore({ path: file });
  const values = await settings.load();
  assert.deepEqual(values, {
    maxConcurrency: 1,
    chapterDelayMs: 2500,
    defaultFormat: "epub",
    ...displayDefaults,
  });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), values);
  const updated = await settings.update({
    refreshIntervalMs: 2000,
    libraryPageSize: 96,
    thumbnailFit: "cover",
    displayDensity: "compact",
  });
  const reopened = new SettingsStore({ path: file });
  assert.deepEqual(await reopened.load(), updated);
});

test("settings fail closed on malformed stored data", async (t) => {
  const file = await path(t);
  for (const content of [
    "malformed",
    '{"maxConcurrency":9}',
    '{"secret":"hidden"}',
  ]) {
    await writeFile(file, content);
    await assert.rejects(new SettingsStore({ path: file }).load(), /설정/);
  }
});

test("failed settings writes preserve active values and queued updates merge latest state", async (t) => {
  const file = await path(t);
  const settings = new SettingsStore({ path: file });
  await settings.load();
  await Promise.all([
    settings.update({ maxConcurrency: 1 }),
    settings.update({ defaultFormat: "epub" }),
  ]);
  assert.equal(settings.get().maxConcurrency, 1);
  assert.equal(settings.get().defaultFormat, "epub");
  await rm(file);
  await mkdir(file);
  await assert.rejects(settings.update({ maxConcurrency: 2 }), /저장/);
  assert.equal(settings.get().maxConcurrency, 1);
});
