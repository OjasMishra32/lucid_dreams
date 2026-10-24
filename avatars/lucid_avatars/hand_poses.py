"""Named SMPL-X hand poses (relaxed, pinch, fist, point), blending, joint limits, and the JSON the chess builder reads.

Poses are absolute axis-angle per finger joint, (15, 3) in SMPL-X's hand joint order (index1-3, middle1-3, pinky1-3,
ring1-3, thumb1-3), exactly what motion.json's `pose[40:55]` (right hand) and `pose[25:40]` (left hand) hold: no hand
mean, no PCA. They are designed for the right hand (finger flexion is +z); the left hand is the x-mirror, which
negates the y and z components (`hand_fk.mirror_hand`). The finger flexion numbers are what `idle._curl_fingers` and
the chess person's finger curl already use; the thumbs were solved by forward kinematics (`hand_fk`) on
`tests/smplx_rest.py`'s rest skeleton (bounded least squares, thumb tip on index tip within 0.1 mm there).

`python -m lucid_avatars.hand_poses [out.json]` writes avatars/hand_poses.json; a test keeps the file in step.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from .hand_fk import FINGER_SLICE, HAND_JOINTS, TIP_OFFSET_M, mirror_hand
from .rotations import aa_to_quat, quat_to_aa

JSON_FILE = Path(__file__).resolve().parents[1] / "hand_poses.json"


def _hand(index, middle, ring, pinky, thumb) -> np.ndarray:
    """A right-hand pose from three flexions (radians, +z) per finger and the thumb's 9 axis-angle numbers."""
    p = np.zeros((15, 3))
    for name, flex in (("index", index), ("middle", middle), ("ring", ring), ("pinky", pinky)):
        for k, v in enumerate(flex):
            p[FINGER_SLICE[name].start + k, 2] = v
    p[FINGER_SLICE["thumb"]] = np.asarray(thumb, dtype=np.float64).reshape(3, 3)
    return p


_PINCH_THUMB = [0.416, -0.478, 0.430, 0.098, 0.041, 0.163, 0.012, 0.005, 0.020]
_FIST_THUMB = [0.298, -0.948, 0.138, 0.079, 0.122, 0.133, 0.001, 0.001, 0.001]

# Right-hand poses. pinch: thumb tip on index tip, middle / ring / pinky curled into the palm. point: index straight,
# the rest as in the fist.
RIGHT_POSES: dict[str, np.ndarray] = {
    "relaxed": _hand((0.15, 0.25, 0.12), (0.20, 0.30, 0.15), (0.25, 0.35, 0.18), (0.30, 0.40, 0.20),
                     0.3 * np.asarray(_PINCH_THUMB)),
    "pinch": _hand((0.887, 1.030, 0.502), (1.0, 1.25, 0.75), (1.1, 1.3, 0.8), (1.15, 1.35, 0.8), _PINCH_THUMB),
    "fist": _hand((1.4, 1.7, 1.1), (1.45, 1.75, 1.1), (1.45, 1.75, 1.1), (1.4, 1.75, 1.1), _FIST_THUMB),
    "point": _hand((0.04, 0.04, 0.02), (1.45, 1.75, 1.1), (1.45, 1.75, 1.1), (1.4, 1.75, 1.1), _FIST_THUMB),
}
POSE_NAMES = tuple(RIGHT_POSES)


def pose(name: str, side: str = "right") -> np.ndarray:
    """A named hand pose, (15, 3), for "right" or "left" (the mirror)."""
    if side not in ("left", "right"):
        raise ValueError(f"side must be 'left' or 'right', got {side!r}")
    p = RIGHT_POSES[name].copy()
    return p if side == "right" else mirror_hand(p)


def _slerp(qa: np.ndarray, qb: np.ndarray, t: np.ndarray) -> np.ndarray:
    dot = np.sum(qa * qb, axis=-1, keepdims=True)
    qb = np.where(dot < 0, -qb, qb)  # the short way round
    dot = np.abs(dot)
    theta = np.arccos(np.clip(dot, -1.0, 1.0))
    s = np.sin(theta)
    near = s < 1e-6
    wa = np.where(near, 1.0 - t, np.sin((1.0 - t) * theta) / np.where(near, 1.0, s))
    wb = np.where(near, t, np.sin(t * theta) / np.where(near, 1.0, s))
    q = wa * qa + wb * qb
    return q / np.linalg.norm(q, axis=-1, keepdims=True)


def blend(a: np.ndarray, b: np.ndarray, t) -> np.ndarray:
    """Per-joint spherical interpolation from hand pose a (t = 0) to b (t = 1). Shapes (..., 15, 3); t is a number or
    broadcasts against the leading dimensions (e.g. (N,) for N frames)."""
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    t = np.asarray(t, dtype=np.float64)
    t = t[..., None, None] if t.ndim else t  # (N,) -> (N, 1, 1) against (N, 15, 1)
    return quat_to_aa(_slerp(aa_to_quat(a), aa_to_quat(b), t))


# Plausible joint ranges for the RIGHT hand (the left is mirrored first). Fingers: per axis, radians:
# (twist x, spread y, flexion z). Thumb joints (axes differ from the fingers'): total rotation angle only.
_FINGER_LIMITS = {
    1: ((-0.4, 0.4), (-0.5, 0.5), (-0.6, 1.7)),   # knuckle: flexes a little back, spreads
    2: ((-0.3, 0.3), (-0.15, 0.15), (-0.1, 2.0)),  # middle joint: hinge
    3: ((-0.3, 0.3), (-0.15, 0.15), (-0.3, 1.5)),  # fingertip joint: hinge
}
_THUMB_MAX_ANGLE = {1: 1.2, 2: 1.0, 3: 1.4}


def _limit_arrays() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    lo, hi, tmax = np.zeros((15, 3)), np.zeros((15, 3)), np.full(15, np.inf)
    for name, sl in FINGER_SLICE.items():
        for k in range(3):
            j = sl.start + k
            if name == "thumb":
                tmax[j] = _THUMB_MAX_ANGLE[k + 1]
                lo[j], hi[j] = -np.inf, np.inf
            else:
                lo[j], hi[j] = zip(*_FINGER_LIMITS[k + 1])
    return lo, hi, tmax


_LO, _HI, _TMAX = _limit_arrays()


def clamp_to_limits(hand: np.ndarray, side: str = "right") -> tuple[np.ndarray, float]:
    """The hand pose pulled inside the plausible joint ranges, and the share of its 15 joints that had to move
    (shape (..., 15, 3) in, (..., 15, 3) and (...,) out). A regressor's wild finger is cut, a natural one untouched."""
    h = np.array(hand, dtype=np.float64)
    if side == "left":
        h = mirror_hand(h)
    out = np.clip(h, _LO, _HI)
    ang = np.linalg.norm(out, axis=-1)
    scale = np.where(ang > _TMAX, _TMAX / np.maximum(ang, 1e-12), 1.0)
    out = out * scale[..., None]
    moved = np.any(np.abs(out - h) > 1e-9, axis=-1)
    if side == "left":
        out = mirror_hand(out)
    return out, moved.mean(axis=-1)


def limit_violations(hand: np.ndarray, side: str = "right", tol: float = 1e-9) -> list[str]:
    """Joint indices (as readable strings) outside the plausible ranges; empty when the pose is plausible."""
    clamped, _ = clamp_to_limits(hand, side)
    bad = np.flatnonzero(np.any(np.abs(clamped - np.asarray(hand)) > tol, axis=-1))
    return [HAND_JOINTS[i] for i in bad]


def to_json_dict() -> dict:
    """What hand_poses.json holds: for each pose and side, the 15 axis-angle rotations and the same as [x, y, z, w]
    quaternions, in SMPL-X hand order, ready to drop into motion.json's pose or three.js quaternions."""
    r = lambda a: np.round(np.asarray(a, dtype=np.float64), 6).tolist()
    poses = {}
    for name in POSE_NAMES:
        poses[name] = {side: {"axisAngle": r(pose(name, side)), "quat": r(aa_to_quat(pose(name, side)))}
                       for side in ("left", "right")}
    return {
        "about": "Absolute SMPL-X hand joint rotations (no hand mean, no PCA), the contract of motion.json's pose. "
                 "Left hand: pose[25 + i] = poses[name].left.axisAngle[i]; right hand: pose[40 + i] = "
                 "poses[name].right.axisAngle[i]. Blend two poses per joint with quaternion slerp. The left hand is "
                 "the right one mirrored (negate the y and z axis-angle components). Pinch: thumb tip on index tip "
                 "(about 1 cm on SMPL-X proportions), middle, ring and pinky curled.",
        "joints": HAND_JOINTS,
        "fingertipOffsetM": TIP_OFFSET_M,
        "poses": poses,
    }


def main(argv: list[str]) -> int:
    out = Path(argv[1]) if len(argv) > 1 else JSON_FILE
    out.write_text(json.dumps(to_json_dict(), indent=1) + "\n")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
