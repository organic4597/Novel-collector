import http from "node:http";
import net, { isIP } from "node:net";
import { resolve4 } from "node:dns/promises";
import { chmod, lstat, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isPublicAddress } from "./public-address.mjs";

const fail = (status) => Object.assign(new Error("테더링 프록시 요청을 처리하지 못했습니다."), { status });
function hostName(value) {
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(value)) throw fail(400);
  return value;
}
function target(value, tunnel) {
  if (tunnel) {
    const match = /^([a-z0-9.-]+):443$/i.exec(value);
    if (!match) throw fail(400);
    return { hostname: hostName(match[1]), port: 443 };
  }
  let url;
  try { url = new URL(value); } catch { throw fail(400); }
  if (!value.startsWith("http://") || url.protocol !== "http:" || url.username || url.password || url.hash || url.port && url.port !== "80")
    throw fail(400);
  return { hostname: hostName(url.hostname), port: 80, path: url.pathname + url.search, host: url.host };
}
function headers(value) {
  const denied = new Set(["connection", "proxy-connection", "proxy-authorization", "proxy-authenticate", "keep-alive", "upgrade", "te", "trailer",
    ...String(value.connection || "").toLowerCase().split(",").map(x => x.trim())]);
  return Object.fromEntries(Object.entries(value).filter(([name]) => !denied.has(name.toLowerCase())));
}
function reply(response, status) {
  if (response.destroyed) return;
  if (response.headersSent) return response.destroy();
  response.writeHead(status, { Connection: "close", "Content-Length": "0" }); response.end();
}
function socketReply(socket, status) {
  if (!socket.destroyed) socket.end("HTTP/1.1 " + status + " " + (http.STATUS_CODES[status] || "Proxy Error") + "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

export async function startTetherProxy({
  socketPath,
  lookup = async hostname => (await resolve4(hostname)).map(address => ({address,family:4})),
  connect = options => net.createConnection(options),
  timeoutMs = 60000,
} = {}) {
  if (typeof socketPath !== "string" || !isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100 || socketPath.includes("\0") ||
      typeof lookup !== "function" || typeof connect !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 120000)
    throw new Error("테더링 프록시 소켓 경로와 제한 시간을 확인하세요.");
  const sockets = new Set();
  let closing = false, closeWork, identity;
  const track = socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    return socket;
  };
  const pinned = async hostname => {
    let timer;
    try {
      const addresses = await Promise.race([
        isIP(hostname) === 4 ? Promise.resolve([{ address: hostname, family: 4 }]) : lookup(hostname),
        new Promise((_, reject) => { timer = setTimeout(() => reject(fail(504)), timeoutMs); timer.unref(); }),
      ]);
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > 64 ||
          addresses.some(a => a.family !== 4 || isIP(a.address || "") !== 4 || !isPublicAddress(a.address))) throw fail(403);
      if (closing) throw fail(503);
      return addresses[0].address;
    } finally { clearTimeout(timer); }
  };
  const agent = new http.Agent({ keepAlive: false });
  agent.createConnection = options => track(connect({ host: options.host, port: Number(options.port), family: 4 }));
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: timeoutMs, headersTimeout: Math.min(10000, timeoutMs) }, (req, res) => {
    void (async () => {
      const destination = target(req.url, false), address = await pinned(destination.hostname);
      if (res.destroyed || closing) return;
      const upstream = http.request({ hostname: address, port: destination.port, family: 4,
        method: req.method, path: destination.path, headers: { ...headers(req.headers), host: destination.host }, agent }, incoming => {
        incoming.on("error", () => res.destroy());
        res.writeHead(incoming.statusCode, headers(incoming.headers));
        incoming.pipe(res);
      });
      upstream.on("socket", socket => socket.setTimeout(timeoutMs, () => upstream.destroy(fail(504))));
      upstream.on("error", error => reply(res, error.status === 504 ? 504 : 502));
      req.on("aborted", () => upstream.destroy());
      req.on("error", () => upstream.destroy());
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    })().catch(error => reply(res, [400, 403, 503, 504].includes(error.status) ? error.status : 502));
  });
  server.maxHeadersCount = 100;
  server.on("connection", socket => {
    track(socket); socket.setTimeout(timeoutMs * 2, () => socket.destroy());
  });
  server.on("connect", (req, client, head) => {
    client.pause();
    void (async () => {
      const destination = target(req.url, true), address = await pinned(destination.hostname);
      if (client.destroyed || closing) return;
      const upstream = track(connect({ host: address, port: destination.port, family: 4 }));
      let established = false;
      upstream.setTimeout(timeoutMs, () => upstream.destroy(fail(504)));
      upstream.on("error", error => {
        if (established) client.destroy();
        else socketReply(client, error.status === 504 ? 504 : 502);
      });
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => { if (established) client.destroy(); });
      upstream.once("connect", () => {
        if (client.destroyed || closing) { upstream.destroy(); return; }
        established = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client); client.resume();
      });
    })().catch(error => socketReply(client, [400, 403, 503, 504].includes(error.status) ? error.status : 502));
  });
  server.on("upgrade", (_req, socket) => socketReply(socket, 400));
  server.on("clientError", (_error, socket) => socketReply(socket, 400));
  try {
    await new Promise((done, reject) => {
      server.once("error", reject); server.once("listening", done);
      // The proxy is a dedicated process; set creation permissions before binding.
      const previous = process.umask(0o077);
      try { server.listen(socketPath); } finally { process.umask(previous); }
    });
    await chmod(socketPath, 0o600); identity = await lstat(socketPath);
  } catch (error) {
    closing = true; for (const socket of sockets) socket.destroy(); agent.destroy();
    if (server.listening) await new Promise(done => server.close(done));
    throw error;
  }
  const close = () => {
    if (closeWork) return closeWork;
    closing = true; for (const socket of sockets) socket.destroy(); agent.destroy();
    closeWork = (async () => {
      // Node unlinks the listener pathname while closing, so reject detected replacements first.
      const current = await lstat(socketPath);
      if(!current.isSocket()||current.ino!==identity.ino||current.dev!==identity.dev)throw Object.assign(Error("프록시 소켓 경로가 변경되어 정리를 중단했습니다."),{code:"TETHER_OWNERSHIP"});
      await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
      try {
        const current = await lstat(socketPath);
        if (current.isSocket() && current.ino === identity.ino && current.dev === identity.dev) await unlink(socketPath);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    })();
    return closeWork;
  };
  return { server, socketPath, close };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  startTetherProxy({ socketPath: process.argv[2] }).then(proxy => {
    const stop = () => { void proxy.close().then(() => process.exit(0), () => process.exit(1)); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
  }).catch(error => {
    console.error("테더링 프록시 시작 실패: " + (error.code || "CONFIGURATION"));
    process.exitCode = 1;
  });
}
