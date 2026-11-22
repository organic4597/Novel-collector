#!/usr/bin/node
import * as fs from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";

const execute = promisify(execFile);
const fail = () => Object.assign(Error("수집 전용 브라우저 네트워크를 확인하세요."), {
  code: "COLLECTION_NAMESPACE_UNAVAILABLE",
});
const safePath = value => typeof value === "string" && isAbsolute(value) &&
  value !== "/" && normalize(value) === value && !value.includes("\0");
function validConfig(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(key => ["namespace", "interface", "user", "executablePath"].includes(key)) &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.namespace || "") &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,14}$/.test(value.interface || "") && value.interface !== "lo" &&
    /^[a-z_][a-z0-9_-]{0,31}$/.test(value.user || "") && value.user !== "root" &&
    safePath(value.executablePath);
}

export async function readNamespaceConfig(path, io = fs) {
  const info = await io.lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 ||
      (info.mode & 0o022) || info.nlink !== 1 || info.size > 8192) throw fail();
  const config = JSON.parse(await io.readFile(path, "utf8"));
  if (!validConfig(config)) throw fail();
  return config;
}

export function namespaceBrowserPlan(config, state, account, args) {
  if (!validConfig(config) || !Number.isSafeInteger(account?.uid) || account.uid < 1 ||
      !Number.isSafeInteger(account.gid) || account.gid < 1 || !safePath(account.home) ||
      !Array.isArray(args) || args.length > 200 || !args.includes("--remote-debugging-pipe") ||
      args.some(arg => typeof arg !== "string" || arg.includes("\0")) ||
      args.some(arg => ["--no-sandbox", "--disable-setuid-sandbox", "--disable-web-security"].includes(arg) ||
        /^--remote-debugging-(?:port|address)(?:=|$)/.test(arg)) ||
      args.join("\0").length > 65536) throw fail();
  const device = config.interface;
  const links = state.links;
  const ready = state.hostInode && state.namespaceInode && state.hostInode !== state.namespaceInode &&
    Array.isArray(links) && links.length === 2 && links.some(link => link.ifname === "lo") &&
    links.some(link => link.ifname === device && link.flags?.includes("UP") && link.flags?.includes("LOWER_UP")) &&
    [state.routes, state.ipv6Routes].every(routes => Array.isArray(routes) && routes.length === 1 &&
      routes[0].dst === "default" && routes[0].dev === device) &&
    state.addresses?.some(link => link.ifname === device && link.addr_info?.some(address =>
      address.family === "inet6" && address.scope === "global" && !address.tentative && !address.dadfailed));
  if (!ready) throw fail();
  return {
    file: "/usr/sbin/ip",
    args: ["netns", "exec", config.namespace, "/usr/bin/setpriv", `--reuid=${account.uid}`,
      `--regid=${account.gid}`, "--init-groups", "--no-new-privs", "--bounding-set=-all",
      "--inh-caps=-all", "--ambient-caps=-all", "--", config.executablePath, ...args],
    env: { PATH: "/usr/bin:/bin", HOME: account.home, USER: config.user,
      LOGNAME: config.user, LANG: "ko_KR.UTF-8" },
  };
}

export async function prepareNamespaceBrowser(args, {
  configPath = "/etc/novel-collector-namespace-browser.json", io = fs,
  run = execute, uid = () => process.getuid?.(),
} = {}) {
  if (process.platform !== "linux" || uid() !== 0) throw fail();
  const config = await readNamespaceConfig(configPath, io);
  const namespacePath = "/run/netns/" + config.namespace;
  const info = await io.lstat(namespacePath);
  if (info.isSymbolicLink() || info.uid !== 0) throw fail();
  const command = async (file, argv) => (await run(file, argv, {
    timeout: 15000, maxBuffer: 1024 * 1024, encoding: "utf8",
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
  })).stdout.trim();
  const [links, routes, ipv6Routes, addresses] = await Promise.all([
    ["-j", "link", "show"], ["-j", "-4", "route", "show", "default"],
    ["-j", "-6", "route", "show", "default"], ["-j", "addr", "show"],
  ].map(argv => command("/usr/sbin/ip", ["-n", config.namespace, ...argv]).then(JSON.parse)));
  const fields = (await command("/usr/bin/getent", ["passwd", config.user])).split(":");
  if (fields.length !== 7 || fields[0] !== config.user) throw fail();
  const account = { uid: Number(fields[2]), gid: Number(fields[3]), home: fields[5] };
  const checkOnly = args.length === 1 && args[0] === "--check";
  const plan = namespaceBrowserPlan(config, {
    links, routes, ipv6Routes, addresses, namespaceInode: (await io.stat(namespacePath)).ino,
    hostInode: (await io.stat("/proc/self/ns/net")).ino,
  }, account, checkOnly ? ["--remote-debugging-pipe"] : args);
  return { ready: true, namespace: config.namespace, interface: config.interface, plan, account };
}

export class NamespaceBrowserBroker {
  constructor({ runtimeDir = "/run/novel-collector-namespace-browser",
    prepare = prepareNamespaceBrowser, launch = spawn, gid = process.getgid(), ownerUid = process.getuid() } = {}) {
    if (!safePath(runtimeDir) || Buffer.byteLength(runtimeDir + "/control.sock") > 100 ||
        !Number.isSafeInteger(gid) || gid < 0) throw fail();
    Object.assign(this, { runtimeDir, prepare, launch, gid, ownerUid });
    this.socketPath = runtimeDir + "/control.sock";
    this.sockets = new Set();
    this.children = new Set();
    this.server = null;
    this.closed = false;
    this.identity = null;
  }
  async start() {
    try { await fs.mkdir(this.runtimeDir, { mode: 0o750 }); }
    catch (e) { if (e.code !== "EEXIST") throw e; }
    const dir = await fs.lstat(this.runtimeDir);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== this.ownerUid || (dir.mode & 0o022)) throw fail();
    await fs.chown(this.runtimeDir, this.ownerUid, this.gid);
    this.server = net.createServer(socket => {
      if (this.closed || this.sockets.size >= 8) { socket.destroy(); return; }
      this.sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => this.sockets.delete(socket));
      let buffer = Buffer.alloc(0);
      const timer = setTimeout(() => socket.destroy(), 10000);
      socket.once("close", () => clearTimeout(timer));
      const receive = chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf(10);
        if ((end < 0 ? buffer.length : end) > 65536) { socket.destroy(); return; }
        if (end < 0) return;
        socket.pause(); socket.off("data", receive); clearTimeout(timer);
        let request;
        try { request = JSON.parse(buffer.subarray(0, end).toString("utf8")); }
        catch { socket.destroy(); return; }
        void this.handle(socket, request, buffer.subarray(end + 1)).catch(() => socket.destroy());
      };
      socket.on("data", receive);
    });
    await new Promise((done, reject) => {
      this.server.once("error", reject); this.server.listen(this.socketPath, done);
    });
    this.identity = await fs.lstat(this.socketPath);
    await fs.chown(this.socketPath, this.ownerUid, this.gid);
    await fs.chmod(this.socketPath, 0o660);
    this.identity = await fs.lstat(this.socketPath);
    return this;
  }
  async handle(socket, request, head) {
    if (this.closed || !request || typeof request !== "object" || Array.isArray(request) ||
        Object.keys(request).some(key => !["check", "args"].includes(key))) throw fail();
    const check = request.check === true && request.args === undefined;
    if (!check && (request.check !== undefined || !Array.isArray(request.args))) throw fail();
    const result = await this.prepare(check ? ["--check"] : request.args);
    if (this.closed || socket.destroyed) return;
    if (check) {
      socket.resume();
      socket.end(JSON.stringify({ ready: true, namespace: result.namespace, interface: result.interface }) + "\n");
      return;
    }
    const child = this.launch(result.plan.file, result.plan.args, {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env: result.plan.env,
    });
    this.children.add(child);
    let killed = false, killTimer;
    const stop = () => {
      if (killed || child.exitCode !== null || child.signalCode !== null) return;
      killed = true; child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3000); killTimer.unref();
    };
    socket.once("close", stop);
    child.once("error", () => { this.children.delete(child); socket.destroy(); });
    child.once("exit", () => {
      clearTimeout(killTimer); this.children.delete(child); socket.end();
    });
    child.stderr?.resume();
    for (const stream of [child.stdio[3], child.stdio[4]]) stream.on("error", () => socket.destroy());
    if (head.length) child.stdio[3].write(head);
    socket.pipe(child.stdio[3]); child.stdio[4].pipe(socket);
    socket.resume();
  }
  async close() {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    await Promise.all([...this.children].map(child => new Promise(done => {
      if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
      child.once("exit", done); child.kill("SIGTERM");
      const timer = setTimeout(() => { child.kill("SIGKILL"); done(); }, 3500);
      timer.unref(); child.once("exit", () => clearTimeout(timer));
    })));
    if (this.server?.listening) await new Promise(done => this.server.close(done));
    if (this.identity) {
      const info = await fs.lstat(this.socketPath).catch(() => null);
      if (info?.isSocket() && info.ino === this.identity.ino && info.dev === this.identity.dev)
        await fs.unlink(this.socketPath);
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let broker;
  Promise.resolve().then(async () => {
    if (process.getuid?.() !== 0 || process.argv.length !== 3 || process.argv[2] !== "--serve") throw fail();
    const config = await readNamespaceConfig("/etc/novel-collector-namespace-browser.json");
    const fields = (await execute("/usr/bin/getent", ["passwd", config.user])).stdout.trim().split(":");
    if (fields.length !== 7 || !Number.isSafeInteger(Number(fields[3])) || Number(fields[3]) < 1) throw fail();
    broker = new NamespaceBrowserBroker({ gid: Number(fields[3]) });
    for (const signal of ["SIGTERM", "SIGINT"])
      process.once(signal, () => { void broker.close().then(() => process.exit(0), () => process.exit(1)); });
    await broker.start();
    console.log("COLLECTION_NAMESPACE_BROKER_READY");
  }).catch(async () => {
    await broker?.close().catch(() => {});
    console.error("COLLECTION_NAMESPACE_UNAVAILABLE: 수집 전용 브라우저 네트워크를 확인하세요.");
    process.exitCode = 1;
  });
}
