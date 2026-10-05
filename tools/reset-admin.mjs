#!/usr/bin/env node
import { access, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openCredentials, assertRecoveryDirectory } from "../src/auth.mjs";
import { AdminSessions } from "../src/admin-sessions.mjs";
import { RESET_CONFIRMATION } from "../src/admin-recovery.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failure = (message) => Object.assign(new Error(message), { status: 400 });

export function parseResetArguments(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const options = {},
    seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (
      !["--root", "--confirm", "--service-stopped"].includes(flag) ||
      seen.has(flag)
    )
      throw failure(
        "관리자 복구 옵션이 올바르지 않습니다. --help를 확인하세요.",
      );
    seen.add(flag);
    if (flag === "--service-stopped") {
      options.serviceStopped = true;
      continue;
    }
    const value = args[++index];
    if (typeof value !== "string" || !value || value.startsWith("--"))
      throw failure("관리자 복구 경로 또는 확인 문구가 필요합니다.");
    options[flag === "--root" ? "rootDir" : "confirmation"] = value;
  }
  if (!options.serviceStopped)
    throw failure("서버를 먼저 종료한 뒤 --service-stopped로 확인하세요.");
  if (options.confirmation !== RESET_CONFIRMATION)
    throw failure(`복구 확인 문구는 '${RESET_CONFIRMATION}'입니다.`);
  return options;
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
async function assertStopped(rootDir, alive) {
  await assertRecoveryDirectory(
    join(rootDir, ".updates"),
    ["server.json", "instance.json"],
    { allowMissing: true },
  );
  for (const name of ["server.json", "instance.json"]) {
    let record;
    try {
      const text = await readFile(join(rootDir, ".updates", name), "utf8");
      if (text.length > 16384) throw Error();
      record = JSON.parse(text);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw failure(
        "기존 서버 실행 기록을 확인할 수 없습니다. 종료 상태를 먼저 확인하세요.",
      );
    }
    if (!record || !Number.isSafeInteger(record.pid) || record.pid < 1)
      throw failure("기존 서버 실행 기록이 올바르지 않습니다.");
    if (alive(record.pid))
      throw failure("서버가 실행 중입니다. 서버를 정상 종료한 뒤 복구하세요.");
  }
}
export async function resetLocalAdmin({
  rootDir = ROOT,
  confirmation,
  serviceStopped,
  alive = processAlive,
} = {}) {
  if (serviceStopped !== true || confirmation !== RESET_CONFIRMATION)
    throw failure("서비스 종료 확인과 관리자 복구 확인 문구가 필요합니다.");
  let root;
  try {
    root = await realpath(resolve(rootDir));
    const manifest = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    if (manifest.name !== "novel-collector") throw Error();
  } catch {
    throw failure("Novel Collector 설치 경로를 확인하세요.");
  }
  await assertStopped(root, alive);
  const directory = join(root, "secrets");
  await assertRecoveryDirectory(directory, [
    "admin-credentials.json",
    "admin-login.txt",
  ]);
  await assertRecoveryDirectory(join(root, "data"), ["admin-sessions.json"], {
    allowMissing: true,
  });
  let prepared = false;
  for (const filename of ["admin-credentials.json", "admin-login.txt"]) {
    try {
      await access(join(directory, filename));
      prepared = true;
    } catch (error) {
      if (error.code !== "ENOENT")
        throw failure("관리자 인증 정보 접근 권한을 확인하세요.");
    }
  }
  if (!prepared)
    throw failure(
      "기존 관리자 인증 정보가 없습니다. 설치 준비를 먼저 완료하세요.",
    );
  const credentials = await openCredentials({ directory });
  const sessions = new AdminSessions({
    store: { path: (...parts) => join(root, "data", ...parts) },
    binding: credentials.sessionVersion(),
  });
  await credentials.reset();
  sessions.bind(credentials.sessionVersion());
  await sessions.flush();
  return { reset: true, passwordFile: join(directory, "admin-login.txt") };
}

export async function main(
  args = process.argv.slice(2),
  {
    write = (line) => console.info(line),
    errorWrite = (line) => console.error(line),
  } = {},
) {
  try {
    const options = parseResetArguments(args);
    if (options.help) {
      write(
        `서버를 먼저 정상 종료하세요. 로컬 파일 접근 권한이 있는 관리자만 실행할 수 있습니다.\n사용법: node tools/reset-admin.mjs [--root 설치경로] --service-stopped --confirm "${RESET_CONFIRMATION}"\n새 비밀번호는 secrets/admin-login.txt에 저장되고 터미널에 출력되지 않습니다.`,
      );
      return 0;
    }
    const result = await resetLocalAdmin(options);
    write(
      `관리자 비밀번호를 초기화했습니다. 새 접속 정보 파일: ${result.passwordFile}`,
    );
    return 0;
  } catch (error) {
    errorWrite(
      error.status
        ? error.message
        : "관리자 복구에 실패했습니다. 서비스 종료 상태와 파일 권한을 확인하세요.",
    );
    return 1;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  process.exitCode = await main();
