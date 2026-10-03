import base64
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

spec = importlib.util.spec_from_file_location("position", Path(__file__).resolve().parents[1] / "tools/captcha_position.py")
position = importlib.util.module_from_spec(spec)
spec.loader.exec_module(position)


def png(image):
    return "data:image/png;base64," + base64.b64encode(cv2.imencode(".png", image)[1]).decode()


def fixture(seed=1, x=117):
    rng = np.random.default_rng(seed)
    image = rng.integers(30, 240, (160, 320, 3), dtype=np.uint8)
    image = cv2.GaussianBlur(image, (5, 5), 1)
    piece = cv2.cvtColor(image[51:111, x:x + 60].copy(), cv2.COLOR_BGR2BGRA)
    piece[:, :, 3] = 0
    mask = np.zeros((60, 60), dtype=np.uint8)
    cv2.rectangle(mask, (4, 4), (55, 55), 255, -1)
    cv2.circle(mask, (30, 4), 4, 255, -1)
    piece[:, :, 3] = mask
    roi = image[51:111, x:x + 60]
    roi[mask > 0] = (roi[mask > 0].astype(np.float32) * .55).astype(np.uint8)
    return {"challengeId": "synthetic", "background": png(image), "piece": png(piece),
            "width": 320, "height": 160, "pieceWidth": 60, "pieceHeight": 60, "y": 51}


def flat_fixture(x=170, duplicate=False):
    # Locally generated shape/background: deliberately unrelated piece texture.
    rng = np.random.default_rng(12)
    image = np.full((160, 320, 3), 230, np.uint8)
    for i in range(12):
        center = tuple(int(v) for v in rng.integers([0, 0], [320, 160]))
        cv2.circle(image, center, int(rng.integers(10, 35)), (200 + i, 220, 205), -1)
    mask = np.zeros((60, 60), np.uint8)
    cv2.rectangle(mask, (5, 12), (47, 55), 255, -1)
    cv2.circle(mask, (26, 12), 9, 255, -1)
    cv2.circle(mask, (47, 32), 9, 255, -1)
    cv2.circle(mask, (5, 33), 8, 0, -1)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for left in ([x, 50] if duplicate else [x]):
        roi = image[29:89, left:left + 60]
        roi[mask > 0] = (120, 135, 150)
        cv2.drawContours(roi, contours, -1, (255, 255, 255), 2)
    piece = np.zeros((60, 60, 4), np.uint8)
    piece[:, :, :3] = rng.integers(60, 200, (60, 60, 3), dtype=np.uint8)
    piece[:, :, 3] = mask
    return {"challengeId": "synthetic-flat", "background": png(image), "piece": png(piece),
            "width": 320, "height": 160, "pieceWidth": 60, "pieceHeight": 60, "y": 29}


class PositionTests(unittest.TestCase):
    profile = {"minScore": .85, "minMargin": .12}

    def test_original_coordinates_on_seeded_darkened_cutouts(self):
        for seed, x in enumerate([0, 30, 80, 117, 145, 190, 230, 260]):
            with self.subTest(x=x):
                result, _ = position.analyze(fixture(seed, x), self.profile)
                self.assertLessEqual(abs(result["targetX"] - x), .5)
                self.assertEqual(result["targetY"], 51)
                self.assertEqual(result["decision"], "accept")

    def test_peak_interpolation_preserves_fractional_positions(self):
        scores = np.array([1 - .1 * (x - 2.25) ** 2 for x in range(5)], dtype=np.float32)
        self.assertAlmostEqual(position.peaks(scores, 4)[0]["x"], 2.25, places=5)
        flat = np.array([.1, .5, .9, .9, .5, .1], dtype=np.float32)
        self.assertEqual(position.peaks(flat, 4)[0]["x"], 2.5)

    def test_uncalibrated_results_abstain(self):
        result, _ = position.analyze(fixture())
        self.assertEqual(result["reason"], "UNCALIBRATED")
        self.assertEqual(result["decision"], "abstain")

    def test_flat_cutouts_use_alpha_shape_without_texture_similarity(self):
        for x in (90, 170, 230):
            with self.subTest(x=x):
                result, _ = position.analyze(flat_fixture(x), self.profile)
                self.assertEqual(result["method"], "alpha-edge")
                self.assertEqual(result["decision"], "accept")
                self.assertLessEqual(abs(result["targetX"] - x), 2)

    def test_duplicate_flat_cutouts_abstain(self):
        result, _ = position.analyze(flat_fixture(duplicate=True), self.profile)
        self.assertEqual(result["decision"], "abstain")

    def test_equal_candidates_abstain(self):
        c = fixture()
        image = position.decode(c["background"], 320, 160)
        image[51:111, 210:270] = image[51:111, 117:177]
        c["background"] = png(image)
        result, _ = position.analyze(c, self.profile)
        self.assertLess(result["candidateMargin"], .001)
        self.assertEqual(result["decision"], "abstain")

    def test_background_only_never_certifies_unknown_silhouette(self):
        c = fixture()
        del c["piece"]
        self.assertEqual(position.analyze(c, self.profile)[0]["decision"], "abstain")

    def test_corrupt_image_and_declared_dimensions(self):
        c = fixture()
        c["width"] = 319
        with self.assertRaisesRegex(position.AnalysisError, "IMAGE_SIZE_MISMATCH"):
            position.analyze(c, self.profile)
        c = fixture()
        c["background"] = "data:image/png;base64,broken"
        with self.assertRaisesRegex(position.AnalysisError, "IMAGE_DECODE_FAILED"):
            position.analyze(c, self.profile)

    def test_evaluation_separates_position_accuracy_from_server_success(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            dataset = Path(directory) / "labeled.json"
            dataset.write_text(json.dumps([{"challenge": fixture(), "expectedX": 117},
                                           {"challenge": fixture(2), "expectedX": 100}]))
            output = subprocess.check_output([sys.executable, str(root / "tools/evaluate_captcha.py"), str(dataset),
                                              "--min-score", ".85", "--min-margin", ".12",
                                              "--diagnostics", str(Path(directory) / "diagnostics")])
            report = json.loads(output)
            self.assertEqual(report["accepted"], 2)
            self.assertEqual(report["acceptedPositionAccuracy"], .5)
            self.assertIsNone(report["serverVerificationSuccessRate"])
            self.assertFalse(report["serverVerificationMeasured"])
            self.assertTrue((Path(directory) / "diagnostics/sample-0000.png").is_file())


if __name__ == "__main__":
    unittest.main()
