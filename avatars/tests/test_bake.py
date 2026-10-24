import json

import numpy as np

from lucid_avatars import bake as B
from lucid_avatars import skinning as S
from lucid_avatars.bundle import validate_bundle, write_avatar_bundle
from lucid_avatars.gaussian_ply import read_ply
from lucid_avatars.idle import idle_loop
from lucid_avatars.rotations import aa_to_quat, quat_to_matrix
from lucid_avatars.smplx_layout import NUM_JOINTS

from test_bundle import random_gaussians


def _skin(n, seed=0):
    return S.quantize_top4(np.random.default_rng(seed).dirichlet(np.ones(NUM_JOINTS) * 0.1, size=n))


def _rest(seed=1):
    return np.random.default_rng(seed).normal(scale=0.3, size=(NUM_JOINTS, 3))


def test_rest_pose_changes_nothing():
    g = random_gaussians(n=200, sh_degree=0)
    idx, w = _skin(200)
    M = S.skin_matrices(_rest(), np.array([0, 0, 0, 1.0]), np.zeros(3), np.zeros((NUM_JOINTS, 3)))
    posed = B.pose_gaussians(g, idx, w, M)
    np.testing.assert_allclose(posed.xyz, g.xyz, atol=1e-9)
    np.testing.assert_allclose(np.abs(np.sum(posed.rotation * g.rotation, axis=1)), 1, atol=1e-9)
    np.testing.assert_array_equal(posed.f_dc, g.f_dc)
    np.testing.assert_array_equal(posed.scale, g.scale)


def test_root_turn_rotates_positions_and_orientations_together():
    g = random_gaussians(n=50, sh_degree=0)
    idx, w = _skin(50)
    q = aa_to_quat(np.array([0.0, np.pi / 2, 0.0]))
    M = S.skin_matrices(_rest(), q, np.array([1.0, 0, 0]), np.zeros((NUM_JOINTS, 3)))
    posed = B.pose_gaussians(g, idx, w, M)
    R = quat_to_matrix(q)
    np.testing.assert_allclose(posed.xyz, S.pose_points(g.xyz, idx, w, M), atol=1e-12)
    # each Gaussian's axes turn with the body: compare rotation matrices (stored as w, x, y, z)
    def mat(wxyz):
        return quat_to_matrix(np.concatenate([wxyz[:, 1:], wxyz[:, :1]], axis=1))
    np.testing.assert_allclose(mat(posed.rotation), R @ mat(g.rotation), atol=1e-9)


def test_bake_writes_a_valid_replay_bundle(tmp_path):
    n = 300
    g = random_gaussians(n=n, sh_degree=0)
    motion = idle_loop(np.zeros(10), seconds=1.0, fps=30)
    src = write_avatar_bundle(tmp_path / "dreams", "grandma", "Grandma", g, motion,
                              skin=_skin(n), skeleton=S.skeleton_dict(_rest()))
    out = B.bake_bundle(src, tmp_path / "dreams", "grandma-baked", fps=10)
    assert validate_bundle(out) == []
    dream = json.loads((out / "dream.json").read_text())
    assert dream["kind"] == "replay" and dream["avatar"] is None
    assert dream["fps"] == 10 and dream["frameCount"] == 10
    assert dream["frames"]["gaussiansPerFrame"] == n
    assert dream["source"]["bakedFrom"] == "grandma"
    assert len(read_ply(out / "frames" / "000003.ply")) == n
    if dream["frames"].get("spz"):
        assert (out / "frames" / "000003.spz").stat().st_size > 0
