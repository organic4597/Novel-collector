// Inspect the Git index, not ignored runtime files. Never print matched values.
import { execFileSync } from "node:child_process";
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const files = git("ls-files", "-z").split("\0").filter(Boolean);
const allowed = /^(?:LICENSE|README\.md|\.gitignore|run\.mjs|package(?:-lock)?\.json|requirements-captcha\.txt|src\/[^/]+\.mjs|public\/[^/]+\.(?:js|html|css)|tests\/[^/]+\.test\.mjs|tests\/captcha_position_test\.py|tests\/fixtures\/(?:captcha-reader\.html|work-detail-synthetic\.html|discovery-synthetic\.mjs)|tools\/(?:captcha_position\.py|evaluate_captcha\.py|check-publication\.mjs)|docs\/(?:CAPTCHA|CONTRACT|TESTING|INSTALL|UPDATE|TROUBLESHOOTING|DASHBOARD|PRESETS)\.md|docs\/assets\/[^/]+\.svg|deploy\/novel-collector\.service)$/;
const privateValues = (process.env.PRIVATE_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);
const rules = [
  ["private-key", /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/],
  ["access-token", /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/],
  ["captured-cookie", /(?:ntk_fp|__vsid|ntk_pid)=[A-Za-z0-9_-]{16,}/],
  ["private-home", /\/(?:home1|root)\/[A-Za-z0-9_.-]+/],
  ["authenticated-url", /https?:\/\/[^\s/"'<>]+:[^\s/@"'<>]+@/],
];
const findings = [];
for (const file of files) {
  if (!allowed.test(file)) { findings.push({ file, rule: "not-allowlisted" }); continue; }
  const contents = git("show", `:${file}`);
  if (Buffer.byteLength(contents) > 1024 * 1024) findings.push({ file, rule: "oversized-source" });
  for (const [rule, expression] of rules) {
    // Tests intentionally exercise rejection of fake authenticated URLs.
    if (rule === "authenticated-url" && file.startsWith("tests/")) continue;
    if (expression.test(contents)) findings.push({ file, rule });
  }
  if (privateValues.some((value) => contents.includes(value))) findings.push({ file, rule: "private-host" });
}
console.log(JSON.stringify({ files: files.length, findings }, null, 2));
if (findings.length) process.exitCode = 1;
