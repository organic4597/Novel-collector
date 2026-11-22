import { randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export async function pauseBetweenChapters(signal, onWait = () => {}, { choose = randomInt, wait = sleep } = {}) {
  signal?.throwIfAborted();
  const seconds = choose(10, 61);
  await onWait(seconds);
  await wait(seconds * 1000, undefined, { signal });
}
