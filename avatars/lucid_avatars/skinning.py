"""Linear-blend skinning for avatar.ply: avatar/skin.bin and avatar/skeleton.json, plus a reference player.

skin.bin: per Gaussian, in avatar.ply's order, 8 bytes: 4 x uint8 joint index then 4 x uint8 weight summing to 255.
skeleton.json: {"joints": [55 names], "parents": [55 ints, -1 for the root], "rest": [55 x [x, y, z]]}, the SMPL-X
joints of avatar.ply's rest pose (zero rotations, flat hands) in metres.

Posing (what pose_points does, and what a player does on the GPU), for a motion.json frame:
  G_0 = [R(root_q) R(pose[0]) | rest_0],  G_j = G_parent(j) [R(pose[j]) | rest_j - rest_parent(j)]
  M_j = G_j [I | -rest_j] + [0 | root_t],   x_posed = sum_k w_k M_{i_k} x_rest
which is exactly how SMPL-X applies global_orient, transl and the joint rotations.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .rotations import aa_to_quat, quat_mul, quat_to_matrix
from .smplx_layout import JOINT_NAMES, NUM_JOINTS, SMPLX_PARENTS

SKIN_FILE = "avatar/skin.bin"
SKELETON_FILE = "avatar/skeleton.json"
RECORD_BYTES = 8


def rest_joints(v_template, shapedirs, J_regressor, betas) -> tuple[np.ndarray, np.ndarray]:
    """SMPL-X rest joints (55, 3) and vertices (V, 3) for these betas (zero pose, flat hands)."""
    betas = np.asarray(betas, dtype=np.float64).reshape(-1)
    shapedirs = np.asarray(shapedirs, dtype=np.float64)[..., : len(betas)]
    verts = np.asarray(v_template, dtype=np.float64) + shapedirs @ betas
    return np.asarray(J_regressor, dtype=np.float64)[:NUM_JOINTS] @ verts, verts


def blend_vertex_weights(lbs_weights, idx, dist, eps: float = 1e-6) -> np.ndarray:
    """Per-point joint weights (N, 55): the SMPL-X skinning weights of each point's k nearest rest vertices
    (idx, dist: (N, k)), blended by inverse distance."""
    inv = 1.0 / (np.asarray(dist, dtype=np.float64) + eps)
    w = np.einsum("nk,nkj->nj", inv, np.asarray(lbs_weights, dtype=np.float64)[np.asarray(idx)])
    return w / w.sum(axis=1, keepdims=True)


def quantize_top4(weights) -> tuple[np.ndarray, np.ndarray]:
    """The 4 biggest joints per row, as uint8 indices and uint8 weights summing exactly to 255 (largest remainder)."""
    weights = np.asarray(weights, dtype=np.float64)
    idx = np.argsort(-weights, axis=1, kind="stable")[:, :4]
    top = np.take_along_axis(weights, idx, axis=1)
    top = top / top.sum(axis=1, keepdims=True) * 255
    q = np.floor(top).astype(np.int64)
    short = 255 - q.sum(axis=1)
    order = np.argsort(-(top - q), axis=1, kind="stable")
    for k in range(4):
        q[np.arange(len(q)), order[:, k]] += k < short
    idx = np.where(q > 0, idx, 0)  # unused slots point at the pelvis with weight 0
    return idx.astype(np.uint8), q.astype(np.uint8)


def write_skin_bin(path: str | Path, idx: np.ndarray, q: np.ndarray) -> None:
    Path(path).write_bytes(np.concatenate([idx, q], axis=1).astype(np.uint8).tobytes())


def read_skin_bin(path: str | Path) -> tuple[np.ndarray, np.ndarray]:
    raw = np.frombuffer(Path(path).read_bytes(), dtype=np.uint8)
    if len(raw) % RECORD_BYTES:
        raise ValueError(f"skin.bin is {len(raw)} bytes, not a multiple of {RECORD_BYTES}")
    rec = raw.reshape(-1, RECORD_BYTES)
    return rec[:, :4].copy(), rec[:, 4:].copy()


def skeleton_dict(rest: np.ndarray) -> dict:
    rest = np.asarray(rest, dtype=np.float64).reshape(NUM_JOINTS, 3)
    return {"joints": list(JOINT_NAMES), "parents": list(SMPLX_PARENTS), "rest": np.round(rest, 6).tolist()}


def skeleton_errors(sk) -> list[str]:
    if not isinstance(sk, dict):
        return ["skeleton.json must be an object"]
    errors = []
    if sk.get("joints") != JOINT_NAMES:
        errors.append(f"joints must be the {NUM_JOINTS} SMPL-X joint names in order")
    if sk.get("parents") != SMPLX_PARENTS:
        errors.append("parents must be the SMPL-X kinematic tree")
    rest = sk.get("rest")
    if not (isinstance(rest, list) and len(rest) == NUM_JOINTS
            and all(isinstance(p, list) and len(p) == 3 and all(np.isfinite(v) for v in p) for p in rest)):
        errors.append(f"rest must be {NUM_JOINTS} x [x, y, z]")
    return errors


def skin_errors(root: Path, avatar: dict, n_gaussians: int) -> list[str]:
    """Problems with the skin.bin and skeleton.json a dream.json names; nothing to check when it names neither."""
    errors = []
    if "skeleton" in avatar:
        try:
            sk = json.loads((root / avatar["skeleton"]).read_text())
            errors += [f"skeleton.json: {e}" for e in skeleton_errors(sk)]
        except (OSError, ValueError, TypeError) as e:
            errors.append(f"skeleton.json: {e}")
    if "skin" in avatar:
        try:
            idx, q = read_skin_bin(root / avatar["skin"])
        except (OSError, ValueError, TypeError) as e:
            return errors + [f"skin.bin: {e}"]
        if len(idx) != n_gaussians:
            return errors + [f"skin.bin: has {len(idx)} records but avatar.ply has {n_gaussians} Gaussians"]
        if (bad := int((idx >= NUM_JOINTS).sum())):
            errors.append(f"skin.bin: {bad} joint index values are {NUM_JOINTS} or more")
        if (bad := int((q.astype(np.int64).sum(axis=1) != 255).sum())):
            errors.append(f"skin.bin: weights of {bad} Gaussians don't sum to 255")
    if ("skin" in avatar) != ("skeleton" in avatar):
        errors.append("dream.json: avatar.skin and avatar.skeleton come together")
    return errors


def skin_matrices(rest, root_q, root_t, pose) -> np.ndarray:
    """(55, 4, 4) skinning matrices M_j for one motion.json frame (see the module docstring)."""
    rest = np.asarray(rest, dtype=np.float64).reshape(NUM_JOINTS, 3)
    local = quat_to_matrix(aa_to_quat(np.asarray(pose, dtype=np.float64).reshape(NUM_JOINTS, 3)))
    local[0] = quat_to_matrix(quat_mul(np.asarray(root_q, dtype=np.float64), aa_to_quat(np.asarray(pose)[0])))
    G = np.zeros((NUM_JOINTS, 4, 4))
    for j, p in enumerate(SMPLX_PARENTS):
        T = np.eye(4)
        T[:3, :3] = local[j]
        T[:3, 3] = rest[j] - (rest[p] if p >= 0 else 0)
        G[j] = T if p < 0 else G[p] @ T
    M = G.copy()
    M[:, :3, 3] -= np.einsum("jab,jb->ja", G[:, :3, :3], rest)
    M[:, :3, 3] += np.asarray(root_t, dtype=np.float64)
    return M


def pose_points(xyz, idx, q, M) -> np.ndarray:
    """Reference linear-blend skinning of rest positions xyz (N, 3) with skin.bin records and skin_matrices."""
    w = np.asarray(q, dtype=np.float64) / 255
    blended = np.einsum("nk,nkab->nab", w, np.asarray(M)[np.asarray(idx, dtype=np.int64)])
    return np.einsum("nab,nb->na", blended[:, :3, :3], np.asarray(xyz, dtype=np.float64)) + blended[:, :3, 3]
