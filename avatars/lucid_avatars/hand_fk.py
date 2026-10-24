"""Hand forward kinematics on an SMPL-X rest skeleton, and the hand conventions both hand modules share.

A hand pose is (15, 3) absolute axis-angle in SMPL-X's hand joint order: index1-3, middle1-3, pinky1-3, ring1-3,
thumb1-3 (MANO's order too), each rotation in its parent's frame as motion.json stores it. Poses are written for the
RIGHT hand (finger flexion is +z); the left hand is the x-mirror: `mirror_hand` negates the y and z components.
"""

from __future__ import annotations

import numpy as np

from .rotations import aa_to_quat, quat_to_matrix
from .smplx_layout import J, JOINT_NAMES

FINGERS = ("index", "middle", "pinky", "ring", "thumb")
HAND_JOINTS = [f"{f}{i}" for f in FINGERS for i in (1, 2, 3)]  # 15 names, no side
FINGER_SLICE = {f: slice(3 * k, 3 * k + 3) for k, f in enumerate(FINGERS)}
TIP_OFFSET_M = 0.02  # the fingertip lies this far past the third joint, along its bone

assert JOINT_NAMES[25:40] == [f"left_{n}" for n in HAND_JOINTS]
assert JOINT_NAMES[40:55] == [f"right_{n}" for n in HAND_JOINTS]


def mirror_hand(pose: np.ndarray) -> np.ndarray:
    """The other hand's pose: reflecting across x flips an axis-angle vector's y and z components."""
    out = np.array(pose, dtype=np.float64)
    out[..., 1:] *= -1.0
    return out


def hand_rest(rest: np.ndarray, side: str) -> np.ndarray:
    """(15, 3) rest positions of one hand's finger joints, from a (55, 3) skeleton."""
    return np.asarray(rest, dtype=np.float64)[[J[f"{side}_{n}"] for n in HAND_JOINTS]]


def hand_chain(rest: np.ndarray, side: str, pose: np.ndarray, tip_offset: float = TIP_OFFSET_M) -> dict[str, np.ndarray]:
    """Posed finger joints for one hand with the wrist at its rest rotation.

    `pose` is (15, 3) in the convention of the `side` hand (a right-hand pose for "right", a left one for "left").
    Returns {finger: (4, 3)}: the three joints then the fingertip, in the skeleton's frame.
    """
    pts = hand_rest(rest, side)
    R = quat_to_matrix(aa_to_quat(np.asarray(pose, dtype=np.float64).reshape(15, 3)))
    out = {}
    for f, sl in FINGER_SLICE.items():
        r_rest = pts[sl]
        rot = np.eye(3)
        joints = []
        p = r_rest[0]
        for k in range(3):
            rot = rot @ R[sl.start + k]
            joints.append(p)
            if k < 2:
                p = p + rot @ (r_rest[k + 1] - r_rest[k])
        bone = r_rest[2] - r_rest[1]
        tip = joints[2] + rot @ (bone / np.linalg.norm(bone) * tip_offset)
        out[f] = np.array([*joints, tip])
    return out


def fingertips(rest: np.ndarray, side: str, pose: np.ndarray, tip_offset: float = TIP_OFFSET_M) -> dict[str, np.ndarray]:
    return {f: c[3] for f, c in hand_chain(rest, side, pose, tip_offset).items()}


def pinch_gap(rest: np.ndarray, side: str, pose: np.ndarray, tip_offset: float = TIP_OFFSET_M) -> float:
    """Metres between the thumb tip and the index tip."""
    tips = fingertips(rest, side, pose, tip_offset)
    return float(np.linalg.norm(tips["thumb"] - tips["index"]))
