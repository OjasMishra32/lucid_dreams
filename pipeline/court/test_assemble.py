"""assemble.py and its helpers on synthetic data (no broadcast numbers). Run from the repo root:
python3 -I -m unittest discover -s pipeline/court -p 'test_assemble*.py' -v   (needs numpy, opencv, ffmpeg; node for
the bundle check against format.ts)"""

import json
import math
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import assemble_geom as g  # noqa: E402


def random_rotation(rng) -> np.ndarray:
    q = rng.normal(size=4)
    return g.quat_to_matrix(q / np.linalg.norm(q))


def look(C, target, w=1216, h=2160, f=2000.0, cx=None, cy=None) -> g.Cam:
    """A camera at C looking at target with no roll (OpenCV axes, world-from-camera R)."""
    fwd = np.asarray(target, float) - C
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, g.UP)
    right /= np.linalg.norm(right)
    down = np.cross(fwd, right)
    R = np.stack([right, down, fwd], 1)
    return g.Cam(np.asarray(C, float), R, f, (w - 1) / 2 if cx is None else cx, (h - 1) / 2 if cy is None else cy, w, h)


def person(rng, n=4000, foot=(0.0, 0.0), height=2.0, facing=0.0) -> np.ndarray:
    """A standing body's points: two legs with flat soles on y = 0, a torso, a head."""
    legs = []
    for side in (-0.12, 0.12):
        r = 0.07 * np.sqrt(rng.uniform(0, 1, n // 10))
        a = rng.uniform(0, 2 * math.pi, n // 10)
        legs.append(np.stack([side + r * np.cos(a), np.zeros_like(r), r * np.sin(a)], 1))
        t = rng.uniform(0, 1, n // 4)
        a = rng.uniform(0, 2 * math.pi, n // 4)
        legs.append(np.stack([side + 0.07 * np.cos(a), 0.47 * height * t, 0.07 * np.sin(a)], 1))
    t = rng.uniform(0, 1, n // 3)
    a = rng.uniform(0, 2 * math.pi, n // 3)
    torso = np.stack([0.18 * np.cos(a), height * (0.47 + 0.33 * t), 0.12 * np.sin(a)], 1)
    d = rng.normal(size=(n // 6, 3))
    head = d / np.linalg.norm(d, axis=1, keepdims=True) * 0.11 + [0, height * 0.93, 0]
    P = np.concatenate(legs + [torso, head])
    P = P @ g.rot_y(facing).T
    return P + [foot[0], 0.0, foot[1]]


class Rotations(unittest.TestCase):
    def test_quat_round_trip(self):
        rng = np.random.default_rng(1)
        for _ in range(50):
            R = random_rotation(rng)
            q = g.matrix_to_quat(R)
            self.assertGreaterEqual(q[3], 0)
            np.testing.assert_allclose(g.quat_to_matrix(q), R, atol=1e-12)

    def test_quat_order_is_xyzw(self):
        # 90 deg about +y: x -> -z
        q = g.matrix_to_quat(g.rot_y(math.pi / 2))
        np.testing.assert_allclose(q, [0, math.sin(math.pi / 4), 0, math.cos(math.pi / 4)], atol=1e-12)
        np.testing.assert_allclose(g.rot_y(math.pi / 2) @ [1, 0, 0], [0, 0, -1], atol=1e-12)

    def test_slerp_halfway(self):
        q0 = g.matrix_to_quat(np.eye(3))
        q1 = g.matrix_to_quat(g.rot_y(0.4))
        np.testing.assert_allclose(g.quat_to_matrix(g.slerp(q0, q1, 0.5)), g.rot_y(0.2), atol=1e-12)

    def test_kabsch_recovers_rotation(self):
        rng = np.random.default_rng(2)
        R = random_rotation(rng)
        a = rng.normal(size=(30, 3))
        np.testing.assert_allclose(g.kabsch(a, a @ R.T), R, atol=1e-10)


class Calibration(unittest.TestCase):
    def calib(self):
        frames = []
        for n in range(100, 111):
            Rcw = g.rot_y(0.01 * (n - 100)).T  # camera-from-world, as the calibration stores it
            frames.append({"source_frame": n, "R": Rcw.tolist(), "f": 1000.0 + 10 * (n - 100), "k1": 0.5})
        return {"image_size": [3840, 2160], "C": [-10.0, 1.0, 2.0], "frames": frames}

    def test_whole_frame_is_its_own_camera(self):
        t = g.CalibTrack(self.calib())
        q, f = t.at(105)
        np.testing.assert_allclose(g.quat_to_matrix(q), g.rot_y(0.05), atol=1e-12)
        self.assertEqual(f, 1050.0)
        self.assertEqual(t.clamped, 0)

    def test_in_between_is_slerp_and_lerp(self):
        t = g.CalibTrack(self.calib())
        q, f = t.at(102.25)
        np.testing.assert_allclose(g.quat_to_matrix(q), g.rot_y(0.0225), atol=1e-12)
        self.assertAlmostEqual(f, 1022.5)

    def test_outside_is_clamped_and_counted(self):
        t = g.CalibTrack(self.calib())
        q, f = t.at(150)
        self.assertEqual(f, 1100.0)
        t.at(90)
        self.assertEqual(t.clamped, 2)

    def test_cam_projects_its_axis_to_the_centre(self):
        cam = g.CalibTrack(self.calib()).cam(103)
        u, v, z = cam.project(cam.C + 20 * cam.axis)
        self.assertAlmostEqual(float(u), 1919.5)
        self.assertAlmostEqual(float(v), 1079.5)
        self.assertAlmostEqual(float(z), 20.0)


class Placement(unittest.TestCase):
    def test_camera_mode_keeps_pixels_and_stands_on_the_floor(self):
        rng = np.random.default_rng(3)
        # the truth: a 2.0 m player on the court, seen by a court camera through a crop of a wider frame
        P_court = person(rng, foot=(5.0, 1.5), facing=0.7)
        full = look(np.array([-16.0, 0.8, 2.5]), [5.0, 1.0, 1.5], w=3840, h=2160, f=22000.0)
        crop = g.Cam(full.C, full.R, full.f, full.cx - 1400, full.cy - 0, 1216, 2160)  # crop at x0 = 1400
        # the same player in a reconstruction's own y-up world: scaled 0.9, turned about +y and moved; its solved
        # source camera there has a centred principal point (the recon sees only the crop)
        s0 = 0.9
        A = g.rot_y(1.1)
        T = rng.normal(size=3)
        P_rec = s0 * (P_court @ A.T) + T
        Q = g.pixel_grid_rotation(g.Cam(crop.C, crop.R, crop.f, 607.5, 1079.5, 1216, 2160), crop)
        R_src = A @ crop.R @ Q  # rec-world-from-camera so that its pixels match the crop's
        src = g.Cam(s0 * (A @ crop.C) + T, R_src, crop.f, 607.5, 1079.5, 1216, 2160)
        sim, info = g.place_by_camera(P_rec, src, crop)
        placed = sim.apply(P_rec)
        self.assertAlmostEqual(info["scale"], 1 / s0, delta=0.01)
        self.assertLess(info["tilt_deg"], 0.2)
        np.testing.assert_allclose(placed, P_court, atol=0.02)
        u0, v0, _ = crop.project(P_court)
        u1, v1, _ = crop.project(placed)
        self.assertLess(np.max(np.hypot(u1 - u0, v1 - v0)), 2.0)

    def test_feet_mode_turns_to_the_camera_and_lands_on_the_point(self):
        rng = np.random.default_rng(4)
        P = person(rng, foot=(0.0, 0.0), facing=0.0)  # bundle space: the source camera is at -z
        sim, info = g.place_by_feet(P, [0.0, 1.0, -20.0], (6.0, 1.0), [-16.0, 0.8, 2.0])
        placed = sim.apply(P)
        feet = g.contact_points(placed).mean(0)
        self.assertAlmostEqual(feet[0], 6.0, delta=0.01)
        self.assertAlmostEqual(feet[2], 1.0, delta=0.01)
        self.assertAlmostEqual(np.percentile(placed[:, 1], 0.5), 0.0, delta=1e-6)
        # the direction that faced the source camera now faces the court camera
        to_cam = sim.M @ np.array([0.0, 0.0, -1.0])
        want = np.array([-16.0, 0.0, 2.0]) - np.array([6.0, 0.0, 1.0])
        self.assertLess(g.angle_deg(to_cam, want), 0.5)


class ReconFiles(unittest.TestCase):
    def test_run_files_put_the_player_back_on_the_court(self):
        """court-run.json's still camera, recon's source-camera JSON (rig world) and the export's placement (rig ->
        bundle) read back into the same court points the clip was cut from."""
        import tempfile
        from pathlib import Path

        import assemble as A

        rng = np.random.default_rng(5)
        P_court = person(rng, foot=(6.0, 1.2), facing=-0.4)
        full = look(np.array([-16.0, 0.8, 2.5]), [6.0, 1.0, 1.2], w=3840, h=2160, f=22000.0)
        x0, y0 = 1300, 0
        crop = g.Cam(full.C, full.R, full.f, full.cx - x0, full.cy - y0, 1216, 2160)
        # the rig's world: some similarity of the court; the recon solved its source camera there
        s_r, A_r, T_r = 0.95, g.rot_y(2.0) @ g.quat_to_matrix([0.005, 0, 0.003, 1]), np.array([0.3, -1.0, 2.0])
        to_rig = lambda X: s_r * (np.asarray(X) @ A_r.T) + T_r  # noqa: E731
        Q = g.pixel_grid_rotation(g.Cam(crop.C, crop.R, crop.f, 607.5, 1079.5, 1216, 2160), crop)
        c2w = np.eye(4)
        c2w[:3, :3], c2w[:3, 3] = A_r @ crop.R @ Q, to_rig(crop.C)
        # the export: rig -> bundle, a turn about +y and a shift (lucid/export.py `placement`)
        rot, t = g.rot_y(0.7), np.array([0.1, 0.05, -0.2])
        P_bundle = to_rig(P_court) @ rot.T + t
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "src.json").write_text(json.dumps({"camera_to_world": c2w.tolist(), "K": [[crop.f, 0, 607.5], [0, crop.f, 1079.5], [0, 0, 1]],
                                                    "image_width": 1216, "image_height": 2160, "iou": 0.96}))
            (d / "dream.json").write_text(json.dumps({"placement": {"rot": rot.tolist(), "t": t.tolist()}}))
            (d / "run.json").write_text(json.dumps({"K": 118, "crop": [x0, y0, 1216, 2160], "still": {
                "R": full.R.T.tolist(), "C": full.C.tolist(), "K": [[crop.f, 0, crop.cx], [0, crop.f, crop.cy], [0, 0, 1]]}}))
            src, dst = A.recon_cameras({"sourceCamera": d / "src.json", "dream": d / "dream.json", "courtRun": d / "run.json"})
            src_r, dst_r = A.recon_cameras({"sourceCamera": d / "src.json", "courtRun": d / "run.json", "splatsSpace": "recon"})
        sim, info = g.place_by_camera(P_bundle, src, dst)
        np.testing.assert_allclose(sim.apply(P_bundle), P_court, atol=0.03)
        self.assertLess(info["tilt_deg"], 1.5)
        # the recon's own world: no placement needed
        sim_r, _ = g.place_by_camera(to_rig(P_court), src_r, dst_r)
        np.testing.assert_allclose(sim_r.apply(to_rig(P_court)), P_court, atol=0.03)


class RunLayout(unittest.TestCase):
    def test_a_fetched_freeze_run_names_its_files_and_numbers(self):
        import tempfile
        from pathlib import Path

        import assemble as A

        with tempfile.TemporaryDirectory() as d:
            run = Path(d) / "court-main-s2"
            b, r, m = run / "bundle-raw-default-r1-300k", run / "recon-raw-default-r1-300k", run / "recon-metrics-raw-default-r1"
            for p in (b / "frames", r, m):
                p.mkdir(parents=True)
            for f in ("frames/000000.ply", "frames/000000.spz", "frames/000000.reality.spz"):
                (b / f).write_bytes(b"x")
            (b / "dream.json").write_text("{}")
            (r / "source-camera-000118.json").write_text("{}")
            (r / "recon-000118.json").write_text(json.dumps({"frames": [{"sourcePsnr": 33.1, "facePsnr": 30.2, "gaussians": 299000}],
                                                             "source": {"iou": 0.962, "focal": 22350.0, "focalHeld": True}}))
            (m / "recon-000118.json").write_text(json.dumps({"frames": [{"psnr": 27.4, "ssim": 0.95}], "source": {}}))
            slot = A.resolve_run({"id": "luka", "run": str(run), "variant": "raw-default-r1", "cap": "300k", "courtRun": "x.json"})
            self.assertEqual(Path(slot["splats"]), b / "frames/000000.ply")
            self.assertEqual(Path(slot["reality"]), b / "frames/000000.reality.spz")
            self.assertEqual(Path(slot["spz"]), b / "frames/000000.spz")
            self.assertEqual(Path(slot["dream"]), b / "dream.json")
            self.assertEqual(Path(slot["sourceCamera"]), r / "source-camera-000118.json")
            self.assertEqual(slot["metrics"]["heldOutPsnr"], 27.4)
            self.assertEqual(slot["run_report"], {"variant": "raw-default-r1", "cap": "300k", "iou": 0.962, "focal": 22350.0,
                                                  "focalHeld": True, "sourcePsnr": 33.1, "facePsnr": 30.2, "gaussians": 299000, "heldOutPsnr": 27.4})
            # one recon in the run: no need to name it
            self.assertEqual(A.resolve_run({"run": str(run)})["run_report"]["variant"], "raw-default-r1")
            # the recon's own PLY wins (matched straight to the still camera); only the A frame's source camera counts;
            # court-run.json comes from the clips folder
            (r / "frames").mkdir()
            (r / "frames" / "000118.ply").write_bytes(b"x")
            (r / "source-camera-B592-000118.json").write_text("{}")
            slot = A.resolve_run({"run": str(run), "variant": "raw-default-r1", "cap": "300k"}, clips=Path(d) / "clips")
            self.assertEqual((Path(slot["splats"]), slot["splatsSpace"]), (r / "frames" / "000118.ply", "recon"))
            self.assertEqual(Path(slot["sourceCamera"]), r / "source-camera-000118.json")
            self.assertEqual(Path(slot["courtRun"]), Path(d) / "clips" / "court-main-s2" / "court-run.json")

    def test_a_show_written_into_the_bundle_is_taken(self):
        import tempfile
        from pathlib import Path

        import assemble as A

        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "court-side"
            self.assertEqual(A.show_dir({"out": str(out)}), (None, "calib"))
            (out / "video").mkdir(parents=True)
            (out / "video" / "video.json").write_text("{}")
            self.assertEqual(A.show_dir({"out": str(out)}), (out / "video", "show"))
            self.assertEqual(A.show_dir({"out": str(out), "show": {"dir": d, "cameras": "calib"}}), (None, "calib"))


class Ball(unittest.TestCase):
    def test_ball_on_its_pixel_at_the_hands_depth(self):
        import tempfile
        from pathlib import Path

        import assemble as A

        rng = np.random.default_rng(6)
        cam = look(np.array([-16.0, 0.8, 2.5]), [6.0, 1.0, 1.5], w=3840, h=2160, f=22000.0)
        ball = np.array([5.8, 1.0, 1.3])
        # the holder's front surface around the ball: a hand-sized patch of points on the ball's camera-facing side
        d = rng.normal(size=(3000, 3))
        shell = ball + d / np.linalg.norm(d, axis=1, keepdims=True) * A.BALL_RADIUS
        toward = (cam.C - ball) / np.linalg.norm(cam.C - ball)
        front = shell[(shell - ball) @ toward > 0.05]
        body = np.concatenate([person(rng, foot=(6.0, 1.5)), front])
        u, v, _ = cam.project(ball[None])
        with tempfile.TemporaryDirectory() as tmp:
            w = A.Writer(Path(tmp))
            got = A.ball_piece(w, {"ball": {"pixel": [float(u[0]), float(v[0])], "depthFrom": "luka"}}, {}, [{"id": "luka"}], cam, {"luka": body})
        np.testing.assert_allclose(got["centre"], ball, atol=0.03)
        self.assertEqual(got["erase"], [{"player": "luka", "radius": 0.15}])


class Floor(unittest.TestCase):
    def test_top_down_floor_from_a_still_camera_mosaic(self):
        import assemble as A

        # a still camera 1 m up looking down the court; its "mosaic" is the floor's own pattern where the floor is
        cam = look(np.array([-16.0, 1.0, 0.0]), [6.0, 0.0, 0.0], w=1600, h=900, f=900.0)
        u, v = np.meshgrid(np.arange(cam.w, dtype=float), np.arange(cam.h, dtype=float))
        d = cam.rays(u.ravel(), v.ravel())
        s = -cam.C[1] / np.where(d[:, 1] < -1e-6, d[:, 1], np.nan)
        X = cam.C + s[:, None] * d
        pattern = lambda x, z: np.stack([(np.floor(x) % 2) * 200 + 20, (np.floor(z) % 2) * 200 + 20, np.full_like(x, 90)], -1)  # noqa: E731
        img = np.where(np.isfinite(s)[:, None], pattern(X[:, 0], X[:, 2]), 0).reshape(cam.h, cam.w, 3).astype(np.uint8)
        count = np.isfinite(s).reshape(cam.h, cam.w).astype(np.uint16)
        canvas = {"K": cam.K.tolist(), "R": cam.R.T.tolist(), "C": cam.C.tolist(), "size": [cam.w, cam.h]}
        floor, seen, hardwood = A.floor_from_mosaic(img, count, None, canvas, res=0.1)
        self.assertEqual(floor.shape[:2], (int(round(A.WIDTH / 0.1)), int(round(A.LENGTH / 0.1))))
        # a floor point well inside the view: x = 5.25 m, z = 0.55 m (pixel centres at (i + 0.5) res - half)
        col, row = int((5.25 + A.LENGTH / 2) / 0.1), int((0.55 + A.WIDTH / 2) / 0.1)
        self.assertTrue(seen[row, col])
        np.testing.assert_allclose(floor[row, col], pattern(np.array([5.25]), np.array([0.55]))[0], atol=12)
        self.assertFalse(seen[int((7.0 + A.WIDTH / 2) / 0.1), int((-13.95 + A.LENGTH / 2) / 0.1)])  # outside the view
        self.assertEqual(len(hardwood), 3)


class Spots(unittest.TestCase):
    def test_spots_clear_every_body(self):
        bounds = [([4.6, 0, 1.2], [5.4, 2.0, 2.0]), ([5.8, 0, 0.0], [6.9, 2.6, 1.0])]
        spots = g.viewing_spots([5.8, 0, 1.2], [-16, 0.8, 2.5], bounds, clear=1.0)
        self.assertEqual(len(spots), 3)
        for s in spots:
            self.assertEqual(s[1], 0.0)
            for b in bounds:
                self.assertGreaterEqual(g.box_distance_xz(s, b), 1.0)
        # front spot is toward the camera
        self.assertLess(spots[0][0], 5.8)


class Rays(unittest.TestCase):
    def test_triangulate_two_rays(self):
        X = np.array([5.0, 1.0, 2.0])
        o = [np.array([-16.0, 0.8, 2.5]), np.array([-15.0, 1.0, -2.0])]
        X_hat, rms = g.triangulate(o, [X - oi for oi in o])
        np.testing.assert_allclose(X_hat, X, atol=1e-9)
        self.assertLess(rms, 1e-9)


if __name__ == "__main__":
    unittest.main()
