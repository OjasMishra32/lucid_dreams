import json

import numpy as np
import pytest

from lucid_avatars.bundle import validate_bundle, write_avatar_bundle
from lucid_avatars.gaussian_ply import Gaussians, read_ply, write_ply
from lucid_avatars.idle import idle_loop


def random_gaussians(n=1000, sh_degree=3, seed=0):
    rng = np.random.default_rng(seed)
    rot = rng.normal(size=(n, 4))
    return Gaussians(
        xyz=rng.uniform([-0.3, -1.0, -0.2], [0.3, 0.8, 0.2], size=(n, 3)),
        f_dc=rng.normal(size=(n, 3)),
        f_rest=rng.normal(size=(n, 3 * ((sh_degree + 1) ** 2 - 1))),
        opacity=rng.normal(size=n),
        scale=rng.normal(-5, 1, size=(n, 3)),
        rotation=rot / np.linalg.norm(rot, axis=1, keepdims=True),
    )


@pytest.mark.parametrize("sh_degree", [0, 3])
def test_ply_roundtrip(tmp_path, sh_degree):
    g = random_gaussians(sh_degree=sh_degree)
    path = tmp_path / "avatar.ply"
    write_ply(path, g)
    header = path.read_bytes().split(b"end_header\n")[0].decode()
    assert "format binary_little_endian 1.0" in header
    assert "element vertex 1000" in header
    for prop in ["x", "f_dc_0", "opacity", "scale_2", "rot_3"]:
        assert f"property float {prop}\n" in header
    back = read_ply(path)
    np.testing.assert_allclose(back.xyz, g.xyz, rtol=1e-6)
    np.testing.assert_allclose(back.f_rest, g.f_rest, rtol=1e-6)
    np.testing.assert_allclose(back.rotation, g.rotation, rtol=1e-6)
    assert back.sh_degree == sh_degree


def test_bundle_roundtrip_is_valid(tmp_path):
    motion = idle_loop(betas=np.zeros(10), seconds=2.0, fps=30)
    root = write_avatar_bundle(
        tmp_path / "dreams", "grandpa-01", "Grandpa", random_gaussians(), motion,
        source={"clip": "grandpa.jpg", "width": 1200, "height": 1600},
    )
    assert validate_bundle(root) == []
    dream = json.loads((root / "dream.json").read_text())
    assert dream["kind"] == "avatar"
    assert dream["frames"] is None
    assert dream["avatar"] == {"file": "avatar/avatar.ply", "rig": "smplx", "motion": "avatar/motion.json"}
    assert dream["fps"] == 30 and dream["frameCount"] == 60
    assert dream["units"] == "meters" and dream["upAxis"] == "+Y"
    assert dream["preview"] is None and dream["thumb"] is None


def test_validate_bundle_flags_problems(tmp_path):
    motion = idle_loop(betas=np.zeros(10), seconds=1.0, fps=30)
    root = write_avatar_bundle(tmp_path, "x", "X", random_gaussians(), motion)
    dream = json.loads((root / "dream.json").read_text())
    dream["kind"] = "avatarr"
    dream["preview"] = "preview.mp4"
    (root / "dream.json").write_text(json.dumps(dream))
    (root / "avatar" / "motion.json").write_text('{"fps": 30, "betas": [], "frames": []}')
    errors = validate_bundle(root)
    assert any("kind" in e for e in errors)
    assert any("preview.mp4" in e for e in errors)
    assert any("betas" in e for e in errors)


def test_validate_bundle_rejects_non_gaussian_ply(tmp_path):
    motion = idle_loop(betas=np.zeros(10), seconds=1.0, fps=30)
    root = write_avatar_bundle(tmp_path, "x", "X", random_gaussians(), motion)
    (root / "avatar" / "avatar.ply").write_bytes(
        b"ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n0\n"
    )
    assert any("avatar.ply" in e for e in validate_bundle(root))


def test_truncated_ply_is_rejected(tmp_path):
    path = tmp_path / "avatar.ply"
    write_ply(path, random_gaussians(n=10))
    path.write_bytes(path.read_bytes()[:-100])
    from lucid_avatars.gaussian_ply import header_errors
    assert any("size" in e for e in header_errors(path))
    with pytest.raises(ValueError):
        read_ply(path)


@pytest.mark.parametrize("dream", ["[]", '{"kind": "avatar", "avatar": "x"}', '{"bounds": 3}'])
def test_validate_bundle_never_crashes_on_bad_json(tmp_path, dream):
    (tmp_path / "dream.json").write_text(dream)
    assert validate_bundle(tmp_path)


def test_validate_bundle_rejects_paths_outside_bundle(tmp_path):
    motion = idle_loop(betas=np.zeros(10), seconds=1.0, fps=30)
    root = write_avatar_bundle(tmp_path / "dreams", "x", "X", random_gaussians(), motion)
    write_ply(tmp_path / "elsewhere.ply", random_gaussians())
    dream = json.loads((root / "dream.json").read_text())
    dream["avatar"]["file"] = "../../elsewhere.ply"
    dream["bounds"] = {"min": [0, 0, 0], "max": [0, 1]}
    (root / "dream.json").write_text(json.dumps(dream))
    errors = validate_bundle(root)
    assert any("outside" in e for e in errors)
    assert any("bounds" in e for e in errors)


def test_replay_bundle_needs_its_frames(tmp_path):
    (tmp_path / "frames").mkdir()
    dream = {
        "id": "r", "name": "R", "kind": "replay", "fps": 25, "frameCount": 2, "durationS": 0.08,
        "units": "meters", "upAxis": "+Y", "bounds": {"min": [-1, 0, -1], "max": [1, 2, 1]},
        "frames": {"dir": "frames", "pattern": "%06d.ply", "gaussiansPerFrame": 10},
        "avatar": None, "audio": None, "preview": None, "thumb": None, "source": None,
        "metrics": None, "createdAt": "2026-10-24T03:00:00Z",
    }
    (tmp_path / "dream.json").write_text(json.dumps(dream))
    write_ply(tmp_path / "frames" / "000000.ply", random_gaussians(n=10))
    assert any("000001.ply" in e for e in validate_bundle(tmp_path))
    write_ply(tmp_path / "frames" / "000001.ply", random_gaussians(n=10))
    assert validate_bundle(tmp_path) == []
