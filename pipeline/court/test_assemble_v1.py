"""The pair's spike carve, the head-protected cut, the extras' shared budget and the depth anchor, on synthetic bodies
(no broadcast numbers). Run from the repo root:
python3 -I -m unittest discover -s pipeline/court -p 'test_assemble*.py' -v"""

import os
import sys
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import assemble as A  # noqa: E402
import assemble_carve as cv  # noqa: E402
import assemble_geom as g  # noqa: E402
import assemble_splats as sp  # noqa: E402
from test_assemble import person  # noqa: E402


def ring_view(P_body, yaw_deg: float, W: int = 360, H: int = 640, f: float = 900.0):
    """A generated view as the recon's ring has it: a camera 3.5 m out at body height, a grey background whose
    brightness changes by row (wall, then floor), the body drawn in its own colour (an image, 0-1 RGB)."""
    a = np.radians(yaw_deg)
    C = np.array([3.5 * np.sin(a), 1.0, 3.5 * np.cos(a)])
    cam = A.look_from(C, [0.0, 1.0, 0.0], f, W, H)
    rows = np.linspace(0.42, 0.30, H)[:, None, None]
    img = np.broadcast_to(rows, (H, W, 3)).copy()
    u, v, z = cam.project(P_body)
    ui, vi = np.round(u).astype(int), np.round(v).astype(int)
    ok = (z > 0) & (ui >= 1) & (ui < W - 1) & (vi >= 1) & (vi < H - 1)
    for du in (-1, 0, 1):  # dense enough to read as a body
        for dv in (-1, 0, 1):
            img[vi[ok] + dv, ui[ok] + du] = [0.85, 0.62, 0.45]
    c2w = np.eye(4)
    c2w[:3, :3], c2w[:3, 3] = cam.R, cam.C
    return {"image": img, "camera_to_world": c2w, "K": cam.K, "name": f"yaw{yaw_deg:.0f}"}


class Carve(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(5)
        self.body = person(rng, n=6000, height=2.0)
        t = np.linspace(0, 1, 60)[:, None]
        self.needle = np.array([0.0, 2.05, 0.0]) + t * np.array([0.02, 0.15, 0.0])  # a thin spike off the head
        self.views = [ring_view(self.body, y) for y in (0, 90, 180, 270)]

    def test_a_spike_off_the_body_in_its_own_views_is_carved(self):
        P = np.concatenate([self.body, self.needle])
        off = cv.off_body(P, [cv.view_mask(v["image"]) | {k: v[k] for k in ("camera_to_world", "K")} for v in self.views])
        self.assertTrue(np.all(off[len(self.body):] >= 2), off[len(self.body):])
        self.assertLess(float(np.mean(off[: len(self.body)] >= 2)), 0.001)

    def test_the_mask_is_the_body_on_a_plain_background(self):
        m = cv.view_mask(self.views[0]["image"])["mask"]
        self.assertGreater(m.sum(), 1000)
        self.assertFalse(m[:20].any())  # the top rows are background
        self.assertFalse(m[:, :10].any())

    def test_views_off_the_image_count_nothing(self):
        P = np.array([[50.0, 1.0, 0.0]])
        view = cv.view_mask(self.views[0]["image"]) | {k: self.views[0][k] for k in ("camera_to_world", "K")}
        self.assertEqual(int(cv.off_body(P, [view])[0]), 0)


class ProtectedCut(unittest.TestCase):
    def test_the_top_eighth_seen_from_the_camera_is_kept_whole(self):
        rng = np.random.default_rng(6)
        P = person(rng, n=4000, height=2.0)
        cam = A.look_from([0.0, 1.0, -20.0], [0.0, 1.0, 0.0], 3000.0, 400, 640)
        head = A.head_box(P, cam)
        head_pts = np.linalg.norm(P - [0, 1.86, 0], axis=1) < 0.12
        self.assertGreater(float(head[head_pts].mean()), 0.95)
        self.assertFalse(head[P[:, 1] < 1.6].any())
        score = rng.uniform(0, 1, len(P))
        score[head] = 0.0  # the head would lose a plain cut
        keep = A.protected_top(score, head, 2000)
        self.assertEqual(int(keep.sum()), 2000)
        self.assertTrue(keep[head].all())

    def test_with_an_arm_raised_the_head_is_still_kept_and_floaters_are_not(self):
        rng = np.random.default_rng(9)
        body = person(rng, n=4000, height=2.0)
        t = rng.uniform(0, 1, 600)[:, None]
        arm = np.array([0.2, 1.55, 0.0]) + t * np.array([0.15, 0.85, 0.0])  # up past the head to 2.4 m
        floater = np.array([[0.0, 2.6, 0.0], [0.9, 2.35, 0.0]])
        P = np.concatenate([body, arm, floater])
        cam = A.look_from([0.0, 1.2, -20.0], [0.0, 1.2, 0.0], 3000.0, 400, 700)
        solid = np.concatenate([body, arm])
        keep, by = A.head_protect(P, cam, solid)
        head_pts = np.linalg.norm(P - [0, 1.86, 0], axis=1) < 0.12
        self.assertGreater(float(keep[head_pts].mean()), 0.95)
        self.assertTrue(keep[len(body):len(body) + len(arm)][arm[:, 1] > 2.3].all())  # the raised hand: the top eighth
        self.assertFalse(keep[-2:].any())
        self.assertIn("head capsule", by)

    def test_joints_protect_what_is_near_them(self):
        P = np.array([[0.0, 1.9, 0.0], [0.0, 1.0, 0.0], [0.5, 1.2, 0.0], [0.5, 1.31, 0.0]])
        near = A.near_joints(P, [[0.0, 1.95, 0.0], [0.5, 1.2, 0.0]], 0.15)
        np.testing.assert_array_equal(near, [True, False, True, True])

    def test_more_protected_than_the_cap_is_refused(self):
        with self.assertRaises(ValueError):
            A.protected_top(np.ones(10), np.ones(10, bool), 5)


class ExtrasBudget(unittest.TestCase):
    def test_a_shared_budget_keeps_each_extras_floor_then_the_most_visible(self):
        rng = np.random.default_rng(7)
        scores = {"near": rng.uniform(1, 2, 3000), "far": rng.uniform(0, 0.5, 3000), "small": rng.uniform(0, 1, 500)}
        keep, dropped = A.split_extras(scores, total=4000, floor=1000)
        self.assertEqual(dropped, [])
        self.assertEqual(sum(int(k.sum()) for k in keep.values()), 4000)
        self.assertEqual(int(keep["small"].sum()), 500)  # all it has, under the floor
        self.assertGreaterEqual(int(keep["far"].sum()), 1000)
        self.assertGreater(int(keep["near"].sum()), int(keep["far"].sum()))
        far = scores["far"]  # each keeps its own best
        self.assertGreaterEqual(far[keep["far"]].min(), far[~keep["far"]].max())

    def test_when_more_land_than_fit_the_least_visible_go(self):
        scores = {"a": np.full(3000, 3.0), "b": np.full(3000, 1.0), "c": np.full(3000, 2.0)}
        keep, dropped = A.split_extras(scores, total=2500, floor=1200)
        self.assertEqual(dropped, ["b"])
        self.assertEqual(sorted(keep), ["a", "c"])
        self.assertEqual(sum(int(k.sum()) for k in keep.values()), 2500)


class DepthAnchor(unittest.TestCase):
    def test_footref_moves_the_body_along_cameras_rays_without_moving_a_pixel(self):
        rng = np.random.default_rng(8)
        P = person(rng, n=3000, height=2.0, foot=(6.4, 1.0))
        C = np.array([-16.0, 0.8, 3.0])
        cam = A.look_from(C, [6.0, 1.0, 1.0], 20000.0, 3840, 2160)
        ref = np.array([6.0, 1.02])  # the true soles: the body stands 0.4 m too far along the rays
        sim0 = g.Similarity(1.0, np.eye(3), np.zeros(3))
        sim, info = A.depth_anchor(sim0, P, C, ref)
        Q = sim.apply(P)
        np.testing.assert_allclose(sp.contact_points_xz(Q), ref, atol=0.03)
        u0, v0, _ = cam.project(P)
        u1, v1, _ = cam.project(Q)
        self.assertLess(float(np.max(np.hypot(u1 - u0, v1 - v0))), 1e-6)
        self.assertAlmostEqual(info["liftM"], float(np.percentile(Q[:, 1], 0.5)), delta=0.003)
        self.assertGreater(info["movedM"], 0.3)
        self.assertLess(info["acrossM"], 0.05)


if __name__ == "__main__":
    unittest.main()
