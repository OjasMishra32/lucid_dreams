import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import uika_head as U  # noqa: E402

from lucid_avatars import head_swap as H  # noqa: E402
from lucid_avatars.smplx_layout import NUM_JOINTS, J  # noqa: E402


def test_gate_lets_consenting_people_and_approved_opponents_only(tmp_path):
    assert U.gate_errors("vishal") == []
    assert U.gate_errors("magnus-carlsen") == []
    assert U.gate_errors("someone-else")
    assert U.gate_errors("../magnus-carlsen")
    held = tmp_path / ".held"
    held.write_text("magnus-carlsen\n")
    assert U.gate_errors("magnus-carlsen", held)
    assert all(credit.strip() for credit in U.OPPONENTS.values())  # every opponent's photos are credited


def test_own_bundle_and_new_id(tmp_path):
    src = tmp_path / "magnus-carlsen-lhm"
    src.mkdir()
    (src / "dream.json").write_text(json.dumps({"id": "magnus-carlsen-lhm"}))
    assert U.own_bundle_errors("magnus-carlsen", src, "magnus-carlsen-uika") == []
    assert U.own_bundle_errors("vishal", src, "vishal-uika")  # not his body
    assert U.own_bundle_errors("magnus-carlsen", src, "magnus-carlsen-lhm")  # never the source itself
    other = tmp_path / "magnus-carlsen-uika"
    other.mkdir()
    assert U.own_bundle_errors("magnus-carlsen", src, "magnus-carlsen-uika")  # someone else's bundle stays
    (other / U.REPORT_FILE).write_text("{}")
    assert U.own_bundle_errors("magnus-carlsen", src, "magnus-carlsen-uika") == []  # ours may be redone


def test_teacher_cameras_go_all_round_and_over_the_crown():
    angles = U.teacher_angles()
    assert len(angles) == 24 * len(U.TEACHER_PITCH) + 8
    yaws = {y for y, p in angles if p == 0}
    assert len(yaws) == 24 and min(yaws) == -180 and max(yaws) == 165
    target = np.array([0.0, 0.02, 0.01])
    views = U.teacher_cameras(target, 0.8, 512, 0.24)
    for v in views:
        w2c = np.asarray(v["w2c"])
        cam = w2c[:3, :3] @ target + w2c[:3, 3]
        assert cam[0] == pytest.approx(0, abs=1e-9) and cam[1] == pytest.approx(0, abs=1e-9)
        assert cam[2] == pytest.approx(0.8)
    front = next(v for v in views if v["yawDeg"] == 0 and v["elevDeg"] == 0)
    eye = -np.asarray(front["w2c"])[:3, :3].T @ np.asarray(front["w2c"])[:3, 3]
    assert eye[2] > target[2] + 0.79  # the face looks along +Z: the front camera sits on +Z


def test_scale_clamp_caps_size_and_axis_ratios():
    rng = np.random.default_rng(0)
    ls = np.log(rng.uniform(1e-5, 0.08, (500, 3)))
    out = U.clamp_log_scales(ls, math.log(U.MIN_SCALE_M), math.log(U.MAX_SCALE_M))
    assert out.min() >= math.log(U.MIN_SCALE_M) - 1e-12 and out.max() <= math.log(U.MAX_SCALE_M) + 1e-12
    srt = np.sort(out, axis=1)
    assert np.exp(srt[:, 2] - srt[:, 0]).max() <= U.MAX_AXIS_RATIO + 1e-9
    assert np.exp(srt[:, 2] - srt[:, 1]).max() <= 3.0 + 1e-9
    assert np.allclose(out.max(1), np.clip(ls.max(1), math.log(U.MIN_SCALE_M), math.log(U.MAX_SCALE_M)))  # longest kept


def test_nearest_skin_takes_head_weights_and_never_the_eyes():
    pytest.importorskip("scipy")
    rng = np.random.default_rng(1)
    verts = rng.normal(size=(200, 3))
    lbs = np.zeros((200, NUM_JOINTS))
    lbs[:100, J["head"]] = 1
    lbs[100:150, J["left_eye"]] = 1
    lbs[150:, J["neck"]] = 0.6
    lbs[150:, J["spine3"]] = 0.4
    cand = U.skin_candidates(verts, lbs, floor_y=-10)
    assert len(cand) == 200  # head, eye and neck dominant all qualify
    idx, q = U.nearest_skin(verts[100:150] + 1e-4, verts, lbs, cand, k=1)
    assert (q.astype(int).sum(1) == 255).all()
    assert (idx[:, 0] == J["head"]).all() and (q[:, 0] == 255).all()  # an eye vertex's point follows the head
    idx, q = U.nearest_skin(verts[150:] + 1e-4, verts, lbs, cand, k=1)
    assert set(idx[:, 0]) == {J["neck"]} and set(idx[:, 1]) == {J["spine3"]}


def test_uika_gaussians_follow_the_alignment(tmp_path):
    rng = np.random.default_rng(2)
    n = 50
    xyz = rng.normal(size=(n, 3)) * 0.1
    np.savez(tmp_path / "g.npz", xyz=xyz, opacity=rng.uniform(0.1, 0.9, n), scale=rng.uniform(1e-3, 3e-3, (n, 3)),
             rotation_wxyz=np.tile([1.0, 0, 0, 0], (n, 1)), rgb=rng.uniform(0, 1, (n, 3)))
    a = math.radians(30)
    R = np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]])
    g, alpha = U.uika_gaussians(tmp_path / "g.npz", 1.1, R, np.array([0, 1.5, 0]))
    assert np.allclose(g.xyz, 1.1 * xyz @ R.T + [0, 1.5, 0])
    assert np.allclose(np.exp(g.scale), 1.1 * np.load(tmp_path / "g.npz")["scale"])
    assert np.allclose(H.wxyz_to_matrix(g.rotation), R)
    assert np.allclose(1 / (1 + np.exp(-g.opacity)), alpha, atol=1e-6)


def test_ssim_is_one_for_equal_images():
    torch = pytest.importorskip("torch")
    x = torch.rand(40, 50, 3)
    assert float(U.ssim_torch(x, x)) == pytest.approx(1.0, abs=1e-5)
    assert float(U.ssim_torch(x, torch.rand(40, 50, 3))) < 0.2


def _uika_scene(rng, n_per=40):
    """FLAME-like vertices with regions: seen scalp (top front), back scalp, an ear, the neck, its boundary ring."""
    spots = {"seen": ([0.0, 0.10, 0.0], "scalp"), "back": ([0.0, 0.0, -0.10], "scalp"),
             "ear": ([0.08, 0.0, -0.065], "left_ear"), "neck": ([0.0, -0.10, 0.02], "neck"),
             "ring": ([0.0, -0.15, 0.0], "boundary")}
    flame, regions, xyz, rgb, label = [], [], [], [], []
    for name, (centre, region) in spots.items():
        v = np.asarray(centre) + rng.normal(scale=0.004, size=(n_per, 3))
        flame.append(v)
        regions += [region] * n_per
        xyz.append(v + rng.normal(scale=0.001, size=(n_per, 3)))
        colour = {"seen": [0.2, 0.12, 0.08], "back": [0.8, 0.6, 0.5], "ear": [0.8, 0.6, 0.5],
                  "neck": [0.95, 0.95, 0.95], "ring": [0.7, 0.55, 0.45]}[name]
        rgb.append(np.tile(colour, (n_per, 1)))
        label += [name] * n_per
    return np.concatenate(flame), np.asarray(regions, dtype=object), np.concatenate(xyz), np.concatenate(rgb), \
        np.asarray(label)


def test_edit_uika_repaints_the_unseen_back_and_drops_the_collar():
    pytest.importorskip("scipy")
    from lucid_avatars.gaussian_ply import SH_C0, Gaussians

    rng = np.random.default_rng(3)
    flame, regions, xyz, rgb, label = _uika_scene(rng)
    n = len(xyz)
    g = Gaussians(xyz=xyz, f_dc=(rgb - 0.5) / SH_C0, f_rest=np.zeros((n, 0)), opacity=np.zeros(n),
                  scale=np.full((n, 3), -6.0), rotation=np.tile([1.0, 0, 0, 0], (n, 1)))
    near = np.arange(n)
    keep, new, back_w, counts, seen = U.edit_uika(g, np.ones(n), near, np.full(n, 0.002), flame, regions)
    assert seen[label == "seen"].all() and not seen[label != "seen"].any()
    assert (back_w[label == "back"] == 1).all() and (back_w[label == "ear"] == 0).all()  # ears keep their skin
    assert np.allclose(new[label == "back"], [0.2, 0.12, 0.08], atol=0.02)  # the smear becomes the seen hair
    assert np.allclose(new[label == "ear"], rgb[label == "ear"])
    assert not keep[label == "neck"].any() and not keep[label == "ring"].any()  # white collar, boundary ring
    assert keep[label == "seen"].all() and keep[label == "back"].all()
    far = U.edit_uika(g, np.ones(n), near, np.full(n, 0.035), flame, regions)[0]
    assert not far[label == "back"].any() and far[label == "seen"].all()  # no tuft behind, hair may stand off in front


def test_flame_regions_take_the_finer_mask():
    masks = {"face": np.arange(10), "nose": np.array([2, 3]), "scalp": np.array([20]), "neck": np.array([9])}
    reg = U.flame_regions(masks, 25)
    assert reg[2] == "nose" and reg[0] == "face" and reg[9] == "neck" and reg[20] == "scalp" and reg[24] == "other"


def test_through_collar_drops_a_neck_outside_the_collar_only():
    pytest.importorskip("scipy")
    a = np.linspace(0, 2 * np.pi, 72, endpoint=False)
    ring = lambda r, y: np.stack([r * np.cos(a), np.full_like(a, y), r * np.sin(a)], 1)  # noqa: E731
    collar = ring(0.065, 0.10)
    neck = np.concatenate([ring(0.075, 0.10), ring(0.055, 0.10), ring(0.075, 0.20)])  # outside, inside, above
    out = U.through_collar(neck, np.ones(len(neck), dtype=bool), collar, np.zeros(2), below_y=0.15)
    assert out[:72].all() and not out[72:].any()
    assert not U.through_collar(neck, np.zeros(len(neck), dtype=bool), collar, np.zeros(2), 0.15).any()  # only necks
