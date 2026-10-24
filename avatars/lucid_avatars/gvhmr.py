"""GVHMR's SMPL-X motion (what 4DAnyone saves in <result>/gvhmr/motion.safetensors) as our Motion.

GVHMR stores smpl_params_global {global_orient (T,3), body_pose (T,63), betas (T,10), transl (T,3)} in its own
gravity-aligned, y-up frame. 4DAnyone's views live in another world (frame-0 pelvis over the origin, the lowest
vertex of the clip at y = 0, frame 0 facing +Z); it computes that 4x4 (motion_world_to_canonical_world) but doesn't
save it, so gvhmr_motion.py recomputes it with 4DAnyone's own code and passes it here as `world`.

No jaw, eyes or hands come from GVHMR: they are zero here (flat hands). GVHMR's own SMPL-X shows the hand mean, so
DiGS-side tools put the hands back with digs_io.with_hand_mean.
"""

from __future__ import annotations

import numpy as np

from .motion import Motion
from .rotations import aa_to_quat, quat_mul
from .smplx_layout import NUM_JOINTS


def matrix_to_quat(R: np.ndarray) -> np.ndarray:
    """Rotation matrix (3, 3) to unit quaternion [x, y, z, w] (Shepperd: branch on the largest component)."""
    R = np.asarray(R, dtype=np.float64)
    tr = np.trace(R)
    if tr > 0:
        s = 2 * np.sqrt(1 + tr)
        q = [(R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s, s / 4]
    else:
        i = int(np.argmax(np.diag(R)))
        j, k = (i + 1) % 3, (i + 2) % 3
        s = 2 * np.sqrt(1 + R[i, i] - R[j, j] - R[k, k])
        q = [0.0, 0.0, 0.0, (R[k, j] - R[j, k]) / s]
        q[i], q[j], q[k] = s / 4, (R[j, i] + R[i, j]) / s, (R[k, i] + R[i, k]) / s
    q = np.asarray(q)
    return q / np.linalg.norm(q)


def gvhmr_to_motion(global_orient, body_pose, transl, betas, fps: float, J0, world=None) -> Motion:
    """GVHMR smpl_params_global as a Motion, moved by the rigid 4x4 `world` (default: none).

    SMPL-X turns the body about the rest pelvis J0 (for these betas): v = R_go (x - J0) + J0 + transl. A world
    transform [R | t] then gives v' = R R_go (x - J0) + R (J0 + transl) + t, so root_q = R R_go and
    root_t = R (J0 + transl) + t - J0.
    """
    go = np.asarray(global_orient, dtype=np.float64).reshape(-1, 3)
    n = len(go)
    transl = np.asarray(transl, dtype=np.float64).reshape(n, 3)
    J0 = np.asarray(J0, dtype=np.float64).reshape(3)
    W = np.eye(4) if world is None else np.asarray(world, dtype=np.float64)
    R, t = W[:3, :3], W[:3, 3]
    root_q = quat_mul(np.broadcast_to(matrix_to_quat(R), (n, 4)), aa_to_quat(go))
    root_t = (J0 + transl) @ R.T + t - J0
    pose = np.zeros((n, NUM_JOINTS, 3))
    pose[:, 1:22] = np.asarray(body_pose, dtype=np.float64).reshape(n, 21, 3)
    betas = np.asarray(betas, dtype=np.float64).reshape(-1, 10).mean(axis=0)
    return Motion(fps=float(fps), betas=betas, root_t=root_t, root_q=root_q, pose=pose)
