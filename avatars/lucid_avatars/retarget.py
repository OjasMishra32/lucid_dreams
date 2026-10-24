"""Playing one person's motion on another avatar, standing on our floor.

retarget: keep the joint rotations (SMPL-X pose is body-independent), give the motion the avatar's betas, and scale
the root path by leg length so a child doesn't skate a grown-up's stride.
place_on_floor: turn the motion to face the viewer (-Z), centre it, and drop it so the avatar's lowest visible
Gaussian over the whole clip touches y = 0, posing the avatar's own Gaussians with its skin.bin weights, so crouches
and jumps stay where they were.
"""

from __future__ import annotations

from dataclasses import replace

import numpy as np

from .motion import Motion, face_viewer_on_floor
from .skinning import pose_points, skin_matrices
from .smplx_layout import J


def leg_length(rest: np.ndarray) -> float:
    """Mean hip-to-ankle length of a rest skeleton (55, 3)."""
    rest = np.asarray(rest, dtype=np.float64)
    sides = [np.linalg.norm(rest[J[f"{s}_hip"]] - rest[J[f"{s}_ankle"]]) for s in ("left", "right")]
    return float(np.mean(sides))


def retarget(m: Motion, rest_src: np.ndarray, rest_dst: np.ndarray, betas: np.ndarray) -> Motion:
    """m (performed by a body with rest joints rest_src) for a body with rest joints rest_dst and these betas."""
    src, dst = leg_length(rest_src), leg_length(rest_dst)
    scale = dst / src if src > 1e-6 and dst > 1e-6 else 1.0
    t0 = m.root_t[:1]
    return replace(m, betas=np.asarray(betas, dtype=np.float64).copy(), root_t=t0 + scale * (m.root_t - t0),
                   pose=m.pose.copy(), root_q=m.root_q.copy())


def place_on_floor(m: Motion, xyz, opacity_logit, skin_idx, skin_w, rest, min_alpha: float = 0.5,
                   max_points: int = 20000, max_frames: int = 60) -> Motion:
    """m facing -Z, its first pelvis on x = z = 0, and its lowest posed visible Gaussian (over the clip) on y = 0."""
    faced = face_viewer_on_floor(m, floor_y=0.0, pelvis_rest=np.asarray(rest)[0])
    xyz = np.asarray(xyz, dtype=np.float64)
    visible = np.flatnonzero(1 / (1 + np.exp(-np.asarray(opacity_logit, dtype=np.float64))) >= min_alpha)
    if len(visible) > max_points:  # every soles-height point, plus an even sample of the rest
        low = visible[xyz[visible, 1] <= np.percentile(xyz[visible, 1], 5)]
        visible = np.union1d(low, visible[:: max(1, len(visible) // max_points)])
    frames = np.unique(np.linspace(0, m.num_frames - 1, min(m.num_frames, max_frames)).round().astype(int))
    pts, idx, w = xyz[visible], np.asarray(skin_idx)[visible], np.asarray(skin_w)[visible]
    floor = min(
        pose_points(pts, idx, w, skin_matrices(rest, faced.root_q[f], faced.root_t[f], faced.pose[f]))[:, 1].min()
        for f in frames
    )
    t = faced.root_t.copy()
    t[:, 1] -= floor
    return replace(faced, root_t=t)
