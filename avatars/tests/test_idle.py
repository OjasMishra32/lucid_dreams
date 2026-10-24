import numpy as np
import pytest

from lucid_avatars.idle import idle_loop
from lucid_avatars.motion import validate_motion_dict
from lucid_avatars.rotations import quat_to_aa


def test_idle_loop_is_valid_motion():
    m = idle_loop(betas=np.zeros(10), seconds=8.0, fps=30)
    assert m.pose.shape == (240, 55, 3)
    assert validate_motion_dict(m.to_dict()) == []


def test_idle_loop_wraps_seamlessly():
    m = idle_loop(betas=np.zeros(10), seconds=8.0, fps=30)
    # The step from the last frame back to the first must be no bigger than an ordinary step.
    steps = np.abs(np.diff(m.pose, axis=0)).max(axis=(1, 2))
    wrap = np.abs(m.pose[0] - m.pose[-1]).max()
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
