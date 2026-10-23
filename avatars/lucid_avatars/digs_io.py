"""Glue between a photo, NLF's SMPL-X fit, DiGS-Avatar and our bundle. Plain numpy so it is testable anywhere.

DiGS reads the reference fit in its SMPLify-style JSON (see its demo/001.json and lib/utils/infer_util.py
load_smplify_json): camera {R, t, focal, princpt} plus SMPL-X parts, hands relative to the SMPL-X hand mean.
"""

from __future__ import annotations

import math
from dataclasses import replace

import numpy as np

from .gaussian_ply import SH_C0, Gaussians
from .motion import Motion
from .smplx_layout import LEFT_HAND, RIGHT_HAND

DIGS_W, DIGS_H = 640, 896  # DiGS input size (configs/student_inpaint.yaml image_size is [H, W])


def intrinsics_from_fov(width: int, height: int, fov_deg: float) -> np.ndarray:
    """Pinhole K with the field of view across the image's long side and the principal point at the centre."""
    f = max(width, height) / 2 / math.tan(math.radians(fov_deg) / 2)
    return np.array([[f, 0, width / 2], [0, f, height / 2], [0, 0, 1]], dtype=np.float64)


def aspect_crop_box(bbox, aspect_wh: float, margin: float = 0.1) -> tuple[float, float, float, float]:
    """A box around bbox (x0, y0, x1, y1) with `margin` extra on each side and width/height = aspect_wh.

    It may extend past the image; the caller pads that area with background.
    """
    x0, y0, x1, y1 = bbox
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    w, h = (x1 - x0) * (1 + 2 * margin), (y1 - y0) * (1 + 2 * margin)
    if w / h > aspect_wh:
        h = w / aspect_wh
    else:
        w = h * aspect_wh
    return cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2


def crop_intrinsics(K: np.ndarray, box, out_w: int, out_h: int) -> np.ndarray:
    """K for the image you get by cropping `box` and resizing it to out_w x out_h."""
    x0, y0, x1, y1 = box
    sx, sy = out_w / (x1 - x0), out_h / (y1 - y0)
    Kc = np.array(K, dtype=np.float64).copy()
    Kc[0, 0] *= sx
    Kc[1, 1] *= sy
    Kc[0, 2] = (Kc[0, 2] - x0) * sx
    Kc[1, 2] = (Kc[1, 2] - y0) * sy
    return Kc


def centred_crop_intrinsics(K: np.ndarray, box, out_w: int, out_h: int) -> np.ndarray:
    """crop_intrinsics with the principal point moved to the crop's centre.

    DiGS's visibility mesh renderer hard-codes a centred principal point, so an off-centre one makes visibility and
    texture sampling disagree. Fit the body on the crop under this K (not on the photo) and everything stays consistent.
    """
    Kc = crop_intrinsics(K, box, out_w, out_h)
    Kc[0, 2], Kc[1, 2] = out_w / 2, out_h / 2
    return Kc


def digs_fit_json(pose: np.ndarray, betas: np.ndarray, trans: np.ndarray, K: np.ndarray,
                  hand_mean: np.ndarray) -> dict:
    """NLF SMPL-X output for one person (pose 165 absolute axis-angle, betas, trans in metres, camera space)
    as the reference-fit JSON DiGS reads. The camera is the identity; K is for the image DiGS sees.
    hand_mean is DiGS's own get_hand_pose_mean() (90 floats), because DiGS uses flat_hand_mean=False.
    """
    pose = np.asarray(pose, dtype=np.float64).reshape(165)
    hand_mean = np.asarray(hand_mean, dtype=np.float64).reshape(90)
    row = lambda a: [np.asarray(a, dtype=np.float64).reshape(-1).tolist()]
    return {
        "root_pose": row(pose[0:3]),
        "body_pose": row(pose[3:66]),
        "jaw_pose": row(pose[66:69]),
        "leye_pose": row(pose[69:72]),
        "reye_pose": row(pose[72:75]),
        "lhand_pose": row(pose[75:120] - hand_mean[:45]),
        "rhand_pose": row(pose[120:165] - hand_mean[45:]),
        "betas_save": row(np.asarray(betas).reshape(-1)[:10]),
        "trans": row(trans),
        "expr": row(np.zeros(10)),
        "scale": [1.0],
        # load_smplify_json doubles t, so keep everything in trans and t at zero.
        "camera": {
            "R": [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
            "t": [0, 0, 0],
            "focal": [float(K[0, 0]), float(K[1, 1])],
            "princpt": [float(K[0, 2]), float(K[1, 2])],
        },
    }


def rendered_to_gaussians(xyz, rgb, opacity, scale, rotation) -> Gaussians:
    """Gaussians as DiGS hands them to the rasterizer (RGB colour, opacity in 0..1, metric scale,
    unnormalised [w, x, y, z] quaternion) to the stored form of a standard 3DGS PLY (SH degree 0)."""
    xyz = np.asarray(xyz, dtype=np.float64).reshape(-1, 3)
    n = len(xyz)
    p = np.clip(np.asarray(opacity, dtype=np.float64).reshape(n), 1e-6, 1 - 1e-6)
    rot = np.asarray(rotation, dtype=np.float64).reshape(n, 4)
    return Gaussians(
        xyz=xyz,
        f_dc=(np.asarray(rgb, dtype=np.float64).reshape(n, 3) - 0.5) / SH_C0,
        f_rest=np.zeros((n, 0)),
        opacity=np.log(p / (1 - p)),
        scale=np.log(np.asarray(scale, dtype=np.float64).reshape(n, 3)),
        rotation=rot / np.linalg.norm(rot, axis=1, keepdims=True),
    )


def stand_y(xyz: np.ndarray, opacity_logit: np.ndarray, min_alpha: float = 0.5) -> float:
    """SMPL-X transl y that puts the rest-pose soles on y = 0: minus the lowest clearly visible Gaussian."""
    visible = 1 / (1 + np.exp(-np.asarray(opacity_logit))) >= min_alpha
    return float(-np.asarray(xyz)[visible, 1].min())


def alpha_bbox(alpha: np.ndarray, threshold: int = 32) -> tuple[int, int, int, int]:
    """(x0, y0, x1, y1) of the pixels whose matte alpha (H, W, 0..255) is above threshold; x1 and y1 exclusive."""
    ys, xs = np.nonzero(np.asarray(alpha) > threshold)
    if len(xs) == 0:
        raise ValueError("the matte has no person in it")
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def largest_person(boxes) -> int:
    """Index of the person to avatar-ise from NLF's (n, 5) boxes [x, y, w, h, confidence]: the biggest box.
    With no boxes (None) it is the first detection."""
    if boxes is None:
        return 0
    boxes = np.asarray(boxes, dtype=np.float64)
    return int(np.argmax(boxes[:, 2] * boxes[:, 3]))


def rest_pose_errors(xyz: np.ndarray, opacity_logit: np.ndarray, min_alpha: float = 0.5) -> list[str]:
    """Reasons a captured rest-pose Gaussian cloud can't be a person in metres, for a loud failure
    instead of a plausible-looking wrong bundle."""
    xyz = np.asarray(xyz, dtype=np.float64)
    visible = 1 / (1 + np.exp(-np.asarray(opacity_logit, dtype=np.float64))) >= min_alpha
    if not visible.any():
        return ["no Gaussian is visible (opacity below 0.5 everywhere)"]
    height = np.ptp(xyz[visible, 1])
    if not 0.8 <= height <= 2.4:
        return [f"rest-pose height is {height:.2f} m; expected a person between 0.8 and 2.4 m (wrong units or scale?)"]
    return []


def with_hand_mean(m: Motion, hand_mean: np.ndarray) -> Motion:
    """The motion with both hands held in DiGS's rest hand pose (hand_mean, 90 floats, absolute), so the
    fingers match the captured avatar.ply instead of snapping flat."""
    hand_mean = np.asarray(hand_mean, dtype=np.float64).reshape(90)
    pose = m.pose.copy()
    pose[:, LEFT_HAND] = hand_mean[:45].reshape(15, 3)
    pose[:, RIGHT_HAND] = hand_mean[45:].reshape(15, 3)
    return replace(m, pose=pose)
