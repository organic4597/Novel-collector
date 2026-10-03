import { randomUUID } from "node:crypto";
import { validateViewerOrigin } from "./site-browser.mjs";

const fail = (message, status = 409) =>
  Object.assign(new Error(message), { status });
const validateHost = (host) => {
  if (
    typeof host !== "string" ||
    !/^newtoki\d+\.(org|com|net|me|co|io|site|tv)$/.test(host)
  )
    throw fail("지원하는 사이트를 선택하세요.", 400);
  return host;
};
const exactObject = (value, keys) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw fail("지원하는 인증 세션 입력을 확인하세요.", 400);
};

// This owns only the browser opened for this human dialog. No cookies, storage
// data or credentials cross domains; each slot proves its own rendered chapter.
export class CaptchaSession {
  constructor({
    siteBrowser,
    attention,
    scheduler,
    autoAuth,
    recovery,
    viewerOrigins = null,
  }) {
    Object.assign(this, {
      siteBrowser,
      attention,
      scheduler,
      autoAuth,
      recovery,
      viewerOrigins,
    });
    this.session = null;
    this.lastState = {
      open: false,
      state: "closed",
      host: null,
      slot: null,
      pendingSlots: [],
    };
    this.control = Promise.resolve();
    this.frameCapture = null;
    this.automatic = null;
  }

  serialized(operation) {
    const work = this.control.catch(() => {}).then(operation);
    this.control = work;
    return work;
  }

  async pending(host) {
    const site = await this.attention.get(host);
    if (!site?.held) return [];
    return (site.requiredSlots || []).filter(
      (slot) => !site.verifiedSlots?.includes(slot),
    );
  }

  async ownedState() {
    if (this.automatic?.active) return { ...this.automatic.status, automatic: this.autoStatus(), state: "automatic" };
    const session = this.session;
    if (!session)
      return {
        ...this.lastState,
          pendingSlots: [...this.lastState.pendingSlots],
          automatic: this.autoStatus(),
      };
    const state = await this.siteBrowser.status({ owner: session.owner });
    if (this.session !== session)
      throw fail("인증 세션이 변경됐습니다. 화면을 다시 요청하세요.");
    if (!state.open) {
      await this.finish("closed", state);
      return { ...this.lastState };
    }
    if (state.host !== session.host)
      throw fail("인증 브라우저가 변경됐습니다.");
    return { ...state, state: "open", automatic: this.autoStatus() };
  }

  async requireOwned() {
    if (this.automatic?.active) throw fail("자동 CAPTCHA 진행 중입니다. 완료 후 수동 입력을 사용하세요.");
    const state = await this.ownedState();
    if (!this.session || !state.open)
      throw fail("사람이 사용할 인증 세션을 먼저 여세요.");
    return this.session;
  }

  open(input = {}) {
    return this.serialized(async () => {
      exactObject(input, ["host", "viewerOrigin"]);
      const host = validateHost(input.host);
      const viewerOrigin = validateViewerOrigin(
        input.viewerOrigin ?? "https://sbxh9.com",
      );
      if (this.session) {
        const state = await this.ownedState();
        if (state.open) {
          if (
            this.session.host === host &&
            this.session.viewerOrigin === viewerOrigin
          )
            return state;
          throw fail("열려 있는 인증 세션을 먼저 닫으세요.");
        }
      }
      const slots = await this.pending(host);
      if (!slots.length)
        throw fail("이 사이트에 직접 확인할 인증 슬롯이 없습니다.");
      const session = { host, viewerOrigin, owner: randomUUID() };
      this.automatic = null;
      session.onExpired = async () => {
        if (this.session === session)
          await this.finish("closed", {
            host,
            pendingSlots: await this.pending(host),
          });
      };
      await this.recovery?.suspend(host);
      this.session = session;
      try {
        await this.autoAuth?.wait(host);
        const remaining = await this.pending(host);
        if (!remaining.length) {
          await this.finish("completed", { host, pendingSlots: [] });
          return { ...this.lastState };
        }
        const state = await this.siteBrowser.open({
          ...session,
          slot: remaining[0],
        });
        return { ...state, state: "open" };
      } catch (error) {
        await this.finish("closed", {
          host,
          pendingSlots: await this.pending(host),
        });
        throw error;
      }
    });
  }

  status() {
    return this.serialized(() => this.ownedState());
  }

  async frame() {
    const capture = await this.serialized(async () => {
      const session = await this.requireOwned();
      if (this.frameCapture)
        throw fail("진행 중인 화면 요청이 완료된 뒤 다시 요청하세요.", 429);
      const capture = { session };
      this.frameCapture = capture;
      return capture;
    });
    try {
      const frame = await this.siteBrowser.frame({
        owner: capture.session.owner,
      });
      return await this.serialized(async () => {
        if (this.session !== capture.session)
          throw fail("인증 세션이 변경됐습니다. 화면을 다시 요청하세요.");
        await this.requireOwned();
        return frame;
      });
    } finally {
      if (this.frameCapture === capture) this.frameCapture = null;
    }
  }

  live({ onFrame, onClose = () => {} } = {}) {
    return this.serialized(async () => {
      const session = await this.requireOwned();
      let lease;
      lease = await this.siteBrowser.live({
        owner: session.owner,
        onFrame: async (bytes) => {
          if (this.session === session) await onFrame(bytes);
        },
        onClose: async () => {
          if (session.liveLease === lease) session.liveLease = null;
          await onClose();
        },
      });
      session.liveLease = lease;
      return {
        ...lease,
        validate: () => this.session === session && lease.validate(),
      };
    });
  }

  input(input = {}) {
    return this.serialized(async () => {
      const session = await this.requireOwned();
      const fields = {
        pointer: ["type", "phase", "x", "y"],
        click: ["type", "x", "y"],
        scroll: ["type", "deltaX", "deltaY"],
        key: ["type", "key"],
        text: ["type", "text"],
      };
      exactObject(input, fields[input?.type] || []);
      return {
        ...(await this.siteBrowser.input(input, { owner: session.owner })),
        state: "open",
      };
    });
  }

  apply() {
    return this.serialized(async () => {
      const session = await this.requireOwned();
      const proof = await this.siteBrowser.check({
        reload: false,
        owner: session.owner,
      });
      return this.completeProof(session, proof);
    });
  }

  async completeProof(session, proof) {
      if (this.session !== session) throw fail("인증 세션이 변경됐습니다.");
      if (!proof?.verified) throw fail("회차 본문 확인이 필요합니다.");
      const pendingSlots = await this.pending(session.host);
      if (pendingSlots.length) {
        let status;
        try {
          status = await this.siteBrowser.open({
            ...session,
            slot: pendingSlots[0],
          });
        } catch (error) {
          await this.finish("closed", { host: session.host, pendingSlots });
          throw error;
        }
        return { ...proof, pendingSlots, status: { ...status, state: "open" } };
      }
      await this.finish(
        "completed",
        proof.status ?? { host: session.host, pendingSlots: [] },
      );
      return { ...proof, pendingSlots: [], status: { ...this.lastState } };
  }

  autoStatus() {
    const a = this.automatic;
    return a ? { active: a.active, state: a.state, attempt: a.attempt,
      maxAttempts: 5, stage: a.stage, error: a.error ?? null } : null;
  }

  retry() {
    return this.serialized(async () => {
      if (this.automatic?.active) return { ...this.automatic.status, automatic: this.autoStatus(), state: "automatic" };
      const session = await this.requireOwned();
      if (typeof this.siteBrowser.retryAutomatic !== "function") throw fail("자동 CAPTCHA 모듈을 사용할 수 없습니다.", 503);
      const status = await this.siteBrowser.status({ owner: session.owner });
      const automatic = { active: true, state: "running", attempt: 1, stage: "CREATING",
        status, controller: new AbortController(), error: null, work: null };
      this.automatic = automatic;
      automatic.work = Promise.resolve().then(async () => {
        try {
          await this.siteBrowser.retryAutomatic({ owner: session.owner,
            signal: automatic.controller.signal,
            onProgress: (p) => { if (this.automatic === automatic) Object.assign(automatic, { attempt: p.attempt, stage: p.stage }); },
          });
          if (automatic.controller.signal.aborted || this.session !== session) return;
          const proof = await this.siteBrowser.check({ reload: false, owner: session.owner });
          await this.serialized(() => this.completeProof(session, proof));
          automatic.state = "succeeded";
        } catch {
          automatic.state = automatic.controller.signal.aborted ? "cancelled" : "failed";
          automatic.error = automatic.state === "cancelled" ? "자동 확인이 취소됐습니다." :
            "자동 CAPTCHA 확인을 완료하지 못했습니다. 아래 화면에서 직접 확인할 수 있습니다.";
        } finally { automatic.active = false; }
      });
      return { ...status, automatic: this.autoStatus(), state: "automatic" };
    });
  }

  async finish(state, status = {}) {
    const session = this.session;
    this.session = null;
    this.lastState = {
      ...status,
      open: false,
      slot: null,
      state,
      host: session?.host ?? status.host ?? null,
      pendingSlots: [...(status.pendingSlots ?? [])],
    };
    if (session) {
      await session.liveLease?.close().catch(() => {});
      await this.recovery?.resume(session.host);
    }
  }

  async close() {
    if (this.automatic?.active) {
      this.automatic.controller.abort();
      await this.automatic.work;
    }
    return this.serialized(async () => {
      if (!this.session) return this.ownedState();
      const session = this.session;
      // A mismatched nonce is an error; it never authorizes closing a foreign browser.
      const state = await this.siteBrowser.status({ owner: session.owner });
      if (state.open) await this.siteBrowser.close({ owner: session.owner });
      await this.finish("closed", {
        ...state,
        pendingSlots: await this.pending(session.host),
      });
      return { ...this.lastState };
    });
  }
}
