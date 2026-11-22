import test from "node:test";
import assert from "node:assert/strict";
import { vpnFirewallRules, verifyVpnFirewall, prepareVpnNetwork } from "../src/vpn-firewall.mjs";

const config = { namespace: "nc-vpn-synthetic", interface: "tun0", uplink: "eth0",
  remote: { ip: "203.0.113.20", port: 1194, protocol: "udp" } };
const match = (left, right) => ({ match: { op: "==", left, right } });
const meta = key => ({ meta: { key } });
const payload = (protocol, field) => ({ payload: { protocol, field } });
const expressions = [
  [match(meta("oifname"), "lo"), { accept: null }],
  [match(meta("nfproto"), "ipv4"), match(meta("oifname"), "tun0"), { accept: null }],
  [match(meta("oifname"), "eth0"), match(payload("ip", "daddr"), "203.0.113.20"),
    match(payload("udp", "dport"), 1194), { accept: null }],
];
const state = () => ({ nftables: [
  { chain: { family: "inet", table: "nc_collection_vpn", name: "output", type: "filter",
    hook: "output", prio: -300, policy: "drop" } },
  ...expressions.map(expr => ({ rule: { family: "inet", table: "nc_collection_vpn", chain: "output", expr: structuredClone(expr) } })),
] });

test("VPN firewall allows only loopback, IPv4 tunnel and one upstream VPN endpoint", () => {
  const rules = vpnFirewallRules(config);
  assert.equal(rules.length, 3);
  assert.ok(rules.every(args => !args.includes("established")));
  assert.equal(verifyVpnFirewall(config, state()), true);
});
test("VPN firewall rejects a permissive policy, extra accept, IPv6 and unscoped endpoint rules", () => {
  for (const change of [
    value => { value.nftables[0].chain.policy = "accept"; },
    value => { value.nftables.push({ rule: { chain: "output", expr: [{ accept: null }] } }); },
    value => { value.nftables[2].rule.expr.shift(); },
    value => { value.nftables[3].rule.expr.shift(); },
  ]) {
    const value = state(); change(value);
    assert.equal(verifyVpnFirewall(config, value), false);
  }
});
test("VPN preparation creates a default-drop filter before accept rules, verifies it, then probes only the tunnel", async () => {
  const calls = [];
  const command = async (file, args) => {
    calls.push([file, args]);
    if (args.includes("--json")) {
      if (calls.filter(([, argv]) => argv.includes("--json")).length === 1)
        throw Error("no table");
      return JSON.stringify(state());
    }
    if (args.includes("/usr/bin/curl")) return "ip=198.51.100.1\nloc=KR\n";
    if (args.includes("net.ipv6.conf.all.disable_ipv6")) return "1";
    return "";
  };
  const proof = await prepareVpnNetwork(config, command);
  assert.equal(proof.firewallVerified, true);
  assert.equal(proof.country, "KR");
  const chain = calls.findIndex(([, args]) => args.includes("chain") && args.includes("add"));
  const rule = calls.findIndex(([, args]) => args.includes("rule"));
  assert.ok(chain >= 0 && chain < rule);
  const curl = calls.find(([, args]) => args.includes("/usr/bin/curl"))[1];
  assert.ok(curl.includes("--interface") && curl.includes("tun0") && curl.includes("--noproxy"));
});
