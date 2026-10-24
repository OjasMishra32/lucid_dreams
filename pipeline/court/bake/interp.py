"""In-between frames: the image w of the way (in capture time) from real frame a to real frame b.

Two sources, one interface (Inbetweens.get(a, b, w) -> (RGB uint8, "rife" | "dis")):
- RIFE results computed on HiPerGator (hpg/), read from a results folder whose needs.json lists every (a, b, w) and
  the file the job wrote for it;
- otherwise the Mac fallback: bidirectional DIS optical flow (OpenCV, preset medium), each neighbour warped to the
  in-between's time and blended by distance in time (the smooth spike's video_ramp.py method), plus a
  forward-backward consistency weight so a pixel one flow gets wrong (an occlusion edge) comes from the other
  neighbour instead of a half-strength double.

In-betweens are made on raw frames (before the watermark inpaint and undistortion: source.py cleans the result with
the in-between's own interpolated focal), so RIFE runs on the unmodified source frames.

Also the SSIM metric the tests and checks report (11x11 Gaussian window, sigma 1.5, on 8-bit luma).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Callable, Iterable

import cv2
import numpy as np

_GRID = {}


def _grid(h: int, w: int) -> np.ndarray:
    if (h, w) not in _GRID:
        _GRID[(h, w)] = np.stack(np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32)), -1)
    return _GRID[(h, w)]


def _gray(img: np.ndarray) -> np.ndarray:
    return img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)


def flows(a: np.ndarray, b: np.ndarray):
    """DIS flow a -> b and b -> a (pixels, (h, w, 2))."""
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    ga, gb = _gray(a), _gray(b)
    return dis.calc(ga, gb, None), dis.calc(gb, ga, None)


def _warp(img, grid, flow, k):
    return cv2.remap(img, grid - k * flow, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def interpolate(a: np.ndarray, b: np.ndarray, w: float, method: str = "dis") -> np.ndarray:
    """The in-between w (0 = a, 1 = b) of two uint8 images. method: "dis" (flow) or "dissolve" (a plain blend,
    for comparison only)."""
    if w <= 1e-6:
        return a.copy()
    if w >= 1 - 1e-6:
        return b.copy()
    af, bf = a.astype(np.float32), b.astype(np.float32)
    if method == "dissolve":
        return np.clip((1 - w) * af + w * bf + 0.5, 0, 255).astype(np.uint8)
    if method != "dis":
        raise ValueError(f"unknown method {method!r}")
    h, wd = a.shape[:2]
    g = _grid(h, wd)
    f01, f10 = flows(a, b)
    wa = _warp(af, g, f01, w)  # a carried forward to time w
    wb = _warp(bf, g, f10, 1 - w)  # b carried back to time w
    # consistency: flow at the pixel each warp read from should be undone by the opposite flow at its target
    fa = _warp(f01, g, f01, w)  # the a->b flow of the a pixel landing here
    fb = _warp(f10, g, f10, 1 - w)
    ea = np.linalg.norm(fa + _warp(f10, g, -fa, 1 - w), axis=2)
    eb = np.linalg.norm(fb + _warp(f01, g, -fb, w), axis=2)
    ka = (1 - w) / (1.0 + ea * ea)
    kb = w / (1.0 + eb * eb)
    s = ka + kb
    ka, kb = np.where(s > 1e-6, ka / np.maximum(s, 1e-6), 1 - w), np.where(s > 1e-6, kb / np.maximum(s, 1e-6), w)
    if a.ndim == 3:
        ka, kb = ka[..., None], kb[..., None]
    return np.clip(ka * wa + kb * wb + 0.5, 0, 255).astype(np.uint8)


def ssim_map(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a, b = _gray(a).astype(np.float64), _gray(b).astype(np.float64)
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2

    def blur(x):
        return cv2.GaussianBlur(x, (11, 11), 1.5)

    ma, mb = blur(a), blur(b)
    va, vb, cov = blur(a * a) - ma * ma, blur(b * b) - mb * mb, blur(a * b) - ma * mb
    return ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2))


def ssim(a: np.ndarray, b: np.ndarray) -> float:
    return float(ssim_map(a, b).mean())


# ---- RIFE results -----------------------------------------------------------------------------------------------
def _wkey(w: float) -> int:
    return int(round(float(w) * 1e6))


def out_name(a: int, b: int, w: float, ext: str = ".png") -> str:
    return f"{int(a):06d}_{int(b):06d}_{_wkey(w):07d}{ext}"


def write_needs(entries: Iterable, path: Path, frame_pattern: str = "{src:06d}.jpg", ext: str = ".png",
                checks: Iterable = ()) -> dict:
    """needs.json for the RIFE job: every distinct (a, b, w) with the file the job must write for it, plus optional
    held-out checks (a, m, c, w): the job interpolates a -> c at m's time and scores it against the real frame m."""
    seen, pairs = set(), []
    for a, b, w in entries:
        k = (int(a), int(b), _wkey(w))
        if k in seen or not (0 < k[2] < 1_000_000):
            continue
        seen.add(k)
        pairs.append({"a": k[0], "b": k[1], "w": k[2] / 1e6, "out": out_name(*k[:2], w, ext)})
    chk = [{"a": int(a), "m": int(m), "c": int(c), "w": float(w)} for a, m, c, w in checks]
    frames = {p["a"] for p in pairs} | {p["b"] for p in pairs} | {x[k] for x in chk for k in ("a", "m", "c")}
    man = {"version": 1, "frame_pattern": frame_pattern, "pairs": pairs, "checks": chk, "frames": sorted(frames)}
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(man, indent=1))
    return man


class Inbetweens:
    """read(src) -> raw RGB uint8 frame; rife_dir: a fetched RIFE results folder (needs.json + its outputs)."""

    def __init__(self, read: Callable[[int], np.ndarray], rife_dir: Path | None = None, method: str = "dis"):
        self.read = read
        self.method = method
        self.rife = {}
        if rife_dir is not None:
            man = Path(rife_dir) / "needs.json"
            if man.exists():
                for p in json.loads(man.read_text())["pairs"]:
                    f = Path(rife_dir) / p["out"]
                    if f.exists():
                        self.rife[(int(p["a"]), int(p["b"]), _wkey(p["w"]))] = f

    def get(self, a: int, b: int, w: float):
        f = self.rife.get((int(a), int(b), _wkey(w)))
        if f is not None:
            img = cv2.imread(str(f), cv2.IMREAD_COLOR)
            if img is not None:
                img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
                ref = self.read(a)
                if img.shape != ref.shape:
                    img = cv2.resize(img, (ref.shape[1], ref.shape[0]), interpolation=cv2.INTER_AREA)
                return img, "rife"
        return interpolate(self.read(a), self.read(b), w, self.method), self.method
