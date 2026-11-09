import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, cp, symlink, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

async function stagedWorker(t) {
  const root = await mkdtemp(join(tmpdir(), "recovery-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = fileURLToPath(new URL("../", import.meta.url));
  const worker = join(root, "verified-worker"), installed = join(root, "installed");
  await mkdir(join(worker, "tools"), { recursive: true });
  await mkdir(join(installed, "tools"), { recursive: true });
  await mkdir(join(installed, ".updates"));
  await cp(join(project, "src"), join(worker, "src"), { recursive: true });
  await cp(join(project, "run.mjs"), join(worker, "run.mjs"));
  await cp(join(project, "tools", "update.mjs"), join(worker, "tools", "update.mjs"));
  await symlink(join(project, "node_modules"), join(worker, "node_modules"), "junction");
  const recovery = await readFile(join(project, "tools", "recover-update.mjs"), "utf8") + "\n// verified-staging-recovery\n";
  await writeFile(join(worker, "tools", "recover-update.mjs"), recovery);
  const legacy = "const allowed=/^src\\/[^/]+\\.mjs$/;\n// old installed recovery\n";
  await writeFile(join(installed, "tools", "recover-update.mjs"), legacy);
  const module = await import(pathToFileURL(join(worker, "tools", "update.mjs")).href);
  return { worker, installed, recovery, legacy, module };
}

test("bootstrap installs its own verified recovery, preserving the old target helper", async t => {
  const { installed, recovery, legacy, module } = await stagedWorker(t);
  await module.prepareRecovery(join(installed, ".updates"));
  assert.equal(await readFile(join(installed, ".updates", "recover.mjs"), "utf8"), recovery);
  assert.equal(await readFile(join(installed, "tools", "recover-update.mjs"), "utf8"), legacy);
  const allowed = Function("return " + recovery.match(/const allowed\s*=\s*(\/.*\/);/)[1])();
  assert.ok(allowed.test("src/hermes-tether.py"), "new journal paths must remain recoverable");
});

test("missing staged recovery fails before replacing a previously prepared recovery", async t => {
  const { worker, installed, module } = await stagedWorker(t);
  const previous = join(installed, ".updates", "recover.mjs");
  await writeFile(previous, "existing recovery canary");
  await rm(join(worker, "tools", "recover-update.mjs"));
  await assert.rejects(module.prepareRecovery(join(installed, ".updates")), { code: "ENOENT" });
  assert.equal(await readFile(previous, "utf8"), "existing recovery canary");
});

test("staged standalone recovery restores new tether journal paths without runtime dependencies", async t => {
  const { worker, installed, module } = await stagedWorker(t);
  const base = join(installed, ".updates"), id = "100-aaaaaaaa";
  await module.prepareRecovery(base);
  const paths = ["src/hermes-tether.py", "deploy/novel-collector-tether.service", "deploy/novel-collector-tether.tmpfiles.conf"];
  await mkdir(join(installed, "src")); await mkdir(join(installed, "deploy")); await mkdir(join(installed, "data"));
  await writeFile(join(installed, "data", "canary.txt"), "PRIVATE_CANARY");
  for (const path of paths) await writeFile(join(installed, path), "NEW_SOURCE");
  const backup = join(base, "backups", id, "source", "deploy");
  await mkdir(backup, { recursive: true });
  await writeFile(join(backup, "novel-collector-tether.service"), "PREVIOUS_SERVICE");
  await writeFile(join(base, "transaction.json"), JSON.stringify({
    id, operations: paths.map(path => ({ path, existed: path.endsWith(".service") })), previousMetadata: {}
  }));
  await rm(join(worker, "node_modules"));
  await exec(process.execPath, [join(base, "recover.mjs"), installed], { timeout: 5000 });
  await assert.rejects(access(join(installed, paths[0])), { code: "ENOENT" });
  assert.equal(await readFile(join(installed, paths[1]), "utf8"), "PREVIOUS_SERVICE");
  await assert.rejects(access(join(installed, paths[2])), { code: "ENOENT" });
  await assert.rejects(access(join(base, "transaction.json")), { code: "ENOENT" });
  assert.equal(await readFile(join(installed, "data", "canary.txt"), "utf8"), "PRIVATE_CANARY");
});
