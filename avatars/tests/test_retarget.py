import numpy as np

from lucid_avatars import retarget as R
from lucid_avatars import skinning as S
from lucid_avatars.motion import Motion
from lucid_avatars.rotations import aa_to_quat, rotate_by_quat
from lucid_avatars.smplx_layout import J, NUM_JOINTS


def _body():
    """A stick person: rest joints, and points hanging off the pelvis (torso) and the feet (soles at y = -1.0)."""
    rest = np.zeros((NUM_JOINTS, 3))
    rest[J["left_ankle"]] = [0.1, -0.9, 0]
    rest[J["right_ankle"]] = [-0.1, -0.9, 0]
    rest[J["left_foot"]] = [0.1, -0.95, 0.1]
    rest[J["right_foot"]] = [-0.1, -0.95, 0.1]
    rest[J["head"]] = [0, 0.6, 0]
    rng = np.random.default_rng(0)
    torso = rng.uniform([-0.2, -0.5, -0.1], [0.2, 0.7, 0.1], size=(300, 3))
    lfoot = rest[J["left_foot"]] + rng.uniform(-0.03, 0.03, size=(50, 3)) + [0, -0.02, 0]
    rfoot = rest[J["right_foot"]] + rng.uniform(-0.03, 0.03, size=(50, 3)) + [0, -0.02, 0]
    xyz = np.concatenate([torso, lfoot, rfoot])
    idx = np.zeros((len(xyz), 4), dtype=np.uint8)
    idx[300:350, 0], idx[350:, 0] = J["left_foot"], J["right_foot"]
    w = np.zeros((len(xyz), 4), dtype=np.uint8)
    w[:, 0] = 255
    return xyz, np.full(len(xyz), 3.0), idx, w, rest


def _motion(n=20, heading=np.pi / 2, height=0.7, jump=0.3):
    t = np.zeros((n, 3))
    t[:, 0] = 2.0  # somewhere off to the side
    t[:, 1] = height + jump * np.clip(np.sin(np.linspace(0, np.pi, n)), 0, None)  # stands, jumps, lands
    q = np.tile(aa_to_quat(np.array([0, heading, 0])), (n, 1))
    return Motion(fps=30, betas=np.zeros(10), root_t=t, root_q=q, pose=np.zeros((n, NUM_JOINTS, 3)))


def test_place_on_floor_puts_the_lowest_sole_on_y0_and_faces_the_viewer():
    xyz, opacity, idx, w, rest = _body()
    m = R.place_on_floor(_motion(), xyz, opacity, idx, w, rest)
    lows = []
    for f in range(m.num_frames):
        M = S.skin_matrices(rest, m.root_q[f], m.root_t[f], m.pose[f])
        lows.append(S.pose_points(xyz, idx, w, M)[:, 1].min())
    assert abs(min(lows)) < 0.01  # standing frames touch the floor
    assert max(lows) > 0.25  # the jump still leaves it
    forward = rotate_by_quat(m.root_q[0], np.array([0, 0, 1.0]))
    np.testing.assert_allclose(forward, [0, 0, -1], atol=1e-9)  # front faces -Z
    pelvis0 = m.root_t[0] + rest[0]
    np.testing.assert_allclose(pelvis0[[0, 2]], 0, atol=1e-9)  # centred on x = z = 0


def test_place_on_floor_ignores_faint_gaussians():
    xyz, opacity, idx, w, rest = _body()
    xyz = np.concatenate([xyz, [[0, -3.0, 0]]])  # a floater far below the feet
    opacity = np.concatenate([opacity, [-6.0]])
    idx = np.concatenate([idx, np.zeros((1, 4), np.uint8)])
    w = np.concatenate([w, np.array([[255, 0, 0, 0]], np.uint8)])
    m = R.place_on_floor(_motion(jump=0.0), xyz, opacity, idx, w, rest)
    M = S.skin_matrices(rest, m.root_q[0], m.root_t[0], m.pose[0])
    assert abs(S.pose_points(xyz[:-1], idx[:-1], w[:-1], M)[:, 1].min()) < 0.01


def test_retarget_keeps_the_pose_and_scales_the_path_by_leg_length():
    m = _motion()
    m.pose[:, J["left_knee"], 0] = 0.5
    rest_src = np.zeros((NUM_JOINTS, 3))
    rest_src[J["left_hip"]], rest_src[J["left_ankle"]] = [0.1, -0.1, 0], [0.1, -1.0, 0]
    rest_dst = rest_src * 0.5  # a child half the size
    out = R.retarget(m, rest_src, rest_dst, betas=np.ones(10))
    np.testing.assert_allclose(out.pose, m.pose)
    np.testing.assert_allclose(out.betas, np.ones(10))
    step = np.diff(m.root_t[:, [0, 2]], axis=0)
    np.testing.assert_allclose(np.diff(out.root_t[:, [0, 2]], axis=0), step * 0.5, atol=1e-12)
