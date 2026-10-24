"""player_clip.py and stabilize.py on synthetic data (no broadcast numbers). Run from the repo root:
python3 -I -m unittest discover -s pipeline/court -p 'test_*.py' -v   (needs numpy, scipy, opencv, PyAV, ffmpeg)"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import player_clip as pc  # noqa: E402
import stabilize as st  # noqa: E402
from scipy.spatial.transform import Rotation  # noqa: E402

W, H = 160, 90


def rot(yaw_deg, pitch_deg=0.0, roll_deg=0.0):
    """World -> camera rotation: looking along +x (rows: right, down, forward), then turned by yaw/pitch/roll."""
    base = np.array([[0, 0, 1.0], [0, -1.0, 0], [1.0, 0, 0]])
    r = Rotation.from_euler("yzx", [yaw_deg, pitch_deg, roll_deg], degrees=True).as_matrix()
    return base @ r.T


def synth_calib(frames, f=400.0, k1=0.0, moving=True):
    """A tripod camera at the origin panning, tilting and zooming a little (or held still); frames are source frame
    numbers."""
    out = []
    for n in frames:
        R = rot(0.02 * (n - frames[0]), 0.3 * np.sin(n / 40.0)) if moving else rot(0.0)
        out.append({"file": f"{n:06d}.png", "source_frame": n, "C": [0.0, 1.0, 0.0], "R": R.tolist(),
                    "f": f * (1 + 0.001 * (n % 7)) if moving else f, "k1": k1})
    return {"image_size": [W, H], "C": [0.0, 1.0, 0.0], "frames": out}


class Window(unittest.TestCase):
    def test_unique_grid_skips_repeats(self):
        self.assertEqual(pc.unique_frames(96, 105, 4, 3), [96, 97, 98, 100, 101, 102, 104, 105])

    def test_stride_two_window_puts_ref_at_k(self):
        w = pc.window(1000, stride=2, k=118, n=121, mod=4, phase=3)
        self.assertEqual(len(w), 121)
        self.assertEqual(w[118], 1000)
        self.assertEqual((w[0], w[-1]), (685, 1005))
        self.assertTrue(all(n % 4 != 3 for n in w))
        u = pc.unique_frames(w[0], w[-1], 4, 3)
        self.assertEqual(w, u[::2])  # even spacing on the unique grid

    def test_stride_one_window(self):
        w = pc.window(1000, stride=1, k=117, n=121, mod=4, phase=3)
        self.assertEqual((w[0], w[117], w[-1]), (844, 1000, 1004))
        self.assertEqual(len(set(w)), 121)

    def test_window_ending_at_ref(self):
        w = pc.window(1000, stride=2, k=120, n=121, mod=4, phase=3)
        self.assertEqual(w[-1], 1000)

    def test_ref_on_a_repeat_is_refused(self):
        with self.assertRaises(ValueError):
            pc.window(1003, stride=1, k=117, n=121, mod=4, phase=3)

    def test_window_outside_the_repeat_range_is_refused(self):
        with self.assertRaises(ValueError):
            pc.window(1000, stride=2, k=118, n=121, mod=4, phase=3, valid=(900, 1100))


class StillCamera(unittest.TestCase):
    def setUp(self):
        self.calib = synth_calib(list(range(100, 140)))

    def test_ref_frame_maps_to_its_own_pixels(self):
        still = st.ref_still_camera(self.calib, 120)
        fr = self.calib["frames"][st.frame_index(self.calib, 120)]
        mu, mv, ok = st.crop_maps(still, fr, W, H, 10, 5, 40, 70)
        uu, vv = np.meshgrid(np.arange(10, 50), np.arange(5, 75))
        self.assertLess(np.abs(mu - uu).max(), 1e-3)
        self.assertLess(np.abs(mv - vv).max(), 1e-3)
        self.assertTrue(ok.all())
        self.assertEqual(still["f0"], fr["f"])

    def test_canvas_points_inverts_crop_maps(self):
        calib = synth_calib(list(range(100, 140)), k1=0.8)
        still = st.ref_still_camera(calib, 120)
        fr = calib["frames"][st.frame_index(calib, 104)]
        mu, mv, ok = st.crop_maps(still, fr, W, H, -20, 0, 60, 90)
        uu, vv = np.meshgrid(np.arange(-20, 40, dtype=float), np.arange(0, 90, dtype=float))
        cu, cv = st.canvas_points(still, fr, W, H, mu[ok], mv[ok])
        self.assertLess(np.abs(cu - uu[ok]).max(), 1e-3)
        self.assertLess(np.abs(cv - vv[ok]).max(), 1e-3)

    def test_frames_are_found_by_file_name_without_source_frame(self):
        calib = synth_calib(list(range(100, 140)))
        for fr in calib["frames"]:
            del fr["source_frame"]
        self.assertEqual(st.frame_index(calib, 120), 20)

    def test_unknown_frame_is_an_error(self):
        with self.assertRaises(KeyError):
            st.ref_still_camera(self.calib, 99)


class Crop(unittest.TestCase):
    def test_fits_inside_the_ref_frame_when_it_can(self):
        x0, y0 = pc.fit_crop((60, 10, 90, 80), 50, 90, W, H, margin=4)
        self.assertTrue(x0 <= 60 - 4 and x0 + 50 >= 90 + 4)
        self.assertEqual(y0, 0)
        self.assertTrue(0 <= x0 <= W - 50)
        self.assertEqual(x0 % 2, 0)

    def test_too_wide_raises_with_the_width_needed(self):
        with self.assertRaises(pc.CropDoesNotFit) as cm:
            pc.fit_crop((10, 10, 70, 80), 50, 90, W, H, margin=4)
        self.assertIn("68", str(cm.exception))

    def test_too_tall_raises(self):
        with self.assertRaises(pc.CropDoesNotFit):
            pc.fit_crop((60, -20, 80, 80), 50, 90, W, H, margin=0)

    def test_leaves_the_ref_frame_only_when_the_path_does(self):
        x0, y0 = pc.fit_crop((140, 0, 170, 90), 50, 90, W, H, margin=0)
        self.assertLessEqual(x0, 140)
        self.assertGreaterEqual(x0 + 50, 170)


class ClipWindow(unittest.TestCase):
    def test_native_when_the_path_fits_under_the_cap(self):
        w, h, s = pc.clip_window((10, 0, 110, 80), 50, 90, (400, 720), margin=2)
        self.assertEqual(s, 1.0)
        self.assertGreaterEqual(w, 104)
        self.assertLessEqual(w / h, 9 / 16 + 1e-9)
        self.assertEqual((w % 2, h % 2), (0, 0))

    def test_never_smaller_than_the_source_crop(self):
        self.assertEqual(pc.clip_window((10, 0, 20, 30), 50, 90, (400, 720), margin=0), (50, 90, 1.0))

    def test_scaled_down_past_the_cap(self):
        w, h, s = pc.clip_window((0, 0, 200, 80), 50, 90, (60, 108), margin=0)
        self.assertLess(s, 1.0)
        self.assertLessEqual(round(w * s), 60)
        self.assertLessEqual(round(h * s), 108)


class Layers(unittest.TestCase):
    def setUp(self):
        self.back = np.zeros((20, 20), np.float32)
        self.back[2:18, 4:12] = 1  # the player further away
        self.front = np.zeros((20, 20), np.float32)
        self.front[8:20, 9:16] = 1  # nearer, overlapping the back player's right side

    def test_back_player_never_takes_the_front_players_pixels(self):
        a = pc.player_alpha(self.back, [], [self.front], grow=1)
        self.assertEqual(float((a * self.front).max()), 0.0)
        self.assertEqual(float(a[3, 5]), 1.0)

    def test_front_player_keeps_their_whole_mask(self):
        a = pc.player_alpha(self.front, [], [], grow=1)
        np.testing.assert_array_equal(a, self.front)

    def test_carried_object_joins_the_player(self):
        ball = np.zeros((20, 20), np.float32)
        ball[14:17, 16:19] = 1
        a = pc.player_alpha(self.front, [ball], [], grow=1)
        self.assertEqual(float(a[15, 17]), 1.0)

    def test_ignore_is_the_front_player_near_the_back_player(self):
        ig = pc.ignore_mask(self.back, [self.front], grow=1, near=3)
        self.assertEqual(float(ig[10, 10]), 1.0)  # over the back player's region
        self.assertEqual(float(ig[19, 15]), 0.0)  # far from the back player
        self.assertEqual(float(pc.ignore_mask(self.front, [], grow=1, near=3).max()), 0.0)

    def test_edge_band_straddles_the_matte_edge(self):
        band = pc.edge_band(self.back, 2)
        self.assertEqual(float(band[2, 6]), 1.0)  # on the top edge, inside
        self.assertEqual(float(band[1, 6]), 1.0)  # just outside it
        self.assertEqual(float(band[10, 8]), 0.0)  # deep inside
        self.assertEqual(float(band[10, 16]), 0.0)  # well outside
        self.assertEqual(float(pc.edge_band(self.back, 0).max()), 0.0)

    def test_contact_band_is_where_another_person_meets_the_player(self):
        hand = np.zeros((20, 20), np.float32)
        hand[0:6, 13:20] = 1  # one column of background between it and the player
        band = pc.contact_band(self.back, [hand], 3)
        self.assertEqual(float(band[3, 12]), 1.0)  # the gap between them
        self.assertEqual(float(band[3, 10]), 1.0)  # the player's own pixels next to the hand
        self.assertEqual(float(band[15, 10]), 0.0)  # the player's far end
        self.assertEqual(float(pc.contact_band(self.back, [], 3).max()), 0.0)

    def test_real_ignore_adds_the_bands_only_when_asked(self):
        hand = np.zeros((20, 20), np.float32)
        hand[0:6, 13:20] = 1
        alpha = pc.player_alpha(self.back, [], [self.front], 1)
        base = pc.ignore_mask(self.back, [self.front], 1, 3) * (alpha <= 0)
        np.testing.assert_array_equal(pc.real_ignore(self.back, alpha, [self.front], [hand], 1, 3), base)
        full = pc.real_ignore(self.back, alpha, [self.front], [hand], 1, 3, edge=2, touch_band=3)
        self.assertTrue((full >= base).all())
        self.assertEqual((float(full[3, 12]), float(full[2, 6]), float(full[4, 7])), (1.0, 1.0, 0.0))

    def test_soft_matte_is_preferred_when_present(self):
        import cv2
        with tempfile.TemporaryDirectory() as tmp:
            m = Path(tmp)
            (m / "p").mkdir()
            cv2.imwrite(str(m / "p" / "000007.png"), np.full((4, 4), 255, np.uint8))
            self.assertEqual(float(pc.load_matte(m, "p", 7, 4, 4).min()), 1.0)
            (m / "p-alpha").mkdir()
            cv2.imwrite(str(m / "p-alpha" / "000007.png"), np.full((4, 4), 51, np.uint8))
            self.assertAlmostEqual(float(pc.load_matte(m, "p", 7, 4, 4).max()), 0.2)
            self.assertEqual(float(pc.load_matte(m, "p", 7, 4, 4, use=False).min()), 1.0)  # opt-in only

    def test_extra_view_prefers_a_flat_soft_matte(self):
        import cv2
        import extra_view
        with tempfile.TemporaryDirectory() as tmp:
            m = Path(tmp)
            cv2.imwrite(str(m / "p.png"), np.full((4, 4), 255, np.uint8))
            self.assertEqual(float(extra_view.read_matte(m, "p", 7, 4, 4).min()), 1.0)
            cv2.imwrite(str(m / "p-alpha.png"), np.full((4, 4), 51, np.uint8))
            self.assertAlmostEqual(float(extra_view.read_matte(m, "p", 7, 4, 4).max()), 0.2)

    def test_edge_check_cuts_out_the_real_frame_not_the_clip(self):
        import cv2
        real = np.full((300, 300, 3), 40, np.uint8)
        alpha = np.zeros((300, 300), np.float32)
        alpha[100:300, 80:220] = 1  # the player in the real frame's window
        grey = np.full((500, 280, 3), 128, np.uint8)  # the clip's window: elsewhere, all background here
        K = {"real": real, "comp": grey, "alpha": alpha, "ignore": np.zeros((300, 300), np.float32), "raw": real}
        with tempfile.TemporaryDirectory() as tmp:
            pc._sheets(Path(tmp), {"first": grey, "last": grey, "K": K}, 5)
            edge = cv2.imread(str(Path(tmp) / "edge-5.png"))
        mid = edge[:, edge.shape[1] // 3: 2 * edge.shape[1] // 3].astype(int)
        self.assertGreater(int((mid < 60).all(axis=-1).sum()), 0)

    def test_composite_is_exact_at_full_and_zero_alpha(self):
        rgb = np.full((20, 20, 3), 200, np.uint8)
        out = pc.composite(rgb, self.back, (128, 128, 128))
        self.assertEqual(out[3, 5].tolist(), [200, 200, 200])
        self.assertEqual(out[0, 0].tolist(), [128, 128, 128])

    def test_covered_counts_front_pixels_over_the_back_players_hull(self):
        self.assertGreater(pc.covered_fraction(self.back, [self.front]), 0.0)
        far = np.zeros((20, 20), np.float32)
        far[0:4, 16:20] = 1
        self.assertEqual(pc.covered_fraction(self.back, [far]), 0.0)


def ffprobe(path, entries="stream=width,height,r_frame_rate,nb_read_frames"):
    out = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", entries,
                          "-of", "json", str(path)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)["streams"][0]


def decode(path):
    import av
    with av.open(str(path)) as c:
        return [f.to_ndarray(format="rgb24") for f in c.decode(c.streams.video[0])]


class EndToEnd(unittest.TestCase):
    """A 60p clip with every 4th frame repeated, a still tripod camera and one moving player in front of another."""

    extra: dict = {}

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        n_frames = 230
        rng = np.random.default_rng(0)
        bgimg = rng.integers(0, 255, (H, W, 3), np.uint8)
        frames = []
        for n in range(n_frames):
            src = n - 1 if n % 4 == 3 else n  # 4k+3 repeats 4k+2
            img = np.roll(bgimg, src // 3, axis=1).copy()
            img[10:80, 60 + src % 9:72 + src % 9] = (250, 250 - src % 100, 250 - src // 100)  # back player, unique per frame
            img[30:90, 70 + src % 5:80 + src % 5] = (20, 20, 20)  # front player
            img[0, 0] = src % 256
            frames.append(img)
        video = root / "clip.mkv"
        p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                              "-framerate", "60000/1001", "-i", "-", "-c:v", "ffv1", "-pix_fmt", "gbrp", str(video)],
                             stdin=subprocess.PIPE)
        p.communicate(np.stack(frames).tobytes())
        assert p.returncode == 0
        calib = synth_calib(list(range(0, n_frames)), moving=False)
        (root / "calib.json").write_text(json.dumps(calib))
        for who in ("back", "front"):
            (root / "masks" / who).mkdir(parents=True)
        import cv2
        for n in range(n_frames):
            src = n - 1 if n % 4 == 3 else n
            m = np.zeros((H, W), np.uint8)
            m[10:80, 60 + src % 9:72 + src % 9] = 255
            front = np.zeros((H, W), np.uint8)
            front[30:90, 70 + src % 5:80 + src % 5] = 255
            m[front > 0] = 0
            cv2.imwrite(str(root / "masks" / "back" / f"{n:06d}.png"), m)
            cv2.imwrite(str(root / "masks" / "front" / f"{n:06d}.png"), front)
        cfg = {"video": str(video), "calib": str(root / "calib.json"), "masks": str(root / "masks"),
               "out": str(root / "out"), "ref": 200, "repeat": [4, 3], "repeat_range": [0, n_frames - 1],
               "crop": [50, 90], "margin": 2, "bg": [128, 128, 128],
               "extras": [{"name": "X150", "video": str(video), "calib": str(root / "calib.json"), "frame": 150,
                           "masks": str(root / "masks"), "weight": 0.7}]}
        cfg["sets"] = {"back-s1": {"player": "back", "front": ["front"], "stride": 1, "k": 117}}
        cfg["runs"] = {"court-test-back-s1": {"set": "back-s1", "turbo": True}}
        cfg.update(cls.extra)
        (root / "cfg.json").write_text(json.dumps(cfg))
        cls.root, cls.frames, cls.cfg = root, frames, cfg
        pc.main(["--config", str(root / "cfg.json")])
        cls.set_dir = root / "out" / "back-s1"
        cls.run_dir = root / "out" / "runs" / "court-test-back-s1"

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_input_is_121_frames_at_25_fps(self):
        s = ffprobe(self.run_dir / "input.mp4")
        self.assertEqual(s["r_frame_rate"], "25/1")
        self.assertEqual(int(s["nb_read_frames"]), 121)
        self.assertEqual((s["width"], s["height"]), (50, 90))

    def test_framemd5_shows_121_distinct_frames(self):
        lines = [x for x in (self.set_dir / "input.framemd5").read_text().splitlines() if x and not x.startswith("#")]
        self.assertEqual(len(lines), 121)
        self.assertEqual(len({x.split(",")[-1].strip() for x in lines}), 121)

    def test_source_frame_k_is_the_ref_frames_own_pixels(self):
        run = json.loads((self.run_dir / "court-run.json").read_text())
        K, (x0, y0, cw, ch) = run["K"], run["crop"]
        src = decode(self.run_dir / "source-4k.mkv")
        self.assertEqual(len(src), K + 1)
        np.testing.assert_array_equal(src[K], self.frames[200][y0:y0 + ch, x0:x0 + cw])
        self.assertEqual(int(src[0].max()), 0)

    def test_masks_and_ignore_at_k(self):
        run = json.loads((self.run_dir / "court-run.json").read_text())
        import cv2
        m = cv2.imread(str(self.run_dir / "masks" / f"{run['K']:06d}.png"), cv2.IMREAD_GRAYSCALE)
        ig = cv2.imread(str(self.run_dir / "ignore" / f"{run['K']:06d}.png"), cv2.IMREAD_GRAYSCALE)
        self.assertEqual(m.shape, (90, 50))
        self.assertEqual(ig.shape, (90, 50))
        self.assertEqual(int((m.astype(int) * (ig > 0)).max()), 0)  # the player is never ignored
        self.assertGreater(int((ig > 0).sum()), 0)  # the front player over them is

    def test_run_record(self):
        run = json.loads((self.run_dir / "court-run.json").read_text())
        job = json.loads((self.run_dir / "job.json").read_text())
        ref = self.cfg["ref"]
        self.assertEqual(run["id"], "court-test-back-s1")
        self.assertEqual(run["K"], 117)
        self.assertEqual(run["frames"][117], ref)
        self.assertEqual(len(run["frames"]), 121)
        f_ref = synth_calib([ref], moving=False)["frames"][0]["f"]
        self.assertAlmostEqual(run["FOCAL"], round(f_ref, 1))
        self.assertEqual(job["sourceFocal"], run["FOCAL"])
        self.assertEqual((job["id"], job["frames"], job["fps"], job["turbo"], job["intent"]),
                         ("court-test-back-s1", 121, 25, True, ""))

    def test_composite_never_shows_the_front_player(self):
        frames = decode(self.set_dir / "clip-lossless.mkv")
        self.assertEqual(len(frames), 121)
        dark = np.all(np.stack(frames) < 60, axis=-1)
        self.assertEqual(int(dark.sum()), 0)


class ExtraView(EndToEnd):
    """Another camera's frame of the same instant, cropped around one player (here: the same clip, frame 200)."""

    def test_extra_view_is_native_pixels_with_its_masks(self):
        import extra_view
        import cv2
        out = self.root / "real" / "X200"
        extra_view.main(["--video", self.cfg["video"], "--calib", self.cfg["calib"], "--frame", "200", "--masks",
                         self.cfg["masks"], "--player", "back", "--front", "front", "--out", str(out), "--margin", "2"])
        cam = json.loads((out / "camera.json").read_text())
        x0, y0, cw, ch = cam["crop"]
        self.assertLessEqual(cw / ch, 9 / 16 + 1e-9)
        (frame,) = decode(out / "X200.mkv")
        ref = np.zeros((ch, cw, 3), np.uint8)
        a, b, c, d = max(0, x0), max(0, y0), min(W, x0 + cw), min(H, y0 + ch)
        ref[b - y0:d - y0, a - x0:c - x0] = self.frames[200][b:d, a:c]
        np.testing.assert_array_equal(frame, ref)
        m = cv2.imread(str(out / "masks" / "000000.png"), cv2.IMREAD_GRAYSCALE)
        ig = cv2.imread(str(out / "ignore" / "000000.png"), cv2.IMREAD_GRAYSCALE)
        self.assertEqual(int((m.astype(int) * (ig > 0)).max()), 0)
        self.assertGreater(int((ig > 0).sum()), 0)
        self.assertEqual(float((out / "focal.txt").read_text()), 400.0)

    def test_runs_carry_the_extra_views(self):
        rd = self.run_dir / "real"
        self.assertEqual([e["name"] for e in json.loads((rd / "extras.json").read_text())], ["X150"])
        self.assertEqual(len(decode(rd / "X150" / "X150.mkv")), 1)
        self.assertTrue((rd / "X150" / "masks" / "000000.png").exists())
        run = json.loads((self.run_dir / "court-run.json").read_text())
        self.assertEqual(run["extras"][0]["weight"], 0.7)


class ExtrasLater(EndToEnd):
    """The other real views arrive after the clips: --extras-only adds them to the sets and run folders in place."""

    extra = {"extras": []}

    def test_extras_only_adds_them_without_touching_the_clip(self):
        before = (self.set_dir / "input.mp4").stat().st_mtime_ns
        self.assertFalse((self.run_dir / "real").exists())
        cfg = dict(self.cfg, extras=[{"name": "X150", "video": self.cfg["video"], "calib": self.cfg["calib"],
                                      "frame": 150, "masks": self.cfg["masks"], "weight": 0.7}])
        (self.root / "cfg2.json").write_text(json.dumps(cfg))
        pc.main(["--config", str(self.root / "cfg2.json"), "--extras-only"])
        self.assertEqual((self.set_dir / "input.mp4").stat().st_mtime_ns, before)
        self.assertEqual(len(decode(self.run_dir / "real" / "X150" / "X150.mkv")), 1)
        run = json.loads((self.run_dir / "court-run.json").read_text())
        self.assertEqual((run["id"], run["extras"][0]["name"]), ("court-test-back-s1", "X150"))


class RealViewsLater(EndToEnd):
    """--real-only redoes the real views' ignore (here with an edge band) and the run folders from the masks alone; the
    clip stays as built, and a run folder the config no longer lists keeps its files."""

    def test_real_only_adds_the_edge_band_under_a_new_run_id(self):
        import cv2
        k = json.loads((self.run_dir / "court-run.json").read_text())["K"]
        before = (self.set_dir / "input.mp4").stat().st_mtime_ns
        old = cv2.imread(str(self.run_dir / "ignore" / f"{k:06d}.png"), cv2.IMREAD_GRAYSCALE)
        old_x = cv2.imread(str(self.run_dir / "real" / "X150" / "ignore" / "000000.png"), cv2.IMREAD_GRAYSCALE)
        cfg = dict(self.cfg, edge=2, runs={"court-test-back-s1-r2": {"set": "back-s1", "turbo": True}})
        (self.root / "cfg3.json").write_text(json.dumps(cfg))
        pc.main(["--config", str(self.root / "cfg3.json"), "--real-only"])
        self.assertEqual((self.set_dir / "input.mp4").stat().st_mtime_ns, before)
        rd = self.root / "out" / "runs" / "court-test-back-s1-r2"
        three = np.ones((3, 3), np.uint8)
        for m_path, ig_path, was in ((rd / "masks" / f"{k:06d}.png", rd / "ignore" / f"{k:06d}.png", old),
                                     (rd / "real" / "X150" / "masks" / "000000.png",
                                      rd / "real" / "X150" / "ignore" / "000000.png", old_x)):
            m = (cv2.imread(str(m_path), cv2.IMREAD_GRAYSCALE) > 127).astype(np.uint8)
            ig = cv2.imread(str(ig_path), cv2.IMREAD_GRAYSCALE) > 0
            outline = (cv2.dilate(m, three) > 0) & ~(cv2.erode(m, three) > 0)
            self.assertTrue(outline.any())
            self.assertTrue(ig[outline].all())  # both sides of the player's edge
            self.assertTrue(ig[was > 0].all())  # and still who's in front
        np.testing.assert_array_equal(cv2.imread(str(self.run_dir / "ignore" / f"{k:06d}.png"),
                                                 cv2.IMREAD_GRAYSCALE), old)
        run = json.loads((rd / "court-run.json").read_text())
        self.assertEqual((run["id"], run["realIgnore"]["edge"], run["extras"][0]["name"]),
                         ("court-test-back-s1-r2", 2, "X150"))


class EndToEndScaled(EndToEnd):
    """The same clip with a clip cap under the window: input.mp4 is scaled, the real frame stays native."""

    extra = {"clip_max": [40, 72]}

    def test_input_is_121_frames_at_25_fps(self):
        s = ffprobe(self.run_dir / "input.mp4")
        self.assertEqual((s["r_frame_rate"], int(s["nb_read_frames"])), ("25/1", 121))
        self.assertEqual((s["width"], s["height"]), (40, 72))
        run = json.loads((self.run_dir / "court-run.json").read_text())
        self.assertEqual((run["clip"]["scale"], run["clip"]["size"]), (0.8, [40, 72]))
        self.assertEqual(run["crop"][2:], [50, 90])


if __name__ == "__main__":
    unittest.main()
