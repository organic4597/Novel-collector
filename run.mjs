import { existsSync } from "node:fs";
import { readFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const pathFor = platform => platform === "win32" ? path.win32 : path.posix;
const failure = (code, message) => Object.assign(new Error(message), { code });
export function runtimePaths(rootDir, platform = process.platform) {
  const p = pathFor(platform);
  return { rootDir, python: p.join(rootDir, ".venv-captcha", platform === "win32" ? "Scripts" : "bin", platform === "win32" ? "python.exe" : "python"),
    venv: p.join(rootDir, ".venv-captcha"), profile: p.join(rootDir, "profile", "chromium"),
    browsers: p.join(rootDir, "profile", "playwright-browsers"),
    bundledBrowser: p.join(rootDir, "browser", platform === "win32" ? "chrome-win64" : "chrome-linux64", platform === "win32" ? "chrome.exe" : "chrome"),
  };
}
export function runtimeEnvironment(rootDir, supplied = process.env, platform = process.platform, exists = existsSync) {
  const p = pathFor(platform), paths = runtimePaths(rootDir, platform);
  const legacyProfile = p.join(rootDir, "data", "browser-profile");
  return { ...supplied, NODE_ENV: supplied.NODE_ENV || "production", HOST: supplied.HOST || "127.0.0.1", PORT: supplied.PORT || "8788",
    PROFILE_DIR: supplied.PROFILE_DIR ? p.resolve(rootDir, supplied.PROFILE_DIR) : exists(legacyProfile) ? legacyProfile : paths.profile,
    PLAYWRIGHT_BROWSERS_PATH: supplied.PLAYWRIGHT_BROWSERS_PATH ? p.resolve(rootDir, supplied.PLAYWRIGHT_BROWSERS_PATH) : paths.browsers,
    XDG_CONFIG_HOME: supplied.XDG_CONFIG_HOME || p.join(rootDir, "profile", "config"),
    XDG_CACHE_HOME: supplied.XDG_CACHE_HOME || p.join(rootDir, "profile", "cache"),
    OPENBLAS_NUM_THREADS: supplied.OPENBLAS_NUM_THREADS || "1", OMP_NUM_THREADS: supplied.OMP_NUM_THREADS || "1",
  };
}
export function parseArguments(args) {
  const allowed = new Set(["--help", "--setup", "--check", "--no-setup", "--test-images", "--replace"]);
  if (args.some(arg => !allowed.has(arg))) throw failure("ARGUMENT_INVALID", "지원하는 옵션: --setup, --check, --no-setup, --test-images, --help");
  const modes = ["--setup", "--check", "--test-images"].filter(arg => args.includes(arg));
  if (modes.length > 1 || (args.includes("--setup") && args.includes("--no-setup")))
    throw failure("ARGUMENT_INVALID", "실행 모드 옵션을 함께 사용할 수 없습니다.");
  return { mode: args.includes("--help") ? "help" : modes[0]?.slice(2) || "start",
    ...(args.includes("--replace")?{replace:true}:{}),
    setup: !args.includes("--no-setup") && !args.includes("--check") && !args.includes("--test-images") };
}
export async function waitForUpdate(rootDir=ROOT,{sleep=ms=>new Promise(r=>setTimeout(r,ms)),alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}}}={}){
  const lock=path.join(rootDir,".updates","lock.json");
  for(let i=0;i<1800;i++){
    let job;try{job=JSON.parse(await readFile(lock,"utf8"));}catch(e){
      if(e.code!=="ENOENT")throw failure("UPDATE_LOCK","업데이트 잠금 파일을 확인하세요.");
      try{job=JSON.parse(await readFile(path.join(rootDir,".updates","pending-verification.json"),"utf8"));}catch(error){if(error.code==="ENOENT")return;throw failure("UPDATE_LOCK","업데이트 검증 기록을 확인하세요.");}
      if(Number.isSafeInteger(job.pid)&&job.pid>0&&alive(job.pid))return;
    }
    if(!Number.isSafeInteger(job.pid)||job.pid<1)throw failure("UPDATE_LOCK","업데이트 잠금 형식을 확인하세요.");
    if(!alive(job.pid)){
      const helper=path.join(rootDir,".updates","recover.mjs");
      if(existsSync(path.join(rootDir,".updates","transaction.json"))){if(!existsSync(helper))throw failure("UPDATE_RECOVERY","업데이트 복구 스크립트를 확인하세요.");const result=await runCommand(process.execPath,[helper,rootDir]);if(result.code!==0)throw failure("UPDATE_RECOVERY","이전 소스 자동 복구를 완료하지 못했습니다.");}
      const {rm,writeFile}=await import("node:fs/promises");await rm(lock,{force:true});await rm(path.join(rootDir,".updates","pending-verification.json"),{force:true});await writeFile(path.join(rootDir,".updates","job.json"),JSON.stringify({state:"failed",message:"중단된 업데이트에서 이전 소스를 복구했습니다."}),{mode:0o600});return;
    }
    await sleep(1000);
  }throw failure("UPDATE_WAIT","업데이트 완료를 기다리는 중 시간 제한을 초과했습니다.");
}

export function runCommand(command, args, { cwd = ROOT, env = process.env, capture = false, timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "", stderr = "", interrupted = null;
    const stop = signal => { interrupted = signal; child.kill(signal); };
    const onInt = () => stop("SIGINT"), onTerm = () => stop("SIGTERM");
    process.once("SIGINT", onInt); process.once("SIGTERM", onTerm);
    const timer = setTimeout(() => stop("SIGKILL"), timeoutMs);
    const cleanup = () => { clearTimeout(timer); process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm); };
    child.stdout?.on("data", chunk => { stdout += chunk; if (stdout.length > 65536) stop("SIGKILL"); });
    child.stderr?.on("data", chunk => { stderr += chunk; if (stderr.length > 65536) stop("SIGKILL"); });
    child.once("error", () => { cleanup(); reject(failure("COMMAND_UNAVAILABLE", "준비 명령을 실행할 수 없습니다. Node.js·npm·Python 설치와 실행 권한을 확인하세요.")); });
    child.once("close", code => {
      cleanup();
      if (interrupted) reject(failure("COMMAND_INTERRUPTED", "준비 작업이 취소되거나 시간 제한을 초과했습니다."));
      else resolve({ code, stdout, stderr });
    });
  });
}

export function npmCliPath({ nodePath = process.execPath, env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const p = pathFor(platform), directory = p.dirname(nodePath);
  const candidates = [env.npm_execpath,
    p.join(directory, "node_modules", "npm", "bin", "npm-cli.js"),
    p.join(directory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    p.join(directory, "..", "share", "nodejs", "npm", "bin", "npm-cli.js")];
  const found = candidates.find(file => file?.endsWith(".js") && exists(file));
  if (!found) throw failure("NPM_UNAVAILABLE", "npm을 포함한 Node.js 22 이상을 설치하세요.");
  return found;
}
export async function dependenciesReady(rootDir) {
  const manifest = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  try {
    for (const [name, version] of Object.entries(manifest.dependencies || {})) {
      // Never resolve through ancestors: staging lives underneath the old install.
      const installed = JSON.parse(await readFile(path.join(rootDir,"node_modules",name,"package.json"), "utf8"));
      if (installed.version !== version) return false;
    }
    return true;
  } catch { return false; }
}
const pythonProbe = modules => `import sys,json\n${modules ? "import cv2,numpy\n" : ""}print(json.dumps({"executable":sys.executable,"version":list(sys.version_info[:3])${modules ? ',"opencv":cv2.__version__,"numpy":numpy.__version__' : ""}}))`;
async function probePython(command, prefix, modules, run, options) {
  try {
    const result = await run(command, [...prefix, "-c", pythonProbe(modules)], { ...options, capture: true, timeoutMs: 15000 });
    if (result.code !== 0) return null;
    const info = JSON.parse(result.stdout.trim());
    if (info.version?.[0] !== 3 || info.version[1] < 9 || typeof info.executable !== "string") return null;
    return info;
  } catch (e) { if (e.code === "COMMAND_INTERRUPTED") throw e; return null; }
}
export function pythonCandidates(platform = process.platform) {
  return platform === "win32"
    ? ["3.12", "3.11", "3.10", "3.9"].map(v => ["py", [`-${v}`]]).concat([["python", []], ["python3", []]])
    : ["python3.12", "python3.11", "python3.10", "python3.9", "python3", "python"].map(command => [command, []]);
}

export async function prepareRuntime({ rootDir = ROOT, supplied = process.env, platform = process.platform,
  nodeVersion = process.versions.node, nodePath = process.execPath, setup = true, hooks = {}, log = message => console.info(`[Launcher] ${message}`) } = {}) {
  const major = Number(nodeVersion.split(".")[0]);
  if (!Number.isSafeInteger(major) || major < 22) throw failure("NODE_VERSION", "Node.js 22 이상이 필요합니다.");
  if (!["win32", "linux"].includes(platform)) throw failure("PLATFORM", "Windows와 Linux 실행을 지원합니다.");
  const paths = runtimePaths(rootDir, platform), env = runtimeEnvironment(rootDir, supplied, platform);
  const exists = hooks.exists || existsSync, run = hooks.run || runCommand;
  const options = { cwd: rootDir, env };
  const execute = async (command, args) => {
    const result = await run(command, args, options);
    if (result.code !== 0) throw failure("SETUP_FAILED", "의존성 준비가 실패했습니다. 위 설치 결과를 확인하세요.");
  };
  const ready = hooks.dependenciesReady || (() => dependenciesReady(rootDir));
  if (!(await ready())) {
    if (!setup) throw failure("DEPENDENCIES_MISSING", "프로젝트 의존성이 없습니다. node run.mjs --setup으로 먼저 준비하세요.");
    log("Node.js 프로젝트 의존성 준비");
    await execute(nodePath, [npmCliPath({ nodePath, env, platform, exists }), "ci", "--omit=dev", "--no-audit", "--no-fund"]);
    if (!(await ready())) throw failure("DEPENDENCIES_MISSING", "프로젝트 의존성 설치를 확인하지 못했습니다.");
  }

  const targetPython = supplied.CAPTCHA_PYTHON || paths.python;
  let python = await probePython(targetPython, [], true, run, options);
  if (!python) {
    if (!setup || supplied.CAPTCHA_PYTHON)
      throw failure("PYTHON_MISSING", "Python/OpenCV 환경을 확인하세요. 기본 환경은 node run.mjs --setup으로 준비할 수 있습니다.");
    const uv = await run(platform === "win32" ? "uv.exe" : "uv", ["--version"], { ...options, capture: true, timeoutMs: 10000 }).catch(() => null);
    const uvAvailable = uv?.code === 0;
    if (!exists(paths.python)) {
      log("독립 Python 가상환경 준비");
      if (uvAvailable) await execute(platform === "win32" ? "uv.exe" : "uv", ["venv", "--python", "3.11", paths.venv]);
      else {
        let base;
        for (const [command, prefix] of pythonCandidates(platform)) {
          const info = await probePython(command, prefix, false, run, options);
          if (info && info.version[1] <= 12) { base = info.executable; break; }
        }
        if (!base) throw failure("PYTHON_MISSING", "Python 3.9~3.12 또는 uv를 설치하세요. Python 3.11을 권장합니다.");
        await execute(base, ["-m", "venv", paths.venv]);
      }
    }
    log("OpenCV·NumPy 의존성 준비");
    const requirements = pathFor(platform).join(rootDir, "requirements-captcha.txt");
    if (uvAvailable) await execute(platform === "win32" ? "uv.exe" : "uv", ["pip", "install", "--python", paths.python, "-r", requirements]);
    else {
      await execute(paths.python, ["-m", "ensurepip", "--upgrade"]);
      await execute(paths.python, ["-m", "pip", "install", "--disable-pip-version-check", "-r", requirements]);
    }
    python = await probePython(paths.python, [], true, run, options);
    if (!python) throw failure("PYTHON_MISSING", "Python 이미지 분석 환경을 준비하지 못했습니다.");
  }
  env.CAPTCHA_PYTHON = python.executable;

  let browser = supplied.BROWSER_PATH || (exists(paths.bundledBrowser) ? paths.bundledBrowser : null);
  if (!browser) {
    const getBrowser = hooks.browserPath || (async () => {
      process.env.PLAYWRIGHT_BROWSERS_PATH = env.PLAYWRIGHT_BROWSERS_PATH;
      const { chromium } = await import("playwright");
      return chromium.executablePath();
    });
    browser = await getBrowser();
    if (!exists(browser)) {
      if (!setup) throw failure("BROWSER_MISSING", "Chromium이 없습니다. node run.mjs --setup으로 먼저 준비하세요.");
      log("Chromium 준비");
      const cli = hooks.playwrightCli || (() => {
        const require = createRequire(path.join(rootDir, "package.json"));
        return path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
      })();
      await execute(nodePath, [cli, "install", "chromium"]);
      if (!exists(browser)) throw failure("BROWSER_MISSING", "Chromium 설치를 확인하지 못했습니다.");
    }
  }
  if (!exists(browser)) throw failure("BROWSER_MISSING", "BROWSER_PATH의 Chromium 실행 파일을 확인하세요.");
  if (platform === "win32") {
    // Windows Chrome does not provide a reliable POSIX --version process.
    // Use an ephemeral, blank headless browser instead of the saved profile.
    const check = hooks.checkWindowsBrowser || (async (executablePath, browserEnv) => {
      process.env.PLAYWRIGHT_BROWSERS_PATH = browserEnv.PLAYWRIGHT_BROWSERS_PATH;
      const { chromium } = await import("playwright");
      const opened = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, env: browserEnv, timeout: 15000 });
      await opened.close();
    });
    try { await check(browser, env); } catch {
      throw failure("BROWSER_DEPENDENCIES", "Chromium 실행에 필요한 운영체제 라이브러리와 실행 권한을 확인하세요.");
    }
  } else {
    const browserCheck = await run(browser, ["--version"], { ...options, capture: true, timeoutMs: 15000 });
    if (browserCheck.code !== 0) throw failure("BROWSER_DEPENDENCIES", "Chromium 실행에 필요한 운영체제 라이브러리를 확인하세요.");
  }
  env.BROWSER_PATH = browser;
  log("실행 환경 확인 완료");
  return { env, paths, python };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.mode === "help") {
    console.log("Windows/Linux: node run.mjs\n--setup: 준비만 실행\n--check: 설치 없이 확인\n--no-setup: 설치 없이 서버 실행\n--replace: 같은 설치의 기존 인스턴스 정상 종료 후 시작\n--test-images: Python 이미지 테스트");
    return;
  }
  process.chdir(ROOT);
  if(args.mode==="start"&&args.replace){
    if(existsSync(path.join(ROOT,".updates","lock.json"))||existsSync(path.join(ROOT,".updates","pending-verification.json")))throw failure("UPDATE_BUSY","업데이트 완료 후 기존 인스턴스를 교체하세요.");
  }
  if(args.mode==="start")await waitForUpdate(ROOT);
  if(args.mode==="start"&&args.replace){
    const { stopExisting } = await import("./src/instance-control.mjs");
    await stopExisting(ROOT);
  }
  const { env, python } = await prepareRuntime({ setup: args.setup });
  if (args.mode === "test-images") {
    const result = await runCommand(python.executable, ["-m", "unittest", "discover", "-s", "tests", "-p", "captcha_position_test.py", "-v"], { env });
    process.exitCode = result.code || 0;
    return;
  }
  if (["setup", "check"].includes(args.mode)) return;
  Object.assign(process.env, env);
  await Promise.all(["data", "secrets", "profile/config", "profile/cache"].map(dir => mkdir(path.join(ROOT, dir), { recursive: true, mode: 0o700 })));
  const { startServer } = await import("./src/server.mjs");
  const runtime = await startServer({ rootDir: ROOT });
  const address = runtime.app.address();
  console.info(`[Launcher] Novel Collector 실행 중 · http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(async error => {
    console.error(`[Launcher] ${error.code || "START_FAILED"}: ${error.code ? error.message : "실행을 완료하지 못했습니다. 실행 환경과 서비스 로그를 확인하세요."}`);
    try{const {updateLog,updateEvent}=await import("./src/activity-log.mjs"),log=await updateLog(ROOT);updateEvent(log,"START_SERVER",error.message,{level:"error",errorCode:error.code||"START_FAILED",component:"launcher"});await log.close();}catch{}
    process.exitCode = 1;
  });
}
