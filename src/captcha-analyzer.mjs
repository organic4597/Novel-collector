import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CaptchaError } from "./novel-captcha.mjs";

const script = fileURLToPath(new URL("../tools/captcha_position.py", import.meta.url));
const defaultPython = fileURLToPath(new URL(process.platform === "win32" ? "../.venv-captcha/Scripts/python.exe" : "../.venv-captcha/bin/python", import.meta.url));

export function createCaptchaAnalyzer({ python = defaultPython, profile = null, timeoutMs = 5000 } = {}) {
  return (challenge, { signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CaptchaError("CANCELLED"));
    const child = spawn(python, [script], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1" },
    });
    let output = "", error = null;
    const stop = (code) => { error ??= new CaptchaError(code); child.kill("SIGKILL"); };
    const abort = () => stop("CANCELLED");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("ANALYSIS_TIMEOUT"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 64 * 1024) stop("ANALYSIS_FAILED");
    });
    child.on("error", () => { error = new CaptchaError("ANALYZER_UNAVAILABLE"); });
    child.stdin.on("error", () => { error ??= new CaptchaError("ANALYSIS_FAILED"); });
    child.on("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) return reject(error);
      try {
        const result = JSON.parse(output);
        if (result.error) throw new CaptchaError(
          ["IMAGE_DECODE_FAILED", "IMAGE_SIZE_MISMATCH", "CREATE_INVALID_RESPONSE"].includes(result.error)
            ? result.error : "ANALYSIS_FAILED",
        );
        resolve(result);
      } catch (problem) {
        reject(problem instanceof CaptchaError ? problem : new CaptchaError("ANALYSIS_FAILED"));
      }
    });
    child.stdin.end(JSON.stringify({ challenge, profile }));
  });
}
