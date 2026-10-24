"""head_swap_render.py's plain parts (the renders themselves need gsplat and a GPU)."""

import importlib.util
import math
import sys
from pathlib import Path

import numpy as np
import pytest

_spec = importlib.util.spec_from_file_location("head_swap_render", Path(__file__).parents[1] / "head_swap_render.py")
R = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(R)


def test_framing_uses_the_visible_gaussians_only():
    rng = np.random.default_rng(0)
    body = np.column_stack([rng.uniform(-0.2, 0.2, 500), rng.uniform(-1.2, 0.5, 500), rng.uniform(0.9, 1.1, 500)])
    ghosts = np.array([[0.0, 9.0, 0.0], [0.0, -9.0, 0.0]])  # transparent drifters a metre-wide check would count
    xyz = np.concatenate([body, ghosts])
    opacity = np.concatenate([np.full(500, 2.0), np.full(2, -5.0)])
    height, middle, (cx, cz) = R.framing(xyz, opacity)
    assert height == pytest.approx(1.7, abs=0.02) and middle == pytest.approx(-0.35, abs=0.02)
    assert cx == pytest.approx(0, abs=0.03) and cz == pytest.approx(1.0, abs=0.03)


def test_face_view_is_level_with_the_face_and_shows_its_height():
    y, (cx, cz), radius = R.face_target(np.array([0.01, 0.4, 0.02]))
    assert y == pytest.approx(0.4 + R.FACE_ABOVE_HEAD_JOINT_M) and (cx, cz) == (0.01, 0.02)
    assert 2 * radius * math.tan(math.radians(20)) == pytest.approx(2 * R.FACE_HALF_M)


def test_front_camera_sits_on_plus_z_looking_back_at_the_face():
    sys.path.insert(0, str(Path(__file__).parents[2] / "pipeline"))
    from lucid.export import orbit_camera  # numpy only at import

    c2w = np.linalg.inv(orbit_camera(R.FRONT, 0.5, 0.4, 0.4, (0.0, 0.0)))
    assert c2w[2, 3] == pytest.approx(0.5) and c2w[:3, 2] @ [0, 0, -1] == pytest.approx(1)  # at +Z, looking toward -Z


def test_identity_report_is_the_cosine_to_the_photo():
    photo = np.array([1.0, 0, 0])
    out = R.identity_report({"photo": 2 * photo, "old": np.array([0.0, 1, 0]), "new": np.array([1.0, 1, 0])})
    assert out["old"] == 0 and out["new"] == pytest.approx(math.sqrt(0.5), abs=1e-4)
    assert R.identity_report({"old": photo}) is None  # no face in the photo, nothing to compare to


def test_photo_for_finds_exactly_the_photo_lam_saw(tmp_path):
    (tmp_path / "a.jpg").write_bytes(b"")
    (tmp_path / "close-up.jpg").write_bytes(b"")
    assert R.photo_for({"headPhoto": "vishal-close-up"}, tmp_path, "vishal") == tmp_path / "close-up.jpg"
    for missing in ("vishal-gone", "magnus-a"):  # never another photo, and never someone else's
        with pytest.raises(SystemExit):
            R.photo_for({"headPhoto": missing}, tmp_path, "vishal")


def test_render_refuses_a_bundle_the_swap_gate_would_refuse(tmp_path, monkeypatch, capsys):
    import test_head_swap as T

    from lucid_avatars.__main__ import main as cli

    root, verts, ids = T._synthetic_body(tmp_path)
    T._lam_head_files(tmp_path / "heads", "vishal-a", verts[ids])
    monkeypatch.setattr("sys.argv", ["lucid_avatars", "head-swap", str(root), str(tmp_path / "heads"), "--person",
                                     "vishal", "--smplx", str(tmp_path / "SMPLX_NEUTRAL.npz"),
                                     "--flame-ids", str(tmp_path / "SMPL-X__FLAME_vertex_ids.npy")])
    assert cli() == 0
    new = tmp_path / "dreams" / "vishal-head"
    (tmp_path / "dreams" / ".held").write_text("vishal\n")  # held after the swap: the render won't touch it
    monkeypatch.setattr("sys.argv", ["head_swap_render.py", "--old", str(root), "--new", str(new), "--photos",
                                     str(tmp_path), "--person", "vishal"])
    assert R.main() == 2 and "REFUSED" in capsys.readouterr().out
    assert not (new / "preview.mp4").exists()


def test_with_expr_shuts_the_eyes_the_way_a_player_does(tmp_path):
    from dataclasses import dataclass

    from lucid_avatars import face_expr as F

    @dataclass
    class G:  # lucid.gaussians.Gaussians' fields that matter here
        means: np.ndarray

    (tmp_path / "avatar").mkdir()
    d = np.zeros((2, 10, 3))
    d[:, F.BLINK, 1] = -0.004
    F.write_expr_bin(tmp_path / F.EXPR_FILE, 3, d)
    out = R.with_expr(G(np.zeros((5, 3), np.float32)), tmp_path, {"avatar": {"expr": F.EXPR_FILE}}, np.eye(10)[F.BLINK])
    assert out.means.dtype == np.float32
    np.testing.assert_allclose(out.means[:3], 0)
    np.testing.assert_allclose(out.means[3:, 1], -0.004, atol=5e-6)  # float16 in the file


def test_eyes_zooms_the_eye_band_to_the_views_size():
    face = np.zeros((100, 100, 3), np.uint8)
    face[25:55, 35:65] = 200  # the eyes box
    zoom = R.eyes(face)
    assert zoom.shape == face.shape and zoom.mean() > 190
