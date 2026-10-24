"""export --placement-from: a re-reconstruction placed exactly in an earlier bundle's space. Run from repo root:
PYTHONPATH=pipeline python3 -m unittest discover -s pipeline/tests -v."""

import json
import math
from pathlib import Path
import tempfile
import unittest

import numpy as np

from lucid import export
from lucid.gaussians import Gaussians

OLD = {"rot": [[-0.99642519, 0.0, 0.08447986], [0.0, 1.0, 0.0], [-0.08447986, 0.0, -0.99642519]],
       "t": [-0.092179, 0.007401, -0.044344]}


def dream_with(placement) -> Path:
    tmp = Path(tempfile.mkdtemp())
    (tmp / "dream.json").write_text(json.dumps({"id": "old", "placement": placement}))
    return tmp / "dream.json"


def person(offset=(0.0, 0.0, 0.0), n=400):
    rng = np.random.default_rng(1)
    means = (rng.normal(scale=0.2, size=(n, 3)) + offset).astype(np.float32)
    means[:, 1] = rng.uniform(0.7, 2.5, n)  # standing on a world floor at y = 0.7
    z = np.zeros((n, 3), np.float32)
    return Gaussians(means, z, np.tile([1, 0, 0, 0], (n, 1)).astype(np.float32), np.full(n, 5.0, np.float32), z,
                     np.zeros((n, 0, 3), np.float32))


class PlacementFrom(unittest.TestCase):
    def test_reuses_the_old_placement_exactly(self):
        rot, t, placed_by = export.placement_from(dream_with(OLD))
        self.assertEqual(placed_by, OLD)  # written back unchanged: the new bundle names the same space
        np.testing.assert_array_equal(rot, np.asarray(OLD["rot"]))
        np.testing.assert_array_equal(t, np.asarray(OLD["t"]))

    def test_a_moved_person_keeps_the_old_space(self):
        # the new reconstruction sits 3 cm off the old one: frame 0's own placement would re-centre it and move every
        # joint, ball and step target with it; the reused one maps the world exactly as before
        world = np.array([[0.1, 1.2, -0.3]])
        rot, t, _ = export.placement_from(dream_with(OLD))
        moved = export.place(person((0.03, 0.0, 0.0)), rot, t)
        g = person((0.03, 0.0, 0.0))
        np.testing.assert_allclose(moved.means, g.means @ rot.T + t, atol=1e-5)
        np.testing.assert_allclose((world @ rot.T + t)[0], np.asarray(OLD["rot"]) @ world[0] + np.asarray(OLD["t"]))
        own_rot, own_t = export.placement(g, None)
        self.assertGreater(float(np.abs(own_t - t).max()), 0.01)

    def test_refuses_a_bundle_without_placement(self):
        with self.assertRaises(SystemExit):
            export.placement_from(dream_with(None))

    def test_refuses_a_tilt(self):
        c, s = math.cos(0.2), math.sin(0.2)
        tilted = {"rot": [[1, 0, 0], [0, c, -s], [0, s, c]], "t": [0, 0, 0]}
        with self.assertRaises(SystemExit):
            export.placement_from(dream_with(tilted))

    def test_parse_args(self):
        a = export.parse_args(["--recon", "r", "--out", "o", "--id", "x", "--name", "X", "--placement-from", "d.json"])
        self.assertEqual(a.placement_from, Path("d.json"))
        self.assertIsNone(export.parse_args(["--recon", "r", "--out", "o", "--id", "x", "--name", "X"]).placement_from)


if __name__ == "__main__":
    unittest.main()
