"""court_facefix.py without its models: the alignment maths, SCRFD's decoding, the face gate, the steady-in-time plan,
the paste, and a whole video through fix_video with a stand-in for the networks (ffmpeg only).
Run from the repo root: python3 -I -m unittest discover -s pipeline/court -p 'test_*.py' -v"""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import court_facefix as ff  # noqa: E402


def frontal(cx: float = 50.0, cy: float = 60.0, eye: float = 30.0) -> np.ndarray:
    """5 points of a made-up upright frontal face: eyes `eye` px apart."""
    return (ff.ARC - ff.ARC[:2].mean(0)) * (eye / (ff.ARC[1, 0] - ff.ARC[0, 0])) + [cx, cy]


class Geometry(unittest.TestCase):
    def test_similarity_recovers_a_known_transform(self):
        rng = np.random.default_rng(0)
        src = rng.uniform(0, 100, (5, 2))
        a, s, t = 0.3, 1.7, np.array([12.0, -4.0])
        r = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
        m = ff.similarity(src, src @ (s * r).T + t)
        np.testing.assert_allclose(m, np.hstack([s * r, t[:, None]]), atol=1e-4)

    def test_align_puts_the_points_on_the_template(self):
        k = frontal(200, 300, 45)
        for size, dst in ((112, ff.ARC), (224, ff.ARC * 2), (128, ff.ARC + [8, 0])):
            m = ff.align(k, size)
            np.testing.assert_allclose(cv2.transform(k[None].astype(np.float32), m)[0], dst, atol=1e-3)

    def test_turn_and_gate(self):
        k = frontal(eye=30)
        self.assertAlmostEqual(ff.turn(k), 0.0, places=2)
        self.assertAlmostEqual(ff.face_gate(k), 1.0)
        prof = k.copy()
        prof[2, 0] = k[0, 0] - 0.5 * 30  # the nose well past the near eye: a profile
        self.assertGreater(ff.turn(prof), 0.75)
        self.assertEqual(ff.face_gate(prof), 0.0)
        self.assertEqual(ff.face_gate(frontal(eye=ff.MIN_EYE - 1)), 0.0)  # too small to swap
        mid = ff.face_gate(frontal(eye=1.25 * ff.MIN_EYE))
        self.assertTrue(0 < mid < 1, mid)
        three_quarter = k.copy()
        three_quarter[2, 0] = k[0, 0] + 0.1 * 30  # the nose near one eye: still swapped in full
        self.assertAlmostEqual(ff.face_gate(three_quarter), 1.0)

    def test_a_face_cut_by_the_frame_fades_out(self):
        k = frontal(80, 100, 30)
        self.assertAlmostEqual(ff.inside(k, 160, 200), 1.0)
        self.assertAlmostEqual(ff.face_gate(k, frame=(160, 200)), 1.0)
        edge = frontal(5, 100, 30)  # half the face past the left edge
        self.assertLess(ff.inside(edge, 160, 200), 0.75)
        self.assertEqual(ff.face_gate(edge, frame=(160, 200)), 0.0)
        self.assertAlmostEqual(ff.face_gate(edge), 1.0)  # no frame given: size and turn only


class Scrfd(unittest.TestCase):
    def test_decode_one_face_and_nms(self):
        w = h = 64
        outs = []
        for stride in (8, 16, 32):
            n = (h // stride) * (w // stride) * 2
            outs.append(np.zeros((n, 1), np.float32))
        for stride in (8, 16, 32):
            n = (h // stride) * (w // stride) * 2
            outs.append(np.zeros((n, 4), np.float32))
        for stride in (8, 16, 32):
            n = (h // stride) * (w // stride) * 2
            outs.append(np.zeros((n, 10), np.float32))
        gx, gy = 3, 2  # stride 8 cell (3, 2): centre (24, 16); both of its anchors fire, nearly the same box
        for anchor, sc in ((0, 0.9), (1, 0.8)):
            j = (gy * (w // 8) + gx) * 2 + anchor
            outs[0][j] = sc
            outs[3][j] = np.array([1.0, 1.0, 1.0, 1.25]) + 0.05 * anchor  # distances in strides
            outs[6][j] = np.tile([0.5, -0.5], 5)
        boxes, scores, kps = ff.scrfd_decode(outs, w, h, thr=0.5)
        self.assertEqual(len(scores), 1)  # NMS keeps the better anchor
        np.testing.assert_allclose(boxes[0], [16, 8, 32, 26], atol=1e-4)
        np.testing.assert_allclose(kps[0], np.tile([28, 12], (5, 1)), atol=1e-4)
        self.assertAlmostEqual(float(scores[0]), 0.9, places=5)

    def test_nothing_above_the_threshold(self):
        outs = [np.zeros(((64 // s) ** 2 * 2, c), np.float32) for c in (1, 4, 10) for s in (8, 16, 32)]
        boxes, scores, kps = ff.scrfd_decode(outs, 64, 64)
        self.assertEqual((boxes.shape, scores.shape, kps.shape), ((0, 4), (0,), (0, 5, 2)))


class Plan(unittest.TestCase):
    def test_fades_bridges_and_keeps_the_last_frame(self):
        n = 40
        rng = np.random.default_rng(1)
        kps = [None] * n
        gates = [0.0] * n
        for t in list(range(5, 20)) + list(range(30, 40)):  # two runs, the second to the video's last frame
            kps[t] = frontal() + rng.normal(0, 0.8, (5, 2))
            gates[t] = 1.0
        kps[12], gates[12] = None, 0.0  # one missed frame inside a run
        kps[25], gates[25] = frontal(), 1.0  # a lone detection: never pasted
        pts, s = ff.plan(kps, gates)
        self.assertEqual(s[:5].tolist(), [0.0] * 5)
        self.assertLess(s[5], 0.2)  # fades in
        self.assertGreater(s[12], 0.9)  # the missed frame is bridged
        self.assertTrue(np.isfinite(pts[12]).all())
        self.assertEqual(s[25], 0.0)
        self.assertTrue(np.isnan(pts[25]).all())
        self.assertGreater(s[39], 0.99)  # the video's end is not a run end: the freeze can be the last frame
        self.assertGreater(s[37], 0.99)
        raw = np.array([kps[t] for t in range(31, 39)])
        self.assertLess(np.abs(np.diff(pts[31:39], axis=0)).mean(), np.abs(np.diff(raw, axis=0)).mean())  # steadier

    def test_gate_follows_the_face(self):
        kps = [frontal()] * 20
        gates = [1.0] * 10 + [0.0] * 10  # turning away: the strength goes to 0 before the gate does
        pts, s = ff.plan(kps, gates)
        self.assertGreater(s[5], 0.99)
        self.assertEqual(s[12:].tolist(), [0.0] * 8)


class Paste(unittest.TestCase):
    def test_paste_blends_inside_the_mask_only(self):
        img = np.full((200, 160, 3), 50, np.uint8)
        k = frontal(80, 100, 30)
        m = ff.align(k, 128)
        face = np.full((128, 128, 3), 250, np.float32)
        out = ff.paste(img, face, m, 1.0)
        self.assertEqual(out[100, 80].tolist(), [250, 250, 250])  # the face's centre
        self.assertEqual(out[5, 5].tolist(), [50, 50, 50])  # far away: untouched
        half = ff.paste(img, face, m, 0.5)
        self.assertEqual(half[100, 80].tolist(), [150, 150, 150])
        self.assertTrue((ff.paste(img, face, m, 0.0) == img).all())


class FakeFaces:
    """fix_video's view of Faces: a face in frames 2..8 at fixed points; the 'swap' paints it white."""
    used = "fake"

    def __init__(self):
        self.k = frontal(48, 70, 24)

    def detect_one(self, img, thr=ff.DET_SCORE, near=None):
        return (0.9, np.array([30, 50, 66, 95.0]), self.k) if img.mean() > 100 else None

    def swap(self, img, kps, latent):
        return np.full((128, 128, 3), 255, np.float32), ff.align(kps, 128)


def video(path: Path, frames: list[np.ndarray]):
    ff.write_frames(path, frames, "25/1")


class FixVideo(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.t = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_video_with_a_face_is_rewritten_frame_for_frame(self):
        frames = [np.full((128, 96, 3), 160 if 2 <= i <= 12 else 60, np.uint8) for i in range(15)]
        video(self.t / "07.mp4", frames)
        r = ff.fix_video(FakeFaces(), self.t / "07.mp4", self.t / "out" / "07.mp4", np.zeros(512, np.float32))
        self.assertEqual((r["frames"], r["detected"]), (15, 11))
        self.assertGreater(r["swapped"], 0)
        got, rate = ff.read_frames(self.t / "out" / "07.mp4")
        self.assertEqual((len(got), rate), (15, "25/1"))
        n = subprocess.run(["ffprobe", "-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries",
                            "stream=nb_read_packets", "-of", "csv=p=0", str(self.t / "out" / "07.mp4")],
                           capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(n, "15")
        self.assertGreater(got[7][70, 48].mean(), 230)  # mid-run: the swapped face
        self.assertLess(abs(float(got[0][70, 48].mean()) - 60), 4)  # no face: as it was

    def test_no_face_no_file(self):
        video(self.t / "08.mp4", [np.full((128, 96, 3), 60, np.uint8)] * 6)
        (self.t / "out").mkdir()
        r = ff.fix_video(FakeFaces(), self.t / "08.mp4", self.t / "out" / "08.mp4", np.zeros(512, np.float32))
        self.assertEqual((r["detected"], r["swapped"]), (0, 0))
        self.assertNotIn("out", r)
        self.assertEqual(list((self.t / "out").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
