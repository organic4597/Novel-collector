import test from "node:test";import assert from "node:assert/strict";import {mkdtemp,unlink,writeFile,readFile,rm} from "node:fs/promises";import {tmpdir} from "node:os";import {join} from "node:path";import {fork} from "node:child_process";import {once} from "node:events";
test("proxy shutdown preserves an administrator replacement file",async t=>{
 const dir=await mkdtemp(join(tmpdir(),"tether-owner-")),socket=join(dir,"proxy.sock"),script=join(dir,"child.mjs");t.after(()=>rm(dir,{recursive:true,force:true}));
 const source="import {startTetherProxy} from "+JSON.stringify(new URL("../src/tether-proxy.mjs",import.meta.url).href)+";const p=await startTetherProxy({socketPath:process.argv[2]});process.send('ready');process.on('message',async()=>{try{await p.close();process.send('closed');}catch{process.send('refused');}process.exit(0);});";
 await writeFile(script,source);
 const child=fork(script,[socket],{stdio:["ignore","ignore","ignore","ipc"]});t.after(()=>child.kill());assert.equal((await once(child,"message"))[0],"ready");
 await unlink(socket);await writeFile(socket,"administrator-owned replacement");const reply=once(child,"message"),exit=once(child,"exit");child.send("stop");assert.equal((await reply)[0],"refused");await exit;assert.equal(await readFile(socket,"utf8"),"administrator-owned replacement");
});
