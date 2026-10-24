"""Hands and face pass: 2x close-up crops of 4DAnyone's views, for a short extra optimisation after the fine-tune
(digs_finetune.py --detail-steps), so close-ups hold up. Plain numpy; cameras are OpenCV (+X right, +Y down, +Z
forward), camera_to_world 4x4, in 4DAnyone's metric world.

A crop can't be a shifted principal point: DiGS's renderer assumes it at the image centre. So a crop is a virtual
camera at the same centre, turned to look at the face or hand, at twice the view's focal length. Same centre means
the view maps onto it exactly by a homography (H = K_src R_src^T R_crop K_crop^-1), which is how the real view is
resampled into the crop for the loss.
"""

from __future__ import annotations

import math

import numpy as np

from .smplx_layout import J

FACE_RADIUS = 0.16  # m: face, hair and ears around the point between the skull's centre and the eyes


def _unit(v: np.ndarray) -> np.ndarray:
    return v / np.linalg.norm(v)


def detail_regions(joints) -> dict[str, tuple[np.ndarray, float]]:
    """{"face" | "left_hand" | "right_hand": (centre (3,), radius m)} from posed SMPL-X joints (55, 3)."""
    joints = np.asarray(joints, dtype=np.float64)
    eyes = (joints[J["left_eye"]] + joints[J["right_eye"]]) / 2
    out = {"face": ((joints[J["head"]] + eyes) / 2, FACE_RADIUS)}
    for side in ("left", "right"):
        wrist, tip = joints[J[f"{side}_wrist"]], joints[J[f"{side}_middle3"]]
        out[f"{side}_hand"] = ((wrist + tip) / 2, 0.6 * float(np.linalg.norm(tip - wrist)) + 0.04)
    return out


def crop_camera(K, camera_to_world, centre, radius: float, width: int, height: int, scale: float = 2.0,
                multiple: int = 16, min_px: int = 64, max_px: int = 512):
    """(K_crop, camera_to_world_crop, size) of a square crop turned onto the sphere (centre, radius) at `scale` times
    the view's focal length, or None when the sphere is behind the view, not wholly inside its image (a crop past
    the edge would ask for white where the body is), or round the camera. Too big a crop for max_px zooms out."""
    K = np.asarray(K, dtype=np.float64)
    c2w = np.asarray(camera_to_world, dtype=np.float64)
    C, R = c2w[:3, 3], c2w[:3, :3]
    centre = np.asarray(centre, dtype=np.float64)
    local = R.T @ (centre - C)
    d = float(np.linalg.norm(local))
    if local[2] <= 0 or d <= 1.5 * radius:
        return None
    u, v = (K @ local)[:2] / local[2]
    half = math.asin(min(radius / d, 1.0))  # the sphere's angular radius
    r_px = max(K[0, 0], K[1, 1]) * math.tan(half) / max(local[2] / d, 1e-6) ** 2  # generous off-axis
    if not (r_px <= u < width - r_px and r_px <= v < height - r_px):
        return None
    f = scale * (K[0, 0] + K[1, 1]) / 2
    size = int(np.clip(multiple * math.ceil(2 * f * math.tan(half) / multiple), min_px, max_px))
    f = min(f, size / (2 * math.tan(half)))
    z = _unit(centre - C)
    x = _unit(R[:, 0] - (R[:, 0] @ z) * z)  # keep the view's roll: its right stays right, down stays down
    out = np.eye(4)
    out[:3, :3] = np.stack([x, np.cross(z, x), z], axis=1)
    out[:3, 3] = C
    return np.array([[f, 0, size / 2], [0, f, size / 2], [0, 0, 1.0]]), out, size


def crop_homography(K_src, c2w_src, K_crop, c2w_crop) -> np.ndarray:
    """(3, 3) crop pixel -> source pixel, for two cameras sharing a centre."""
    R_src = np.asarray(c2w_src, dtype=np.float64)[:3, :3]
    R_crop = np.asarray(c2w_crop, dtype=np.float64)[:3, :3]
    return np.asarray(K_src, dtype=np.float64) @ R_src.T @ R_crop @ np.linalg.inv(np.asarray(K_crop, dtype=np.float64))


def sample_grid(H, size: int, width: int, height: int) -> np.ndarray:
    """(size, size, 2) torch grid_sample coordinates (align_corners=False, x then y) that resample the source view
    into the crop: crop pixel (u, v) reads source pixel H (u, v), pixel centres on integers as in OpenCV."""
    v, u = np.mgrid[0:size, 0:size].astype(np.float64)
    p = np.stack([u, v, np.ones_like(u)], axis=-1) @ np.asarray(H, dtype=np.float64).T
    xy = p[..., :2] / p[..., 2:]
    return np.stack([(2 * xy[..., 0] + 1) / width - 1, (2 * xy[..., 1] + 1) / height - 1], axis=-1).astype(np.float32)
