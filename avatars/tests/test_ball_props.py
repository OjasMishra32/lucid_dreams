"""basketball_object's glue, with 4DAnyone, torch and YOLO stubbed (the real run is on HiPerGator)."""

import json
import sys
import types

import numpy as np

from lucid_avatars import ball_props
from lucid_avatars.ball import BALL_DIAMETER
from test_ball import K, H, W, _gvhmr_pair, sphere_box


class T:  # just enough of a torch tensor
    def __init__(self, a):
        self.a = np.asarray(a)

    def double(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return self.a


def test_basketball_object_end_to_end(tmp_path, monkeypatch):
    n = 4
    rng = np.random.default_rng(5)
    v_template = rng.normal(size=(6, 3))
    shapedirs = np.zeros((6, 3, 20))
    J_regressor = np.zeros((2, 6))
    J_regressor[0, 2] = 1.0
    J0 = v_template[2]
    incam, glob, Tcg = _gvhmr_pair(n, J0, rng)
    glob["betas"] = incam["betas"] = np.zeros((n, 10))
    cam_pts = np.array([[0.3, 0.1, 4.0], [0.3, 0.0, 4.2], [0.3, -0.1, 4.4], [0.3, -0.2, 4.6]])
    boxes = np.array([sphere_box(K, p, BALL_DIAMETER / 2) for p in cam_pts])
    boxes[3] = np.nan  # not seen

    gv = tmp_path / "GVHMR" / "inputs/checkpoints/body_models/smplx"
    gv.mkdir(parents=True)
    np.savez(gv / "SMPLX_NEUTRAL.npz", v_template=v_template, shapedirs=shapedirs, J_regressor=J_regressor)
    views = tmp_path / "views"
    (views / "gvhmr").mkdir(parents=True)
    (views / "gvhmr" / "motion.json").write_text("{}")
    (views / "source.mkv").write_bytes(b"")
    M = np.eye(4)
    M[:3, 3] = [0, -1, 0.5]
    (views / "cameras.json").write_text(json.dumps({"motion_world_to_canonical_world": M.tolist()}))

    motion = types.SimpleNamespace(
        smpl_params_global={k: T(v) for k, v in glob.items()}, smpl_params_incam={k: T(v) for k, v in incam.items()},
        K_fullimg=T(np.tile(K, (n, 1, 1))), image_width=W, image_height=H, num_frames=n)
    result_mod = types.ModuleType("fdanyone.motion.result")
    result_mod.MotionResult = types.SimpleNamespace(load=lambda d: motion)
    for name in ("fdanyone", "fdanyone.motion"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    monkeypatch.setitem(sys.modules, "fdanyone.motion.result", result_mod)
    monkeypatch.setattr(ball_props, "gvhmr_root", lambda: tmp_path / "GVHMR")
    monkeypatch.setattr(ball_props, "detect_ball_boxes", lambda video: boxes)

    placement = np.eye(4)
    placement[:3, :3] = [[0, 0, 1], [0, 1, 0], [-1, 0, 0]]
    placement[:3, 3] = [0.2, 0.0, -0.1]
    obj = ball_props.basketball_object(views, placement, 4, smooth=0)
    assert obj["kind"] == "basketball" and obj["radius"] == BALL_DIAMETER / 2
    assert obj["track"][3] is None
    world = placement @ M
    want = np.einsum("nab,nb->na", Tcg[:, :3, :3], cam_pts) + Tcg[:, :3, 3]
    want = want @ world[:3, :3].T + world[:3, 3]
    got = np.array(obj["track"][:3])
    assert np.linalg.norm(got - want[:3], axis=1).max() < 0.02 * 4.6


def test_no_gvhmr_no_ball(tmp_path):
    assert ball_props.basketball_object(tmp_path, np.eye(4), 4) is None
