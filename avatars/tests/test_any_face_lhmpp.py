"""any_face on a bundle shaped the way lhmpp_avatar.py's export_bundle writes it (nothing here needs LHM++ itself).

What differs from the DiGS-shaped bundle test_any_face.py uses, copied from lhmpp_avatar.py: the SMPL-X model is the real
400-component one while LHM++ poses with 10 betas (`shapedirs[:, :, :10]`), the skeleton is the rest joints of those
betas, the Gaussians carry no SH rest bands (f_rest has 0 columns), the motion is an 8 s idle with SMPL-X's relaxed
hand mean at the standing height, `source` names photos, a variant and a model but no `motion`, and `dream.json` has
no `reality`.
"""
import json
import shutil

import numpy as np
import pytest
from test_head_swap import FACES, _gaussians, _synthetic_body

from lucid_avatars import any_face as A
from lucid_avatars import face_expr as F
from lucid_avatars import head_swap as H
from lucid_avatars import skinning as S
from lucid_avatars.bundle import validate_bundle, write_avatar_bundle
from lucid_avatars.digs_io import stand_y, with_hand_mean
from lucid_avatars.gaussian_ply import read_ply
from lucid_avatars.idle import idle_loop

BETAS = np.array([1.5, -0.8, 0.4, 0.0, 0.3, -0.2, 0.1, 0.0, 0.0, 0.6])


def _lhmpp_bundle(tmp_path, skeleton_shift_m=0.0):
    root, verts0, ids = _synthetic_body(tmp_path)
    shutil.rmtree(root)
    m = dict(np.load(tmp_path / "SMPLX_NEUTRAL.npz"))
    v0, rng = m["v_template"], np.random.default_rng(8)
    sd = rng.normal(size=(len(v0), 3, 400))  # components beyond the first 10 must never be used
    sd[:, :, :10] = 0.0
    sd[:, :, 0] = 0.02 * v0  # a bigger or smaller body: every vertex moves with its own position
    sd[:, 1, 1] = 0.03  # taller
    sd[:, :, 10:] *= 5.0
    hands = np.linspace(-0.2, 0.2, 45)
    np.savez(tmp_path / "SMPLX_NEUTRAL.npz", v_template=v0, shapedirs=sd, J_regressor=m["J_regressor"],
             weights=m["weights"], hands_meanl=hands, hands_meanr=-hands)
    joints, verts = S.rest_joints(v0, sd[:, :, :10], m["J_regressor"], BETAS)  # as export_bundle does
    g = _gaussians(verts + rng.normal(scale=0.003, size=verts.shape), rgb=0.6)
    idx, q = S.quantize_top4(np.asarray(m["weights"])[np.argmin(((g.xyz[:, None] - verts[None]) ** 2).sum(-1), axis=1)])
    motion = with_hand_mean(idle_loop(BETAS, 8.0, 30, stand_y(g.xyz, g.opacity)), np.concatenate([hands, -hands]))
    source = {"photos": ["a.jpg", "b.jpg"], "views": 2, "variant": "matte", "model": "LHM++ LHMPP-700M-PixelShuffle",
              "note": "avatar.ply is the SMPL-X zero pose", "credit": "photos: someone, CC BY"}
    root = write_avatar_bundle(tmp_path / "dreams", "magnus-lhm", "Magnus", g, motion, source=source,
                               metrics={"psnr": None, "ssim": None, "lpips": None, "views": 2},
                               skin=(idx, q), skeleton=S.skeleton_dict(joints + [0, skeleton_shift_m, 0]))
    dream = json.loads((root / "dream.json").read_text())
    dream["intent"] = None
    (root / "dream.json").write_text(json.dumps(dream, indent=2) + "\n")
    np.savez(tmp_path / "flame.npz", v_template=verts[ids], faces=FACES, expr_dirs=np.zeros((F.FLAME_VERTS, 3, 100)))
    return root, ids, verts


def _run(tmp_path, root):
    return A.add_face(root, tmp_path / "SMPLX_NEUTRAL.npz", tmp_path / "SMPL-X__FLAME_vertex_ids.npy",
                      tmp_path / "flame.npz")


def test_blinks_and_living_idle_on_an_lhmpp_shaped_bundle(tmp_path):
    root, ids, verts = _lhmpp_bundle(tmp_path)
    assert (root / "avatar" / "reality.ply").exists() is False
    _run(tmp_path, root)
    assert validate_bundle(root) == []
    report = json.loads((root / "face.json").read_text())
    assert report["skeletonErrMm"] < 1e-3  # the 10-beta rest joints equal any_face's: only shapedirs[:, :, :10] is read
    assert report["motion"] == "living idle" and report["expr"]["blink"]["openFraction"] < 0.2
    assert report["headGaussians"] > 0 and report["eyeGaussians"] > 0
    dream = json.loads((root / "dream.json").read_text())
    assert dream["avatar"]["expr"] == "avatar/expr.bin" and dream["durationS"] == 20.0
    assert len(dream["avatar"]["exprChannels"]) == 10 and "reality" not in dream["avatar"]
    g = read_ply(root / "avatar" / "avatar.ply")
    first, d = F.read_expr_bin(root / F.EXPR_FILE)
    assert first + len(d) == len(g) and read_ply(root / "avatar" / "avatar.ply").f_rest.shape == (len(g), 0)
    before = {p.name: p.read_bytes() for p in (root / "avatar").iterdir()}
    _run(tmp_path, root)  # idempotent on this bundle too
    assert {p.name: p.read_bytes() for p in (root / "avatar").iterdir() if p.name != "motion.json"} == \
        {k: v for k, v in before.items() if k != "motion.json"}


def test_a_skeleton_3_mm_off_passes_lhmpp_export_gate_but_not_any_face(tmp_path):
    """lhmpp_avatar.py accepts up to 5 mm between LHM++'s rest joints and ours; any_face (head_swap's 2 mm) refuses
    over 2 mm and writes nothing. In practice both numbers are float noise (same model, same betas)."""
    root, *_ = _lhmpp_bundle(tmp_path, skeleton_shift_m=0.003)
    before = {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}
    with pytest.raises(ValueError, match="skeleton.json is 3.0 mm"):
        _run(tmp_path, root)
    assert before == {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}
    assert H.MAX_SKELETON_ERR_M == 0.002
