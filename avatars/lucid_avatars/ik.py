"""Closed-form arm IK and head aim on the SMPL-X skeleton, for the seated chess opponent and its reach-and-place.

The arm is a two-bone chain (shoulder -> elbow -> wrist) with the bone lengths of the avatar's rest skeleton. The elbow
sits on the circle of points that reach the wrist; it hangs toward a pole (down and a little out, like a relaxed arm)
unless that would put it below a floor height (a table top), where it rests on the table instead. Joint rotations are
built from frames, so the posed elbow and wrist land exactly on their targets: the upper arm turns about the elbow's
hinge, the forearm carries the palm's twist (pronation), and the wrist bends the hand toward hand_dir.
"""

from __future__ import annotations

import math

import numpy as np

from .rotations import matrix_to_quat, quat_to_aa, quat_to_matrix
from .skinning import skin_matrices
from .smplx_layout import J

_DOWN = np.array([0.0, -1.0, 0.0])
_REST_FORWARD = np.array([0.0, 0.0, 1.0])  # SMPL-X rest faces +Z
SPINE_SHARE = {"spine1": 0.4, "spine2": 0.3, "spine3": 0.3}


def world_joints(rest, root_q, root_t, pose) -> tuple[np.ndarray, np.ndarray]:
    """Posed joint positions (55, 3) and world rotations (55, 3, 3) for one motion.json frame."""
    rest = np.asarray(rest, dtype=np.float64)
    M = skin_matrices(rest, root_q, root_t, pose)
    R = M[:, :3, :3]
    return np.einsum("jab,jb->ja", R, rest) + M[:, :3, 3], R


def _unit(v) -> np.ndarray:
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


def frame(d, n) -> np.ndarray:
    """Rotation whose columns are d, n made orthogonal to d, and their cross product."""
    e1 = _unit(d)
    e2 = _unit(np.asarray(n, dtype=np.float64) - np.dot(n, e1) * e1)
    return np.stack([e1, e2, np.cross(e1, e2)], axis=1)


def to_aa(R) -> np.ndarray:
    return quat_to_aa(matrix_to_quat(R))


def elbow_position(S, W, L1: float, L2: float, pole, min_y: float = -math.inf) -> np.ndarray:
    """Where the elbow goes for shoulder S and wrist W: toward the pole, but never below min_y if it can help it.

    A wrist out of reach is treated as one at full stretch along the same line.
    """
    S, W = np.asarray(S, dtype=np.float64), np.asarray(W, dtype=np.float64)
    axis = _unit(W - S)
    D = float(np.clip(np.linalg.norm(W - S), abs(L1 - L2) + 1e-6, L1 + L2 - 1e-6))
    along = (L1 * L1 - L2 * L2 + D * D) / (2 * D)
    h = math.sqrt(max(L1 * L1 - along * along, 0.0))
    C = S + along * axis
    u = np.asarray(pole, dtype=np.float64) - np.dot(pole, axis) * axis
    u = _unit(u if np.linalg.norm(u) > 1e-9 else np.cross(axis, [1.0, 0, 0]))
    v = np.cross(axis, u)
    phi = 0.0
    if C[1] + h * u[1] < min_y:
        rho, psi = math.hypot(u[1], v[1]), math.atan2(v[1], u[1])
        k = float(np.clip((min_y - C[1]) / (h * rho), -1, 1)) if h * rho > 1e-9 else 1.0
        wrap = lambda a: (a + math.pi) % (2 * math.pi) - math.pi
        phi = min((psi + math.acos(k), psi - math.acos(k)), key=lambda a: abs(wrap(a)))
    return C + h * (math.cos(phi) * u + math.sin(phi) * v)


def lowest_elbow_y(S, W, L1: float, L2: float) -> float:
    """The lowest the elbow can go while the wrist stays on W (the bottom of elbow_position's circle)."""
    S, W = np.asarray(S, dtype=np.float64), np.asarray(W, dtype=np.float64)
    axis = _unit(W - S)
    D = float(np.clip(np.linalg.norm(W - S), abs(L1 - L2) + 1e-6, L1 + L2 - 1e-6))
    along = (L1 * L1 - L2 * L2 + D * D) / (2 * D)
    h = math.sqrt(max(L1 * L1 - along * along, 0.0))
    return float(S[1] + along * axis[1] - h * math.sqrt(max(1 - axis[1] ** 2, 0.0)))


def arm_lengths(rest, side: str) -> tuple[float, float]:
    rest = np.asarray(rest, dtype=np.float64)
    s, e, w = (rest[J[f"{side}_{n}"]] for n in ("shoulder", "elbow", "wrist"))
    return float(np.linalg.norm(e - s)), float(np.linalg.norm(w - e))


def arm_pole(root_q, side: str, out: float = 0.5) -> np.ndarray:
    """Down and `out` toward this arm's side: where a relaxed elbow points (out ~0.15 for one resting on a table)."""
    side_dir = quat_to_matrix(np.asarray(root_q, dtype=np.float64)) @ np.array([1.0 if side == "left" else -1.0, 0, 0])
    return _DOWN + out * side_dir


def solve_arm(rest, root_q, root_t, pose, side: str, wrist, palm=_DOWN, hand_dir=None,
              elbow_min_y: float = -math.inf, elbow_out: float = 0.5) -> np.ndarray:
    """pose with this side's shoulder, elbow and wrist set so the wrist joint lands on `wrist`.

    palm: the world direction the palm should face (down by default). hand_dir: where the hand points from the wrist
    (default: straight on from the forearm). elbow_min_y: the elbow joint stays at or above this height.
    elbow_out: how far out the elbow points (arm_pole); a small value lets it settle onto elbow_min_y.
    """
    rest = np.asarray(rest, dtype=np.float64)
    js, je, jw = (J[f"{side}_{n}"] for n in ("shoulder", "elbow", "wrist"))
    pose = np.array(pose, dtype=np.float64)
    pos, R = world_joints(rest, root_q, root_t, pose)
    S, R_collar = pos[js], R[J[f"{side}_collar"]]
    L1, L2 = arm_lengths(rest, side)
    W = np.asarray(wrist, dtype=np.float64)
    E = elbow_position(S, W, L1, L2, arm_pole(root_q, side, elbow_out), elbow_min_y)
    u, f = _unit(E - S), _unit(W - E)

    d1, d2 = _unit(rest[je] - rest[js]), _unit(rest[jw] - rest[je])
    hinge_rest = np.cross(d1, _REST_FORWARD)  # a bent elbow brings the forearm forward
    hinge = np.cross(u, f)
    if np.linalg.norm(hinge) < 1e-6:  # arm straight: any hinge works, keep the elbow pointing at the pole
        hinge = np.cross(u, arm_pole(root_q, side, elbow_out))
    R_upper = frame(u, hinge) @ frame(d1, hinge_rest).T
    R_fore = frame(f, palm) @ frame(d2, _DOWN).T  # rest palms face down
    h = f if hand_dir is None else _unit(hand_dir)
    d3 = _unit(rest[J[f"{side}_middle1"]] - rest[jw])
    R_hand = frame(h, palm) @ frame(d3, _DOWN).T

    pose[js] = to_aa(R_collar.T @ R_upper)
    pose[je] = to_aa(R_upper.T @ R_fore)
    pose[jw] = to_aa(R_fore.T @ R_hand)
    return pose


def lean(pose, angle: float) -> np.ndarray:
    """pose with the spine bent forward by `angle` radians, spread over spine1-3 (the pelvis tilt is the caller's)."""
    pose = np.array(pose, dtype=np.float64)
    for name, share in SPINE_SHARE.items():
        pose[J[name], 0] += share * angle
    return pose


def look_at(rest, root_q, root_t, pose, target, neck_share: float = 0.4) -> np.ndarray:
    """pose with neck and head turned (no roll) so the face points at target; the neck takes neck_share of it."""
    pose = np.array(pose, dtype=np.float64)
    pose[J["neck"]] = pose[J["head"]] = 0
    for _ in range(4):  # turning the neck moves the head a little, so re-aim from where it ends up
        pos, R = world_joints(rest, root_q, root_t, pose)
        d = _unit(R[J["spine3"]].T @ (np.asarray(target, dtype=np.float64) - pos[J["head"]]))
        axis = np.cross(_REST_FORWARD, d)
        s = np.linalg.norm(axis)
        total = axis / s * math.atan2(s, d @ _REST_FORWARD) if s > 1e-12 else np.zeros(3)
        pose[J["neck"]] = neck_share * total
        pose[J["head"]] = (1 - neck_share) * total
    return pose
