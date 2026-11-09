import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,lstat,rm,symlink,chmod} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import net from "node:net";
import {EventEmitter} from "node:events";
import {TetherGateway,REMOTE_SOCKET_ADMIN} from "../src/tether-gateway.mjs";
const config={target:"collector@dashboard",rootDir:"/srv/collector",serial:"TESTPHONE123",python:"/usr/bin/python3",node:"/usr/bin/node",controlSocket:"/run/novel-collector-tether/broker/control.sock"};
async function fixture(t){const base=await mkdtemp(join(tmpdir(),"nc-export-"));t.after(()=>rm(base,{recursive:true,force:true}));return join(base,"export");}
function adminRun(_file,args){
 const command=args.at(-1);
 if(args.includes("-O"))return Promise.resolve({stdout:"Master running"});
 if(command.endsWith("'preflight' 'novelcollector'"))return Promise.resolve({stdout:'{"ready":true,"gid":1234}'});
 if(command.endsWith("'activate' 'novelcollector'"))return Promise.resolve({stdout:JSON.stringify({ready:true,gid:1234,sockets:[
  {name:"control.sock",ino:11,dev:2,uid:0,gid:1234,mode:0o660},{name:"proxy.sock",ino:12,dev:2,uid:0,gid:1234,mode:0o660}]})});
 return Promise.resolve({stdout:'{"ready":false}'});
}
function fakeExport(){
 const records=[];let server,child;
 const spawn=(file,args,options)=>{
  records.push({file,args,options});child=new EventEmitter();Object.assign(child,{pid:999999,exitCode:null,signalCode:null});
  child.kill=signal=>{child.signalCode=signal;server?.close(()=>{child.exitCode=0;child.emit("exit",0,signal);});return true;};
  const path=args[args.indexOf("-S")+1],mask=process.umask(0o077);
  try{server=net.createServer(socket=>socket.end()).listen(path,()=>child.emit("spawn"));}finally{process.umask(mask);}
  return child;
 };
 return{spawn,records,get child(){return child;},get server(){return server;}};
}
test("reverse export rejects option injection and unsafe helper paths",()=>{
 for(const patch of[{target:"-oProxyCommand=id"},{target:"ssh://host"},{target:"root@host;id"},{target:"u:p@host"},{rootDir:"/srv/../private"},{python:"python3"},{node:"/usr/bin/node;id"},{serial:"*"}])
  assert.throws(()=>new TetherGateway({...config,...patch}));
});
test("broker helper calls are LOCAL fixed argv and carry no SSH keys or user commands",async()=>{
 const calls=[];const gateway=new TetherGateway({...config,run:async(...args)=>{calls.push(args);return{stdout:'{"ready":false}'};}});
 assert.deepEqual(await gateway.runHost("status"),{ready:false});await gateway.runPhone("off");
 assert.deepEqual(calls[0].slice(0,2),["/usr/bin/node",["/srv/collector/src/tether-host.mjs","status"]]);
 assert.deepEqual(calls[1].slice(0,2),["/usr/bin/python3",["/srv/collector/src/hermes-tether.py","off"]]);
 assert.equal(calls[0][2].env.NC_TETHER_PHONE_SERIAL,"TESTPHONE123");assert.equal(calls[0][2].shell,undefined);
 await assert.rejects(gateway.runHost("shell"),{code:"TETHER_GATEWAY_ACTION"});await assert.rejects(gateway.runPhone("reboot"),{code:"TETHER_GATEWAY_ACTION"});await gateway.close();
});
test("local helper failures and malformed envelopes are sanitized",async()=>{
 let gateway=new TetherGateway({...config,run:async()=>{throw Object.assign(Error("secret"),{stdout:'{"code":"PHONE_LOCKED","message":"private"}'});}});
 await assert.rejects(gateway.runPhone("on"),e=>e.code==="PHONE_LOCKED"&&!/secret|private/.test(e.message));
 for(const stdout of["not-json","[]","null",'{"ok":false,"code":"bad-code"}']){
  gateway=new TetherGateway({...config,run:async()=>({stdout})});await assert.rejects(gateway.runHost("status"),{code:"TETHER_GATEWAY_RESPONSE"});
 }
});
test("closing invalidates an in-flight LOCAL helper and prevents later calls",async()=>{
 let done,signal;const gateway=new TetherGateway({...config,run:async(_f,_a,o)=>{signal=o.signal;return new Promise(r=>{done=r;});}});
 const pending=gateway.runPhone("prepare");await Promise.resolve();await gateway.close();assert.equal(signal.aborted,true);
 done({stdout:'{"ok":true}'});await assert.rejects(pending,{code:"TETHER_GATEWAY_CLOSED"});await assert.rejects(gateway.runHost("connect"),{code:"TETHER_GATEWAY_CLOSED"});
});
test("export makes only two reverse Unix forwards with existing-key authentication",async t=>{
 const runtimeDir=await fixture(t),fake=fakeExport(),checks=[];
 const gateway=new TetherGateway({...config,runtimeDir,spawn:fake.spawn,run:async(...args)=>{checks.push(args);return adminRun(...args);}});
 await gateway.start();assert.equal(await gateway.isReady(),true);assert.equal((await lstat(runtimeDir)).mode&0o077,0);
 const args=fake.records[0].args;assert.equal(args.filter(x=>x==="-R").length,2);assert.equal(args.includes("-L"),false);
 assert.ok(args.includes("BatchMode=yes"));assert.ok(args.includes("ExitOnForwardFailure=yes"));
 assert.ok(args.includes("/run/novel-collector-tether/proxy.sock:/run/novel-collector-tether/proxy.sock"));
 assert.ok(args.includes("/run/novel-collector-tether/control.sock:"+config.controlSocket));
 assert.equal(args.some(x=>/0\.0\.0\.0|StrictHostKeyChecking=no|IdentityFile/.test(x)),false);
 assert.equal(checks[0][0],"ssh");assert.ok(checks.some(call=>call[1].includes("-O")));
 await gateway.start();assert.equal(fake.records.length,1);await gateway.close();assert.equal(fake.child.signalCode,"SIGTERM");
});
test("no export target is valid for local development and starts no SSH",async()=>{
 let calls=0;const gateway=new TetherGateway({...config,target:"",spawn(){calls++;}});
 await gateway.start();assert.equal(await gateway.isReady(),true);assert.equal(calls,0);await gateway.close();assert.equal(await gateway.isReady(),false);
});
test("unknown private directory and symlinks are preserved",async t=>{
 const runtimeDir=await fixture(t);await mkdir(runtimeDir,{mode:0o700});await writeFile(join(runtimeDir,"keep"),"preserve");
 let gateway=new TetherGateway({...config,runtimeDir,spawn(){throw Error("must not spawn");}});
 await assert.rejects(gateway.start(),{code:"TETHER_GATEWAY_OWNERSHIP"});assert.equal(await readFile(join(runtimeDir,"keep"),"utf8"),"preserve");
 const other=runtimeDir+"-link";await symlink(runtimeDir,other);gateway=new TetherGateway({...config,runtimeDir:other});
 await assert.rejects(gateway.start(),{code:"TETHER_GATEWAY_OWNERSHIP"});
});
test("unexpected SSH exit holds export and owned restart is possible",async t=>{
 const runtimeDir=await fixture(t),fake=fakeExport(),gateway=new TetherGateway({...config,runtimeDir,spawn:fake.spawn,run:adminRun});
 await gateway.start();await new Promise(r=>fake.server.close(r));fake.child.exitCode=1;fake.child.emit("exit",1,null);
 assert.equal(await gateway.isReady(),false);await gateway.start();assert.equal(fake.records.length,2);await gateway.close();
});
test("close preserves replacement control-master file",async t=>{
 const runtimeDir=await fixture(t),fake=fakeExport(),gateway=new TetherGateway({...config,runtimeDir,spawn:fake.spawn,run:adminRun});
 await gateway.start();await new Promise(r=>fake.server.close(r));await writeFile(gateway.masterPath,"replacement",{mode:0o600});
 await gateway.close();assert.equal(await readFile(gateway.masterPath,"utf8"),"replacement");
});
test("a second instance cannot take a pending private export claim",async t=>{
 const runtimeDir=await fixture(t);let spawned;const made=new Promise(r=>{spawned=r;});
 const first=new TetherGateway({...config,runtimeDir,run:adminRun,spawn(){
  const child=new EventEmitter();Object.assign(child,{pid:999998,exitCode:null,signalCode:null});child.kill=signal=>{child.exitCode=0;child.signalCode=signal;child.emit("exit",0,signal);};spawned();return child;
 }});
 const pending=first.start();await made;const second=new TetherGateway({...config,runtimeDir,run:adminRun});
 await assert.rejects(second.start(),{code:"TETHER_GATEWAY_BUSY"});await first.close();await assert.rejects(pending,{code:"TETHER_GATEWAY_CLOSED"});
});

test("remote socket preflight refuses foreign existing sockets before exporting",async t=>{
 const runtimeDir=await fixture(t);let launched=0;
 const gateway=new TetherGateway({...config,runtimeDir,spawn(){launched++;},run:async()=>({stdout:'{"ready":false,"code":"TETHER_GATEWAY_REMOTE_SOCKET_UNSAFE"}'})});
 await assert.rejects(gateway.start(),{code:"TETHER_GATEWAY_REMOTE_SOCKET_UNSAFE"});assert.equal(launched,0);
 assert.match(REMOTE_SOCKET_ADMIN,/os\.O_PATH\|os\.O_NOFOLLOW/);assert.match(REMOTE_SOCKET_ADMIN,/0o2750/);
 assert.equal(REMOTE_SOCKET_ADMIN.includes("os.unlink"),false);
});
test("remote permission proof rejects replaced or unapproved socket metadata",async t=>{
 const runtimeDir=await fixture(t),fake=fakeExport();
 const gateway=new TetherGateway({...config,runtimeDir,spawn:fake.spawn,run:async(file,args)=>{
  if(args.at(-1).endsWith("'activate' 'novelcollector'"))return{stdout:JSON.stringify({ready:true,gid:1234,sockets:[
   {name:"control.sock",ino:11,dev:2,uid:0,gid:1234,mode:0o777},{name:"proxy.sock",ino:12,dev:2,uid:0,gid:1234,mode:0o660}]})};
  return adminRun(file,args);
 }});
 await assert.rejects(gateway.start(),{code:"TETHER_GATEWAY_REMOTE_SOCKET_UNSAFE"});assert.equal(await gateway.isReady(),false);
 assert.equal(fake.child.signalCode,"SIGTERM");
});

test("host prepare cannot be acknowledged by an empty helper envelope",async()=>{
 const gateway=new TetherGateway({...config,run:async()=>({stdout:"{}"})});
 await assert.rejects(gateway.runHost("prepare"),{code:"TETHER_GATEWAY_RESPONSE"});
});
