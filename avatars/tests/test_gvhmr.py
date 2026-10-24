import numpy as np

from lucid_avatars import skinning as S
from lucid_avatars.gvhmr import gvhmr_to_motion
from lucid_avatars.motion import validate_motion_dict
from lucid_avatars.rotations import aa_to_quat, quat_to_matrix
from lucid_avatars.smplx_layout import NUM_JOINTS


def _world(yaw=2.0, t=(0.3, -1.1, 0.7)):
    T = np.eye(4)
    T[:3, :3] = quat_to_matrix(aa_to_quat(np.array([0.0, yaw, 0.0])))
    T[:3, 3] = t
    return T


def test_world_transform_is_folded_into_root_exactly():
    rng = np.random.default_rng(0)
    n = 6
    go = rng.normal(scale=0.6, size=(n, 3))
    body = rng.normal(scale=0.3, size=(n, 63))
    transl = rng.normal(size=(n, 3))
    betas = rng.normal(size=(n, 10))
    rest = rng.normal(scale=0.4, size=(NUM_JOINTS, 3))
    W = _world()
    m = gvhmr_to_motion(go, body, transl, betas, fps=30, J0=rest[0], world=W)
    assert validate_motion_dict(m.to_dict()) == []
    np.testing.assert_allclose(m.betas, betas.mean(0))
    np.testing.assert_allclose(m.pose[:, 0], 0)  # root only in root_q
    np.testing.assert_allclose(m.pose[:, 1:22].reshape(n, 63), body)
    np.testing.assert_allclose(m.pose[:, 22:], 0)  # GVHMR has no jaw, eyes or hands
    pts = rng.normal(scale=0.5, size=(40, 3))
    idx = rng.integers(0, 22, size=(40, 4)).astype(np.uint8)
    w = np.tile(np.array([[100, 80, 50, 25]], np.uint8), (40, 1))
    for f in range(n):
        pose = m.pose[f].copy()
        orig = S.pose_points(pts, idx, w, S.skin_matrices(rest, aa_to_quat(go[f]), transl[f], pose))
        expected = orig @ W[:3, :3].T + W[:3, 3]
        got = S.pose_points(pts, idx, w, S.skin_matrices(rest, m.root_q[f], m.root_t[f], pose))
        np.testing.assert_allclose(got, expected, atol=1e-9)


def test_identity_world_keeps_gvhmr_root():
    go = np.array([[0.1, 0.2, 0.3]])
    transl = np.array([[1.0, 2.0, 3.0]])
    m = gvhmr_to_motion(go, np.zeros((1, 63)), transl, np.zeros((1, 10)), fps=25, J0=np.array([0, 0.3, 0]))
    np.testing.assert_allclose(m.root_t, transl, atol=1e-12)
    np.testing.assert_allclose(m.root_q, aa_to_quat(go), atol=1e-12)
    assert m.fps == 25


def test_matrix_to_quat_roundtrips_including_half_turns():
    from lucid_avatars.gvhmr import matrix_to_quat

    rng = np.random.default_rng(4)
    axes = list(rng.normal(size=(50, 3))) + [np.array([1.0, -1.0, 0.0]), np.array([0.0, 1.0, 1.0])]
    for k, a in enumerate(axes):
        aa = a / np.linalg.norm(a) * (np.pi if k >= 50 else rng.uniform(0, np.pi))
        R = quat_to_matrix(aa_to_quat(aa))
        np.testing.assert_allclose(quat_to_matrix(matrix_to_quat(R)), R, atol=1e-9)
