"""lucid.clean: what a replay's cleanup drops, and how it writes. Run from repo root:
PYTHONPATH=pipeline python3 -m unittest discover -s pipeline/tests -v (needs numpy and scipy)."""

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from lucid.clean import (Settings, body_distance, capsules, load_keep, plan_bundle, plan_frame, save_keep, subset_spz,
                         write_bundle)
from lucid.gaussians import SH_C0, Gaussians, read_spz, write_spz

NAMES = ['pelvis', 'left_hip', 'right_hip', 'spine1', 'left_knee', 'right_knee', 'spine2', 'left_ankle', 'right_ankle',
         'spine3', 'left_foot', 'right_foot', 'neck', 'left_collar', 'right_collar', 'head', 'left_shoulder',
         'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist']


def standing():
    j = dict(pelvis=[0, 0.95, 0], left_hip=[0.1, 0.92, 0], right_hip=[-0.1, 0.92, 0], spine1=[0, 1.05, 0],
             left_knee=[0.1, 0.5, 0], right_knee=[-0.1, 0.5, 0], spine2=[0, 1.18, 0], left_ankle=[0.1, 0.08, 0],
             right_ankle=[-0.1, 0.08, 0], spine3=[0, 1.3, 0], left_foot=[0.1, 0.02, -0.12], right_foot=[-0.1, 0.02, -0.12],
             neck=[0, 1.45, 0], left_collar=[0.08, 1.4, 0], right_collar=[-0.08, 1.4, 0], head=[0, 1.6, 0],
             left_shoulder=[0.18, 1.42, 0], right_shoulder=[-0.18, 1.42, 0], left_elbow=[0.3, 1.15, 0],
             right_elbow=[-0.3, 1.15, 0], left_wrist=[0.35, 0.9, 0], right_wrist=[-0.35, 0.9, 0])
    return np.array([j[k] for k in NAMES], float)


def cloud(points, alpha=0.9, rng=None, colour=(0.6, 0.4, 0.3)):
    rng = rng or np.random.default_rng(0)
    n = len(points)
    a = np.clip(np.full(n, alpha), 1e-3, 1 - 1e-3)
    q = rng.normal(size=(n, 4))
    return Gaussians(np.asarray(points, np.float32), np.full((n, 3), np.log(0.008), np.float32), q.astype(np.float32),
                     np.log(a / (1 - a)).astype(np.float32),
                     np.tile((np.array(colour) - 0.5) / SH_C0, (n, 1)).reshape(n, 1, 3).astype(np.float32),
                     np.zeros((n, 0, 3), np.float32))


def body_points(rng, n=4000):
    """A rough person: a torso column and two legs, dense enough to be one piece on a 2 cm grid."""
    torso = np.c_[rng.uniform(-0.15, 0.15, n), rng.uniform(0.9, 1.6, n), rng.uniform(-0.1, 0.1, n)]
    legs = np.c_[rng.choice([-0.1, 0.1], n) + rng.uniform(-0.05, 0.05, n), rng.uniform(0.0, 0.92, n), rng.uniform(-0.05, 0.05, n)]
    return np.concatenate([torso, legs])


def concat(*gs):
    return Gaussians(*(np.concatenate([getattr(g, k) for g in gs]) for k in ("means", "scales", "quats", "opacities", "sh0", "shN")))


class Body(unittest.TestCase):
    def test_capsules_hold_the_joints_and_not_the_room(self):
        j = standing()
        d = body_distance(j, capsules(j))
        self.assertTrue((d < 0).all())
        far = np.array([[1.0, 1.0, 0.0], [0.0, 2.3, 0.0], [0.0, 1.0, 0.8]])
        self.assertTrue((body_distance(far, capsules(j)) > 0.3).all())


class Plan(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(3)
        self.body = cloud(body_points(rng), 0.9, rng)
        self.ghost = cloud(np.c_[rng.uniform(0.3, 0.4, 300), rng.uniform(0.2, 0.6, 300), rng.uniform(-0.05, 0.05, 300)], 0.08, rng)
        self.speck = cloud(np.c_[rng.uniform(0.9, 0.92, 20), rng.uniform(1.5, 1.52, 20), rng.uniform(0.5, 0.52, 20)], 0.9, rng)
        self.g = concat(self.body, self.ghost, self.speck)
        nb, ng = self.body.count, self.ghost.count
        n = self.g.count
        # the body: inside every silhouette, real and generated; the ghost and the speck: outside the real person and
        # inside the silhouette in only 20 and 3 of the 48 views
        self.sup = {"n": np.full(n, 48, np.uint8), "v": np.full(n, 47, np.uint8), "e": np.full(n, 47, np.uint8),
                    "r": np.ones(n, np.int8), "s": np.zeros(n, np.int8)}
        self.sup["v"][nb:nb + ng] = 20
        self.sup["e"][nb:nb + ng] = 20
        self.sup["v"][nb + ng:] = 3
        self.sup["r"][nb:] = 0
        self.slices = (slice(0, nb), slice(nb, nb + ng), slice(nb + ng, n))

    def settings(self, *tests):
        s = Settings()
        s.tests = tests
        return s

    def test_drops_ghost_and_speck_keeps_body(self):
        keep, why = plan_frame(self.g, standing(), None, self.sup, Settings())
        body, ghost, speck = self.slices
        self.assertTrue(keep[body].all())
        self.assertFalse(keep[ghost].any())
        self.assertFalse(keep[speck].any())
        self.assertEqual(why["kept"], self.body.count)
        self.assertEqual(why["outside"], self.ghost.count + self.speck.count)

    def test_one_camera_alone_never_drops(self):
        sup = {k: v.copy() for k, v in self.sup.items()}
        body, ghost, _ = self.slices
        sup["r"][body] = 0  # the real camera alone says outside: the generated views disagree, so it stays
        sup["v"][ghost] = 47  # the views alone say inside, the real camera outside: it stays too
        keep, _ = plan_frame(self.g, standing(), None, sup, self.settings("outside", "hull", "smear"))
        self.assertTrue(keep[body].all())
        self.assertTrue(keep[ghost].all())
        sup["r"][ghost] = 1  # the real camera says inside, the views (20 of 48) don't: stays
        sup["v"][ghost] = 20
        keep, _ = plan_frame(self.g, standing(), None, sup, self.settings("outside", "hull", "smear"))
        self.assertTrue(keep[ghost].all())

    def test_views_decide_where_the_real_camera_cannot_tell(self):
        sup = {k: v.copy() for k, v in self.sup.items()}
        sup["r"][:] = -1  # out of the clip's picture, or no camera solved
        keep, why = plan_frame(self.g, standing(), None, sup, self.settings("hull"))
        body, ghost, speck = self.slices
        self.assertTrue(keep[body].all())
        self.assertFalse(keep[ghost].any())  # 20 of 48 views: under half
        self.assertFalse(keep[speck].any())
        sup["s"][ghost] = 1  # seen on the surface by the real camera: never dropped
        keep, _ = plan_frame(self.g, standing(), None, sup, self.settings("hull"))
        self.assertTrue(keep[ghost].all())

    def test_the_ball_is_never_dropped(self):
        ball = self.g.means[self.slices[2]].mean(0)
        keep, _ = plan_frame(self.g, standing(), ball, self.sup, Settings())
        self.assertTrue(keep[self.slices[2]].all())

    def test_islands_without_cameras(self):
        keep, why = plan_frame(self.g, None, None, None, self.settings("island"))
        body, ghost, speck = self.slices
        self.assertTrue(keep[body].all())
        self.assertFalse(keep[speck].any())  # 20 Gaussians 70 cm away: a detached clump
        self.assertFalse(keep[ghost].any())  # 15 cm off the leg: detached too
        self.assertEqual(why["island"], self.speck.count + self.ghost.count)

    def test_a_clump_inside_every_silhouette_is_the_inside_not_a_speck(self):
        sup = {k: v.copy() for k, v in self.sup.items()}
        body, ghost, speck = self.slices
        sup["v"][speck] = 48
        keep, why = plan_frame(self.g, None, None, sup, self.settings("island"))
        self.assertTrue(keep[speck].all())
        self.assertFalse(keep[ghost].any())

    def test_smear_needs_faint_long_and_outside(self):
        g = cloud(np.zeros((5, 3)) + [0, 1.2, 0], 0.1)
        g.scales[:] = np.log(0.03)
        g.opacities[3] = 3.0  # solid: kept
        sup = {"n": np.full(5, 48, np.uint8), "v": np.full(5, 48, np.uint8), "e": np.array([10, 40, 10, 10, 10], np.uint8),
               "r": np.array([0, 0, -1, 0, 1], np.int8), "s": np.zeros(5, np.int8)}
        keep, why = plan_frame(g, None, None, sup, self.settings("smear"))
        self.assertEqual(keep.tolist(), [False, True, False, True, True])  # the last: inside the real person


class Files(unittest.TestCase):
    def test_subset_spz_is_exact(self):
        rng = np.random.default_rng(1)
        g = cloud(rng.uniform(-1, 1, (500, 3)), 0.5, rng)
        g.opacities[:] = rng.normal(size=500)
        g.shN = rng.normal(scale=0.2, size=(500, 3, 3)).astype(np.float32)
        keep = rng.random(500) > 0.3
        with tempfile.TemporaryDirectory() as d:
            src, dst = Path(d) / "a.spz", Path(d) / "b.spz"
            write_spz(src, g, sh_degree=1)
            subset_spz(src, dst, keep)
            full, part = read_spz(src), read_spz(dst)
            self.assertEqual(part.count, int(keep.sum()))
            for k in ("means", "scales", "quats", "opacities", "sh0", "shN"):
                np.testing.assert_array_equal(getattr(part, k), getattr(full, k)[keep])

    def test_keep_files_round_trip(self):
        keeps = {0: np.array([True, False, True]), 7: np.ones(1000, bool)}
        keeps[7][::3] = False
        with tempfile.TemporaryDirectory() as d:
            save_keep(Path(d) / "k.npz", keeps)
            back = load_keep(Path(d) / "k.npz")
        self.assertEqual(sorted(back), [0, 7])
        for i in keeps:
            np.testing.assert_array_equal(back[i], keeps[i])

    def test_write_bundle_keeps_reality_in_step_and_refuses_twice(self):
        rng = np.random.default_rng(2)
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "dreams"
            b = root / "test-replay"
            (b / "frames").mkdir(parents=True)
            frames = []
            for i in range(3):
                g = concat(cloud(body_points(rng), 0.9, rng), cloud(rng.uniform(1.5, 1.6, (30, 3)), 0.9, rng))
                write_spz(b / "frames" / f"{i:06d}.spz", g, sh_degree=0)
                t = cloud(g.means, 0.9, rng, colour=(0.0, 0.44, 0.89))
                t.opacities = g.opacities
                write_spz(b / "frames" / f"{i:06d}.reality.spz", t, sh_degree=0)
                frames.append(g)
            dream = {"id": "test-replay", "kind": "replay", "fps": 25, "frameCount": 3, "someoneElsesField": {"x": 1},
                     "frames": {"dir": "frames", "pattern": "%06d.ply", "spz": "%06d.spz", "reality": "%06d.reality.spz",
                                "gaussiansPerFrame": frames[0].count},
                     "metrics": {"psnr": 25.0}}
            (b / "dream.json").write_text(json.dumps(dream))
            s = Settings()
            s.tests = ("island",)
            keeps, whys = plan_bundle(b, s, jobs=1)
            self.assertTrue(all((~k).sum() == 30 for k in keeps.values()))
            write_bundle(b, keeps, whys, s, {"check": {"real.psnr": [25.0, 25.1]}})
            out = json.loads((b / "dream.json").read_text())
            self.assertEqual(out["someoneElsesField"], {"x": 1})
            self.assertEqual(out["metrics"]["psnr"], 25.0)
            self.assertEqual(out["metrics"]["cleanup"]["dropped"], 90)
            self.assertEqual(out["metrics"]["cleanup"]["check"], {"real.psnr": [25.0, 25.1]})
            self.assertEqual(out["frames"]["gaussiansPerFrame"], frames[0].count - 30)
            for i in range(3):
                a = read_spz(b / "frames" / f"{i:06d}.spz")
                r = read_spz(b / "frames" / f"{i:06d}.reality.spz")
                self.assertEqual(a.count, frames[i].count - 30)
                np.testing.assert_array_equal(a.means, r.means)
                self.assertTrue((root / ".clean-backup" / "test-replay" / "frames" / f"{i:06d}.reality.spz").exists())
                self.assertEqual(read_spz(root / ".clean-backup" / "test-replay" / "frames" / f"{i:06d}.spz").count,
                                 frames[i].count)
            with self.assertRaises(SystemExit):
                write_bundle(b, keeps, whys, s)


if __name__ == "__main__":
    unittest.main()
