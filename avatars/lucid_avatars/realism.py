"""Realism numbers for a dream bundle's `metrics`: identity, lpipsFace and sharpness.

  identity   InsightFace buffalo_l ArcFace cosine between the avatar's front face render and the source photo's face
  lpipsFace  LPIPS on the face crop: the avatar re-rendered from the photo's own fitted camera vs the photo, same crop
  sharpness  variance of the Laplacian on that render's face crop over the photo's (1.0 = as sharp as the photo)

This module is the plain part (numpy only; InsightFace is imported inside embed_faces): where the face is in the
photo's camera, the crop, the Laplacian, the cosine and the assembly of the three numbers, null for anything that
couldn't be computed. The renders and LPIPS itself are GPU glue in digs_avatar.py. Nothing here sends data anywhere.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from .ik import world_joints
from .rotations import aa_to_quat
from .smplx_layout import J, NUM_JOINTS

FACE_HALF_M = 0.17  # half the height a face view shows: chin to crown with a little neck and hair
FACE_ABOVE_HEAD_JOINT_M = 0.07  # SMPL-X's head joint is at the top of the neck; the face's middle is above it
MIN_FACE_PX = 16  # a face crop smaller than this has nothing to measure
MIN_FACE_INSIDE = 0.6  # share of the face box that must be inside the image


# ---------------------------------------------------------------- where the face is

def project(K: np.ndarray, point: np.ndarray) -> tuple[float, float] | None:
    """Pixel (u, v) of a camera-space point through pinhole K (y down), None on or behind the camera plane."""
    x, y, z = (float(v) for v in point)
    if z <= 1e-6:
        return None
    return float(K[0, 0] * x / z + K[0, 2]), float(K[1, 1] * y / z + K[1, 2])


def face_box(centre: np.ndarray, K: np.ndarray, half_m: float = FACE_HALF_M) -> tuple[float, float, float, float] | None:
    """The square (x0, y0, x1, y1) in pixels that a face centred at camera-space `centre` fills: 2 * half_m tall."""
    uv = project(K, centre)
    if uv is None:
        return None
    half_px = float(K[0, 0]) * half_m / float(centre[2])
    return uv[0] - half_px, uv[1] - half_px, uv[0] + half_px, uv[1] + half_px


def posed_face_centre(rest: np.ndarray, pose: np.ndarray, trans: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(face centre, head up direction) in camera space for an NLF SMPL-X fit (pose 165 absolute axis-angle with the
    global orientation first, trans = SMPL-X transl) of a body with these rest joints (skeleton.json's `rest`).
    The centre sits FACE_ABOVE_HEAD_JOINT_M above the head joint along the posed head's own up."""
    pose55 = np.asarray(pose, dtype=np.float64).reshape(NUM_JOINTS, 3).copy()
    root_q = aa_to_quat(pose55[0])
    pose55[0] = 0.0  # the root rotation lives in root_q only (motion.json's convention)
    joints, R = world_joints(rest, root_q, np.asarray(trans, dtype=np.float64), pose55)
    up = R[J["head"]] @ np.array([0.0, 1.0, 0.0])
    return joints[J["head"]] + FACE_ABOVE_HEAD_JOINT_M * up, up


def face_box_from_fit(rest, pose, trans, K, half_m: float = FACE_HALF_M):
    """The face's pixel box in the photo's camera from the fitted SMPL-X, or None if the head isn't in front of it."""
    centre, _ = posed_face_centre(rest, pose, trans)
    return face_box(centre, K, half_m)


# ---------------------------------------------------------------- boxes and crops

def clip_box(box, width: int, height: int) -> tuple[int, int, int, int] | None:
    """An integer box clamped to the image, or None: no box, under MIN_FACE_INSIDE of it inside the image, or a side
    under MIN_FACE_PX once clamped."""
    if box is None:
        return None
    x0, y0, x1, y1 = (float(v) for v in box)
    area = (x1 - x0) * (y1 - y0)
    if area <= 0:
        return None
    inside = max(0.0, min(x1, width) - max(x0, 0.0)) * max(0.0, min(y1, height) - max(y0, 0.0))
    if inside / area < MIN_FACE_INSIDE:
        return None
    out = (round(max(x0, 0.0)), round(max(y0, 0.0)), round(min(x1, width)), round(min(y1, height)))
    if out[2] - out[0] < MIN_FACE_PX or out[3] - out[1] < MIN_FACE_PX:
        return None
    return out


def crop(img: np.ndarray, box) -> np.ndarray:
    """The pixels of an (H, W[, C]) image inside an integer box (x0, y0, x1, y1)."""
    x0, y0, x1, y1 = box
    return img[y0:y1, x0:x1]


def map_box(box, crop_box, crop_w: int, crop_h: int):
    """A box in a crop's pixels (the crop shown at crop_w x crop_h) moved into the pixels of the image the crop was
    cut from (crop_box = (x0, y0, x1, y1) there). None stays None."""
    if box is None:
        return None
    cx0, cy0, cx1, cy1 = crop_box
    sx, sy = (cx1 - cx0) / crop_w, (cy1 - cy0) / crop_h
    x0, y0, x1, y1 = box
    return cx0 + x0 * sx, cy0 + y0 * sy, cx0 + x1 * sx, cy0 + y1 * sy


# ---------------------------------------------------------------- sharpness

def laplacian_variance(img: np.ndarray) -> float | None:
    """Variance of the 4-neighbour Laplacian over the interior of an image (luma if RGB). Pixel scale is whatever
    the image has: only ratios of two images on the same scale mean anything. None under 3 x 3 pixels."""
    a = np.asarray(img, dtype=np.float64)
    if a.ndim == 3:
        a = a[..., :3] @ np.array([0.299, 0.587, 0.114])
    if a.shape[0] < 3 or a.shape[1] < 3:
        return None
    lap = a[:-2, 1:-1] + a[2:, 1:-1] + a[1:-1, :-2] + a[1:-1, 2:] - 4 * a[1:-1, 1:-1]
    return float(lap.var())


def sharpness_ratio(render_crop: np.ndarray, photo_crop: np.ndarray) -> float | None:
    """Laplacian variance of the render's face over the photo's (1.0 = as sharp as the photo), None if either can't
    be measured or the photo's face is perfectly flat."""
    r, p = laplacian_variance(render_crop), laplacian_variance(photo_crop)
    if r is None or p is None or p <= 1e-9:
        return None
    return r / p


# ---------------------------------------------------------------- identity (shared with head_swap_render.py)

def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a / np.linalg.norm(a), b / np.linalg.norm(b)))


def identity_report(embeddings: dict[str, np.ndarray]) -> dict | None:
    """Cosine of the old and new faces' ArcFace embeddings to the photo's (None without a face in the photo)."""
    if "photo" not in embeddings:
        return None
    cos = {k: round(cosine(embeddings["photo"], v), 4) for k, v in embeddings.items() if k != "photo"}
    return {"model": "InsightFace buffalo_l (ArcFace), cosine to the photo, front view", "old": cos.get("old"),
            "new": cos.get("new")}


def identity_of(embeddings: dict[str, np.ndarray] | None) -> float | None:
    """The avatar's face-to-photo cosine from embed_faces({"photo": ..., "avatar": ...}); None if InsightFace is
    missing (embeddings None) or either image had no face."""
    if not embeddings or "photo" not in embeddings or "avatar" not in embeddings:
        return None
    return cosine(embeddings["photo"], embeddings["avatar"])


def embed_faces(images: dict[str, np.ndarray], root: Path) -> dict[str, np.ndarray] | None:
    """ArcFace embedding of the biggest face in each image, or None if InsightFace isn't installed."""
    try:
        from insightface.app import FaceAnalysis
    except ImportError:
        return None
    app = FaceAnalysis(name="buffalo_l", root=str(root), providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    app.prepare(ctx_id=0, det_size=(640, 640))
    out = {}
    for key, rgb in images.items():
        faces = app.get(np.ascontiguousarray(rgb[..., ::-1]))  # InsightFace wants BGR
        if faces:
            out[key] = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])).normed_embedding
        else:
            print(f"[identity] no face found in the {key} image")
    return out


# ---------------------------------------------------------------- the three numbers

def _clean(v) -> float | None:
    return None if v is None or not math.isfinite(float(v)) else round(float(v), 4)


def realism_metrics(identity, lpips_face, sharpness) -> dict:
    """The three dream.json metrics, always all three keys, rounded to 4 places, null where not computed."""
    return {"identity": _clean(identity), "lpipsFace": _clean(lpips_face), "sharpness": _clean(sharpness)}


def guarded(name: str, fn):
    """fn() or None: a metric that fails for any reason is null and logged, and never stops the bundle."""
    try:
        return fn()
    except Exception as e:  # noqa: BLE001  (a missing model, no GPU, a odd image: all just "not computed")
        print(f"[realism] {name} skipped: {type(e).__name__}: {e}")
        return None
