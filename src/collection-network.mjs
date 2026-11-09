const FIVE_MINUTES = 300000;
const RECOVERY = new Set(["disconnecting", "cooldown", "reconnecting", "verifying"]);
const PHASES = new Set(["offline", "ready", ...RECOVERY, "needs_attention"]);
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

export class CollectionNetwork {
  constructor({
    enabled = false, store, phone, connect, probe, clock = Date.now,
    pollMs = 2000, onChange = () => {}, schedule = setTimeout, cancel = clearTimeout,
  } = {}) {
    if (typeof enabled !== "boolean" || !Number.isSafeInteger(pollMs) || pollMs < 1)
      throw Error("수집 연결 설정이 올바르지 않습니다.");
    if (enabled && (!store?.path || !store?.json || !store?.atomic ||
      ![phone, connect, probe].every(value => typeof value === "function")))
      throw Error("테더링 저장소와 휴대전화·연결 확인 도구가 필요합니다.");
    Object.assign(this, { enabled, store, phone, connect, probe, clock, pollMs, onChange, schedule, cancel });
    this.path = enabled ? store.path("collection-network.json") : null;
    this.state = { schema: 1, phase: "offline", reason: "테더링 연결 확인 대기", retryAt: null, cycleUsed: false, siteHost: null };
    this.closed = false;
    this.started = false;
    this.epoch = 0;
    this.revision = 0;
    this.writes = Promise.resolve();
    this.work = null;
    this.probing = null;
    this.monitorTimer = null;
    this.recoveryTimer = null;
  }

  snapshot() {
    const phase = !this.enabled ? "disabled" : this.closed ? "closed" : this.state.phase;
    const ready = !this.enabled || phase === "ready";
    return { enabled: this.enabled, active: this.enabled && !ready, ready, phase,
      reason: ready ? null : this.state.reason, retryAt: this.state.retryAt,
      siteHost: this.state.siteHost, cycleUsed: this.state.cycleUsed };
  }

  assertAvailable() {
    if (this.snapshot().active)
      throw Object.assign(Error(this.state.reason || "테더링 연결을 기다리고 있습니다."),
        { code: "COLLECTION_NETWORK_PAUSED", status: 503 });
  }

  live(epoch) { return !this.closed && epoch === this.epoch; }

  async change(patch) {
    if (this.closed) return;
    const next = { ...this.state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    const revision = ++this.revision;
    const notice = this.snapshot();
    const write = this.writes.catch(() => {}).then(() => this.store.atomic(this.path, next));
    this.writes = write;
    await write;
    if (!this.closed && revision === this.revision) {
      try { await this.onChange(notice); }
      catch {
        // A failed observer must never grant collection permission.
        if (!this.closed) {
          this.state = { ...this.state, phase: "needs_attention", reason: "수집 연결 상태 알림에 실패했습니다." };
          ++this.revision;
          const persist = this.writes.catch(() => {}).then(() => this.store.atomic(this.path, this.state));
          this.writes = persist;
          await persist;
        }
      }
    }
  }

  async fail(error) {
    if (!this.closed)
      await this.change({ phase: "needs_attention", retryAt: null,
        reason: "테더링 제어 또는 연결 검증에 실패했습니다. 휴대전화 연결을 확인하세요." + (typeof error?.code==="string"&&/^[A-Z0-9_]{1,80}$/.test(error.code)?" ("+error.code+")":"") });
  }

  launch(operation) {
    const previous = this.work;
    const task = Promise.resolve(previous).then(operation).catch(error => this.fail(error));
    const tracked = task.finally(() => { if (this.work === tracked) this.work = null; });
    this.work = tracked;
    return tracked;
  }

  async start() {
    if (!this.enabled || this.started || this.closed) return this.snapshot();
    this.started = true;
    try {
      const saved = await this.store.json(this.path);
      if (this.closed) return this.snapshot();
      if (saved) {
        if (saved.schema !== 1 || !PHASES.has(saved.phase) ||
          typeof saved.cycleUsed !== "boolean" ||
          (saved.siteHost != null && (typeof saved.siteHost !== "string" || !HOST.test(saved.siteHost))) ||
          (saved.phase === "cooldown" && !Number.isFinite(Date.parse(saved.retryAt))))
          throw Error("저장된 수집 연결 상태를 확인하세요.");
        this.state = { ...this.state, ...saved,
          phase: saved.phase === "ready" ? "offline" : saved.phase };
        ++this.revision;
      }
      if (this.state.phase === "cooldown") this.armCooldown();
      else if (this.state.phase === "disconnecting") {
        const epoch = this.epoch;
        await this.launch(() => this.disconnect(epoch));
      } else if (["reconnecting", "verifying"].includes(this.state.phase)) {
        const epoch = this.epoch;
        await this.launch(() => this.reconnect(epoch));
      } else if (this.state.phase !== "needs_attention") await this.refresh();
    } catch { await this.fail(); }
    this.armMonitor();
    return this.snapshot();
  }

  bootstrap() {
    if (!this.enabled || this.closed || RECOVERY.has(this.state.phase) || this.state.phase === "ready")
      return this.work || Promise.resolve(this.snapshot());
    const epoch = ++this.epoch;
    const held = this.change({ phase: "reconnecting", retryAt: null, cycleUsed: false,
      reason: "휴대전화 테더링 연결 준비 중" });
    return this.launch(async () => {
      await held;
      if (this.live(epoch)) await this.reconnect(epoch);
      return this.snapshot();
    });
  }

  refresh() {
    if (!this.enabled || this.closed || RECOVERY.has(this.state.phase) || this.state.phase === "needs_attention")
      return Promise.resolve(this.snapshot());
    if (this.probing) return this.probing;
    const revision = this.revision;
    const pending = (async () => {
      let ready = false;
      try { ready = (await this.probe())?.ready === true; } catch {}
      if (!this.closed && revision === this.revision)
        await this.change({ phase: ready ? "ready" : "offline", retryAt: null,
          reason: ready ? null : "휴대전화 테더링 연결이 끊겨 수집을 기다리고 있습니다." });
      return this.snapshot();
    })();
    const tracked = pending.finally(() => { if (this.probing === tracked) this.probing = null; });
    this.probing = tracked;
    return tracked;
  }

  block({ siteHost, blockCode } = {}) {
    if (!this.enabled || this.closed || blockCode !== "NGINX_CIDR_REALIP")
      return Promise.resolve(false);
    if (typeof siteHost !== "string" || !HOST.test(siteHost))
      return Promise.reject(Error("차단된 사이트 주소가 올바르지 않습니다."));
    if (RECOVERY.has(this.state.phase)) return this.work || Promise.resolve(this.snapshot());
    const epoch = ++this.epoch;
    if (this.state.cycleUsed) {
      const held = this.change({ phase: "needs_attention", retryAt: null, siteHost,
        reason: "테더링 재연결 후에도 접근 차단이 확인됐습니다. 수집을 보류합니다." });
      return this.launch(async () => { await held; return this.snapshot(); });
    }
    const held = this.change({ phase: "disconnecting", retryAt: null, cycleUsed: true,
      siteHost, reason: "IP 대역 접근 차단으로 테더링 연결을 재설정합니다." });
    return this.launch(async () => {
      await held;
      if (this.live(epoch)) await this.disconnect(epoch);
      return this.snapshot();
    });
  }

  async disconnect(epoch) {
    if (!this.live(epoch)) return;
    const result = await this.phone("off");
    if (!this.live(epoch)) return;
    if (result?.enabled !== false) throw Error("테더링 종료가 확인되지 않았습니다.");
    await this.change({ phase: "cooldown", retryAt: new Date(this.clock() + FIVE_MINUTES).toISOString(),
      reason: "테더링 종료 확인 완료 · 5분 뒤 다시 연결합니다." });
    if (this.live(epoch)) this.armCooldown();
  }

  async reconnect(epoch) {
    if (!this.live(epoch)) return;
    await this.change({ phase: "reconnecting", reason: "휴대전화 테더링 재연결 중" });
    if (!this.live(epoch)) return;
    const phone = await this.phone("on");
    if (!this.live(epoch)) return;
    if (phone?.enabled !== true) throw Error("테더링 시작이 확인되지 않았습니다.");
    const connected = await this.connect();
    if (!this.live(epoch)) return;
    if (connected?.ready !== true) throw Error("테더링 경로가 확인되지 않았습니다.");
    await this.change({ phase: "verifying", reason: "테더링 전용 수집 경로 확인 중" });
    if (!this.live(epoch)) return;
    const proof = await this.probe();
    if (!this.live(epoch)) return;
    if (proof?.ready !== true) throw Error("테더링 연결 검증에 실패했습니다.");
    await this.change({ phase: "ready", retryAt: null, reason: null });
  }

  armCooldown() {
    if (this.closed) return;
    this.cancel(this.recoveryTimer);
    const epoch = this.epoch;
    this.recoveryTimer = this.schedule(() => {
      this.recoveryTimer = null;
      if (this.live(epoch)) void this.launch(() => this.reconnect(epoch)).catch(() => {});
    }, Math.max(0, Date.parse(this.state.retryAt) - this.clock()));
    this.recoveryTimer?.unref?.();
  }

  armMonitor() {
    if (this.closed || !this.enabled) return;
    this.cancel(this.monitorTimer);
    this.monitorTimer = this.schedule(() => {
      this.monitorTimer = null;
      void this.refresh().catch(() => this.fail()).finally(() => this.armMonitor()).catch(() => {});
    }, this.pollMs);
    this.monitorTimer?.unref?.();
  }

  close() {
    this.closed = true;
    ++this.epoch;
    this.cancel(this.monitorTimer);
    this.cancel(this.recoveryTimer);
    this.monitorTimer = this.recoveryTimer = null;
  }
}

// This only probes host/status and phone/status; it never prepares or toggles tethering.
export async function refreshCollectionLink(network,error) {
  if(!network?.enabled||network.snapshot().active||typeof network.refresh!=="function")return;
  if(["ECONNRESET","ECONNREFUSED","ENETUNREACH","EHOSTUNREACH"].includes(error.code)||
    /net::ERR_(?:PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|CONNECTION_CLOSED|CONNECTION_RESET|INTERNET_DISCONNECTED|NETWORK_CHANGED|ADDRESS_UNREACHABLE|NAME_NOT_RESOLVED|FAILED)\b/.test(String(error.message||"")))await network.refresh();
}
