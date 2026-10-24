"""props.json from the export. Run from repo root: PYTHONPATH=pipeline python3 -m unittest discover -s pipeline/tests -v."""

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from lucid import export
from lucid.gaussians import Gaussians


def person(n=600):
    rng = np.random.default_rng(0)
    means = rng.normal(scale=0.2, size=(n, 3)).astype(np.float32)
    means[:, 1] = rng.uniform(0, 1.8, n)
    z = np.zeros((n, 3), np.float32)
    return Gaussians(means, z, np.tile([1, 0, 0, 0], (n, 1)).astype(np.float32), np.full(n, 5.0, np.float32), z,
                     np.zeros((n, 0, 3), np.float32))


BALL = {"kind": "basketball", "radius": 0.12, "track": [[0.2, 1.0, -0.3], None]}


class ShotProps(unittest.TestCase):
    def test_ball_goes_in_with_the_hoop(self):
        props = export.shot_props([person()], "teach me this jump shot", 25.0, ball=BALL)
        self.assertEqual([o["kind"] for o in props["objects"]], ["basketball", "hoop"])
        self.assertEqual(props["objects"][0], BALL)

    def test_no_ball_keeps_the_hoop_alone(self):
        props = export.shot_props([person()], "jump shot", 25.0)
        self.assertEqual([o["kind"] for o in props["objects"]], ["hoop"])

    def test_not_a_shot_no_props(self):
        self.assertIsNone(export.shot_props([person()], "teach me this strum", 25.0, ball=BALL))


class BallObject(unittest.TestCase):
    def test_no_result_dir_no_ball(self):
        self.assertIsNone(export.ball_object(None, np.eye(3), np.zeros(3), 4))

    def test_bundle_transform_is_rot_then_t(self):
        rot = np.array([[0.0, 0, 1], [0, 1, 0], [-1, 0, 0]])
        t = np.array([0.1, -0.2, 0.3])
        with tempfile.TemporaryDirectory() as tmp, patch("lucid_avatars.ball_props.basketball_object",
                                                         return_value=BALL) as call:
            self.assertEqual(export.ball_object(Path(tmp), rot, t, 4), BALL)
        result, M, n = call.call_args.args
        self.assertEqual((result, n), (Path(tmp), 4))
        np.testing.assert_allclose(M[:3, :3], rot)
        np.testing.assert_allclose(M[:3, 3], t)
        np.testing.assert_allclose(M[3], [0, 0, 0, 1])

    def test_a_failing_ball_never_fails_the_export(self):
        with tempfile.TemporaryDirectory() as tmp, patch("lucid_avatars.ball_props.basketball_object",
                                                         side_effect=RuntimeError("no GPU")):
            self.assertIsNone(export.ball_object(Path(tmp), np.eye(3), np.zeros(3), 4))


if __name__ == "__main__":
    unittest.main()
