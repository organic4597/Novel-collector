import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { isAbsolute } from "node:path";

const paused = () => Object.assign(new Error("수집 전용 테더링 연결을 확인하세요."), {
  code: "COLLECTION_NETWORK_PAUSED", status: 503,
});
const validHost = value => typeof value === "string" &&
  /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(value);

export class CollectionTransport {
  constructor({ network = null, socketPath = "/run/novel-collector-tether/proxy.sock" } = {}) {
    if (typeof socketPath !== "string" || !isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100 || socketPath.includes("\0"))
      throw new Error("수집 전용 프록시 소켓 경로를 확인하세요.");
    this.network = network;
    this.socketPath = socketPath;
    this.server = null;
    this.port = null;
    this.sockets = new Set();
    this._agent = null;
    this.startWork = null;
    this.closeWork = null;
    this.closed = false;
  }
  get enabled() { return !!this.network?.enabled; }
  assertAvailable() {
    if (!this.enabled) return;
    try {
      if (this.closed || typeof this.network?.assertAvailable !== "function") throw paused();
      this.network.assertAvailable();
    } catch { throw paused(); }
  }
  track(socket) {
    this.sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => this.sockets.delete(socket));
    return socket;
  }
  async start() {
    if (!this.enabled) return this;
    if (this.closed) throw paused();
    if (this.startWork) return this.startWork;
    this.startWork = (async () => {
      const server = net.createServer(client => {
        this.track(client);
        let upstream;
        try {
          this.assertAvailable();
          upstream = this.track(net.createConnection({ path: this.socketPath }));
          const timeout = setTimeout(() => upstream.destroy(paused()), 15000); timeout.unref();
          upstream.once("connect", () => {
            clearTimeout(timeout);
            try { this.assertAvailable(); } catch { client.destroy(); upstream.destroy(); }
          });
          upstream.once("close", () => clearTimeout(timeout));
          upstream.on("error", () => client.destroy());
          upstream.on("close", () => client.destroy());
          client.on("error", () => upstream.destroy());
          client.on("close", () => upstream.destroy());
          client.pipe(upstream); upstream.pipe(client);
        } catch {
          upstream?.destroy();
          client.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        }
      });
      this.server = server;
      try {
        await new Promise((done, reject) => {
          server.once("error", reject); server.listen(0, "127.0.0.1", done);
        });
        if (this.closed) throw paused();
        this.port = server.address().port;
        return this;
      } catch {
        if (server.listening) await new Promise(done => server.close(done));
        this.server = null; this.port = null; this.startWork = null;
        throw paused();
      }
    })();
    return this.startWork;
  }
  proxyOptions() {
    if (!this.enabled) return {};
    this.assertAvailable();
    if (!this.port) throw paused();
    return { proxy: { server: "http://127.0.0.1:" + this.port, bypass: "<-loopback>" } };
  }
  launchOptions() {
    if (!this.enabled) return {};
    this.assertAvailable();
    return { args: [
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--dns-prefetch-disable",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    ] };
  }
  persistentOptions() {
    return { ...this.launchOptions(), ...this.proxyOptions() };
  }
  get agent() {
    if (!this.enabled) return undefined;
    this.proxyOptions();
    if (!this._agent) {
      this._agent = new https.Agent({ keepAlive: false });
      this._agent.createConnection = (options, callback) => { this.connectSecure(options, callback); };
    }
    return this._agent;
  }
  connectSecure(options, callback) {
    let request, socket, secure, timeout, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      if (error) { request?.destroy(); secure?.destroy(); socket?.destroy(); }
      callback(error ? paused() : null, result);
    };
    try {
      const hostname = options.hostname || options.host;
      if (!validHost(hostname) || Number(options.port ?? 443) !== 443) throw paused();
      this.proxyOptions();
      request = http.request({ host: "127.0.0.1", port: this.port, method: "CONNECT",
        path: hostname + ":443", headers: { Host: hostname + ":443" }, agent: false });
      timeout = setTimeout(() => finish(paused()), 15000); timeout.unref();
      request.on("socket", value => this.track(value));
      request.on("error", () => finish(paused()));
      request.on("connect", (response, connection, head) => {
        socket = connection;
        try {
          this.assertAvailable();
          if (response.statusCode !== 200) throw paused();
          if (head.length) socket.unshift(head);
          // Only the destination name and standard TLS verification enter the tunnel.
          secure = this.track(tls.connect({ socket, host: hostname,
            servername: net.isIP(hostname) ? undefined : hostname, rejectUnauthorized: true }));
          secure.once("secureConnect", () => {
            try { this.assertAvailable(); finish(null, secure); } catch { finish(paused()); }
          });
          secure.on("error", () => finish(paused()));
          secure.once("close", () => finish(paused()));
        } catch { finish(paused()); }
      });
      request.end();
    } catch { queueMicrotask(() => finish(paused())); }
  }
  disconnect() {
    for (const socket of this.sockets) socket.destroy(paused());
    this._agent?.destroy();
  }
  close() {
    if (this.closeWork) return this.closeWork;
    this.closed = true;
    this.disconnect();
    this.closeWork = (async () => {
      await this.startWork?.catch(() => {});
      this.disconnect();
      const server = this.server;
      this.server = null; this.port = null;
      if (server?.listening) await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    })();
    return this.closeWork;
  }
}
