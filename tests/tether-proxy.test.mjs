import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtemp, stat, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startTetherProxy } from "../src/tether-proxy.mjs";

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "novel-tether-proxy-"));
  const socketPath = join(root, "proxy.sock");
  const proxy = await startTetherProxy({ socketPath, timeoutMs: 1000, ...options });
  t.after(async () => { await proxy.close(); await rm(root, { recursive: true, force: true }); });
  return { ...proxy, socketPath };
}
function request(socketPath, path, body = "", extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method: body ? "POST" : "GET",
      headers: { ...extraHeaders, ...(body ? { "Content-Length": Buffer.byteLength(body), "X-Test": "present" } : {}) } },
      res => {
        const chunks = []; res.on("data", c => chunks.push(c)); res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }));
      });
    req.on("error", reject); req.end(body);
  });
}
async function target(t, server) {
  const sockets = new Set();
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
const publicLookup = async () => [{ address: "8.8.8.8", family: 4 }];
function tunnel(socketPath, authority, head = "") {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let data = Buffer.alloc(0);
    socket.on("error", reject);
    socket.on("data", chunk => {
      data = Buffer.concat([data, chunk]);
      const boundary = data.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const status = Number(data.subarray(0, boundary).toString().split(" ")[1]);
      const body = data.subarray(boundary + 4).toString();
      if (status !== 200 || body === head) { socket.destroy(); resolve({ status, body }); }
    });
    socket.on("connect", () => socket.write("CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\n\r\n" + head));
  });
}

test("Unix proxy forwards CONNECT bytes and head through pinned IPv4", { timeout: 5000 }, async t => {
  const port = await target(t, net.createServer(socket => socket.pipe(socket)));
  const connects = [];
  const proxy = await fixture(t, { lookup: publicLookup, connect: options => {
    connects.push(options); return net.createConnection({ host: "127.0.0.1", port });
  }});
  assert.equal((await stat(proxy.socketPath)).mode & 0o777, 0o600);
  assert.deepEqual(await tunnel(proxy.socketPath, "example.com:443", "hello through tunnel"), { status: 200, body: "hello through tunnel" });
  assert.deepEqual(connects, [{ host: "8.8.8.8", port: 443, family: 4 }]);
});

test("absolute HTTP forwards method, path, body, host and response without proxy credentials", { timeout: 5000 }, async t => {
  let seen;
  const port = await target(t, http.createServer((req, res) => {
    const chunks = []; req.on("data", c => chunks.push(c)); req.on("end", () => {
      seen = { method: req.method, url: req.url, host: req.headers.host, body: Buffer.concat(chunks).toString(), proxyAuthorization: req.headers["proxy-authorization"], hop: req.headers["x-hop"], endToEnd: req.headers["x-test"] };
      res.writeHead(201, { "Content-Type": "text/plain" }); res.end("saved");
    });
  }));
  const proxy = await fixture(t, { lookup: publicLookup, connect: options => {
    assert.equal(options.host, "8.8.8.8"); assert.equal(Number(options.port), 80);
    return net.createConnection({ host: "127.0.0.1", port });
  }});
  const result = await request(proxy.socketPath, "http://example.com/read?q=1", "payload", { "Proxy-Authorization": "Basic Zml4dHVyZTo=", Connection: "keep-alive, X-Hop", "X-Hop": "remove" });
  assert.equal(result.status, 201); assert.equal(result.body, "saved");
  assert.deepEqual(seen, { method: "POST", url: "/read?q=1", host: "example.com", body: "payload", proxyAuthorization: undefined, hop: undefined, endToEnd: "present" });
});

test("invalid targets and private IPv4 never reach the connector", { timeout: 5000 }, async t => {
  let calls = 0;
  const proxy = await fixture(t, { lookup: publicLookup, connect: () => { calls++; throw Error("must not connect"); } });
  for (const path of ["http://user:secret@example.com/", "http://example.com:81/", "https://example.com/", "/relative", "http://[::1]/"])
    assert.equal((await request(proxy.socketPath, path)).status, 400, path);
  for (const path of ["http://127.0.0.1/", "http://10.1.2.3/", "http://169.254.169.254/", "http://192.168.1.1/", "http://100.64.1.2/"])
    assert.equal((await request(proxy.socketPath, path)).status, 403, path);
  for (const authority of ["example.com:80", "example.com:444", "user:secret@example.com:443", "example.com:443/extra", "[::1]:443", "example.com:NaN"])
    assert.equal((await tunnel(proxy.socketPath, authority)).status, 400, authority);
  assert.equal(calls, 0);
});

test("mixed DNS answers fail closed before connection", { timeout: 5000 }, async t => {
  let calls = 0;
  const proxy = await fixture(t, { lookup: async () => [...await publicLookup(), { address: "127.0.0.1", family: 4 }], connect: () => { calls++; throw Error("unexpected"); } });
  assert.equal((await request(proxy.socketPath, "http://example.com/")).status, 403);
  assert.equal((await tunnel(proxy.socketPath, "example.com:443")).status, 403);
  assert.equal(calls, 0);
});

test("resolver failures, refused upstream and lookup timeout return closed errors", { timeout: 5000 }, async t => {
  const failed = await fixture(t, { lookup: async () => { throw Error("private resolver detail"); } });
  assert.equal((await request(failed.socketPath, "http://example.com/")).status, 502);
  const refused = await fixture(t, { lookup: publicLookup, connect: () => { const socket = new net.Socket(); queueMicrotask(() => socket.destroy(Error("upstream refused"))); return socket; } });
  assert.equal((await tunnel(refused.socketPath, "example.com:443")).status, 502);
  const timed = await fixture(t, { lookup: () => new Promise(() => {}), timeoutMs: 40 });
  assert.equal((await request(timed.socketPath, "http://example.com/")).status, 504);
});

test("close destroys open tunnels and removes only its socket", { timeout: 5000 }, async t => {
  const port = await target(t, net.createServer(() => {}));
  const proxy = await fixture(t, { lookup: publicLookup, connect: () => net.createConnection({ host: "127.0.0.1", port }) });
  const client = net.createConnection({ path: proxy.socketPath }); await once(client, "connect");
  client.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"); await once(client, "data");
  const closed = once(client, "close");
  await proxy.close(); await closed;
  assert.equal(client.destroyed, true);
  await assert.rejects(stat(proxy.socketPath), { code: "ENOENT" });
  await proxy.close();
});

test("invalid socket options fail and an occupied path is never removed", { timeout: 5000 }, async t => {
  await assert.rejects(startTetherProxy({ socketPath: "relative.sock" }));
  await assert.rejects(startTetherProxy({ socketPath: "/tmp/x.sock", timeoutMs: 0 }));
  const root = await mkdtemp(join(tmpdir(), "novel-tether-occupied-")), socketPath = join(root, "occupied");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(socketPath, "keep existing content");
  await assert.rejects(startTetherProxy({ socketPath }), { code: "EADDRINUSE" });
  assert.equal(await readFile(socketPath, "utf8"), "keep existing content");
});

test("IPv6-only DNS answers have no wired or IPv6 fallback", { timeout: 5000 }, async t => {
  let connects = 0;
  const proxy = await fixture(t, { lookup: async () => [{ address: "2606:4700:4700::1111", family: 6 }], connect: () => { connects++; throw Error("not allowed"); } });
  assert.equal((await request(proxy.socketPath, "http://example.com/")).status, 403);
  assert.equal(connects, 0);
});

test("CLI binds a private Unix socket, denies local targets, and stops cleanly", { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "novel-tether-cli-")), socketPath = join(root, "proxy.sock");
  const cli = spawn(process.execPath, [fileURLToPath(new URL("../src/tether-proxy.mjs", import.meta.url)), socketPath], { stdio: "ignore" });
  const exited = once(cli, "exit");
  t.after(async () => { if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGKILL"); await exited; await rm(root, { recursive: true, force: true }); });
  const until = Date.now() + 3000;
  while (true) {
    try { await stat(socketPath); break; } catch (error) { if (error.code !== "ENOENT" || Date.now() > until) throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await request(socketPath, "http://127.0.0.1/")).status, 403);
  cli.kill("SIGTERM"); assert.deepEqual(await exited, [0, null]);
  await assert.rejects(stat(socketPath), { code: "ENOENT" });
});

test("CLI rejects invalid configuration with a nonzero exit", { timeout: 5000 }, async () => {
  const cli = spawn(process.execPath, [fileURLToPath(new URL("../src/tether-proxy.mjs", import.meta.url)), "relative.sock"], { stdio: "ignore" });
  assert.deepEqual(await once(cli, "exit"), [1, null]);
});
