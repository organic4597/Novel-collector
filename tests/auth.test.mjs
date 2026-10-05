import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  stat,
  readdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryCredentials, openCredentials } from "../src/auth.mjs";

const initial = "fixture-old-password";
const replacement = "fixture-new-password";
const change = (currentPassword = initial, newPassword = replacement) => ({
  currentPassword,
  newPassword,
  confirmPassword: newPassword,
});
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "collector-auth-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("memory credentials verify and reject invalid changes without modifying authentication", async () => {
  const credentials = new MemoryCredentials({ password: initial });
  assert.equal(credentials.verify(initial), true);
  assert.equal(credentials.verify(null), false);
  assert.equal(credentials.verify("wrong"), false);
  await assert.rejects(credentials.change(change("wrong")), { status: 403 });
  for (const input of [
    change(initial, "short"),
    change(initial, "a".repeat(129)),
    { ...change(), confirmPassword: "different" },
    null,
  ]) {
    await assert.rejects(credentials.change(input), { status: 400 });
    assert.equal(credentials.verify(initial), true);
  }
  assert.deepEqual(await credentials.change(change()), { changed: true });
  assert.equal(credentials.verify(initial), false);
  assert.equal(credentials.verify(replacement), true);
  assert.equal(JSON.stringify(credentials).includes(initial), false);
});

test("legacy initial credentials migrate to hashes and plaintext retires on actual change", async (t) => {
  const path = await directory(t);
  await writeFile(join(path, "admin-login.txt"), `${initial}\n`, {
    mode: 0o600,
  });
  const credentials = await openCredentials({ directory: path });
  assert.equal(credentials.verify(initial), true);
  const persisted = await readFile(
    join(path, "admin-credentials.json"),
    "utf8",
  );
  assert.equal(persisted.includes(initial), false);
  assert.equal(
    (await readFile(join(path, "admin-login.txt"), "utf8")).trim(),
    initial,
  );
  await credentials.change(change());
  await assert.rejects(readFile(join(path, "admin-login.txt")), {
    code: "ENOENT",
  });
  const reopened = await openCredentials({ directory: path });
  assert.equal(reopened.verify(replacement), true);
  assert.equal(reopened.verify(initial), false);
  await assert.rejects(readFile(join(path, "admin-login.txt")), {
    code: "ENOENT",
  });
  if (process.platform !== "win32")
    assert.equal(
      (await stat(join(path, "admin-credentials.json"))).mode & 0o777,
      0o600,
    );
});

test("new installation writes retrievable initial password but hashed-only startup does not regenerate it", async (t) => {
  const path = await directory(t);
  const credentials = await openCredentials({ directory: path });
  const generated = (
    await readFile(join(path, "admin-login.txt"), "utf8")
  ).trim();
  assert.ok(generated.length >= 24);
  assert.equal(credentials.verify(generated), true);
  await rm(join(path, "admin-login.txt"));
  assert.equal(
    (await openCredentials({ directory: path })).verify(generated),
    true,
  );
  await assert.rejects(readFile(join(path, "admin-login.txt")), {
    code: "ENOENT",
  });
});

test("malformed hash data fails closed even when a legacy password exists", async (t) => {
  const path = await directory(t);
  await writeFile(join(path, "admin-login.txt"), initial);
  for (const value of [
    "broken",
    JSON.stringify({
      version: 1,
      algorithm: "scrypt",
      salt: "bad",
      hash: "bad",
    }),
    JSON.stringify({
      version: 2,
      algorithm: "scrypt",
      salt: "a".repeat(64),
      hash: "b".repeat(128),
    }),
  ]) {
    await writeFile(join(path, "admin-credentials.json"), value);
    await assert.rejects(openCredentials({ directory: path }), /인증 정보/);
    assert.equal(
      await readFile(join(path, "admin-login.txt"), "utf8"),
      initial,
    );
  }
});

test("failed persistence leaves the active verifier intact and no temporary secrets", async (t) => {
  const path = await directory(t);
  await writeFile(join(path, "admin-login.txt"), initial);
  const credentials = await openCredentials({ directory: path });
  const hashPath = join(path, "admin-credentials.json");
  await rm(hashPath);
  await mkdir(hashPath);
  await assert.rejects(credentials.change(change()), /저장/);
  assert.equal(credentials.verify(initial), true);
  assert.equal(credentials.verify(replacement), false);
  assert.equal(await readFile(join(path, "admin-login.txt"), "utf8"), initial);
  assert.deepEqual((await readdir(path)).sort(), [
    "admin-credentials.json",
    "admin-login.txt",
  ]);
});

test("queued authentication change captures request data before caller mutations", async () => {
  const credentials = new MemoryCredentials({ password: initial });
  const input = change();
  const pending = credentials.change(input);
  input.newPassword = "changed-after-call";
  input.confirmPassword = "changed-after-call";
  await pending;
  assert.equal(credentials.verify(replacement), true);
  assert.equal(credentials.verify(input.newPassword), false);
});

test("existing hashes always take precedence over changed legacy plaintext", async (t) => {
  const path = await directory(t);
  await writeFile(join(path, "admin-login.txt"), initial);
  await openCredentials({ directory: path });
  await writeFile(join(path, "admin-login.txt"), replacement);
  const reopened = await openCredentials({ directory: path });
  assert.equal(reopened.verify(initial), true);
  assert.equal(reopened.verify(replacement), false);
});

test("concurrent password changes cannot both use a stale current password", async () => {
  const credentials = new MemoryCredentials({ password: initial });
  const results = await Promise.allSettled([
    credentials.change(change()),
    credentials.change(change(initial, "fixture-another-password")),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(results[1].reason.status, 403);
  assert.equal(credentials.verify(replacement), true);
});

async function startupLink(t, target, path, directory = false) {
  try {
    await symlink(
      target,
      path,
      directory ? (process.platform === "win32" ? "junction" : "dir") : "file",
    );
    return true;
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EPERM", "EACCES"].includes(error.code)
    ) {
      t.skip("Windows file symlink privilege unavailable");
      return false;
    }
    throw error;
  }
}

test("credential startup refuses a linked secrets directory without creating external state", async (t) => {
  const root = await directory(t),
    outside = join(root, "outside"),
    secrets = join(root, "secrets");
  await mkdir(outside);
  if (!(await startupLink(t, outside, secrets, true))) return;
  await assert.rejects(openCredentials({ directory: secrets }), /경로|안전/);
  assert.deepEqual(await readdir(outside), []);
});

for (const name of ["admin-login.txt", "admin-credentials.json"])
  test(`credential startup refuses a linked ${name} without changing its external target`, async (t) => {
    const root = await directory(t),
      secrets = join(root, "secrets"),
      outside = join(root, "outside-file");
    await mkdir(secrets);
    const value =
      name === "admin-login.txt"
        ? "outside-password-fixture"
        : JSON.stringify({
            version: 1,
            algorithm: "scrypt",
            salt: "a".repeat(64),
            hash: "b".repeat(128),
          });
    await writeFile(outside, value, { mode: 0o644 });
    const originalMode = (await stat(outside)).mode;
    if (!(await startupLink(t, outside, join(secrets, name)))) return;
    await assert.rejects(openCredentials({ directory: secrets }), /경로|안전/);
    assert.equal(await readFile(outside, "utf8"), value);
    assert.equal((await stat(outside)).mode, originalMode);
    assert.deepEqual(await readdir(secrets), [name]);
  });

test("credential startup rejects a linked ancestor before creating a missing secrets directory", async (t) => {
  const root = await directory(t),
    outside = join(root, "outside"),
    alias = join(root, "alias");
  await mkdir(outside);
  if (!(await startupLink(t, outside, alias, true))) return;
  await assert.rejects(
    openCredentials({ directory: join(alias, "new-secrets") }),
    /경로|안전/,
  );
  assert.deepEqual(await readdir(outside), []);
});

test("credential startup creates a missing nested installation directory inside its verified parent", async (t) => {
  const root = await directory(t),
    secrets = join(root, "installation", "secrets");
  const credentials = await openCredentials({ directory: secrets });
  const initialPassword = (
    await readFile(join(secrets, "admin-login.txt"), "utf8")
  ).trim();
  assert.equal(credentials.verify(initialPassword), true);
  assert.deepEqual((await readdir(secrets)).sort(), [
    "admin-credentials.json",
    "admin-login.txt",
  ]);
  if (process.platform !== "win32")
    for (const path of [join(root, "installation"), secrets])
      assert.equal((await stat(path)).mode & 0o777, 0o700);
});
