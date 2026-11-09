import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CollectionTransport } from "../src/collection-transport.mjs";

async function fixture(t, { enabled = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "novel-collection-transport-")), socketPath = join(root, "proxy.sock");
  const network = { enabled, available: true, checks: 0, assertAvailable() { this.checks++; if (!this.available) throw Error("not connected"); } };
  const server = http.createServer((_req, res) => { res.writeHead(200); res.end("relay"); });
  const sockets = new Set(), targets = [];
  let connections = 0;
  server.on("connection", socket => { connections++; sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("connect", (req, socket) => {
    targets.push(req.url);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.pipe(socket);
  });
  server.listen(socketPath); await once(server, "listening");
  const transport = new CollectionTransport({ network, socketPath });
  t.after(async () => {
    await transport.close(); for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
  });
  return { transport, network, targets, server, get connections() { return connections; }, socketPath };
}
function connectTunnel(transport, authority = "example.com:443") {
  const port = Number(new URL(transport.proxyOptions().proxy.server).port);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: authority, agent: false });
    req.on("error", reject);
    req.on("connect", (res, socket) => resolve({ res, socket }));
    req.end();
  });
}

test("direct mode has no listener, browser flags or HTTPS agent", async t => {
  const { transport, network } = await fixture(t, { enabled: false });
  await transport.start();
  assert.equal(transport.enabled, false); assert.deepEqual(transport.proxyOptions(), {});
  assert.deepEqual(transport.launchOptions(), {}); assert.deepEqual(transport.persistentOptions(), {});
  assert.equal(transport.agent, undefined); assert.equal(network.checks, 0);
});

test("loopback relay forwards only to Unix proxy and browser options prevent direct routes", { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.transport.start();
  const config = f.transport.persistentOptions();
  const proxyUrl = new URL(config.proxy.server);
  assert.equal(proxyUrl.hostname, "127.0.0.1"); assert.ok(Number(proxyUrl.port) > 0);
  assert.equal(config.proxy.bypass, "<-loopback>");
  assert.ok(config.args.includes("--disable-quic"));
  assert.ok(config.args.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));
  assert.ok(config.args.includes("--dns-prefetch-disable"));
  assert.ok(config.args.some(x => x.startsWith("--host-resolver-rules=MAP * ~NOTFOUND")));
  const { res, socket } = await connectTunnel(f.transport);
  assert.equal(res.statusCode, 200); assert.deepEqual(f.targets, ["example.com:443"]);
  socket.write("through tether"); const [data] = await once(socket, "data");
  assert.equal(data.toString(), "through tether"); socket.destroy();
});

test("offline startup preserves dashboard relay without any Unix connections", { timeout: 5000 }, async t => {
  const f = await fixture(t); f.network.available = false;
  await f.transport.start();
  assert.ok(f.transport.server.listening);
  assert.equal(f.connections, 0);
  f.network.available = true; await f.transport.start();
  const port = Number(new URL(f.transport.proxyOptions().proxy.server).port);
  f.network.available = false;
  assert.throws(() => f.transport.proxyOptions(), { code: "COLLECTION_NETWORK_PAUSED" });
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: "example.com:443", agent: false });
    req.on("error", reject); req.on("connect", (response, socket) => { socket.destroy(); resolve(response.statusCode); }); req.end();
  });
  assert.equal(status, 503); assert.equal(f.connections, 0);
  assert.throws(() => f.transport.agent, { code: "COLLECTION_NETWORK_PAUSED" });
});

test("disconnect terminates live relay tunnels without stopping the listener", { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.transport.start();
  const endpoint = f.transport.proxyOptions().proxy.server;
  const { socket } = await connectTunnel(f.transport); socket.on("error", () => {});
  const closed = once(socket, "close"); f.network.available = false; f.transport.disconnect();
  await closed; assert.equal(socket.destroyed, true);
  f.network.available = true;
  assert.equal(f.transport.proxyOptions().proxy.server, endpoint);
  const next = await connectTunnel(f.transport); next.socket.destroy();
});

test("HTTPS agent uses CONNECT, destination SNI and enforced certificate validation", { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.transport.start();
  let observed;
  t.mock.method(tls, "connect", options => {
    observed = options;
    const secured = new PassThrough(); secured.on("close", () => options.socket.destroy());
    queueMicrotask(() => secured.emit("secureConnect")); return secured;
  });
  const secure = await new Promise((resolve, reject) => f.transport.agent.createConnection(
    { host: "example.com", port: 443, rejectUnauthorized: false, servername: "untrusted.example" },
    (error, socket) => error ? reject(error) : resolve(socket)));
  assert.deepEqual(f.targets, ["example.com:443"]);
  assert.equal(observed.host, "example.com"); assert.equal(observed.servername, "example.com");
  assert.equal(observed.rejectUnauthorized, true); secure.destroy();
});

test("HTTPS agent refuses malformed targets and returns sanitized unavailable errors", { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.transport.start();
  const agent = f.transport.agent;
  for (const options of [{ host: "user:secret@example.com", port: 443 }, { host: "example.com\r\nX: bad", port: 443 }, { host: "example.com", port: 444 }]) {
    await assert.rejects(new Promise((resolve, reject) => agent.createConnection(options,
      (error, socket) => error ? reject(error) : resolve(socket))), { code: "COLLECTION_NETWORK_PAUSED" });
  }
  assert.equal(f.connections, 0);
  f.network.available = false;
  await assert.rejects(new Promise((resolve, reject) => agent.createConnection({ host: "example.com", port: 443 },
    (error, socket) => error ? reject(error) : resolve(socket))), { code: "COLLECTION_NETWORK_PAUSED" });
  assert.equal(f.connections, 0);
});

test("unstarted and closed transports fail closed, close is idempotent", { timeout: 5000 }, async t => {
  assert.throws(() => new CollectionTransport({ socketPath: "relative" }));
  const f = await fixture(t);
  assert.throws(() => f.transport.proxyOptions(), { code: "COLLECTION_NETWORK_PAUSED" });
  await f.transport.start(); await f.transport.close(); await f.transport.close();
  assert.throws(() => f.transport.proxyOptions(), { code: "COLLECTION_NETWORK_PAUSED" });
  await assert.rejects(f.transport.start(), { code: "COLLECTION_NETWORK_PAUSED" });
});

test("rejected proxy tunnels and certificate errors are sanitized and cleaned up", { timeout: 5000 }, async t => {
  const f = await fixture(t); await f.transport.start();
  f.server.removeAllListeners("connect");
  f.server.on("connect", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
  await assert.rejects(new Promise((resolve, reject) => f.transport.agent.createConnection({ host: "example.com", port: 443 },
    (error, socket) => error ? reject(error) : resolve(socket))), { code: "COLLECTION_NETWORK_PAUSED" });
  f.server.removeAllListeners("connect");
  f.server.on("connect", (_request, socket) => socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"));
  t.mock.method(tls, "connect", options => {
    const secure = new PassThrough(); secure.once("close", () => options.socket.destroy());
    queueMicrotask(() => secure.destroy(Error("certificate fixture detail"))); return secure;
  });
  await assert.rejects(new Promise((resolve, reject) => f.transport.agent.createConnection({ host: "example.com", port: 443 },
    (error, socket) => error ? reject(error) : resolve(socket))), error => error.code === "COLLECTION_NETWORK_PAUSED" && !error.message.includes("fixture"));
});

test("absent Unix proxy cannot fall back to a direct target connection", { timeout: 5000 }, async t => {
  const f = await fixture(t); await new Promise(resolve => f.server.close(resolve)); await f.transport.start();
  await assert.rejects(new Promise((resolve, reject) => f.transport.agent.createConnection({ host: "example.com", port: 443 },
    (error, socket) => error ? reject(error) : resolve(socket))), { code: "COLLECTION_NETWORK_PAUSED" });
  assert.equal(f.connections, 0);
});
