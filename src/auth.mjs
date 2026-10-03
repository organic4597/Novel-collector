import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  chmod,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const failure = (message, status = 500) =>
  Object.assign(new Error(message), { status });
function hashPassword(password) {
  const salt = randomBytes(32);
  return {
    version: 1,
    algorithm: "scrypt",
    salt: salt.toString("hex"),
    hash: scryptSync(password, salt, 64).toString("hex"),
  };
}
function validRecord(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.version === 1 &&
    value.algorithm === "scrypt" &&
    typeof value.salt === "string" &&
    /^[a-f0-9]{64}$/.test(value.salt) &&
    typeof value.hash === "string" &&
    /^[a-f0-9]{128}$/.test(value.hash) &&
    Object.keys(value).every((key) =>
      ["version", "algorithm", "salt", "hash"].includes(key),
    )
  );
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
async function saveRecord(path, record) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(record), {
      mode: 0o600,
      flag: "wx",
    });
    await replace(temporary, path);
  } catch {
    throw failure("관리자 인증 정보 저장에 실패했습니다.");
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
function validateChange(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw failure("현재 비밀번호와 새 비밀번호를 입력하세요.", 400);
  const { newPassword, confirmPassword } = input;
  if (
    typeof newPassword !== "string" ||
    newPassword.length < 8 ||
    newPassword.length > 128
  )
    throw failure("새 비밀번호는 8~128자여야 합니다.", 400);
  if (newPassword !== confirmPassword)
    throw failure("새 비밀번호 확인이 일치하지 않습니다.", 400);
}

class CredentialService {
  #record;
  #path;
  #legacyPath;
  #pending = Promise.resolve();
  constructor({ record, path = null, legacyPath = null }) {
    this.#record = { ...record };
    this.#path = path;
    this.#legacyPath = legacyPath;
  }
  verify(password) {
    if (typeof password !== "string" || !password || password.length > 1024)
      return false;
    const candidate = scryptSync(
      password,
      Buffer.from(this.#record.salt, "hex"),
      64,
    );
    return timingSafeEqual(candidate, Buffer.from(this.#record.hash, "hex"));
  }
  sessionVersion() {
    return this.#path
      ? createHash("sha256").update(this.#record.salt).digest("hex")
      : null;
  }
  change(input) {
    let snapshot;
    try {
      validateChange(input);
      snapshot = {
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        confirmPassword: input.confirmPassword,
      };
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = this.#pending.then(() => this.#change(snapshot));
    this.#pending = operation.catch(() => {});
    return operation;
  }
  async #change(input) {
    validateChange(input);
    if (!this.verify(input.currentPassword))
      throw failure("현재 비밀번호가 올바르지 않습니다.", 403);
    const next = hashPassword(input.newPassword);
    if (this.#path) await saveRecord(this.#path, next);
    this.#record = next;
    if (this.#legacyPath) {
      try {
        await rm(this.#legacyPath, { force: true });
      } catch {
        return {
          changed: true,
          warning: "초기 접속 정보 파일을 정리하지 못했습니다.",
        };
      }
    }
    return { changed: true };
  }
}

export class MemoryCredentials extends CredentialService {
  constructor({ password }) {
    if (typeof password !== "string" || !password || password.length > 1024)
      throw failure("관리자 인증 설정이 필요합니다.");
    super({ record: hashPassword(password) });
  }
}

async function readRecord(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw failure("관리자 인증 정보를 읽을 수 없습니다.");
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw failure("관리자 인증 정보 형식이 올바르지 않습니다.");
  }
  if (!validRecord(record))
    throw failure("관리자 인증 정보 형식이 올바르지 않습니다.");
  return record;
}
async function initialPassword(path) {
  try {
    const password = (await readFile(path, "utf8")).trim();
    if (!password || password.length > 1024)
      throw failure("초기 관리자 인증 정보 형식이 올바르지 않습니다.");
    await chmod(path, 0o600);
    return password;
  } catch (error) {
    if (error.code !== "ENOENT")
      throw failure("초기 관리자 인증 정보를 읽을 수 없습니다.");
  }
  const password = randomBytes(24).toString("base64url");
  try {
    await writeFile(path, `${password}\n`, { mode: 0o600, flag: "wx" });
  } catch {
    throw failure("초기 관리자 인증 정보 저장에 실패했습니다.");
  }
  return password;
}
export async function openCredentials({ directory }) {
  const path = join(directory, "admin-credentials.json"),
    legacyPath = join(directory, "admin-login.txt");
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch {
    throw failure("관리자 인증 정보 저장 경로를 열 수 없습니다.");
  }
  const existing = await readRecord(path);
  if (existing) {
    try {
      await chmod(path, 0o600);
    } catch {
      throw failure("관리자 인증 정보 권한을 설정할 수 없습니다.");
    }
    return new CredentialService({ record: existing, path, legacyPath });
  }
  const record = hashPassword(await initialPassword(legacyPath));
  await saveRecord(path, record);
  return new CredentialService({ record, path, legacyPath });
}
