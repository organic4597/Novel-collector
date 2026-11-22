import test from "node:test";
import assert from "node:assert/strict";
import { CollectionRoutes, createRouteRuntime } from "../src/collection-routes.mjs";

function fixture(options = {}) {
  let saved = options.saved ?? null;
  const calls = [], notices = [];
  const states = { vpn1: true, vpn2: true, tether: false };
  const routes = ["vpn1", "vpn2", "tether"].map(id => ({
    id, kind: id === "tether" ? "tether" : "vpn", launcher: "/synthetic/" + id,
    async probe() { calls.push(id); return { ready: states[id] }; },
  }));
  const network = new CollectionRoutes({
    store: { path: name => name, json: async () => saved,
      atomic: async (_path, data) => { saved = structuredClone(data); } },
    routes, wait: async () => calls.push("wait"), pollMs: 60000,
    onChange: async state => notices.push(state), ...options,
  });
  return { network, calls, states, notices, saved: () => saved };
}
const block = generation => ({ siteHost: "sbxh9.com", blockCode: "NGINX_CIDR_REALIP", generation });

test("wired starts without probing or toggling any fallback", async t => {
  const f = fixture(); t.after(() => f.network.close());
  await f.network.start();
  assert.equal(f.network.snapshot().route, "wired");
  assert.equal(f.network.snapshot().ready, true);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.network.launchOptions(), {});
});

test("only an explicit IP policy block selects VPN, with a chapter gap before reuse", async t => {
  const f = fixture(); t.after(() => f.network.close());
  await f.network.start();
  await f.network.block({ ...block(0), blockCode: "HTTP_403" });
  assert.deepEqual(f.calls, []);
  await f.network.block(block(0));
  assert.equal(f.network.snapshot().route, "vpn1");
  assert.deepEqual(f.calls, ["wait", "vpn1"]);
  assert.equal(f.network.launchOptions().executablePath, "/synthetic/vpn1");
  assert.equal(f.saved().wiredBlocked, true);
  assert.ok(f.notices.some(state => state.active));
});

test("duplicate and stale block reports cannot consume the next VPN", async t => {
  const f = fixture(); t.after(() => f.network.close());
  await f.network.start();
  const first = f.network.block(block(0));
  await f.network.block(block(0)); await first;
  await f.network.block(block(0));
  assert.equal(f.network.snapshot().route, "vpn1");
  await f.network.block(block(f.network.generation));
  assert.equal(f.network.snapshot().route, "vpn2");
});

test("VPN failures fall through to tether only when its read-only proof succeeds", async t => {
  const f = fixture(); t.after(() => f.network.close());
  f.states.vpn1 = f.states.vpn2 = false; f.states.tether = true;
  await f.network.start(); await f.network.block(block(0));
  assert.equal(f.network.snapshot().route, "tether");
  assert.deepEqual(f.calls, ["wait", "vpn1", "vpn2", "tether"]);
});

test("all fallback failures hold collection, including auxiliary HTTP, without wired reuse", async t => {
  const f = fixture(); t.after(() => f.network.close());
  f.states.vpn1 = f.states.vpn2 = false;
  await f.network.start(); await f.network.block(block(0));
  assert.equal(f.network.snapshot().active, true);
  assert.throws(() => f.network.launchOptions(), { code: "COLLECTION_NETWORK_PAUSED" });
  assert.throws(() => f.network.agent, { code: "COLLECTION_NETWORK_PAUSED" });
  await f.network.refresh();
  assert.equal(f.network.snapshot().active, true);
});

test("restart cannot silently return to a blocked wired connection", async t => {
  const f = fixture({ saved: { schema: 1, wiredBlocked: true, route: "vpn2", rejected: ["vpn1"] } });
  t.after(() => f.network.close());
  await f.network.start();
  assert.equal(f.network.snapshot().route, "vpn2");
  assert.deepEqual(f.calls, ["vpn2"]);
});

test("loss of a selected VPN invalidates it and never enables direct auxiliary requests", async t => {
  const f = fixture(); t.after(() => f.network.close());
  await f.network.start(); await f.network.block(block(0));
  assert.throws(() => f.network.agent, { code: "COLLECTION_NETWORK_PAUSED" });
  f.states.vpn1 = false;
  await f.network.refresh();
  assert.equal(f.network.snapshot().route, "vpn2");
});

test("failed browser retirement prevents fallback permission", async t => {
  const f = fixture({ onChange: async state => { if (state.active) throw Error("close failed"); } });
  t.after(() => f.network.close());
  await f.network.start(); await f.network.block(block(0));
  assert.equal(f.network.snapshot().active, true);
  assert.deepEqual(f.calls, []);
});

test("closing during a probe cannot publish a ready fallback", async () => {
  let release;
  const f = fixture({ routes: [{ id: "vpn1", kind: "vpn", launcher: "/synthetic/vpn1",
    probe: () => new Promise(done => { release = done; }) }] });
  await f.network.start();
  const switching = f.network.block(block(0));
  while (!release) await new Promise(done => setImmediate(done));
  f.network.close(); release({ ready: true }); await switching;
  assert.equal(f.network.snapshot().ready, false);
});

test("runtime probes VPN launchers, then only host/phone status for tether; never on/off", async t => {
  const calls = [];
  const runtime = createRouteRuntime({
    store: { path: x => x, json: async () => null, atomic: async () => {} },
    env: { NC_VPN_BROWSER_LAUNCHERS: '["/synthetic/vpn"]',
      NC_TETHER_BROWSER_LAUNCHER: "/synthetic/tether", NC_TETHER_CONTROL_SOCKET: "/synthetic/control" },
    control: { callHost: async action => { calls.push("host:" + action); return { ready: true }; },
      callPhone: async action => { calls.push("phone:" + action); return { usbConnected: true, tethering: true, cellular: true, validated: true }; },
      close() {} },
    run: async (file, args) => {
      calls.push(file + ":" + args.join(","));
      if (file.endsWith("vpn")) throw Error("AUTH_FAILED");
      return { stdout: '{"ready":true}' };
    },
    wait: async () => {},
  });
  t.after(() => runtime.close());
  await runtime.network.start(); await runtime.network.block(block(0));
  assert.equal(runtime.network.snapshot().route, "tether");
  assert.deepEqual(calls, ["/synthetic/vpn:--check", "host:status", "phone:status", "/synthetic/tether:--check"]);
  assert.equal(runtime.transport.directBrowser, true);
});

test("VPN runtime rejects a launcher without explicit KR and VPN proof", async t => {
  for (const proof of [{ ready: true }, { ready: true, mode: "vpn", country: "JP" }]) {
    const runtime = createRouteRuntime({
      store: { path: x => x, json: async () => null, atomic: async () => {} },
      env: { NC_VPN_BROWSER_LAUNCHERS: '["/synthetic/vpn"]' },
      run: async () => ({ stdout: JSON.stringify(proof) }), wait: async () => {},
    });
    t.after(() => runtime.close());
    await runtime.network.start(); await runtime.network.block(block(0));
    assert.equal(runtime.network.snapshot().active, true);
  }
});

test("corrupt persisted route state fails closed, including the next restart", async t => {
  const f = fixture({ saved: { schema: 99 } }); t.after(() => f.network.close());
  await f.network.start();
  assert.equal(f.network.snapshot().active, true);
  assert.equal(f.saved().wiredBlocked, true);
});

test("a later verified mobile connection can resume a held route without toggling the phone", async t => {
  const f = fixture(); t.after(() => f.network.close());
  f.states.vpn1 = f.states.vpn2 = false;
  await f.network.start(); await f.network.block(block(0));
  assert.equal(f.network.snapshot().active, true);
  f.states.tether = true;
  await f.network.refresh();
  assert.equal(f.network.snapshot().route, "tether");
});

test("manual recheck can reuse a repaired VPN, but never a source-blocked route or wired", async t => {
  const f = fixture(); t.after(() => f.network.close());
  await f.network.start(); await f.network.block(block(0));
  f.states.vpn1 = f.states.vpn2 = false;
  await f.network.refresh();
  assert.equal(f.network.snapshot().active, true);
  f.states.vpn1 = true;
  await f.network.bootstrap();
  assert.equal(f.network.snapshot().route, "vpn1");
  await f.network.block(block(f.network.generation));
  await f.network.bootstrap();
  assert.equal(f.network.snapshot().active, true);
});

test("restart checks the next route if the previously selected VPN throws", async t => {
  const f = fixture({ saved: { schema: 1, wiredBlocked: true, route: "vpn1", rejected: [] } });
  t.after(() => f.network.close());
  f.network.routes[0].probe = async () => { throw Error("VPN unavailable"); };
  await f.network.start();
  assert.equal(f.network.snapshot().route, "vpn2");
  assert.equal(f.network.snapshot().ready, true);
});

test("manual recheck on a connected VPN performs one shared real probe", async t => {
  const f = fixture(); t.after(() => f.network.close());
  await f.network.start(); await f.network.block(block(0));
  f.calls.length = 0;
  let release;
  f.network.routes[0].probe = () => {
    f.calls.push("probe"); return new Promise(done => { release = done; });
  };
  const a = f.network.bootstrap(), b = f.network.refresh();
  await new Promise(done => setImmediate(done));
  assert.equal(f.network.snapshot().checking, true);
  assert.deepEqual(f.calls, ["probe"]);
  release({ ready: true }); await Promise.all([a, b]);
  assert.equal(f.network.snapshot().checking, false);
  assert.equal(f.network.snapshot().route, "vpn1");
});

test("route snapshot reports only real configured fallback counts", async t => {
  const f = fixture(); t.after(() => f.network.close());
  await f.network.start();
  assert.equal(f.network.snapshot().vpnConfigured, 2);
  assert.equal(f.network.snapshot().mobileConfigured, true);
});
