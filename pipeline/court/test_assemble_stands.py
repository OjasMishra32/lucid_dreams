"""assemble_stands.py on a synthetic arena: two calibrated cameras a few metres apart look at a textured wall of
"stands" behind the far baseline; matching and triangulating their frames must find the wall. Run from the repo root:
python3 -I -m unittest discover -s pipeline/court -p 'test_assemble*.py' -v"""

import os
import sys
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import assemble_geom as g  # noqa: E402
import assemble_stands as st  # noqa: E402
from test_assemble import look  # noqa: E402

W, H = 1280, 720


def render_wall(cam: g.Cam, texture: np.ndarray, x0: float, z: tuple, y: tuple, k1: float = 0.0) -> np.ndarray:
    """The image of a vertical wall x = x0 (z from z[0] to z[1], y from y[0] to y[1]) wearing `texture`, through a
    pinhole camera with radial distortion k1 (xd = xn (1 + k1 r^2))."""
    th, tw = texture.shape[:2]
    u, v = np.meshgrid(np.arange(cam.w, dtype=np.float64), np.arange(cam.h, dtype=np.float64))
    xd, yd = (u - cam.cx) / cam.f, (v - cam.cy) / cam.f
    xn, yn = st.undistort(xd, yd, k1)
    d = np.stack([xn, yn, np.ones_like(xn)], -1) @ cam.R.T
    s = (x0 - cam.C[0]) / d[..., 0]
    P = cam.C + s[..., None] * d
    mu = ((P[..., 2] - z[0]) / (z[1] - z[0]) * (tw - 1)).astype(np.float32)
    mv = ((y[1] - P[..., 1]) / (y[1] - y[0]) * (th - 1)).astype(np.float32)
    return cv2.remap(texture, mu, mv, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)


class Stands(unittest.TestCase):
    def test_two_cameras_find_the_wall_behind_the_baseline(self):
        rng = np.random.default_rng(1)
        # crowd-sized detail (~20 cm), so each camera sees it at several pixels
        tex = cv2.resize(rng.uniform(0, 255, (45, 120, 3)).astype(np.uint8), (2400, 900), interpolation=cv2.INTER_CUBIC)
        target = np.array([16.0, 2.5, 0.5])
        a = look(np.array([-16.5, 0.8, 2.8]), target, w=W, h=H, f=1100.0)
        b = look(np.array([-17.5, 0.9, -2.8]), target, w=W, h=H, f=1000.0)
        k1 = 0.3
        ia = render_wall(a, tex, 17.0, (-12.0, 12.0), (0.0, 9.0), k1)
        ib = render_wall(b, tex, 17.0, (-12.0, 12.0), (0.0, 9.0), k1)
        X, err = st.triangulate_frames(ia, st.CalCam(a, k1), ib, st.CalCam(b, k1))
        self.assertGreater(len(X), 200)
        self.assertLess(np.median(err), 1.0)
        self.assertAlmostEqual(float(np.median(X[:, 0])), 17.0, delta=0.15)
        planes, rep = st.stands_planes(X)
        self.assertEqual(len(planes), 2)
        front, upper = (np.array(p["points"]) for p in planes)
        self.assertTrue(np.all(np.abs(front[:, 0] - 17.0) < 0.15))
        self.assertEqual(front[0][1], 0.0)  # it reaches down to the floor
        self.assertTrue(rep["upper"]["fit"])
        self.assertTrue(np.all(np.abs(upper[:, 0] - 17.0) < 0.5))  # a wall: the upper part doesn't lean back
        self.assertLess(front[0][2], front[1][2])  # bottom-left is at -z: left as seen from the court


class Parallax(unittest.TestCase):
    def test_rays_too_close_to_parallel_are_dropped(self):
        rng = np.random.default_rng(2)
        tex = cv2.resize(rng.uniform(0, 255, (45, 120, 3)).astype(np.uint8), (2400, 900), interpolation=cv2.INTER_CUBIC)
        target = np.array([16.0, 2.5, 0.5])
        a = look(np.array([-16.5, 0.8, 2.8]), target, w=W, h=H, f=1100.0)
        b = look(np.array([-16.5, 0.8, 2.801]), target, w=W, h=H, f=1100.0)  # a 1 mm baseline: no depth to be had
        ia = render_wall(a, tex, 17.0, (-12.0, 12.0), (0.0, 9.0))
        ib = render_wall(b, tex, 17.0, (-12.0, 12.0), (0.0, 9.0))
        X, err = st.triangulate_frames(ia, st.CalCam(a, 0.0), ib, st.CalCam(b, 0.0))
        self.assertEqual(len(X), 0)

    def test_too_few_points_give_a_flagged_guess(self):
        planes, rep = st.stands_planes(np.zeros((0, 3)))
        self.assertTrue(rep["guessed"])
        self.assertEqual(len(planes), 2)


if __name__ == "__main__":
    unittest.main()
