"""Evaluate labeled, saved challenges offline; never submit to a CAPTCHA server."""
import argparse
import json
import math
from pathlib import Path

import cv2

from captcha_position import AnalysisError, analyze


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path, help="JSON array of {challenge, expectedX}")
    parser.add_argument("--min-score", type=float, required=True)
    parser.add_argument("--min-margin", type=float, required=True)
    parser.add_argument("--max-error", type=float, default=1.0, help="Evaluation pixel error, not server tolerance")
    parser.add_argument("--diagnostics", type=Path)
    args = parser.parse_args()
    if not (0 < args.min_score <= 1 and 0 < args.min_margin <= 1 and 0 <= args.max_error <= 2048):
        parser.error("Use bounded score/margin and evaluation error values")
    samples = json.loads(args.dataset.read_text(encoding="utf-8"))
    if not isinstance(samples, list) or not samples:
        parser.error("A nonempty labeled sample array is required")
    if args.diagnostics:
        args.diagnostics.mkdir(parents=True, exist_ok=True)
    rows = []
    for index, sample in enumerate(samples):
        expected = sample.get("expectedX")
        if type(expected) not in (int, float) or not 0 <= expected <= sample["challenge"]["width"] - sample["challenge"]["pieceWidth"]:
            parser.error(f"Invalid expectedX at sample {index}")
        try:
            result, image = analyze(sample["challenge"], {"minScore": args.min_score, "minMargin": args.min_margin})
            error = None if result["targetX"] is None else abs(result["targetX"] - expected)
            if args.diagnostics:
                for candidate in result["candidates"]:
                    c = sample["challenge"]
                    x = int(math.floor(candidate["x"] + .5))
                    cv2.rectangle(image, (x, c["y"]),
                                  (x + c["pieceWidth"], c["y"] + c["pieceHeight"]),
                                  (0, 255, 0, 255), 1)
                if not cv2.imwrite(str(args.diagnostics / f"sample-{index:04d}.png"), image):
                    raise AnalysisError("DIAGNOSTIC_WRITE_FAILED")
            rows.append({"sample": index, "targetX": result["targetX"], "absoluteError": error,
                         "decision": result["decision"], "matchScore": result["matchScore"],
                         "candidateMargin": result["candidateMargin"]})
        except AnalysisError as error:
            rows.append({"sample": index, "decision": "abstain", "error": str(error), "absoluteError": None})
    accepted = [r for r in rows if r["decision"] == "accept"]
    correct = sum(r["absoluteError"] is not None and r["absoluteError"] <= args.max_error for r in accepted)
    estimated = [r for r in rows if r["absoluteError"] is not None]
    print(json.dumps({"samples": len(rows), "accepted": len(accepted), "correctAccepted": correct,
                      "coverage": len(accepted) / len(rows),
                      "acceptedPositionAccuracy": correct / len(accepted) if accepted else None,
                      "meanAbsoluteError": sum(r["absoluteError"] for r in estimated) / len(estimated) if estimated else None,
                      "serverVerificationSuccessRate": None,
                      "serverVerificationMeasured": False,
                      "results": rows}, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
