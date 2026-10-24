"""Feet that don't skate: pin planted feet to the floor in a motion, with the legs solved by two-bone IK.

Contact labels: GVHMR predicts per-frame static labels (`static_conf` in its network outputs), but what 4DAnyone saves
for a run (MotionResult: smpl_params_global / smpl_params_incam / K_fullimg / fps) carries none, and gvhmr_motion.py
reads only smpl_params_global. So contact is detected from the motion itself (detect_contacts): the ankle AND the
foot (toe) joint both within a few cm of their floor, and both slower than a threshold horizontally, for at least 3
frames, with hysteresis (a segment starts on the tight thresholds and grows across frames still within the loose ones).
"Their floor" is the clip's own low percentile of that joint's height, so it works in any y-up frame, before or after
place_on_floor. Only flat-foot contact counts (a heel-up toe push-off is left alone).

lock_feet then pins each contact segment: the ankle held at the segment's mean position, the foot turned flat (yaw kept,
pitch and roll removed, so the sole lies on the floor), the leg solved with ik.elbow_position (knee toward where it was)
and applied as minimal swings of the original hip and knee rotations, so the pose stays the person's own and an
untouched frame is bit-identical. If a leg can't reach the held point the root moves just enough to bring the hip into
reach (a shift of millimetres); the held foot itself never moves, so it is never lifted or pushed through the floor,
and a held ankle is never set below the clip's own ankle or toe floor. The hold fades in and out over `blend` frames
(smoothstep), so there is no pop. The root's rotation, the spine and the arms are never touched.

Plain numpy. Positions are metres, motion.json conventions (motion.py, skinning.py).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np

from .ik import elbow_position, to_aa, world_joints
from .motion import Motion
from .rotations import matrix_to_quat, quat_to_matrix
from .smplx_layout import J

SIDES = ("left", "right")


@dataclass(frozen=True)
class FootLockParams:
    enter_height: float = 0.04  # m above the joint's floor to start a contact
    exit_height: float = 0.07   # m above it to still count as in contact
    enter_speed: float = 0.35   # m/s horizontal, to start
    exit_speed: float = 0.60    # m/s horizontal, to stay
    min_frames: int = 3         # a contact needs this many consecutive frames on the tight thresholds
    blend: int = 4              # frames to fade the hold in before and out after a segment
    floor_percentile: float = 2.0
    ramp_root_shift: float = 0.01  # m: fading the hold in or out never asks the root to move more than this (the
    #                                hold itself, at full weight, moves it as far as reach demands)


def _floor(heights: np.ndarray, p: FootLockParams) -> float:
    return float(np.percentile(heights, p.floor_percentile))


def detect_contacts(ankle, toe, fps: float, ankle_floor: float, toe_floor: float,
                    params: FootLockParams | None = None) -> list[tuple[int, int]]:
    """Contact segments (first, last frame, inclusive) of one foot from its ankle and toe joint tracks (N, 3)."""
    p = params or FootLockParams()
    ankle, toe = np.asarray(ankle, dtype=np.float64), np.asarray(toe, dtype=np.float64)
    n = len(ankle)
    if n < p.min_frames:
        return []
    speed = np.zeros(n)
    for track in (ankle, toe):
        v = np.linalg.norm(np.gradient(track[:, [0, 2]], axis=0), axis=1) * fps
        speed = np.maximum(speed, v)
    ha, ht = ankle[:, 1] - ankle_floor, toe[:, 1] - toe_floor
    enter = (ha <= p.enter_height) & (ht <= p.enter_height) & (speed < p.enter_speed)
    stay = (ha <= p.exit_height) & (ht <= p.exit_height) & (speed < p.exit_speed)
    segments, i = [], 0
    while i < n:
        if not stay[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and stay[j + 1]:
            j += 1
        run = longest = 0  # the loose run counts only if it holds min_frames tight frames in a row
        for k in range(i, j + 1):
            run = run + 1 if enter[k] else 0
            longest = max(longest, run)
        if longest >= p.min_frames:
            segments.append((i, j))
        i = j + 1
    return segments


def _smooth(x: np.ndarray) -> np.ndarray:
    return x * x * (3 - 2 * x)


def _weights(n: int, segments, blend: int) -> tuple[np.ndarray, np.ndarray]:
    """Hold weight per frame (1 inside a segment, a smoothstep ramp over `blend` frames outside) and the index of the
    segment each frame follows (-1 for none)."""
    w, seg = np.zeros(n), np.full(n, -1)
    for k, (s, e) in enumerate(segments):
        for f in range(max(0, s - blend), min(n, e + blend + 1)):
            d = max(s - f, f - e, 0)
            v = 1.0 if d == 0 else float(_smooth(1 - d / (blend + 1)))
            if v > w[f]:
                w[f], seg[f] = v, k
    return w, seg


def _swing(a, b) -> np.ndarray:
    """The shortest rotation taking direction a to direction b."""
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    v, c = np.cross(a, b), float(np.dot(a, b))
    if c < -1 + 1e-9:  # opposite: any half turn about a perpendicular axis
        axis = np.cross(a, [1.0, 0, 0] if abs(a[0]) < 0.9 else [0, 1.0, 0])
        axis /= np.linalg.norm(axis)
        return 2 * np.outer(axis, axis) - np.eye(3)
    K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + K + K @ K / (1 + c)


def _slerp(R0, R1, w: float) -> np.ndarray:
    q0, q1 = matrix_to_quat(R0), matrix_to_quat(R1)
    if np.dot(q0, q1) < 0:
        q1 = -q1
    dot = float(np.clip(np.dot(q0, q1), -1, 1))
    th = math.acos(dot)
    if th < 1e-8:
        q = q0
    else:
        q = (math.sin((1 - w) * th) * q0 + math.sin(w * th) * q1) / math.sin(th)
    return quat_to_matrix(q / np.linalg.norm(q))


def _yaw(angle: float) -> np.ndarray:
    c, s = math.cos(angle), math.sin(angle)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def _track(m: Motion, rest) -> tuple[np.ndarray, np.ndarray]:
    pos, rot = [], []
    for f in range(m.num_frames):
        p, r = world_joints(rest, m.root_q[f], m.root_t[f], m.pose[f])
        pos.append(p)
        rot.append(r)
    return np.array(pos), np.array(rot)


def _extent_mm(points: np.ndarray) -> float:
    """Largest horizontal distance between any two of the (N, 3) points, in mm."""
    xz = np.asarray(points)[:, [0, 2]]
    if len(xz) < 2:
        return 0.0
    d = np.linalg.norm(xz[:, None] - xz[None], axis=-1)
    return float(d.max() * 1000)


def _slide_mm(pos, side: str, segments) -> float:
    worst = 0.0
    for s, e in segments:
        for name in ("ankle", "foot"):
            worst = max(worst, _extent_mm(pos[s:e + 1, J[f"{side}_{name}"]]))
    return worst


def _empty_report(n: int) -> dict:
    rep = {s: {"contactFrames": 0, "segments": [], "slideMm": {"before": 0.0, "after": 0.0}} for s in SIDES}
    rep["footSlideMm"] = {"before": 0.0, "after": 0.0}
    rep["rootShiftMaxMm"] = 0.0
    rep["frames"] = n
    return rep


def lock_feet(m: Motion, rest, params: FootLockParams | None = None) -> tuple[Motion, dict]:
    """m with every planted foot pinned (see the module doc), and a report: per foot `contactFrames`, `segments`,
    `slideMm` {before, after} (largest horizontal travel of the ankle or foot joint inside one contact), overall
    `footSlideMm` {before, after}, and `rootShiftMaxMm`. The input is not modified."""
    p = params or FootLockParams()
    rest = np.asarray(rest, dtype=np.float64)
    n = m.num_frames
    report = _empty_report(n)
    if n < p.min_frames:
        return m, report
    pos, rot = _track(m, rest)
    ankle_floor = _floor(np.concatenate([pos[:, J[f"{s}_ankle"], 1] for s in SIDES]), p)
    toe_floor = _floor(np.concatenate([pos[:, J[f"{s}_foot"], 1] for s in SIDES]), p)

    plans = {}
    for side in SIDES:
        a, t = pos[:, J[f"{side}_ankle"]], pos[:, J[f"{side}_foot"]]
        segs = detect_contacts(a, t, m.fps, ankle_floor, toe_floor, p)
        report[side]["segments"] = [[int(s), int(e)] for s, e in segs]
        report[side]["contactFrames"] = int(sum(e - s + 1 for s, e in segs))
        report[side]["slideMm"]["before"] = round(_slide_mm(pos, side, segs), 3)
        plans[side] = segs
    report["footSlideMm"]["before"] = round(max(report[s]["slideMm"]["before"] for s in SIDES), 3)
    if not any(plans.values()):
        return m, report

    toe_vec = {s: rest[J[f"{s}_foot"]] - rest[J[f"{s}_ankle"]] for s in SIDES}
    held, weight = {}, {}
    for side in SIDES:
        w, seg = _weights(n, plans[side], p.blend)
        target = np.zeros((n, 3))
        flat = [None] * n
        for k, (s, e) in enumerate(plans[side]):
            P = pos[s:e + 1, J[f"{side}_ankle"]].mean(axis=0)
            P[1] = max(P[1], ankle_floor, toe_floor - toe_vec[side][1])  # never into the floor
            heading = np.zeros(2)
            for f in range(s, e + 1):
                d = rot[f, J[f"{side}_ankle"]] @ toe_vec[side]
                h = np.array([d[0], d[2]])
                heading += h / (np.linalg.norm(h) + 1e-12)
            rest_h = np.array([toe_vec[side][0], toe_vec[side][2]])
            Rflat = _yaw(math.atan2(heading[0], heading[1]) - math.atan2(rest_h[0], rest_h[1]))
            for f in np.flatnonzero(seg == k):
                target[f], flat[f] = P, Rflat
        held[side], weight[side] = (target, flat), w

    pose, root_t = m.pose.copy(), m.root_t.copy()
    bones = {s: (np.linalg.norm(rest[J[f"{s}_knee"]] - rest[J[f"{s}_hip"]]),
                 np.linalg.norm(rest[J[f"{s}_ankle"]] - rest[J[f"{s}_knee"]])) for s in SIDES}
    for f in range(n):
        active = [s for s in SIDES if weight[s][f] > 0]
        if not active:
            continue
        def solve_shift(ws):
            goal = {s: (1 - ws[s]) * pos[f, J[f"{s}_ankle"]] + ws[s] * held[s][0][f] for s in active}
            shift = np.zeros(3)
            for _ in range(40):  # alternating projections: move the root only as far as a leg's reach demands
                moved = False
                for s in active:
                    v = goal[s] - (pos[f, J[f"{s}_hip"]] + shift)
                    dist, reach = np.linalg.norm(v), bones[s][0] + bones[s][1] - 2e-5
                    if dist > reach:
                        shift += v * (1 - reach / dist)
                        moved = True
                if not moved:
                    break
            return goal, shift

        ws = {s: weight[s][f] for s in active}
        goal, shift = solve_shift(ws)
        ramping = [s for s in active if ws[s] < 1]
        if ramping and np.linalg.norm(shift) > p.ramp_root_shift:  # fade less rather than drag the root about
            full = dict(ws)
            lo, hi = 0.0, 1.0
            for _ in range(14):
                c = (lo + hi) / 2
                trial = {s: (full[s] * c if s in ramping else full[s]) for s in active}
                if np.linalg.norm(solve_shift(trial)[1]) <= p.ramp_root_shift:
                    lo = c
                else:
                    hi = c
            ws = {s: (full[s] * lo if s in ramping else full[s]) for s in active}
            goal, shift = solve_shift(ws)
        root_t[f] = m.root_t[f] + shift
        for s in active:
            L1, L2 = bones[s]
            hip, knee, ank = (J[f"{s}_{n_}"] for n_ in ("hip", "knee", "ankle"))  # noqa: E741
            H = pos[f, hip] + shift
            K = elbow_position(H, goal[s], L1, L2, pos[f, knee] - pos[f, hip])
            R_hip, R_knee = rot[f, hip], rot[f, knee]
            sw1 = _swing(R_hip @ (rest[knee] - rest[hip]), K - H)
            R_hip_new, R_knee_cur = sw1 @ R_hip, sw1 @ R_knee
            sw2 = _swing(R_knee_cur @ (rest[ank] - rest[knee]), goal[s] - K)
            R_knee_new = sw2 @ R_knee_cur
            R_foot = _slerp(rot[f, ank], held[s][1][f], ws[s])
            pose[f, hip] = to_aa(rot[f, J["pelvis"]].T @ R_hip_new)
            pose[f, knee] = to_aa(R_hip_new.T @ R_knee_new)
            pose[f, ank] = to_aa(R_knee_new.T @ R_foot)
    out = replace(m, root_t=root_t, pose=pose)
    after, _ = _track(out, rest)
    for side in SIDES:
        report[side]["slideMm"]["after"] = round(_slide_mm(after, side, plans[side]), 3)
    report["footSlideMm"]["after"] = round(max(report[s]["slideMm"]["after"] for s in SIDES), 3)
    report["rootShiftMaxMm"] = round(float(np.linalg.norm(root_t - m.root_t, axis=1).max() * 1000), 3)
    return out, report


def add_slide_metrics(bundle_dir, report: dict) -> dict:
    """Put `footSlideMm` {before, after} into dream.json's metrics (other keys kept) and write the whole report next
    to the motion as avatar/foot_lock.json. Returns the metrics dict."""
    root = Path(bundle_dir)
    dream = json.loads((root / "dream.json").read_text())
    dream["metrics"] = {**(dream.get("metrics") or {}), "footSlideMm": dict(report["footSlideMm"])}
    (root / "dream.json").write_text(json.dumps(dream, indent=2) + "\n")
    (root / "avatar").mkdir(exist_ok=True)
    (root / "avatar" / "foot_lock.json").write_text(json.dumps(report, indent=1) + "\n")
    return dream["metrics"]


def format_report(report: dict) -> str:
    """Log lines: contact frames and max slide before -> after, per foot."""
    lines = []
    for side in SIDES:
        r = report[side]
        lines.append(f"[foot-lock] {side} foot: {r['contactFrames']} contact frames in {len(r['segments'])} segments, "
                     f"max slide {r['slideMm']['before']:.1f} mm -> {r['slideMm']['after']:.1f} mm")
    lines.append(f"[foot-lock] worst slide {report['footSlideMm']['before']:.1f} mm -> "
                 f"{report['footSlideMm']['after']:.1f} mm, root moved at most {report['rootShiftMaxMm']:.1f} mm")
    return "\n".join(lines)
