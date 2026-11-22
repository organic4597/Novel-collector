import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, normalize } from "node:path";
import { pauseBetweenChapters } from "./chapter-delay.mjs";
import { TetherControl } from "./tether-control.mjs";

const execute = promisify(execFile);
const paused = () => Object.assign(Error("검증된 수집 연결을 기다리고 있습니다."), {
  code: "COLLECTION_NETWORK_PAUSED", status: 503,
});
const safePath = value => typeof value === "string" && isAbsolute(value) &&
  normalize(value) === value && value !== "/" && !value.includes("\0");

export class CollectionRoutes {
  constructor({ store, routes, onChange = async () => {}, wait = pauseBetweenChapters, pollMs = 15000 }) {
    if (!store?.path || !store?.json || !store?.atomic || !Array.isArray(routes) || routes.length > 9 ||
        routes.some(route => !/^[a-z][a-z0-9-]{0,31}$/.test(route.id) || route.id === "wired" ||
          !["vpn", "tether"].includes(route.kind) || !safePath(route.launcher) || typeof route.probe !== "function") ||
        new Set(routes.map(route => route.id)).size !== routes.length)
      throw Error("수집 대체 경로 설정을 확인하세요.");
    Object.assign(this, { store, routes: [...routes.filter(r => r.kind === "vpn"), ...routes.filter(r => r.kind === "tether")],
      onChange, wait, pollMs });
    this.enabled = true;
    this.directBrowser = true;
    this.routeMode = "failover";
    this.generation = 0;
    this.state = { schema: 1, wiredBlocked: false, route: "wired", rejected: [] };
    this.phase = "offline";
    this.reason = "수집 연결 확인 대기";
    this.path = store.path("collection-routes.json");
    this.closed = false;
    this.started = false;
    this.work = null;
    this.timer = null;
    this.watchTether = false;
    this.cancellation = new AbortController();
  }
  snapshot() {
    const ready = !this.closed && this.phase === "ready";
    return { enabled: true, active: !ready, ready, phase: this.closed ? "closed" : this.phase,
      reason: ready ? null : this.reason, retryAt: null, cycleUsed: this.state.wiredBlocked,
      siteHost: null, route: this.state.route, mode: this.routeMode, generation: this.generation };
  }
  assertAvailable() { if (!this.snapshot().ready) throw paused(); }
  async save() { await this.store.atomic(this.path, structuredClone(this.state)); }
  async notice() { if (!this.closed) await this.onChange(this.snapshot()); }
  get current() { return this.routes.find(route => route.id === this.state.route); }
  async ready(route) {
    if (this.closed) return;
    this.watchTether = false;
    this.state.route = route;
    await this.save();
    if (this.closed) return;
    this.phase = "ready"; this.reason = null;
    await this.notice();
  }
  async fail(watchTether = false) {
    this.watchTether = watchTether;
    this.phase = "needs_attention";
    this.reason = "검증된 VPN·모바일 연결이 없습니다. 수집을 보류합니다.";
    this.state.wiredBlocked = true;
    this.state.route = null;
    await this.save();
  }
  async select() {
    for (const route of this.routes) {
      if (this.closed || this.state.rejected.includes(route.id)) continue;
      let proof;
      try { proof = await route.probe(); } catch {}
      if (this.closed) return;
      if (proof?.ready === true) { await this.ready(route.id); return; }
    }
    await this.fail(true);
    await this.notice();
  }
  transition({ gap = false } = {}) {
    if (this.work) return this.work;
    this.phase = "verifying";
    this.reason = "유선 우회 없이 VPN·확인된 모바일 연결을 검사합니다.";
    ++this.generation;
    const task = Promise.resolve().then(async () => {
      await this.save();
      await this.notice();
      if (this.closed) return;
      if (gap) await this.wait(this.cancellation.signal);
      if (!this.closed) await this.select();
    }).catch(async () => { if (!this.closed) await this.fail(); });
    const tracked = task.finally(() => { if (this.work === tracked) this.work = null; });
    this.work = tracked;
    return tracked;
  }
  async start() {
    if (this.started || this.closed) return this.snapshot();
    this.started = true;
    try {
      const saved = await this.store.json(this.path);
      if (saved) {
        const ids = new Set(this.routes.map(route => route.id));
        if (saved.schema !== 1 || typeof saved.wiredBlocked !== "boolean" ||
            !Array.isArray(saved.rejected) || saved.rejected.some(id => typeof id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(id)) ||
            (saved.route !== null && saved.route !== "wired" && typeof saved.route !== "string") ||
            (saved.wiredBlocked && saved.route === "wired")) throw paused();
        this.state = { schema: 1, wiredBlocked: saved.wiredBlocked,
          route: saved.route, rejected: saved.rejected.filter(id => ids.has(id)) };
      }
      if (!this.state.wiredBlocked) await this.ready("wired");
      else if (this.current && !this.state.rejected.includes(this.current.id) &&
          (await this.current.probe())?.ready === true) await this.ready(this.current.id);
      else await this.transition();
    } catch { await this.fail(); }
    this.armMonitor();
    return this.snapshot();
  }
  block({ blockCode, siteHost, generation } = {}) {
    if (this.closed || blockCode !== "NGINX_CIDR_REALIP" ||
        (generation !== undefined && generation !== this.generation)) return Promise.resolve(false);
    if (typeof siteHost !== "string" || !/^[a-z0-9][a-z0-9.-]{0,252}$/i.test(siteHost))
      return Promise.reject(paused());
    if (this.work) return this.work;
    this.state.wiredBlocked = true;
    if (this.current && !this.state.rejected.includes(this.current.id)) this.state.rejected.push(this.current.id);
    this.state.route = null;
    return this.transition({ gap: true });
  }
  async refresh() {
    if (this.closed || this.work) return this.snapshot();
    if (this.phase !== "ready" || !this.current) {
      const tether = this.watchTether && this.routes.find(route => route.kind === "tether" &&
        !this.state.rejected.includes(route.id));
      if (tether) {
        const generation = this.generation;
        let proof;
        try { proof = await tether.probe(); } catch {}
        if (!this.closed && !this.work && generation === this.generation && proof?.ready === true) await this.transition();
      }
      return this.snapshot();
    }
    const generation = this.generation, route = this.current;
    let proof;
    try { proof = await route.probe(); } catch {}
    if (!this.closed && generation === this.generation && proof?.ready !== true) {
      this.state.route = null;
      await this.transition({ gap: true });
    }
    return this.snapshot();
  }
  bootstrap() {
    if (this.closed || this.work || this.phase === "ready") return this.work || Promise.resolve(this.snapshot());
    return this.transition();
  }
  armMonitor() {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      void this.refresh().catch(() => this.fail()).finally(() => this.armMonitor()).catch(() => {});
    }, this.pollMs);
    this.timer.unref?.();
  }
  launchOptions() {
    this.assertAvailable();
    return this.current ? { executablePath: this.current.launcher, args: [] } : {};
  }
  proxyOptions() { this.assertAvailable(); return {}; }
  persistentOptions() { return this.launchOptions(); }
  get agent() {
    this.assertAvailable();
    if (this.current) throw paused();
    return undefined;
  }
  disconnect() {}
  close() {
    this.closed = true;
    ++this.generation;
    clearTimeout(this.timer);
    this.cancellation.abort();
  }
}

export function createRouteRuntime({ store, env = process.env, onChange, run = execute,
  control = null, wait, pollMs } = {}) {
  let launchers;
  try { launchers = JSON.parse(env.NC_VPN_BROWSER_LAUNCHERS || "[]"); } catch { throw paused(); }
  if (!Array.isArray(launchers) || launchers.length > 8 || launchers.some(path => !safePath(path)) ||
      new Set(launchers).size !== launchers.length) throw paused();
  const cancellation = new AbortController();
  const check = async (launcher, vpn = false) => {
    const result = await run(launcher, ["--check"], { timeout: 30000, maxBuffer: 65536,
      env, windowsHide: true, signal: cancellation.signal });
    const proof = JSON.parse(result.stdout);
    return { ready: proof?.ready === true && (!vpn || (proof.mode === "vpn" && proof.country === "KR")) };
  };
  const routes = launchers.map((launcher, index) => ({
    id: "vpn-" + (index + 1), kind: "vpn", launcher, probe: () => check(launcher, true),
  }));
  if (env.NC_TETHER_BROWSER_LAUNCHER && env.NC_TETHER_CONTROL_SOCKET) {
    control ??= new TetherControl({ socketPath: env.NC_TETHER_CONTROL_SOCKET });
    routes.push({ id: "tether", kind: "tether", launcher: env.NC_TETHER_BROWSER_LAUNCHER,
      probe: async () => {
        if ((await control.callHost("status"))?.ready !== true) return { ready: false };
        const phone = await control.callPhone("status");
        if (![phone.usbConnected, phone.tethering, phone.cellular, phone.validated].every(value => value === true))
          return { ready: false };
        return check(env.NC_TETHER_BROWSER_LAUNCHER);
      } });
  }
  const network = new CollectionRoutes({ store, routes, onChange, wait, pollMs });
  return { network, transport: network,
    close: async () => { network.close(); cancellation.abort(); control?.close(); await network.work?.catch(() => {}); } };
}
