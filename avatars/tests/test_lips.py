import json
import math
import shutil

import numpy as np
import pytest
from test_arkit import a2e_json
from test_head_swap import MID_EDGES, _lam_with_flame, _swap, _synthetic_body

from lucid_avatars import arkit as A
from lucid_avatars import face_expr as F
from lucid_avatars import head_swap as H
from lucid_avatars import lips as L
from lucid_avatars.bundle import validate_bundle
from lucid_avatars.gaussian_ply import read_ply
from lucid_avatars.idle import idle_loop
from lucid_avatars.motion import Motion

# ---------------------------------------------------------------- the PCA channels


def _lowrank_weights(T, C, rank, seed=0):
    rng = np.random.default_rng(seed)
    t = np.linspace(0, 6, T)[:, None]
    basis = 0.5 + 0.5 * np.sin(t * rng.uniform(0.5, 3, size=(1, rank)) + rng.uniform(0, 6, size=(1, rank)))
    mix = rng.uniform(size=(rank, C))
    return basis @ (mix / mix.sum(0))  # every weight a convex mix of `rank` smooth curves: in 0..1, rank `rank`


def test_mouth_pca_reconstructs_a_synthetic_mouth_sequence_and_keeps_all_its_variance():
    rng = np.random.default_rng(1)
    M, C, T = 300, 12, 90
    d = rng.normal(scale=0.0004, size=(M, C, 3))
    w = _lowrank_weights(T, C, rank=5)
    coeffs, channels, report = L.mouth_pca(d, w)
    assert coeffs.shape == (T, 9) and channels.shape == (M, 9, 3)
    want = w @ d.transpose(1, 0, 2).reshape(C, M * 3)
    got = coeffs @ channels.transpose(1, 0, 2).reshape(9, M * 3)
    np.testing.assert_allclose(got, want, atol=1e-10)
    assert report["varianceKept"] > 0.999999 and report["energyKept"] > 0.999999
    np.testing.assert_allclose((coeffs[:, :5] ** 2).mean(0).sum(), 5, rtol=0.2)  # unit-variance-ish coefficients
    assert np.abs(coeffs[:, 5:]).max() < 1e-6 and np.abs(channels[:, 5:]).max() < 1e-9  # beyond the rank: nothing
    assert report["peakMm"] == pytest.approx(np.linalg.norm(want.reshape(T, M, 3), axis=2).max() * 1000, rel=1e-3)


def test_mouth_pca_coefficients_are_unit_variance_and_signs_fixed():
    rng = np.random.default_rng(2)
    d = rng.normal(scale=0.0004, size=(200, 10, 3))
    coeffs, channels, _ = L.mouth_pca(d, rng.uniform(0, 1, size=(120, 10)))
    np.testing.assert_allclose((coeffs ** 2).mean(0), 1.0, atol=1e-9)  # U sqrt(T): exactly unit mean square
    biggest = coeffs[np.abs(coeffs).argmax(0), np.arange(9)]
    assert (biggest > 0).all()
    assert np.linalg.norm(channels[:, 0]) >= np.linalg.norm(channels[:, 8])  # biggest component first


def test_mouth_pca_variance_share_matches_an_explicit_svd_when_nine_channels_arent_enough():
    rng = np.random.default_rng(3)
    M, C, T = 120, 20, 150
    d = rng.normal(scale=0.0004, size=(M, C, 3))
    w = rng.uniform(0, 1, size=(T, C))  # twenty independent weights: nine components can't hold them
    _, _, report = L.mouth_pca(d, w)
    X = w @ d.transpose(1, 0, 2).reshape(C, M * 3)
    S = np.linalg.svd(X, compute_uv=False)
    resid = (S[9:] ** 2).sum()
    assert report["energyKept"] == pytest.approx(1 - resid / (S ** 2).sum(), abs=1e-4)
    assert report["varianceKept"] == pytest.approx(1 - resid / ((X - X.mean(0)) ** 2).sum(), abs=1e-4)
    assert report["varianceKept"] < 0.95 and report["energyKept"] > report["varianceKept"] - 1e-9


def test_mouth_pca_refuses_silence_and_nonsense_units_and_mismatched_weights():
    d = np.random.default_rng(4).normal(scale=0.0004, size=(50, 6, 3))
    with pytest.raises(ValueError, match="silent"):
        L.mouth_pca(d, np.zeros((30, 6)))
    with pytest.raises(ValueError, match="cm in speech"):
        L.mouth_pca(d * 100, np.ones((30, 6)) * np.linspace(0, 1, 30)[:, None])
    with pytest.raises(ValueError, match="don't fit"):
        L.mouth_pca(d, np.ones((30, 5)))


# ---------------------------------------------------------------- motion assembly

def _idle(fps=10, seconds=1.0):
    return idle_loop(np.zeros(10), seconds, fps)


def test_resample_interpolates_in_time_and_holds_the_end():
    a = np.stack([np.arange(5.0), np.arange(5.0) ** 2], axis=1)  # frames at 0, .1, .. at 10 fps
    out = L.resample(a, 10, 20, 12)
    np.testing.assert_allclose(out[:, 0], np.minimum(np.arange(12) / 2, 4))
    np.testing.assert_allclose(out[1, 1], 0.5)  # halfway between 0 and 1
    assert L.frames_for(2.0, 10) == 20 and L.frames_for(2.01, 10) == 21 and L.frames_for(0.0, 10) == 1


def test_lips_motion_is_as_long_as_the_clip_with_mouth_then_the_idles_own_blink():
    src = _idle(fps=10)
    T, fps_a = 63, 30.0  # 2.1 s
    coeffs = np.random.default_rng(5).normal(size=(T, 9))
    m = L.lips_motion(src, None, coeffs, fps_a)
    assert m.fps == 10 and m.num_frames == 21 and m.expr.shape == (21, 10)
    np.testing.assert_allclose(m.expr[:, :9], coeffs[::3][:21], atol=1e-12)  # 30 fps read at 10 fps
    ref = H.living_idle(src, None, seconds=2.1)
    assert ref.num_frames == 21
    np.testing.assert_allclose(m.expr[:, F.BLINK], ref.expr[:, F.BLINK])  # the blink curve is the idle's, untouched
    assert m.expr[:, F.BLINK].min() >= 0 and m.expr[:, F.BLINK].max() <= 1
    np.testing.assert_allclose(m.pose, ref.pose)
    np.testing.assert_allclose(m.betas, src.betas)


def test_lips_motion_blinks_in_a_longer_clip_and_resamples_other_fps():
    src = _idle(fps=30)
    coeffs = np.sin(np.linspace(0, 20, 25 * 12))[:, None] * np.ones((1, 9))  # 12 s at 25 fps
    m = L.lips_motion(src, None, coeffs, 25.0)
    assert m.num_frames == 360 and m.fps == 30
    assert m.expr[:, F.BLINK].max() == 1.0  # a 12 s clip has blinks in it
    t = np.arange(360) / 30
    np.testing.assert_allclose(m.expr[:, 0], np.interp(t, np.arange(300) / 25, coeffs[:, 0]), atol=1e-12)


def test_lips_motion_leaves_a_performance_alone():
    src = _idle()
    assert L.lips_motion(src, {"motion": "runs/x/gvhmr"}, np.ones((30, 9)), 30.0) is None


# ---------------------------------------------------------------- the consent gate

def _own_bundle(tmp_path, person):
    root, _, _ = _synthetic_body(tmp_path)
    if person == "vishal":
        return root
    other = tmp_path / "dreams" / person
    shutil.copytree(root, other)
    dream = json.loads((other / "dream.json").read_text())
    (other / "dream.json").write_text(json.dumps({**dream, "id": person}))
    return other


def test_only_vishal_may_have_his_voice_drive_his_face():
    assert H.VOICE_CONSENTED == frozenset({"vishal"})
    assert H.VOICE_CONSENTED <= H.CONSENTED


def test_voice_gate_lets_vishal_through_on_his_own_avatar(tmp_path):
    root = _own_bundle(tmp_path, "vishal")
    assert H.voice_consent_errors("vishal", root, new_id="vishal-head-voice") == []
    assert H.voice_consent_errors("vishal", root) == []


@pytest.mark.parametrize("person", ["ian-grandma",  # her face is consented, her voice is the family's call through Ian
                                    "steph-curry", "lebron", "bobby-fischer", "magnus-carlsen", "juice-wrld",
                                    "someone-else", "Vishal", "vishal ", ""])
def test_voice_gate_refuses_everyone_else_and_every_public_figure(tmp_path, person):
    root = _own_bundle(tmp_path, "vishal")
    errors = H.voice_consent_errors(person, root)
    assert any("voice" in e for e in errors)


def test_voice_gate_refuses_held_ids_a_foreign_avatar_and_a_bad_new_id(tmp_path):
    root = _own_bundle(tmp_path, "vishal")
    (tmp_path / "dreams" / ".held").write_text("vishal\n")
    assert any(".held" in e for e in H.voice_consent_errors("vishal", root))
    (tmp_path / "dreams" / ".held").write_text("vishal-head-voice\n")
    assert any(".held" in e for e in H.voice_consent_errors("vishal", root, new_id="vishal-head-voice"))
    (tmp_path / "dreams" / ".held").unlink()
    held = tmp_path / "more.held"
    held.write_text("vishal\n")
    assert any(".held" in e for e in H.voice_consent_errors("vishal", root, held))
    ian = _own_bundle(tmp_path, "ian-grandma")
    assert any("own avatar" in e for e in H.voice_consent_errors("vishal", ian))
    assert any("new vishal-" in e for e in H.voice_consent_errors("vishal", root, new_id="ian-voice"))


def test_lips_bundle_refuses_before_reading_a_single_file(tmp_path):
    root = _own_bundle(tmp_path, "ian-grandma")
    with pytest.raises(PermissionError, match="voice"):
        L.lips_bundle(root, "ian-grandma", "nope.ply", "nope.obj", "nope.npz", "nope.npy", "nope.npz", "nope.npz",
                      "nope.json", "nope.m4a", root.parent, "ian-grandma-voice")  # none of these exist: gate first
    assert sorted(p.name for p in root.parent.iterdir() if p.name != "ian-grandma") == ["vishal"]


# ---------------------------------------------------------------- end to end on a synthetic head swap

def _arkit_npz(tmp_path, rank=5, seed=11):
    """ARKit on FLAME: every shape a mix of `rank` smooth fields (so 9 channels hold the speech), jawOpen a 2 cm drop."""
    rng = np.random.default_rng(seed)
    V = F.FLAME_VERTS
    fields = rng.normal(scale=0.002, size=(rank, V, 3))
    fields[0] = np.outer(np.clip(1 - (np.arange(V) % 100) / 100, 0, 1), [0, -0.02, 0])
    mix = 0.1 * rng.normal(size=(52, rank))
    mix[A.ARKIT_NAMES.index("jawOpen")] = np.eye(rank)[0]
    deltas = np.einsum("cr,rvx->cvx", mix, fields)
    np.savez(tmp_path / "arkit.npz", names=np.array(A.ARKIT_NAMES), deltas=deltas)
    return deltas


def _weights_json(tmp_path, T=60, fps=30.0):
    w = np.zeros((T, 52))
    w[:, list(A.LOWER_FACE)] = _lowrank_weights(T, len(A.LOWER_FACE), 4, seed=21) * 0.6
    w[:, [i for i in range(52) if i not in A.LOWER_FACE]] = np.random.default_rng(1).uniform(0, 1, (T, 20))  # eyes, brows
    frames = [{"weights": w[i].round(6).tolist(), "time": i / fps, "rotation": []} for i in range(T)]
    p = tmp_path / "bs.json"
    p.write_text(json.dumps({"names": list(A.ARKIT_NAMES), "metadata": {"fps": fps, "frame_count": T,
                                                                       "blendshape_names": list(A.ARKIT_NAMES)},
                             "frames": frames}))
    return p, w.round(6)


def _setup(tmp_path):
    root, verts, flame_ids = _synthetic_body(tmp_path)
    (s, R, t), (k, R0), base = _lam_with_flame(tmp_path, verts, flame_ids)
    out = _swap(tmp_path, root, flame_npz=tmp_path / "flame.npz")
    deltas = _arkit_npz(tmp_path)
    voice = tmp_path / "voice.m4a"
    voice.write_bytes(b"\x00\x00\x00\x18ftypM4A fake aac")
    return out, (s, R, t), (k, R0), base, deltas, voice


def _lips(tmp_path, out, voice, a2e, **kw):
    return L.lips_bundle(out, "vishal", tmp_path / "vishal-a_gs_offset.ply", tmp_path / "vishal-a_textured_mesh.obj",
                         tmp_path / "SMPLX_NEUTRAL.npz", tmp_path / "SMPL-X__FLAME_vertex_ids.npy",
                         tmp_path / "flame.npz", tmp_path / "arkit.npz", a2e, voice, tmp_path / "dreams",
                         kw.pop("new_id", "vishal-head-voice"), **kw)


def test_lips_bundle_moves_the_mouth_as_arkits_shapes_say_and_keeps_the_blink(tmp_path):
    out, (s, R, t), (k, R0), base, deltas, voice = _setup(tmp_path)
    a2e, w = _weights_json(tmp_path)
    new = _lips(tmp_path, out, voice, a2e)
    assert validate_bundle(new) == []
    dream = json.loads((new / "dream.json").read_text())
    assert dream["id"] == "vishal-head-voice" and dream["avatar"]["exprChannels"] == list(L.MOUTH_CHANNELS)
    assert dream["avatar"]["expr"] == F.EXPR_FILE and (new / "voice.m4a").read_bytes() == voice.read_bytes()

    first0, d_swap = F.read_expr_bin(out / F.EXPR_FILE)
    first, d = F.read_expr_bin(new / F.EXPR_FILE)
    assert first == first0 and d.shape == d_swap.shape
    np.testing.assert_array_equal(d[:, F.BLINK], d_swap[:, F.BLINK])  # channel 9 is the head swap's own blink

    m = Motion.load(new / "avatar" / "motion.json")
    assert m.num_frames == 20 and m.fps == 10 and dream["frameCount"] == 20 and dream["durationS"] == 2.0
    assert m.expr.shape == (20, 10) and m.expr[:, F.BLINK].max() <= 1.0

    # what the mouth does, decoded the way a player does it, against ARKit's own shapes carried by hand: vertex ->
    # FLAME's frame -> LAM's (k R0) -> the avatar's (s R)
    head_xyz = read_ply(new / "avatar" / "avatar.ply").xyz[first:]
    all_xyz = s * base @ R.T + t
    rows = np.array([np.argmin(((all_xyz - p) ** 2).sum(1)) for p in head_xyz])
    low = deltas[list(A.LOWER_FACE)]  # (32, 5023, 3)

    def vertex_delta(r):
        a, b = (r, r) if r < F.FLAME_VERTS else MID_EDGES[r - F.FLAME_VERTS]
        return 0.5 * (low[:, a] + low[:, b])

    per = np.stack([vertex_delta(r) for r in rows[::7]])  # (n, 32, 3)
    for f in (0, 5, 11, 19):
        got = np.einsum("k,ikx->ix", m.expr[f], d[::7].astype(np.float64))
        want = (s * R @ (k * R0 @ np.einsum("c,icx->ix", w[3 * f][list(A.LOWER_FACE)], per).T)).T
        np.testing.assert_allclose(got, want, atol=6e-5)
    rep = json.loads((new / "lips.json").read_text())
    assert rep["varianceKept"] > 0.99 and rep["meetsTarget"] and rep["channels"] == list(L.MOUTH_CHANNELS)
    assert rep["clipS"] == 2.0 and rep["person"] == "vishal" and rep["a2e"]["fps"] == 30.0
    assert rep["peakMm"] > 1 and rep["flameChannelCheckMm"] < 0.01
    assert dream["source"]["voice"]["audio"] == "voice.m4a" and dream["source"]["voice"]["person"] == "vishal"
    assert (out / F.EXPR_FILE).read_bytes() != (new / F.EXPR_FILE).read_bytes()  # the head swap itself is untouched
    assert dream["source"]["voice"]["from"] == "vishal-head" and rep["from"] == "vishal-head"  # the SOURCE bundle's id


def test_lips_bundle_with_busy_speech_reports_the_variance_it_keeps(tmp_path):
    out, *_rest, voice = _setup(tmp_path)
    rng = np.random.default_rng(31)
    deltas = rng.normal(scale=0.001, size=(52, F.FLAME_VERTS, 3))
    deltas[A.ARKIT_NAMES.index("jawOpen"), :, 1] = -0.02 * rng.uniform(size=F.FLAME_VERTS)
    np.savez(tmp_path / "arkit.npz", names=np.array(A.ARKIT_NAMES), deltas=deltas)
    T = 150
    w = np.zeros((T, 52))
    w[:, list(A.LOWER_FACE)] = rng.uniform(0, 1, size=(T, 32))  # 32 independent weights
    p = tmp_path / "busy.json"
    p.write_text(json.dumps({"names": list(A.ARKIT_NAMES), "metadata": {"fps": 30, "frame_count": T},
                             "frames": [{"weights": r.tolist(), "time": i / 30} for i, r in enumerate(w)]}))
    new = _lips(tmp_path, out, voice, p, new_id="vishal-head-busy")
    rep = json.loads((new / "lips.json").read_text())
    assert rep["varianceKept"] < 0.95 and not rep["meetsTarget"] and rep["target"] == 0.95
    assert validate_bundle(new) == []


def test_lips_bundle_refuses_what_it_cant_trust(tmp_path):
    out, _, _, _, _, voice = _setup(tmp_path)
    a2e, _ = _weights_json(tmp_path)
    with pytest.raises(ValueError, match="m4a"):
        _lips(tmp_path, out, tmp_path / "voice.wav", a2e)
    empty = tmp_path / "empty.m4a"
    empty.write_bytes(b"")
    with pytest.raises(ValueError, match="non-empty"):
        _lips(tmp_path, out, empty, a2e)
    bad = tmp_path / "bs-bad.json"
    bad.write_text(a2e.read_text().replace('"jawOpen"', '"jawShut"', 1))
    with pytest.raises(ValueError, match="52"):
        _lips(tmp_path, out, voice, bad)
    silent = tmp_path / "silent.json"
    d = json.loads(a2e.read_text())
    for f in d["frames"]:
        f["weights"] = [0.0] * 52
    silent.write_text(json.dumps(d))
    with pytest.raises(ValueError, match="silent"):
        _lips(tmp_path, out, voice, silent)
    assert not (tmp_path / "dreams" / "vishal-head-voice").exists()  # nothing written by a refusal


def test_lips_bundle_refuses_a_head_that_isnt_the_one_in_the_bundle(tmp_path):
    out, _, _, base, _, voice = _setup(tmp_path)
    a2e, _ = _weights_json(tmp_path)
    obj = tmp_path / "vishal-a_textured_mesh.obj"
    moved = base + np.random.default_rng(8).normal(scale=0.003, size=base.shape)  # another photo's head
    obj.write_text("".join(f"v {p[0]} {p[1]} {p[2]}\n" for p in moved))
    with pytest.raises(ValueError, match="this bundle was swapped with|differ|fits the SMPL-X head only"):
        _lips(tmp_path, out, voice, a2e)


def test_lips_bundle_needs_a_flame_head_swap_and_an_idle(tmp_path):
    out, *_rest, voice = _setup(tmp_path)
    a2e, _ = _weights_json(tmp_path)
    dream = json.loads((out / "dream.json").read_text())
    dream["source"] = {**(dream.get("source") or {}), "motion": "runs/x/gvhmr"}  # a performance
    (out / "dream.json").write_text(json.dumps(dream))
    with pytest.raises(ValueError, match="performance"):
        _lips(tmp_path, out, voice, a2e)
    dream["avatar"].pop("expr")
    dream["avatar"].pop("exprChannels")
    (out / "dream.json").write_text(json.dumps(dream))
    with pytest.raises(ValueError, match="no FLAME expr.bin"):
        _lips(tmp_path, out, voice, a2e)


def test_cli_lips_gate_check_refuses_without_writing_and_passes_for_vishal(tmp_path, monkeypatch, capsys):
    from lucid_avatars.__main__ import main

    root = _own_bundle(tmp_path, "vishal")
    monkeypatch.setattr("sys.argv", ["lucid_avatars", "lips", str(root), "--person", "ian-grandma", "--check"])
    assert main() == 2 and "REFUSED" in capsys.readouterr().out
    monkeypatch.setattr("sys.argv", ["lucid_avatars", "lips", str(root), "--person", "steph-curry"])
    assert main() == 2  # refused before it even asks for the other files
    monkeypatch.setattr("sys.argv", ["lucid_avatars", "lips", str(root), "--person", "vishal", "--check"])
    assert main() == 0 and "consent OK" in capsys.readouterr().out
    assert sorted(p.name for p in (tmp_path / "dreams").iterdir()) == ["vishal"]


def test_cli_lips_runs_end_to_end_and_warns_when_variance_is_low(tmp_path, monkeypatch, capsys):
    from lucid_avatars.__main__ import main

    out, _, _, _, _, voice = _setup(tmp_path)
    a2e, _ = _weights_json(tmp_path)
    (tmp_path / "heads").mkdir()
    for f in ("vishal-a_gs_offset.ply", "vishal-a_textured_mesh.obj"):
        shutil.copy(tmp_path / f, tmp_path / "heads" / f)
    argv = ["lucid_avatars", "lips", str(out), "--person", "vishal", "--heads", str(tmp_path / "heads"),
            "--smplx", str(tmp_path / "SMPLX_NEUTRAL.npz"), "--flame-ids", str(tmp_path / "SMPL-X__FLAME_vertex_ids.npy"),
            "--flame-expr", str(tmp_path / "flame.npz"), "--arkit", str(tmp_path / "arkit.npz"),
            "--a2e-json", str(a2e), "--voice", str(voice)]
    monkeypatch.setattr("sys.argv", argv)
    assert main() == 0
    new = tmp_path / "dreams" / "vishal-head-voice"  # named after the head swap's own bundle id
    text = capsys.readouterr().out
    assert "OK" in text and "WARNING" not in text and validate_bundle(new) == []
    monkeypatch.setattr("sys.argv", argv[:-2] + ["--voice", str(tmp_path / "no.m4a")])
    assert main() == 1 and "FAILED" in capsys.readouterr().out
    monkeypatch.setattr("sys.argv", argv[:-6])
    with pytest.raises(SystemExit):
        main()  # missing --flame-expr etc.: argparse error


def test_lips_bundle_only_writes_next_to_the_bundle_the_gate_judged(tmp_path):
    out, _, _, _, _, voice = _setup(tmp_path)
    a2e, _ = _weights_json(tmp_path)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "vishal-head-voice").mkdir()  # something the gate never looked at: it must not be replaced
    with pytest.raises(ValueError, match="isn't the folder holding"):
        L.lips_bundle(out, "vishal", tmp_path / "vishal-a_gs_offset.ply", tmp_path / "vishal-a_textured_mesh.obj",
                      tmp_path / "SMPLX_NEUTRAL.npz", tmp_path / "SMPL-X__FLAME_vertex_ids.npy", tmp_path / "flame.npz",
                      tmp_path / "arkit.npz", a2e, voice, elsewhere, "vishal-head-voice")
    assert (elsewhere / "vishal-head-voice").is_dir()
