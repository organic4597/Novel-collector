import { cleanMessage, safeId, validateUrl } from "./store.mjs";
import { viewerOrigin as allowedViewerOrigin } from "./viewer-origins.mjs";

const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const kinds = ["authentication", "captcha", "site_blocked", "unknown"];
function hostId(host) {
  return new URL(validateUrl(`https://${host}/novel/1`)).hostname;
}
function proofOrigin(value, host) {
  if (value === `https://${host}`) return value;
  return allowedViewerOrigin(value);
}
function slotList(slots) {
  if (
    !Array.isArray(slots) ||
    !slots.length ||
    slots.some((slot) => ![1, 2].includes(slot))
  )
    throw invalid("인증 슬롯은 1 또는 2여야 합니다.");
  return [...new Set(slots)].sort();
}
export class SiteAttention {
  constructor({ store, clock = Date.now }) {
    this.store = store;
    this.clock = clock;
    this.path = store.path("site-attention.json");
    this.sites = new Map();
    this.pending = Promise.resolve();
  }
  serialized(operation) {
    const next = this.pending.catch(() => {}).then(operation);
    this.pending = next;
    return next;
  }
  async persist(next) {
    await this.store.atomic(this.path, { sites: [...next.values()] });
    this.sites = next;
  }
  async load() {
    return this.serialized(async () => {
      const saved = await this.store.json(this.path);
      if (!saved) return this.snapshot();
      if (!Array.isArray(saved.sites))
        throw invalid("저장된 사이트 인증 상태가 올바르지 않습니다.");
      const sites = new Map();
      for (const site of saved.sites) {
        const host = hostId(site.host),
          requiredSlots = slotList(site.requiredSlots);
        const verifiedSlots = Array.isArray(site.verifiedSlots)
          ? [...new Set(site.verifiedSlots)]
              .filter((slot) => requiredSlots.includes(slot))
              .sort()
          : [];
        sites.set(host, {
          host,
          reason: cleanMessage(site.reason),
          kind: /일일\s*조회\s*인증|captcha_required_daily_quota/i.test(
            site.reason || "",
          )
            ? "captcha"
            : kinds.includes(site.kind)
              ? site.kind
              : "unknown",
          jobIds: (site.jobIds ?? []).map(safeId),
          requiredSlots,
          verifiedSlots,
          ...(site.proofOrigin != null
            ? { proofOrigin: proofOrigin(site.proofOrigin, host) }
            : {}),
          createdAt: site.createdAt,
          held:
            site.held !== false ||
            !requiredSlots.every((slot) => verifiedSlots.includes(slot)),
        });
      }
      const migrated = saved.sites.some(
        (site) =>
          /일일\s*조회\s*인증|captcha_required_daily_quota/i.test(
            site.reason || "",
          ) && site.kind !== "captcha",
      );
      if (migrated) await this.persist(sites);
      else this.sites = sites;
      return this.snapshot();
    });
  }
  get(host) {
    const site = this.sites.get(hostId(host));
    return site ? structuredClone(site) : null;
  }
  isHeld(host) {
    return this.sites.get(hostId(host))?.held === true;
  }
  snapshot() {
    return { sites: structuredClone([...this.sites.values()]) };
  }
  async holdSite(host, { reason, jobIds = [], requiredSlots, kind } = {}) {
    host = hostId(host);
    const slots = slotList(requiredSlots),
      ids = jobIds.map(safeId);
    return this.serialized(async () => {
      const previous = this.sites.get(host);
      const continuing = previous?.held === true;
      const site = {
        host,
        reason: cleanMessage(reason || "사이트 인증이 필요합니다."),
        kind: /일일\s*조회\s*인증|captcha_required_daily_quota/i.test(
          reason || "",
        )
          ? "captcha"
          : kinds.includes(kind)
            ? kind
            : continuing
              ? previous.kind
              : "unknown",
        jobIds: [...new Set([...(continuing ? previous.jobIds : []), ...ids])],
        requiredSlots: [
          ...new Set([...(continuing ? previous.requiredSlots : []), ...slots]),
        ].sort(),
        verifiedSlots: continuing ? [...previous.verifiedSlots] : [],
        ...(continuing && previous.proofOrigin
          ? { proofOrigin: previous.proofOrigin }
          : {}),
        createdAt: continuing
          ? previous.createdAt
          : new Date(this.clock()).toISOString(),
        held: true,
      };
      await this.persist(new Map([...this.sites, [host, site]]));
      return this.get(host);
    });
  }
  async verifySlot(host, slot, { viewerOrigin, beforeRelease } = {}) {
    host = hostId(host);
    const origin =
      viewerOrigin === undefined ? undefined : proofOrigin(viewerOrigin, host);
    if (beforeRelease !== undefined && typeof beforeRelease !== "function")
      throw invalid("인증 완료 저장기를 확인하세요.");
    return this.serialized(async () => {
      const previous = this.sites.get(host);
      if (!previous)
        throw Object.assign(new Error("인증 대기 사이트를 찾을 수 없습니다."), {
          status: 404,
        });
      if (!previous.requiredSlots.includes(slot))
        throw invalid("확인이 필요한 슬롯이 아닙니다.");
      // Each required profile must prove the same origin in this held cycle.
      // Unknown older partial proofs cannot establish trust for a new viewer.
      const priorSlots =
        previous.proofOrigin === origin ? previous.verifiedSlots : [];
      const verifiedSlots = [...new Set([...priorSlots, slot])].sort();
      const { proofOrigin: _previousOrigin, ...previousState } = previous;
      const site = {
        ...previousState,
        ...(origin !== undefined ? { proofOrigin: origin } : {}),
        verifiedSlots,
        held: !previous.requiredSlots.every((id) => verifiedSlots.includes(id)),
      };
      // Persist the shared destination before marking the gate released. A
      // failed destination write leaves the previous held proof on disk.
      if (!site.held) await beforeRelease?.(structuredClone(site));
      await this.persist(new Map([...this.sites, [host, site]]));
      return this.get(host);
    });
  }
}
