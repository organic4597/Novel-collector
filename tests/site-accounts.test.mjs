import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  stat,
  rm,
  mkdir,
} from "node:fs/promises";
import { randomBytes, randomInt } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SiteAccounts } from "../src/site-accounts.mjs";
const host = "newtoki1.org";
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "collector-site-accounts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const accounts = new SiteAccounts({ directory });
  await accounts.load();
  const secret = {
    username: "fixture_member",
    password: randomBytes(20).toString("hex"),
    pin: String(randomInt(10000)).padStart(4, "0"),
  };
  return { directory, accounts, secret };
}

test("site account secrets are encrypted, public status is redacted and disabled by default", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.accounts.status(host), {
    host,
    configured: false,
    enabled: false,
    username: "",
  });
  assert.equal(f.accounts.getCredentials(host), null);
  const state = await f.accounts.save({ host, ...f.secret, enabled: false });
  assert.equal(state.configured, true);
  assert.equal(state.enabled, false);
  assert.equal(f.accounts.getCredentials(host), null);
  const file = await readFile(join(f.directory, "site-accounts.json"), "utf8");
  assert.ok(!file.includes(f.secret.password));
  assert.ok(!file.includes(f.secret.pin));
  assert.doesNotMatch(
    JSON.stringify(state),
    /password|pin|masterKey|directory/,
  );
  if (process.platform !== "win32") {
    assert.equal(
      (await stat(join(f.directory, "site-accounts.key"))).mode & 0o777,
      0o600,
    );
    assert.equal(
      (await stat(join(f.directory, "site-accounts.json"))).mode & 0o777,
      0o600,
    );
  }
});

test("reopen and partial changes retain omitted secrets, clear removes only the selected host", async (t) => {
  const f = await fixture(t);
  await f.accounts.save({ host, ...f.secret, enabled: true });
  const reopened = new SiteAccounts({ directory: f.directory });
  await reopened.load();
  assert.deepEqual(reopened.getCredentials(host), { host, ...f.secret });
  await reopened.save({ host, username: "changed_member", enabled: true });
  assert.deepEqual(reopened.getCredentials(host), {
    host,
    ...f.secret,
    username: "changed_member",
  });
  await reopened.save({ host: "newtoki2.org", ...f.secret, enabled: true });
  await reopened.clear(host);
  assert.equal(reopened.status(host).configured, false);
  assert.equal(reopened.getCredentials(host), null);
  assert.equal(reopened.status("newtoki2.org").configured, true);
});

test("account configuration validates hosts, explicit enablement, exact PINs and known fields", async (t) => {
  const f = await fixture(t);
  for (const input of [
    { host, username: "member", enabled: true },
    { host, ...f.secret },
    { host, ...f.secret, enabled: "true" },
    { host, ...f.secret, enabled: true, token: "invalid" },
    { host, ...f.secret, enabled: true, password: "" },
    { host, ...f.secret, enabled: true, password: "x".repeat(129) },
    { host, ...f.secret, enabled: true, pin: "12" },
    { host, ...f.secret, enabled: true, pin: 1234 },
    { host, ...f.secret, enabled: true, username: "ab" },
    { host, ...f.secret, enabled: true, username: "x".repeat(21) },
    { host, ...f.secret, enabled: true, username: "invalid-member" },
    { host: "localhost", ...f.secret, enabled: true },
    { host: "../escape", ...f.secret, enabled: true },
  ])
    await assert.rejects(f.accounts.save(input), { status: 400 });
  assert.equal(f.accounts.status(host).configured, false);
});

test("tampered encryption, malformed data and missing master key fail closed without exposing secrets", async (t) => {
  const f = await fixture(t);
  await f.accounts.save({ host, ...f.secret, enabled: true });
  const filePath = join(f.directory, "site-accounts.json");
  const original = JSON.parse(await readFile(filePath, "utf8"));
  const damaged = structuredClone(original);
  const bytes = Buffer.from(damaged.accounts[host].data, "base64");
  bytes[0] ^= 1;
  damaged.accounts[host].data = bytes.toString("base64");
  await writeFile(filePath, JSON.stringify(damaged));
  const bad = new SiteAccounts({ directory: f.directory });
  await assert.rejects(
    bad.load(),
    (error) =>
      error.status === 500 &&
      !error.message.includes(f.secret.password) &&
      !error.message.includes(f.secret.pin),
  );
  assert.throws(() => bad.getCredentials(host));
  await writeFile(filePath, "malformed");
  await assert.rejects(new SiteAccounts({ directory: f.directory }).load(), {
    status: 500,
  });
  await writeFile(filePath, JSON.stringify(original));
  await rm(join(f.directory, "site-accounts.key"));
  await assert.rejects(new SiteAccounts({ directory: f.directory }).load(), {
    status: 500,
  });
});

test("explicit master keys reopen encrypted storage and concurrent partial writes merge safely", async (t) => {
  const f = await fixture(t);
  const directory = join(f.directory, "provided-key");
  const key = randomBytes(32);
  const accounts = new SiteAccounts({ directory, masterKey: key });
  await accounts.load();
  await accounts.save({ host, ...f.secret, enabled: true });
  const replacement = randomBytes(24).toString("hex");
  await Promise.all([
    accounts.save({ host, username: "new_member", enabled: true }),
    accounts.save({ host, password: replacement, enabled: true }),
  ]);
  const reopened = new SiteAccounts({
    directory,
    masterKey: key.toString("base64"),
  });
  await reopened.load();
  assert.deepEqual(reopened.getCredentials(host), {
    host,
    ...f.secret,
    username: "new_member",
    password: replacement,
  });
  await assert.rejects(
    new SiteAccounts({ directory, masterKey: randomBytes(32) }).load(),
    { status: 500 },
  );
});

test("failed encrypted writes preserve active credentials and return only generic errors", async (t) => {
  const f = await fixture(t);
  await f.accounts.save({ host, ...f.secret, enabled: true });
  const path = join(f.directory, "site-accounts.json");
  await rm(path);
  await mkdir(path);
  await assert.rejects(
    f.accounts.save({ host, username: "changed_member", enabled: false }),
    (error) =>
      error.status === 500 &&
      !error.message.includes(path) &&
      !error.message.includes(f.secret.password),
  );
  assert.deepEqual(f.accounts.getCredentials(host), { host, ...f.secret });
});
