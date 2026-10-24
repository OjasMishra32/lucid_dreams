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
        self.assertEqual(img.shape[0], 3 * (64 + 4))  # the clip + first half of the ring, the second half, the peeks
        # the clip tile, below its label, is frame 5's grey
        self.assertAlmostEqual(float(img[40:60, 2:30].mean()), 100, delta=6)

    def test_the_whole_ring_in_two_rows(self):
        for v in ("02", "06", "10", "14"):
            ramp(self.run / "views" / "videos" / f"{v}.mp4", 22, 40)
        self.assertEqual(g2.split_views(self.run), (["00", "02", "04", "06"], ["08", "10", "12", "14"]))
        first, second = g2.rows_for(self.run, 64, None)[:2]
        self.assertEqual(second.shape[1], 35 + 35 + 36 + 35)  # 12 is missing: a grey 36x64 tile

    def test_each_bundle_gets_its_orbit_every_45_degrees(self):
        ramp(self.run / "bundle-raw-default-r0-300k" / "preview.mp4", 18, 32, n=12)  # frame i: grey 20 * i
        rows = g2.rows_for(self.run, 64, None)
        self.assertEqual(len(rows), 4)  # ring, ring, peeks, orbit
        orbit = rows[3]
        self.assertEqual(orbit.shape[1], 8 * 36)
        back = orbit[40:60, 4 * 36 + 2:4 * 36 + 30]  # 180 degrees: frame 6 of 12, below its label
        self.assertAlmostEqual(float(back.mean()), 120, delta=6)

    def test_a_tagged_rerun_stands_in_for_its_seed(self):
        mgpu = self.run.parent / "seed1-mgpu"
        self.run.rename(mgpu)
        (self.run / "logs").mkdir(parents=True)  # the cancelled seed1: a partial log only
        out = Path(self.tmp.name) / "g.jpg"
        g2.main([str(self.run), str(mgpu), "--out", str(out), "--height", "64"])
        import cv2
        self.assertEqual(cv2.imread(str(out)).shape[0], 3 * (64 + 4))  # seed1-mgpu's rows only

    def test_the_freeze_p42_goes_on_its_peek(self):
        rec = self.run / "recon-views-default-r0-300k"
        self.assertEqual(g2.p42_text(rec, None), "")  # no report, no peek of the real frame: nothing to say
        (rec / "p42.json").write_text(json.dumps({"pass": False, "iouFinal": 0.9123}))
        self.assertEqual(g2.p42_text(rec, None), "P42 FAIL iou 0.9123")
        self.assertEqual(len(g2.rows_for(self.run, 64, None)), 3)
        (rec / "stance.json").write_text(json.dumps({"stance": 0.52, "along": 0.47, "across": 0.23,
                                                     "ref": {"stance": 0.57, "along": 0.53, "across": 0.21}}))
        self.assertEqual(g2.stance_text(rec), "stance 0.52 (0.47/0.23) vs 0.57")
        self.assertEqual(g2.depth_text(self.run, rec, None), "")

    def test_no_k_anywhere_is_one_labelled_tile(self):
        bare = Path(self.tmp.name) / "court-y"
        bare.mkdir()
        rows = g2.rows_for(bare, 48, None)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].shape[0], 48)


if __name__ == "__main__":
    unittest.main()
