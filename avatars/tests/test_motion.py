import json

import numpy as np
import pytest

from lucid_avatars import motion as M
from lucid_avatars.rotations import aa_to_quat, quat_to_aa
from lucid_avatars.smplx_layout import DIGS_PARAM_DIM, JOINT_NAMES, NUM_JOINTS


def random_motion(n=5, seed=0):
    rng = np.random.default_rng(seed)
    return M.Motion(
        fps=30,
        betas=rng.normal(size=10),
        root_t=rng.normal(size=(n, 3)),
        root_q=np.stack([aa_to_quat(a) for a in rng.normal(scale=0.5, size=(n, 3))]),
        pose=rng.normal(scale=0.3, size=(n, NUM_JOINTS, 3)),
    )


def test_joint_layout_is_smplx_55():
    assert NUM_JOINTS == 55
    assert JOINT_NAMES[0] == "pelvis"
    assert JOINT_NAMES[22:25] == ["jaw", "left_eye", "right_eye"]
    assert JOINT_NAMES[25].startswith("left_index") and JOINT_NAMES[40].startswith("right_index")


def test_quat_roundtrip():
    rng = np.random.default_rng(1)
    for aa in rng.normal(scale=1.0, size=(50, 3)):
        q = aa_to_quat(aa)
        assert np.isclose(np.linalg.norm(q), 1.0)
        np.testing.assert_allclose(aa_to_quat(quat_to_aa(q)), q, atol=1e-9)
    np.testing.assert_allclose(aa_to_quat(np.zeros(3)), [0, 0, 0, 1])


def test_json_roundtrip_matches_contract_shape(tmp_path):
    m = random_motion()
    path = tmp_path / "motion.json"
    m.save(path)
    raw = json.loads(path.read_text())
    assert set(raw) == {"fps", "betas", "frames"}
    assert len(raw["betas"]) == 10
    f0 = raw["frames"][0]
    assert set(f0) == {"root_t", "root_q", "pose"}
    assert len(f0["root_q"]) == 4 and len(f0["pose"]) == 55 and len(f0["pose"][0]) == 3
    back = M.Motion.load(path)
    np.testing.assert_allclose(back.pose, m.pose, atol=1e-6)
    np.testing.assert_allclose(back.root_q, m.root_q, atol=1e-6)
    assert back.fps == 30


def test_validate_rejects_bad_motion():
    m = random_motion()
    assert M.validate_motion_dict(m.to_dict()) == []
    bad = m.to_dict()
    bad["frames"][1]["pose"] = bad["frames"][1]["pose"][:54]
    bad["frames"][2]["root_q"] = [0, 0, 0, 2]
    bad["betas"] = [0.0] * 9
    errors = M.validate_motion_dict(bad)
    assert any("pose" in e for e in errors)
    assert any("root_q" in e for e in errors)
    assert any("betas" in e for e in errors)


def test_digs_packed_roundtrip():
    rng = np.random.default_rng(2)
    n = 4
    hand_mean = rng.normal(scale=0.1, size=90)
    packed = rng.normal(scale=0.3, size=(n, DIGS_PARAM_DIM))
    packed[:, 0] = 1.0
    packed[:, 70:80] = packed[0, 70:80]  # betas are static
    m = M.from_digs_params(packed, fps=25, hand_mean=hand_mean)
    assert m.pose.shape == (n, 55, 3)
    # Hands in motion.json are absolute: DiGS stores them relative to the SMPL-X hand mean.
    np.testing.assert_allclose(m.pose[:, 25:40].reshape(n, 45), packed[:, 80:125] + hand_mean[:45])
    back = M.to_digs_params(m, hand_mean=hand_mean)
    np.testing.assert_allclose(back[:, :159], packed[:, :159], atol=1e-6)


def test_face_viewer_on_floor():
    m = random_motion(n=3)
    m.root_q[:] = [0, 0, 0, 1]  # facing +Z, the SMPL-X canonical direction
    m.root_t[:] = [[2.0, 1.1, 3.0], [2.5, 1.2, 3.0], [3.0, 1.1, 3.5]]
    out = M.face_viewer_on_floor(m, floor_y=0.1)
    # First frame is centred on x = z = 0 and lifted so the floor sits at y = 0.
    np.testing.assert_allclose(out.root_t[0], [0.0, 1.0, 0.0], atol=1e-9)
    # A 180 degree yaw turns +Z into -Z, so later displacement flips sign in x and z.
    np.testing.assert_allclose(out.root_t[2], [-1.0, 1.0, -0.5], atol=1e-9)
    np.testing.assert_allclose(np.abs(out.root_q[0]), [0, 1, 0, 0], atol=1e-9)
    # The input is untouched.
    assert m.root_t[0, 0] == 2.0


def test_from_digs_rejects_wrong_width():
    with pytest.raises(ValueError):
        M.from_digs_params(np.zeros((2, 100)), fps=30, hand_mean=np.zeros(90))


def test_face_viewer_on_floor_handles_any_starting_heading():
    m = random_motion(n=2)
    m.pose[:] = 0
    m.root_q[:] = aa_to_quat(np.array([0.0, np.pi / 2, 0.0]))  # facing +X
    out = M.face_viewer_on_floor(m, floor_y=0.0)
    np.testing.assert_allclose(np.abs(out.root_q[0]), [0, 1, 0, 0], atol=1e-9)


def test_face_viewer_on_floor_centres_pelvis_when_rest_joint_known():
    m = random_motion(n=2)
    m.root_q[:] = [0, 0, 0, 1]
    j0 = np.array([0.003, -0.35, 0.028])
    out = M.face_viewer_on_floor(m, floor_y=0.0, pelvis_rest=j0)
    pelvis_world = out.root_t[0] + j0  # SMPL-X puts the pelvis at J0 + transl
    np.testing.assert_allclose(pelvis_world[[0, 2]], [0, 0], atol=1e-9)


def test_validate_rejects_bool_and_infinite_fps():
    d = random_motion().to_dict()
    d["fps"] = float("inf")
    assert M.validate_motion_dict(d)
    d["fps"] = True
    assert M.validate_motion_dict(d)
