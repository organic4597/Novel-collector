import { validateUrl } from "./store.mjs";

export const DEFAULT_SOURCE_ORIGIN = "https://sbxh9.com";
export const SOURCE_HOSTS = ["sbxh9.com", "toki32.com"];

// Legacy external source is inactive. Canonical names identify existing files.
// Its previous routing is retained in the migration archive, never as fallback.
// const LEGACY_EXTERNAL_SOURCE = "https://newtoki1.org";
export function sourceGateHost(host) {
  if (SOURCE_HOSTS.includes(host)) return "newtoki1.org";
  return new URL(validateUrl(`https://${host}/novel/1`)).hostname;
}
