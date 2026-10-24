"""Camera and placement maths for assemble.py (numpy only, no footage numbers in here).

Conventions (the court bundle's, apps/webxr/src/court/format.ts):
  court space : metres; origin centre court on the floor; +y up; +x toward the basket the play attacks; +z to the
                right when facing +x.
  cameras     : OpenCV axes (+x right, +y down, +z forward). `R` here is always WORLD-FROM-CAMERA (the bundle's `q`);
                the calibration files store camera-from-world (x_cam = R (X - C)), so they are transposed on read.
  quaternions : [x, y, z, w] (the bundle's order), unit, w >= 0.
  pixels      : pixel centres at whole numbers; principal point (W - 1) / 2, (H - 1) / 2 when centred.
"""

from __future__ import annotations

import bisect
import math
from dataclasses import dataclass

import numpy as np

UP = np.array([0.0, 1.0, 0.0])


# ---------------------------------------------------------------- rotations

def quat_to_matrix(q) -> np.ndarray:
    x, y, z, w = (float(v) for v in q)
    n = math.sqrt(x * x + y * y + z * z + w * w)
    x, y, z, w = x / n, y / n, z / n, w / n
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def matrix_to_quat(m) -> np.ndarray:
    """[x, y, z, w] of a rotation matrix, w >= 0."""
    m = np.asarray(m, float)
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        q = [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, s / 4]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [s / 4, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 1] + m[1, 0]) / s, s / 4, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, s / 4, (m[1, 0] - m[0, 1]) / s]
    q = np.array(q)
    q /= np.linalg.norm(q)
    return -q if q[3] < 0 else q


def slerp(q0, q1, t: float) -> np.ndarray:
    a, b = np.asarray(q0, float), np.asarray(q1, float)
    d = float(a @ b)
    if d < 0:
        b, d = -b, -d
    if d > 1 - 1e-12:
        q = a + t * (b - a)
    else:
        th = math.acos(d)
        q = (math.sin((1 - t) * th) * a + math.sin(t * th) * b) / math.sin(th)
    q = q / np.linalg.norm(q)
    return -q if q[3] < 0 else q


def rot_y(angle: float) -> np.ndarray:
    """Rotation about +y by `angle` radians (right-handed: +x turns toward -z)."""
    c, s = math.cos(angle), math.sin(angle)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def angle_deg(a, b) -> float:
    a, b = np.asarray(a, float), np.asarray(b, float)
    c = float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)))
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def quat_angle_deg(qa, qb) -> float:
    """The rotation between two quaternions [x, y, z, w] in degrees (exactly 0 for the same one)."""
    a, b = np.asarray(qa, float), np.asarray(qb, float)
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    if a @ b < 0:
        b = -b
    return math.degrees(4 * math.atan2(float(np.linalg.norm(a - b)), float(np.linalg.norm(a + b))))


def rot_angle_deg(ra, rb) -> float:
    c = (np.trace(np.asarray(ra) @ np.asarray(rb).T) - 1) / 2
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def kabsch(a, b) -> np.ndarray:
    """The rotation R minimising sum |R a_i - b_i|^2 (rows of a and b are matched vectors)."""
    h = np.asarray(a, float).T @ np.asarray(b, float)
    u, _, vt = np.linalg.svd(h)
    d = np.sign(np.linalg.det(vt.T @ u.T))
    return vt.T @ np.diag([1.0, 1.0, d]) @ u.T


# ---------------------------------------------------------------- cameras

@dataclass
class Cam:
    """A pinhole camera: centre C (court space), world-from-camera R, focal f and principal point, image w x h."""
    C: np.ndarray
    R: np.ndarray
    f: float
    cx: float
    cy: float
    w: int
    h: int

    @property
    def K(self) -> np.ndarray:
        return np.array([[self.f, 0, self.cx], [0, self.f, self.cy], [0, 0, 1.0]])

    @property
    def axis(self) -> np.ndarray:
        return self.R[:, 2]

    def to_cam(self, X) -> np.ndarray:
        return (np.asarray(X, float) - self.C) @ self.R  # R^T (X - C), row-wise

    def project(self, X):
        """(u, v, z): pixels and depth along the optical axis (z <= 0 behind the camera)."""
        c = self.to_cam(X)
        z = c[..., 2]
        zs = np.where(np.abs(z) < 1e-9, 1e-9, z)
        return self.cx + self.f * c[..., 0] / zs, self.cy + self.f * c[..., 1] / zs, z

    def rays(self, u, v) -> np.ndarray:
        """Unit world directions through pixels (u, v)."""
        d = np.stack([(np.asarray(u, float) - self.cx) / self.f, (np.asarray(v, float) - self.cy) / self.f,
                      np.ones(np.broadcast(u, v).shape)], -1)
        d = d @ self.R.T
        return d / np.linalg.norm(d, axis=-1, keepdims=True)

    def scaled(self, w: int) -> "Cam":
        s = w / self.w
        return Cam(self.C, self.R, self.f * s, (self.cx + 0.5) * s - 0.5, (self.cy + 0.5) * s - 0.5, w, round(self.h * s))


class CalibTrack:
    """A calibration's per-frame cameras by source frame (calib_A.json's layout: one C, per-frame R (camera-from-world),
    f, k1). `at(src)` gives the camera of any source frame; a fractional one gets the slerp of its two real
    neighbours' rotations and the interpolation of their focals, as the bake does. Frames outside the calibrated range
    are clamped to its ends and counted in `clamped`."""

    def __init__(self, calib: dict):
        self.size = tuple(int(x) for x in calib["image_size"])
        self.C = np.asarray(calib["C"], float)
        frames = sorted(calib["frames"], key=lambda fr: fr["source_frame"])
        self.src = [int(fr["source_frame"]) for fr in frames]
        self.q = [matrix_to_quat(np.asarray(fr["R"], float).T) for fr in frames]
        self.f = [float(fr["f"]) for fr in frames]
        self.k1 = [float(fr.get("k1", 0.0)) for fr in frames]
        self.clamped = 0
        # the calibration's own warnings: frames it interpolated or saw a strobe in, and its `flags` lists
        self.marks = {"interp": [[n, n] for n, fr in zip(self.src, frames) if str(fr.get("source", "")).endswith("interp")],
                      "strobe": [[n, n] for n, fr in zip(self.src, frames) if fr.get("strobe")]}
        for k, v in (calib.get("flags") or {}).items():
            self.marks[k] = [[int(x), int(x)] if isinstance(x, (int, float)) else [int(x[0]), int(x[-1])] for x in v]

    @property
    def range(self) -> tuple[int, int]:
        return self.src[0], self.src[-1]

    def flagged(self, lo: float, hi: float) -> dict:
        """The calibration's warnings for source frames lo..hi, each as merged [a, b] spans clipped to lo..hi; only
        the non-empty ones."""
        lo, hi = math.ceil(lo), math.floor(hi)
        out = {}
        for k, spans in self.marks.items():
            got: list[list[int]] = []
            for a, b in sorted(spans):
                a, b = max(a, lo), min(b, hi)
                if a > b:
                    continue
                if got and a <= got[-1][1] + 1:
                    got[-1][1] = max(got[-1][1], b)
                else:
                    got.append([a, b])
            if got:
                out[k] = got
        return out

    def has(self, src: float) -> bool:
        return self.src[0] <= src <= self.src[-1]

    def at(self, src: float) -> tuple[np.ndarray, float]:
        """(q world-from-camera [x, y, z, w], f) at source frame `src`."""
        if src <= self.src[0] or src >= self.src[-1]:
            if not self.has(src):
                self.clamped += 1
            i = 0 if src <= self.src[0] else len(self.src) - 1
            return self.q[i], self.f[i]
        j = bisect.bisect_left(self.src, src)
        if self.src[j] == src:
            return self.q[j], self.f[j]
        i = j - 1
        t = (src - self.src[i]) / (self.src[j] - self.src[i])
        return slerp(self.q[i], self.q[j], t), self.f[i] + t * (self.f[j] - self.f[i])

    def cam(self, src: float) -> Cam:
        q, f = self.at(src)
        w, h = self.size
        return Cam(self.C, quat_to_matrix(q), f, (w - 1) / 2, (h - 1) / 2, w, h)


# ---------------------------------------------------------------- placement (recon / stand-in space -> court space)

@dataclass
class Similarity:
    """X_court = s M X + t."""
    s: float
    M: np.ndarray
    t: np.ndarray

    def apply(self, X) -> np.ndarray:
        return self.s * (np.asarray(X, float) @ self.M.T) + self.t

    def as_json(self) -> dict:
        return {"scale": round(self.s, 6), "rotation": np.round(self.M, 8).tolist(), "translation": np.round(self.t, 6).tolist()}


def pixel_grid_rotation(src: Cam, dst: Cam, n: int = 9) -> np.ndarray:
    """The rotation Q taking src's camera-frame rays onto dst's for the same pixels (Kabsch over an n x n grid of the
    image). Exact when the two differ only by a rotation; with a shifted principal point (a crop of a wider frame)
    it is the best rotation, within ~1 px over a narrow crop."""
    u, v = np.meshgrid(np.linspace(0, src.w - 1, n), np.linspace(0, src.h - 1, n))
    u, v = u.ravel(), v.ravel()
    a = np.stack([(u - src.cx) / src.f, (v - src.cy) / src.f, np.ones_like(u)], 1)
    b = np.stack([(u - dst.cx) / dst.f, (v - dst.cy) / dst.f, np.ones_like(u)], 1)
    a /= np.linalg.norm(a, axis=1, keepdims=True)
    b /= np.linalg.norm(b, axis=1, keepdims=True)
    return kabsch(a, b)


def place_by_camera(points, src: Cam, dst: Cam, contact_pct: float = 0.5) -> tuple[Similarity, dict]:
    """Map a reconstruction onto the court so it looks exactly as it did from its own solved source camera `src`
    from the court's camera `dst` (same image: the player's crop), and scale it along those rays until its lowest
    points (the `contact_pct` percentile, the soles) touch y = 0. Returns the similarity and its diagnostics:
    `scale` (1 = the reconstruction's own size), `tilt_deg` (the reconstruction's up vs the court's)."""
    P = np.asarray(points, float)
    Q = pixel_grid_rotation(src, dst)
    M = dst.R @ Q @ src.R.T
    a = (P - src.C) @ M.T
    lo = float(np.percentile(a[:, 1], contact_pct))
    if lo >= -1e-6:
        raise ValueError("place_by_camera: the camera is not above the body's lowest points")
    s = -dst.C[1] / lo
    sim = Similarity(s, M, dst.C - s * (M @ src.C))
    return sim, {"mode": "camera", "scale": s, "tilt_deg": angle_deg(M @ UP, UP)}


def contact_points(points, band: float = 0.04, pct: float = 0.5) -> np.ndarray:
    """The soles: points within `band` m of the lowest level (its `pct` percentile), y up."""
    P = np.asarray(points, float)
    lo = np.percentile(P[:, 1], pct)
    return P[P[:, 1] <= lo + band]


def place_by_feet(points, src_camera_pos, foot_xz, dst_camera_pos, scale: float = 1.0) -> tuple[Similarity, dict]:
    """Stand a y-up reconstruction on the court: turned about +y so the camera it was seen from lies the same way
    from it as the court camera does from `foot_xz`, its soles' centre on `foot_xz` and its lowest level on y = 0."""
    P = np.asarray(points, float)
    feet = contact_points(P)
    fc = feet.mean(0)
    lo = float(np.percentile(P[:, 1], 0.5))
    b_src = np.asarray(src_camera_pos, float) - fc
    b_dst = np.asarray(dst_camera_pos, float) - np.array([foot_xz[0], 0.0, foot_xz[1]])
    yaw = math.atan2(b_dst[0], b_dst[2]) - math.atan2(b_src[0], b_src[2])
    M = rot_y(yaw)
    t = np.array([foot_xz[0], 0.0, foot_xz[1]]) - scale * (M @ np.array([fc[0], lo, fc[2]]))
    return Similarity(scale, M, t), {"mode": "feet", "scale": scale, "yaw_deg": math.degrees(yaw)}


# ---------------------------------------------------------------- the seat and the viewing spots (Decision W)

def box_distance_xz(p, bounds) -> float:
    lo, hi = bounds
    return math.hypot(max(lo[0] - p[0], 0, p[0] - hi[0]), max(lo[2] - p[2], 0, p[2] - hi[2]))


def viewing_spots(pair_centre, camera_centre, bounds_list, clear: float, angles=(0, -60, 60), r0: float = 1.5,
                  margin: float = 0.05) -> list[list[float]]:
    """Front (toward the camera) and `angles` degrees to either side of it, all at one radius from the pair's centre:
    the smallest from r0 up that keeps every spot `clear` + margin metres from every body's bounds (P29)."""
    pc = np.asarray(pair_centre, float)
    to_cam = np.asarray(camera_centre, float) - pc
    to_cam[1] = 0
    to_cam /= np.linalg.norm(to_cam)

    def spot(deg, r):
        d = rot_y(math.radians(deg)) @ to_cam
        return [pc[0] + d[0] * r, 0.0, pc[2] + d[2] * r]

    r = r0
    while any(box_distance_xz(spot(a, r), b) < clear + margin for a in angles for b in bounds_list):
        r += 0.05
        if r > 10:
            raise ValueError("viewing_spots: no radius under 10 m clears the bodies")
    return [[round(x, 3) for x in spot(a, r)] for a in angles]


# ---------------------------------------------------------------- rays

def triangulate(origins, dirs) -> tuple[np.ndarray, float]:
    """Least-squares point nearest a set of rays; returns it and the rms distance to the rays."""
    A = np.zeros((3, 3))
    b = np.zeros(3)
    for o, d in zip(origins, dirs):
        d = np.asarray(d, float) / np.linalg.norm(d)
        P = np.eye(3) - np.outer(d, d)
        A += P
        b += P @ np.asarray(o, float)
    X = np.linalg.solve(A, b)
    res = [np.linalg.norm((np.eye(3) - np.outer(d, d) / (d @ d)) @ (X - o)) for o, d in zip(origins, dirs)]
    return X, float(np.sqrt(np.mean(np.square(res))))
