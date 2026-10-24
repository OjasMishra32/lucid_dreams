import json

import numpy as np
import pytest
from smplx_rest import smplx_like_rest

from lucid_avatars import hand_poses as H
from lucid_avatars.hand_fk import (
    FINGER_SLICE,
    HAND_JOINTS,
    fingertips,
    hand_chain,
    hand_rest,
    mirror_hand,
    pinch_gap,
)
from lucid_avatars.rotations import aa_to_quat, quat_to_matrix
from lucid_avatars.smplx_layout import J, JOINT_NAMES, LEFT_HAND, RIGHT_HAND

REST = smplx_like_rest()
SIDES = ("left", "right")


def test_hand_layout_matches_smplx_joint_order():
    assert HAND_JOINTS[:3] == ["index1", "index2", "index3"] and HAND_JOINTS[12:] == ["thumb1", "thumb2", "thumb3"]
    assert JOINT_NAMES[LEFT_HAND] == [f"left_{n}" for n in HAND_JOINTS]
    assert JOINT_NAMES[RIGHT_HAND] == [f"right_{n}" for n in HAND_JOINTS]


def test_zero_pose_puts_tips_straight_out_past_the_third_joint():
    chain = hand_chain(REST, "left", np.zeros((15, 3)))
    for finger, c in chain.items():
        np.testing.assert_allclose(c[:3], hand_rest(REST, "left")[FINGER_SLICE[finger]])
        bone = c[2] - c[1]
        np.testing.assert_allclose(c[3] - c[2], bone / np.linalg.norm(bone) * 0.02, atol=1e-12)


@pytest.mark.parametrize("side", SIDES)
def test_pinch_thumb_tip_meets_index_tip_within_a_centimetre(side):
    assert pinch_gap(REST, side, H.pose("pinch", side)) < 0.01


@pytest.mark.parametrize("side", SIDES)
@pytest.mark.parametrize("tip_offset", [0.015, 0.025])
def test_pinch_survives_a_different_fingertip_length(side, tip_offset):
    assert pinch_gap(REST, side, H.pose("pinch", side), tip_offset) < 0.01


@pytest.mark.parametrize("side", SIDES)
def test_pinch_survives_a_slightly_different_hand(side):
    """A hand 8% bigger or smaller (fingers scaled about the wrist) still has the tips within a centimetre."""
    for scale in (0.92, 1.08):
        rest = REST.copy()
        wrist = rest[J[f"{side}_wrist"]]
        for n in HAND_JOINTS:
            rest[J[f"{side}_{n}"]] = wrist + (rest[J[f"{side}_{n}"]] - wrist) * scale
        assert pinch_gap(rest, side, H.pose("pinch", side), 0.02 * scale) < 0.01


@pytest.mark.parametrize("side", SIDES)
def test_pinch_curls_three_fingers_and_leaves_the_pinch_off_the_palm(side):
    wrist = REST[J[f"{side}_wrist"]]
    flat = fingertips(REST, side, np.zeros((15, 3)))
    tips = fingertips(REST, side, H.pose("pinch", side))
    for f in ("middle", "ring", "pinky"):
        assert np.linalg.norm(tips[f] - wrist) < 0.75 * np.linalg.norm(flat[f] - wrist)  # curled in
    # the pinch itself is out in front of the palm, not collapsed onto the wrist
    assert np.linalg.norm(tips["index"] - wrist) > 0.07


@pytest.mark.parametrize("side", SIDES)
def test_other_poses_are_not_pinches_and_curl_toward_the_palm(side):
    wrist = REST[J[f"{side}_wrist"]]
    reach = lambda name, f: np.linalg.norm(fingertips(REST, side, H.pose(name, side))[f] - wrist)
    assert pinch_gap(REST, side, H.pose("relaxed", side)) > 0.03
    assert pinch_gap(REST, side, H.pose("fist", side)) > 0.03
    for f in ("index", "middle", "ring", "pinky"):
        assert reach("fist", f) < reach("relaxed", f)
        assert reach("fist", f) < 0.12
    # point: the index is out, the others in
    assert reach("point", "index") > reach("point", "middle") + 0.07
    # curling moves the tip to the palm side (down, -y) on both hands, and never through the back of the hand
    tips = lambda name: fingertips(REST, side, H.pose(name, side))
    assert tips("fist")["index"][1] < tips("point")["index"][1] - 0.005
    assert tips("relaxed")["index"][1] < tips("point")["index"][1] - 0.005
    knuckles = hand_rest(REST, side)
    for name in H.POSE_NAMES:
        for f in ("index", "middle", "ring", "pinky"):
            assert tips(name)[f][1] <= knuckles[FINGER_SLICE[f].start][1] + 0.002, (name, f)


def test_left_hand_is_the_exact_mirror_of_the_right():
    for name in H.POSE_NAMES:
        left, right = H.pose(name, "left"), H.pose(name, "right")
        np.testing.assert_allclose(left, mirror_hand(right))
        tl = fingertips(REST, "left", left)
        tr = fingertips(REST, "right", right)
        wl, wr = REST[J["left_wrist"]], REST[J["right_wrist"]]
        for f in tl:
            np.testing.assert_allclose(tl[f] - wl, (tr[f] - wr) * [-1, 1, 1], atol=1e-12)


def test_mirror_is_the_reflection_of_the_rotation():
    rng = np.random.default_rng(3)
    aa = rng.normal(size=(15, 3)) * 0.5
    M = np.diag([-1.0, 1.0, 1.0])
    R = quat_to_matrix(aa_to_quat(aa))
    Rm = quat_to_matrix(aa_to_quat(mirror_hand(aa)))
    np.testing.assert_allclose(Rm, M @ R @ M, atol=1e-12)


@pytest.mark.parametrize("name", H.POSE_NAMES)
@pytest.mark.parametrize("side", SIDES)
def test_named_poses_stay_within_plausible_joint_limits(name, side):
    assert H.limit_violations(H.pose(name, side), side) == []
    clamped, share = H.clamp_to_limits(H.pose(name, side), side)
    np.testing.assert_allclose(clamped, H.pose(name, side))
    assert share == 0.0


def test_poses_are_anatomical_hinges():
    for name in H.POSE_NAMES:
        p = H.RIGHT_POSES[name]
        for f in ("index", "middle", "ring", "pinky"):
            sl = p[FINGER_SLICE[f]]
            assert np.all(sl[:, :2] == 0)       # fingers only flex
            assert np.all(sl[:, 2] >= 0)        # never hyperextended
        assert np.abs(p).max() < 2.0            # nothing past ~115 degrees


def test_clamp_cuts_a_wild_finger_and_leaves_the_rest():
    p = H.pose("relaxed", "right")
    wild = p.copy()
    wild[1] = [0.0, 1.4, 3.0]  # index2 bent 170 degrees and sideways
    out, share = H.clamp_to_limits(wild)
    assert share == pytest.approx(1 / 15)
    np.testing.assert_allclose(np.delete(out, 1, axis=0), np.delete(p, 1, axis=0))
    assert out[1, 2] == 2.0 and out[1, 1] == 0.15
    # the left hand is cut the same way
    left_out, left_share = H.clamp_to_limits(mirror_hand(wild), "left")
    np.testing.assert_allclose(left_out, mirror_hand(out))
    assert left_share == pytest.approx(1 / 15)


def test_clamp_limits_a_thumb_by_total_angle_and_handles_frames():
    p = np.zeros((4, 15, 3))
    p[2, 12] = [0.0, 0.0, 3.0]
    out, share = H.clamp_to_limits(p)
    assert np.linalg.norm(out[2, 12]) == pytest.approx(1.2)
    np.testing.assert_allclose(share, [0, 0, 1 / 15, 0])


def test_blend_endpoints_and_midpoint():
    a, b = H.pose("relaxed"), H.pose("fist")
    np.testing.assert_allclose(H.blend(a, b, 0.0), a, atol=1e-9)
    np.testing.assert_allclose(H.blend(a, b, 1.0), b, atol=1e-9)
    mid = H.blend(H.pose("point"), H.pose("fist"), 0.5)
    # same-axis flexions halve: slerp of z rotations is their mean
    np.testing.assert_allclose(mid[:3, 2], (H.pose("point")[:3, 2] + H.pose("fist")[:3, 2]) / 2, atol=1e-9)


def test_blend_takes_the_short_way_round_and_is_a_slerp():
    a = np.zeros((15, 3))
    b = np.zeros((15, 3))
    b[0] = [0, 0, 2 * np.pi - 0.4]  # the same rotation as -0.4 about z, written the long way
    half = H.blend(a, b, 0.5)
    np.testing.assert_allclose(half[0], [0, 0, -0.2], atol=1e-9)
    # constant angular speed: a quarter of the way is a quarter of the angle
    c = np.zeros((15, 3))
    c[0] = [0.0, 1.2, 0.0]
    np.testing.assert_allclose(H.blend(a, c, 0.25)[0], [0, 0.3, 0], atol=1e-9)


def test_blend_over_frames():
    a, b = H.pose("relaxed"), H.pose("pinch")
    t = np.array([0.0, 0.5, 1.0])
    out = H.blend(a, b, t)
    assert out.shape == (3, 15, 3)
    np.testing.assert_allclose(out[0], a, atol=1e-9)
    np.testing.assert_allclose(out[2], b, atol=1e-9)
    np.testing.assert_allclose(out[1], H.blend(a, b, 0.5), atol=1e-12)
    stack = np.stack([a, b, a])
    np.testing.assert_allclose(H.blend(stack, b, 1.0), np.stack([b, b, b]), atol=1e-9)


def test_blending_to_a_pinch_closes_the_gap_smoothly():
    gaps = [pinch_gap(REST, "right", H.blend(H.pose("relaxed"), H.pose("pinch"), t)) for t in np.linspace(0, 1, 11)]
    assert gaps[-1] < 0.01 and gaps[0] > 0.04
    assert all(b <= a + 1e-9 for a, b in zip(gaps, gaps[1:]))  # closes monotonically, never opens and closes again


def test_unknown_side_is_refused():
    with pytest.raises(ValueError):
        H.pose("pinch", "middle")


def test_json_file_is_what_the_code_writes_and_reads_back_to_the_poses():
    on_disk = json.loads(H.JSON_FILE.read_text())
    assert on_disk == json.loads(json.dumps(H.to_json_dict()))
    assert on_disk["joints"] == HAND_JOINTS
    for name in H.POSE_NAMES:
        for side in SIDES:
            entry = on_disk["poses"][name][side]
            np.testing.assert_allclose(entry["axisAngle"], H.pose(name, side), atol=1e-6)
            q = np.asarray(entry["quat"])
            assert q.shape == (15, 4)
            np.testing.assert_allclose(np.linalg.norm(q, axis=1), 1.0, atol=1e-6)
            np.testing.assert_allclose(quat_to_matrix(q), quat_to_matrix(aa_to_quat(H.pose(name, side))), atol=1e-5)
