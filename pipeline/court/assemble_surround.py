"""The arena round the footage (court.json `surround`, apps/webxr/src/court/format.ts): the pan's mosaic as one pinhole
image that shares camera F's centre and rotation (`far`, real: everything the broadcast camera filmed at the far end,
people removed), and tiles of that crowd resampled to one scale (`crowd`, imagined: laid on a seating bowl the camera
never saw). numpy and OpenCV only.

    python3 -I pipeline/court/assemble_surround.py --config <private json> --bundle <an assembled bundle dir>

adds a surround to a bundle that is already assembled; assemble.py makes the same step when its config has `surround`.

Config (private, never in git: the rects and every number about the footage live there):
  canvas        the layers' canvas pinhole (K, R: x_cam = R (X - C); the stitched pan's own registration)
  cams          the layers' per-frame registration (frames[src].R, f; k1; at 1080p, cx 959.5, cy 539.5)
  mosaic, cover the stitched pan (RGB, people removed) and how many frames saw each pixel (0 = never filmed)
  calib         (or the assemble config's) the calibration whose k1 undoes the show's lens (xn -> xn (1 + k1 r^2))
  maxWidth      the far image's widest side (default 4096)
  feather       alpha ramp inside the covered edge, px (default 8)
  crowd         {tiles: [[x0, y0, x1, y1] in mosaic px, ...], pxPerM (default 200), atlas: [maxW, maxH]}
  freezeCleanAlpha  optional: the clean plate's replaced-pixel map (255 = replaced), to score only untouched pixels
  check         folder for the alignment check image

The two cameras. The mosaic is a lens-free pinhole (the canvas) whose pixels relate to the raw frame of F through the
layers' registration (cams.json: R, f, k1). The bundle's pictures of F are the same raw frame resampled onto a pinhole
by the show's own lens (calibration k1, bundle f), so a far pixel's tangent n goes
    n -> raw 4K = c + f_b n (1 + k1_show |n|^2) -> raw 1080p (u4k = 2u + 0.5) -> tangent (undo cams' lens) -> canvas px
and the far image is exactly aligned with video.freezeClean wherever F sees. Centres are never mixed: the layers'
canvas has an older centre, so it is only used for 2D maps, never for 3D.
"""

from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cv2
import numpy as np

cv2.setNumThreads(2)  # a shared Mac

import assemble_geom as geo  # noqa: E402
from assemble_stands import undistort  # noqa: E402

MAX_WIDTH = 4096
FEATHER_PX = 8
PX_PER_M = 200.0
ATLAS_MAX = (4096, 2048)
GUTTER = 4  # replicated edge pixels round each tile, so bilinear filtering never reads a neighbour
JPEG_Q = 90


def distort(xn, yn, k1: float):
    s = 1 + k1 * (xn * xn + yn * yn)
    return xn * s, yn * s


# ---------------------------------------------------------------- the canvas <-> camera F's pinhole picture

class Chain:
    """Maps between canvas pixels and the tangent n = (x/z, y/z) of camera F's pinhole picture.

    canvas: K (f0, principal point) and R (x_cam = R (X - C)); frame: the layers' registration of F (R, f, k1, centre,
    at 1080p); show: the bundle's picture of F (focal `f_b` at width `w_b`, centre, and the lens it was undistorted
    with, k1)."""

    def __init__(self, canvas: dict, frame_R, frame_f: float, frame_k1: float, show_f: float, show_k1: float,
                 show_cx: float, show_cy: float, frame_cx: float = 959.5, frame_cy: float = 539.5, scale: float = 2.0):
        K = np.asarray(canvas["K"], float)
        self.f0, self.c0 = float(K[0, 0]), (float(K[0, 2]), float(K[1, 2]))
        self.Rc = np.asarray(canvas["R"], float)
        self.Rf = np.asarray(frame_R, float)
        self.ff, self.k1f = float(frame_f), float(frame_k1)
        self.cf = (float(frame_cx), float(frame_cy))
        self.fb, self.k1s = float(show_f), float(show_k1)
        self.cb = (float(show_cx), float(show_cy))
        self.scale = float(scale)  # show pixels per frame pixel: u_show = scale u + (scale - 1) / 2

    def _show_of_frame(self, u, v):
        o = (self.scale - 1.0) / 2.0
        return self.scale * u + o, self.scale * v + o

    def _frame_of_show(self, u, v):
        o = (self.scale - 1.0) / 2.0
        return (u - o) / self.scale, (v - o) / self.scale

    def tangent_to_canvas(self, nx, ny):
        """Canvas pixels of the pinhole picture's tangents (the picture's lens-free axes)."""
        dx, dy = distort(np.asarray(nx, float), np.asarray(ny, float), self.k1s)
        ru, rv = self._frame_of_show(self.cb[0] + self.fb * dx, self.cb[1] + self.fb * dy)
        tx, ty = undistort((ru - self.cf[0]) / self.ff, (rv - self.cf[1]) / self.ff, self.k1f)
        x = np.stack([tx, ty, np.ones_like(tx)], -1) @ self.Rf  # R_f^T [t, 1]: the world ray of the registration
        y = x @ self.Rc.T
        return self.f0 * y[..., 0] / y[..., 2] + self.c0[0], self.f0 * y[..., 1] / y[..., 2] + self.c0[1]

    def canvas_to_tangent(self, cu, cv_):
        """The pinhole picture's tangents of canvas pixels."""
        cu, cv_ = np.asarray(cu, float), np.asarray(cv_, float)
        d = np.stack([(cu - self.c0[0]) / self.f0, (cv_ - self.c0[1]) / self.f0, np.ones_like(cu)], -1) @ self.Rc
        x = d @ self.Rf.T
        tx, ty = x[..., 0] / x[..., 2], x[..., 1] / x[..., 2]
        xd, yd = distort(tx, ty, self.k1f)
        ru, rv = self.cf[0] + self.ff * xd, self.cf[1] + self.ff * yd
        su, sv = self._show_of_frame(ru, rv)
        return undistort((su - self.cb[0]) / self.fb, (sv - self.cb[1]) / self.fb, self.k1s)


# ---------------------------------------------------------------- the far image

def far_geometry(chain: Chain, cover: np.ndarray, max_width: int = MAX_WIDTH, margin: int = 4, stride: int = 6):
    """Intrinsics (f, cx, cy, width, height) of the far pinhole picture holding every covered canvas pixel in at most
    `max_width` px, at the mosaic's own sharpness where that fits (one far pixel = one canvas pixel at the middle)."""
    h, w = cover.shape
    ys, xs = np.nonzero(cover[::stride, ::stride] > 0)
    cu, cv_ = xs * stride, ys * stride
    nx, ny = chain.canvas_to_tangent(cu.astype(float), cv_.astype(float))
    lo, hi = np.array([nx.min(), ny.min()]), np.array([nx.max(), ny.max()])
    # native: a far pixel as large as a canvas pixel at the middle of the covered area
    mx, my = chain.canvas_to_tangent(np.array([w / 2 - 1.0, w / 2 + 1.0]), np.array([h / 2, h / 2]))
    native = 2.0 / float(mx[1] - mx[0])
    room = max_width - 2 * margin
    f = min(native, room / float(hi[0] - lo[0]), (max_width - 2 * margin) / float(hi[1] - lo[1]))
    cx, cy = margin - lo[0] * f, margin - lo[1] * f
    return {"f": float(f), "cx": float(cx), "cy": float(cy), "width": int(math.ceil(hi[0] * f + cx + margin)),
            "height": int(math.ceil(hi[1] * f + cy + margin))}


def far_maps(chain: Chain, g: dict):
    """cv2.remap maps: for every far pixel, the canvas pixel to sample."""
    u, v = np.meshgrid(np.arange(g["width"], dtype=np.float64), np.arange(g["height"], dtype=np.float64))
    cu, cv_ = chain.tangent_to_canvas((u - g["cx"]) / g["f"], (v - g["cy"]) / g["f"])
    return cu.astype(np.float32), cv_.astype(np.float32)


def feather_alpha(covered: np.ndarray, px: float = FEATHER_PX) -> np.ndarray:
    """8-bit alpha: 255 deeper than `px` inside the covered area, 0 outside it (and past the image's own edge, where
    nothing was filmed either), a linear ramp over the last `px` pixels."""
    pad = int(math.ceil(px)) + 1
    m = cv2.copyMakeBorder(covered.astype(np.uint8), pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)
    dist = cv2.distanceTransform(m, cv2.DIST_L2, 5)[pad:-pad, pad:-pad]
    return np.clip(np.round(dist / px * 255.0), 0, 255).astype(np.uint8)


def extend_colour(img: np.ndarray, covered: np.ndarray, reach: int = 24) -> np.ndarray:
    """Spread the covered colours `reach` px outward over the uncovered side, so the feathered edge (and JPEG's
    ringing) blends into picture rather than black."""
    out = img.copy()
    todo = ~covered
    have = covered.copy()
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    for _ in range(reach):
        grow = cv2.dilate(have.astype(np.uint8), k) > 0
        new = grow & ~have
        if not new.any():
            break
        num = cv2.blur(np.where(have[..., None], out, 0).astype(np.float32), (3, 3))
        den = cv2.blur(have.astype(np.float32), (3, 3))[..., None]
        out[new] = (num / np.maximum(den, 1e-6))[new].astype(np.uint8)
        have |= new
    out[todo & ~have] = 0
    return out


def build_far(chain: Chain, mosaic: np.ndarray, cover: np.ndarray, max_width: int = MAX_WIDTH, feather: float = FEATHER_PX) -> dict:
    """The far picture: {image (BGR), alpha, f, cx, cy, width, height} of the mosaic as camera F's pinhole picture
    (all-uncovered rows and columns dropped)."""
    g = far_geometry(chain, cover, max_width)
    mu, mv = far_maps(chain, g)
    img = cv2.remap(mosaic, mu, mv, cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    cov = cv2.remap((cover > 0).astype(np.float32), mu, mv, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0) > 0.999
    cols, rows = np.nonzero(cov.any(0))[0], np.nonzero(cov.any(1))[0]
    x0, x1, y0, y1 = int(cols[0]), int(cols[-1]) + 1, int(rows[0]), int(rows[-1]) + 1
    img, cov = img[y0:y1, x0:x1], cov[y0:y1, x0:x1]
    alpha = feather_alpha(cov, feather)
    img = extend_colour(img, cov)
    return {"image": img, "alpha": alpha, "f": g["f"], "cx": g["cx"] - x0, "cy": g["cy"] - y0,
            "width": x1 - x0, "height": y1 - y0, "covered": float(cov.mean())}


# ---------------------------------------------------------------- the alignment check

def render_far_in_f(far: dict, cam: dict) -> tuple[np.ndarray, np.ndarray]:
    """The far picture seen through camera F's own pinhole (cam: f, cx, cy, width, height): both pictures share centre
    and rotation, so this is a scale and a shift. Returns (BGR, alpha)."""
    s = far["f"] / cam["f"]
    M = np.array([[s, 0.0, far["cx"] - s * cam["cx"]], [0.0, s, far["cy"] - s * cam["cy"]]])
    size = (int(cam["width"]), int(cam["height"]))
    flags = cv2.INTER_CUBIC | cv2.WARP_INVERSE_MAP
    img = cv2.warpAffine(far["image"], M, size, flags=flags, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    a = cv2.warpAffine(far["alpha"], M, size, flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    return img, a


def feature_offset(a: np.ndarray, b: np.ndarray, mask: np.ndarray, ratio: float = 0.8) -> dict:
    """Where b's features sit against a's: SIFT matches (Lowe ratio) inside `mask`, then RANSAC on a similarity; the
    median displacement (b - a) of the inliers, their spread about it (rms, px), and the median on the left and right
    halves of the picture (a scale error shows as opposite signs)."""
    sift = cv2.SIFT_create(8000)
    ka, da = sift.detectAndCompute(a, mask)
    kb, db = sift.detectAndCompute(b, mask)
    if da is None or db is None or len(ka) < 8 or len(kb) < 8:
        return {"matches": 0}
    pairs = cv2.BFMatcher().knnMatch(da, db, k=2)
    good = [p[0] for p in pairs if len(p) == 2 and p[0].distance < ratio * p[1].distance]
    if len(good) < 8:
        return {"matches": len(good)}
    pa = np.float32([ka[m.queryIdx].pt for m in good])
    pb = np.float32([kb[m.trainIdx].pt for m in good])
    _, inl = cv2.estimateAffinePartial2D(pa, pb, ransacReprojThreshold=2.0)
    keep = inl.ravel() > 0
    d = (pb - pa)[keep]
    if len(d) < 8:
        return {"matches": len(good), "inliers": int(keep.sum())}
    med = np.median(d, 0)
    half = pa[keep][:, 0] < a.shape[1] / 2
    side = lambda sel: [round(float(v), 3) for v in np.median(d[sel], 0)] if sel.sum() >= 5 else None  # noqa: E731
    return {"matches": len(good), "inliers": int(keep.sum()), "dx": round(float(med[0]), 3), "dy": round(float(med[1]), 3),
            "rmsPx": round(float(np.sqrt(((d - med) ** 2).sum(1).mean())), 3), "left": side(half), "right": side(~half)}


def psnr(a: np.ndarray, b: np.ndarray, mask: np.ndarray) -> float:
    d = (a.astype(np.float64) - b.astype(np.float64))[mask]
    mse = float((d * d).mean()) if d.size else float("nan")
    return float(10 * math.log10(255.0 ** 2 / mse)) if mse > 0 else float("inf")


def gain_matched(a: np.ndarray, b: np.ndarray, mask: np.ndarray, rounds: int = 3, keep: float = 0.6) -> np.ndarray:
    """b with a per-channel gain and offset fitted to a over the mask, refitted on the `keep` share that agrees best
    (people, a moved fan and the LED boards must not set the colour)."""
    out = b.astype(np.float64).copy()
    idx = np.nonzero(mask.ravel())[0][::7]
    for c in range(3):
        x, y = b[..., c].ravel()[idx].astype(np.float64), a[..., c].ravel()[idx].astype(np.float64)
        sel = np.ones(len(x), bool)
        for _ in range(rounds):
            g, o = np.polyfit(x[sel], y[sel], 1)
            r = np.abs(g * x + o - y)
            sel = r <= max(float(np.quantile(r, keep)), 0.5)  # (half a grey level: an exact fit leaves nothing under the quantile)
        out[..., c] = g * out[..., c] + o
    return np.clip(out, 0, 255)


def alignment(far: dict, cam: dict, clean: np.ndarray, replaced: np.ndarray | None = None) -> dict:
    """Far picture vs video.freezeClean where both are valid: PSNR (gain-matched, since the show's colours are decoded
    fuller than the mosaic's; and over the 80% of pixels that agree best, since fans move between frames and off-court
    staff stay in the plate), and the features' offset in 1080p pixels. `replaced` (255 = the clean plate's own fill)
    restricts the score to pixels the plate took from the live frame."""
    ren, alpha = render_far_in_f(far, cam)
    valid = cv2.erode((alpha >= 255).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    if replaced is not None:
        valid &= cv2.dilate((replaced > 0).astype(np.uint8), np.ones((9, 9), np.uint8)) == 0
    gm = gain_matched(clean, ren, valid)
    err = np.abs(clean.astype(np.float32) - gm.astype(np.float32)).mean(-1)
    best = valid & (err <= np.percentile(err[valid], 80))
    out = {"validFraction": round(float(valid.mean()), 4), "psnr": round(psnr(clean, ren, valid), 2),
           "psnrGain": round(psnr(clean, gm, valid), 2), "psnrGainBest80": round(psnr(clean, gm, best), 2)}
    half = (clean.shape[1] // 2, clean.shape[0] // 2)
    g = lambda x: cv2.cvtColor(cv2.resize(x, half, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)  # noqa: E731
    m = cv2.resize(valid.astype(np.uint8), half, interpolation=cv2.INTER_NEAREST)
    out["features"] = feature_offset(g(clean), g(ren), m)
    out["_render"], out["_valid"] = ren, valid
    return out


def check_image(clean: np.ndarray, ren: np.ndarray, valid: np.ndarray, width: int = 3300) -> np.ndarray:
    """Left: the clean plate, middle: the far picture through F, right: their edges (red = the plate, green = far; yellow
    where they agree) over the valid area."""
    s = width / (3 * clean.shape[1])  # three panels side by side
    sm = lambda x: cv2.resize(x, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)  # noqa: E731
    a, b = sm(clean), sm(ren)
    def edges(x):
        g = cv2.cvtColor(x, cv2.COLOR_BGR2GRAY)
        e = cv2.Canny(cv2.GaussianBlur(g, (0, 0), 1.0), 40, 110)
        return e > 0
    ea, eb = edges(a), edges(b)
    ov = (np.asarray(a, np.float32) * 0.35).astype(np.uint8)
    ov[ea] = (0, 0, 255)
    ov[eb] = (0, 255, 0)
    ov[ea & eb] = (0, 255, 255)
    inv = cv2.resize(valid.astype(np.uint8), (a.shape[1], a.shape[0]), interpolation=cv2.INTER_NEAREST) == 0
    ov[inv] = (ov[inv] * 0.3).astype(np.uint8)
    return np.hstack([a, b, ov])


# ---------------------------------------------------------------- the crowd

def plane_for(point_y: float, planes: list[dict]) -> dict:
    """The stands proxy plane (a vertical wall x = const) a hit at height `point_y` belongs to: the one whose height
    range holds it, else the nearest one."""
    best, bd = None, 1e9
    for p in planes:
        pts = np.asarray(p["points"], float)
        lo, hi = float(pts[:, 1].min()), float(pts[:, 1].max())
        d = 0.0 if lo <= point_y <= hi else min(abs(point_y - lo), abs(point_y - hi))
        if d < bd:
            best, bd = p, d
    return best


def hit_wall(C, d, x: float) -> np.ndarray | None:
    """Where the ray C + s d meets the wall x = const (None behind or parallel)."""
    d = np.asarray(d, float)
    if abs(d[..., 0]) < 1e-9:
        return None
    s = (x - C[0]) / d[..., 0]
    return None if s <= 0 else np.asarray(C, float) + s * d


class Sight:
    """Camera F as the bundle has it (centre, world-from-camera R) with the chain to the mosaic: rays out of canvas
    pixels, and the canvas pixel of any court point."""

    def __init__(self, chain: Chain, C, R):
        self.chain, self.C, self.R = chain, np.asarray(C, float), np.asarray(R, float)

    def ray(self, cu: float, cv_: float) -> np.ndarray:
        nx, ny = self.chain.canvas_to_tangent(np.array([cu]), np.array([cv_]))
        d = self.R @ np.array([nx[0], ny[0], 1.0])
        return d / np.linalg.norm(d)

    def canvas_of(self, X) -> tuple[np.ndarray, np.ndarray]:
        c = (np.asarray(X, float) - self.C) @ self.R
        return self.chain.tangent_to_canvas(c[..., 0] / c[..., 2], c[..., 1] / c[..., 2])


def tile_scale(sight: Sight, planes: list[dict], cu: float, cv_: float) -> dict:
    """Where the ray through canvas pixel (cu, cv_) meets the stands, and how many metres a canvas pixel spans there
    (across, along the wall's z; up, along y), by the neighbouring pixels' rays."""
    d = sight.ray(cu, cv_)
    h0 = hit_wall(sight.C, d, float(np.asarray(planes[0]["points"], float)[0, 0]))
    plane = plane_for(h0[1] if h0 is not None else 0.0, planes)
    x = float(np.asarray(plane["points"], float)[0, 0])
    hit = hit_wall(sight.C, d, x)
    if hit is None:
        raise ValueError(f"the ray through canvas pixel ({cu:.0f}, {cv_:.0f}) never meets the stands")
    hx = [hit_wall(sight.C, sight.ray(cu + e, cv_), x) for e in (-1.0, 1.0)]
    hy = [hit_wall(sight.C, sight.ray(cu, cv_ + e), x) for e in (-1.0, 1.0)]
    return {"hit": hit, "x": x, "mPerPxAcross": abs(float(hx[1][2] - hx[0][2])) / 2.0,
            "mPerPxUp": abs(float(hy[1][1] - hy[0][1])) / 2.0}


def rectified_tile(mosaic: np.ndarray, sight: Sight, planes: list[dict], rect, px_per_m: float) -> tuple[np.ndarray, dict]:
    """A mosaic rect laid flat on the stands' wall at `px_per_m` atlas pixels per metre: each tile pixel is a point of the
    wall (z across, y up), found in the mosaic through camera F. Size from the rect's width and height in metres."""
    x0, y0, x1, y1 = rect
    cu, cv_ = (x0 + x1 - 1) / 2.0, (y0 + y1 - 1) / 2.0
    sc = tile_scale(sight, planes, cu, cv_)
    w_m, h_m = (x1 - x0) * sc["mPerPxAcross"], (y1 - y0) * sc["mPerPxUp"]
    W, H = max(8, int(round(w_m * px_per_m))), max(8, int(round(h_m * px_per_m)))
    a, b = np.meshgrid(np.arange(W, dtype=np.float64), np.arange(H, dtype=np.float64))
    P = np.stack([np.full_like(a, sc["x"]), sc["hit"][1] - (b - (H - 1) / 2) / px_per_m, sc["hit"][2] + (a - (W - 1) / 2) / px_per_m], -1)
    mu, mv = sight.canvas_of(P)
    # sampled finer than the atlas: low-pass the source first (sigma of half the shrink) so it doesn't alias
    shrink = 1.0 / (0.5 * (sc["mPerPxAcross"] + sc["mPerPxUp"]) * px_per_m)
    pad = int(math.ceil(3 * max(shrink, 1.0))) + 4
    cx0, cy0 = max(0, int(math.floor(mu.min())) - pad), max(0, int(math.floor(mv.min())) - pad)
    cx1, cy1 = min(mosaic.shape[1], int(math.ceil(mu.max())) + pad), min(mosaic.shape[0], int(math.ceil(mv.max())) + pad)
    src = mosaic[cy0:cy1, cx0:cx1]
    if shrink > 1.0:
        src = cv2.GaussianBlur(src, (0, 0), 0.5 * shrink)
    tile = cv2.remap(src, (mu - cx0).astype(np.float32), (mv - cy0).astype(np.float32), cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    return tile, {"mPerPxAcross": sc["mPerPxAcross"], "mPerPxUp": sc["mPerPxUp"], "widthM": w_m, "heightM": h_m}


def shelves(sizes: list, width: int, gutter: int) -> tuple[list, int] | None:
    """Shelf layout (tallest first, then left to right) of (h, w) tiles in an atlas `width` wide: ([x, y] corners of the
    tiles' padded cells in their own order, height used); None when a tile is wider than the atlas."""
    cells: list = [None] * len(sizes)
    x = y = shelf = 0
    for i in sorted(range(len(sizes)), key=lambda i: -sizes[i][0]):
        h, w = sizes[i][0] + 2 * gutter, sizes[i][1] + 2 * gutter
        if w > width:
            return None
        if x + w > width:
            x, y, shelf = 0, y + shelf, 0
        cells[i] = [x, y]
        x += w
        shelf = max(shelf, h)
    return cells, y + shelf


def pack(tiles: list[np.ndarray], limit=ATLAS_MAX, gutter: int = GUTTER) -> tuple[np.ndarray, list[list[int]]]:
    """Shelf-pack the tiles into one atlas no larger than `limit` (least area, not a sliver), `gutter`
    replicated pixels round each; returns (atlas, [[x0, y0, x1, y1]] in the tiles' own order). Raises when they don't fit."""
    maxw, maxh = limit
    sizes = [t.shape[:2] for t in tiles]
    best = None
    for width in range(512, maxw + 1, 256):
        got = shelves(sizes, width, gutter)
        if got is None or got[1] > maxh:
            continue
        score = width * got[1] * (1 + 0.25 * math.log2(max(width / got[1], got[1] / width)))  # least area, and not a sliver
        if best is None or score < best[3]:
            best = (width, got[0], got[1], score)
    if best is None:
        raise ValueError(f"the crowd tiles don't fit a {maxw}x{maxh} atlas: lower pxPerM or cut a tile")
    width, cells, height, _ = best
    atlas = np.zeros((height, width, 3), np.uint8)
    boxes = []
    for t, (x, y) in zip(tiles, cells):
        h, w = t.shape[:2]
        atlas[y:y + h + 2 * gutter, x:x + w + 2 * gutter] = cv2.copyMakeBorder(t, gutter, gutter, gutter, gutter, cv2.BORDER_REPLICATE)
        boxes.append([x + gutter, y + gutter, x + gutter + w, y + gutter + h])
    return atlas, boxes


def build_crowd(mosaic: np.ndarray, sight: Sight, planes: list[dict], rects: list, px_per_m: float = PX_PER_M, limit=ATLAS_MAX) -> dict:
    tiles, info = [], []
    for r in rects:
        t, i = rectified_tile(mosaic, sight, planes, r, px_per_m)
        tiles.append(t)
        info.append(i)
    atlas, boxes = pack(tiles, limit)
    return {"atlas": atlas, "tiles": boxes, "width": int(atlas.shape[1]), "height": int(atlas.shape[0]), "pxPerM": float(px_per_m), "info": info}


# ---------------------------------------------------------------- the bundle step

def expand(p) -> Path:
    return Path(os.path.expanduser(str(p)))


def scaled_camera(cam: dict, width: int) -> dict:
    """The same camera for a picture of another width (same aspect), pixel centres on pixel centres (camera.ts `scaled`)."""
    k = width / cam["width"]
    return {"f": cam["f"] * k, "cx": (cam["cx"] + 0.5) * k - 0.5, "cy": (cam["cy"] + 0.5) * k - 0.5, "width": width,
            "height": int(round(cam["height"] * k))}


def camera_f(court_camera: dict, frame: dict) -> dict:
    return {"f": float(frame["f"]), "cx": float(court_camera["cx"]), "cy": float(court_camera["cy"]),
            "width": int(court_camera["width"]), "height": int(court_camera["height"])}


def f_show_frame(video: dict) -> int:
    """The show frame of the freeze F: the second frame of the first ease (it holds F for all of them)."""
    return int(video["segments"]["eases"][0]["frames"][1])


def make_surround(w, cfg: dict, court_camera: dict, video: dict, frames: list, stands: dict, k1_show: float | None) -> dict:
    """Write surround/far.jpg, far-alpha.png and crowd.jpg into the bundle `w` (a Writer) and return court.json's
    `surround` block; record the pieces and the numbers on `w`. `cfg` is the config's `surround` block."""
    sc = cfg
    if sc.get("k1Show", k1_show) is None:
        raise ValueError("surround: the show's lens is unknown: the config needs `calib` (its k1 at the freeze) or `k1Show`")
    k1_show = float(sc.get("k1Show", k1_show))
    shown = f_show_frame(video)
    frame = frames[shown]
    src = int(video["freezeSource"])
    if int(round(frame["src"])) != src:
        raise ValueError(f"show frame {shown} is source frame {frame['src']}, not the freeze's {src}")
    canvas = json.loads(expand(sc["canvas"]).read_text())
    cams = json.loads(expand(sc["cams"]).read_text())
    fr = cams["frames"][str(src)]
    cam = camera_f(court_camera, frame)
    chain = Chain(canvas, fr["R"], fr["f"], cams["k1"], cam["f"], k1_show, cam["cx"], cam["cy"], cams.get("cx", 959.5), cams.get("cy", 539.5),
                  court_camera["width"] / float(cams["size"][0]))
    mosaic = cv2.imread(str(expand(sc["mosaic"])), cv2.IMREAD_COLOR)
    cover = cv2.imread(str(expand(sc["cover"])), cv2.IMREAD_UNCHANGED)
    if mosaic is None or cover is None or mosaic.shape[:2] != cover.shape[:2]:
        raise ValueError("surround: the mosaic and its cover must be readable images of one size")
    far = build_far(chain, mosaic, cover, int(sc.get("maxWidth", MAX_WIDTH)), float(sc.get("feather", FEATHER_PX)))
    out = w.path("surround/far.jpg")
    cv2.imwrite(str(out), far["image"], [cv2.IMWRITE_JPEG_QUALITY, JPEG_Q])
    cv2.imwrite(str(w.path("surround/far-alpha.png")), far["alpha"])
    block = {"far": {"image": "surround/far.jpg", "alpha": "surround/far-alpha.png", "frame": shown, "f": round(far["f"], 3),
                     "cx": round(far["cx"], 3), "cy": round(far["cy"], 3), "width": far["width"], "height": far["height"]}}
    # the gate: the far picture through F's own camera against the layers' clean plate of F
    clean_rel = video.get("freezeClean")
    detail = f"{expand(sc['mosaic'])}: the pan's stitched mosaic (people removed) as camera F's pinhole picture"
    extra = {"width": far["width"], "height": far["height"], "covered": round(far["covered"], 4)}
    clean = cv2.imread(str(w.root / clean_rel), cv2.IMREAD_COLOR) if clean_rel and (w.root / clean_rel).exists() else None
    if clean is None:
        w.notes.append("surround.far: the bundle has no clean plate of F: the alignment check was not run")
    else:
        repl = cv2.imread(str(expand(sc["freezeCleanAlpha"])), cv2.IMREAD_GRAYSCALE) if sc.get("freezeCleanAlpha") else None
        if repl is not None and repl.shape != clean.shape[:2]:
            repl = cv2.resize(repl, (clean.shape[1], clean.shape[0]), interpolation=cv2.INTER_NEAREST)
        al = alignment(far, scaled_camera(cam, clean.shape[1]), clean, repl)
        ren, valid = al.pop("_render"), al.pop("_valid")
        shot = expand(sc["check"]) / "far-check.jpg" if sc.get("check") else None
        if shot is not None:
            shot.parent.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(shot), check_image(clean, ren, valid), [cv2.IMWRITE_JPEG_QUALITY, 88])
        extra["alignment"] = al
        ft = al["features"]
        w.notes.append(f"surround.far vs freezeClean at F ({al['validFraction']:.0%} of the frame, "
                       f"{'untouched pixels only' if repl is not None else 'all'}): PSNR {al['psnr']} dB, {al['psnrGain']} gain-matched, "
                       f"{al['psnrGainBest80']} on the best 80%; {ft.get('inliers', 0)} feature matches offset ({ft.get('dx')}, {ft.get('dy')}) px "
                       f"at 1080p, spread {ft.get('rmsPx')} px, left {ft.get('left')}, right {ft.get('right')}")
    w.pieces["surround:far"] = {"source": "real", "detail": detail, **extra}
    cr = sc.get("crowd")
    if cr and cr.get("tiles"):
        R = geo.quat_to_matrix(frame["q"])
        sight = Sight(chain, court_camera["centre"], R)
        crowd = build_crowd(mosaic, sight, stands["proxy"], cr["tiles"], float(cr.get("pxPerM", PX_PER_M)), tuple(cr.get("atlas", ATLAS_MAX)))
        cv2.imwrite(str(w.path("surround/crowd.jpg")), crowd["atlas"], [cv2.IMWRITE_JPEG_QUALITY, JPEG_Q])
        block["crowd"] = {"atlas": "surround/crowd.jpg", "width": crowd["width"], "height": crowd["height"], "pxPerM": crowd["pxPerM"],
                          "tiles": crowd["tiles"]}
        mpp = [i["mPerPxAcross"] for i in crowd["info"]]
        w.pieces["surround:crowd"] = {"source": "imagined", "detail": f"{len(crowd['tiles'])} tiles of the pan's real crowd laid flat on the stands' "
                                      "wall; the seating bowl they are laid on was never filmed (tinted by the Reality check)",
                                      "tiles": len(crowd["tiles"]), "pxPerM": crowd["pxPerM"], "atlas": [crowd["width"], crowd["height"]],
                                      "nativeMPerPx": [round(min(mpp), 5), round(max(mpp), 5)]}
        w.notes.append(f"surround.crowd: {len(crowd['tiles'])} tiles at {crowd['pxPerM']:g} px/m in a {crowd['width']}x{crowd['height']} atlas "
                       f"(the mosaic spans {min(mpp) * 1000:.2f} to {max(mpp) * 1000:.2f} mm per pixel across at the tiles)")
    return block


def check_block(bundle: Path, block: dict | None, info: list) -> list[str]:
    """Errors in a bundle's surround: each picture the size court.json declares, the alpha the far picture's size, the
    crowd's tiles inside the atlas, and (a far picture only counts if) some of it is covered and some of it isn't."""
    if not block:
        return []
    errs: list[str] = []
    far, crowd = block.get("far"), block.get("crowd")
    if far:
        img = cv2.imread(str(bundle / far["image"]), cv2.IMREAD_COLOR)
        al = cv2.imread(str(bundle / far["alpha"]), cv2.IMREAD_GRAYSCALE)
        if img is None or img.shape[:2] != (far["height"], far["width"]):
            errs.append(f"{far['image']}: not the {far['width']}x{far['height']} surround.far declares")
        if al is None or img is None or al.shape != img.shape[:2]:
            errs.append(f"{far['alpha']}: not the size of {far['image']}")
        elif not (al == 255).any():
            errs.append(f"{far['alpha']}: nothing is covered")
        else:
            info.append(f"surround.far: {far['width']}x{far['height']}, f {far['f']}, {float((al > 127).mean()):.0%} filmed")
    if crowd:
        at = cv2.imread(str(bundle / crowd["atlas"]), cv2.IMREAD_COLOR)
        if at is None or at.shape[:2] != (crowd["height"], crowd["width"]):
            errs.append(f"{crowd['atlas']}: not the {crowd['width']}x{crowd['height']} surround.crowd declares")
        else:
            info.append(f"surround.crowd: {len(crowd['tiles'])} tiles at {crowd['pxPerM']:g} px/m in {crowd['width']}x{crowd['height']}")
    return errs


def add_to_bundle(cfg: dict, bundle: Path, k1_show: float) -> dict:
    """Add a surround to an assembled bundle: write its files, set court.json's `surround`, and put the pieces and
    numbers into assembly.json."""
    import assemble as A

    court = json.loads((bundle / "court.json").read_text())
    frames = json.loads((bundle / court["video"]["frames"]).read_text())
    w = A.Writer(bundle)
    block = make_surround(w, cfg, court["camera"], court["video"], frames, court["freeze"]["stands"], k1_show)
    court["surround"] = block
    (bundle / "court.json").write_text(json.dumps(court, indent=1, ensure_ascii=False))
    ap = bundle / "assembly.json"
    diag = json.loads(ap.read_text()) if ap.exists() else {}
    diag.setdefault("pieces", {}).update(w.pieces)
    diag["notes"] = [n for n in diag.get("notes", []) if not n.startswith("surround.")] + w.notes
    ap.write_text(json.dumps(diag, indent=1, ensure_ascii=False))
    return {"block": block, "pieces": w.pieces, "notes": w.notes}


def show_k1(calib_json: dict, src: int) -> float:
    t = geo.CalibTrack(calib_json)
    return float(t.k1[int(np.argmin(np.abs(np.asarray(t.src) - src)))])


def main(argv=None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--config", required=True, help="a private json: the `surround` block, or an assemble config holding one")
    ap.add_argument("--bundle", required=True, help="an assembled bundle folder (court.json beside it), changed in place")
    a = ap.parse_args(argv)
    cfg = json.loads(expand(a.config).read_text())
    block = cfg.get("surround", cfg)
    calib_path = block.get("calib") or cfg.get("calib")
    bundle = expand(a.bundle)
    court = json.loads((bundle / "court.json").read_text())
    if "k1Show" in block:
        k1 = float(block["k1Show"])
    elif calib_path:
        k1 = show_k1(json.loads(expand(calib_path).read_text()), int(court["video"]["freezeSource"]))
    else:
        ap.error("no lens: give `calib` (the calibration with the show's k1) or `k1Show`")
    got = add_to_bundle(block, bundle, k1)
    for n in got["notes"]:
        print(f"  note: {n}")
    print(f"SURROUND {bundle}: {', '.join(k for k in got['block'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
