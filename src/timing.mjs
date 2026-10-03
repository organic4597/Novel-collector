export class ChapterTiming {
  constructor({ clock = () => Date.now(), windowSize = 20 } = {}) {
    this.clock = clock;
    this.windowSize = windowSize;
    this.samples = [];
  }
  record(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.samples = [...this.samples, durationMs].slice(-this.windowSize);
  }
  estimate(remainingAttempts) {
    const samples = this.samples.length;
    const meanChapterMs = samples
      ? this.samples.reduce((sum, value) => sum + value, 0) / samples
      : null;
    const confidence =
      samples >= 10
        ? "high"
        : samples >= 5
          ? "medium"
          : samples
            ? "low"
            : "unknown";
    const estimatedSecondsRemaining =
      remainingAttempts === 0
        ? 0
        : samples
          ? Math.ceil((meanChapterMs * remainingAttempts) / 1000)
          : null;
    return {
      estimatedSecondsRemaining,
      estimatedCompletionAt:
        estimatedSecondsRemaining === null
          ? null
          : new Date(
              this.clock() + estimatedSecondsRemaining * 1000,
            ).toISOString(),
      timing: { samples, meanChapterMs, confidence },
    };
  }
}
