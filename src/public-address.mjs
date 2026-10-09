import { isIP } from "node:net";

export function isPublicAddress(address) {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice(7);
    if (isIP(mapped) === 4) return isPublicAddress(mapped);
    const pairs = mapped.split(":");
    if (pairs.length === 2) {
      const value = parseInt(pairs[0], 16) * 65536 + parseInt(pairs[1], 16);
      return isPublicAddress([24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join("."));
    }
  }
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)));
  }
  if (isIP(address) === 6) return !/^(::|fc|fd|fe[89ab]|ff)/.test(normalized);
  return false;
}
