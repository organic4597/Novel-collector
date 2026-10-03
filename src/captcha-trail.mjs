import { CaptchaError } from "./novel-captcha.mjs";

export const TRAIL_MIN_MS = 1800;
export const TRAIL_MAX_MS = 4500;
export const TRAIL_TARGET_MS = 2400;

// Validate real client-recorded samples. Never synthesize a server trail here.
export function validateTrail(body, challenge, answer) {
  const points = body?.trail;
  if (body?.challengeId !== challenge.challengeId || body.x !== answer.x || body.y !== challenge.y ||
      !Array.isArray(points) || points.length < 2 || points.length > 2048)
    throw new CaptchaError("TRAIL_INVALID");
  let previous = -1;
  for (const point of points) {
    if (!point || ![point.x, point.y, point.t].every(Number.isFinite) ||
        point.x < 0 || point.x > challenge.width - challenge.pieceWidth ||
        point.t < previous || point.t < 0)
      throw new CaptchaError("TRAIL_INVALID");
    previous = point.t;
  }
  if (points[0].t !== 0 || Math.round(points.at(-1).x) !== answer.x)
    throw new CaptchaError("TRAIL_INVALID");
  if (previous < TRAIL_MIN_MS || previous > TRAIL_MAX_MS)
    throw new CaptchaError("TRAIL_DURATION_OUT_OF_RANGE");
  return points;
}
