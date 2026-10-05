import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openCredentials } from "../src/auth.mjs";
import { AdminSessions, SESSION_TTL_MS } from "../src/admin-sessions.mjs";
import { RESET_CONFIRMATION } from "../src/admin-recovery.mjs";
import {
  parseResetArguments,
  resetLocalAdmin,
  main,
} from "../tools/reset-admin.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "novel-reset-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "novel-collector" }),
  );
  await mkdir(join(root, "secrets"));
  await writeFile(
    join(root, "secrets", "admin-login.txt"),
    "old-cli-fixture-password",
  );
  const credentials = await openCredentials({
    directory: join(root, "secrets"),
  });
  return {
    root,
    rootDir: root,
    credentials,
    confirmation: RESET_CONFIRMATION,
    serviceStopped: true,
  };
}

test("operator reset requires explicit stopped-service acknowledgement and the exact confirmation phrase", () => {
  assert.deepEqual(
    parseResetArguments([
      "--root",
      "/fixture",
      "--service-stopped",
      "--confirm",
      RESET_CONFIRMATION,
    ]),
    {
      rootDir: "/fixture",
      serviceStopped: true,
      confirmation: RESET_CONFIRMATION,
    },
  );
  assert.deepEqual(parseResetArguments(["--help"]), { help: true });
  for (const args of [
    [],
    ["--confirm", RESET_CONFIRMATION],
    ["--service-stopped"],
    ["--root"],
    ["--password", "secret"],
    ["--service-stopped", "--confirm", "wrong"],
    [
      "--root",
      "/a",
      "--root",
      "/b",
      "--service-stopped",
      "--confirm",
      RESET_CONFIRMATION,
    ],
  ])
    assert.throws(() => parseResetArguments(args), /복구|종료|확인|옵션/);
});

test("CLI refuses an active or malformed installation marker without changing credentials", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, ".updates"));
  for (const filename of ["server.json", "instance.json"]) {
    await writeFile(
      join(f.root, ".updates", filename),
      JSON.stringify({ pid: process.pid }),
    );
    await assert.rejects(resetLocalAdmin(f), /종료/);
    assert.equal(f.credentials.verify("old-cli-fixture-password"), true);
    await rm(join(f.root, ".updates", filename));
  }
  await writeFile(join(f.root, ".updates", "server.json"), "broken");
  await assert.rejects(resetLocalAdmin(f), /실행 기록/);
});

test("stopped CLI reset rotates the password, preserves data and retires durable cookies", async (t) => {
  const f = await fixture(t),
    token = "a".repeat(64);
  const store = { path: (...parts) => join(f.root, "data", ...parts) };
  const sessions = new AdminSessions({
    store,
    binding: f.credentials.sessionVersion(),
  });
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  await sessions.flush();
  await mkdir(join(f.root, "profile"));
  await writeFile(join(f.root, "profile", "marker"), "untouched");
  const result = await resetLocalAdmin(f);
  assert.deepEqual(result, {
    reset: true,
    passwordFile: join(f.root, "secrets", "admin-login.txt"),
  });
  assert.equal(result.newPassword, undefined);
  const password = (await readFile(result.passwordFile, "utf8")).trim();
  const credentials = await openCredentials({
    directory: join(f.root, "secrets"),
  });
  assert.equal(credentials.verify(password), true);
  assert.equal(credentials.verify("old-cli-fixture-password"), false);
  const restarted = new AdminSessions({
    store,
    binding: credentials.sessionVersion(),
  });
  await restarted.load();
  assert.equal(restarted.get(token), null);
  assert.equal(
    await readFile(join(f.root, "profile", "marker"), "utf8"),
    "untouched",
  );
});

test("CLI output reports only the private file path and never logs the new password", async (t) => {
  const f = await fixture(t),
    output = [],
    errors = [];
  const code = await main(
    ["--root", f.root, "--service-stopped", "--confirm", RESET_CONFIRMATION],
    {
      write: (line) => output.push(line),
      errorWrite: (line) => errors.push(line),
    },
  );
  assert.equal(code, 0);
  const password = (
    await readFile(join(f.root, "secrets", "admin-login.txt"), "utf8")
  ).trim();
  assert.equal(output.join("\n").includes(password), false);
  assert.equal(output.join("\n").includes("admin-login.txt"), true);
  assert.deepEqual(errors, []);
  assert.equal(
    await main(["--help"], {
      write: (line) => output.push(line),
      errorWrite: (line) => errors.push(line),
    }),
    0,
  );
  assert.equal(
    await main([], {
      write: (line) => output.push(line),
      errorWrite: (line) => errors.push(line),
    }),
    1,
  );
  assert.equal(errors.join("\n").includes(password), false);
});

test("CLI does not create administrator state in an unrelated or unprepared directory", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, "package.json"),
    JSON.stringify({ name: "unrelated-project" }),
  );
  await assert.rejects(resetLocalAdmin(f), /설치/);
  await writeFile(
    join(f.root, "package.json"),
    JSON.stringify({ name: "novel-collector" }),
  );
  await rm(join(f.root, "secrets"), { recursive: true });
  await assert.rejects(resetLocalAdmin(f), /인증 정보/);
});

for (const relative of [
  ".updates/server.json",
  ".updates/instance.json",
  "secrets/admin-credentials.json",
  "secrets/admin-login.txt",
  "data/admin-sessions.json",
])
  test(`CLI recovery refuses the linked file ${relative}`, async (t) => {
    const f = await fixture(t),
      target = join(f.root, "outside-file-fixture"),
      path = join(f.root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(target, "external-fixture-never-change");
    await rm(path, { force: true });
    try {
      await symlink(target, path, "file");
    } catch (error) {
      if (
        process.platform === "win32" &&
        ["EPERM", "EACCES"].includes(error.code)
      )
        return t.skip("Windows file symlink privilege unavailable");
      throw error;
    }
    await assert.rejects(resetLocalAdmin(f), /경로|안전/);
    assert.equal(
      await readFile(target, "utf8"),
      "external-fixture-never-change",
    );
  });

for (const name of ["secrets", ".updates", "data"])
  test(`CLI recovery refuses the linked directory ${name}`, async (t) => {
    const f = await fixture(t),
      path = join(f.root, name),
      target = join(f.root, name + "-linked-backup");
    await mkdir(path, { recursive: true });
    await rename(path, target);
    await symlink(
      target,
      path,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(resetLocalAdmin(f), /경로|안전/);
  });

test("operator command help and missing acknowledgement use safe exit codes without accessing credentials", async (t) => {
  const f = await fixture(t),
    script = fileURLToPath(
      new URL("../tools/reset-admin.mjs", import.meta.url),
    );
  const path = join(f.root, "secrets", "admin-credentials.json"),
    before = await readFile(path, "utf8");
  const help = spawnSync(process.execPath, [script, "--help"], {
    cwd: f.root,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--service-stopped/);
  assert.equal(help.stderr, "");
  const refused = spawnSync(process.execPath, [script], {
    cwd: f.root,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /종료/);
  assert.equal(refused.stdout, "");
  assert.equal(await readFile(path, "utf8"), before);
});
