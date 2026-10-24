"""Run from repo root: PYTHONPATH=pipeline python3 -m unittest pipeline.tests.test_strums -v (needs numpy)."""

import unittest

import numpy as np

from lucid import strums as st


def strum_sound(times, seconds, sr=st.SR, seed=0):
    """A strum per time: six plucked partials over a broadband attack, each ringing out, in a little room noise."""
    rng = np.random.default_rng(seed)
    x = rng.normal(0, 0.002, int(seconds * sr))
    t = np.arange(int(0.6 * sr)) / sr
    for k, s in enumerate(times):
        tone = sum(np.sin(2 * np.pi * f * t + k) for f in (82.4, 110, 146.8, 196, 246.9, 329.6)) / 6
        attack = rng.normal(0, 1, len(t)) * np.exp(-t / 0.004)
        burst = (0.5 * tone * np.exp(-t / 0.35) + 0.4 * attack) * 0.5
        i = int(s * sr)
        x[i:i + len(t)] += burst[: len(x) - i]
    return x.astype(np.float32)


class AudioStrums(unittest.TestCase):
    def test_finds_every_strum_on_time(self):
        truth = [0.3, 0.8, 1.05, 1.55, 1.8, 2.3, 2.55, 3.05]  # down, down-up at 120 BPM
        found = st.audio_strums(strum_sound(truth, 3.6))
        self.assertEqual(len(found), len(truth), found)
        self.assertLess(np.max(np.abs(found - np.array(truth))), 0.015)

    def test_silence_is_silent(self):
        self.assertLess(st.peak_dbfs(np.zeros(st.SR, np.float32)), st.SILENT_DBFS)
        self.assertLess(st.peak_dbfs(np.full(st.SR, 2.8e-5, np.float32)), st.SILENT_DBFS)  # guitar-01's -91 dBFS
        self.assertGreater(st.peak_dbfs(strum_sound([0.2], 1.0)), st.SILENT_DBFS)

    def test_quiet_room_has_no_strums(self):
        x = np.random.default_rng(3).normal(0, 0.002, st.SR * 2).astype(np.float32)
        self.assertEqual(len(st.audio_strums(x)), 0)


class HandStrokes(unittest.TestCase):
    def test_one_strum_per_stroke_at_its_fastest(self):
        fps = 25.0
        t = np.arange(121) / fps
        y = 20 * np.sin(2 * np.pi * (t - 0.3) / 1.2)  # down and up every 1.2 s, a hand 40 px tall in the picture
        y += np.random.default_rng(1).normal(0, 0.4, len(t))  # tracking jitter
        vy = np.gradient(y) * fps
        idx = st.strokes(vy, fps)
        # fastest where the sine crosses zero: 0.3, 0.9, ... 4.5 s; down (+ in the picture) at 0.3, 1.5, ...
        self.assertEqual(len(idx), 8)
        k = np.round((idx / fps - 0.3) / 0.6)
        self.assertLess(np.max(np.abs(idx / fps - 0.3 - 0.6 * k)), 1.6 / fps)  # within a frame and a half
        self.assertEqual([bool(vy[i] > 0) for i in idx], [kk % 2 == 0 for kk in k])

    def test_a_slow_moment_mid_stroke_does_not_split_it(self):
        vy = np.array([0, 20, 60, 70, 30, 25, 60, 50, 10, -10, -60, -80, -40, -5, 5, 0], float)
        self.assertEqual(st.strokes(vy, 25.0).tolist(), [3, 11])

    def test_a_still_hand_makes_no_strums(self):
        y = np.random.default_rng(2).normal(0, 0.5, 100)  # half a pixel of tracking jitter, no stroke
        self.assertEqual(len(st.strokes(np.gradient(y) * 25.0, 25.0)), 0)


class Direction(unittest.TestCase):
    def joints(self, y):
        frames = [[[0, 0.7, 0], [0, 0, 0], [0.1, yy, 0]] for yy in y]
        return {"fps": 25, "names": ["pelvis", "left_wrist", "right_wrist"], "frames": frames}

    def test_the_moving_wrist_says_which_way(self):
        t = np.arange(60) / 25
        y = 0.8 + 0.01 * np.cos(2 * np.pi * t / 1.2)  # falling for the first 0.6 s, then rising
        j = self.joints(y)
        self.assertEqual(st.strumming_wrist(j), "right_wrist")
        self.assertEqual(st.joint_directions(j, np.array([0.3, 0.9]), "right_wrist").tolist(), [-1, 1])

    def test_a_still_wrist_says_nothing(self):
        j = self.joints(np.full(60, 0.8))
        self.assertEqual(st.joint_directions(j, np.array([1.0]), "right_wrist").tolist(), [0])


if __name__ == "__main__":
    unittest.main()
