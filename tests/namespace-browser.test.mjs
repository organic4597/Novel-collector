import test from "node:test";
import assert from "node:assert/strict";
import { readNamespaceConfig, namespaceBrowserPlan } from "../src/namespace-browser.mjs";
import { NamespaceBrowserBroker } from "../src/namespace-browser.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const config = { namespace: "nc-synthetic", interface: "usb0", user: "collector",
  executablePath: "/opt/runtime/chrome" };
const account = { uid: 1234, gid: 1234, home: "/var/lib/collector" };
const state = () => ({
  links: [{ ifname: "lo" }, { ifname: "usb0", flags: ["UP", "LOWER_UP"] }],
  routes: [{ dst: "default", dev: "usb0", gateway: "192.168.42.1" }],
  ipv6Routes: [{ dst: "default", dev: "usb0", gateway: "fe80::1" }],
  addresses: [{ ifname: "usb0", addr_info: [{ family: "inet6", local: "2001:db8::2", scope: "global" }] }],
  hostInode: 100, namespaceInode: 200,
});

test("namespace browser uses a fixed network namespace and drops privileges before executing Chromium", () => {
  const plan = namespaceBrowserPlan(config, state(), account, ["--remote-debugging-pipe", "--user-data-dir=/tmp/profile"]);
  assert.equal(plan.file, "/usr/sbin/ip");
  assert.deepEqual(plan.args.slice(0, 3), ["netns", "exec", "nc-synthetic"]);
  assert.ok(plan.args.includes("/usr/bin/setpriv"));
  assert.ok(plan.args.includes("--reuid=1234"));
  assert.ok(plan.args.includes("--regid=1234"));
  assert.ok(plan.args.includes("--no-new-privs"));
  assert.ok(plan.args.indexOf("/opt/runtime/chrome") > plan.args.indexOf("--no-new-privs"));
  assert.deepEqual(plan.args.slice(-2), ["--remote-debugging-pipe", "--user-data-dir=/tmp/profile"]);
});

test("namespace browser fails closed for a host namespace, foreign interface, wrong default or unfinished IPv6", () => {
  for (const patch of [
    { namespaceInode: 100 },
    { links: [...state().links, { ifname: "eth0" }] },
    { links: [{ ifname: "lo" }, { ifname: "usb0", flags: ["UP"] }] },
    { routes: [{ dst: "default", dev: "eth0", gateway: "192.168.1.1" }] },
    { ipv6Routes: [] },
    { ipv6Routes: [{ dst: "default", dev: "eth0" }] },
    { addresses: [{ ifname: "usb0", addr_info: [{ family: "inet6", scope: "global", tentative: true }] }] },
  ]) assert.throws(() => namespaceBrowserPlan(config, { ...state(), ...patch }, account, ["--remote-debugging-pipe"]),
    { code: "COLLECTION_NAMESPACE_UNAVAILABLE" });
  assert.throws(() => namespaceBrowserPlan(config, state(), { ...account, uid: 0 }, ["--remote-debugging-pipe"]));
  for (const flag of ["--no-sandbox", "--disable-setuid-sandbox", "--disable-web-security", "--remote-debugging-port=9222"])
    assert.throws(() => namespaceBrowserPlan(config, state(), account, ["--remote-debugging-pipe", flag]));
});

test("namespace configuration is root-owned data, not a shell command or an environment override", async () => {
  const file = { uid: 0, mode: 0o100600, size: 300, nlink: 1, isFile: () => true, isSymbolicLink: () => false };
  const io = { lstat: async () => file, readFile: async () => JSON.stringify(config) };
  assert.deepEqual(await readNamespaceConfig("/synthetic/config.json", io), config);
  for (const patch of [{ uid: 1234 }, { mode: 0o100666 }, { nlink: 2 }, { isSymbolicLink: () => true }])
    await assert.rejects(readNamespaceConfig("/synthetic/config.json", { ...io, lstat: async () => ({ ...file, ...patch }) }));
  for (const patch of [{ namespace: "../host" }, { interface: "--help" }, { executablePath: "relative" }, { user: "root" }])
    await assert.rejects(readNamespaceConfig("/synthetic/config.json", { ...io, readFile: async () => JSON.stringify({ ...config, ...patch }) }));
});

test("browser broker carries native pipe bytes over a private socket and rejects unknown requests", async t => {
  const root = await mkdtemp(join(tmpdir(), "nc-browser-broker-"));
  let preparations = 0;
  const broker = new NamespaceBrowserBroker({
    runtimeDir: join(root, "runtime"),
    launch: (file, args, options) => {
      assert.deepEqual(options.stdio, ["ignore", "ignore", "pipe", "pipe", "pipe"]);
      return spawn(file, args, options);
    },
    prepare: async args => {
      preparations++;
      assert.ok(args[0] === "--check" || args.includes("--remote-debugging-pipe"));
      return { namespace: "synthetic", interface: "usb0", plan: {
        file: process.execPath, args: ["-e",
          "require('fs').createReadStream(null,{fd:3}).pipe(require('fs').createWriteStream(null,{fd:4}))"],
        env: process.env,
      } };
    },
  });
  t.after(async () => { await broker.close(); await rm(root, { recursive: true, force: true }); });
  await broker.start();
  const exchange = (request, payload = "") => new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: broker.socketPath });
    let data = "";
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n" + payload));
    socket.on("data", chunk => {
      data += chunk.toString();
      if (payload && data === payload) { socket.destroy(); resolve(data); }
    });
    socket.on("close", () => resolve(data));
  });
  assert.equal(JSON.parse(await exchange({ check: true })).ready, true);
  const payload = '{"id":1,"method":"Browser.getVersion"}\0';
  assert.equal(await exchange({ args: ["--remote-debugging-pipe"] }, payload), payload);
  const count = preparations;
  assert.equal(await exchange({ command: "/bin/sh" }), "");
  assert.equal(preparations, count);
});
