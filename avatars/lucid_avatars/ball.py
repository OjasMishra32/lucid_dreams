"""The basketball's 3D path from its 2D boxes in the clip GVHMR ran on (4DAnyone's input video), in the person's frame.

Distance: a ball of known diameter (24 cm, regulation size 7) at distance d spans an angle of 2 asin(R / d), the same
in every direction, so the angle between the rays through its box's opposite edges gives d. The box's centre ray gives
the direction. That puts the ball in GVHMR's camera (K_fullimg).

Camera -> person: GVHMR fits the same body twice, in the camera (smpl_params_incam) and in its gravity-aligned world
(smpl_params_global). SMPL-X turns the body about the rest pelvis J0, so for each frame
    x_cam = R_c (x - J0) + J0 + t_c   and   x_glob = R_g (x - J0) + J0 + t_g,
and the camera's pose in GVHMR's world is x_glob = R_g R_c^T (x_cam - J0 - t_c) + J0 + t_g. `world` (4x4) moves it on:
4DAnyone's motion_world_to_canonical_world (what gvhmr_motion.py uses), composed with the export's placement
[rot | t] for bundle space.

Limits: a box cut by a hand or blurred along the ball's flight gives a wrong size and so a wrong distance (each pixel
of size error is 1 / size of the distance: 3% for a 30 px ball); smooth the distance over time, or skip held frames,
before trusting single frames.
"""

from __future__ import annotations

import numpy as np

from .rotations import aa_to_quat, quat_to_matrix

BALL_DIAMETER = 0.24


def _unit(v: np.ndarray) -> np.ndarray:
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def ball_in_camera(K, boxes, diameter: float = BALL_DIAMETER, width: int | None = None,
                   height: int | None = None, edge_px: float = 1.0) -> np.ndarray:
    """(N, 3) ball centres in camera coordinates (OpenCV: +Z forward, +Y down) from (N, 4) pixel boxes x1, y1, x2, y2.

    K is (3, 3) or one per frame (N, 3, 3). Rows without a box (NaN) give NaN; so do boxes within edge_px of the
    image border when width and height are given (the ball is partly out of frame, so its size is wrong).
    """
    boxes = np.asarray(boxes, dtype=np.float64).reshape(-1, 4)
    n = len(boxes)
    K = np.broadcast_to(np.asarray(K, dtype=np.float64), (n, 3, 3))
    Kinv = np.linalg.inv(K)
    x1, y1, x2, y2 = boxes.T
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2

    def ray(u, v):
        return _unit(np.einsum("nab,nb->na", Kinv, np.stack([u, v, np.ones(n)], axis=1)))

    across = np.arccos(np.clip(np.sum(ray(x1, cy) * ray(x2, cy), axis=1), -1, 1))
    down = np.arccos(np.clip(np.sum(ray(cx, y1) * ray(cx, y2), axis=1), -1, 1))
    half = (across + down) / 4  # half the ball's angular diameter
    with np.errstate(divide="ignore", invalid="ignore"):
        out = ray(cx, cy) * (diameter / 2 / np.sin(half))[:, None]
    bad = ~np.isfinite(boxes).all(axis=1) | (x2 <= x1) | (y2 <= y1)
    if width is not None and height is not None:
        bad |= (x1 <= edge_px) | (y1 <= edge_px) | (x2 >= width - edge_px) | (y2 >= height - edge_px)
    out[bad] = np.nan
    return out


def camera_to_global(incam: dict, global_: dict, J0) -> np.ndarray:
    """(N, 4, 4) GVHMR camera -> GVHMR world per frame, from the incam and global fits of the same body.

    incam / global_ hold at least "global_orient" (N, 3) and "transl" (N, 3), as in GVHMR's smpl_params_*.
    J0 is the rest pelvis for the clip's betas (gvhmr_motion.rest_pelvis).
    """
    J0 = np.asarray(J0, dtype=np.float64).reshape(3)
    R_c = quat_to_matrix(aa_to_quat(np.asarray(incam["global_orient"], dtype=np.float64).reshape(-1, 3)))
    R_g = quat_to_matrix(aa_to_quat(np.asarray(global_["global_orient"], dtype=np.float64).reshape(-1, 3)))
    t_c = np.asarray(incam["transl"], dtype=np.float64).reshape(-1, 3)
    t_g = np.asarray(global_["transl"], dtype=np.float64).reshape(-1, 3)
    R = R_g @ np.transpose(R_c, (0, 2, 1))
    T = np.tile(np.eye(4), (len(R), 1, 1))
    T[:, :3, :3] = R
    T[:, :3, 3] = J0 + t_g - np.einsum("nab,nb->na", R, J0 + t_c)
    return T


def smooth_distance(cam, window: int = 5) -> np.ndarray:
    """(N, 3) camera-space centres with each distance replaced by a robust line through the seen frames within
    `window` around it (Theil-Sen: median slope, median offset), so one bad box is ignored and a ball flying away
    isn't pulled back at the clip's ends. The directions, which a hand or blur barely moves, stay. NaN stays NaN."""
    cam = np.asarray(cam, dtype=np.float64)
    dist = np.linalg.norm(cam, axis=1)
    out = np.full_like(cam, np.nan)
    h = window // 2
    for i in np.flatnonzero(np.isfinite(dist)):
        j = np.arange(max(0, i - h), min(len(dist), i + h + 1))
        j = j[np.isfinite(dist[j])]
        a, b = np.triu_indices(len(j), 1)
        slope = np.median((dist[j[b]] - dist[j[a]]) / (j[b] - j[a])) if len(a) else 0.0
        out[i] = cam[i] * (np.median(dist[j] - slope * (j - i)) / dist[i])
    return out


def pelvis_from_model(v_template, shapedirs, J_regressor, betas) -> np.ndarray:
    """J0, the rest pelvis SMPL-X turns the body about, for these betas from the model file's own arrays
    (SMPLX_NEUTRAL.npz: v_template (V, 3), shapedirs (V, 3, B), J_regressor (J, V)); numpy only, no GPU."""
    betas = np.asarray(betas, dtype=np.float64).reshape(-1)
    shaped = np.asarray(v_template, dtype=np.float64) + np.asarray(shapedirs, dtype=np.float64)[:, :, : len(betas)] @ betas
    return np.asarray(J_regressor, dtype=np.float64)[0] @ shaped


def track_for_frames(points, n_frames: int) -> list:
    """props.json `track`: one entry per bundle frame (nearest source frame in time, both spanning the clip),
    [x, y, z] to the millimetre or None where the ball isn't known."""
    points = np.asarray(points, dtype=np.float64)
    src = np.rint(np.arange(n_frames) * (len(points) - 1) / max(n_frames - 1, 1)).astype(int)
    return [[round(float(v), 3) for v in points[i]] if np.isfinite(points[i]).all() else None for i in src]


def ball_world(K, boxes, incam: dict, global_: dict, J0, world=None, diameter: float = BALL_DIAMETER,
               width: int | None = None, height: int | None = None, smooth: int = 0) -> np.ndarray:
    """(N, 3) ball centres in GVHMR's world moved by `world` (4x4, default none); NaN where there's no usable box.

    Frame i of boxes, K (if per frame), incam and global_ must be the same video frame. smooth > 1 takes each
    distance as the median over that many frames (smooth_distance) before leaving the camera.
    """
    cam = ball_in_camera(K, boxes, diameter, width, height)
    if smooth > 1:
        cam = smooth_distance(cam, smooth)
    T = camera_to_global(incam, global_, J0)
    if world is not None:
        T = np.asarray(world, dtype=np.float64) @ T
    return np.einsum("nab,nb->na", T[:, :3, :3], cam) + T[:, :3, 3]
