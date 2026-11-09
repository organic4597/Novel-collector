import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import { usbRule, dhcpLease, latestDhcpLease, namespaceReady, ownProcess, TetherHost } from "../src/tether-host.mjs";

test("USB rule matches one explicit phone and rejects shell or udev injection", () => {
  assert.match(usbRule("TESTPHONE_123"), /ATTRS\{serial\}=="TESTPHONE_123"/);
  assert.match(usbRule("TESTPHONE_123"), /NM_UNMANAGED/);
  for (const value of ["", "*", "../phone", 'phone", ENV{x}="1', "a\nphone", "TEST PHONE"])
    assert.throws(() => usbRule(value));
});
test("DHCP lease admits valid interface-local routing and ignores unrelated DHCP options", () => {
  const lease = dhcpLease({interface:"usb0",new_ip_address:"192.168.42.2",new_subnet_mask:"255.255.255.0",
    new_routers:"192.168.42.1",new_domain_name_servers:"192.168.42.1 1.1.1.1",new_host_name:"untrusted; hostname"});
  assert.deepEqual(lease,{interface:"usb0",address:"192.168.42.2",prefix:24,gateway:"192.168.42.1",dns:["192.168.42.1","1.1.1.1"]});
  for (const patch of [{interface:"--help"},{new_ip_address:"127.0.0.1"},{new_subnet_mask:"255.0.255.0"},
    {new_routers:"10.0.0.1"},{new_domain_name_servers:"1.1.1.1;echo"}])
    assert.throws(()=>dhcpLease({...{interface:"usb0",new_ip_address:"192.168.42.2",new_subnet_mask:"255.255.255.0",
      new_routers:"192.168.42.1",new_domain_name_servers:"192.168.42.1"},...patch}));
});
const valid = () => ({owned:true,interface:"usb0",proxy:true,lease:{address:"192.168.42.2",gateway:"192.168.42.1"},
  links:[{ifname:"lo"},{ifname:"usb0",flags:["UP","LOWER_UP"]}],
  routes:[{dst:"default",dev:"usb0",gateway:"192.168.42.1"}],
  addresses:[{ifname:"usb0",addr_info:[{family:"inet",local:"192.168.42.2",scope:"global"}]}]});
test("readiness requires a live owned namespace with only tether and its own default route", () => {
  assert.equal(namespaceReady(valid()),true);
  for(const patch of [{owned:false},{proxy:false},{links:[{ifname:"lo"}]},
    {links:[...valid().links,{ifname:"enp46s0"}]},
    {routes:[{dst:"default",dev:"enp46s0",gateway:"192.168.1.1"}]},
    {addresses:[]},{links:[{ifname:"lo"},{ifname:"usb0",flags:["UP"]}]}])
    assert.equal(namespaceReady({...valid(),...patch}),false);
});
test("PID ownership rejects reused process IDs, another command, or another network namespace", () => {
  const expected={pid:123,start:"456",command:["/usr/bin/node","/work/src/tether-proxy.mjs","/run/novel-collector-tether/proxy.sock"],netns:"789"};
  assert.equal(ownProcess(expected,{start:"456",args:expected.command,netns:"789"}),true);
  for(const patch of [{start:"999"},{args:["/usr/bin/node","unrelated.mjs"]},{netns:"111"}])
    assert.equal(ownProcess(expected,{start:"456",args:expected.command,netns:"789",...patch}),false);
});
test("CLI helper refuses unsafe serial or non-root execution before any commands", async () => {
  let calls=0; const exec=async()=>{calls++;return {stdout:""};};
  await assert.rejects(new TetherHost({serial:"unsafe*",exec,uid:()=>0}).prepare());
  await assert.rejects(new TetherHost({serial:"TESTPHONE",exec,uid:()=>1000}).prepare());
  assert.equal(calls,0);
});
test("USB interface discovery ignores unrelated devices and rejects ambiguity", async () => {
  const io={readdir:async()=>["lo","enp46s0","usb0"],realpath:async path=>path.includes("enp46s0")?"/sys/devices/pci/wired":"/sys/devices/pci/usb/PHONE/net",
    readFile:async path=>{if(path==="/sys/devices/pci/usb/PHONE/serial")return "TESTPHONE";throw Object.assign(Error(),{code:"ENOENT"});}};
  const host=new TetherHost({serial:"TESTPHONE",io});
  assert.equal(await host.usbDevice(),"usb0");
  io.readdir=async()=>["usb0","usb1"];
  await assert.rejects(host.usbDevice(),{code:"TETHER_USB_DEVICE"});
});
test("proxy and DHCP launch are always inside the fixed namespace", async () => {
  const calls=[];let saved;
  const command=["/usr/bin/node","/work/tether-proxy.mjs","/run/novel-collector-tether/proxy.sock"];
  const host=new TetherHost({serial:"TESTPHONE",launch:(file,args)=>{
    calls.push([file,args]);const listeners={};
    queueMicrotask(()=>listeners.spawn());
    return {pid:123,once:(event,fn)=>{listeners[event]=fn;},unref(){}};
  }});
  host.processInfo=async()=>({start:"456",args:command,netns:"789"});
  host.write=async(_path,value)=>{saved=value;};
  const result=await host.startProcess("/usr/sbin/ip",{netns:"789"},"proxy",command);
  assert.deepEqual(calls,[["/usr/sbin/ip",["netns","exec","novel-collector-tether",...command]]]);
  assert.equal(result.proxy.start,"456");assert.deepEqual(saved,result);
});
test("connect refuses a foreign namespace interface before moving a USB device", async () => {
  const calls=[];
  const host=new TetherHost({serial:"TESTPHONE",uid:()=>0,io:{lstat:async()=>({uid:0,isFile:()=>true,isSymbolicLink:()=>false})}});
  host.tool=async()=>"/usr/sbin/ip";host.routes=async()=>"[wired unchanged]";
  host.marker=async()=>({interface:"usb0"});host.ownedNamespace=async()=>true;
  host.command=async(_file,args)=>{calls.push(args);return JSON.stringify([{ifname:"lo"},{ifname:"enp46s0"}]);};
  host.usbDevice=async()=>{throw Error("must not inspect or move");};
  await assert.rejects(host.connect(),{code:"TETHER_OWNERSHIP"});
  assert.deepEqual(calls,[["-n","novel-collector-tether","-json","link","show"]]);
});
test("connect detects a changed wired route before launching or moving any device", async () => {
  let calls=0;
  const host=new TetherHost({serial:"TESTPHONE",uid:()=>0});
  host.tool=async()=>"/usr/sbin/ip";host.routes=async()=>"new tether default";
  host.marker=async()=>({wiredRoutes:"original wired default"});
  host.command=async()=>{calls++;throw Error("must not run");};
  await assert.rejects(host.connect(),{code:"TETHER_WIRED_ROUTE_CHANGED"});
  assert.equal(calls,0);
});
test("close preserves namespace and processes when an administrator adds another interface", async () => {
  const calls=[];let stops=0;
  const host=new TetherHost({serial:"TESTPHONE",uid:()=>0});
  host.tool=async()=>"/usr/sbin/ip";host.routes=async()=>"[wired unchanged]";
  host.marker=async()=>({interface:"usb0",proxy:{pid:123},dhcp:{pid:124}});
  host.ownedNamespace=async()=>true;
  host.command=async(_file,args)=>{calls.push(args);return JSON.stringify([{ifname:"lo"},{ifname:"usb0"},{ifname:"admin0"}]);};
  host.stopProcess=async()=>{stops++;};
  await assert.rejects(host.close(),{code:"TETHER_OWNERSHIP"});
  assert.equal(stops,0);
  assert.deepEqual(calls,[["-n","novel-collector-tether","-json","link","show"]]);
});
async function preparedFilesystem(t,{partial=false}={}){
  const root=await fs.mkdtemp(join(tmpdir(),"tether-host-fs-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const map=path=>path.startsWith("/proc/")?path:join(root,path);
  await fs.mkdir(map("/run"),{recursive:true});await fs.mkdir(map("/etc/udev/rules.d"),{recursive:true});
  await fs.mkdir(map("/etc/dhcp"),{recursive:true});await fs.mkdir(map("/var/lib/dhclient"),{recursive:true});
  const calls=[],io={};
  for(const method of ["readFile","writeFile","lstat","stat","access","mkdir","readdir","unlink","rmdir"])
    io[method]=(...args)=>fs[method](map(args[0]),...args.slice(1));
  io.rename=(source,target)=>fs.rename(map(source),map(target));
  const host=new TetherHost({serial:"TESTPHONE",uid:()=>0,io,exec:async(file,args)=>{
    calls.push([file,args]);
    if(args[0]==="netns"&&args[1]==="add"){
      await fs.mkdir(map("/run/netns"),{recursive:true});
      await fs.writeFile(map("/run/netns/novel-collector-tether"),"owned namespace fixture");
    }
    return {stdout:args.includes("route")?"[]":""};
  }});
  host.tool=async name=>"/test/"+name;
  if(partial){
    await fs.mkdir(map("/run/netns"),{recursive:true});await fs.writeFile(map("/run/netns/novel-collector-tether"),"fixture");
    await fs.mkdir(map("/run/novel-collector-tether"),{recursive:true});
    await fs.writeFile(map("/run/novel-collector-tether/owner.json"),JSON.stringify({
      schema:1,owner:"novel-collector-tether",serial:"TESTPHONE",wiredRoutes:"[[],[]]",
      hostNetns:String((await fs.stat("/proc/self/ns/net")).ino),
      netns:String((await fs.stat(map("/run/netns/novel-collector-tether"))).ino)
    }));
  }
  return {host,map,calls};
}
test("fresh prepare creates the absent netns DNS parent on a real temporary filesystem",async t=>{
  const {host,map,calls}=await preparedFilesystem(t);
  assert.equal((await host.prepare()).prepared,true);
  assert.equal((await fs.lstat(map("/etc/netns/novel-collector-tether"))).isDirectory(),true);
  assert.equal((await fs.lstat(map("/etc/netns/novel-collector-tether/resolv.conf"))).mode&0o777,0o600);
  assert.match(await fs.readFile(map("/etc/dhcp/novel-collector-tether.conf"),"utf8"),/no host script/);
  assert.equal((await fs.lstat(map("/var/lib/dhclient/novel-collector-tether.leases"))).mode&0o777,0o600);
  assert.equal(calls.filter(([_file,args])=>args[0]==="netns"&&args[1]==="add").length,1);
});
test("prepare recovers its owned partial namespace without recreating the namespace or overwriting DNS",async t=>{
  const {host,map,calls}=await preparedFilesystem(t,{partial:true});
  assert.equal((await host.prepare()).prepared,true);
  const resolver=map("/etc/netns/novel-collector-tether/resolv.conf");
  await fs.writeFile(resolver,"nameserver 192.168.42.1\\n");
  assert.equal((await host.prepare()).prepared,true);
  assert.equal(await fs.readFile(resolver,"utf8"),"nameserver 192.168.42.1\\n");
  assert.equal(calls.filter(([_file,args])=>args[0]==="netns"&&args[1]==="add").length,0);
});
const leaseText=(address="192.168.42.2",expiry="1 2030/01/01 00:00:00",extra="")=>[
 "lease {",'interface "usb0";',"fixed-address "+address+";","option subnet-mask 255.255.255.0;",
 "option routers 192.168.42.1;","option domain-name-servers 192.168.42.1, 1.1.1.1;","expire "+expiry+";",extra,"}"].join("\n");
test("latest native DHCP lease is parsed without evaluating quoted option text",()=>{
 const raw=leaseText("192.168.42.2",undefined,'option vendor-encapsulated-options "fixed-address 127.0.0.1; expire never; }";');
 const lease=latestDhcpLease(raw,"usb0",Date.UTC(2026,10,9));
 assert.equal(lease.address,"192.168.42.2");assert.deepEqual(lease.dns,["192.168.42.1","1.1.1.1"]);
 const latest=latestDhcpLease(leaseText()+leaseText("192.168.42.3"),"usb0",Date.UTC(2026,10,9));
 assert.equal(latest.address,"192.168.42.3");
});
test("expired, truncated, duplicate, malformed or wrong-interface native leases fail closed",()=>{
 const now=Date.UTC(2026,10,9);
 for(const raw of [leaseText("192.168.42.2","1 2020/01/01 00:00:00"),leaseText().slice(0,-1),
  leaseText("192.168.42.2",undefined,"fixed-address 192.168.42.3;"),leaseText("127.0.0.1"),
  leaseText().replace('"usb0"','"other0"'),leaseText()+"\\n"+'option bad "unterminated'])
  assert.throws(()=>latestDhcpLease(raw,"usb0",now),{code:"TETHER_DHCP_LEASE"});
});
test("native DHCP lease with changed DNS cannot be mistaken for an applied old lease",()=>{
 const first=latestDhcpLease(leaseText(),"usb0",Date.UTC(2026,10,9));
 const changed=latestDhcpLease(leaseText().replace("192.168.42.1, 1.1.1.1","8.8.8.8"),"usb0",Date.UTC(2026,10,9));
 assert.notDeepEqual(first.dns,changed.dns);
});
test("close retains its owned marker and phone lock inode for a safe later prepare",async t=>{
 const {host,map}=await preparedFilesystem(t,{partial:true});
 await host.prepare();
 const lock=map("/run/novel-collector-tether/phone.lock");await fs.writeFile(lock,"phone lock fixture");
 const inode=(await fs.stat(lock)).ino;
 host.command=async(_file,args)=>{
  if(args.includes("route"))return "[]";
  if(args.includes("link"))return '[{"ifname":"lo"}]';
  if(args[0]==="netns"&&args[1]==="delete"){await fs.unlink(map("/run/netns/novel-collector-tether"));return "";}
  return "";
 };
 assert.equal((await host.close()).closed,true);
 const marker=JSON.parse(await fs.readFile(map("/run/novel-collector-tether/owner.json"),"utf8"));
 assert.equal(marker.owner,"novel-collector-tether");assert.equal(marker.closed,true);assert.equal(marker.netns,null);
 assert.equal((await fs.stat(lock)).ino,inode);
});
test("expired historical DHCP records do not hide a valid latest lease",()=>{
 const raw=leaseText("192.168.42.2","1 2020/01/01 00:00:00")+leaseText("192.168.42.3");
 assert.equal(latestDhcpLease(raw,"usb0",Date.UTC(2026,10,9)).address,"192.168.42.3");
 assert.throws(()=>latestDhcpLease(leaseText()+leaseText("192.168.42.3","1 2020/01/01 00:00:00"),"usb0",Date.UTC(2026,10,9)),
  {code:"TETHER_DHCP_LEASE"});
});
test("a new USB session clears only the owned stale DHCP lease before starting DHCP",async()=>{
 let cleared=false,started=false;const stopped=[];
 const regular={uid:0,isFile:()=>true,isSymbolicLink:()=>false};
 const host=new TetherHost({serial:"TESTPHONE",uid:()=>0,io:{
  lstat:async path=>{if(path.endsWith("proxy.sock"))throw Object.assign(Error(),{code:"ENOENT"});return regular;},
  writeFile:async(path,bytes)=>{assert.equal(path,"/var/lib/dhclient/novel-collector-tether.leases");assert.equal(bytes,"");cleared=true;}
 }});
 host.tool=async name=>"/test/"+name;host.routes=async()=>"[wired]";
 host.marker=async()=>({dhcpFiles:true,interface:"oldusb",proxy:{pid:123},dhcp:{pid:124}});
 host.ownedNamespace=async()=>true;host.usbDevice=async()=>"usb0";host.write=async()=>{};
 host.stopProcess=async record=>stopped.push(record.pid);
 host.command=async(_file,args)=>args.includes("show")?'[{"ifname":"lo"}]':"";
 host.startProcess=async()=>{started=true;assert.equal(cleared,true);throw Object.assign(Error(),{code:"SYNTHETIC_STOP"});};
 await assert.rejects(host.connect(),{code:"SYNTHETIC_STOP"});
 assert.deepEqual(stopped,[123,124]);assert.equal(started,true);
});
