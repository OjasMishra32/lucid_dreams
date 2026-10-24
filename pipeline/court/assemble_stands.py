"""The stands proxy from two real views of the same instant (plan 4.1: the assembly's stands proxy): SIFT matches
between two calibrated frames, each match triangulated from both cameras' rays (lens distortion undone), and planes
fitted to the points behind the far baseline. The footage's stands pixels are projected onto these planes, so their
depth is what the cameras measured rather than a guess. numpy and OpenCV only.

Cameras here carry the calibration's own lens (xn = x_cam / z; xd = xn (1 + k1 |xn|^2); u = f xd + cx), because the
frames are the raw ones the calibration was solved on.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from assemble_geom import Cam


@dataclass
class CalCam:
    """A calibrated camera on raw (distorted) frames."""
    cam: Cam
    k1: float


def undistort(xd, yd, k1: float, iters: int = 10):
    """Invert xd = xn (1 + k1 r^2) on the radius by Newton steps."""
    rd = np.hypot(xd, yd)
    r = rd.copy()
    for _ in range(iters):
        r = r - (r + k1 * r ** 3 - rd) / (1 + 3 * k1 * r * r)
    s = np.where(rd > 1e-12, r / np.maximum(rd, 1e-12), 1.0)
    return xd * s, yd * s


def rays(cc: CalCam, uv: np.ndarray) -> np.ndarray:
    c = cc.cam
    xn, yn = undistort((uv[:, 0] - c.cx) / c.f, (uv[:, 1] - c.cy) / c.f, cc.k1)
    d = np.stack([xn, yn, np.ones_like(xn)], 1) @ c.R.T
    return d / np.linalg.norm(d, axis=1, keepdims=True)


def project(cc: CalCam, X: np.ndarray):
    c = cc.cam.to_cam(X)
    z = c[:, 2]
    xn, yn = c[:, 0] / z, c[:, 1] / z
    s = 1 + cc.k1 * (xn * xn + yn * yn)
    return cc.cam.cx + cc.cam.f * xn * s, cc.cam.cy + cc.cam.f * yn * s, z


def closest_points(oa, da, ob, db):
    """Midpoints of the shortest segments between rays oa + s da and ob + t db (rows), and s, t."""
    w = oa - ob
    a, b, c = (da * da).sum(1), (da * db).sum(1), (db * db).sum(1)
    d, e = (da * w).sum(1), (db * w).sum(1)
    den = np.where(np.abs(a * c - b * b) < 1e-12, 1e-12, a * c - b * b)
    s = (b * e - c * d) / den
    t = (a * e - b * d) / den
    return (oa + s[:, None] * da + ob + t[:, None] * db) / 2, s, t


def match(img_a: np.ndarray, img_b: np.ndarray, ratio: float = 0.75, max_features: int = 40000):
    """Mutual-nearest SIFT matches passing Lowe's ratio test: (uv_a, uv_b) in each image's pixels."""
    sift = cv2.SIFT_create(nfeatures=max_features)
    gray = lambda im: cv2.cvtColor(im, cv2.COLOR_BGR2GRAY) if im.ndim == 3 else im  # noqa: E731
    ka, da = sift.detectAndCompute(gray(img_a), None)
    kb, db = sift.detectAndCompute(gray(img_b), None)
    if da is None or db is None:
        return np.zeros((0, 2)), np.zeros((0, 2))
    bf = cv2.BFMatcher(cv2.NORM_L2)
    ab = bf.knnMatch(da, db, k=2)
    ba = {m.queryIdx: m.trainIdx for m in bf.match(db, da)}
    good = [m for m, n in (p for p in ab if len(p) == 2) if m.distance < ratio * n.distance and ba.get(m.trainIdx) == m.queryIdx]
    uv_a = np.array([ka[m.queryIdx].pt for m in good], float).reshape(-1, 2)
    uv_b = np.array([kb[m.trainIdx].pt for m in good], float).reshape(-1, 2)
    return uv_a, uv_b


def triangulate_frames(img_a, ca: CalCam, img_b, cb: CalCam, max_err: float = 2.0):
    """3D points (court space) where the two frames agree, and each point's worse reprojection error in pixels."""
    uv_a, uv_b = match(img_a, img_b)
    if not len(uv_a):
        return np.zeros((0, 3)), np.zeros(0)
    X, s, t = closest_points(np.broadcast_to(ca.cam.C, uv_a.shape[:1] + (3,)), rays(ca, uv_a),
                             np.broadcast_to(cb.cam.C, uv_b.shape[:1] + (3,)), rays(cb, uv_b))
    ua, va, za = project(ca, X)
    ub, vb, zb = project(cb, X)
    err = np.maximum(np.hypot(ua - uv_a[:, 0], va - uv_a[:, 1]), np.hypot(ub - uv_b[:, 0], vb - uv_b[:, 1]))
    keep = (s > 0) & (t > 0) & (za > 0) & (zb > 0) & (err < max_err)
    return X[keep], err[keep]


def stands_planes(X, x_min: float = 14.0, y_split: float = 2.5, half_width: float = 9.6, top: float = 12.0,
                  min_upper: int = 30) -> tuple[list[dict], dict]:
    """The stands behind the far baseline as two proxy planes (format.ts: corners bottom-left, bottom-right, top-right,
    top-left as seen from the court; looking +x, left is -z), from the triangulated points beyond x_min:
      front  vertical, at the median depth of the points up to y_split (the courtside rows, photographers, the
             bench), floor to y_split, across the end (z +-half_width);
      upper  from y_split to `top`, its depth a line in height fitted to the points above y_split (the bowl rising
             back), or, with fewer than min_upper of them, vertical 1.5 m behind the front (said so in the report).
    Returns (planes, report)."""
    P = np.asarray(X, float)
    P = P[P[:, 0] > x_min]
    low, high = P[P[:, 1] <= y_split], P[P[:, 1] > y_split]
    if len(low) < 10:
        raise ValueError(f"stands: only {len(low)} triangulated points below {y_split} m behind the baseline")
    med = np.median(low[:, 0])
    mad = np.median(np.abs(low[:, 0] - med)) + 1e-6
    low = low[np.abs(low[:, 0] - med) < 4 * 1.4826 * mad]
    xf = float(np.median(low[:, 0]))
    rep = {"points": int(len(P)), "front": {"x": round(xf, 3), "n": int(len(low)), "rms": round(float(np.sqrt(np.mean((low[:, 0] - xf) ** 2))), 3)}}
    z0, z1 = -half_width, half_width
    front = [[xf, 0.0, z0], [xf, 0.0, z1], [xf, y_split, z1], [xf, y_split, z0]]
    if len(high) >= min_upper:
        A = np.stack([np.ones(len(high)), high[:, 1]], 1)
        (a, b), *_ = np.linalg.lstsq(A, high[:, 0], rcond=None)
        b = float(np.clip(b, 0.0, 2.0))  # stands only rise backwards, at most ~63 deg from vertical
        a = float(np.median(high[:, 0] - b * high[:, 1]))
        x_at = lambda y: a + b * y  # noqa: E731
        rep["upper"] = {"fit": True, "n": int(len(high)), "slope": round(b, 3), "rms": round(float(np.sqrt(np.mean((high[:, 0] - x_at(high[:, 1])) ** 2))), 3)}
    else:
        x_at = lambda y: xf + 1.5  # noqa: E731
        rep["upper"] = {"fit": False, "n": int(len(high))}
    upper = [[x_at(y_split), y_split, z0], [x_at(y_split), y_split, z1], [x_at(top), top, z1], [x_at(top), top, z0]]
    rnd = lambda q: [[round(float(v), 3) for v in p] for p in q]  # noqa: E731
    return [{"kind": "plane", "points": rnd(front)}, {"kind": "plane", "points": rnd(upper)}], rep
