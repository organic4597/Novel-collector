export function collectionNetworkPaused(scheduler) {
  return !!scheduler.network?.enabled &&
    scheduler.network.snapshot?.().active !== false;
}

// Caller owns scheduler.control; this also supports the mid-start race in fillSlots.
export async function holdCollectionNetwork(scheduler) {
  let affected = 0;
  for (const [id, entry] of scheduler.active) {
    let held = false;
    const browser = entry.type === "browser";
    await scheduler.store.locked("agent:" + id, async () => {
      const current = await scheduler.store.getJob(id);
      if (current?.status !== "running") return;
      await scheduler.store.patchJob(id, job => {
        if (job.status !== "running") return null;
        held = true;
        return {
          status: browser ? "needs_attention" : "queued",
          phase: "테더링 연결 대기",
          error: null,
          resumeCatalog: true,
          backoffResumeChapterId: job.currentChapterId ?? job.backoffResumeChapterId ?? null,
          estimatedSecondsRemaining: null,
          estimatedCompletionAt: null,
        };
      });
    });
    if (!held) continue;
    ++affected;
    if (browser) {
      if (scheduler.lease?.jobId === id) scheduler.lease = null;
      scheduler.active.delete(id);
    } else {
      entry.controller?.abort(Object.assign(
        Error("테더링 연결이 복구될 때까지 수집을 기다립니다."),
        { code: "COLLECTION_NETWORK_PAUSED" },
      ));
    }
  }
  return { paused: true, affected };
}
