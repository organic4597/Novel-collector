import { validateUrl } from "./store.mjs";
const conflict = (message) =>
  Object.assign(new Error(message), { status: 409 });
export function requiresSiteAttention(error) {
  return (
    error.code === "NEEDS_ATTENTION" &&
    ["authentication", "captcha", "site_blocked"].includes(
      error.attentionKind,
    ) &&
    error.httpStatus !== 429 &&
    error.status !== 429 &&
    !(error.retryAfterMs > 0) &&
    !/\bHTTP[_\s-]*429\b/i.test(error.message || "")
  );
}
export async function holdJobSite(scheduler, jobId, error) {
  if (!scheduler.attention) return null;
  const state = await scheduler.withControl(async () => {
    const triggering = jobId ? await scheduler.store.getJob(jobId) : null;
    if (!triggering && !error.siteHost) return null;
    const host = triggering
      ? new URL(triggering.url).hostname
      : new URL(validateUrl(`https://${error.siteHost}/novel/1`)).hostname;
    const entries = [...scheduler.active].filter(
      ([, entry]) => new URL(entry.job.url).hostname === host,
    );
    const requiredSlots = entries.map(([, entry]) => entry.slotId);
    const queued = (await scheduler.store.listJobs()).filter(
      (job) => job.status === "queued" && new URL(job.url).hostname === host,
    );
    const state = await scheduler.attention.holdSite(host, {
      reason: error.message,
      kind: error.attentionKind,
      jobIds: [...entries.map(([id]) => id), ...queued.map((job) => job.id)],
      requiredSlots: requiredSlots.length
        ? requiredSlots
        : [triggering?.verificationSlotId ?? 1],
    });
    for (const [id, entry] of entries) {
      await scheduler.store.locked("agent:" + id, () =>
        scheduler.store.patchJob(id, (job) =>
          job.status === "running"
            ? {
                status: "needs_attention",
                phase: "사이트 인증 필요",
                error: state.reason,
                verificationSlotId: entry.slotId,
                backoffResumeChapterId:
                  job.currentChapterId ?? job.backoffResumeChapterId ?? null,
                estimatedSecondsRemaining: null,
                estimatedCompletionAt: null,
              }
            : null,
        ),
      );
      if (entry.type === "browser") {
        if (scheduler.lease?.jobId === id) scheduler.lease = null;
        scheduler.active.delete(id);
      } else
        entry.controller.abort(
          Object.assign(new Error("사이트 인증이 필요합니다."), {
            code: "SITE_ATTENTION",
          }),
        );
    }
    for (const job of queued) {
      await scheduler.store.patchJob(job.id, (current) =>
        current.status === "queued"
          ? {
              status: "needs_attention",
              phase: "사이트 인증 필요",
              error: state.reason,
              verificationSlotId: state.requiredSlots[0],
              estimatedSecondsRemaining: null,
              estimatedCompletionAt: null,
            }
          : null,
      );
    }
    scheduler.requestTick();
    return state;
  });
  if (state && scheduler.onSiteAttention) {
    try {
      await scheduler.onSiteAttention(state);
    } catch (callbackError) {
      scheduler.recordTaskError(null, callbackError);
    }
  }
  return state;
}
export async function releaseJobSite(scheduler, host) {
  return scheduler.withControl(async () => {
    const state = scheduler.attention?.get(host);
    if (!state)
      throw Object.assign(new Error("인증 대기 사이트를 찾을 수 없습니다."), {
        status: 404,
      });
    if (
      state.held ||
      !state.requiredSlots.every((slot) => state.verifiedSlots.includes(slot))
    )
      throw conflict("필요한 모든 세션의 인증을 먼저 확인하세요.");
    let affected = 0;
    for (const id of state.jobIds) {
      const job = await scheduler.store.getJob(id);
      if (job?.status !== "needs_attention") continue;
      await scheduler.store.patchJob(id, (current) =>
        current.status === "needs_attention"
          ? { status: "queued", phase: "인증 확인 완료 · 대기", error: null, resumeCatalog: true }
          : null,
      );
      affected++;
    }
    await scheduler.fillSlots();
    return { host: state.host, released: true, affected };
  });
}
export async function reserveManualSlot(scheduler, slot) {
  return scheduler.withControl(() => {
    if (![1, 2].includes(slot))
      throw Object.assign(new Error("인증 슬롯은 1 또는 2여야 합니다."), {
        status: 400,
      });
    if (
      scheduler.manualSlots.has(slot) ||
      [...scheduler.active.values()].some((entry) => entry.slotId === slot)
    )
      throw conflict("해당 브라우저 슬롯은 사용 중입니다.");
    scheduler.manualSlots.add(slot);
    return { slotId: slot, reserved: true };
  });
}
export async function releaseManualSlot(scheduler, slot) {
  return scheduler.withControl(() => {
    if (![1, 2].includes(slot))
      throw Object.assign(new Error("인증 슬롯은 1 또는 2여야 합니다."), {
        status: 400,
      });
    scheduler.manualSlots.delete(slot);
    scheduler.requestTick();
    return { slotId: slot, reserved: false };
  });
}
