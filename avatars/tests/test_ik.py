import math

import numpy as np
from smplx_rest import smplx_like_rest

from lucid_avatars.ik import look_at, solve_arm, world_joints
from lucid_avatars.rotations import yaw_quat
from lucid_avatars.smplx_layout import NUM_JOINTS, J

ROOT_Q, ROOT_T = yaw_quat(math.pi), np.array([0.0, 0.9, 0.0])


def test_solve_arm_lands_the_wrist_with_the_hand_pointing_down():
    rest = smplx_like_rest()
    target = np.array([-0.3, 1.0, -0.4])
    pose = solve_arm(rest, ROOT_Q, ROOT_T, np.zeros((NUM_JOINTS, 3)), "left", target, hand_dir=[0, -1, 0])
    assert np.isfinite(pose).all()
    pos, _ = world_joints(rest, ROOT_Q, ROOT_T, pose)
    np.testing.assert_allclose(pos[J["left_wrist"]], target, atol=1e-6)
    hand = pos[J["left_middle1"]] - pos[J["left_wrist"]]
    np.testing.assert_allclose(hand / np.linalg.norm(hand), [0, -1, 0], atol=1e-6)


def test_look_at_turns_and_nods_without_tilting_the_head():
    rest = smplx_like_rest()
    for target in ([0.4, 0.6, -0.8], [-0.5, 0.9, -0.6], [0.0, 0.7, -0.9]):
        pose = look_at(rest, ROOT_Q, ROOT_T, np.zeros((NUM_JOINTS, 3)), target)
        pos, R = world_joints(rest, ROOT_Q, ROOT_T, pose)
        to = np.asarray(target) - pos[J["head"]]
        np.testing.assert_allclose(R[J["head"]] @ [0, 0, 1.0], to / np.linalg.norm(to), atol=1e-6)
        ear_to_ear = R[J["spine3"]].T @ R[J["head"]] @ [1.0, 0, 0]
        assert abs(ear_to_ear[1]) < 1e-6  # level ears relative to the chest: yaw and pitch, no roll
