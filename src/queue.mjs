import { randomBytes, createHash } from "node:crypto";
import { cleanMessage, safeId, validateUrl } from "./store.mjs";
import { loadQueueState, pauseQueue, startQueue } from "./queue-controls.mjs";
import { suspendRequests } from "./queue-backoff.mjs";
import {
  requiresSiteAttention,
  holdJobSite,
  releaseJobSite,
  reserveManualSlot,
  releaseManualSlot,
} from "./queue-site-attention.mjs";
const TERMINAL = new Set([
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
]);
const conflict = (message) =>
  Object.assign(new Error(message), { status: 409 });
const canonicalBookId = (url) =>
  `${url.hostname.replace(/\./g, "_")}-${url.pathname.split("/")[2]}`;
const canonicalChapterId = (url) =>
  createHash("sha256").update(url.href).digest("hex").slice(0, 24);
export class Scheduler {
  constructor({
    store,
    collector,
    collectorFactory,
    intervalMs = 2000,
    maxConcurrency = 2,
    chapterDelayMs = collector.delayMs ?? 1000,
    queuePaused = false,
    backoff = null,
    attention = null,
    onBackoff,
    onSiteAttention,
    onError = ({ jobId, message }) =>
      console.error("[Scheduler]", jobId ?? "service", message),
  }) {
    if (
      !Number.isSafeInteger(maxConcurrency) ||
      maxConcurrency < 1 ||
      maxConcurrency > 2
    )
      throw new Error("동시 수집 수는 1 또는 2여야 합니다.");
    if (
      !Number.isSafeInteger(chapterDelayMs) ||
      chapterDelayMs < 0 ||
      chapterDelayMs > 60000
    )
      throw new Error("회차 간 대기는 0~60000ms여야 합니다.");
    this.store = store;
    this.collector = collector;
    this.collectorFactory = collectorFactory;
    this.onError = onError;
    this.lastError = null;
    this.intervalMs = intervalMs;
    this.maxConcurrency = maxConcurrency;
    this.chapterDelayMs = chapterDelayMs;
    this.queuePaused = queuePaused;
    this.backoff = backoff;
    this.attention = attention;
    this.manualSlots = new Set();
    this.onBackoff = onBackoff;
    this.onSiteAttention = onSiteAttention;
    this.active = new Map();
    this.collectors = new Map();
    this.control = Promise.resolve();
    this.timer = null;
    this.enabled = false;
    this.lease = null;
    this.agents = new Map();
    this.deletions = new Map();
  }
  get activeJobIds() {
    return [...this.active.keys()];
  }
  get currentJobId() {
    return this.activeJobIds[0] ?? null;
  }
  withControl(operation) {
    const next = this.control.catch(() => {}).then(operation);
    this.control = next;
    return next;
  }
  requestTick() {
    if (this.enabled)
      queueMicrotask(() =>
        this.tick().catch((error) => this.recordTaskError(null, error)),
      );
  }
  recordTaskError(jobId, error) {
    const details = {
      jobId,
      message: cleanMessage(error.message),
      time: new Date().toISOString(),
    };
    this.lastError = details;
    try {
      this.onError(details);
    } catch {
      console.error("[Scheduler]", details.jobId ?? "service", details.message);
    }
  }
  async appendJobEvent(jobId, event) {
    try {
      await this.store.appendEvent(jobId, event);
    } catch (error) {
      if (error.status === 404 && !(await this.store.getJob(jobId))) return;
      throw error;
    }
  }
  availableSlot() {
    const occupied = new Set(
      [...this.active.values()]
        .map((entry) => entry.slotId)
        .concat([...this.manualSlots]),
    );
    for (let slotId = 1; slotId <= this.maxConcurrency; slotId++)
      if (!occupied.has(slotId)) return slotId;
    return null;
  }
  collectorForSlot(slotId) {
    if (!this.collectors.has(slotId)) {
      const instance = this.collectorFactory
        ? this.collectorFactory(slotId)
        : this.collector.fork
          ? this.collector.fork(slotId)
          : this.collector;
      if (!instance?.run) throw new Error("수집기 실행 설정이 필요합니다.");
      this.collectors.set(slotId, instance);
    }
    const collector = this.collectors.get(slotId);
    collector.delayMs = this.chapterDelayMs;
    return collector;
  }
  async configure({
    maxConcurrency = this.maxConcurrency,
    chapterDelayMs = this.chapterDelayMs,
  } = {}) {
    if (
      !Number.isSafeInteger(maxConcurrency) ||
      maxConcurrency < 1 ||
      maxConcurrency > 2 ||
      !Number.isSafeInteger(chapterDelayMs) ||
      chapterDelayMs < 0 ||
      chapterDelayMs > 60000
    )
      throw Object.assign(
        new Error("동시 수집은 1~2개, 회차 간 대기는 0~60000ms여야 합니다."),
        { status: 400 },
      );
    return this.withControl(() => {
      this.maxConcurrency = maxConcurrency;
      this.chapterDelayMs = chapterDelayMs;
      this.requestTick();
      return { maxConcurrency, chapterDelayMs };
    });
  }
  async start() {
    return this.withControl(async () => {
      if (this.enabled) return;
      await loadQueueState(this);
      await this.attention?.load();
      for (const job of await this.store.listJobs()) {
        if (!job.deleting) continue;
        await this.store.deleteJob(job.id);
        await this.attention?.forgetJob?.(job.id);
      }
      for (const job of await this.store.listJobs())
        if (job.status === "running")
          await this.store.patchJob(job.id, {
            status: this.queuePaused
              ? "paused"
              : this.attention?.isHeld(new URL(job.url).hostname)
                ? "needs_attention"
                : job.executor === "server"
                  ? "queued"
                  : "needs_attention",
            phase: "서비스 재시작",
            resumeCatalog: true,
            error:
              job.executor === "browser"
                ? "브라우저 연결을 다시 확인하세요."
                : null,
          });
      this.enabled = true;
      this.timer = setInterval(
        () => this.tick().catch((error) => this.recordTaskError(null, error)),
        this.intervalMs,
      );
      this.timer.unref();
      await this.fillSlots();
    });
  }
  async pauseAll() {
    return pauseQueue(this);
  }
  async requestFailed(jobId, error) {
    if (this.attention && requiresSiteAttention(error))
      return holdJobSite(this, jobId, error);
    return suspendRequests(this, jobId, error);
  }
  async releaseSite(host) {
    return releaseJobSite(this, host);
  }
  async reserveManualSlot(slot) {
    return reserveManualSlot(this, slot);
  }
  async releaseManualSlot(slot) {
    return releaseManualSlot(this, slot);
  }
  async startAll() {
    return startQueue(this);
  }
  async stop() {
    return this.withControl(async () => {
      this.enabled = false;
      clearInterval(this.timer);
      this.timer = null;
      const entries = [...this.active.values()];
      for (const entry of entries) {
        await this.store.locked("agent:" + entry.job.id, () =>
          this.store.patchJob(entry.job.id, (job) =>
            job.status === "running"
              ? {
                  status:
                    job.executor === "server" ? "queued" : "needs_attention",
                  phase: "서비스 중지",
                  resumeCatalog: true,
                }
              : null,
          ),
        );
      }
      for (const entry of entries)
        entry.controller?.abort(new Error("서비스 중지"));
      await Promise.allSettled(
        entries.map((entry) => entry.task).filter(Boolean),
      );
      this.active.clear();
      this.lease = null;
      await Promise.all(
        [...new Set([this.collector, ...this.collectors.values()])].map(
          (instance) => instance.close?.(),
        ),
      );
    });
  }
  async nextJob(executor = null) {
    const now = Date.now();
    const works = new Set(
      [...this.active.values()].map((entry) => entry.workId),
    );
    return (await this.store.listJobs()).find(
      (job) =>
        job.status === "queued" &&
        !this.attention?.isHeld(new URL(job.url).hostname) &&
        !this.active.has(job.id) &&
        !works.has(canonicalBookId(new URL(job.url))) &&
        (!executor || job.executor === executor) &&
        (!job.startAt || Date.parse(job.startAt) <= now),
    );
  }
  async tick() {
    return this.withControl(() => this.fillSlots());
  }
  async fillSlots() {
    if (!this.enabled || this.queuePaused) return;
    await this.backoff?.clearAfterExpiry();
    if (this.lease && Date.now() > this.lease.expires) {
      const expiredId = this.lease.jobId;
      await this.store.locked("agent:" + expiredId, async () => {
        if (this.lease?.jobId !== expiredId || Date.now() <= this.lease.expires)
          return;
        await this.store.patchJob(this.lease.jobId, {
          status: "needs_attention",
          phase: "브라우저 연결 끊김",
          error: "브라우저 워커가 90초 동안 응답하지 않았습니다.",
        });
        this.active.delete(expiredId);
        this.lease = null;
      });
    }
    while (this.active.size < this.maxConcurrency) {
      if (this.backoff?.snapshot().active) break;
      const job = await this.nextJob("server");
      if (!job || this.backoff?.snapshot().active) break;
      const slotId = this.availableSlot();
      if (slotId === null) break;
      const entry = {
        job,
        slotId,
        workId: canonicalBookId(new URL(job.url)),
        controller: new AbortController(),
        collector: this.collectorForSlot(slotId),
        task: null,
      };
      this.active.set(job.id, entry);
      let next;
      try {
        next = await this.store.patchJob(job.id, {
          status: "running",
          phase: "시작",
          captcha: null,
          currentChapterId: null,
          currentChapter: null,
          error: null,
          lastActivity: new Date().toISOString(),
        });
      } catch (error) {
        if (this.active.get(job.id) === entry) this.active.delete(job.id);
        throw error;
      }
      entry.task = this.run(next, entry).catch((error) =>
        this.recordTaskError(job.id, error),
      );
    }
  }
  async run(job, entry) {
    const signal = entry.controller.signal;
    try {
      const patch =
        (await entry.collector.run(
          job,
          {
            report: async (patch) => {
              const { exports, ...progress } = patch;
              await this.store.patchJob(job.id, (current) =>
                current.status === "running" && !signal.aborted
                  ? {
                      ...progress,
                      status: "running",
                      lastActivity: new Date().toISOString(),
                    }
                  : null,
              );
            },
            event: (level, message) =>
              this.appendJobEvent(job.id, { level, message }),
            requestFailure: (error) => this.requestFailed(job.id, error),
            requestSuccess: () => this.backoff?.success(),
          },
          signal,
        )) ?? {};
      const current = await this.store.getJob(job.id);
      if (current?.status === "running" && !signal.aborted) {
        const { exports, ...result } = patch;
        const failed = patch.failed ?? current.failed;
        const saved =
          (patch.completed ?? current.completed) +
          (patch.skipped ?? current.skipped);
        const status = [
          "completed",
          "completed_with_errors",
          "failed",
          "needs_attention",
        ].includes(patch.status)
          ? patch.status
          : failed > 0
            ? saved > 0
              ? "completed_with_errors"
              : "failed"
            : "completed";
        await this.store.patchJob(job.id, (latest) =>
          latest.status === "running" && !signal.aborted
            ? {
                ...result,
                status,
                phase:
                  status === "needs_attention"
                    ? "사이트 인증 필요"
                    : status === "failed"
                      ? "수집 실패"
                      : "완료",
                currentChapter: null,
                lastActivity: new Date().toISOString(),
              }
            : null,
        );
      }
    } catch (error) {
      const current = await this.store.getJob(job.id);
      if (current?.status === "running" && !signal.aborted) {
        try {
          await this.requestFailed(job.id, error);
        } catch (backoffError) {
          this.recordTaskError(job.id, backoffError);
        }
        if (signal.aborted) return;
        const message = cleanMessage(error.message);
        await this.store.patchJob(job.id, (latest) =>
          latest.status === "running" && !signal.aborted
            ? {
                status:
                  error.code === "NEEDS_ATTENTION"
                    ? "needs_attention"
                    : "failed",
                phase: "중지",
                error: message,
              }
            : null,
        );
        await this.appendJobEvent(job.id, { level: "error", message });
      }
    } finally {
      try {
        await entry.collector.close?.();
      } finally {
        if (entry.collector.availability)
          this.collector.availability = { ...entry.collector.availability };
        if (this.active.get(job.id) === entry) this.active.delete(job.id);
        this.requestTick();
      }
    }
  }
  async action(id, action, options = {}) {
    return this.withControl(() =>
      this.store.locked("agent:" + safeId(id), async () => {
        safeId(id);
        const job = await this.store.getJob(id);
        if (!job)
          throw Object.assign(new Error("작업을 찾을 수 없습니다."), {
            status: 404,
          });
        if (job.deleting || this.deletions.has(id)) throw conflict("삭제 중인 예약은 변경할 수 없습니다.");
        if (
          !["pause", "resume", "cancel", "retry", "retry_failed"].includes(
            action,
          )
        )
          throw Object.assign(new Error("지원하지 않는 작업입니다."), {
            status: 400,
          });
        let status;
        if (action === "pause") {
          if (!["running", "queued"].includes(job.status))
            throw conflict("현재 작업은 일시정지할 수 없습니다.");
          status = "paused";
        }
        if (action === "cancel") {
          if (TERMINAL.has(job.status))
            throw conflict("이미 종료된 작업입니다.");
          status = "cancelled";
        }
        if (action === "resume") {
          if (!["paused", "needs_attention"].includes(job.status))
            throw conflict("현재 작업은 재개할 수 없습니다.");
          status = "queued";
        }
        if (action === "retry" || action === "retry_failed") {
          if (!TERMINAL.has(job.status) && job.status !== "needs_attention")
            throw conflict("현재 작업은 재시도할 수 없습니다.");
          status = "queued";
        }
        let retryPatch = {};
        if (action === "retry_failed") {
          const selected = options.chapterIds ?? null;
          if (
            selected !== null &&
            (!Array.isArray(selected) ||
              !selected.length ||
              selected.length > 10000)
          )
            throw Object.assign(
              new Error("재시도할 회차 목록이 올바르지 않습니다."),
              { status: 400 },
            );
          if (selected) selected.forEach(safeId);
          retryPatch = {
            retryOnlyFailed: true,
            retryChapterIds: selected ? [...new Set(selected)] : null,
            overwrite: false,
            backoffResumeChapterId: null,
          };
        } else if (action === "retry")
          retryPatch = {
            retryOnlyFailed: false,
            retryChapterIds: null,
            backoffResumeChapterId: null,
          };
        const next = await this.store.patchJob(id, {
          ...retryPatch,
          status,
          phase:
            status === "queued"
              ? "대기"
              : status === "paused"
                ? "일시정지"
                : "취소",
          error: null,
          resumeCatalog: action === "resume" || action === "retry_failed",
          estimatedSecondsRemaining: null,
          estimatedCompletionAt: null,
          lastActivity: new Date().toISOString(),
        });
        const entry = this.active.get(id);
        if (entry) {
          entry.controller?.abort(new Error(action));
          if (this.lease?.jobId === id) {
            this.lease = null;
            this.active.delete(id);
          }
        }
        this.requestTick();
        return next;
      }),
    );
  }
  browserAgents() {
    return [...this.agents]
      .filter(([, time]) => Date.now() - time < 90000)
      .map(([clientId, lastSeen]) => ({
        clientId,
        lastSeen: new Date(lastSeen).toISOString(),
      }));
  }

  async deleteJob(id, { waitMs = 1500 } = {}) {
    safeId(id);
    let record = this.deletions.get(id);
    if (!record) {
      record = {};
      this.deletions.set(id, record);
      record.work = Promise.resolve().then(async () => {
        let task;
        await this.withControl(async () => {
          const job = await this.store.getJob(id);
          if (!job) throw Object.assign(new Error("작업을 찾을 수 없습니다."), { status: 404 });
          const entry = this.active.get(id);
          task = entry?.task;
          await this.store.patchJob(id, {
            status: TERMINAL.has(job.status) ? job.status : "cancelled",
            phase: "예약 삭제 중", deleting: true, captcha: null,
            estimatedSecondsRemaining: null, estimatedCompletionAt: null,
          });
          entry?.controller?.abort(new Error("예약 삭제"));
          if (this.lease?.jobId === id) { this.lease = null; this.active.delete(id); }
        });
        // Worker cleanup may itself need the scheduler control queue. Never
        // wait for it while holding that queue, and never archive a live writer.
        await task;
        const result = await this.withControl(() => this.store.locked("agent:" + id, async () => {
          const deleted = await this.store.deleteJob(id);
          await this.attention?.forgetJob?.(id);
          return deleted;
        }));
        this.requestTick();
        return result;
      });
      record.work.then(() => this.deletions.delete(id), async (error) => {
        this.recordTaskError(id, error);
        try {
          if (await this.store.getJob(id)) await this.store.patchJob(id, { deleting: false, phase: "예약 삭제 실패" });
        } catch {}
        this.deletions.delete(id);
      });
    }
    let timer;
    try {
      return await Promise.race([record.work, new Promise(resolve => {
        timer = setTimeout(() => resolve({ deleted: false, pending: true }), waitMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  async claim(clientId) {
    safeId(clientId);
    this.agents.set(clientId, Date.now());
    return this.withControl(async () => {
      await this.backoff?.clearAfterExpiry();
      if (
        this.queuePaused ||
        this.backoff?.snapshot().active ||
        this.active.size >= this.maxConcurrency ||
        this.lease
      )
        return { job: null };
      const job = await this.nextJob("browser");
      if (!job || this.backoff?.snapshot().active) return { job: null };
      const slotId = this.availableSlot();
      if (slotId === null) return { job: null };
      this.lease = {
        jobId: job.id,
        clientId,
        token: randomBytes(32).toString("hex"),
        expires: Date.now() + 90000,
        catalog: null,
      };
      this.active.set(job.id, {
        job,
        slotId,
        workId: canonicalBookId(new URL(job.url)),
        type: "browser",
      });
      let next;
      try {
        next = await this.store.patchJob(job.id, {
          status: "running",
          phase: "브라우저 연결",
          currentChapterId: null,
          currentChapter: null,
          error: null,
          lastActivity: new Date().toISOString(),
        });
      } catch (error) {
        if (this.lease?.jobId === job.id) this.lease = null;
        this.active.delete(job.id);
        throw error;
      }
      return { job: next, leaseToken: this.lease.token };
    });
  }
  verifyLease(id, clientId, token) {
    if (
      !this.lease ||
      this.lease.jobId !== id ||
      this.lease.clientId !== clientId ||
      this.lease.token !== token ||
      Date.now() > this.lease.expires
    )
      throw conflict("브라우저 작업 임대가 만료되었거나 일치하지 않습니다.");
    this.lease.expires = Date.now() + 90000;
    this.agents.set(clientId, Date.now());
    return this.lease;
  }
  async agentOperation(id, operation, body, token) {
    return this.store.locked("agent:" + safeId(id), () =>
      this.performAgentOperation(id, operation, body, token),
    );
  }
  async performAgentOperation(id, operation, body, token) {
    const lease = this.verifyLease(id, body.clientId, token);
    const job = await this.store.getJob(id);
    if (job.status !== "running") throw conflict("실행 중인 작업이 아닙니다.");
    if (operation === "heartbeat") {
      const next = await this.store.patchJob(id, {
        phase: String(body.phase ?? "브라우저 수집 중").slice(0, 200),
        lastActivity: new Date().toISOString(),
      });
      return { job: next, status: next.status };
    }
    if (operation === "catalog") {
      safeId(body.bookId);
      if (
        !Array.isArray(body.chapters) ||
        !body.chapters.length ||
        body.chapters.length > 10000
      )
        throw Object.assign(new Error("잘못된 회차 목록입니다."), {
          status: 400,
        });
      const bookUrl = new URL(job.url);
      if (body.bookId !== canonicalBookId(bookUrl))
        throw conflict("작품 ID가 작업과 다릅니다.");
      const chapters = body.chapters
        .map((item) => {
          safeId(item.id);
          const url = validateUrl(item.url),
            parsed = new URL(url);
          parsed.search = "";
          const path = parsed.pathname.split("/");
          const belongs = path[3]
            ? path[2] === bookUrl.pathname.split("/")[2]
            : path[2] !== bookUrl.pathname.split("/")[2];
          if (
            parsed.hostname !== bookUrl.hostname ||
            !belongs ||
            canonicalChapterId(parsed) !== item.id ||
            !Number.isSafeInteger(item.number) ||
            item.number < 0
          )
            throw conflict("회차 URL 또는 번호가 작업과 다릅니다.");
          return {
            id: item.id,
            number: item.number,
            title: String(item.title ?? "").slice(0, 500),
            url: parsed.href,
          };
        })
        .filter(
          (c) =>
            (job.startEpisode === null || c.number >= job.startEpisode) &&
            (job.endEpisode === null || c.number <= job.endEpisode),
        );
      if (!chapters.length)
        throw conflict("회차 범위에 해당하는 목차가 없습니다.");
      if (new Set(chapters.map((c) => c.id)).size !== chapters.length)
        throw conflict("중복 회차 ID입니다.");
      lease.catalog = chapters;
      await this.store.upsertBook(body.bookId, {
        title: String(body.title ?? "").slice(0, 500),
        url: job.url,
      });
      const existingChapterIds = job.overwrite
        ? []
        : (await this.store.listChapters(body.bookId))
            .filter((c) => chapters.some((item) => item.id === c.id))
            .map((c) => c.id);
      await this.store.patchJob(id, {
        bookId: body.bookId,
        title: String(body.title ?? job.title).slice(0, 500),
        total: chapters.length,
        completed: 0,
        skipped: existingChapterIds.length,
        failed: 0,
        lastActivity: new Date().toISOString(),
      });
      lease.saved = new Set(existingChapterIds);
      return { chapters, existingChapterIds };
    }
    if (operation === "chapter") {
      const entry = lease.catalog?.find((item) => item.id === body.id);
      if (!entry) throw conflict("목차에 없는 회차입니다.");
      if (lease.saved.has(entry.id)) return { saved: true };
      if (
        typeof body.text !== "string" ||
        Buffer.byteLength(body.text) > 1500000
      )
        throw Object.assign(new Error("본문 크기가 올바르지 않습니다."), {
          status: 400,
        });
      await this.store.writeChapter(job.bookId, entry.id, {
        ...entry,
        text: body.text,
      });
      lease.saved.add(entry.id);
      await this.store.patchJob(id, {
        completed: lease.saved.size - job.skipped,
        currentChapter: entry.title,
        lastActivity: new Date().toISOString(),
      });
      return { saved: true };
    }
    if (operation === "finish") {
      let status = body.needsAttention
        ? "needs_attention"
        : body.error
          ? "failed"
          : "completed";
      if (
        !body.error &&
        !body.needsAttention &&
        (!lease.catalog || lease.saved.size !== lease.catalog.length)
      )
        throw conflict("저장하지 않은 회차가 남았습니다.");
      if (status === "completed") {
        const chapters = await Promise.all(
          lease.catalog.map((c) => this.store.readChapter(job.bookId, c.id)),
        );
        if (job.format === "epub") {
          if (!this.collector.exportBook)
            throw conflict("EPUB 생성기를 사용할 수 없습니다.");
          await this.collector.exportBook(job, chapters);
        } else
          await this.store.writeExport(
            id,
            "txt",
            Buffer.from(
              chapters
                .map((c) => `${c.number}. ${c.title}\n\n${c.text}`)
                .join("\n\n"),
            ),
            (job.title || job.bookId) + ".txt",
          );
      }
      const next = await this.store.patchJob(id, {
        status,
        phase: status === "completed" ? "완료" : "중지",
        error: body.error
          ? cleanMessage(body.error)
          : body.needsAttention
            ? "사이트 확인이 필요합니다."
            : null,
        currentChapter: null,
        lastActivity: new Date().toISOString(),
      });
      this.lease = null;
      this.active.delete(id);
      this.requestTick();
      return next;
    }
    throw Object.assign(new Error("지원하지 않는 워커 작업입니다."), {
      status: 404,
    });
  }
}
