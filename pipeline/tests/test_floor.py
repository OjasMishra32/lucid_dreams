"""lucid.floor: a bundle moved so its feet touch y = 0, with everything that lines up with the person moved alike.
Run from repo root: PYTHONPATH=pipeline python3 -m unittest discover -s pipeline/tests -v."""

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from lucid.floor import main, measure
from lucid.gaussians import Gaussians, read_spz, write_spz


def person(lift: float, n=2000, seed=0):
    rng = np.random.default_rng(seed)
    means = np.c_[rng.normal(0, 0.15, n), rng.uniform(0, 1.75, n) + lift, rng.normal(0, 0.1, n)].astype(np.float32)
    z = np.zeros((n, 3), np.float32)
    return Gaussians(means, np.full((n, 3), -4, np.float32), np.tile([1, 0, 0, 0], (n, 1)).astype(np.float32),
                     np.full(n, 4.0, np.float32), z[:, None, :], np.zeros((n, 0, 3), np.float32))


class Floor(unittest.TestCase):
    def test_lifted_bundle_comes_down_with_its_joints_and_ball_but_not_the_hoop(self):
        with tempfile.TemporaryDirectory() as tmp:
            b = Path(tmp)
            (b / "frames").mkdir()
            for i in range(2):
                write_spz(b / "frames" / f"{i:06d}.spz", person(0.04, seed=i))
                write_spz(b / "frames" / f"{i:06d}.reality.spz", person(0.04, seed=i))
            dream = {"frameCount": 2, "frames": {"dir": "frames", "spz": "%06d.spz", "reality": "%06d.reality.spz"},
                     "bounds": {"min": [-0.5, 0.04, -0.3], "max": [0.5, 1.79, 0.3]},
                     "placement": {"rot": np.eye(3).tolist(), "t": [0, 0.01, 0]}, "metrics": {}}
            (b / "dream.json").write_text(json.dumps(dream))
            (b / "joints.json").write_text(json.dumps({"names": ["pelvis"], "frames": [[[0, 0.98, 0]], [[0, 0.99, 0]]]}))
            (b / "props.json").write_text(json.dumps({"objects": [
                {"kind": "basketball", "radius": 0.12, "track": [[0.2, 1.0, -0.3], None]},
                {"kind": "hoop", "rim": [0, 3.05, -4.5], "facing": [0, 0, 1]}]}))
            self.assertAlmostEqual(min(measure(b, dream)), 0.045, delta=0.006)
            main([str(b), "--write"])
            d = json.loads((b / "dream.json").read_text())
            self.assertAlmostEqual(min(measure(b, d)), 0.0, delta=0.002)
            self.assertAlmostEqual(read_spz(b / "frames/000000.reality.spz").means[:, 1].min(),
                                   read_spz(b / "frames/000000.spz").means[:, 1].min(), delta=1e-3)
            dy = d["metrics"]["floorShift"]
            self.assertAlmostEqual(dy, -0.045, delta=0.006)
            self.assertAlmostEqual(d["placement"]["t"][1], 0.01 + dy, places=4)
            self.assertAlmostEqual(d["bounds"]["min"][1], 0.04 + dy, places=3)
            j = json.loads((b / "joints.json").read_text())
            self.assertAlmostEqual(j["frames"][0][0][1], 0.98 + dy, places=4)
            props = json.loads((b / "props.json").read_text())["objects"]
            self.assertAlmostEqual(props[0]["track"][0][1], 1.0 + dy, places=3)
            self.assertIsNone(props[0]["track"][1])
            self.assertEqual(props[1]["rim"], [0, 3.05, -4.5])  # the hoop is on the real floor: it never moves


if __name__ == "__main__":
    unittest.main()
