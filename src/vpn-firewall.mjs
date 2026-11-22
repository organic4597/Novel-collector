import { isDeepStrictEqual } from "node:util";

const TABLE = "nc_collection_vpn";
const fail = () => Object.assign(Error("VPN 전용 방화벽·국내 출구를 확인하세요."), {
  code: "COLLECTION_NAMESPACE_UNAVAILABLE",
});
const match = (left, right) => ({ match: { op: "==", left, right } });
const meta = key => ({ meta: { key } });
const payload = (protocol, field) => ({ payload: { protocol, field } });

export function vpnFirewallRules(config) {
  return [
    ["oifname", "lo", "accept"],
    ["meta", "nfproto", "ipv4", "oifname", config.interface, "accept"],
    ["oifname", config.uplink, "ip", "daddr", config.remote.ip,
      config.remote.protocol, "dport", String(config.remote.port), "accept"],
  ];
}
export function verifyVpnFirewall(config, state) {
  const records = state?.nftables;
  if (!Array.isArray(records)) return false;
  const chains = records.filter(item => item.chain).map(item => item.chain);
  const rules = records.filter(item => item.rule).map(item => item.rule);
  const chain = chains[0];
  if (chains.length !== 1 || chain.family !== "inet" || chain.table !== TABLE ||
      chain.name !== "output" || chain.type !== "filter" || chain.hook !== "output" ||
      chain.prio !== -300 || chain.policy !== "drop" || rules.length !== 3) return false;
  const expected = [
    [match(meta("oifname"), "lo"), { accept: null }],
    [match(meta("nfproto"), "ipv4"), match(meta("oifname"), config.interface), { accept: null }],
    [match(meta("oifname"), config.uplink), match(payload("ip", "daddr"), config.remote.ip),
      match(payload(config.remote.protocol, "dport"), config.remote.port), { accept: null }],
  ];
  return rules.every((rule, index) => rule.family === "inet" && rule.table === TABLE &&
    rule.chain === "output" && isDeepStrictEqual(rule.expr, expected[index]));
}
const pending = new Map();
export function prepareVpnNetwork(config, command) {
  if (pending.has(config.namespace)) return pending.get(config.namespace);
  const task = (async () => {
    const nft = args => command("/usr/sbin/ip", ["netns", "exec", config.namespace, "/usr/sbin/nft", ...args]);
    let state;
    try { state = JSON.parse(await nft(["--json", "list", "table", "inet", TABLE])); }
    catch {
      await nft(["add", "table", "inet", TABLE]);
      await nft(["add", "chain", "inet", TABLE, "output",
        "{ type filter hook output priority -300; policy drop; }"]);
      for (const rule of vpnFirewallRules(config))
        await nft(["add", "rule", "inet", TABLE, "output", ...rule]);
      state = JSON.parse(await nft(["--json", "list", "table", "inet", TABLE]));
    }
    if (!verifyVpnFirewall(config, state)) throw fail();
    const ipv6 = await command("/usr/sbin/ip", ["netns", "exec", config.namespace,
      "/usr/sbin/sysctl", "-n", "net.ipv6.conf.all.disable_ipv6"]);
    if (ipv6.trim() !== "1") throw fail();
    const trace = await command("/usr/sbin/ip", ["netns", "exec", config.namespace,
      "/usr/bin/curl", "--silent", "--show-error", "--fail", "--ipv4", "--noproxy", "*",
      "--interface", config.interface, "--max-time", "8", "--connect-timeout", "4",
      "https://1.1.1.1/cdn-cgi/trace"]);
    const fields = Object.fromEntries(trace.split("\n").filter(line => line.includes("=")).map(line => {
      const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1).trim()];
    }));
    if (fields.loc !== "KR" || !fields.ip) throw fail();
    return { firewallVerified: true, country: "KR", ipv6Disabled: true };
  })();
  const tracked = task.finally(() => { if (pending.get(config.namespace) === tracked) pending.delete(config.namespace); });
  pending.set(config.namespace, tracked);
  return tracked;
}
