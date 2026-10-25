"""floor_fusion.py on synthetic data (no broadcast numbers): a known floor seen by a panning, zooming still camera
with people over it and a jittered registration; the fused floor must come back sharper and cleaner than any one
frame. Run from the repo root:
python3 -I -m unittest discover -s pipeline/court -p 'test_floor_fusion.py' -v   (needs numpy, opencv)"""

import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import floor_fusion as ff  # noqa: E402

LENGTH, WIDTH = 8.0, 5.0  # a small court keeps the test quick
W, H = 640, 360  # the "4K" frames
SCALE = 2  # cams.json is at half size, like layers' 1080p cameras for a 4K video
C = np.array([-9.0, 1.2, 0.3])


def look_R(target) -> np.ndarray:
    """camera-from-world rotation (x_cam = R (X - C)) looking at target, no roll."""
    fwd = np.asarray(target, float) - C
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0.0, 1.0, 0.0])
    right /= np.linalg.norm(right)
    down = np.cross(fwd, right)
    return np.stack([right, down, fwd], 0)


def floor_truth(rng) -> np.ndarray:
    """The true floor, 2 mm texels: boards along x, grain, and white lines (sRGB uint8, rows along +z)."""
    nx, nz = int(LENGTH / 0.002), int(WIDTH / 0.002)
    base = np.array([150, 120, 90], float)
    img = np.ones((nz, nx, 3)) * base
    boards = (np.arange(nz) // 30) % 2
    img += (boards[:, None, None] * 18 - 9)
    img += cv2.GaussianBlur(rng.normal(0, 25, (nz, nx)), (0, 0), 1.5)[..., None]
    for x in (-2.0, 0.0, 2.5):  # lines across the court
        i = int((x + LENGTH / 2) / 0.002)
        img[:, i - 12:i + 12] = 235
    for z in (-1.5, 1.0):
        j = int((z + WIDTH / 2) / 0.002)
        img[j - 12:j + 12, :] = 235
    return np.clip(img, 0, 255).astype(np.uint8)


def render(truth, R, f, k1=0.05) -> np.ndarray:
    """What the camera sees of the floor (black above the horizon), bilinear from the 2 mm truth."""
    ys, xs = np.mgrid[0:H, 0:W].astype(float)
    xd, yd = (xs - (W / 2 - 0.5)) / f, (ys - (H / 2 - 0.5)) / f
    xn, yn = ff.undistort(xd, yd, k1)
    d = np.stack([xn, yn, np.ones_like(xn)], -1) @ R  # world directions
    t = -C[1] / np.where(d[..., 1] < -1e-9, d[..., 1], np.nan)
    X, Z = C[0] + t * d[..., 0], C[2] + t * d[..., 2]
    u = ((X + LENGTH / 2) / 0.002 - 0.5).astype(np.float32)
    v = ((Z + WIDTH / 2) / 0.002 - 0.5).astype(np.float32)
    out = cv2.remap(truth, u, v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    out[~np.isfinite(t)] = 0
    return out


class Scene:
    """A pan over the floor: 24 frames, zooming in and out, with a person (red block) walking through, and cams.json
    rotations jittered by ~half a pixel (the registration's own error)."""

    def __init__(self, seed=3):
        rng = np.random.default_rng(seed)
        self.truth = floor_truth(rng)
        self.frames, self.masks, cams = {}, {}, {}
        for i, n in enumerate(range(100, 124)):
            target = [-1.5 + 3.0 * i / 23, 0.0, -0.6 + 1.2 * np.sin(i / 4)]
            f = 900.0 * (1.0 + 0.6 * np.sin(i / 5) ** 2)
            R = look_R(target)
            img = render(self.truth, R, f)
            img = np.clip(img + rng.normal(0, 6, img.shape), 0, 255).astype(np.uint8)  # sensor and codec noise
            # a person: a red box standing on the floor, its mask at the cams' half size
            px, py = int(W * (0.2 + 0.6 * i / 23)), int(H * 0.55)
            img[py - 60:py + 20, px - 12:px + 12] = (40, 40, 220)
            m = np.zeros((H // SCALE, W // SCALE), np.uint8)
            m[(py - 60) // SCALE:(py + 20) // SCALE, (px - 12) // SCALE:(px + 12) // SCALE] = 255
            self.frames[n], self.masks[n] = img, m
            jitter = cv2.Rodrigues(rng.normal(0, 0.4 / f, 3))[0]
            cams[str(n)] = dict(R=(jitter @ R).tolist(), f=f / SCALE, repeat_of=None, strobe=False)
        self.cams = dict(C=C.tolist(), k1=0.05, size=[W // SCALE, H // SCALE], cx=(W // SCALE) / 2 - 0.5,
                         cy=(H // SCALE) / 2 - 0.5, frames=cams)

    def reader(self, wanted):
        for n in sorted(wanted):
            yield n, self.frames[n]


def psnr(a, b, m) -> float:
    d = (a.astype(float) - b.astype(float))[m]
    return 10 * np.log10(255 ** 2 / max(1e-9, (d ** 2).mean()))


def truth_at(truth, res_x, res_z) -> np.ndarray:
    nx, nz = int(round(LENGTH / res_x)), int(round(WIDTH / res_z))
    return cv2.resize(truth, (nx, nz), interpolation=cv2.INTER_AREA)


class TestFloorFusion(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scene = Scene()
        cls.cams = ff.load_cams(cls.scene.cams, video_width=W)

    def test_camera_model_round_trip(self):
        cam = self.cams[105]
        P = np.array([[0.5, 0.0, 0.2], [-2.0, 0.0, -1.0]])
        u, v, ok = ff.project(cam, P)
        self.assertTrue(ok.all())
        # back through the pixel: the ray meets the floor at P
        xn, yn = ff.undistort((u - cam.cx) / cam.f, (v - cam.cy) / cam.f, cam.k1)
        d = np.stack([xn, yn, np.ones_like(xn)], -1) @ cam.R
        t = -cam.C[1] / d[:, 1]
        np.testing.assert_allclose(cam.C + t[:, None] * d, P, atol=1e-6)

    def test_plan_covers_what_the_frames_see_and_only_that(self):
        plan = ff.make_plan(self.cams, sorted(self.cams), LENGTH, WIDTH, 0.01, 0.004, tiles=12, size=(W, H))
        self.assertGreater(len(plan["tiles"]), 4)
        for t in plan["tiles"]:
            self.assertTrue(t["frames"], f"tile {t['id']} has frames")
        # tiles don't overlap and lie on the grid
        grid = np.zeros((plan["nz"], plan["nx"]), int)
        for t in plan["tiles"]:
            grid[t["z0"]:t["z1"], t["x0"]:t["x1"]] += 1
        self.assertLessEqual(grid.max(), 1)

    def test_fused_floor_is_sharper_and_cleaner_than_one_frame(self):
        res_x, res_z = 0.01, 0.004
        plan = ff.make_plan(self.cams, sorted(self.cams), LENGTH, WIDTH, res_x, res_z, tiles=6, size=(W, H))
        with tempfile.TemporaryDirectory() as d:
            for t in plan["tiles"]:
                ff.run_tile(plan, t["id"], self.cams, self.scene.reader(t["frames"]),
                            masks=lambda n: self.scene.masks[n], out=Path(d))
            rgb, count = ff.stitch(plan, Path(d))
        truth = truth_at(self.scene.truth, res_x, res_z)
        seen = count >= 3
        self.assertGreater(seen.mean(), 0.2, "a good share of the floor is seen")
        fused = psnr(rgb, truth, seen)
        # one frame's view of the same floor: the best of three single frames alone (no fusion, its own registration)
        one = 0.0
        for n in (104, 112, 118):
            rgb1, ok1 = ff.single_frame(plan, self.cams, n, self.scene.frames[n])
            if (ok1 & seen).sum() > 1000:
                one = max(one, psnr(rgb1, truth, ok1 & seen))
        print(f"\nfused {fused:.2f} dB, best single frame {one:.2f} dB, {100 * seen.mean():.0f}% seen")
        self.assertGreater(fused, 24.0, f"fused {fused:.1f} dB")
        self.assertGreater(fused, one + 1.0, f"fused {fused:.1f} dB vs best single frame {one:.1f} dB")
        # the person never lands on the floor: no red anywhere it's seen
        red = (rgb[..., 2].astype(int) - rgb[..., 1].astype(int) > 60) & seen
        self.assertLess(red.mean(), 1e-3, f"people left on the floor: {red.mean():.4f}")

    def test_alignment_takes_out_a_registration_shift(self):
        rng = np.random.default_rng(0)
        ref = cv2.GaussianBlur(rng.normal(128, 40, (120, 160)), (0, 0), 1.2).clip(0, 255).astype(np.float32)
        M = np.float32([[1, 0, 1.6], [0, 1, -0.8]])
        moved = cv2.warpAffine(ref, M, (160, 120), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
        valid = np.ones_like(ref, bool)
        dx, dz = ff.estimate_shift(moved, valid, ref)
        self.assertAlmostEqual(dx, -1.6, delta=0.15)
        self.assertAlmostEqual(dz, 0.8, delta=0.15)

    def test_ship_and_seat_sheet(self):
        res_x, res_z = 0.01, 0.004
        plan = ff.make_plan(self.cams, sorted(self.cams), LENGTH, WIDTH, res_x, res_z, tiles=4, size=(W, H))
        with tempfile.TemporaryDirectory() as d:
            for t in plan["tiles"]:
                ff.run_tile(plan, t["id"], self.cams, self.scene.reader(t["frames"]),
                            masks=lambda n: self.scene.masks[n], out=Path(d))
            rgb, count = ff.stitch(plan, Path(d))
            floor, seen, hardwood = ff.ship(rgb, count, (400, 250))
            self.assertEqual(floor.shape, (250, 400, 3))
            self.assertEqual(seen.shape, (250, 400))
            self.assertTrue(0 < seen.mean() < 1)
            # unseen floor is the hardwood colour (RGB; the image is BGR), as assemble.py writes it
            np.testing.assert_array_equal(floor[~seen][0][::-1], np.round(np.array(hardwood) * 255).astype(np.uint8))
            court = dict(court=dict(length=LENGTH, width=WIDTH), seat=dict(pairCentre=[1.0, 0, 0.0], distance=3.0),
                         camera=dict(centre=C.tolist()))
            sheet = ff.seat_sheet(court, {"before": floor, "after": floor})
            self.assertEqual(sheet.ndim, 3)
            self.assertGreater(sheet.std(), 5, "the sheet shows the floor")


def make_upload(scene: Scene, d: Path, tiles: int = 4) -> dict:
    """The upload folder floor-fusion-submit.sh and the sbatch read, from the synthetic scene."""
    d.mkdir(parents=True, exist_ok=True)
    here = Path(__file__).resolve().parent
    for f in ("floor_fusion.py", "floor-fusion.sbatch", "floor-fusion-submit.sh", "court-lib.sh"):
        shutil.copy(here / f, d / f)
    cams = ff.load_cams(scene.cams, video_width=W)
    plan = ff.make_plan(cams, sorted(cams), LENGTH, WIDTH, 0.01, 0.004, tiles=tiles, size=(W, H))
    (d / "plan.json").write_text(json.dumps(plan))
    (d / "cams.json").write_text(json.dumps(scene.cams))
    (d / "det.json").write_text("{}")
    (d / "run.json").write_text(json.dumps({"masks": "union/%06d.png", "exclude": ["0,0,4,4"]}))
    m = d / "union"
    m.mkdir()
    for n, mask in scene.masks.items():
        cv2.imwrite(str(m / f"{n:06d}.png"), mask)
    with tarfile.open(d / "masks.tar", "w") as t:
        t.add(m, arcname="union")
    shutil.rmtree(m)
    # the source: black before the pan, then the pan (lossless H.264, as the real one decodes through the same path)
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}",
                            "-r", "25", "-i", "-", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv444p",
                            str(d / "source.mp4")], stdin=subprocess.PIPE)
    for n in range(max(scene.frames) + 1):
        enc.stdin.write(scene.frames.get(n, np.zeros((H, W, 3), np.uint8)).tobytes())
    enc.stdin.close()
    assert enc.wait() == 0
    court = dict(court=dict(length=LENGTH, width=WIDTH), seat=dict(pairCentre=[1.0, 0, 0.0], distance=3.0),
                 camera=dict(centre=C.tolist()))
    (d / "court.json").write_text(json.dumps(court))
    cv2.imwrite(str(d / "floor-before.jpg"), cv2.resize(scene.truth, (160, 100), interpolation=cv2.INTER_AREA))
    return plan


class TestFloorFusionJobs(unittest.TestCase):
    """floor-fusion.sbatch run here (python3 for the cluster's env) and floor-fusion-submit.sh with stubbed sbatch
    and blue_quota. Nothing leaves this machine."""

    @classmethod
    def setUpClass(cls):
        cls.scene = Scene()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data = self.root / "data"
        self.plan = make_upload(self.scene, self.data)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.calls = self.root / "calls.log"
        for name, body in (("sbatch", 'echo "sbatch $*" >> "$CALLS"; echo $((RANDOM + 1000))'),
                           ("blue_quota", "printf 'Storage quotas for group x:\\nblue2  10G  2T  2T  -  1\\n'")):
            f = self.bin / name
            f.write_text(f"#!/bin/bash\n{body}\n")
            f.chmod(0o755)
        self.env = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}", "CALLS": str(self.calls),
                    "L2": str(self.root / "blue"), "PY": shutil.which("python3"), "TMPDIR": str(self.root / "node"),
                    "ACCOUNT": "acct", "QOS": "acct-b"}

    def tearDown(self):
        self.tmp.cleanup()

    def job(self, mode, **env):
        e = {**self.env, "DATA": str(self.data), "OUT": str(self.root / "out"), "MODE": mode, **env}
        p = subprocess.run(["bash", str(self.data / "floor-fusion.sbatch")], capture_output=True, text=True, env=e)
        self.assertEqual(p.returncode, 0, p.stderr[-2000:])
        return p.stdout

    def test_probe_tiles_and_stitch(self):
        self.assertIn("PROBE_OK 60 frames", self.job("probe"))
        for t in self.plan["tiles"]:
            self.assertIn(f"TILE_OK {t['id']}", self.job("tile", SLURM_ARRAY_TASK_ID=str(t["id"])))
        out = self.job("stitch", SIZES="200x125")
        self.assertIn("STITCH_OK", out)
        self.assertIn("SHIP_OK 200x125", out)
        o = self.root / "out"
        rgb = cv2.imread(str(o / "master" / "floor.png"))
        count = cv2.imread(str(o / "master" / "count.png"), cv2.IMREAD_UNCHANGED)
        truth = truth_at(self.scene.truth, 0.01, 0.004)
        seen = count >= 3
        self.assertGreater(psnr(rgb, truth, seen), 24.0)
        for f in ("ship-200x125/floor.jpg", "ship-200x125/floor-seen.png", "sheet-200x125.jpg"):
            self.assertTrue((o / f).stat().st_size > 0, f)
        # the node's scratch held the work; only results reached OUT
        self.assertEqual(sorted(p.name for p in (o / "tiles").iterdir())[:3], ["tile-000-count.png", "tile-000.json",
                                                                               "tile-000.png"])

    def submit(self, **env):
        return subprocess.run(["bash", str(self.data / "floor-fusion-submit.sh")], capture_output=True, text=True,
                              env={**self.env, **env})

    def test_submit_checks_then_chains_probe_array_and_stitch(self):
        p = self.submit(DRY="1")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn(f"OK: {len(self.plan['tiles'])} tiles, 20 at a time", p.stdout)
        self.assertFalse(self.calls.exists(), "DRY submits nothing")
        p = self.submit()
        self.assertEqual(p.returncode, 0, p.stderr)
        calls = self.calls.read_text().splitlines()
        self.assertEqual(len(calls), 3)
        probe, array, stitch = calls
        self.assertIn("MODE=probe", probe)
        self.assertIn(f"--array=0-{len(self.plan['tiles']) - 1}%20", array)
        self.assertIn("--dependency=afterok:", array)
        self.assertIn("MODE=tile", array)
        self.assertIn("--dependency=afterok:", stitch)
        self.assertIn("MODE=stitch", stitch)
        self.assertTrue(all(c.endswith("floor-fusion.sbatch") for c in calls))
        # the allocation comes from the environment, on every job
        self.assertTrue(all("--account=acct" in c and "--qos=acct-b" in c for c in calls))
        # never twice into the same OUT
        p = self.submit()
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("submitted before", p.stderr)

    def test_submit_needs_the_allocation_from_the_environment(self):
        for missing in ("L2", "ACCOUNT", "QOS"):
            env = {k: v for k, v in self.env.items() if k != missing}
            p = subprocess.run(["bash", str(self.data / "floor-fusion-submit.sh")], capture_output=True, text=True,
                               env={**env, "DRY": "1"})
            self.assertNotEqual(p.returncode, 0, missing)
            self.assertIn(missing, p.stderr)
        self.assertNotIn("--account=", (self.data / "floor-fusion.sbatch").read_text(), "no allocation in the job script")

    def test_submit_refuses_a_missing_input(self):
        (self.data / "masks.tar").unlink()
        p = self.submit(DRY="1")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("missing", p.stderr)
        self.assertIn("masks.tar", p.stderr)


if __name__ == "__main__":
    unittest.main()
