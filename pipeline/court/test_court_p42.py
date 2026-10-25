"""court_p42.py on synthetic freezes: the trained render against the real mask at K (ignore applied) and the focal
guard; a shifted silhouette fails."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import court_p42 as p42  # noqa: E402

K = 60


def person(w, h, dx=0):
    img = np.full((h, w, 3), 255, np.uint8)
    cv2.ellipse(img, (w // 2 + dx, h // 2), (w // 5, h // 3), 0, 0, 360, (30, 40, 50), -1)
    cv2.rectangle(img, (w // 2 + dx - 10, h // 2 - 20), (w // 2 + dx + 10, h // 2 + 20), (250, 250, 250), -1)  # kit
    return img


def freeze(run: Path, dx: int, focal=1000.0, held=True, used_focal=1000.0, iou_solve=0.8, ignore=None):
    rec = run / "recon-raw-default-r0-300k"
    rec.mkdir(parents=True)
    w, h = 100, 200
    cv2.imwrite(str(rec / f"peek-source-{K:06d}.jpg"), np.hstack([person(w, h), person(w, h, dx)]))
    (rec / f"recon-{K:06d}-{K + 1:06d}.json").write_text(json.dumps({
        "frames": [{"frame": K}], "source": {"iou": iou_solve, "focal": focal, "focalHeld": held,
                                             "crop": [10, 0, 110, 200], "size": [w, h]}}))
    (rec / "used.json").write_text(json.dumps({"K": K, "FOCAL": used_focal}))
    if ignore is not None:
        (run / "ignore").mkdir(exist_ok=True)
        cv2.imwrite(str(run / "ignore" / f"{K:06d}.png"), ignore)
    return rec


class P42(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_matching_freeze_passes(self):
        rec = freeze(self.root / "court-a" / "seed1-mgpu", 0)
        r = p42.check(rec)
        self.assertGreater(r["iouFinal"], 0.99)  # the white kit inside the body is not a hole
        self.assertTrue(r["pass"])
        self.assertEqual((r["iouSolve"], r["focalHeld"], r["focal"], r["FOCAL"]), (0.8, True, 1000.0, 1000.0))

    def test_a_shifted_silhouette_fails(self):
        r = p42.check(freeze(self.root / "court-b", 12))
        self.assertLess(r["iouFinal"], 0.95)
        self.assertFalse(r["pass"])

    def test_a_wrong_or_free_focal_fails(self):
        self.assertFalse(p42.check(freeze(self.root / "c1", 0, held=False))["pass"])
        self.assertFalse(p42.check(freeze(self.root / "c2", 0, focal=1000.0, used_focal=1100.0))["pass"])

    def test_ignored_pixels_do_not_count(self):
        ig = np.zeros((200, 120), np.uint8)
        ig[:, 10 + 30:10 + 42] = 255  # the two bands (source-4k pixels: the crop starts at x 10) where the shift
        ig[:, 10 + 70:10 + 82] = 255  # makes the silhouettes differ at the body's widest rows
        clips = self.root / "clips"
        rec = freeze(self.root / "court-d", 12)
        freeze(clips / "court-d", 0, ignore=ig)  # the local run folder: its ignore at K, in source-4k pixels
        free = p42.check(rec)["iouFinal"]
        held = p42.check(rec, clips=clips)["iouFinal"]
        self.assertGreater(held, free)

    def test_main_writes_p42_json_per_freeze_recon(self):
        freeze(self.root / "court-e" / "seed1", 0)
        p42.main([str(self.root / "court-e" / "seed1")])
        out = json.loads((self.root / "court-e" / "seed1" / "recon-raw-default-r0-300k" / "p42.json").read_text())
        self.assertEqual(set(out) >= {"iouFinal", "iouSolve", "focalHeld", "focal", "pass"}, True)


if __name__ == "__main__":
    unittest.main()
