import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  chmod,
} from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

const DEFAULTS = Object.freeze({
  maxConcurrency: 2,
  chapterDelayMs: 1000,
  defaultFormat: "txt",
  refreshIntervalMs: 5000,
  libraryPageSize: 24,
  thumbnailFit: "contain",
  displayDensity: "comfortable",
});
export const SETTINGS_KEYS = Object.freeze(Object.keys(DEFAULTS));
const failure = (message, status = 500) =>
  Object.assign(new Error(message), { status });
function validate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw failure("올바른 설정을 입력하세요.", 400);
  if (Object.keys(input).some((key) => !Object.hasOwn(DEFAULTS, key)))
    throw failure("지원하지 않는 설정 항목입니다.", 400);
  if (
    Object.hasOwn(input, "maxConcurrency") &&
    ![1, 2].includes(input.maxConcurrency)
  )
    throw failure("동시 수집 작품 수는 1개 또는 2개여야 합니다.", 400);
  if (
    Object.hasOwn(input, "chapterDelayMs") &&
    (!Number.isSafeInteger(input.chapterDelayMs) ||
      input.chapterDelayMs < 500 ||
      input.chapterDelayMs > 10000)
  )
    throw failure("회차 대기 시간은 500~10000밀리초여야 합니다.", 400);
  if (
    Object.hasOwn(input, "defaultFormat") &&
    !["txt", "epub"].includes(input.defaultFormat)
  )
    throw failure("기본 다운로드 형식은 TXT 또는 EPUB이어야 합니다.", 400);
  if (
    Object.hasOwn(input, "refreshIntervalMs") &&
    (!Number.isSafeInteger(input.refreshIntervalMs) ||
      input.refreshIntervalMs < 2000 ||
      input.refreshIntervalMs > 30000)
  )
    throw failure("화면 갱신 간격은 2000~30000밀리초의 정수여야 합니다.", 400);
  if (
    Object.hasOwn(input, "libraryPageSize") &&
    ![12, 24, 48, 96].includes(input.libraryPageSize)
  )
    throw failure("서재 페이지 크기는 12, 24, 48, 96 중 하나여야 합니다.", 400);
  if (
    Object.hasOwn(input, "thumbnailFit") &&
    !["contain", "cover"].includes(input.thumbnailFit)
  )
    throw failure("표지 맞춤은 contain 또는 cover여야 합니다.", 400);
  if (
    Object.hasOwn(input, "displayDensity") &&
    !["comfortable", "compact"].includes(input.displayDensity)
  )
    throw failure("화면 밀도는 comfortable 또는 compact여야 합니다.", 400);
  return { ...input };
}
async function replace(source, target) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(source, target);
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
        attempt >= 4
      )
        throw error;
      await wait(10 * (attempt + 1));
    }
  }
}
export class SettingsStore {
  #path;
  #values = { ...DEFAULTS };
  #pending = Promise.resolve();
  constructor({ path }) {
    this.#path = path;
  }
  get() {
    return { ...this.#values };
  }
  async load() {
    let text;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return this.get();
      throw failure("저장된 설정을 읽을 수 없습니다.");
    }
    let values, stored;
    try {
      stored = validate(JSON.parse(text));
      values = { ...DEFAULTS, ...stored };
    } catch {
      throw failure("저장된 설정 형식이 올바르지 않습니다.");
    }
    try {
      await chmod(this.#path, 0o600);
    } catch {
      throw failure("저장된 설정 권한을 설정할 수 없습니다.");
    }
    if (SETTINGS_KEYS.some((key) => !Object.hasOwn(stored, key)))
      return this.update(values);
    this.#values = values;
    return this.get();
  }
  update(input) {
    let patch;
    try {
      patch = validate(input);
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = this.#pending.then(() => this.#update(patch));
    this.#pending = operation.catch(() => {});
    return operation;
  }
  async #update(patch) {
    const values = { ...this.#values, ...patch },
      temporary = `${this.#path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(values), {
        mode: 0o600,
        flag: "wx",
      });
      await replace(temporary, this.#path);
    } catch {
      throw failure("설정 저장에 실패했습니다.");
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    this.#values = values;
    return this.get();
  }
}
