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
        W, H = sp.floor_size(rect, 64)
        self.assertEqual(shadow.shape, (H, W, 4))
        self.assertAlmostEqual(H / W, (rect[3] - rect[1]) / (rect[2] - rect[0]), delta=0.03)  # square pixels
        # the image runs minX -> maxX left to right, minZ -> maxZ top to bottom
        col = int((1.0 - rect[0]) / (rect[2] - rect[0]) * (W - 1))
        row = int((2.0 - rect[1]) / (rect[3] - rect[1]) * (H - 1))
        self.assertGreater(shadow[row, col, 3], 100)
        self.assertLess(shadow[0, 0, 3], 5)
        self.assertTrue(np.all(shadow[..., :3] == 0))


class Proxy(unittest.TestCase):
    def one(self, centre, scales, alpha=0.9, quat=(1.0, 0.0, 0.0, 0.0)) -> sp.Splats:
        return sp.Splats.new(np.array([centre], np.float32), np.array([quat], np.float32), np.log(np.array([scales], np.float32)),
                             np.array([math.log(alpha / (1 - alpha))], np.float32), np.zeros((1, 3), np.float32))

    def test_coverage_is_each_gaussians_projected_footprint(self):
        # one Gaussian 20 m down the axis, 1 cm by 4 cm across the view: its footprint is 10 x 40 px (sigma) at f 20000
        cam = look(np.array([0.0, 1.0, -20.0]), [0.0, 1.0, 0.0], w=400, h=400, f=20000.0)
        s = self.one([0.0, 1.0, 0.0], [0.04, 0.01, 0.001], alpha=0.9)
        box = (0.0, 0.0, 400.0, 400.0)
        cov = sp.coverage_image(s, cam, box, 400, 400)
        c = 200  # the centre texel (pixel centres at i + 0.5 - 0.5 = i ... texel 200 holds pixel 199.5..200.5)
        self.assertAlmostEqual(cov[c, c], 0.9, delta=0.01)
        # one sigma out: alpha * exp(-1/2), 40 px along u (the 4 cm axis, world x is image u), 10 px along v
        self.assertAlmostEqual(cov[c, c + 40], 0.9 * math.exp(-0.5), delta=0.02)
        self.assertAlmostEqual(cov[c + 10, c], 0.9 * math.exp(-0.5), delta=0.03)
        self.assertLess(cov[c + 40, c], 0.01)
        # two overlapping: 1 - (1 - a)(1 - b), whatever the order
        two = sp.Splats(np.concatenate([s.table, self.one([0.0, 1.0, 0.5], [0.04, 0.01, 0.001], alpha=0.5).table]))
        self.assertAlmostEqual(sp.coverage_image(two, cam, box, 400, 400)[c, c], 1 - 0.1 * 0.5, delta=0.01)

    def test_render_composites_front_to_back(self):
        cam = look(np.array([0.0, 1.0, -20.0]), [0.0, 1.0, 0.0], w=200, h=200, f=20000.0)
        near = self.one([0.0, 1.0, 0.0], [0.01, 0.01, 0.01], alpha=0.6)
        far = self.one([0.0, 1.0, 0.5], [0.01, 0.01, 0.01], alpha=0.9)
        red, green = np.float32([(1 - 0.5) / sp.C0, (0 - 0.5) / sp.C0, (0 - 0.5) / sp.C0]), np.float32([(0 - 0.5) / sp.C0, (1 - 0.5) / sp.C0, (0 - 0.5) / sp.C0])
        near.table["f_dc_0"], near.table["f_dc_1"], near.table["f_dc_2"] = red
        far.table["f_dc_0"], far.table["f_dc_1"], far.table["f_dc_2"] = green
        for both in (np.concatenate([near.table, far.table]), np.concatenate([far.table, near.table])):
            rgb, alpha = sp.render(sp.Splats(both), cam)
            np.testing.assert_allclose(rgb[100, 100], [0.6, 0.4 * 0.9, 0.0], atol=0.01)
            self.assertAlmostEqual(float(alpha[100, 100]), 1 - 0.4 * 0.1, delta=0.01)
        self.assertLess(float(alpha[0, 0]), 1e-6)

    def test_cap_keeps_the_largest_contributions(self):
        rng = np.random.default_rng(12)
        cam = look(np.array([0.0, 1.0, -20.0]), [0.0, 1.0, 0.0], w=400, h=400, f=20000.0)
        n = 1000
        P = rng.normal(scale=0.1, size=(n, 3)) + [0.0, 1.0, 0.0]
        sc = np.full((n, 3), math.log(0.002))
        sc[:100] = math.log(0.02)  # the hundred that matter: ten times wider
        logit = np.full(n, 2.0)
        logit[100:200] = 4.0  # opaque but tiny: alpha alone would keep these
        s = sp.Splats.new(P.astype(np.float32), np.tile(np.float32([1, 0, 0, 0]), (n, 1)), sc.astype(np.float32), logit.astype(np.float32), np.zeros((n, 3), np.float32))
        keep = sp.cap(s, cam, 150)
        self.assertEqual(int(keep.sum()), 150)
        self.assertTrue(keep[:100].all())
        np.testing.assert_array_equal(sp.cap(s, cam, 5000), np.ones(n, bool))

    def test_proxy_is_fine_at_the_silhouette_and_open_where_no_body_is(self):
        # two 0.3 m balls of splats 1 m apart, 20 m from the camera: the mesh covers each ball's front, nothing between
        rng = np.random.default_rng(11)
        cam = look(np.array([-15.0, 1.0, 0.0]), [5.0, 1.0, 0.0], w=3840, h=2160, f=20000.0)
        balls = []
        for z0 in (-0.5, 0.5):
            d = rng.normal(size=(30000, 3))
            balls.append(d / np.linalg.norm(d, axis=1, keepdims=True) * 0.3 + [5.0, 1.0, z0])
        P = np.concatenate(balls)
        n = len(P)
        s = sp.Splats.new(P.astype(np.float32), np.tile(np.float32([1, 0, 0, 0]), (n, 1)), np.full((n, 3), math.log(0.006), np.float32),
                          np.full(n, 4.0, np.float32), np.zeros((n, 3), np.float32))
        pos, idx, info = sp.proxy_mesh(s, cam, cell_m=0.004)
        self.assertLessEqual(info["cellM"], 0.0041)
        # the ray between the balls misses the mesh: no triangle covers that pixel
        u, v, z = cam.project(pos)
        tri = idx.reshape(-1, 3)
        cu, cv = u[tri].mean(1), v[tri].mean(1)
        mu, mv, _ = cam.project(np.array([5.0, 1.0, 0.0]))
        self.assertFalse(np.any((np.abs(cu - mu) < 20) & (np.abs(cv - mv) < 20)))
        # the front of a ball is where the mesh is: its nearest vertex on the ball's own axis ray, 0.3 m short of its centre
        bu, bv, _ = cam.project(np.array([5.0, 1.0, 0.5]))
        k = np.argmin((u - bu) ** 2 + (v - bv) ** 2)
        self.assertAlmostEqual(float(np.linalg.norm(pos[k] - cam.C)), float(np.linalg.norm(np.array([5.0, 1.0, 0.5]) - cam.C)) - 0.3, delta=0.02)
        # the silhouette: the mesh reaches the ball's edge (0.3 m, plus the splats' own half-width), not a cell beyond
        r_px = np.hypot(u - bu, v - bv)[np.hypot(u - bu, v - bv) < 0.5 * cam.f / 20.0]
        edge_px = 0.3 * cam.f / 20.0
        self.assertGreater(r_px.max(), edge_px)
        self.assertLess(r_px.max(), edge_px + 2.5 * 0.006 * cam.f / 20.0 + 2 * info["cellPx"])
        # and is light enough to ship
        self.assertLess(len(pos), 120_000)
        glb, ginfo = sp.proxy_glb(s, cam, cell_m=0.004, name="balls")
        gpos, gidx = sp.read_glb(glb)
        np.testing.assert_allclose(gpos, pos, atol=1e-5)
        self.assertEqual(ginfo["cellM"], info["cellM"])


if __name__ == "__main__":
    unittest.main()
