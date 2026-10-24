import numpy as np
import pytest
from smplx_rest import smplx_like_rest

from lucid_avatars.idle import (
    ANKLE_ABOVE_FLOOR,
    BOARD_HALF,
    BOARD_Z,
    ELBOW_ON_TABLE,
    HIP_ABOVE_SEAT,
    MAX_LEAN,
    MIN_SEAT_Y,
    WRIST_ON_TABLE,
    idle_loop,
    seated_idle,
    seated_rest_pose,
)
from lucid_avatars.ik import world_joints
from lucid_avatars.motion import validate_motion_dict
from lucid_avatars.rotations import quat_to_aa, quat_to_matrix
from lucid_avatars.smplx_layout import J


def test_idle_loop_is_valid_motion():
    m = idle_loop(betas=np.zeros(10), seconds=8.0, fps=30)
    assert m.pose.shape == (240, 55, 3)
    assert validate_motion_dict(m.to_dict()) == []


def test_idle_loop_wraps_seamlessly():
    m = idle_loop(betas=np.zeros(10), seconds=8.0, fps=30)
    # The step from the last frame back to the first must be no bigger than an ordinary step.
    body = np.delete(m.pose, [J["left_eye"], J["right_eye"]], axis=1)  # saccades are jumps; their own test checks them
    steps = np.abs(np.diff(body, axis=0)).max(axis=(1, 2))
    wrap = np.abs(body[0] - body[-1]).max()
    assert wrap <= steps.max() * 1.05
    t_steps = np.abs(np.diff(m.root_t, axis=0)).max()
    assert np.abs(m.root_t[0] - m.root_t[-1]).max() <= t_steps * 1.05


def test_idle_loop_moves_but_subtly():
    m = idle_loop(betas=np.zeros(10), seconds=8.0, fps=30)
    spread = m.pose.max(axis=0) - m.pose.min(axis=0)
    assert spread.max() > 0.01  # something is alive
    assert spread.max() < 0.15  # nothing swings more than ~8 degrees
    assert np.ptp(m.root_t[:, 0]) < 0.05  # weight shift stays within a few cm


def test_idle_loop_stands_facing_viewer():
    m = idle_loop(betas=np.zeros(10), seconds=4.0, fps=30)
    yaw = quat_to_aa(m.root_q[0])
    np.testing.assert_allclose(np.abs(yaw), [0, np.pi, 0], atol=1e-6)
    # Arms hang down instead of the SMPL-X T-pose.
    assert m.pose[0, 16, 2] < -1.0 and m.pose[0, 17, 2] > 1.0


def test_idle_loop_wraps_when_seconds_is_not_whole_frames():
    m = idle_loop(betas=np.zeros(10), seconds=0.5, fps=25)
    steps = np.abs(np.diff(m.pose, axis=0)).max()
    assert np.abs(m.pose[0] - m.pose[-1]).max() <= steps * 1.05


def test_idle_loop_blinks_along_the_given_direction():
    closed = np.zeros(10)
    closed[2] = 1.5
    m = idle_loop(np.zeros(10), seconds=8.0, fps=30, blink_expr=closed)
    assert validate_motion_dict(m.to_dict()) == []
    amount = m.expr[:, 2] / 1.5
    np.testing.assert_allclose(np.delete(m.expr, 2, axis=1), 0)
    assert amount.max() == pytest.approx(1.0) and amount.min() == 0.0
    closed_frames = int((amount > 0.5).sum())
    assert 2 <= closed_frames <= 12  # a couple of quick blinks in 8 s, not a long squint
    assert amount[0] == 0.0 and amount[-1] == 0.0  # wraps with eyes open
    assert idle_loop(np.zeros(10), seconds=2.0).expr is None


# ---------------- seated idle (the chess opponent) ----------------

SEAT_Y, TABLE_Y = 0.45, 0.75


@pytest.fixture(scope="module")
def seated():
    rest = smplx_like_rest()
    m = seated_idle(rest, np.zeros(10), seconds=8.0, fps=30, seat_y=SEAT_Y, table_y=TABLE_Y)
    pos, rot = zip(*(world_joints(rest, m.root_q[f], m.root_t[f], m.pose[f]) for f in range(m.num_frames)))
    return m, np.stack(pos), np.stack(rot)


def test_seated_idle_is_valid_and_wraps(seated):
    m, _, _ = seated
    assert m.pose.shape == (240, 55, 3)
    assert validate_motion_dict(m.to_dict()) == []
    steps = np.abs(np.diff(m.pose, axis=0)).max(axis=(1, 2))
    assert np.abs(m.pose[0] - m.pose[-1]).max() <= steps.max() * 1.05


def test_seated_idle_faces_the_viewer_and_sits_on_the_chair(seated):
    m, pos, _ = seated
    facing = quat_to_matrix(m.root_q[0]) @ [0, 0, 1.0]  # leaning in from the hips, but turned to face -Z
    assert abs(facing[0]) < 1e-9 and facing[2] < -0.8
    seat = seated_rest_pose(smplx_like_rest(), SEAT_Y, TABLE_Y).seat_y
    assert MIN_SEAT_Y <= seat <= SEAT_Y  # this body's arms are short, so the seat may have come down a little
    hips = (pos[:, J["left_hip"]] + pos[:, J["right_hip"]]) / 2
    np.testing.assert_allclose(hips, np.tile([0, seat + HIP_ABOVE_SEAT, 0], (len(hips), 1)), atol=1e-6)
    for side in ("left", "right"):
        knee, hip, ankle = pos[:, J[f"{side}_knee"]], pos[:, J[f"{side}_hip"]], pos[:, J[f"{side}_ankle"]]
        thigh = knee - hip
        slope = np.degrees(np.arctan2(-thigh[:, 1], np.linalg.norm(thigh[:, [0, 2]], axis=1)))
        assert np.all((-1 < slope) & (slope < 20))             # thighs on the seat, at most sloping down a little
        assert np.all(knee[:, 2] < hip[:, 2] - 0.3)            # knees out in front (front is -Z)
        np.testing.assert_allclose(ankle[:, 1], ANKLE_ABOVE_FLOOR, atol=0.01)  # feet on the floor
        assert np.all(pos[:, J[f"{side}_foot"], 1] > 0)


def test_seated_idle_rests_forearms_on_the_table(seated):
    _, pos, _ = seated
    for side in ("left", "right"):
        elbow, wrist = pos[:, J[f"{side}_elbow"]], pos[:, J[f"{side}_wrist"]]
        np.testing.assert_allclose(elbow[:, 1], TABLE_Y + ELBOW_ON_TABLE, atol=1e-3)
        np.testing.assert_allclose(wrist[:, 1], TABLE_Y + WRIST_ON_TABLE, atol=1e-3)
        assert np.ptp(wrist, axis=0).max() < 1e-3          # hands stay put while the chest breathes
        assert np.all(wrist[:, 2] < elbow[:, 2] - 0.05)    # forearms point at the board
        for finger in ("index3", "middle3", "ring3", "pinky3", "thumb3"):  # fingertips short of the board's frame
            assert np.all(pos[:, J[f"{side}_{finger}"], 2] > -(BOARD_Z - BOARD_HALF))
    assert np.all(pos[:, J["left_wrist"], 0] < pos[:, J["right_wrist"], 0])  # left hand on the viewer's right


def test_seated_idle_looks_down_at_the_board(seated):
    _, pos, rot = seated
    board = np.array([0, TABLE_Y, -BOARD_Z])
    to_board = board - pos[:, J["head"]]
    to_board /= np.linalg.norm(to_board, axis=1, keepdims=True)
    facing = rot[:, J["head"]] @ np.array([0, 0, 1.0])
    angle = np.degrees(np.arccos(np.clip(np.sum(facing * to_board, axis=1), -1, 1)))
    assert angle.max() < 6


def test_seated_idle_breathes_and_blinks():
    rest = smplx_like_rest()
    closed = np.zeros(10)
    closed[2] = 1.5
    m = seated_idle(rest, np.zeros(10), seconds=8.0, fps=30, blink_expr=closed)
    spine = m.pose[:, J["spine2"]]
    assert 0.005 < np.ptp(spine[:, 0]) < 0.1
    assert m.expr is not None and m.expr[:, 2].max() == pytest.approx(1.5)
    assert m.expr[0, 2] == 0 and m.expr[-1, 2] == 0


def test_seated_keeps_the_chair_height_when_the_arms_reach():
    rest = smplx_like_rest()
    for side in ("left", "right"):  # 20% longer arms
        chain = [J[f"{side}_{n}"] for n in ("shoulder", "elbow", "wrist")]
        hand = range(25, 40) if side == "left" else range(40, 55)
        below = [*chain[1:], *hand]
        rest[below] = rest[chain[0]] + 1.2 * (rest[below] - rest[chain[0]])
    s = seated_rest_pose(rest, SEAT_Y, TABLE_Y)
    assert s.seat_y == pytest.approx(SEAT_Y)
    assert 0 <= s.lean <= MAX_LEAN


def test_seated_takes_a_seat_lower_than_the_minimum():
    s = seated_rest_pose(smplx_like_rest(), seat_y=0.30, table_y=TABLE_Y)
    assert s.seat_y == pytest.approx(0.30) and np.isfinite(s.pose).all()


# ---------------- life when idle ----------------

def _blinks(amount, fps):
    """Start times (s) and lengths (s) of each blink in a 0..1 curve."""
    on = amount > 0
    starts = np.flatnonzero(on & ~np.roll(on, 1))
    ends = np.flatnonzero(on & ~np.roll(on, -1))
    return starts / fps, (ends - starts + 1) / fps


def test_idle_loop_is_twenty_seconds_by_default():
    m = idle_loop(np.zeros(10))
    assert m.num_frames / m.fps == pytest.approx(20.0)


def test_idle_breathes_two_to_three_mm_at_the_chest():
    rest = smplx_like_rest()
    m = idle_loop(np.zeros(10), seconds=8.0, fps=30)
    rel = []
    for f in range(m.num_frames):
        p, R = world_joints(rest, m.root_q[f], m.root_t[f], m.pose[f])
        rel.append(R[0].T @ ((p[J["left_shoulder"]] + p[J["right_shoulder"]]) / 2 - p[0]))  # the pelvis's own frame
    forward = np.ptp(np.array(rel)[:, 2]) / 2
    assert 0.002 <= forward <= 0.003


def test_idle_blinks_every_three_to_five_seconds_for_150_ms():
    m = idle_loop(np.zeros(10), seconds=20.0, fps=30, blink_expr=np.eye(10)[9])
    amount = m.expr[:, 9]
    starts, lengths = _blinks(amount, 30)
    assert len(starts) >= 4
    gaps = np.diff(np.append(starts, starts[0] + 20.0))  # the wrap counts too
    assert gaps.min() >= 3.0 - 1 / 30 and gaps.max() <= 5.0 + 1 / 30
    assert (lengths <= 0.15 + 1 / 30).all()
    assert (amount == 1.0).sum() == len(starts)  # each blink has one frame fully shut
    assert amount[0] == 0 and amount[-1] == 0


def test_idle_eyes_make_small_saccades_together_and_wrap():
    m = idle_loop(np.zeros(10), seconds=20.0, fps=30)
    left, right = m.pose[:, J["left_eye"]], m.pose[:, J["right_eye"]]
    np.testing.assert_allclose(left, right)  # both eyes look at the same thing
    assert np.abs(left).max() <= 0.12  # a few degrees, not a stare to the side
    steps = np.linalg.norm(np.diff(left, axis=0), axis=1)
    jumps = steps > 1e-6
    assert 8 <= jumps.sum() <= 40  # a new fixation every 0.5-2.5 s
    assert steps[jumps].min() > 0.005  # each is a jump within a frame, not a drift
    np.testing.assert_allclose(left[0], left[-1])  # the last fixation is the first, so the loop wraps
    assert m.expr is None  # blinks only when the bundle can show them
