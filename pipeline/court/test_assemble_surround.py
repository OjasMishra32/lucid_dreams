"""assemble_surround.py on synthetic data only (no footage numbers): a made-up canvas, registration and show lens with a
known rotation, a made-up mosaic and a made-up stands wall. Run from the repo root:
python3 -I -m unittest discover -s pipeline/court -p 'test_assemble_surround*.py' -v"""

import json
import math
import os
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import assemble as A  # noqa: E402
import assemble_geom as geo  # noqa: E402
import assemble_surround as S  # noqa: E402

# a made-up camera: the canvas (a lens-free pinhole), the layers' registration of F (its own focal and lens, a small
# rotation off the canvas'), and the show's picture of F (another focal and lens)
F0, C0 = 4000.0, (1000.0, 800.0)
FF, K1F = 3100.0, 1.9
FB, K1S = 5600.0, 2.2
CB = (1919.5, 1079.5)
UP_RIGHT_FORWARD_X = np.array([[0.0, 0.0, 1.0], [0.0, -1.0, 0.0], [1.0, 0.0, 0.0]])  # camera looking along +x, world-from-camera


def rot(axis, deg):
    a = np.asarray(axis, float) / np.linalg.norm(axis)
    t = math.radians(deg)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + math.sin(t) * K + (1 - math.cos(t)) * K @ K


def canvas(R=None):
    return {"K": [[F0, 0, C0[0]], [0, F0, C0[1]], [0, 0, 1]], "R": (np.eye(3) if R is None else R).tolist()}


def chain(Rc=None, Rf=None) -> S.Chain:
    Rc = np.eye(3) if Rc is None else Rc
    return S.Chain(canvas(Rc), np.eye(3) if Rf is None else Rf, FF, K1F, FB, K1S, CB[0], CB[1])


def solve_radius(rd: float, k1: float) -> float:
    """r with r (1 + k1 r^2) = rd, by bisection (independent of the module's Newton steps)."""
    lo, hi = 0.0, max(rd, 1e-9)
    for _ in range(80):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if mid * (1 + k1 * mid * mid) < rd else (lo, mid)
    return (lo + hi) / 2


def expected_tangent(cu: float, cv: float, Rc, Rf) -> np.ndarray:
    """The show picture's tangent of a canvas pixel, step by step from the first principles in the module's docstring."""
    d = Rc.T @ np.array([(cu - C0[0]) / F0, (cv - C0[1]) / F0, 1.0])  # the canvas ray's world direction
    x = Rf @ d  # in the registration's camera
    t = x[:2] / x[2]
    td = t * (1 + K1F * (t @ t))  # through the registration's lens
    raw1080 = np.array([959.5, 539.5]) + FF * td
    raw4k = 2 * raw1080 + 0.5  # a 4K pixel is 2u + 0.5
    off = raw4k - np.array(CB)
    r = solve_radius(float(np.hypot(*off)) / FB, K1S)  # the show undistorted its raw 4K frame with this lens
    return off / max(float(np.hypot(*off)), 1e-12) * r


class ChainMaps(unittest.TestCase):
    def test_canvas_and_tangents_round_trip(self):
        for Rc, Rf in [(None, None), (rot([0.2, 1, 0.1], 20), rot([0.3, 0.9, 0.2], 20.4))]:
            ch = chain(Rc, Rf)
            rng = np.random.default_rng(3)
            cu, cv_ = rng.uniform(100, 1900, 50), rng.uniform(100, 1500, 50)
            nx, ny = ch.canvas_to_tangent(cu, cv_)
            bu, bv = ch.tangent_to_canvas(nx, ny)
            self.assertLess(float(np.abs(bu - cu).max()), 1e-6)
            self.assertLess(float(np.abs(bv - cv_).max()), 1e-6)

    def test_tangents_match_the_step_by_step_chain(self):
        Rc, Rf = rot([0.2, 1, 0.1], 20), rot([0.3, 0.9, 0.2], 20.4)
        ch = chain(Rc, Rf)
        for cu, cv_ in [(1000, 800), (300, 200), (1800, 1400), (1500, 300)]:
            nx, ny = ch.canvas_to_tangent(np.array([float(cu)]), np.array([float(cv_)]))
            want = expected_tangent(cu, cv_, Rc, Rf)
            self.assertLess(abs(nx[0] - want[0]) * FB, 1e-4)
            self.assertLess(abs(ny[0] - want[1]) * FB, 1e-4)


def dots_mosaic(points, size=(2000, 1600), sigma=3.0) -> np.ndarray:
    h, w = size[1], size[0]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    img = np.zeros((h, w), np.float32)
    for (u, v) in points:
        img += 250 * np.exp(-((xx - u) ** 2 + (yy - v) ** 2) / (2 * sigma ** 2))
    g = np.clip(img, 0, 255).astype(np.uint8)
    return cv2.merge([g, g, g])


def centroid(img: np.ndarray, near, r=25) -> tuple[float, float]:
    g = img[..., 0].astype(np.float64)
    x0, y0 = int(near[0]) - r, int(near[1]) - r
    sub = g[y0:y0 + 2 * r + 1, x0:x0 + 2 * r + 1]
    yy, xx = np.mgrid[y0:y0 + 2 * r + 1, x0:x0 + 2 * r + 1]
    return float((sub * xx).sum() / sub.sum()), float((sub * yy).sum() / sub.sum())


class FarImage(unittest.TestCase):
    def test_a_known_point_lands_where_the_chain_puts_it(self):
        """A dot on the canvas lands in the far picture within half a pixel of where the step-by-step chain puts it."""
        Rc, Rf = rot([0.2, 1, 0.1], 20), rot([0.3, 0.9, 0.2], 20.4)
        ch = chain(Rc, Rf)
        pts = [(1300.0, 700.0), (700.0, 1000.0), (1500.0, 1200.0)]
        mosaic = dots_mosaic(pts)
        cover = np.ones(mosaic.shape[:2], np.uint16)
        far = S.build_far(ch, mosaic, cover)
        for (cu, cv_) in pts:
            n = expected_tangent(cu, cv_, Rc, Rf)
            want = (far["cx"] + far["f"] * n[0], far["cy"] + far["f"] * n[1])
            got = centroid(far["image"], want)
            self.assertLess(math.hypot(got[0] - want[0], got[1] - want[1]), 0.5, (got, want))

    def test_it_fits_and_drops_what_was_never_filmed(self):
        ch = chain()
        mosaic = dots_mosaic([(1300.0, 700.0)])
        cover = np.zeros(mosaic.shape[:2], np.uint16)
        cover[300:1300, 500:1700] = 3  # filmed: a box in the middle
        far = S.build_far(ch, mosaic, cover, max_width=900, feather=8)
        self.assertLessEqual(far["width"], 900)
        self.assertEqual(far["image"].shape[:2], (far["height"], far["width"]))
        self.assertEqual(far["alpha"].shape, far["image"].shape[:2])
        a = far["alpha"]
        self.assertTrue(a[0].any() and a[-1].any() and a[:, 0].any() and a[:, -1].any())  # no all-uncovered edge rows or columns
        self.assertEqual(int(a.max()), 255)
        # native sharpness where it fits: a far pixel is about a canvas pixel at the middle
        wide = S.build_far(ch, mosaic, cover, max_width=4096)
        mid = ch.canvas_to_tangent(np.array([999.0, 1001.0]), np.array([800.0, 800.0]))[0]
        self.assertAlmostEqual(wide["f"] * float(mid[1] - mid[0]) / 2.0, 1.0, places=3)

    def test_the_far_picture_through_f_is_a_scale_and_a_shift(self):
        far = {"image": np.tile(np.arange(400, dtype=np.uint8)[None, :, None], (300, 1, 3)), "alpha": np.full((300, 400), 255, np.uint8),
               "f": 1000.0, "cx": 210.0, "cy": 150.0}
        cam = {"f": 2000.0, "cx": 100.0, "cy": 80.0, "width": 200, "height": 100}
        ren, al = S.render_far_in_f(far, cam)
        # F's pixel u sees tangent (u - 100) / 2000 = far pixel 210 + 1000 (u - 100) / 2000 = 160 + u / 2
        for u in (20, 100, 180):
            self.assertAlmostEqual(float(ren[50, u, 0]), 160 + u / 2, delta=1.0)
        self.assertEqual(int(al[50, 100]), 255)


class Cameras(unittest.TestCase):
    def test_a_camera_scaled_to_half_the_width_keeps_pixel_centres(self):
        cam = {"f": 5600.0, "cx": 1919.5, "cy": 1079.5, "width": 3840, "height": 2160}
        half = S.scaled_camera(cam, 1920)
        self.assertEqual((half["width"], half["height"], half["f"]), (1920, 1080, 2800.0))
        self.assertEqual((half["cx"], half["cy"]), (959.5, 539.5))


class Feather(unittest.TestCase):
    def test_alpha_ramps_inside_the_edge_and_is_zero_outside(self):
        cov = np.zeros((60, 100), bool)
        cov[10:50, 20:80] = True
        a = S.feather_alpha(cov, 8)
        self.assertEqual(int(a[30, 5]), 0)  # outside
        self.assertEqual(int(a[30, 50]), 255)  # deep inside
        self.assertEqual(int(a[30, 28]), 255)  # 9 px in
        ramp = [int(a[30, x]) for x in range(20, 29)]
        self.assertEqual(ramp, sorted(ramp))
        self.assertTrue(0 < ramp[0] < 60 and ramp[-1] == 255)
        self.assertAlmostEqual(ramp[4] / 255, 5 / 8, delta=0.05)  # the fifth covered pixel is 5 px from the uncovered one

    def test_the_image_edge_counts_as_uncovered(self):
        a = S.feather_alpha(np.ones((40, 40), bool), 8)
        self.assertLess(int(a[20, 0]), 60)
        self.assertEqual(int(a[20, 20]), 255)


def trivial_sight(distance=20.0) -> S.Sight:
    """Canvas pixel == tangent x f0 (no lens, no rotation, show focal = 2 x the registration's), camera at the origin
    looking along +x, a wall at x = distance."""
    ch = S.Chain(canvas(), np.eye(3), FF, 0.0, 2 * FF, 0.0, CB[0], CB[1])
    return S.Sight(ch, [0.0, 0.0, 0.0], UP_RIGHT_FORWARD_X)


PLANES = [{"kind": "plane", "points": [[20, 0, -9], [20, 0, 9], [20, 2.5, 9], [20, 2.5, -9]]},
          {"kind": "plane", "points": [[21.5, 2.5, -9], [21.5, 2.5, 9], [21.5, 12, 9], [21.5, 12, -9]]}]


class Crowd(unittest.TestCase):
    def test_metres_per_pixel_from_a_known_wall(self):
        sc = S.tile_scale(trivial_sight(), PLANES, C0[0], C0[1] - 100)  # 100 px above the principal point: low wall
        self.assertEqual(sc["x"], 20.0)
        self.assertAlmostEqual(sc["mPerPxAcross"], 20.0 / F0, places=7)
        self.assertAlmostEqual(sc["mPerPxUp"], 20.0 / F0, places=7)
        self.assertAlmostEqual(float(sc["hit"][1]), 100 * 20.0 / F0, places=6)  # up, in metres
        # off-axis the wall is seen obliquely: a pixel spans more of it across, the same up (to first order)
        side = S.tile_scale(trivial_sight(), PLANES, C0[0] + 1000, C0[1])
        self.assertGreater(side["mPerPxAcross"], sc["mPerPxAcross"])
        self.assertAlmostEqual(float(side["hit"][2]), 20.0 * 1000 / F0, places=6)

    def test_a_high_ray_belongs_to_the_upper_plane(self):
        sc = S.tile_scale(trivial_sight(), PLANES, C0[0], C0[1] - 2000)  # 20 * 2000 / 4000 = 10 m up
        self.assertEqual(sc["x"], 21.5)

    def test_a_tile_is_laid_flat_at_the_asked_scale(self):
        yy, xx = np.mgrid[0:1600, 0:2000]
        board = (((xx // 20) + (yy // 20)) % 2 * 255).astype(np.uint8)  # 20 px squares = 0.1 m on the wall
        mosaic = cv2.merge([board, board, board])
        tile, info = S.rectified_tile(mosaic, trivial_sight(), PLANES, [900, 700, 1300, 900], 100.0)
        self.assertEqual(tile.shape[:2], (100, 200))  # 400 x 200 px at 5 mm = 2 m x 1 m at 100 px/m
        self.assertAlmostEqual(info["widthM"], 2.0, places=6)
        row = (tile[50, :, 0] > 127).astype(int)
        flips = int(np.abs(np.diff(row)).sum())
        self.assertAlmostEqual(flips, 2.0 / 0.1 - 1, delta=2)  # a square every 0.1 m

    def test_a_wall_tile_is_exactly_the_rect_asked_for(self):
        """A tile named in wall metres (z across, y up) is that rect to the pixel: its top row is the rect's top."""
        yy, xx = np.mgrid[0:1600, 0:2000]
        stripes = ((yy // 40) % 2 * 255).astype(np.uint8)  # 40 px bands = 0.2 m on the wall, edges at whole bands
        mosaic = cv2.merge([stripes, stripes, stripes])
        sight = trivial_sight()
        # canvas row r is wall y = (C0y - r) * 20 / F0 metres up: bands 40 px high are 0.2 m, with edges at y = 0.2 j
        tile, info = S.wall_tile(mosaic, sight, PLANES, [-1.0, 0.4, 1.0, 1.4], 100.0)
        self.assertEqual(tile.shape[:2], (100, 200))  # 2 m x 1 m at 100 px/m, exactly
        self.assertAlmostEqual(info["widthM"], 2.0)
        self.assertAlmostEqual(info["heightM"], 1.0)
        col = (tile[:, 100, 0] > 127).astype(int)
        edges = np.nonzero(np.diff(col))[0] + 1  # tile rows where the bands flip: every 0.2 m = 20 rows
        self.assertTrue(np.all(np.abs(np.diff(edges) - 20) <= 1), edges.tolist())
        # y = 1.4 is the tile's top, 1.4 / 0.2 = 7 bands up: a band edge, so the first 20 rows are one band
        self.assertEqual(len(set(col[:15].tolist())), 1)
        self.assertEqual(int(edges[0]), 20)

    def test_the_atlas_holds_every_tile_apart(self):
        rng = np.random.default_rng(5)
        tiles = [rng.integers(0, 255, (h, w, 3), dtype=np.uint8) for h, w in [(120, 200), (90, 150), (150, 100), (60, 60)]]
        atlas, boxes = S.pack(tiles, (512, 512), gutter=4)
        self.assertLessEqual(atlas.shape[1], 512)
        self.assertLessEqual(atlas.shape[0], 512)
        for t, (x0, y0, x1, y1) in zip(tiles, boxes):
            self.assertEqual((y1 - y0, x1 - x0), t.shape[:2])
            self.assertTrue(np.array_equal(atlas[y0:y1, x0:x1], t))
            self.assertTrue(np.array_equal(atlas[y0 - 4, x0:x1], t[0]))  # the gutter repeats the edge
        for i, a in enumerate(boxes):
            for b in boxes[i + 1:]:
                gap_x = max(a[0] - b[2], b[0] - a[2])
                gap_y = max(a[1] - b[3], b[1] - a[3])
                self.assertGreaterEqual(max(gap_x, gap_y), 8)  # both gutters
        with self.assertRaises(ValueError):
            S.pack(tiles, (128, 128))


class Alignment(unittest.TestCase):
    def test_a_shifted_picture_reads_as_shifted(self):
        rng = np.random.default_rng(11)
        base = np.zeros((2160, 3840, 3), np.uint8)
        for _ in range(900):  # blobs and boxes: features at every scale
            x, y, r = rng.integers(0, 3840), rng.integers(0, 2160), int(rng.integers(6, 40))
            col = tuple(int(c) for c in rng.integers(30, 255, 3))
            if rng.random() < 0.5:
                cv2.circle(base, (int(x), int(y)), r, col, -1)
            else:
                cv2.rectangle(base, (int(x), int(y)), (int(x) + r, int(y) + r), col, -1)
        base = cv2.GaussianBlur(base, (0, 0), 2.0)
        cam = {"f": 5600.0, "cx": 1919.5, "cy": 1079.5, "width": 3840, "height": 2160}
        # a far picture with the same f and centre, but shifted 4 px (4K) to the right and 2 px down
        far_img = np.roll(base, (2, 4), axis=(0, 1))
        far = {"image": far_img, "alpha": np.full(base.shape[:2], 255, np.uint8), "f": 5600.0, "cx": 1919.5, "cy": 1079.5}
        al = S.alignment(far, cam, base)
        ft = al["features"]
        self.assertGreater(ft["inliers"], 30)
        self.assertAlmostEqual(ft["dx"], 2.0, delta=0.4)  # 4 px at 4K = 2 px at 1080p
        self.assertAlmostEqual(ft["dy"], 1.0, delta=0.4)
        same = S.alignment({**far, "image": base}, cam, base)
        self.assertGreater(same["psnr"], 40)
        self.assertLess(abs(same["features"]["dx"]) + abs(same["features"]["dy"]), 0.2)


def synthetic_bundle(root: Path) -> tuple[dict, dict, list, dict]:
    """A court.json's camera, video and frames, and the stands, enough for make_surround."""
    R = UP_RIGHT_FORWARD_X
    q = geo.matrix_to_quat(R)
    frames = [{"src": 599.0, "interp": False, "q": [float(x) for x in q], "f": FB}] * 10 + [{"src": 600, "interp": False, "q": [float(x) for x in q], "f": FB}] * 2
    camera = {"centre": [0.0, 0.0, 0.0], "width": 3840, "height": 2160, "cx": CB[0], "cy": CB[1], "k1": 0}
    video = {"freezeSource": 600, "segments": {"eases": [{"frames": [9, 11]}]}}
    return camera, video, frames, {"proxy": PLANES}


class Bundle(unittest.TestCase):
    def test_make_surround_writes_the_files_and_the_block(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            rng = np.random.default_rng(2)
            mosaic = cv2.GaussianBlur(rng.integers(0, 255, (1600, 2000, 3), dtype=np.uint8), (0, 0), 3.0)
            mosaic = cv2.normalize(mosaic, None, 0, 255, cv2.NORM_MINMAX)
            cover = np.full((1600, 2000), 2, np.uint16)
            cover[:, :300] = 0
            cv2.imwrite(str(d / "mosaic.png"), mosaic)
            cv2.imwrite(str(d / "cover.png"), cover)
            (d / "canvas.json").write_text(json.dumps(canvas()))
            (d / "cams.json").write_text(json.dumps({"k1": K1F, "size": [1920, 1080], "cx": 959.5, "cy": 539.5,
                                                    "frames": {"600": {"R": np.eye(3).tolist(), "f": FF}}}))
            cfg = {"canvas": str(d / "canvas.json"), "cams": str(d / "cams.json"), "mosaic": str(d / "mosaic.png"), "cover": str(d / "cover.png"),
                   "crowd": {"pxPerM": 120, "tiles": [[700, 500, 1100, 800], [1200, 600, 1600, 900]]}}
            root = d / "bundle"
            root.mkdir()
            w = A.Writer(root)
            camera, video, frames, stands = synthetic_bundle(root)
            block = S.make_surround(w, cfg, camera, video, frames, stands, K1S)
            self.assertEqual(block["far"]["frame"], 11)
            self.assertEqual(block["far"]["image"], "surround/far.jpg")
            for rel in ("surround/far.jpg", "surround/far-alpha.png", "surround/crowd.jpg"):
                self.assertTrue((root / rel).stat().st_size > 0, rel)
            self.assertEqual(len(block["crowd"]["tiles"]), 2)
            self.assertEqual(block["crowd"]["pxPerM"], 120)
            self.assertEqual(w.pieces["surround:far"]["source"], "real")
            self.assertEqual(w.pieces["surround:crowd"]["source"], "imagined")
            info: list = []
            self.assertEqual(S.check_block(root, block, info), [])
            bad = json.loads(json.dumps(block))
            bad["crowd"]["width"] += 1
            self.assertTrue(S.check_block(root, bad, []))
            bad = json.loads(json.dumps(block))
            bad["far"]["height"] -= 1
            self.assertTrue(S.check_block(root, bad, []))
            self.assertEqual(A.declared_paths(block).count("surround/far-alpha.png"), 1)  # the validator checks it is there

    def test_the_show_frame_must_be_the_freeze(self):
        with tempfile.TemporaryDirectory() as d:
            camera, video, frames, stands = synthetic_bundle(Path(d))
            video["freezeSource"] = 777
            with self.assertRaises(ValueError):
                S.make_surround(A.Writer(Path(d)), {"canvas": "x", "cams": "x"}, camera, video, frames, stands, K1S)
        self.assertEqual(S.f_show_frame({"segments": {"eases": [{"frames": [5, 9]}]}}), 9)


if __name__ == "__main__":
    unittest.main()
