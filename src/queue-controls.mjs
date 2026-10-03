export async function loadQueueState(scheduler) {
  const saved = await scheduler.store.json(
    scheduler.store.path("queue-state.json"),
  );
  if (saved && typeof saved.paused === "boolean")
    scheduler.queuePaused = saved.paused;
}

async function persistPause(scheduler, paused) {
  await scheduler.store.atomic(scheduler.store.path("queue-state.json"), {
    paused,
  });
  scheduler.queuePaused = paused;
}

export async function pauseQueue(scheduler) {
  const { result, tasks } = await scheduler.withControl(async () => {
    await persistPause(scheduler, true);
    const entries = [...scheduler.active.values()];
    for (const entry of entries)
      entry.controller?.abort(new Error("전체 수집 일시정지"));
    const browserId = scheduler.lease?.jobId;
    scheduler.lease = null;
    let affected = 0;
    for (const job of await scheduler.store.listJobs()) {
      if (!["queued", "running"].includes(job.status)) continue;
      await scheduler.store.locked("agent:" + job.id, async () => {
        let changed = false;
        await scheduler.store.patchJob(job.id, (current) => {
          if (!["queued", "running"].includes(current.status)) return null;
          changed = true;
          return {
            status: "paused",
            phase: "전체 일시정지",
            estimatedSecondsRemaining: null,
            estimatedCompletionAt: null,
          };
        });
        if (changed) affected++;
      });
    }
    if (browserId) scheduler.active.delete(browserId);
    return {
      result: {
        paused: true,
        affected,
        maxConcurrency: scheduler.maxConcurrency,
      },
      tasks: entries.map((entry) => entry.task).filter(Boolean),
    };
  });
  await Promise.allSettled(tasks);
  return result;
}

export async function startQueue(scheduler) {
  return scheduler.withControl(async () => {
    await persistPause(scheduler, false);
    let affected = 0;
    for (const job of await scheduler.store.listJobs()) {
      if (job.status !== "paused") continue;
      await scheduler.store.patchJob(job.id, (current) =>
        current.status === "paused"
          ? {
              status: "queued",
              phase: "대기",
              estimatedSecondsRemaining: null,
              estimatedCompletionAt: null,
            }
          : null,
      );
      affected++;
    }
    await scheduler.fillSlots();
    return {
      paused: false,
      affected,
      maxConcurrency: scheduler.maxConcurrency,
    };
  });
}
