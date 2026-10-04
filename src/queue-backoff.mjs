export async function suspendRequests(scheduler, jobId, error) {
  if (!scheduler.backoff) return null;
  if (
    error.name === "AbortError" ||
    ["EPERM", "EACCES", "EBUSY", "ENOSPC", "EIO", "ENOENT", "ABORTED"].includes(
      error.code,
    )
  )
    return null;
  const rateLimited =
    error.httpStatus === 429 ||
    error.status === 429 ||
    /\bHTTP[_\s-]*429\b|too many requests/i.test(error.message || "");
  const result = await scheduler.backoff.failure({
    retryAfterMs: rateLimited
      ? Math.max(600000, error.retryAfterMs || 0)
      : error.retryAfterMs,
    reason: error.message,
    jobId,
  });
  if (!result.triggered) return result;
  const protectedSelf = error.code === "NEEDS_ATTENTION" && !rateLimited;
  await scheduler.withControl(async () => {
    for (const [id, entry] of scheduler.active) {
      if (id === jobId && protectedSelf) continue;
      const current = await scheduler.store.getJob(id);
      if (current?.status !== "running") continue;
      const browser = entry.type === "browser";
      await scheduler.store.locked("agent:" + id, () =>
        scheduler.store.patchJob(id, (job) =>
          job.status === "running"
            ? {
                status: browser ? "needs_attention" : "queued",
                phase: "서버 요청 제한 대기",
                estimatedSecondsRemaining: null,
                estimatedCompletionAt: null,
                backoffResumeChapterId:
                  job.currentChapterId ?? job.backoffResumeChapterId ?? null,
              }
            : null,
        ),
      );
      if (browser) {
        if (scheduler.lease?.jobId === id) scheduler.lease = null;
        scheduler.active.delete(id);
      } else {
        entry.controller.abort(
          Object.assign(new Error("서버가 안내한 요청 제한으로 대기합니다."), {
            code: "AUTO_BACKOFF",
          }),
        );
      }
    }
  });
  if (scheduler.onBackoff) {
    try {
      await scheduler.onBackoff(scheduler.backoff.snapshot());
    } catch (callbackError) {
      scheduler.recordTaskError(null, callbackError);
    }
  }
  return result;
}
