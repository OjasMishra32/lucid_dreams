import json

import numpy as np
import pytest

from lucid_avatars import skinning as S
from lucid_avatars.bundle import validate_bundle, write_avatar_bundle
from lucid_avatars.idle import idle_loop
from lucid_avatars.rotations import aa_to_quat
from lucid_avatars.smplx_layout import J, NUM_JOINTS, SMPLX_PARENTS

from test_bundle import random_gaussians


def test_parents_are_a_tree_in_smplx_order():
    assert len(SMPLX_PARENTS) == NUM_JOINTS and SMPLX_PARENTS[0] == -1
    assert all(0 <= p < j for j, p in enumerate(SMPLX_PARENTS) if j)
    assert SMPLX_PARENTS[J["left_elbow"]] == J["left_shoulder"]
    assert SMPLX_PARENTS[J["jaw"]] == J["head"]
    assert SMPLX_PARENTS[J["left_index1"]] == J["left_wrist"]
    assert SMPLX_PARENTS[J["right_thumb3"]] == J["right_thumb2"]


def test_rest_joints_regress_the_shaped_template():
    v = np.arange(12, dtype=float).reshape(4, 3)
    shapedirs = np.zeros((4, 3, 10))
    shapedirs[:, 1, 0] = 1.0  # beta 0 lifts every vertex
    Jreg = np.zeros((NUM_JOINTS, 4))
    Jreg[:, 0] = Jreg[:, 1] = 0.5
    joints, verts = S.rest_joints(v, shapedirs, Jreg, np.r_[0.25, np.zeros(9)])
    np.testing.assert_allclose(verts[:, 1], v[:, 1] + 0.25)
    np.testing.assert_allclose(joints[0], (verts[0] + verts[1]) / 2)
    assert joints.shape == (NUM_JOINTS, 3)


def test_blend_vertex_weights_copies_an_exact_hit_and_normalises():
    lbs = np.zeros((3, NUM_JOINTS))
    lbs[0, 1], lbs[1, 2], lbs[2, 3] = 1, 1, 1
    idx = np.array([[0, 1], [1, 2]])
    dist = np.array([[0.0, 0.5], [0.1, 0.1]])
    w = S.blend_vertex_weights(lbs, idx, dist)
    np.testing.assert_allclose(w.sum(1), 1)
    assert w[0, 1] > 0.999  # sitting on vertex 0
    np.testing.assert_allclose(w[1, [2, 3]], [0.5, 0.5])


def test_quantize_top4_keeps_the_biggest_joints_and_sums_to_255():
    w = np.zeros((3, NUM_JOINTS))
    w[0, 7] = 1.0
    w[1, [1, 2, 3, 4, 5]] = [0.4, 0.3, 0.15, 0.1, 0.05]
    w[2, [10, 11, 12]] = 1 / 3
    idx, q = S.quantize_top4(w)
    assert idx.dtype == np.uint8 and q.dtype == np.uint8 and idx.shape == q.shape == (3, 4)
    assert (q.astype(int).sum(1) == 255).all()
    assert idx[0, 0] == 7 and list(q[0]) == [255, 0, 0, 0]
    assert list(idx[1]) == [1, 2, 3, 4]  # the 0.05 joint is dropped and the rest renormalised
    assert q[1, 0] > q[1, 1] > q[1, 2] > q[1, 3]
    assert sorted(q[2][:3]) == [85, 85, 85]


def test_skin_bin_is_eight_bytes_per_gaussian_index_then_weight(tmp_path):
    idx = np.array([[1, 2, 3, 4], [9, 0, 0, 0]], dtype=np.uint8)
    q = np.array([[100, 80, 50, 25], [255, 0, 0, 0]], dtype=np.uint8)
    path = tmp_path / "skin.bin"
    S.write_skin_bin(path, idx, q)
    raw = path.read_bytes()
    assert len(raw) == 16 and list(raw[:8]) == [1, 2, 3, 4, 100, 80, 50, 25]
    back_idx, back_q = S.read_skin_bin(path)
    np.testing.assert_array_equal(back_idx, idx)
    np.testing.assert_array_equal(back_q, q)


def _skeleton(seed=0):
    rng = np.random.default_rng(seed)
    return S.skeleton_dict(rng.normal(size=(NUM_JOINTS, 3)) * 0.3)


def test_skeleton_dict_names_parents_and_rest():
    sk = _skeleton()
    assert sk["joints"][0] == "pelvis" and len(sk["joints"]) == NUM_JOINTS
    assert sk["parents"] == list(SMPLX_PARENTS)
    assert len(sk["rest"]) == NUM_JOINTS and all(len(p) == 3 for p in sk["rest"])
    assert S.skeleton_errors(sk) == []
    assert S.skeleton_errors({**sk, "parents": sk["parents"][:-1]})


def test_rest_pose_leaves_points_where_they_are():
    sk = _skeleton()
    mats = S.skin_matrices(np.array(sk["rest"]), np.array([0, 0, 0, 1.0]), np.zeros(3), np.zeros((NUM_JOINTS, 3)))
    pts = np.random.default_rng(1).normal(size=(50, 3))
    idx = np.tile(np.array([[3, 7, 0, 0]], dtype=np.uint8), (50, 1))
    q = np.tile(np.array([[200, 55, 0, 0]], dtype=np.uint8), (50, 1))
    np.testing.assert_allclose(S.pose_points(pts, idx, q, mats), pts, atol=1e-12)


def test_root_motion_matches_smplx_transl_and_global_orient():
    """SMPL-X: v -> R (v - J0) + J0 + transl for a point skinned only to the pelvis."""
    sk = _skeleton()
    J0 = np.array(sk["rest"][0])
    aa = np.array([0.3, -1.1, 0.4])
    t = np.array([0.5, 0.9, -2.0])
    mats = S.skin_matrices(np.array(sk["rest"]), aa_to_quat(aa), t, np.zeros((NUM_JOINTS, 3)))
    pts = np.random.default_rng(2).normal(size=(20, 3))
    idx = np.zeros((20, 4), dtype=np.uint8)
    q = np.zeros((20, 4), dtype=np.uint8)
    q[:, 0] = 255
    from lucid_avatars.rotations import rotate_by_quat

    expected = rotate_by_quat(aa_to_quat(aa), pts - J0) + J0 + t
    np.testing.assert_allclose(S.pose_points(pts, idx, q, mats), expected, atol=1e-9)


def test_bending_the_elbow_moves_only_the_forearm_about_the_elbow():
    sk = _skeleton()
    rest = np.array(sk["rest"])
    pose = np.zeros((NUM_JOINTS, 3))
    pose[J["left_elbow"], 1] = np.pi / 2
    mats = S.skin_matrices(rest, np.array([0, 0, 0, 1.0]), np.zeros(3), pose)
    elbow = rest[J["left_elbow"]]
    pts = np.array([elbow + [0.1, 0, 0], elbow + [0.2, 0.05, 0]])
    idx = np.array([[J["left_elbow"], 0, 0, 0], [J["left_shoulder"], 0, 0, 0]], dtype=np.uint8)
    q = np.array([[255, 0, 0, 0], [255, 0, 0, 0]], dtype=np.uint8)
    posed = S.pose_points(pts, idx, q, mats)
    assert np.linalg.norm(posed[0] - elbow) == pytest.approx(0.1)  # rotated about the elbow
    assert not np.allclose(posed[0], pts[0])
    np.testing.assert_allclose(posed[1], pts[1])  # upper arm doesn't move


def _bundle_with_skin(tmp_path, n=1000):
    g = random_gaussians(n=n, sh_degree=0)
    w = np.random.default_rng(3).dirichlet(np.ones(NUM_JOINTS), size=n)
    idx, q = S.quantize_top4(w)
    root = write_avatar_bundle(tmp_path / "dreams", "skinned", "Skinned", g, idle_loop(np.zeros(10), 1.0, 30),
                               skin=(idx, q), skeleton=_skeleton())
    return root


def test_bundle_with_skin_and_skeleton_is_valid(tmp_path):
    root = _bundle_with_skin(tmp_path)
    avatar = json.loads((root / "dream.json").read_text())["avatar"]
    assert avatar["skin"] == "avatar/skin.bin" and avatar["skeleton"] == "avatar/skeleton.json"
    assert validate_bundle(root) == []


def test_validate_bundle_catches_a_bad_skin(tmp_path):
    root = _bundle_with_skin(tmp_path)
    skin = root / "avatar" / "skin.bin"
    raw = bytearray(skin.read_bytes())
    raw[0] = 77  # joint index out of range
    raw[12] = (raw[12] + 1) % 256  # weights of Gaussian 1 no longer sum to 255
    skin.write_bytes(bytes(raw))
    errors = validate_bundle(root)
    assert any("joint index" in e for e in errors) and any("255" in e for e in errors)
    skin.write_bytes(bytes(raw[:-8]))
    assert any("Gaussians" in e for e in validate_bundle(root))
