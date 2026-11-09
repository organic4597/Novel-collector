import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isIP } from "node:net";
import { setTimeout as wait } from "node:timers/promises";

const NS = "novel-collector-tether", RUN = "/run/" + NS, CONFIG = "/etc/netns/" + NS;
const SOCKET = RUN + "/proxy.sock", MARKER = RUN + "/owner.json";
const RULE = "/etc/udev/rules.d/85-novel-collector-tether.rules";
const DHCP_CONF="/etc/dhcp/novel-collector-tether.conf",DHCP_LEASE="/var/lib/dhclient/novel-collector-tether.leases";
const DHCP_PID="/run/dhclient-novel-collector-tether.pid";
const SOURCE = fileURLToPath(import.meta.url), PROXY = join(dirname(SOURCE), "tether-proxy.mjs");
const execute = promisify(execFile);
const fail = (code, message) => Object.assign(new Error(message), { code });
const ifaceName = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,14}$/.test(value);
const serialValid = value => typeof value === "string" && /^[a-zA-Z0-9_-]{4,64}$/.test(value);
const ipv4 = value => isIP(value) === 4 && !/^(?:0|127|169\.254|22[4-9]|2[3-5]\d)\./.test(value);
const numberIP = value => value.split(".").reduce((sum,part) => (sum * 256 + Number(part)) >>> 0, 0);
export function usbRule(serial) {
  if (!serialValid(serial)) throw fail("TETHER_SERIAL", "테더링 휴대전화 식별자를 확인하세요.");
  return '# Novel Collector: USB tether only; preserve the wired dashboard route.\n' +
    'SUBSYSTEM=="net", ACTION=="add", ATTRS{serial}=="' + serial + '", ENV{NM_UNMANAGED}="1"\n';
}
export function dhcpLease(env) {
  const address = env.new_ip_address, mask = env.new_subnet_mask;
  const gateway = (env.new_routers || "").trim().split(/\s+/)[0];
  const dns = [...new Set((env.new_domain_name_servers || "").trim().split(/\s+/).filter(Boolean))];
  if (!ifaceName(env.interface) || !ipv4(address) || isIP(mask || "") !== 4 || !ipv4(gateway) ||
      !dns.length || dns.length > 8 || dns.some(value => !ipv4(value)))
    throw fail("TETHER_DHCP", "테더링 DHCP 응답 형식이 올바르지 않습니다.");
  const bits = numberIP(mask).toString(2).padStart(32, "0");
  if (!/^1{8,30}0{2,24}$/.test(bits)) throw fail("TETHER_DHCP", "테더링 주소 범위를 확인하세요.");
  const prefix = bits.indexOf("0"), maskNumber = numberIP(mask);
  if ((numberIP(address) & maskNumber) !== (numberIP(gateway) & maskNumber) || address === gateway)
    throw fail("TETHER_DHCP", "테더링 게이트웨이가 해당 연결에 속하지 않습니다.");
  return { interface: env.interface, address, prefix, gateway, dns };
}
export function latestDhcpLease(text, device, now=Date.now()) {
  if(typeof text!=="string"||text.length>1024*1024||!ifaceName(device))
    throw fail("TETHER_DHCP_LEASE","DHCP 임대 기록 형식을 확인하세요.");
  const tokens=[];let cursor=0;
  for(const match of text.matchAll(/#[^\n]*|"(?:\\.|[^"\\])*"|[{};]|[^\s{};"]+/g)){
    if(/\S/.test(text.slice(cursor,match.index)))throw fail("TETHER_DHCP_LEASE","DHCP 인용문 형식을 확인하세요.");
    if(!match[0].startsWith("#"))tokens.push(match[0]);cursor=match.index+match[0].length;
  }
  if(/\S/.test(text.slice(cursor)))throw fail("TETHER_DHCP_LEASE","DHCP 인용문 형식을 확인하세요.");
  let latest;
  for(let i=0;i<tokens.length;i++){
    if(tokens[i]!=="lease"||tokens[i+1]!=="{")continue;
    let end=i+2;
    while(end<tokens.length&&tokens[end]!=="}"&&tokens[end]!=="{")end++;
    if(end>=tokens.length||tokens[end]!=="}")throw fail("TETHER_DHCP_LEASE","DHCP 임대 기록이 완성되지 않았습니다.");
    const statements=[];let row=[];
    for(const token of tokens.slice(i+2,end)){if(token===";"){statements.push(row);row=[];}else row.push(token);}
    const names=statements.filter(row=>row[0]==="interface");
    if(names.length!==1||names[0].length!==2)throw fail("TETHER_DHCP_LEASE","DHCP 장치 기록을 확인하세요.");
    const quoted=/^"([A-Za-z0-9_.:-]+)"$/.exec(names[0][1]);
    if(!quoted)throw fail("TETHER_DHCP_LEASE","DHCP 장치 이름을 확인하세요.");
    i=end;if(quoted[1]!==device)continue;
    const values={interface:device},seen=new Set();let expires;
    const fields={"fixed-address":"new_ip_address","subnet-mask":"new_subnet_mask","routers":"new_routers","domain-name-servers":"new_domain_name_servers"};
    for(const row of statements){
      let key=row[0],data=row.slice(1);if(key==="option"){key=data[0];data=data.slice(1);}
      if(!Object.hasOwn(fields,key)&&key!=="expire")continue;
      if(seen.has(key))throw fail("TETHER_DHCP_LEASE","중복된 DHCP 설정은 사용하지 않습니다.");seen.add(key);
      if(key==="expire"){
        if(data.length===1&&data[0]==="never")expires=null;
        else{
          const stamp=/^[0-6] (\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(data.join(" "));
          if(!stamp)throw fail("TETHER_DHCP_LEASE","DHCP 만료 시각을 확인하세요.");
          const parts=stamp.slice(1).map(Number),date=new Date(Date.UTC(parts[0],parts[1]-1,parts[2],parts[3],parts[4],parts[5]));
          if(date.toISOString().slice(0,19)!==parts[0]+"-"+String(parts[1]).padStart(2,"0")+"-"+String(parts[2]).padStart(2,"0")+"T"+
            parts.slice(3).map(value=>String(value).padStart(2,"0")).join(":"))
            throw fail("TETHER_DHCP_LEASE","DHCP 만료 시각을 확인하세요.");
          expires=date.getTime();
        }
      }else values[fields[key]]=data.flatMap(value=>value.split(",")).filter(Boolean).join(" ");
    }
    latest={values,expires,hasExpiry:seen.has("expire")};
  }
  if(!latest)throw fail("TETHER_DHCP_LEASE","해당 USB 장치의 DHCP 임대가 없습니다.");
  if(!latest.hasExpiry||latest.expires!==null&&(!Number.isFinite(latest.expires)||latest.expires<=now))
    throw fail("TETHER_DHCP_LEASE","DHCP 임대가 만료됐습니다.");
  try{return {...dhcpLease(latest.values),expiresAt:latest.expires===null?null:new Date(latest.expires).toISOString()};}
  catch{throw fail("TETHER_DHCP_LEASE","DHCP 임대 주소를 확인하세요.");}
}
export function namespaceReady({ owned, interface: device, proxy, lease, links, routes, addresses }) {
  return !!(owned && proxy && ifaceName(device) && lease && Array.isArray(links) && links.length === 2 &&
    links.some(link => link.ifname === "lo") &&
    links.some(link => link.ifname === device && link.flags?.includes("UP") && link.flags?.includes("LOWER_UP")) &&
    Array.isArray(routes) && routes.length === 1 && routes[0].dev === device &&
    routes[0].gateway === lease.gateway && routes[0].dst === "default" &&
    Array.isArray(addresses) && addresses.some(link => link.ifname === device &&
      link.addr_info?.some(address => address.family === "inet" && address.local === lease.address && address.scope === "global")));
}
export function ownProcess(expected, current) {
  return !!(expected && current && Number.isSafeInteger(expected.pid) && expected.pid > 1 &&
    expected.start === current.start && expected.netns === current.netns &&
    Array.isArray(current.args) && Array.isArray(expected.command) &&
    current.args.length === expected.command.length && expected.command.every((arg,index) => current.args[index] === arg));
}
export class TetherHost {
  constructor({ serial = process.env.NC_TETHER_PHONE_SERIAL, exec = execute, io = fs,
    launch = spawn, uid = () => process.getuid?.(), platform = process.platform, delay = wait } = {}) {
    Object.assign(this, { serial, exec, io, launch, uid, platform, delay });
  }
  check() {
    usbRule(this.serial);
    if (this.platform !== "linux" || this.uid() !== 0)
      throw fail("TETHER_PRIVILEGES", "테더링 네트워크 준비는 Linux의 관리자 서비스에서 실행해야 합니다.");
  }
  async command(file, args, timeout = 15000) {
    const result = await this.exec(file, args, { timeout, maxBuffer: 1024 * 1024, encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" } });
    return String(result.stdout || "").trim();
  }
  async tool(name) {
    for (const directory of ["/usr/sbin", "/usr/bin", "/sbin", "/bin"]) {
      const candidate = join(directory,name);
      try { await this.io.access(candidate, constants.X_OK); return candidate; } catch {}
    }
    throw fail("TETHER_PREREQUISITE", name + " 설치가 필요합니다. 기존 인터넷 설정은 변경하지 않았습니다.");
  }
  async read(path, fallback = null) {
    try {
      const info = await this.io.lstat(path);
      if (info.isSymbolicLink() || info.size > 1024 * 1024) throw fail("TETHER_OWNERSHIP", "테더링 상태 파일을 확인하세요.");
      return JSON.parse(await this.io.readFile(path,"utf8"));
    } catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
  }
  async write(path, value) {
    const tmp = path + "." + process.pid + ".tmp";
    await this.io.writeFile(tmp, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
    await this.io.rename(tmp,path);
  }
  async marker({ required = true } = {}) {
    const marker = await this.read(MARKER);
    if (!marker && !required) return null;
    if (!marker || marker.schema !== 1 || marker.owner !== NS || marker.serial !== this.serial ||
        marker.hostNetns !== String((await this.io.stat("/proc/self/ns/net")).ino))
      throw fail("TETHER_OWNERSHIP", "이 서버에서 준비한 테더링 네트워크가 아닙니다.");
    return marker;
  }
  async ownedNamespace(marker) {
    try { return marker.netns === String((await this.io.stat("/run/netns/" + NS)).ino); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }
  async processInfo(pid) {
    try {
      const stat = await this.io.readFile("/proc/" + pid + "/stat","utf8");
      return { start: stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19],
        args: (await this.io.readFile("/proc/" + pid + "/cmdline")).toString().split("\0").filter(Boolean),
        netns: String((await this.io.stat("/proc/" + pid + "/ns/net")).ino) };
    } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return null; throw error; }
  }
  async processOwned(record) { return ownProcess(record, record && await this.processInfo(record.pid)); }
  async routes(ip) {
    const ipv4 = JSON.parse(await this.command(ip,["-4","-json","route","show","table","main","default"]));
    const ipv6 = JSON.parse(await this.command(ip,["-6","-json","route","show","table","main","default"]));
    return JSON.stringify([ipv4,ipv6].map(routes => routes.map(route => ({
      dev:route.dev,gateway:route.gateway,metric:route.metric,table:route.table,pref:route.pref
    }))));
  }
  async preserveRoutes(ip, before) {
    if (await this.routes(ip) !== before)
      throw fail("TETHER_WIRED_ROUTE_CHANGED", "기존 인터넷 경로가 변경됐습니다. 수집을 재개하지 않습니다.");
  }
  async prepare() {
    this.check();
    const [ip, udev, dhclient] = await Promise.all(["ip","udevadm","dhclient"].map(name => this.tool(name)));
    const before = await this.routes(ip), rule = usbRule(this.serial);
    let marker = await this.marker({required:false});
    if (!marker) {
      for (const path of [RUN,CONFIG,"/run/netns/" + NS]) {
        try { await this.io.lstat(path); throw fail("TETHER_OWNERSHIP", "같은 이름의 기존 네트워크 영역을 자동으로 변경하지 않습니다."); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      await this.io.mkdir(RUN,{mode:0o700});
      marker = {schema:1,owner:NS,serial:this.serial,hostNetns:String((await this.io.stat("/proc/self/ns/net")).ino),wiredRoutes:before};
      await this.write(MARKER,marker);
    }
    try {
      const info = await this.io.lstat(RULE);
      if (info.isSymbolicLink() || info.uid !== 0 || await this.io.readFile(RULE,"utf8") !== rule)
        throw fail("TETHER_UDEV_CONFLICT", "기존 USB 네트워크 설정과 충돌합니다. 자동으로 덮어쓰지 않습니다.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.io.writeFile(RULE,rule,{mode:0o644,flag:"wx"});
    }
    await this.command(udev,["control","--reload-rules"]);
    if (!marker.netns) {
      await this.command(ip,["netns","add",NS]);
      marker = {...marker,netns:String((await this.io.stat("/run/netns/" + NS)).ino)};
      await this.write(MARKER,marker);
    }
    if (!await this.ownedNamespace(marker)) throw fail("TETHER_OWNERSHIP","테더링 네트워크 식별자가 바뀌었습니다.");
    for(const [path,mode] of [["/etc/netns",0o755],[CONFIG,0o700]]){
      try{
        const info=await this.io.lstat(path);
        if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==0)
          throw fail("TETHER_DNS_SCOPE","테더링 전용 DNS 폴더를 확인하세요.");
      }catch(error){if(error.code!=="ENOENT")throw error;await this.io.mkdir(path,{mode});}
    }
    if((await this.io.readdir(CONFIG)).some(name=>name!=="resolv.conf"))
      throw fail("TETHER_DNS_SCOPE","다른 설정이 있는 DNS 폴더는 자동으로 변경하지 않습니다.");
    try{await this.io.lstat(CONFIG+"/resolv.conf");}
    catch(error){if(error.code!=="ENOENT")throw error;await this.io.writeFile(CONFIG+"/resolv.conf","",{mode:0o600,flag:"wx"});}
    const configInfo=await this.io.lstat(CONFIG),resolverInfo=await this.io.lstat(CONFIG+"/resolv.conf");
    if(!configInfo.isDirectory()||configInfo.isSymbolicLink()||configInfo.uid!==0||
      !resolverInfo.isFile()||resolverInfo.isSymbolicLink()||resolverInfo.uid!==0)
      throw fail("TETHER_DNS_SCOPE","테더링 전용 DNS 설정을 확인하세요.");
    await this.command(ip,["-n",NS,"link","set","lo","up"]);
    const sysctl = await this.tool("sysctl");
    await this.command(ip,["netns","exec",NS,sysctl,"-qw","net.ipv6.conf.all.disable_ipv6=1","net.ipv6.conf.default.disable_ipv6=1"]);
    const dhcpConfig="# Novel Collector: namespace-only DHCP; no host script.\ntimeout 25;\nretry 10;\nrequest subnet-mask, routers, domain-name-servers, dhcp-lease-time;\n";
    if(!marker.dhcpFiles){
      for(const path of [DHCP_CONF,DHCP_LEASE,DHCP_PID]){
        try{await this.io.lstat(path);throw fail("TETHER_OWNERSHIP","기존 DHCP 파일은 자동으로 사용하지 않습니다.");}
        catch(error){if(error.code!=="ENOENT")throw error;}
      }
      marker={...marker,dhcpFiles:true};await this.write(MARKER,marker);
    }
    for(const path of [DHCP_CONF,DHCP_LEASE,DHCP_PID]){
      try{const info=await this.io.lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.uid!==0)throw fail("TETHER_OWNERSHIP","DHCP 파일 소유권을 확인하세요.");}
      catch(error){if(error.code!=="ENOENT")throw error;await this.io.writeFile(path,path===DHCP_CONF?dhcpConfig:"",{mode:0o600,flag:"wx"});}
    }
    if(await this.io.readFile(DHCP_CONF,"utf8")!==dhcpConfig)throw fail("TETHER_OWNERSHIP","변경된 DHCP 설정을 덮어쓰지 않습니다.");
    try{
      await this.io.access("/sys/fs/selinux/enforce");
      const restorecon=await this.tool("restorecon");await this.command(restorecon,["-F","--",DHCP_CONF,DHCP_LEASE,DHCP_PID]);
    }catch(error){if(error.code!=="ENOENT")throw error;}
    await this.preserveRoutes(ip,before);
    return {ready:false,prepared:true,namespace:NS,socketPath:SOCKET,dhclient};
  }
  async usbDevice() {
    const found = [];
    for (const name of await this.io.readdir("/sys/class/net")) {
      if (!ifaceName(name) || name === "lo") continue;
      let parent;
      try { parent = await this.io.realpath("/sys/class/net/"+name+"/device"); } catch { continue; }
      for (let depth=0;depth<12 && parent.startsWith("/sys/devices/");depth++,parent=dirname(parent)) {
        try {
          if ((await this.io.readFile(join(parent,"serial"),"utf8")).trim() === this.serial) {found.push(name);break;}
        } catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
      }
    }
    if (found.length !== 1) throw fail("TETHER_USB_DEVICE", "해당 휴대전화의 USB 테더링 연결을 하나만 확인해야 합니다.");
    return found[0];
  }
  async startProcess(ip, marker, key, command) {
    if(marker[key] && await this.processOwned(marker[key])){
      if(marker[key].command.join("\0")===command.join("\0"))return marker;
      await this.stopProcess(marker[key]);
    }
    const child = this.launch(ip,["netns","exec",NS,...command],{
      detached:true,stdio:"ignore",env:{...process.env,NC_TETHER_PHONE_SERIAL:this.serial}
    });
    await new Promise((done,reject)=>{child.once("spawn",done);child.once("error",reject);});
    child.unref();
    let info;
    for(let attempt=0;attempt<30;attempt++){
      info=await this.processInfo(child.pid);
      if(info?.args.join("\0")===command.join("\0") && info.netns===marker.netns)break;
      await this.delay(100);
    }
    if(!info || info.args.join("\0")!==command.join("\0") || info.netns!==marker.netns)
      throw fail("TETHER_PROCESS","테더링 전용 프로세스를 확인할 수 없습니다.");
    const next={...marker,[key]:{pid:child.pid,start:info.start,command,netns:marker.netns}};
    await this.write(MARKER,next);return next;
  }
  async connect() {
    this.check();
    const ip=await this.tool("ip"),before=await this.routes(ip);
    let marker=await this.marker();
    if(marker.wiredRoutes && marker.wiredRoutes!==before)
      throw fail("TETHER_WIRED_ROUTE_CHANGED","기존 인터넷 경로가 변경됐습니다. 수집을 재개하지 않습니다.");
    const resolverInfo=await this.io.lstat(CONFIG+"/resolv.conf");
    if(!resolverInfo.isFile()||resolverInfo.isSymbolicLink()||resolverInfo.uid!==0)
      throw fail("TETHER_DNS_SCOPE","테더링 전용 DNS 설정을 확인하세요.");
    if(!await this.ownedNamespace(marker))throw fail("TETHER_OWNERSHIP","테더링 전용 네트워크를 먼저 준비하세요.");
    const existingLinks=JSON.parse(await this.command(ip,["-n",NS,"-json","link","show"]));
    if(existingLinks.some(link=>link.ifname!=="lo" && link.ifname!==marker.interface))
      throw fail("TETHER_OWNERSHIP","테더링 영역에 다른 네트워크 장치가 있어 연결하지 않습니다.");
    if(!marker.dhcpFiles)throw fail("TETHER_PREREQUISITE","표준 DHCP 파일을 먼저 준비하세요.");
    if(!marker.interface || !existingLinks.some(link=>link.ifname===marker.interface)){
      const device=await this.usbDevice();
      await this.stopProcess(marker.proxy);await this.stopProcess(marker.dhcp);
      const nativeLease=await this.io.lstat(DHCP_LEASE);
      if(!nativeLease.isFile()||nativeLease.isSymbolicLink()||nativeLease.uid!==0)
        throw fail("TETHER_OWNERSHIP","DHCP 임대 파일 소유권을 확인하세요.");
      await this.io.writeFile(DHCP_LEASE,"",{mode:0o600});
      await this.write(RUN+"/lease.json",{interface:device,bound:false});
      try{const socket=await this.io.lstat(SOCKET);if(!socket.isSocket()||socket.uid!==0)throw fail("TETHER_OWNERSHIP","프록시 소켓을 확인하세요.");await this.io.unlink(SOCKET);}
      catch(error){if(error.code!=="ENOENT")throw error;}
      await this.command(ip,["link","set","dev",device,"netns",NS]);
      marker={...marker,interface:device,proxy:null,dhcp:null};await this.write(MARKER,marker);
    }
    const sysctl=await this.tool("sysctl");
    await this.command(ip,["netns","exec",NS,sysctl,"-qw","net/ipv6/conf/"+marker.interface+"/disable_ipv6=1"]);
    await this.command(ip,["-n",NS,"link","set","dev",marker.interface,"up"]);
    const dhclient=await this.tool("dhclient"),noScript=await this.tool("true");
    marker=await this.startProcess(ip,marker,"dhcp",[
      dhclient,"-4","-d","-sf",noScript,"-cf",DHCP_CONF,"-pf",DHCP_PID,"-lf",DHCP_LEASE,marker.interface
    ]);
    let lease;
    for(let attempt=0;attempt<150;attempt++){
      try{lease=latestDhcpLease(await this.io.readFile(DHCP_LEASE,"utf8"),marker.interface);}catch(error){if(error.code!=="TETHER_DHCP_LEASE"&&error.code!=="ENOENT")throw error;}
      if(lease)break;
      if(attempt===149)throw fail("TETHER_DHCP_TIMEOUT","휴대전화 테더링에서 주소를 받지 못했습니다.");
      await this.delay(200);
    }
    await this.command(ip,["-n",NS,"-4","address","replace",lease.address+"/"+lease.prefix,"dev",lease.interface]);
    await this.command(ip,["-n",NS,"-4","route","replace","default","via",lease.gateway,"dev",lease.interface]);
    await this.io.writeFile(CONFIG+"/resolv.conf",lease.dns.map(value=>"nameserver "+value).join("\n")+"\n",{mode:0o600});
    await this.write(RUN+"/lease.json",{...lease,bound:true});
    if(marker.proxy && !await this.processOwned(marker.proxy)){
      try{const info=await this.io.lstat(SOCKET);if(!info.isSocket()||info.uid!==0)throw fail("TETHER_OWNERSHIP","프록시 소켓을 확인하세요.");await this.io.unlink(SOCKET);}
      catch(error){if(error.code!=="ENOENT")throw error;}
    }
    marker=await this.startProcess(ip,marker,"proxy",[process.execPath,PROXY,SOCKET]);
    let state;
    for(let attempt=0;attempt<30;attempt++){
      state=await this.status();
      if(state.ready)break;
      await this.delay(100);
    }
    if(!state?.ready)throw fail("TETHER_CONNECTION","테더링 연결과 전용 프록시를 확인하지 못했습니다.");
    const curl=await this.tool("curl");
    const trace=await this.command(ip,["netns","exec",NS,curl,"--noproxy","*","-4","--fail","--silent",
      "--show-error","--max-time","12","https://www.cloudflare.com/cdn-cgi/trace"],15000);
    const egress=/^ip=([0-9.]+)$/m.exec(trace)?.[1];
    if(!ipv4(egress))throw fail("TETHER_CONNECTIVITY","테더링 인터넷 연결을 확인하지 못했습니다.");
    await this.preserveRoutes(ip,before);
    return {...state,egressVerified:true};
  }
  async status() {
    this.check();
    try {
      const marker=await this.marker({required:false});
      if(!marker || !await this.ownedNamespace(marker))return {ready:false,reason:"not_prepared"};
      const ip=await this.tool("ip"),device=marker.interface;
      if(!ifaceName(device))return {ready:false,reason:"usb_offline"};
      const [links,routes,addresses]=await Promise.all([
        ["-n",NS,"-json","link","show"],["-n",NS,"-4","-json","route","show","default"],
        ["-n",NS,"-4","-json","address","show"]
      ].map(args=>this.command(ip,args).then(JSON.parse)));
      const lease=await this.read(RUN+"/lease.json");
      const current=latestDhcpLease(await this.io.readFile(DHCP_LEASE,"utf8"),device);
      const leaseMatches=lease?.bound&&["interface","address","prefix","gateway","dns"].every(key=>JSON.stringify(lease[key])===JSON.stringify(current[key]));
      const socket=await this.io.lstat(SOCKET).catch(()=>null);
      const ready=namespaceReady({owned:true,interface:device,lease:leaseMatches?lease:null,links,routes,addresses,
        proxy:!!socket?.isSocket() && await this.processOwned(marker.proxy) && await this.processOwned(marker.dhcp)});
      return {ready,interface:device,namespace:NS,socketPath:SOCKET,reason:ready?null:"tether_offline"};
    } catch(error){
      if(["TETHER_OWNERSHIP","TETHER_SERIAL","TETHER_PRIVILEGES"].includes(error.code))throw error;
      return {ready:false,reason:"tether_offline"};
    }
  }
  async stopProcess(record) {
    if(!record)return;
    if(!await this.processOwned(record))return;
    process.kill(record.pid,"SIGTERM");
    for(let i=0;i<20;i++){
      if(!await this.processOwned(record))return;
      await this.delay(100);
    }
    if(await this.processOwned(record))process.kill(record.pid,"SIGKILL");
    await this.delay(100);
  }
  async close() {
    this.check();
    const marker=await this.marker({required:false});
    if(!marker)return {ready:false,closed:true};
    if(!await this.ownedNamespace(marker))throw fail("TETHER_OWNERSHIP","다른 네트워크 영역은 정리하지 않습니다.");
    const ip=await this.tool("ip"),before=await this.routes(ip);
    const existingLinks=JSON.parse(await this.command(ip,["-n",NS,"-json","link","show"]));
    if(existingLinks.some(link=>link.ifname!=="lo" && link.ifname!==marker.interface))
      throw fail("TETHER_OWNERSHIP","테더링 영역에 다른 네트워크 장치가 있어 정리하지 않습니다.");
    await this.stopProcess(marker.proxy);await this.stopProcess(marker.dhcp);
    const pids=(await this.command(ip,["netns","pids",NS])).split(/\s+/).filter(Boolean);
    if(pids.length)throw fail("TETHER_BUSY","테더링 영역의 다른 프로세스를 자동으로 종료하지 않습니다.");
    if(ifaceName(marker.interface)){
      const links=JSON.parse(await this.command(ip,["-n",NS,"-json","link","show"]));
      if(links.some(link=>link.ifname===marker.interface)){
        await this.command(ip,["-n",NS,"-4","address","flush","dev",marker.interface]);
        await this.command(ip,["-n",NS,"link","set","dev",marker.interface,"netns",String(process.pid)]);
      }
    }
    await this.command(ip,["netns","delete",NS]);await this.preserveRoutes(ip,before);
    for(const name of ["resolv.conf"])await this.io.unlink(CONFIG+"/"+name).catch(error=>{if(error.code!=="ENOENT")throw error;});
    await this.io.rmdir(CONFIG);
    for(const name of ["proxy.sock","dhcp-script","dhclient.conf","dhclient.pid","dhclient.leases","dhclient.leases~","dhclient.leases.new","lease.json"])
      await this.io.unlink(RUN+"/"+name).catch(error=>{if(error.code!=="ENOENT")throw error;});
    await this.write(MARKER,{...marker,closed:true,netns:null,interface:null,proxy:null,dhcp:null});
    return {ready:false,closed:true};
  }
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const action=process.argv[2],host=new TetherHost();
  Promise.resolve().then(()=>{
    if(!["prepare","connect","status","close"].includes(action)||process.argv.length!==3)
      throw fail("TETHER_ACTION","지원하지 않는 테더링 작업입니다.");
    return host[action]();
  }).then(result=>console.log(JSON.stringify(result))).catch(error=>{
    console.log(JSON.stringify({ready:false,code:typeof error.code==="string"&&/^TETHER_[A-Z_]+$/.test(error.code)?error.code:"TETHER_OPERATION",
      message:typeof error.code==="string"&&error.code.startsWith("TETHER_")?error.message:"테더링 연결 작업에 실패했습니다."}));
    process.exitCode=1;
  });
}
