"""lucid.ball: the basketball tracked in the reconstruction. Run from repo root:
PYTHONPATH=pipeline python3 -m unittest discover -s pipeline/tests -v (needs numpy and scipy)."""

import unittest

import numpy as np

from lucid.ball import SH_C0, track_ball
from lucid.gaussians import Gaussians

ORANGE = np.array([0.75, 0.35, 0.2])
SKIN = np.array([0.85, 0.42, 0.3])
SHIRT = np.array([0.3, 0.5, 0.8])
NAMES = ['pelvis', 'left_hip', 'right_hip', 'spine1', 'left_knee', 'right_knee', 'spine2', 'left_ankle', 'right_ankle',
         'spine3', 'left_foot', 'right_foot', 'neck', 'left_collar', 'right_collar', 'head', 'left_shoulder',
         'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist']
FPS = 25.0


def shell(c, r, n, rng):
    u = rng.normal(size=(n, 3))
    return np.asarray(c) + r * u / np.linalg.norm(u, axis=1, keepdims=True)


def limb(a, b, r, n, rng):
    a, b = np.asarray(a, float), np.asarray(b, float)
    t = rng.uniform(0, 1, n)[:, None]
    return a + t * (b - a) + r * rng.normal(size=(n, 3)) * [1, 0, 1]


def frame(parts, rng):
    means = np.concatenate([p for p, _ in parts]).astype(np.float32)
    rgb = np.concatenate([np.tile(c, (len(p), 1)) for p, c in parts])
    n = len(means)
    z = np.zeros((n, 3), np.float32)
    return Gaussians(means, z, np.tile([1, 0, 0, 0], (n, 1)).astype(np.float32), np.full(n, 5.0, np.float32),
                     ((rgb - 0.5) / SH_C0)[:, None, :].astype(np.float32), np.zeros((n, 0, 3), np.float32))


def joints_at():
    j = {k: [0.0, 1.0, 0.0] for k in NAMES}
    j.update(head=[0, 1.6, 0], neck=[0, 1.45, 0], pelvis=[0, 0.95, 0], left_knee=[0.1, 0.5, 0], right_knee=[-0.1, 0.5, 0],
             left_hip=[0.1, 0.95, 0], right_hip=[-0.1, 0.95, 0], left_ankle=[0.1, 0.08, 0], right_ankle=[-0.1, 0.08, 0],
             left_foot=[0.1, 0.02, -0.12], right_foot=[-0.1, 0.02, -0.12], left_shoulder=[0.18, 1.42, 0],
             right_shoulder=[-0.18, 1.42, 0], left_elbow=[0.3, 1.15, -0.1], right_elbow=[-0.25, 1.15, -0.1],
             left_wrist=[0.2, 1.0, -0.3], right_wrist=[-0.2, 1.0, -0.3])
    return [j[k] for k in NAMES]


def body(rng):
    """Orange-skinned shins, forearms and a face: what fooled the old finder."""
    return [(limb([0.1, 0.5, 0], [0.1, 0.1, 0], 0.035, 300, rng), SKIN), (limb([-0.1, 0.5, 0], [-0.1, 0.1, 0], 0.035, 300, rng), SKIN),
            (limb([0.3, 1.15, -0.1], [0.2, 1.0, -0.3], 0.03, 200, rng), SKIN),
            (shell([0, 1.69, 0], 0.09, 400, rng), SKIN), (limb([0, 1.0, 0], [0, 1.4, 0], 0.12, 600, rng), SHIRT)]


class Track(unittest.TestCase):
    def test_follows_the_held_ball_not_skin(self):
        rng = np.random.default_rng(1)
        frames, joints, truth = [], [], []
        for f in range(30):
            ball = np.array([0.0, 1.05 + 0.01 * np.sin(f), -0.42])  # held in front of the hands, moving a little
            truth.append(ball)
            frames.append(frame(body(rng) + [(shell(ball, 0.12, 700, rng), ORANGE)], rng))
            joints.append(joints_at())
        out = track_ball(frames, FPS, {"names": NAMES, "frames": joints, "fps": FPS})
        self.assertIsNotNone(out)
        known = [(f, x) for f, x in enumerate(out["track"]) if x is not None]
        self.assertGreater(len(known), 25)
        for f, x in known:
            self.assertLess(np.linalg.norm(np.array(x) - truth[f]), 0.03, f)

    def test_without_a_ball_skin_is_never_a_ball(self):
        rng = np.random.default_rng(2)
        frames = [frame(body(rng), rng) for _ in range(20)]
        self.assertIsNone(track_ball(frames, FPS, {"names": NAMES, "frames": [joints_at()] * 20, "fps": FPS}))

    def test_a_hovering_blob_away_from_the_hands_goes(self):
        rng = np.random.default_rng(3)
        frames = [frame(body(rng) + [(shell([0.6, 1.2, -0.6], 0.12, 700, rng), ORANGE)], rng) for _ in range(20)]
        self.assertIsNone(track_ball(frames, FPS, {"names": NAMES, "frames": [joints_at()] * 20, "fps": FPS}))

    def test_a_falling_ball_stays(self):
        rng = np.random.default_rng(4)
        frames, truth = [], []
        for f in range(12):
            t = f / FPS
            ball = np.array([0.7, 2.0 + 1.0 * t - 4.9 * t * t, -0.7])
            truth.append(ball)
            frames.append(frame(body(rng) + [(shell(ball, 0.12, 700, rng), ORANGE)], rng))
        out = track_ball(frames, FPS, {"names": NAMES, "frames": [joints_at()] * 12, "fps": FPS})
        self.assertIsNotNone(out)
        self.assertGreaterEqual(sum(x is not None for x in out["track"]), 10)

    def test_a_one_frame_flicker_and_a_teleport_go(self):
        rng = np.random.default_rng(5)
        frames = []
        for f in range(20):
            parts = body(rng) + [(shell([0.0, 1.1, -0.42], 0.12, 700, rng), ORANGE)] if f < 15 else body(rng)
            if f == 18:
                parts += [(shell([0.5, 0.3, -0.5], 0.12, 700, rng), ORANGE)]
            frames.append(frame(parts, rng))
        out = track_ball(frames, FPS, {"names": NAMES, "frames": [joints_at()] * 20, "fps": FPS})
        self.assertEqual([f for f, x in enumerate(out["track"]) if x is not None], list(range(15)))

    def test_without_joints_the_ball_is_still_tracked(self):
        rng = np.random.default_rng(6)
        frames = [frame([(shell([0.0, 1.05, -0.42], 0.12, 700, rng), ORANGE),
                         (limb([0, 1.0, 0], [0, 1.4, 0], 0.12, 600, rng), SHIRT)], rng) for _ in range(10)]
        out = track_ball(frames, FPS)
        self.assertEqual(sum(x is not None for x in out["track"]), 10)
        self.assertEqual(out["source"], "reconstruction")


if __name__ == "__main__":
    unittest.main()
