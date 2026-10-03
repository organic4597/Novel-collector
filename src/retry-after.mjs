export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== "string" || !value.trim()) return 0;
  const raw = value.trim();
  if (/^\d+$/.test(raw)) {
    const milliseconds = Number(raw) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : 0;
  }
  const deadline = Date.parse(raw);
  return Number.isFinite(deadline) ? Math.max(0, deadline - now) : 0;
}
