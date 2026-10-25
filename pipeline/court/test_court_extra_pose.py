"""court_extra_pose.py on made-up geometry: a person on a court floor seen by a still camera and one other camera, and
a recon world that is the court turned, scaled and moved. The other camera put into the recon world must see the
recon's person exactly as it sees the court's; the source camera's own still pose must come back as its solved camera;
without pose.json nothing changes; and lucid-fixed-pose.patch applies to source_view.py and only acts on the file."""

import contextlib
import importlib
import io
import json
import py_compile
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import court_extra_pose as cep  # noqa: E402

try:
    import torch
except ImportError:  # the full hook test needs torch; the maths doesn't
    torch = None


def look_at(C, target):
    """camera-from-world R for an OpenCV camera at C looking at target, y up in the world."""
    z = np.asarray(target, float) - C
    z /= np.linalg.norm(z)
    x = np.cross(z, [0, 1.0, 0])
    x /= np.linalg.norm(x)
    return np.stack([x, np.cross(z, x), z])


def K_of(f, cx, cy):
    return np.array([[f, 0, cx], [0, f, cy], [0, 0, 1.0]])


def person(n=20000, seed=0):
    """Points of a standing person 1.9 m tall at (3, 0, -1), an arm out to one side; a tenth of them on the floor."""
    rng = np.random.default_rng(seed)
    t = rng.uniform(0, 2 * np.pi, n)
    r = 0.18 * np.sqrt(rng.uniform(0, 1, n))
    y = rng.uniform(0, 1.9, n)
    P = np.stack([3 + r * np.cos(t), y, -1 + r * np.sin(t)], 1)
    arm = rng.uniform(0, 1, n // 5)
    P[: n // 5] = np.stack([3.15 + 0.6 * arm, 1.4 + 0.04 * np.sin(9 * arm), -1 + 0.04 * np.cos(9 * arm)], 1)
    P[-n // 10:, 1] = 0.0
    return P


A_C, E_C, AIM = np.array([-9.0, 1.4, 1.5]), np.array([4.0, 5.0, 9.0]), np.array([3.0, 0.95, -1.0])
A_K, E_K = K_of(2400.0, 290.5, 470.5), K_of(1500.0, 210.5, 330.5)
A_SIZE, E_SIZE = (600, 1000), (420, 700)


def still():
    return {"R": look_at(A_C, AIM).tolist(), "C": A_C.tolist(), "K": A_K.tolist()}


def extra():
    return {"R": look_at(E_C, AIM).tolist(), "C": E_C.tolist(), "K": E_K.tolist()}


def recon_world(k=0.7, seed=1):
    """(to_recon, solved viewmat of the still camera there): the recon world is the court turned, scaled by k, moved."""
    G = Rotation.from_rotvec(np.random.default_rng(seed).normal(size=3)).as_matrix()
    t = np.array([0.3, -1.2, 2.0])
    R_s = look_at(A_C, AIM) @ G.T
    V = np.eye(4)
    V[:3, :3], V[:3, 3] = R_s, -R_s @ (k * G @ A_C + t)
    return (lambda X: k * np.asarray(X) @ G.T + t), V


def project(K, V, X):
    c = np.asarray(X) @ V[:3, :3].T + V[:3, 3]
    return (c @ np.asarray(K).T)[:, :2] / c[:, 2:]


def project_court(cam, X):
    R, C = np.asarray(cam["R"]), np.asarray(cam["C"])
    V = np.eye(4)
    V[:3, :3], V[:3, 3] = R, -R @ C
    return project(cam["K"], V, X)


class Maths(unittest.TestCase):
    def test_same_intrinsics_need_no_rotation(self):
        np.testing.assert_allclose(cep.pixel_grid_rotation(A_K, A_K, *A_SIZE), np.eye(3), atol=1e-12)

    def test_principal_point_shift_is_a_small_rotation(self):
        # 20 px off is a turn of 1/120 rad; a turn isn't a shift, by the keystone term x y theta / f (~1 px in this
        # short lens's corners, about a millimetre at the body for a long broadcast lens)
        Ks = K_of(2400.0, 270.5, 490.5)
        Q = cep.pixel_grid_rotation(Ks, A_K, *A_SIZE)
        self.assertAlmostEqual(np.linalg.det(Q), 1.0, places=9)
        u, v = np.meshgrid(np.linspace(0, 599, 7), np.linspace(0, 999, 7))
        px = np.stack([u.ravel(), v.ravel(), np.ones(49)], 1)
        b = (px @ np.linalg.inv(Ks).T) @ Q.T @ A_K.T
        self.assertLess(np.abs(b[:, :2] / b[:, 2:] - px[:, :2]).max(), 1.5)

    def test_soles_on_the_floor_give_the_scale(self):
        to_recon, V = recon_world(k=0.7)
        P = person()
        s, M, C_s = cep.court_from_recon(V, A_K, A_SIZE, still(), to_recon(P), np.ones(len(P)))
        self.assertAlmostEqual(s, 1 / 0.7, places=9)
        np.testing.assert_allclose(A_C + s * (to_recon(P) - C_s) @ M.T, P, atol=1e-9)

    def test_the_still_pose_comes_back_as_the_solved_camera(self):
        to_recon, V = recon_world()
        P = person()
        s, M, C_s = cep.court_from_recon(V, A_K, A_SIZE, still(), to_recon(P), np.ones(len(P)))
        np.testing.assert_allclose(cep.extra_viewmat(still(), s, M, C_s, A_C), V, atol=1e-9)

    def test_the_still_pose_with_another_principal_point_projects_the_same(self):
        to_recon, V = recon_world()
        P, Ks = person(), K_of(2400.0, 262.0, 455.0)  # the solve's own principal point
        s, M, C_s = cep.court_from_recon(V, Ks, A_SIZE, still(), to_recon(P), np.ones(len(P)))
        mine = project(A_K, cep.extra_viewmat(still(), s, M, C_s, A_C), to_recon(P))
        self.assertLess(np.abs(mine - project(Ks, V, to_recon(P))).max(), 0.5)

    def test_another_camera_sees_the_recon_as_it_sees_the_court(self):
        to_recon, V = recon_world()
        P = person()
        s, M, C_s = cep.court_from_recon(V, A_K, A_SIZE, still(), to_recon(P), np.ones(len(P)))
        Ve = cep.extra_viewmat(extra(), s, M, C_s, A_C)
        np.testing.assert_allclose(project(E_K, Ve, to_recon(P)), project_court(extra(), P), atol=1e-6)
        np.testing.assert_allclose(Ve[:3, :3] @ Ve[:3, :3].T, np.eye(3), atol=1e-12)

    def test_scale_fit_finds_the_peak_inside_its_range(self):
        f, best = cep.scale_fit(lambda f: -(f - 1.013) ** 2)
        self.assertAlmostEqual(f, 1.013, delta=0.001)
        f, _ = cep.scale_fit(lambda f: f)
        self.assertAlmostEqual(f, cep.SCALE_FIT[1])


def write_run(d: Path, names=("V1",)):
    (d / "real").mkdir(parents=True)
    (d / "court-run.json").write_text(json.dumps({"still": {**still(), "refFrame": 7, "note": "x"}}))
    (d / "real" / "extras.json").write_text(json.dumps([{"name": n, "weight": 1.0} for n in names]))
    for n in names:
        (d / "real" / n).mkdir()
        (d / "real" / n / "camera.json").write_text(json.dumps({**extra(), "size": list(E_SIZE), "focal": 1500.0}))


class Files(unittest.TestCase):
    def test_pose_json_per_other_view(self):
        with tempfile.TemporaryDirectory() as t:
            run = Path(t) / "run"
            write_run(run, ("V1", "V2"))
            out = cep.write_poses(run)
            self.assertEqual([p.parent.name for p in out], ["V1", "V2"])
            pose = json.loads(out[0].read_text())
            self.assertEqual(pose["extra"], extra())
            self.assertEqual(pose["source"], still())
            self.assertEqual(cep.pose_file(run / "real" / "V1" / "V1.mkv"), out[0])

    def test_no_other_views_no_files(self):
        with tempfile.TemporaryDirectory() as t:
            run = Path(t)
            (run / "court-run.json").write_text(json.dumps({"still": still()}))
            self.assertEqual(cep.write_poses(run), [])


class Hook(unittest.TestCase):
    def sv(self, d: Path):
        return types.SimpleNamespace(video=d / "V1" / "V1.mkv", name="V1")

    def test_without_pose_json_nothing_happens(self):
        with tempfile.TemporaryDirectory() as t:
            src = types.SimpleNamespace(ready=True)
            self.assertIsNone(cep.fixed_solve(self.sv(Path(t)), types.SimpleNamespace(source=src), {}))

    def test_without_a_solved_source_camera_it_solves_as_before(self):
        with tempfile.TemporaryDirectory() as t:
            sv = self.sv(Path(t))
            sv.video.parent.mkdir()
            cep.pose_file(sv.video).write_text("{}")
            with contextlib.redirect_stdout(io.StringIO()) as log:
                self.assertIsNone(cep.fixed_solve(sv, types.SimpleNamespace(), {}))
                self.assertIsNone(cep.fixed_solve(sv, types.SimpleNamespace(source=types.SimpleNamespace(ready=False)), {}))
                self.assertIsNone(cep.fixed_solve(sv, types.SimpleNamespace(source=sv), {}))
            self.assertIn("solving as before", log.getvalue())


@unittest.skipIf(torch is None, "needs torch")
class FixedSolve(unittest.TestCase):
    """The whole hook with a stand-in renderer (points dilated into discs) in place of gsplat."""

    @staticmethod
    def draw(K, V, X, w, h):
        uv = torch.as_tensor(project(np.asarray(K, float), np.asarray(V, float), np.asarray(X)))
        ok = (uv[:, 0] >= 0) & (uv[:, 0] < w) & (uv[:, 1] >= 0) & (uv[:, 1] < h)
        img = torch.zeros(h * w)
        img[(uv[ok, 1].long() * w + uv[ok, 0].long())] = 1.0
        return torch.nn.functional.max_pool2d(img.view(1, 1, h, w), 5, 1, 2)[0, 0]

    def make(self, t: Path, lift=0.0, name="V1", weight=1.0, pose_over=None, away=0.0):
        to_recon, V = recon_world()
        P = person()
        R = to_recon(P + [0, lift, 0])  # lift > 0: the recon's soles float, so the soles' scale is off
        w, h = E_SIZE
        mask = self.draw(E_K, np.r_[np.c_[np.asarray(extra()["R"]), -np.asarray(extra()["R"]) @ E_C], [[0, 0, 0, 1]]],
                         P + [0, away, 0], w, h)  # away: the real view shows them that much higher (a wrong frame)
        d = t / "real" / name
        d.mkdir(parents=True)
        pose = {"extra": extra(), "source": still(), "scaleFit": list(cep.SCALE_FIT), "minIou": cep.MIN_IOU}
        cep.pose_file(d / f"{name}.mkv").write_text(json.dumps(pose | (pose_over or {})))
        draw = self.draw

        class SV:
            video, device, W, H, masks_given, max_height = d / f"{name}.mkv", "cpu", w, h, True, 2560
            masks, valid, frame_ids, offset = mask[None].numpy(), None, [0], -40

            def __init__(self):
                self.name, self.weight = name, weight

            def _render(self, trainer, params, vm, K, w, h, bg=None):
                return None, draw(K.numpy(), vm.numpy(), params["means"].numpy(), w, h)[None, ..., None], None

        src = types.SimpleNamespace(ready=True, viewmat=torch.as_tensor(V), K_full=torch.as_tensor(A_K), W=A_SIZE[0],
                                    H=A_SIZE[1])
        params = {"means": torch.as_tensor(R, dtype=torch.float32), "opacities": torch.full((len(R), 1), 5.0)}
        return SV(), types.SimpleNamespace(source=src), params

    def test_fixed_pose_matches_the_real_silhouette(self):
        with tempfile.TemporaryDirectory() as t:
            sv, trainer, params = self.make(Path(t))
            with contextlib.redirect_stdout(io.StringIO()) as log:
                self.assertTrue(cep.fixed_solve(sv, trainer, params))
            self.assertIn("extra V1: fixed pose, iou", log.getvalue())
            self.assertTrue(sv.ready)
            self.assertGreater(sv.report["iou"], 0.9)
            self.assertAlmostEqual(sv.report["scale"], 1 / 0.7, delta=0.003 / 0.7)
            self.assertAlmostEqual(sv.refine(None, params, 0, 60), sv.report["iou"], places=4)  # agree mode leaves the pose alone
            x0, y0, x1, y1 = sv.crop
            self.assertEqual(sv.size, (x1 - x0, y1 - y0))
            np.testing.assert_allclose(sv.K[0, 2].item(), E_K[0, 2] - x0, atol=1e-3)

    def test_the_scale_fit_mends_floating_soles(self):
        with tempfile.TemporaryDirectory() as t:
            sv, trainer, params = self.make(Path(t), lift=0.03)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertTrue(cep.fixed_solve(sv, trainer, params))
            self.assertGreater(sv.report["iou"], sv.report["iouSoles"] + 0.05)
            self.assertAlmostEqual(sv.report["scale"] * 0.7, 1.0, delta=0.006)

    def test_a_pose_json_written_with_the_old_narrow_range_still_fits_far_off_soles(self):
        """The 24-step body's soles sat ~7% off before any real-frame training: past the old +-5% range."""
        with tempfile.TemporaryDirectory() as t:
            sv, trainer, params = self.make(Path(t), lift=0.1, pose_over={"scaleFit": [0.95, 1.05], "minIou": 0.3})
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertTrue(cep.fixed_solve(sv, trainer, params))
            self.assertAlmostEqual(sv.report["scale"] * 0.7, 1.0, delta=0.01)
            self.assertGreater(sv.report["iou"], 0.8)

    def test_a_trained_view_that_cannot_line_up_is_left_out_but_a_held_out_one_is_still_measured(self):
        with tempfile.TemporaryDirectory() as t:
            sv, trainer, params = self.make(Path(t), away=0.6, pose_over={"minIou": 0.3})  # an old file's floor
            with contextlib.redirect_stdout(io.StringIO()) as log:
                self.assertFalse(cep.fixed_solve(sv, trainer, params))
            self.assertIn("trained without it", log.getvalue())
            self.assertLess(sv.report["iou"], cep.MIN_IOU)
            held, trainer2, params2 = self.make(Path(t) / "h", away=0.6, weight=0.0)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertTrue(cep.fixed_solve(held, trainer2, params2))

    def test_one_scale_per_recon_world_and_held_out_views_never_fit_it(self):
        with tempfile.TemporaryDirectory() as t:
            first, trainer, params = self.make(Path(t), lift=0.03)
            second, _, _ = self.make(Path(t), lift=0.03, name="V2", weight=0.7)
            held, _, _ = self.make(Path(t), lift=0.03, name="V3", weight=0.0)
            alone = types.SimpleNamespace(source=trainer.source)
            with contextlib.redirect_stdout(io.StringIO()) as log:
                for sv, tr in ((first, trainer), (second, trainer), (held, alone)):
                    self.assertTrue(cep.fixed_solve(sv, tr, params))
            self.assertEqual(first.report["scaleFrom"], "fit")
            self.assertEqual(second.report["scaleFrom"], "as V1")
            self.assertEqual(second.report["scale"], first.report["scale"])
            self.assertEqual(held.report["scaleFrom"], "soles")  # nothing trained before it: no fit on a held-out view
            self.assertEqual(held.report["scale"], held.report["scaleSoles"])
            self.assertIn("extra V2: fixed pose, iou", log.getvalue())


class Patch(unittest.TestCase):
    """lucid-fixed-pose.patch on this repo's source_view.py: it applies, compiles, and only acts on a pose.json."""

    def test_patch_applies_and_hooks_only_with_the_file(self):
        if shutil.which("patch") is None:
            self.skipTest("no patch tool")
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            (root / "pipeline" / "court").mkdir(parents=True)
            shutil.copytree(HERE.parent / "lucid", root / "pipeline" / "lucid")
            subprocess.run(["patch", "-p1", "-s", "-i", str(HERE / "lucid-fixed-pose.patch")], cwd=root, check=True)
            sv_py = root / "pipeline" / "lucid" / "source_view.py"
            py_compile.compile(str(sv_py), doraise=True)
            text = sv_py.read_text()
            self.assertIn("self.video = Path(video)", text)
            self.assertIn("held = _fixed_pose(self, trainer, params)", text)
            if torch is None:
                return
            ns = {"__file__": str(sv_py), "__name__": "patched_source_view"}
            exec(compile(text, str(sv_py), "exec"), ns)
            sv = types.SimpleNamespace(video=root / "v" / "V1.mkv")
            (root / "v").mkdir()
            saved = list(sys.path)
            sys.path[:] = [p for p in sys.path if Path(p or ".").resolve() != HERE]
            sys.modules.pop("court_extra_pose", None)
            try:
                self.assertIsNone(ns["_fixed_pose"](sv, types.SimpleNamespace(), {}))  # no pose.json: solve as before
                (root / "v" / "pose.json").write_text("{}")
                with contextlib.redirect_stdout(io.StringIO()) as log:  # pose.json, but no court_extra_pose beside lucid
                    self.assertIsNone(ns["_fixed_pose"](sv, types.SimpleNamespace(), {}))
                self.assertIn("no court_extra_pose", log.getvalue())
                shutil.copy(HERE / "court_extra_pose.py", root / "pipeline" / "court")
                importlib.invalidate_caches()
                with contextlib.redirect_stdout(io.StringIO()) as log:  # found beside lucid: the hook runs
                    self.assertIsNone(ns["_fixed_pose"](sv, types.SimpleNamespace(), {}))
                self.assertIn("source camera isn't solved", log.getvalue())
                self.assertEqual(Path(sys.modules["court_extra_pose"].__file__).resolve().parent,
                                 (root / "pipeline" / "court").resolve())
            finally:
                sys.path[:] = saved
                sys.modules.pop("court_extra_pose", None)


if __name__ == "__main__":
    unittest.main()
