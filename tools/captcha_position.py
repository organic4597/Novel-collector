"""Offline, bounded PNG analysis. stdin JSON -> stdout JSON; no network or secrets.

Coordinates stay in original image pixels. Scores are similarity measures, not
probabilities. Without an explicitly evaluated acceptance profile, always abstain.
"""
import argparse
import base64
import json
import math
import struct
import sys

import cv2
import numpy as np


class AnalysisError(Exception):
    pass


def decode(data_url, width, height):
    try:
        if not isinstance(data_url, str) or not data_url.startswith("data:image/png;base64,"):
            raise ValueError()
        raw = base64.b64decode(data_url.split(",", 1)[1], validate=True)
        # Check the header before asking the decoder to allocate an image.
        if len(raw) > 2 * 1024 * 1024 or raw[:8] != b"\x89PNG\r\n\x1a\n" or raw[12:16] != b"IHDR":
            raise ValueError()
        actual = struct.unpack(">II", raw[16:24])
        if actual != (width, height):
            raise AnalysisError("IMAGE_SIZE_MISMATCH")
        image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
        if image is None or image.shape[:2] != (height, width) or image.dtype != np.uint8:
            raise ValueError()
        if image.ndim == 2:
            image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGRA)
        if image.shape[2] == 3:
            image = cv2.cvtColor(image, cv2.COLOR_BGR2BGRA)
        if image.shape[2] != 4:
            raise ValueError()
        return image
    except AnalysisError:
        raise
    except Exception:
        raise AnalysisError("IMAGE_DECODE_FAILED") from None


def analyze(challenge, profile=None):
    w, h, pw, ph, y = (challenge.get(k) for k in ("width", "height", "pieceWidth", "pieceHeight", "y"))
    if not all(type(n) is int and 0 < n <= 2048 for n in (w, h, pw, ph)) or not (
        pw < w and ph <= h and type(y) is int and 0 <= y <= h - ph
    ):
        raise AnalysisError("CREATE_INVALID_RESPONSE")
    background = decode(challenge.get("background"), w, h)
    gray = cv2.cvtColor(background, cv2.COLOR_BGRA2GRAY)
    candidates = []
    method = "contour"
    if challenge.get("piece"):
        piece = decode(challenge["piece"], pw, ph)
        mask = (piece[:, :, 3] >= 200).astype(np.uint8) * 255
        template = cv2.cvtColor(piece, cv2.COLOR_BGRA2GRAY)
        if np.count_nonzero(mask) >= 16 and float(np.std(template[mask > 0])) >= 3:
            # CCOEFF tolerates a uniform dark overlay over the cutout. Alpha mask
            # preserves the jigsaw silhouette; no assumption about tolerance=8.
            scores = cv2.matchTemplate(gray[y:y + ph, :], template, cv2.TM_CCOEFF_NORMED, mask=mask)[0]
            scores = np.nan_to_num(scores, nan=-1.0, posinf=-1.0, neginf=-1.0)
            method = "masked-template"
            for _ in range(5):
                x = int(np.argmax(scores))
                score = float(scores[x])
                if score < 0:
                    break
                candidates.append({"x": x, "score": min(1.0, score)})
                # Nearby pixels of the same peak are not independent candidates.
                radius = max(4, pw // 3)
                scores[max(0, x - radius):min(len(scores), x + radius + 1)] = -1
    if not candidates:
        # Background-only diagnostics: geometry alone is insufficient to certify
        # a puzzle silhouette, so this path never authorizes submission.
        roi = gray[y:y + ph, :]
        edges = cv2.Canny(roi, 40, 120)
        contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            x, top, cw, ch = cv2.boundingRect(contour)
            if abs(cw - pw) <= max(4, pw * .15) and abs(ch - ph) <= max(4, ph * .15) and x <= w - pw:
                score = max(0.0, 1 - (abs(cw - pw) / pw + abs(ch - ph) / ph + top / ph) / 3)
                candidates.append({"x": x, "score": score})
        candidates.sort(key=lambda c: c["score"], reverse=True)
        candidates = candidates[:5]
    best = candidates[0] if candidates else {"x": None, "score": 0.0}
    margin = max(0.0, best["score"] - (candidates[1]["score"] if len(candidates) > 1 else 0.0))
    calibrated = isinstance(profile, dict) and all(
        type(profile.get(k)) in (int, float) and math.isfinite(profile[k]) and 0 < profile[k] <= 1
        for k in ("minScore", "minMargin")
    )
    accept = bool(calibrated and method == "masked-template" and best["x"] is not None
                  and best["score"] >= profile["minScore"] and margin >= profile["minMargin"])
    result = {"challengeId": challenge.get("challengeId"), "targetX": best["x"], "targetY": y,
              "matchScore": best["score"], "candidateMargin": margin,
              "decision": "accept" if accept else "abstain", "method": method,
              "reason": "ACCEPTED" if accept else "POSITION_UNCERTAIN" if calibrated else "UNCALIBRATED",
              "candidates": candidates}
    return result, background


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--diagnostic", help="Optional offline annotated PNG output path")
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(7 * 1024 * 1024 + 1)
        if len(raw) > 7 * 1024 * 1024:
            raise AnalysisError("IMAGE_DECODE_FAILED")
        value = json.loads(raw)
        challenge = value["challenge"]
        result, image = analyze(challenge, value.get("profile"))
        if args.diagnostic:
            for c in result["candidates"]:
                cv2.rectangle(image, (c["x"], challenge["y"]),
                              (c["x"] + challenge["pieceWidth"], challenge["y"] + challenge["pieceHeight"]),
                              (0, 255, 0, 255), 1)
            if not cv2.imwrite(args.diagnostic, image):
                raise AnalysisError("DIAGNOSTIC_WRITE_FAILED")
        print(json.dumps(result, allow_nan=False))
    except Exception as error:
        print(json.dumps({"error": str(error) if isinstance(error, AnalysisError) else "IMAGE_DECODE_FAILED"}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
