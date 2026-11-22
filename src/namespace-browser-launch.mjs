#!/usr/bin/node
import net from "node:net";
import { lstat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";

const path = process.env.NC_NAMESPACE_BROWSER_SOCKET || "/run/novel-collector-namespace-browser/control.sock";
const args = process.argv.slice(2);
const check = args.length === 1 && args[0] === "--check";
try {
  if (!/^\/run\/[A-Za-z0-9_-]+\/control\.sock$/.test(path)) throw Error("unsafe socket path");
  const info = await lstat(path);
  if (!info.isSocket() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o007))
    throw Error("unsafe socket");
  const socket = net.createConnection({ path });
  let input, output;
  const timer = setTimeout(() => socket.destroy(Error("unavailable")), 20000);
  socket.on("connect", () => {
    socket.write(JSON.stringify(check ? { check: true } : { args }) + "\n");
    if (!check) {
      input = createReadStream(null, { fd: 3, autoClose: false });
      output = createWriteStream(null, { fd: 4, autoClose: false });
      for (const stream of [input, output]) stream.on("error", () => socket.destroy());
      input.pipe(socket); socket.pipe(output);
    } else socket.pipe(process.stdout);
  });
  socket.once("data", () => clearTimeout(timer));
  socket.on("error", () => {
    console.error("COLLECTION_NAMESPACE_UNAVAILABLE");
    process.exitCode = 1;
  });
  socket.on("close", () => { clearTimeout(timer); input?.destroy(); output?.destroy(); });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => { socket.destroy(); });
} catch {
  console.error("COLLECTION_NAMESPACE_UNAVAILABLE");
  process.exitCode = 1;
}
