"""court_gate2_sheet.py on a fake fetched run: the frames at K are the ones shown, missing pieces don't stop it."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import court_gate2_sheet as g2  # noqa: E402


def ramp(path: Path, w: int, h: int, n: int = 10):
    """Frame i is flat grey level 20 * i."""
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = np.stack([np.full((h, w, 3), 20 * i, np.uint8) for i in range(n)])
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}",
                          "-r", "25", "-i", "-", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv444p", str(path)],
                         stdin=subprocess.PIPE)
    p.communicate(frames.tobytes())
    assert p.returncode == 0


class Gate2Sheet(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run = Path(self.tmp.name) / "court-x-r2" / "seed1"
        ramp(self.run / "prepped.mp4", 36, 64)
        for v in ("00", "04", "08"):  # 12 is missing
            ramp(self.run / "views" / "videos" / f"{v}.mp4", 22, 40)
        rec = self.run / "recon-views-default-r0-300k"
        rec.mkdir()
        (rec / "used.json").write_text(json.dumps({"K": 5}))
        import cv2
        cv2.imwrite(str(rec / "peek-000005.jpg"), np.full((40, 220, 3), 200, np.uint8))

    def tearDown(self):
        self.tmp.cleanup()

    def test_frame_k_comes_from_the_recon_record(self):
        self.assertEqual(g2.find_k(self.run, None), 5)
        f = g2.frame_at(self.run / "views" / "videos" / "00.mp4", 5)
        self.assertAlmostEqual(float(f.mean()), 100, delta=2)

    def test_sheet_has_the_clip_views_and_peeks(self):
        out = Path(self.tmp.name) / "g.jpg"
        g2.main([str(self.run), "--out", str(out), "--height", "64"])
        import cv2
        img = cv2.imread(str(out))
        self.assertEqual(img.shape[0], 2 * (64 + 4))  # the clip + views row, then the peeks row
        # the clip tile, below its label, is frame 5's grey
        self.assertAlmostEqual(float(img[40:60, 2:30].mean()), 100, delta=6)

    def test_no_k_anywhere_is_one_labelled_tile(self):
        bare = Path(self.tmp.name) / "court-y"
        bare.mkdir()
        rows = g2.rows_for(bare, 48, None)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].shape[0], 48)


if __name__ == "__main__":
    unittest.main()
