"""assemble_audio.py on synthetic crowd noise (no broadcast audio). Run from the repo root:
python3 -I -m unittest discover -s pipeline/court -p 'test_assemble*.py' -v   (needs ffmpeg)"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import assemble_audio as au  # noqa: E402

SR = 44100


def crowd(seconds=20.0, bump=(11.0, 12.5), bump_db=6.0, seed=1) -> np.ndarray:
    """Stereo noise at a steady level, with a smooth swell of +bump_db between bump[0] and bump[1]."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    x = rng.normal(0, 0.05, (n, 2))
    t = np.arange(n) / SR
    w = np.clip(np.minimum(t - bump[0], bump[1] - t) / 0.3, 0, 1)
    gain = 10 ** (bump_db * np.sin(w * np.pi / 2) ** 2 / 20)
    return x * gain[:, None]


class Swell(unittest.TestCase):
    def test_finds_the_swell(self):
        x = crowd()
        t0, t1, db = au.find_swell(x.mean(1), SR)
        self.assertAlmostEqual(t0, 11.0, delta=0.35)
        self.assertAlmostEqual(t1, 12.5, delta=0.35)
        self.assertGreater(db, 4.0)

    def test_cut_leaves_a_level_bed_and_keeps_the_loop_ends(self):
        x = crowd()
        t0, t1, _ = au.find_swell(x.mean(1), SR)
        bed = au.cut(x, SR, t0, t1)
        self.assertAlmostEqual(len(bed) / SR, 20.0 - (t1 - t0), delta=0.01)
        env = au.envelope_db(bed.mean(1), SR)
        self.assertLess(env.max() - np.median(env), 1.5)
        np.testing.assert_array_equal(bed[:SR], x[:SR])
        np.testing.assert_array_equal(bed[-SR:], x[-SR:])

    def test_one_shot_fades_in_and_out(self):
        x = crowd()
        shot = au.extract(x, SR, 11.0, 12.5)
        self.assertGreater(len(shot) / SR, 1.5)
        self.assertLess(np.abs(shot[:10]).max(), 1e-3)
        self.assertLess(np.abs(shot[-10:]).max(), 1e-3)


class Edges(unittest.TestCase):
    def test_one_shot_near_the_end_of_the_loop(self):
        x = crowd(seconds=5.0, bump=(4.0, 4.9))
        shot = au.extract(x, SR, 4.0, 4.9)
        self.assertLess(np.abs(shot[-10:]).max(), 1e-3)
        self.assertEqual(len(au.extract(x, SR, 1.0, 2.0, fade_in=0, fade_out=0)), int(2.6 * SR) - int(0.7 * SR))


class Encode(unittest.TestCase):
    def test_bed_and_swell_share_one_gain_to_the_target(self):
        x = crowd()
        t0, t1, _ = au.find_swell(x.mean(1), SR)
        with tempfile.TemporaryDirectory() as d:
            info = au.make_audio(x, SR, (t0, t1), Path(d), lufs=-23.0)
            bed = au.loudness(Path(d) / "bed.m4a")
            self.assertTrue((Path(d) / "swell.m4a").stat().st_size > 1000)
        self.assertAlmostEqual(bed["I"], -23.0, delta=1.0)
        self.assertLessEqual(bed["TP"], -1.0)
        self.assertEqual(info["channels"], 1)


if __name__ == "__main__":
    unittest.main()
