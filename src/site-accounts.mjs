import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  chmod,
  lstat,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { validateUrl } from "./store.mjs";

const fail = (message, status = 500) =>
  Object.assign(new Error(message), { status });
export function siteAccountHost(host) {
  if (typeof host !== "string" || !host || /[\s/@?#:]/.test(host))
    throw fail("올바른 사이트 호스트를 입력하세요.", 400);
  try {
    if (["sbxh9.com", "toki32.com"].includes(host.toLowerCase()))
      return host.toLowerCase();
    return new URL(validateUrl(`https://${host}/novel/1`)).hostname;
  } catch {
    throw fail("지원하는 HTTPS 사이트 호스트만 사용할 수 있습니다.", 400);
  }
}
function decode(value, expectedLength) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw Error("invalid encoding");
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.toString("base64") !== value ||
    (expectedLength && bytes.length !== expectedLength)
  )
    throw Error("invalid encoding");
  return bytes;
}
function validateInput(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) =>
        !["host", "username", "password", "pin", "enabled"].includes(key),
    )
  )
    throw fail("사이트 계정 설정이 올바르지 않습니다.", 400);
  if (!Object.hasOwn(input, "host"))
    throw fail("사이트 호스트를 입력하세요.", 400);
  const host = siteAccountHost(input.host);
  if (!Object.hasOwn(input, "enabled") || typeof input.enabled !== "boolean")
    throw fail("자동 로그인 사용 여부를 선택하세요.", 400);
  if (
    Object.hasOwn(input, "username") &&
    (typeof input.username !== "string" ||
      !/^[A-Za-z0-9_]{3,20}$/.test(input.username))
  )
    throw fail("사이트 아이디는 영문, 숫자, 밑줄로 된 3~20자여야 합니다.", 400);
  if (
    Object.hasOwn(input, "password") &&
    (typeof input.password !== "string" ||
      input.password.length < 1 ||
      input.password.length > 128)
  )
    throw fail("사이트 비밀번호는 1~128자여야 합니다.", 400);
  if (
    Object.hasOwn(input, "pin") &&
    (typeof input.pin !== "string" || !/^\d{4}$/.test(input.pin))
  )
    throw fail("사이트 PIN은 숫자 네 자리여야 합니다.", 400);
  return {
    ...input,
    host,
    ...(Object.hasOwn(input, "username")
      ? { username: input.username.trim() }
      : {}),
  };
}
async function replace(source, target) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
        attempt >= 7
      )
        throw error;
      await wait(10 * 2 ** attempt);
    }
  }
}

export class SiteAccounts {
  #directory;
  #keyPath;
  #dataPath;
  #providedKey;
  #key = null;
  #accounts = new Map();
  #ready = false;
  #pending = Promise.resolve();
  constructor({ directory, masterKey } = {}) {
    if (typeof directory !== "string" || !directory)
      throw fail("사이트 계정 저장 경로 설정이 필요합니다.");
    this.#directory = resolve(directory);
    this.#keyPath = join(this.#directory, "site-accounts.key");
    this.#dataPath = join(this.#directory, "site-accounts.json");
    this.#providedKey = Buffer.isBuffer(masterKey)
      ? Buffer.from(masterKey)
      : masterKey;
  }
  #serialized(operation) {
    const next = this.#pending.catch(() => {}).then(operation);
    this.#pending = next;
    return next;
  }
  #assertReady() {
    if (!this.#ready)
      throw fail("사이트 계정 저장소를 사용할 수 없습니다.", 503);
  }
  async #readSecure(path) {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 1024 * 1024
    )
      throw Error("invalid file");
    await chmod(path, 0o600);
    return readFile(path, "utf8");
  }
  async #loadKey(hasData) {
    if (this.#providedKey !== undefined) {
      const key = Buffer.isBuffer(this.#providedKey)
        ? Buffer.from(this.#providedKey)
        : decode(this.#providedKey, 32);
      if (key.length !== 32) throw Error("invalid key");
      return key;
    }
    let encoded = await this.#readSecure(this.#keyPath);
    if (encoded === null) {
      if (hasData) throw Error("missing key");
      const generated = randomBytes(32).toString("base64");
      try {
        await writeFile(this.#keyPath, generated + "\n", {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      encoded = await this.#readSecure(this.#keyPath);
    }
    return decode(encoded.trim(), 32);
  }
  #decrypt(host, record) {
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      Object.keys(record).some((key) => !["iv", "tag", "data"].includes(key))
    )
      throw Error("invalid record");
    const data = decode(record.data);
    if (data.length > 16384) throw Error("invalid record");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      decode(record.iv, 12),
    );
    decipher.setAAD(Buffer.from(`site-accounts:v1:${host}`));
    decipher.setAuthTag(decode(record.tag, 16));
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
    try {
      const account = validateInput({
        ...JSON.parse(plaintext.toString("utf8")),
        host,
      });
      if (!account.username || !account.password || !account.pin)
        throw Error("incomplete account");
      const { host: ignored, ...credentials } = account;
      return credentials;
    } finally {
      plaintext.fill(0);
    }
  }
  #encrypt(host, account) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(`site-accounts:v1:${host}`));
    const plaintext = Buffer.from(JSON.stringify(account));
    try {
      const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: data.toString("base64"),
      };
    } finally {
      plaintext.fill(0);
    }
  }
  async load() {
    return this.#serialized(async () => {
      this.#ready = false;
      this.#accounts = new Map();
      try {
        await mkdir(this.#directory, { recursive: true, mode: 0o700 });
        await chmod(this.#directory, 0o700);
        const text = await this.#readSecure(this.#dataPath);
        this.#key = await this.#loadKey(text !== null);
        const data =
          text === null ? { version: 1, accounts: {} } : JSON.parse(text);
        if (
          !data ||
          data.version !== 1 ||
          Object.keys(data).some(
            (key) => !["version", "accounts"].includes(key),
          ) ||
          !data.accounts ||
          typeof data.accounts !== "object" ||
          Array.isArray(data.accounts) ||
          Object.keys(data.accounts).length > 100
        )
          throw Error("invalid data");
        const accounts = new Map();
        for (const [host, record] of Object.entries(data.accounts)) {
          if (siteAccountHost(host) !== host) throw Error("invalid host");
          accounts.set(host, this.#decrypt(host, record));
        }
        this.#accounts = accounts;
        this.#ready = true;
        return { configuredHosts: accounts.size };
      } catch {
        this.#key?.fill(0);
        this.#key = null;
        throw fail("사이트 계정 저장소를 읽을 수 없습니다.");
      }
    });
  }
  status(host) {
    this.#assertReady();
    host = siteAccountHost(host);
    const account = this.#accounts.get(host);
    return {
      host,
      configured: !!account,
      enabled: account?.enabled ?? false,
      username: account?.username ?? "",
    };
  }
  getCredentials(host) {
    this.#assertReady();
    host = siteAccountHost(host);
    const account = this.#accounts.get(host);
    return account?.enabled
      ? {
          host,
          username: account.username,
          password: account.password,
          pin: account.pin,
        }
      : null;
  }
  async #persist(next) {
    const temporary = `${this.#dataPath}.${randomUUID()}.tmp`;
    try {
      const accounts = Object.fromEntries(
        [...next].map(([host, account]) => [
          host,
          this.#encrypt(host, account),
        ]),
      );
      await writeFile(temporary, JSON.stringify({ version: 1, accounts }), {
        flag: "wx",
        mode: 0o600,
      });
      await replace(temporary, this.#dataPath);
    } catch {
      throw fail("사이트 계정 설정을 저장하지 못했습니다.");
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    this.#accounts = next;
  }
  save(input) {
    let patch;
    try {
      this.#assertReady();
      patch = validateInput(input);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#serialized(async () => {
      this.#assertReady();
      const previous = this.#accounts.get(patch.host);
      const { host, ...changes } = patch;
      const account = { ...previous, ...changes };
      if (!account.username || !account.password || !account.pin)
        throw fail("첫 설정에는 아이디, 비밀번호, PIN을 모두 입력하세요.", 400);
      if (!previous && this.#accounts.size >= 100)
        throw fail("사이트 계정 설정 수가 제한을 초과했습니다.", 400);
      await this.#persist(new Map([...this.#accounts, [host, account]]));
      return this.status(host);
    });
  }
  clear(host) {
    this.#assertReady();
    host = siteAccountHost(host);
    return this.#serialized(async () => {
      this.#assertReady();
      const next = new Map(this.#accounts);
      next.delete(host);
      await this.#persist(next);
      return this.status(host);
    });
  }
}
