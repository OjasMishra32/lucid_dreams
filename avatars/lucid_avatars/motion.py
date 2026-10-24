"""SMPL-X motion in the motion.json format from AGENTS.md, plus converters.

Conventions (to confirm with the Quest app):
- root_t and root_q are SMPL-X `transl` and `global_orient`, applied exactly as the SMPL-X model applies them.
- pose[0] (the pelvis) is always zero; the root rotation lives only in root_q, so nothing is applied twice.
- pose holds absolute joint rotations, hands included (no hand-mean offset, no PCA).
- expr (optional, every frame or none) is 10 expression weights, e.g. for blinking: avatar/expr.bin's channels when
  the bundle has one (face_expr.py), else SMPL-X's expression coefficients (DiGS renders).
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np

from .rotations import aa_to_quat, quat_mul, quat_to_aa, rotate_by_quat, yaw_quat
from .smplx_layout import (
    DIGS_BETAS,
    DIGS_BODY,
    DIGS_EXPR,
    DIGS_EYES,
    DIGS_HANDS,
    DIGS_JAW,
    DIGS_PARAM_DIM,
    DIGS_ROOT,
    DIGS_SCALE,
    DIGS_TRANS,
    NUM_JOINTS,
)


@dataclass
class Motion:
    fps: float
    betas: np.ndarray   # (10,)
    root_t: np.ndarray  # (N, 3)
    root_q: np.ndarray  # (N, 4) x, y, z, w
    pose: np.ndarray    # (N, 55, 3) axis-angle
    expr: np.ndarray | None = None  # (N, 10) expression weights (expr.bin channels or SMPL-X), optional

    @property
    def num_frames(self) -> int:
        return len(self.pose)

    def to_dict(self) -> dict:
        r = lambda a: np.round(np.asarray(a, dtype=np.float64), 6).tolist()
        frames = [
            {"root_t": r(t), "root_q": r(q), "pose": r(p)} for t, q, p in zip(self.root_t, self.root_q, self.pose)
        ]
        if self.expr is not None:
            for f, e in zip(frames, self.expr):
                f["expr"] = r(e)
        return {"fps": self.fps, "betas": r(self.betas), "frames": frames}

    @classmethod
    def from_dict(cls, d: dict) -> Motion:
        errors = validate_motion_dict(d)
        if errors:
            raise ValueError("invalid motion: " + "; ".join(errors[:5]))
        frames = d["frames"]
        return cls(
            fps=d["fps"],
            betas=np.asarray(d["betas"], dtype=np.float64),
            root_t=np.asarray([f["root_t"] for f in frames], dtype=np.float64),
            root_q=np.asarray([f["root_q"] for f in frames], dtype=np.float64),
            pose=np.asarray([f["pose"] for f in frames], dtype=np.float64),
            expr=np.asarray([f["expr"] for f in frames], dtype=np.float64) if "expr" in frames[0] else None,
        )

    def save(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.to_dict(), separators=(",", ":")))

    @classmethod
    def load(cls, path: str | Path) -> Motion:
        return cls.from_dict(json.loads(Path(path).read_text()))


def is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def is_vec(x, n: int) -> bool:
    return isinstance(x, list) and len(x) == n and all(is_num(v) for v in x)


def validate_motion_dict(d: dict) -> list[str]:
    """Problems with a motion.json dict, as readable strings. Empty means valid."""
    errors: list[str] = []
    if not isinstance(d, dict):
        return ["motion must be a JSON object"]
    fps = d.get("fps")
    if not is_num(fps) or not fps > 0:
        errors.append(f"fps must be a positive number, got {fps!r}")
    if not is_vec(d.get("betas"), 10):
        errors.append("betas must be 10 finite numbers")
    frames = d.get("frames")
    if not isinstance(frames, list) or not frames:
        errors.append("frames must be a non-empty list")
        return errors
    for i, f in enumerate(frames):
        if len(errors) >= 20:
            errors.append("... more errors not shown")
            break
        if not isinstance(f, dict):
            errors.append(f"frame {i}: not an object")
            continue
        if not is_vec(f.get("root_t"), 3):
            errors.append(f"frame {i}: root_t must be 3 finite numbers")
        q = f.get("root_q")
        if not is_vec(q, 4):
            errors.append(f"frame {i}: root_q must be 4 finite numbers")
        elif abs(math.sqrt(sum(v * v for v in q)) - 1.0) > 1e-3:
            errors.append(f"frame {i}: root_q is not a unit quaternion")
        pose = f.get("pose")
        if not (isinstance(pose, list) and len(pose) == NUM_JOINTS and all(is_vec(p, 3) for p in pose)):
            errors.append(f"frame {i}: pose must be {NUM_JOINTS} x 3 finite numbers")
        if "expr" in f and not is_vec(f["expr"], 10):
            errors.append(f"frame {i}: expr must be 10 finite numbers")
    with_expr = sum(isinstance(f, dict) and "expr" in f for f in frames)
    if 0 < with_expr < len(frames):
        errors.append(f"expr is in {with_expr} of {len(frames)} frames; it goes in every frame or none")
    return errors


def from_digs_params(packed: np.ndarray, fps: float, hand_mean: np.ndarray) -> Motion:
    """DiGS-Avatar packed SMPL-X frames (N, 189) to a Motion.

    hand_mean is the SMPL-X model's (hands_meanl, hands_meanr) concatenated, 90 floats;
    read it from the SMPL-X model file, which we don't redistribute.
    """
    packed = np.atleast_2d(np.asarray(packed, dtype=np.float64))
    if packed.shape[1] != DIGS_PARAM_DIM:
        raise ValueError(f"expected (N, {DIGS_PARAM_DIM}) DiGS params, got {packed.shape}")
    if not np.allclose(packed[:, DIGS_SCALE], 1.0):
        raise ValueError("DiGS scale other than 1 is not representable in motion.json")
    n = len(packed)
    pose = np.zeros((n, NUM_JOINTS, 3))
    pose[:, 1:22] = packed[:, DIGS_BODY].reshape(n, 21, 3)
    pose[:, 22] = packed[:, DIGS_JAW]
    pose[:, 23:25] = packed[:, DIGS_EYES].reshape(n, 2, 3)
    pose[:, 25:55] = (packed[:, DIGS_HANDS] + np.asarray(hand_mean).reshape(90)).reshape(n, 30, 3)
    return Motion(
        fps=fps,
        betas=packed[0, DIGS_BETAS].copy(),
        root_t=packed[:, DIGS_TRANS].copy(),
        root_q=aa_to_quat(packed[:, DIGS_ROOT]),
        pose=pose,
        expr=packed[:, DIGS_EXPR].copy() if packed[:, DIGS_EXPR].any() else None,
    )


def to_digs_params(m: Motion, hand_mean: np.ndarray) -> np.ndarray:
    """Motion to DiGS-Avatar packed frames (N, 189), e.g. to drive a DiGS render. Expression is zero without expr."""
    n = m.num_frames
    out = np.zeros((n, DIGS_PARAM_DIM))
    out[:, DIGS_SCALE] = 1.0
    out[:, DIGS_TRANS] = m.root_t
    out[:, DIGS_ROOT] = quat_to_aa(quat_mul(m.root_q, aa_to_quat(m.pose[:, 0])))
    out[:, DIGS_BODY] = m.pose[:, 1:22].reshape(n, 63)
    out[:, DIGS_BETAS] = m.betas
    out[:, DIGS_HANDS] = m.pose[:, 25:55].reshape(n, 90) - np.asarray(hand_mean).reshape(90)
    out[:, DIGS_JAW] = m.pose[:, 22]
    out[:, DIGS_EYES] = m.pose[:, 23:25].reshape(n, 6)
    if m.expr is not None:
        out[:, DIGS_EXPR] = m.expr
    return out


def face_viewer_on_floor(m: Motion, floor_y: float, pelvis_rest: np.ndarray | None = None) -> Motion:
    """Put a y-up SMPL-X motion into our coordinates: turned about +Y so the first frame faces -Z,
    the first frame's pelvis centred on x = z = 0, and the floor (at height floor_y in the input) moved to y = 0.

    floor_y comes from the posed mesh (lowest sole vertex) and pelvis_rest is the SMPL-X rest pelvis joint J0
    for these betas; both need the SMPL-X model. Without pelvis_rest the pelvis lands a few cm off centre.
    """
    forward = rotate_by_quat(m.root_q[0], np.array([0.0, 0.0, 1.0]))
    yaw = yaw_quat(math.pi - math.atan2(forward[0], forward[2]))
    j0 = np.zeros(3) if pelvis_rest is None else np.asarray(pelvis_rest, dtype=np.float64)
    # SMPL-X rotates about J0, so a world rotation R maps transl t to R(t + J0) - J0.
    t = rotate_by_quat(yaw, m.root_t + j0) - j0
    pelvis0 = t[0] + j0
    t[:, 0] -= pelvis0[0]
    t[:, 2] -= pelvis0[2]
    t[:, 1] -= floor_y
    q = quat_mul(np.broadcast_to(yaw, m.root_q.shape), m.root_q)
    return replace(m, root_t=t, root_q=q, pose=m.pose.copy(), betas=m.betas.copy())
