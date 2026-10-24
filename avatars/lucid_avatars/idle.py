"""Seamless idle loops so a person never stands frozen: standing (breathing, weight shift, head sway) and seated at a
chess board (breathing, forearms on the table, looking down at the board).

Every movement is a sine whose period divides the loop length, so the last frame flows into the first.
Blinking uses motion.json's optional expr: pass the SMPL-X expression vector that closes this avatar's eyes.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .ik import arm_lengths, lean, look_at, lowest_elbow_y, solve_arm, to_aa, world_joints
from .motion import Motion
from .rotations import aa_to_quat, quat_mul, quat_to_matrix, yaw_quat
from .smplx_layout import NUM_JOINTS, J

BREATH_PERIOD_S = 4.0  # ~15 breaths a minute, relaxed
SHIFT_PERIOD_S = 8.0   # slow side-to-side weight shift
BLINK_EVERY_S = 4.0    # people blink every 2-10 s at rest
BLINK_S = 0.25         # close and reopen

# Seated at the chess board. Heights are from the floor, in the person's own frame from AGENTS.md (hips over
# x = z = 0, facing -Z), so the board centre is BOARD_Z in front of the hips: a player puts this origin BOARD_Z
# behind the board centre on the opponent's side, turned to face the board.
SEAT_Y = 0.45
TABLE_Y = 0.75
BOARD_Z = 0.72           # hips to board centre: forearms rest on the table short of the board
BOARD_HALF = 0.218       # 8 x 5 cm squares plus the frame, from pieces.ts
HIP_ABOVE_SEAT = 0.10    # SMPL-X hip joints sit about 10 cm above the seat (approximate; buttock tissue under them)
ANKLE_ABOVE_FLOOR = 0.08 # SMPL-X ankle joints are about 8 cm above the soles
ELBOW_ON_TABLE = 0.045   # elbow joint above the table top when the forearm rests on it
WRIST_ON_TABLE = 0.03
HANDS_APART = 0.12       # each wrist this far from the middle
HANDS_FROM_BOARD = 0.03  # fingertips rest this far short of the board's frame
KNEES_APART = 0.12       # radians each thigh turns out
MIN_SEAT_Y = 0.36        # how far the seat may come down for short arms
MAX_LEAN = 0.5           # radians: leaning in over the board, not hunched on it
MAX_THIGH_SLOPE = 0.3    # radians the thighs may slope down to put the feet on the floor; shorter legs dangle
PELVIS_LEAN = 0.4        # share of the forward lean that tilts the pelvis (the rest bends the spine)
RESTING_ELBOW_OUT = 0.15 # elbows on the table point only slightly out


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


def _curl_fingers(pose: np.ndarray, amount: float) -> None:
    """Bend every finger (not the thumb) toward the palm; 1 is a loose fist's worth, 0.3 a relaxed hand."""
    for side, sign in (("left", -1.0), ("right", 1.0)):
        for finger in ("index", "middle", "ring", "pinky"):
            for i, bend in enumerate((0.35, 0.55, 0.35), start=1):
                pose[J[f"{side}_{finger}{i}"]] = [0.0, 0.0, sign * amount * bend]


def body_point(root_q: np.ndarray, x: float, y: float, forward: float) -> np.ndarray:
    """A point in the seated person's frame (x to their left, y up from the floor, forward from the hips) in world."""
    return quat_to_matrix(root_q) @ np.array([x, 0.0, forward]) + np.array([0.0, y, 0.0])


@dataclass
class Seated:
    """Someone sitting at the board, before breathing (seated_rest_pose)."""
    root_q: np.ndarray
    root_t: np.ndarray
    pose: np.ndarray
    wrists: dict[str, np.ndarray]  # "left"/"right" -> where that wrist rests on the table
    seat_y: float                  # the seat height actually used
    lean: float                    # radians of forward lean (pelvis and spine together)


def _legs(rest, root_q, root_t, pose) -> None:
    """Thighs on the seat, feet flat on the floor: long legs angle the shanks forward, shorter ones slope the thighs
    down a little to the knees, and short ones (a child's) dangle rather than slope steeply."""
    for side, out in (("left", KNEES_APART), ("right", -KNEES_APART)):
        hip, knee, ankle = J[f"{side}_hip"], J[f"{side}_knee"], J[f"{side}_ankle"]

        def ankle_y(flex: float, bend: float, hip=hip, knee=knee, ankle=ankle, out=out) -> float:
            pose[hip] = to_aa(quat_to_matrix(quat_mul(yaw_quat(out), aa_to_quat([-flex, 0, 0]))))
            pose[knee] = [bend, 0, 0]
            return world_joints(rest, root_q, root_t, pose)[0][ankle, 1]

        if ankle_y(math.pi / 2, math.pi / 2) < ANKLE_ABOVE_FLOOR:
            lo, hi = 0.0, math.pi / 2
            for _ in range(30):
                mid = (lo + hi) / 2
                lo, hi = (mid, hi) if ankle_y(math.pi / 2, mid) > ANKLE_ABOVE_FLOOR else (lo, mid)
            flex, bend = math.pi / 2, (lo + hi) / 2
        else:
            lo, hi = math.pi / 2 - MAX_THIGH_SLOPE, math.pi / 2
            for _ in range(30):
                mid = (lo + hi) / 2
                lo, hi = (lo, mid) if ankle_y(mid, mid) > ANKLE_ABOVE_FLOOR else (mid, hi)
            flex = bend = lo
        ankle_y(flex, bend)
        pose[ankle] = [flex - bend, 0, 0]  # soles back to flat


def seated_rest_pose(rest, seat_y: float = SEAT_Y, table_y: float = TABLE_Y, board_z: float = BOARD_Z) -> Seated:
    """Someone sitting at the board: hips on the seat over x = z = 0, facing -Z, feet on the floor, leaning in just
    enough to rest both forearms on the table (elbows on it, hands short of the board), looking at the board's centre.

    If this body's arms can't reach the table from seat_y without leaning past MAX_LEAN, the seat comes down (to
    MIN_SEAT_Y at most): nobody sees the chair in passthrough, everybody sees forearms floating over the table.
    """
    rest = np.asarray(rest, dtype=np.float64)
    facing = yaw_quat(math.pi)  # SMPL-X rest faces +Z; the person faces -Z
    hips = (rest[J["left_hip"]] + rest[J["right_hip"]]) / 2
    hand = max(np.linalg.norm(rest[J[f"{s}_middle3"]] - rest[J[f"{s}_wrist"]]) for s in ("left", "right")) + 0.02
    forward = board_z - BOARD_HALF - HANDS_FROM_BOARD - hand  # fingertips, not wrists, stop short of the board
    wrists = {side: body_point(facing, x, table_y + WRIST_ON_TABLE, forward)
              for side, x in (("left", HANDS_APART), ("right", -HANDS_APART))}
    elbow_y = table_y + ELBOW_ON_TABLE

    def sit(seat: float):
        def placed(root_q: np.ndarray) -> np.ndarray:  # root_t that keeps the hips on the seat
            return np.array([0.0, seat + HIP_ABOVE_SEAT, 0.0]) - quat_to_matrix(root_q) @ (hips - rest[0]) - rest[0]

        legs = np.zeros((NUM_JOINTS, 3))
        _legs(rest, facing, placed(facing), legs)
        thighs = {s: quat_to_matrix(aa_to_quat(legs[J[f"{s}_hip"]])) for s in ("left", "right")}

        def leaned(angle: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
            """Lean forward by angle: the pelvis tilts its share, the thighs stay where they are on the seat."""
            tilt = aa_to_quat([PELVIS_LEAN * angle, 0, 0])
            q = quat_mul(facing, tilt)
            p = lean(legs, (1 - PELVIS_LEAN) * angle)
            for s, R in thighs.items():
                p[J[f"{s}_hip"]] = to_aa(quat_to_matrix(tilt).T @ R)
            return q, placed(q), p

        return leaned

    def elbows_reach(leaned, angle: float, slack: float = 0.01) -> bool:
        pos = world_joints(rest, *leaned(angle))[0]
        return all(lowest_elbow_y(pos[J[f"{s}_shoulder"]], wrists[s], *arm_lengths(rest, s)) <= elbow_y - slack
                   for s in wrists)

    # The highest seat (from seat_y down) and then the least lean that let both elbows down onto the table. Leaning
    # too far folds the arms up again, so scan up from upright, then refine.
    grid = np.linspace(0.0, MAX_LEAN, 11)
    for seat in np.arange(seat_y, min(seat_y, MIN_SEAT_Y) - 1e-9, -0.01):  # always tries seat_y itself
        leaned = sit(float(seat))
        first = next((i for i, a in enumerate(grid) if elbows_reach(leaned, a)), None)
        if first is not None:
            break
    if first is None:  # even the lowest seat and the full lean don't do it: lean in all the way, elbows hover
        lo = hi = MAX_LEAN
    else:
        lo, hi = (grid[first - 1], grid[first]) if first > 0 else (0.0, 0.0)
    for _ in range(12 if first else 0):
        mid = (lo + hi) / 2
        lo, hi = (lo, mid) if elbows_reach(leaned, mid) else (mid, hi)
    root_q, root_t, pose = leaned(hi)
    for side, w in wrists.items():
        pose = solve_arm(rest, root_q, root_t, pose, side, w, elbow_min_y=elbow_y, elbow_out=RESTING_ELBOW_OUT)
    pose = look_at(rest, root_q, root_t, pose, body_point(facing, 0.0, table_y, board_z))
    _curl_fingers(pose, 0.3)
    return Seated(root_q, root_t, pose, wrists, float(seat), float(hi))


def seated_idle(rest, betas: np.ndarray, seconds: float = 8.0, fps: int = 30, seat_y: float = SEAT_Y,
                table_y: float = TABLE_Y, board_z: float = BOARD_Z, blink_expr: np.ndarray | None = None) -> Motion:
    """The chess opponent's idle: seated (seated_rest_pose; the seat may come down for short arms), breathing, head
    swaying a little, blinking with blink_expr; the forearms stay on the table and the hands stay put while the chest
    moves.

    rest is the avatar's skeleton.json rest joints. The board centre is (0, table_y, -board_z) in this motion's frame.
    """
    rest = np.asarray(rest, dtype=np.float64)
    seated = seated_rest_pose(rest, seat_y, table_y, board_z)
    root_q, root_t, base, wrists = seated.root_q, seated.root_t, seated.pose, seated.wrists
    n = max(1, round(seconds * fps))
    seconds = n / fps
    t = np.arange(n) / fps
    breath = np.sin(2 * math.pi * _cycles(seconds, BREATH_PERIOD_S) * t / seconds)
    sway = np.sin(2 * math.pi * _cycles(seconds, SHIFT_PERIOD_S) * t / seconds + 0.9)

    pose = np.empty((n, NUM_JOINTS, 3))
    for f in range(n):
        p = base.copy()
        for name in ("spine1", "spine2", "spine3"):
            p[J[name], 0] -= 0.012 * breath[f]
        p[J["left_collar"], 2] -= 0.015 * breath[f]
        p[J["right_collar"], 2] += 0.015 * breath[f]
        p[J["head"], 0] += 0.008 * breath[f]
        p[J["neck"], 1] += 0.015 * sway[f]
        p[J["head"], 1] += 0.015 * sway[f]
        for side, w in wrists.items():
            p = solve_arm(rest, root_q, root_t, p, side, w, elbow_min_y=table_y + ELBOW_ON_TABLE,
                          elbow_out=RESTING_ELBOW_OUT)
        pose[f] = p
    expr = None
    if blink_expr is not None:
        expr = _blink_curve(n, fps, seconds)[:, None] * np.asarray(blink_expr, dtype=np.float64).reshape(1, 10)
    return Motion(fps=fps, betas=np.asarray(betas, dtype=np.float64), root_t=np.tile(root_t, (n, 1)),
                  root_q=np.tile(root_q, (n, 1)), pose=pose, expr=expr)
