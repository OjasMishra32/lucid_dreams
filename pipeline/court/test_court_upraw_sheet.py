"""court_upraw_sheet.py on fake run folders: up freezes pair with their raw twins, two rows each, and the hands
close-up finds a held ball or else the highest hand."""

import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import court_upraw_sheet as us  # noqa: E402
from test_court_gate2_sheet import ramp  # noqa: E402


def person(h=400, w=300, ball=False):
    """A white canvas with a dark person (a column and a raised arm), optionally an orange ball at their waist."""
    img = np.full((h, w, 3), 255, np.uint8)
    cv2.rectangle(img, (130, 80), (170, 380), (40, 40, 40), -1)
    cv2.rectangle(img, (165, 20), (175, 120), (40, 40, 40), -1)  # the raised arm: the highest point
    if ball:
        cv2.circle(img, (110, 230), 22, (30, 110, 220), -1)
    return img


def freeze(run: Path, name: str, k=5):
    rec = run / f"recon-{name}-300k"
    rec.mkdir(parents=True)
    pair = np.hstack([person(ball=True), person(ball=True)])
    cv2.imwrite(str(rec / f"peek-source-{k:06d}.jpg"), pair)
    cv2.imwrite(str(rec / f"peek-face-{k:06d}.jpg"), np.full((60, 120, 3), 200, np.uint8))
    ramp(run / f"bundle-{name}-300k" / "preview.mp4", 36, 64, n=12)


class UpRaw(unittest.TestCase):
    def test_up_pairs_with_its_raw_twin(self):
        with tempfile.TemporaryDirectory() as t:
            raw, up = Path(t) / "seed1", Path(t) / "winnerv-s1"
            freeze(raw, "raw-default-r0")
            freeze(raw, "raw-default-r2")
            freeze(up, "up-default-r0")
            freeze(up, "up-agree-r0")  # no raw twin: left out
            self.assertEqual([p[0] for p in us.pairs(raw, up, "300k")], ["default-r0"])
            out = Path(t) / "s.jpg"
            us.main(["--raw", str(raw), "--up", str(up), "--out", str(out), "--height", "64", "--ball"])
            self.assertEqual(cv2.imread(str(out)).shape[0], 2 * (64 + 4))  # raw, then up

    def test_hands_on_the_ball_or_else_the_highest_hand(self):
        x, y, w, h = us.hands_box(person(ball=True), ball=True)
        self.assertTrue(x <= 110 <= x + w and y <= 230 <= y + h)
        x, y, w, h = us.hands_box(person(), ball=False)
        self.assertTrue(x <= 170 <= x + w and y <= 30 <= y + h)

    def test_nothing_to_pair_is_one_labelled_tile(self):
        with tempfile.TemporaryDirectory() as t:
            rows = us.rows_for(Path(t) / "a", Path(t) / "b", 64)
            self.assertEqual(len(rows), 1)


if __name__ == "__main__":
    unittest.main()
