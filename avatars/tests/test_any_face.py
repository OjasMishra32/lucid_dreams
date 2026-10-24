import json
from dataclasses import replace

import numpy as np
import pytest
from test_head_swap import EYES_AT, FACES, _rot, _synthetic_body

from lucid_avatars import any_face as A
from lucid_avatars import face_expr as F
from lucid_avatars.bundle import validate_bundle
from lucid_avatars.gaussian_ply import read_ply, write_ply
from lucid_avatars.motion import Motion
from lucid_avatars.skinning import read_skin_bin, write_skin_bin
from lucid_avatars.smplx_layout import J

HEAD = {J["head"], J["jaw"], J["left_eye"], J["right_eye"]}
K, R0, T0 = 0.9, _rot([1, 0, 0], -0.2), np.array([0.0, 0.1, -0.05])  # avatar head = K R0 FLAME + T0


def _bundle(tmp_path, reality=True):
    """The synthetic SMPL-X avatar with its Gaussians shuffled, so the head is scattered through avatar.ply, each
    with its own colour (and, if reality, its own reality.ply colour). Returns root, flame ids, the shuffled
    Gaussians, skin and reality as written, and the FLAME npz path (template = the avatar's head in FLAME's frame,
    expression 0 moves every vertex 1 mm along FLAME's +x)."""
    root, verts, ids = _synthetic_body(tmp_path)
    g = read_ply(root / "avatar" / "avatar.ply")
    idx, q = read_skin_bin(root / "avatar" / "skin.bin")
    rng = np.random.default_rng(11)
    order = rng.permutation(len(g))
    g = replace(g, xyz=g.xyz[order], f_dc=rng.uniform(-1, 1, size=(len(g), 3)), f_rest=g.f_rest[order],
                opacity=g.opacity[order], scale=g.scale[order], rotation=g.rotation[order])
    idx, q = idx[order], q[order]
    write_ply(root / "avatar" / "avatar.ply", g)
    write_skin_bin(root / "avatar" / "skin.bin", idx, q)
    real = replace(g, f_dc=g.f_dc * 0.5 + 0.1)
    write_ply(root / "avatar" / "reality.ply", real)
    g, real = read_ply(root / "avatar" / "avatar.ply"), read_ply(root / "avatar" / "reality.ply")  # as stored (float32)
    dream = json.loads((root / "dream.json").read_text())
    if not reality:
        (root / "avatar" / "reality.ply").unlink()
    else:
        dream["avatar"]["reality"] = "avatar/reality.ply"
        (root / "dream.json").write_text(json.dumps(dream, indent=2) + "\n")
    dirs = np.zeros((F.FLAME_VERTS, 3, 100))
    dirs[:, 0, 0] = 1e-3
    np.savez(tmp_path / "flame.npz", v_template=(verts[ids] - T0) @ R0 / K, faces=FACES, expr_dirs=dirs)
    return root, ids, g, (idx, q), real


def _run(tmp_path, root, **kw):
    return A.add_face(root, tmp_path / "SMPLX_NEUTRAL.npz", tmp_path / "SMPL-X__FLAME_vertex_ids.npy",
                      tmp_path / "flame.npz", **kw)


def _files(root):
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


def _match(old, new):
    """For each Gaussian of `new`, the index of the one at the same position in `old`."""
    where = {tuple(p): i for i, p in enumerate(old.xyz)}
    return np.array([where[tuple(p)] for p in new.xyz])


def test_head_ends_last_and_every_gaussian_keeps_its_skin_and_colours(tmp_path):
    root, ids, g0, (idx0, q0), real0 = _bundle(tmp_path)
    _run(tmp_path, root)
    assert validate_bundle(root) == []
    g = read_ply(root / "avatar" / "avatar.ply")
    idx, q = read_skin_bin(root / "avatar" / "skin.bin")
    real = read_ply(root / "avatar" / "reality.ply")
    assert len(g) == len(g0) == len(real)
    first, d = F.read_expr_bin(root / F.EXPR_FILE)
    dominant = idx[np.arange(len(idx)), np.argmax(q, axis=1)]
    is_head = np.isin(dominant, list(HEAD))
    assert 0 < first < len(g) and first + len(d) == len(g)
    assert not is_head[:first].any() and is_head[first:].all()  # the head is one range, at the end
    src = _match(g0, g)
    assert sorted(src) == list(range(len(g0)))  # a permutation: nothing lost or doubled
    np.testing.assert_array_equal(idx, idx0[src])
    np.testing.assert_array_equal(q, q0[src])
    np.testing.assert_array_equal(g.f_dc, g0.f_dc[src])
    np.testing.assert_array_equal(real.xyz, g.xyz)
    np.testing.assert_array_equal(real.f_dc, real0.f_dc[src])  # reality.ply moved with the same permutation
    assert (np.diff(src[:first]) > 0).all() and (np.diff(src[first:]) > 0).all()  # both halves in original order


def test_channels_are_flames_carried_by_the_fit_and_the_eyes_stay_put(tmp_path):
    root, ids, *_ = _bundle(tmp_path)
    _run(tmp_path, root)
    g = read_ply(root / "avatar" / "avatar.ply")
    first, d = F.read_expr_bin(root / F.EXPR_FILE)
    head = g.xyz[first:]
    dist = np.min([np.linalg.norm(head - c, axis=1) for c in EYES_AT], axis=0)
    want = K * R0 @ [1e-3, 0, 0]
    far = dist > 0.0135  # outside 1.05 eyeball radii (12 mm)
    np.testing.assert_allclose(d[far, 0], np.tile(want, (far.sum(), 1)), atol=2e-6)
    eye = dist < 0.0115
    assert eye.any() and np.abs(d[eye]).max() == 0  # the eyeball turns with the eye joint: no offsets at all
    assert np.abs(d[far, 1]).max() == 0  # flame1 is zero in this toy FLAME
    blink = np.linalg.norm(d[:, F.BLINK], axis=1)
    assert blink.max() > 1e-3  # the lids travel a few mm
    assert blink[dist > 0.045].max() < 5e-4  # nothing away from the eyes moves more than 0.5 mm


def test_blink_report_face_json_and_dream_json(tmp_path):
    root, ids, *_ = _bundle(tmp_path)
    _run(tmp_path, root)
    face = json.loads((root / "face.json").read_text())
    assert face["expr"]["blink"]["openFraction"] < 0.1
    assert face["expr"]["templateRmsMm"] < 1e-3 and face["motion"] == "living idle"
    first, d = F.read_expr_bin(root / F.EXPR_FILE)
    assert face["headGaussians"] == len(d) and face["bodyGaussians"] == first
    assert 0 < face["eyeGaussians"] < len(d)
    dream = json.loads((root / "dream.json").read_text())
    assert dream["avatar"]["expr"] == F.EXPR_FILE and dream["avatar"]["exprChannels"] == list(F.EXPR_CHANNELS)


def test_living_idle_with_blinks_replaces_the_idle(tmp_path):
    root, ids, *_ = _bundle(tmp_path)
    src = Motion.load(root / "avatar" / "motion.json")
    _run(tmp_path, root)
    dream = json.loads((root / "dream.json").read_text())
    m = Motion.load(root / dream["avatar"]["motion"])
    assert m.num_frames / m.fps == pytest.approx(20.0) and dream["frameCount"] == m.num_frames
    assert dream["durationS"] == pytest.approx(20.0) and dream["fps"] == m.fps
    assert np.abs(np.delete(m.expr, F.BLINK, axis=1)).max() == 0 and m.expr[:, F.BLINK].max() == 1.0
    np.testing.assert_allclose(m.betas, src.betas)


def test_a_performance_and_keep_motion_keep_the_motion(tmp_path):
    root, ids, *_ = _bundle(tmp_path)
    before = (root / "avatar" / "motion.json").read_bytes()
    _run(tmp_path, root, keep_motion=True)
    assert (root / "avatar" / "motion.json").read_bytes() == before
    assert json.loads((root / "face.json").read_text())["motion"] == "kept"
    assert (root / F.EXPR_FILE).is_file() and validate_bundle(root) == []
    (tmp_path / "b").mkdir()
    root2, *_ = _bundle(tmp_path / "b")  # digs-perform's move: a real motion, never swapped out
    dream = json.loads((root2 / "dream.json").read_text())
    dream["source"] = {"avatar": "vishal.work/code.pt", "motion": "runs/lebron-jumper/views/gvhmr"}
    (root2 / "dream.json").write_text(json.dumps(dream))
    before = (root2 / "avatar" / "motion.json").read_bytes()
    A.add_face(root2, tmp_path / "b" / "SMPLX_NEUTRAL.npz", tmp_path / "b" / "SMPL-X__FLAME_vertex_ids.npy",
               tmp_path / "b" / "flame.npz")
    assert (root2 / "avatar" / "motion.json").read_bytes() == before
    assert json.loads((root2 / "face.json").read_text())["motion"] == "kept"


def test_a_second_run_changes_nothing(tmp_path):
    root, ids, *_ = _bundle(tmp_path)
    _run(tmp_path, root)
    once = _files(root)
    _run(tmp_path, root)
    assert _files(root) == once


def test_a_bundle_already_in_head_last_order_is_left_in_order(tmp_path):
    root, ids, *_ = _bundle(tmp_path, reality=False)
    _run(tmp_path, root)
    ply = (root / "avatar" / "avatar.ply").read_bytes()
    first, _ = F.read_expr_bin(root / F.EXPR_FILE)
    (root / F.EXPR_FILE).write_bytes(b"stale")  # an expr.bin that no longer fits is rebuilt from the current order
    _run(tmp_path, root)
    assert (root / "avatar" / "avatar.ply").read_bytes() == ply
    assert F.read_expr_bin(root / F.EXPR_FILE)[0] == first and validate_bundle(root) == []


def test_bundle_without_reality_works(tmp_path):
    root, ids, *_ = _bundle(tmp_path, reality=False)
    _run(tmp_path, root)
    assert validate_bundle(root) == [] and not (root / "avatar" / "reality.ply").exists()


def test_held_ids_are_refused_and_nothing_is_written(tmp_path):
    root, ids, *_ = _bundle(tmp_path)
    (tmp_path / "dreams" / ".held").write_text("vishal\n")
    before = _files(root)
    assert A.held_errors(root)
    with pytest.raises(ValueError, match="held"):
        _run(tmp_path, root)
    assert _files(root) == before


def test_refuses_a_skeleton_that_isnt_this_smplx(tmp_path):
    root, ids, *_ = _bundle(tmp_path)
    sk = json.loads((root / "avatar" / "skeleton.json").read_text())
    sk["rest"][J["head"]][1] += 0.05
    (root / "avatar" / "skeleton.json").write_text(json.dumps(sk))
    before = _files(root)
    with pytest.raises(ValueError, match="skeleton"):
        _run(tmp_path, root)
    assert _files(root) == before


def test_refuses_flame_that_doesnt_fit_the_smplx_head(tmp_path):
    root, ids, *_ = _bundle(tmp_path)
    z = dict(np.load(tmp_path / "flame.npz"))
    z["v_template"] = np.random.default_rng(0).normal(scale=0.1, size=z["v_template"].shape)  # not this head
    np.savez(tmp_path / "flame.npz", **z)
    with pytest.raises(ValueError, match="FLAME"):
        _run(tmp_path, root)


def test_eyes_that_cant_be_shut_skip_expr_and_the_reorder_but_still_live(tmp_path, monkeypatch):
    root, ids, g0, *_ = _bundle(tmp_path)

    def no_lids(*a, **k):
        raise ValueError("the lower eyelid has 0 vertices")

    monkeypatch.setattr(F, "blink_field", no_lids)
    _run(tmp_path, root)
    face = json.loads((root / "face.json").read_text())
    assert "eyelid" in face["expr"]["skipped"] and face["motion"] == "living idle"
    assert not (root / F.EXPR_FILE).exists() and validate_bundle(root) == []
    assert "expr" not in json.loads((root / "dream.json").read_text())["avatar"]
    np.testing.assert_array_equal(read_ply(root / "avatar" / "avatar.ply").xyz, g0.xyz)  # not reordered
    assert Motion.load(root / "avatar" / "motion.json").expr is None


def test_a_head_swaps_own_expr_is_never_overwritten(tmp_path):
    root, ids, *_ = _bundle(tmp_path)
    _run(tmp_path, root)
    (root / "face.json").unlink()
    (root / "head_swap.json").write_text("{}\n")  # now it looks like head_swap.swap_bundle's, fitted to LAM's eyelids
    with pytest.raises(ValueError, match="head swap"):
        _run(tmp_path, root)


def test_bundle_without_skinning_is_refused(tmp_path):
    root, ids, *_ = _bundle(tmp_path)
    dream = json.loads((root / "dream.json").read_text())
    del dream["avatar"]["skin"], dream["avatar"]["skeleton"]
    (root / "dream.json").write_text(json.dumps(dream))
    with pytest.raises(ValueError, match="skin"):
        _run(tmp_path, root)


def _cli(monkeypatch, root, tmp_path, *extra):
    from lucid_avatars.__main__ import main

    monkeypatch.setattr("sys.argv", ["lucid_avatars", "blink", str(root), "--smplx", str(tmp_path / "SMPLX_NEUTRAL.npz"),
                                     "--flame-ids", str(tmp_path / "SMPL-X__FLAME_vertex_ids.npy"),
                                     "--flame-expr", str(tmp_path / "flame.npz"), *extra])
    return main()


def test_cli_blink_updates_the_bundle_in_place_and_validates(tmp_path, monkeypatch, capsys):
    root, ids, *_ = _bundle(tmp_path)
    assert _cli(monkeypatch, root, tmp_path) == 0
    out = capsys.readouterr().out
    assert "OK" in out and "openFraction" in out and (root / F.EXPR_FILE).is_file()
    assert sorted(p.name for p in (tmp_path / "dreams").iterdir()) == ["vishal"]  # in place, no new bundle
    assert _cli(monkeypatch, root, tmp_path, "--keep-motion") == 0
    assert json.loads((root / "face.json").read_text())["motion"] == "kept"


def test_cli_blink_refuses_held_ids(tmp_path, monkeypatch, capsys):
    root, ids, *_ = _bundle(tmp_path)
    (tmp_path / "dreams" / ".held").write_text("vishal\n")
    before = _files(root)
    assert _cli(monkeypatch, root, tmp_path) == 2
    assert "REFUSED" in capsys.readouterr().out and _files(root) == before
