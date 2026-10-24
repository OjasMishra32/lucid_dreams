"""assemble_colour.py: sRGB <-> linear <-> CIELAB, CIEDE2000, the affine colour fit and its use on splat colours."""

import math
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import assemble_colour as col  # noqa: E402
import assemble_splats as sp  # noqa: E402
from test_assemble import look  # noqa: E402


class Colour(unittest.TestCase):
    def test_ciede2000_matches_sharmas_reference_pairs(self):
        # G. Sharma, W. Wu, E. N. Dalal (2005), the CIEDE2000 test data, pairs 1, 2 and 4
        a = np.array([[50.0, 2.6772, -79.7751], [50.0, 3.1571, -77.2803], [50.0, -1.3802, -84.2814]])
        b = np.array([[50.0, 0.0, -82.7485], [50.0, 0.0, -82.7485], [50.0, 0.0, -82.7485]])
        np.testing.assert_allclose(col.delta_e2000(a, b), [2.0425, 2.8615, 1.0000], atol=1e-4)

    def test_srgb_round_trips_and_white_is_l_100(self):
        x = np.random.default_rng(1).uniform(0, 1, (100, 3))
        np.testing.assert_allclose(col.linear_to_srgb(col.srgb_to_linear(x)), x, atol=1e-9)
        np.testing.assert_allclose(col.srgb_to_lab(np.array([[1.0, 1.0, 1.0]]))[0], [100.0, 0.0, 0.0], atol=0.01)

    def test_the_affine_fit_recovers_a_known_transform(self):
        rng = np.random.default_rng(2)
        src = rng.uniform(0, 1, (5000, 3))
        M = np.array([[0.9, 0.05, 0.0], [0.02, 1.1, -0.03], [0.0, 0.04, 0.95]])
        b = np.array([0.01, -0.02, 0.03])
        dst = src @ M.T + b
        dst[:100] += 0.5  # outliers (a ball, a hand over the body) the fit leaves out
        got_M, got_b = col.fit_affine(src, dst)
        np.testing.assert_allclose(got_M, M, atol=1e-3)
        np.testing.assert_allclose(got_b, b, atol=1e-3)

    def test_recolouring_moves_each_base_colour_through_the_transform(self):
        rng = np.random.default_rng(3)
        n = 50
        s = sp.Splats.new(rng.normal(size=(n, 3)).astype(np.float32), np.tile(np.float32([1, 0, 0, 0]), (n, 1)), np.full((n, 3), -4.0, np.float32),
                          np.full(n, 2.0, np.float32), rng.normal(0, 0.5, (n, 3)).astype(np.float32), rng.normal(0, 0.1, (n, 9)).astype(np.float32))
        same = col.recolour(s, np.eye(3), np.zeros(3))
        np.testing.assert_allclose(same.dc, s.dc, atol=1e-5)
        M, b = np.diag([0.8, 1.0, 1.2]), np.array([0.0, 0.01, 0.0])
        got = col.recolour(s, M, b)
        want = col.linear_to_srgb(np.clip(col.srgb_to_linear(s.rgb) @ M.T + b, 0, 1))
        np.testing.assert_allclose(got.rgb, want, atol=1e-4)
        np.testing.assert_allclose(got.rest, s.rest)  # the view-dependent band is left as it was

    def test_render_shows_the_view_dependent_band(self):
        # degree 1: one Gaussian whose red follows the view direction along x: seen from -x it is redder than from +x
        n = 1
        rest = np.zeros((n, 9), np.float32)
        rest[0, 2] = 0.8  # red channel, the third band-1 coefficient (weighs -x)
        s = sp.Splats.new(np.array([[0.0, 1.0, 0.0]], np.float32), np.float32([[1, 0, 0, 0]]), np.full((n, 3), math.log(0.05), np.float32),
                          np.full(n, 6.0, np.float32), np.zeros((n, 3), np.float32), rest)
        from_minus = look(np.array([-20.0, 1.0, 0.0]), [0.0, 1.0, 0.0], w=101, h=101, f=2000.0)
        from_plus = look(np.array([20.0, 1.0, 0.0]), [0.0, 1.0, 0.0], w=101, h=101, f=2000.0)
        r_minus = sp.render(s, from_minus)[0][50, 50, 0]
        r_plus = sp.render(s, from_plus)[0][50, 50, 0]
        # direction camera -> Gaussian is +x from -x: -x * 0.8 * C1 lowers red; from +x it raises it
        self.assertAlmostEqual(float(r_minus), (0.5 - sp.C1 * 0.8) * 0.997, delta=0.01)
        self.assertAlmostEqual(float(r_plus), (0.5 + sp.C1 * 0.8) * 0.997, delta=0.01)


if __name__ == "__main__":
    unittest.main()


class Match(unittest.TestCase):
    def scene(self):
        rng = np.random.default_rng(4)
        n = 4000
        P = rng.normal(scale=0.15, size=(n, 3)) + [0.0, 1.0, 0.0]
        dc = ((rng.uniform(0.2, 0.8, (n, 3)) - 0.5) / sp.C0).astype(np.float32)
        s = sp.Splats.new(P.astype(np.float32), np.tile(np.float32([1, 0, 0, 0]), (n, 1)), np.full((n, 3), math.log(0.02), np.float32),
                          np.full(n, 3.0, np.float32), dc)
        cam = look(np.array([0.0, 1.0, -6.0]), [0.0, 1.0, 0.0], w=160, h=160, f=400.0)
        return s, cam

    def test_a_cast_is_measured_fitted_and_taken_out(self):
        import assemble as A

        s, cam = self.scene()
        M, b = np.diag([0.75, 0.95, 1.15]), np.array([0.02, 0.0, -0.01])
        ref, _ = sp.render(col.recolour(s, M, b), cam)  # the "video": the same body under another grade
        mask = sp.render(s, cam)[1] > 0.5
        fixed, rep = A.colour_match(s, cam, ref, mask)
        self.assertGreater(rep["before"]["deltaE"]["p90"], 5)
        self.assertIsNotNone(fixed)
        self.assertLess(rep["after"]["deltaE"]["median"], 1.0)
        self.assertLess(rep["after"]["deltaE"]["p90"], rep["before"]["deltaE"]["p90"] / 3)
        self.assertEqual(len(rep["fit"]["M"]), 3)

    def test_a_close_match_is_left_alone(self):
        import assemble as A

        s, cam = self.scene()
        ref, al = sp.render(s, cam)
        fixed, rep = A.colour_match(s, cam, ref, al > 0.5)
        self.assertIsNone(fixed)
        self.assertLess(rep["before"]["deltaE"]["median"], 0.5)
        self.assertNotIn("after", rep)

    def test_a_fit_that_does_not_help_is_not_applied(self):
        """Texture a few pixels off (no colour change at all) can't be fixed by a colour transform: the fit is measured,
        found no better, and rejected; the splats stay as they were."""
        import assemble as A

        s, cam = self.scene()
        ref, al = sp.render(s, cam)
        ref = np.roll(ref, 3, axis=1)  # the picture sits 3 px over
        fixed, rep = A.colour_match(s, cam, ref, al > 0.5)
        self.assertIsNone(fixed)
        if "after" in rep:
            self.assertTrue(rep["fit"]["rejected"])
