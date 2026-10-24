"""assemble_splats.py on synthetic Gaussians (no broadcast numbers). Run from the repo root:
python3 -I -m unittest discover -s pipeline/court -p 'test_assemble*.py' -v"""

import math
import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))  # pipeline/: lucid.gaussians writes the SPZ the export ships
import assemble_geom as g  # noqa: E402
import assemble_splats as sp  # noqa: E402
from lucid import gaussians as lg  # noqa: E402
from test_assemble import look, person  # noqa: E402

C0 = 0.28209479177387814
C1 = 0.4886025119029199


def splats_of(P, rng, rest_bands=3) -> sp.Splats:
    n = len(P)
    q = rng.normal(size=(n, 4))
    return sp.Splats.new(
        P.astype(np.float32), quats=(q / np.linalg.norm(q, axis=1, keepdims=True)).astype(np.float32),
        scales=np.log(np.full((n, 3), 0.01, np.float32)), opacity=np.full(n, 3.0, np.float32),
        dc=rng.normal(0, 0.5, (n, 3)).astype(np.float32), rest=rng.normal(0, 0.2, (n, 3 * rest_bands)).astype(np.float32))


def sh1_colour(s: sp.Splats, d) -> np.ndarray:
    """Per-Gaussian RGB for view direction d (unit), SH degree 1 as 3DGS evaluates it (before the +0.5)."""
    k = s.rest.shape[1] // 3
    r = s.rest.reshape(len(s), 3, k)  # channel-major
    x, y, z = d
    return C0 * s.dc + C1 * (-y * r[:, :, 0] + z * r[:, :, 1] - x * r[:, :, 2])


class Ply(unittest.TestCase):
    def test_round_trip_keeps_every_property(self):
        rng = np.random.default_rng(1)
        s = splats_of(person(rng, n=600), rng)
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "a.ply"
            sp.write_ply(p, s)
            t = sp.read_ply(p)
        self.assertEqual(t.names, s.names)
        for k in s.names:
            np.testing.assert_array_equal(t[k], s[k])

    def test_reads_the_lucid_writer(self):
        rng = np.random.default_rng(2)
        n = 50
        G = lg.Gaussians(rng.normal(size=(n, 3)).astype(np.float32), rng.normal(size=(n, 3)).astype(np.float32),
                         rng.normal(size=(n, 4)).astype(np.float32), rng.normal(size=n).astype(np.float32),
                         rng.normal(size=(n, 1, 3)).astype(np.float32), rng.normal(size=(n, 3, 3)).astype(np.float32))
        with tempfile.TemporaryDirectory() as d:
            lg.write_ply(Path(d) / "b.ply", G)
            s = sp.read_ply(Path(d) / "b.ply")
        np.testing.assert_array_equal(s.pos, G.means)
        np.testing.assert_array_equal(s.dc, G.sh0[:, 0])
        np.testing.assert_array_equal(s.rest.reshape(n, 3, 3), G.shN.transpose(0, 2, 1))


class Transform(unittest.TestCase):
    def test_similarity_moves_turns_and_scales(self):
        rng = np.random.default_rng(3)
        s = splats_of(person(rng, n=300), rng, rest_bands=3)
        M = g.quat_to_matrix(rng.normal(size=4))
        sim = g.Similarity(1.3, M, np.array([4.0, 0.2, -1.0]))
        t = s.transformed(sim)
        np.testing.assert_allclose(t.pos, sim.apply(s.pos), atol=1e-5)
        np.testing.assert_allclose(t.scales, s.scales + math.log(1.3), atol=1e-6)
        # each Gaussian's own axes turn with the world
        for i in range(5):
            Ri = g.quat_to_matrix(np.roll(s.quats[i], -1))  # (w, x, y, z) -> (x, y, z, w)
            Ti = g.quat_to_matrix(np.roll(t.quats[i], -1))
            np.testing.assert_allclose(Ti, M @ Ri, atol=1e-5)

    def test_view_dependent_colour_turns_with_the_world(self):
        rng = np.random.default_rng(4)
        s = splats_of(person(rng, n=200), rng, rest_bands=3)
        M = g.quat_to_matrix(rng.normal(size=4))
        t = s.transformed(g.Similarity(1.0, M, np.zeros(3)))
        d = rng.normal(size=3)
        d /= np.linalg.norm(d)
        np.testing.assert_allclose(sh1_colour(t, M @ d), sh1_colour(s, d), atol=1e-5)

    def test_higher_bands_are_cut_to_degree_one(self):
        rng = np.random.default_rng(5)
        s = splats_of(person(rng, n=100), rng, rest_bands=15)
        t = s.transformed(g.Similarity(1.0, np.eye(3), np.zeros(3)))
        self.assertEqual(t.rest.shape[1], 9)
        np.testing.assert_allclose(t.rest.reshape(-1, 3, 3), s.rest.reshape(-1, 3, 15)[:, :, :3], atol=1e-6)


class Spz(unittest.TestCase):
    def test_reality_marks_what_the_export_tinted(self):
        rng = np.random.default_rng(6)
        n = 400
        G = lg.Gaussians(rng.normal(size=(n, 3)).astype(np.float32), np.full((n, 3), -4.0, np.float32),
                         np.tile([1, 0, 0, 0], (n, 1)).astype(np.float32), np.full(n, 2.0, np.float32),
                         rng.normal(0, 0.6, (n, 1, 3)).astype(np.float32), np.zeros((n, 3, 3), np.float32))
        seen = rng.uniform(size=n) < 0.6
        blue = (np.array([0.0, 0.44, 0.89]) - 0.5) / C0
        tint = G.sh0.copy()
        tint[~seen, 0] = 0.35 * tint[~seen, 0] + 0.65 * blue
        R = lg.Gaussians(G.means, G.scales, G.quats, G.opacities, tint.astype(np.float32), np.zeros((n, 0, 3), np.float32))
        with tempfile.TemporaryDirectory() as d:
            lg.write_spz(Path(d) / "n.spz", G, sh_degree=0)
            lg.write_spz(Path(d) / "r.spz", R, sh_degree=0)
            lg.write_ply(Path(d) / "f.ply", G)
            s = sp.read_ply(Path(d) / "f.ply")
            got = sp.seen_from_spz(s, Path(d) / "r.spz", Path(d) / "n.spz")
            got_alone = sp.seen_from_spz(s, Path(d) / "r.spz")
        # a Gaussian whose colour is already near the tint can't be told apart: allow a handful
        self.assertGreater((got == seen).mean(), 0.97)
        self.assertGreater((got_alone == seen).mean(), 0.97)
        r = sp.reality(s, got)
        np.testing.assert_allclose(r.dc[~got], 0.35 * s.dc[~got] + 0.65 * blue, atol=1e-5)
        np.testing.assert_array_equal(r.dc[got], s.dc[got])
        self.assertTrue(np.all(r.rest[~got] == 0))

    def test_order_mismatch_is_refused(self):
        rng = np.random.default_rng(7)
        n = 100
        G = lg.Gaussians(rng.normal(size=(n, 3)).astype(np.float32), np.zeros((n, 3), np.float32),
                         np.tile([1, 0, 0, 0], (n, 1)).astype(np.float32), np.zeros(n, np.float32),
                         np.zeros((n, 1, 3), np.float32), np.zeros((n, 0, 3), np.float32))
        with tempfile.TemporaryDirectory() as d:
            lg.write_spz(Path(d) / "r.spz", G)
            lg.write_ply(Path(d) / "f.ply", G.subset(np.arange(n)[::-1]))
            with self.assertRaises(ValueError):
                sp.seen_from_spz(sp.read_ply(Path(d) / "f.ply"), Path(d) / "r.spz")


class Body(unittest.TestCase):
    def test_capsules_find_torso_and_head(self):
        rng = np.random.default_rng(8)
        P = person(rng, n=8000, foot=(3.0, -1.0), height=2.0)
        caps = sp.body_capsules(P)
        self.assertEqual([c["part"] for c in caps], ["torso", "head"])
        head = caps[1]
        np.testing.assert_allclose(head["a"], [3.0, 1.86, -1.0], atol=0.05)
        self.assertAlmostEqual(head["r"], 0.11, delta=0.03)
        torso = caps[0]
        self.assertLess(abs(torso["a"][0] - 3.0) + abs(torso["a"][2] + 1.0), 0.05)
        self.assertGreater(torso["b"][1] - torso["a"][1], 0.4)

    def test_raised_arm_is_not_the_head(self):
        rng = np.random.default_rng(9)
        P = person(rng, n=8000, height=2.0)
        arm = np.stack([np.full(800, 0.45), np.linspace(1.6, 2.7, 800), np.zeros(800)], 1) + rng.normal(0, 0.03, (800, 3))
        caps = sp.body_capsules(np.concatenate([P, arm]))
        np.testing.assert_allclose(caps[1]["a"], [0.0, 1.86, 0.0], atol=0.06)

    def test_floor_maps_are_dark_under_the_feet(self):
        rng = np.random.default_rng(10)
        P = person(rng, n=4000, foot=(1.0, 2.0))
        rgb = np.full((len(P), 3), 0.5)
        rect = sp.floor_rect(P, pad=0.6)
        shadow, refl = sp.floor_maps(P, np.ones(len(P)), rgb, rect, size=64)
        self.assertEqual(shadow.shape, (64, 64, 4))
        # the image runs minX -> maxX left to right, minZ -> maxZ top to bottom
        col = int((1.0 - rect[0]) / (rect[2] - rect[0]) * 63)
        row = int((2.0 - rect[1]) / (rect[3] - rect[1]) * 63)
        self.assertGreater(shadow[row, col, 3], 100)
        self.assertLess(shadow[0, 0, 3], 5)
        self.assertTrue(np.all(shadow[..., :3] == 0))


class Proxy(unittest.TestCase):
    def test_depth_mesh_sits_on_the_front_surface(self):
        # a 0.4 m sphere of points 20 m in front of a camera: the mesh's centre vertex is on its near side
        rng = np.random.default_rng(11)
        d = rng.normal(size=(20000, 3))
        centre = np.array([5.0, 1.0, 0.0])
        P = d / np.linalg.norm(d, axis=1, keepdims=True) * 0.4 + centre
        cam = look(np.array([-15.0, 1.0, 0.0]), centre, w=3840, h=2160, f=20000.0)
        glb = sp.proxy_glb(P, np.ones(len(P)), cam, nu=16, nv=16, name="ball")
        pos, idx = sp.read_glb(glb)
        self.assertEqual(len(pos), 17 * 17)
        self.assertEqual(len(idx), 16 * 16 * 6)
        mid = pos[8 * 17 + 8]
        self.assertAlmostEqual(np.linalg.norm(mid - cam.C), 20.0 - 0.4, delta=0.03)
        # every vertex lies on the camera's ray through its grid pixel: its own pixel back
        u, v, z = cam.project(pos)
        self.assertTrue(np.all(z > 0))


if __name__ == "__main__":
    unittest.main()
