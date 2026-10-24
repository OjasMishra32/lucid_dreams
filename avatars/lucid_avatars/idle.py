"""A seamless idle loop so a family-photo person never stands frozen: breathing, weight shift, head sway.

Every movement is a sine whose period divides the loop length, so the last frame flows into the first.
Blinking uses motion.json's optional expr: pass the SMPL-X expression vector that closes this avatar's eyes.
"""

from __future__ import annotations

import math

import numpy as np

from .motion import Motion
from .rotations import aa_to_quat, quat_mul, yaw_quat
from .smplx_layout import NUM_JOINTS, J

BREATH_PERIOD_S = 4.0  # ~15 breaths a minute, relaxed
SHIFT_PERIOD_S = 8.0   # slow side-to-side weight shift
BLINK_EVERY_S = 4.0    # people blink every 2-10 s at rest
BLINK_S = 0.25         # close and reopen


def _relaxed_stance() -> np.ndarray:
    """Arms hanging at the sides with a soft elbow bend, feet slightly apart (SMPL-X rests in a T-pose)."""
    pose = np.zeros((NUM_JOINTS, 3))
    pose[J["left_shoulder"], 2] = -1.2
    pose[J["right_shoulder"], 2] = 1.2
    pose[J["left_elbow"], 1] = -0.2
    pose[J["right_elbow"], 1] = 0.2
    pose[J["left_hip"], 2] = 0.06
    pose[J["right_hip"], 2] = -0.06
    return pose


def _cycles(seconds: float, period_s: float) -> int:
    return max(1, round(seconds / period_s))


def _blink_curve(n: int, fps: int, seconds: float) -> np.ndarray:
    """0 (open) .. 1 (closed) per frame: a quick raised-cosine blink, unevenly spaced so it doesn't look mechanical,
    never on the first or last frame so the loop wraps with eyes open."""
    amount = np.zeros(n)
    blinks = max(1, round(seconds / BLINK_EVERY_S))
    length = max(3, round(BLINK_S * fps)) | 1  # odd, so one frame sits at fully closed
    for k in range(blinks):
        centre = round((k + 0.5 + 0.15 * (-1) ** k) / blinks * n)
        start = min(max(1, centre - length // 2), n - 1 - length)
        if start < 1:
            break
        amount[start:start + length] = 0.5 - 0.5 * np.cos(2 * math.pi * np.arange(length) / (length - 1))
    return amount


def idle_loop(betas: np.ndarray, seconds: float = 8.0, fps: int = 30, stand_y: float = 0.0,
              blink_expr: np.ndarray | None = None) -> Motion:
    """An idle motion of `seconds` length, facing -Z.

    stand_y is the SMPL-X transl y that puts this body's soles on y = 0 (depends on betas; compute it
    with the SMPL-X model). transl sways about a centimetre in x; the pelvis itself sits at J0 + transl.
    The loop is rounded to a whole number of frames so it wraps cleanly. blink_expr (10 floats) is the SMPL-X
    expression that closes the eyes; with it the loop blinks every few seconds through motion.json's expr.
    """
    n = max(1, round(seconds * fps))
    seconds = n / fps
    t = np.arange(n) / fps
    breath = np.sin(2 * math.pi * _cycles(seconds, BREATH_PERIOD_S) * t / seconds)
    shift_phase = 2 * math.pi * _cycles(seconds, SHIFT_PERIOD_S) * t / seconds
    shift = np.sin(shift_phase)
    sway = np.sin(shift_phase + 0.9)  # the head trails the hips a little

    pose = np.broadcast_to(_relaxed_stance(), (n, NUM_JOINTS, 3)).copy()
    # Breathing: the chest rises and the shoulders lift slightly.
    for name in ("spine1", "spine2", "spine3"):
        pose[:, J[name], 0] -= 0.012 * breath
    pose[:, J["left_collar"], 2] -= 0.015 * breath
    pose[:, J["right_collar"], 2] += 0.015 * breath
    pose[:, J["head"], 0] += 0.008 * breath
    # Weight shift: the pelvis rolls, the spine counters it, the unloaded knee softens.
    pose[:, J["spine1"], 2] -= 0.015 * shift
    pose[:, J["left_knee"], 0] += 0.02 * (1 + shift)
    pose[:, J["right_knee"], 0] += 0.02 * (1 - shift)
    pose[:, J["neck"], 1] += 0.02 * sway
    pose[:, J["head"], 1] += 0.02 * sway

    roll = aa_to_quat(np.stack([np.zeros(n), np.zeros(n), 0.02 * shift], axis=-1))
    root_q = quat_mul(np.broadcast_to(yaw_quat(math.pi), (n, 4)), roll)
    root_t = np.stack([0.012 * shift, np.full(n, stand_y), np.zeros(n)], axis=-1)
    expr = None
    if blink_expr is not None:
        expr = _blink_curve(n, fps, seconds)[:, None] * np.asarray(blink_expr, dtype=np.float64).reshape(1, 10)
    return Motion(fps=fps, betas=np.asarray(betas, dtype=np.float64), root_t=root_t, root_q=root_q, pose=pose,
                  expr=expr)
