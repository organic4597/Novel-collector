// The coordinator owns one challenge, never a content request or its proof.
export const CAPTCHA_REQUIRED = "captcha_required_daily_quota";
export const CAPTCHA_STATES = Object.freeze([
  "IDLE", "CREATING", "ANALYZING", "VERIFYING", "SUCCEEDED", "FAILED",
]);

export class CaptchaError extends Error {
  constructor(code, serverError = null) {
    super(code);
    this.name = "CaptchaError";
    this.code = code;
    // Retain only the server's error identifier, never its response/debug data.
    if (typeof serverError === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(serverError))
      this.serverError = serverError;
  }
}

export function captchaRequired(event) {
  return event?.source === "response"
    ? event.error === CAPTCHA_REQUIRED
    : event?.source === "ui" && event.responseObservable === false && event.visible === true;
}

export function parseChallenge(body, receivedAt = Date.now()) {
  const c = body?.challenge;
  const dimension = (n) => Number.isSafeInteger(n) && n > 0 && n <= 2048;
  const image = (s) => typeof s === "string" && s.length <= 3 * 1024 * 1024 &&
    /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(s);
  if (!Number.isFinite(receivedAt) || receivedAt < 0 || body?.ok !== true || !c || typeof c.challengeId !== "string" ||
      !/^[\w-]{1,200}$/.test(c.challengeId) || !image(c.background) ||
      (c.piece != null && !image(c.piece)) ||
      ![c.width, c.height, c.pieceWidth, c.pieceHeight].every(dimension) ||
      c.pieceWidth >= c.width || c.pieceHeight > c.height ||
      !Number.isSafeInteger(c.y) || c.y < 0 || c.y + c.pieceHeight > c.height)
    throw new CaptchaError("CREATE_INVALID_RESPONSE");
  return Object.freeze({
    challengeId: c.challengeId, background: c.background, piece: c.piece ?? null,
    width: c.width, height: c.height, pieceWidth: c.pieceWidth,
    pieceHeight: c.pieceHeight, y: c.y, receivedAt,
    tier: Object.freeze(Object.fromEntries(
      ["from", "passViews", "difficulty", "tolerance"]
        .filter((key) => Number.isFinite(c.tier?.[key]))
        .map((key) => [key, c.tier[key]]),
    )),
  });
}

export function verifyResult(reply, challengeId) {
  if (reply?.challengeId !== challengeId)
    throw new CaptchaError("VERIFY_RESULT_UNKNOWN");
  const body = reply.body;
  if (!Number.isInteger(reply.status) || reply.status < 200 || reply.status >= 300 || body?.ok !== true)
    throw new CaptchaError("VERIFY_REJECTED", body?.error);
  if (typeof body.token !== "string" || !body.token.trim() || body.token.length > 4096)
    throw new CaptchaError("VERIFY_INVALID_RESPONSE");
  return {
    captchaToken: body.token,
    remaining: Number.isSafeInteger(body.remaining) && body.remaining >= 0 ? body.remaining : null,
  };
}

export function abortable(work, signal) {
  if (signal?.aborted) return Promise.reject(new CaptchaError("CANCELLED"));
  if (!signal) return Promise.resolve(work);
  return new Promise((resolve, reject) => {
    const abort = () => reject(new CaptchaError("CANCELLED"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class NovelCaptcha {
  constructor({ analyze, timeoutMs = 20000, maxChallengeAgeMs = 60000, clock = Date.now, log = () => {} }) {
    if (typeof analyze !== "function" || !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
        !Number.isFinite(maxChallengeAgeMs) || maxChallengeAgeMs <= 0)
      throw new TypeError("Invalid CAPTCHA coordinator options");
    Object.assign(this, { analyze, timeoutMs, maxChallengeAgeMs, clock, log });
    this.sessions = new WeakMap();
  }

  state(session) { return this.sessions.get(session)?.state ?? "IDLE"; }

  async handle(input) {
    const { session, requestId, event, isCurrent = () => true, signal } = input;
    if (!captchaRequired(event)) return { ok: false, skipped: true };
    if (!session || typeof session !== "object" || typeof session.key !== "string" ||
        !session.key || typeof requestId !== "string" || !requestId)
      throw new TypeError("A current session and request identifier are required");
    const sessionKey = session.key;
    let record = this.sessions.get(session);
    if (!record?.flight) {
      record = { state: "IDLE", flight: null };
      this.sessions.set(session, record);
      // Publish the flight before calling any injected operation (including synchronous ones).
      record.flight = Promise.resolve().then(() => this.run({ ...input, sessionKey }, record));
      record.flight.finally(() => { record.flight = null; });
    }
    let result;
    try {
      result = await abortable(record.flight, signal);
      if (!isCurrent() || session.key !== sessionKey) throw new CaptchaError("CONTEXT_CHANGED");
    } catch (error) {
      result = { ok: false, error: { code: error instanceof CaptchaError ? error.code : "CONTEXT_CHANGED" } };
    }
    return { ...result, requestId, sessionKey };
  }

  async run(input, record) {
    const started = this.clock();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    const signal = controller.signal;
    const check = () => {
      if (signal.aborted) throw new CaptchaError("CANCELLED");
      if (input.session.key !== input.sessionKey) throw new CaptchaError("CONTEXT_CHANGED");
      if (input.isCurrent && !input.isCurrent()) throw new CaptchaError("CONTEXT_CHANGED");
    };
    const stage = (state, details = {}) => {
      record.state = state;
      const event = { stage: state, elapsedMs: Math.max(0, this.clock() - started), ...details };
      try { this.log(event); } catch {}
      try { Promise.resolve(input.onProgress?.(event)).catch(() => {}); } catch {}
    };
    try {
      check();
      stage("CREATING");
      const created = await abortable(input.create({ signal }), signal);
      check();
      if (created?.error instanceof CaptchaError) throw created.error;
      if (!created || typeof created !== "object") throw new CaptchaError("CREATE_INVALID_RESPONSE");
      const challenge = parseChallenge(created.body, created.receivedAt ?? this.clock());
      if (!Number.isInteger(created.status) || created.status < 200 || created.status >= 300)
        throw new CaptchaError("CREATE_INVALID_RESPONSE");
      stage("ANALYZING");
      const position = await abortable(this.analyze(challenge, { signal }), signal);
      check();
      if (this.clock() - challenge.receivedAt > this.maxChallengeAgeMs)
        throw new CaptchaError("CHALLENGE_EXPIRED");
      if (position?.challengeId !== challenge.challengeId || position?.decision !== "accept" ||
          !Number.isFinite(position.targetX) || position.targetX < 0 ||
          position.targetX > challenge.width - challenge.pieceWidth || position.targetY !== challenge.y ||
          !Number.isFinite(position.matchScore) || !Number.isFinite(position.candidateMargin))
        throw new CaptchaError("POSITION_UNCERTAIN");
      const answer = Object.freeze({ ...position, x: Math.round(position.targetX), y: challenge.y });
      stage("VERIFYING", { x: answer.x, y: answer.y });
      const reply = await abortable(input.verify(challenge, answer, { signal }), signal);
      check();
      const grant = verifyResult(reply, challenge.challengeId);
      stage("SUCCEEDED");
      return { ok: true, ...grant };
    } catch (error) {
      const code = timedOut
        ? (record.state === "VERIFYING" ? "VERIFY_RESULT_UNKNOWN" : "CAPTCHA_TIMEOUT")
        : error instanceof CaptchaError ? error.code
        : record.state === "VERIFYING" ? "VERIFY_RESULT_UNKNOWN"
        : record.state === "CREATING" ? "CREATE_INVALID_RESPONSE" : "ANALYSIS_FAILED";
      stage("FAILED", { code });
      return { ok: false, error: { code, ...(error instanceof CaptchaError && error.serverError ? { serverError: error.serverError } : {}) } };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  }
}
