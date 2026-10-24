"""Run from repo root: PYTHONPATH=pipeline avatars/.venv/bin/python -m unittest pipeline.tests.test_beats -v (needs numpy)."""

import json
import math
import shutil
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

from lucid import beats


def click_track(path: Path, bpm: float, seconds: float, first: float, sr: int = 22050, noise: float = 0.02):
    """Short, bright clicks on the beat over quiet noise and a low hum (no onsets of its own), as 16-bit WAV."""
    rng = np.random.default_rng(1)
    n = int(seconds * sr)
    t = np.arange(n) / sr
    x = noise * rng.standard_normal(n) + 0.05 * np.sin(2 * np.pi * 110 * t)
    period = 60.0 / bpm
    k = 0
    while first + k * period < seconds:
        i = int((first + k * period) * sr)
        m = min(n - i, int(0.03 * sr))
        env = np.exp(-np.arange(m) / (0.004 * sr))
        x[i : i + m] += 0.8 * env * np.sin(2 * np.pi * 2000 * np.arange(m) / sr)
        k += 1
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def bundle(dir: Path, duration: float, audio: str | None, joints: str | None):
    (dir / "dream.json").write_text(json.dumps({"id": "t", "durationS": duration, "fps": 25, "audio": audio, "joints": joints}))


@unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
class BeatsFromSound(unittest.TestCase):
    def test_click_track_tempo_and_times(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            click_track(d / "audio.wav", 112.0, 4.84, 0.21)
            bundle(d, 4.84, "audio.wav", None)
            b = beats.find(d)
            self.assertEqual(b["source"], "audio")
            self.assertAlmostEqual(b["bpm"], 112.0, delta=2.0)
            truth = 0.21 + np.arange(0, 10) * 60 / 112.0
            truth = truth[truth < 4.84]
            got = np.array(b["times"])
            # every real beat has a found beat within 25 ms, and nothing extra
            for t in truth:
                self.assertLess(np.min(np.abs(got - t)), 0.025, f"no beat near {t:.3f}: {got}")
            self.assertLessEqual(len(got), len(truth) + 1)

    def test_silent_clip_falls_back_to_the_body(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "4.84", "-c:a", "aac", str(d / "audio.m4a")], check=True)
            # a body bouncing at 96 BPM: every joint dips (stops) on the beat and moves between
            fps, n, bpm = 25.0, 121, 96.0
            tt = np.arange(n) / fps
            phase = 2 * np.pi * (tt - 0.3) * bpm / 60.0
            # up on one beat, down on the next: the speed is |sin(phase / 2)|, zero (a stop) on each beat
            y = 0.9 + 0.05 * np.cos(phase / 2)
            frames = [[[0.0, float(y[i]) + 0.1 * j, 0.0] for j in range(22)] for i in range(n)]
            (d / "joints.json").write_text(json.dumps({"fps": fps, "names": [f"j{j}" for j in range(22)], "frames": frames}))
            bundle(d, 4.84, "audio.m4a", "joints.json")
            b = beats.find(d)
            self.assertEqual(b["source"], "motion")
            self.assertAlmostEqual(b["bpm"], bpm, delta=4.0)
            truth = 0.3 + np.arange(-1, 10) * 60 / bpm
            truth = truth[(truth > 0.1) & (truth < 4.7)]
            got = np.array(b["times"])
            for t in truth:
                self.assertLess(np.min(np.abs(got - t)), 0.06, f"no beat near {t:.3f}: {got}")

    def test_write_adds_beats_to_dream_json(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            click_track(d / "audio.wav", 120.0, 4.0, 0.1)
            bundle(d, 4.0, "audio.wav", None)
            self.assertEqual(beats.main([str(d), "--write"]), 0)
            dream = json.loads((d / "dream.json").read_text())
            self.assertEqual(dream["beats"], "beats.json")
            b = json.loads((d / "beats.json").read_text())
            self.assertTrue(all(0 <= t <= 4.0 for t in b["times"]))
            self.assertTrue(all(b2 > b1 for b1, b2 in zip(b["times"], b["times"][1:])))

    def test_nothing_to_find(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "2", "-c:a", "aac", str(d / "audio.m4a")], check=True)
            bundle(d, 2.0, "audio.m4a", None)
            self.assertIsNone(beats.find(d))
            self.assertEqual(beats.main([str(d), "--write"]), 1)
            self.assertFalse((d / "beats.json").exists())


class Grid(unittest.TestCase):
    def test_fill_closes_gaps_and_runs_to_both_ends(self):
        got = beats.fill(np.array([0.5, 1.0, 2.5, 3.0]), 120.0, 3.6)
        self.assertTrue(np.allclose(got, [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5], atol=1e-6), got)
        self.assertFalse(math.isnan(got.sum()))


if __name__ == "__main__":
    unittest.main()
