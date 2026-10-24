"""Source frames for the show bake: raw frame -> watermark inpainted -> strobe replaced -> undistorted pinhole image.

Camera convention (agreed with bake-core's cameras.py): undistortion keeps the solve's own intrinsics. An image of
width Wi gets focal f_img = f_calib * Wi / src_width (calib f is at src_width, e.g. 3840), principal point at the
image centre ((Wi-1)/2, (Hi-1)/2), and the output is the same size as the input. The lens model is calib_A's:
xn = x_cam/z; xd = xn (1 + k1 |xn|^2); u = f xd + cx. With BakeConfig.undistort_f_scale = s != 1 the output focal is
s * f_img (input focal unchanged); bake-core then writes f * s into frames.json. With k1 > 0 (pincushion) the output
corners sample outside the raw frame (about 2-3% at the corners): those pixels are edge-replicated for images,
zero for mattes, and `undistort_valid` says which they are.

Order of operations for a live frame: the watermark is a broadcast overlay in raw pixels, so it is inpainted in raw
space first (its box is in raw source px); in-betweens (and strobe replacements) are interpolated on the inpainted
raw neighbours (interp.py); the result is undistorted with its own focal (an in-between's is the lerp of its two
real frames'). Plates and mattes from the layers agent (raw, distorted, at layers scale) go through the same
functions: `Source.undistort_layer(img, src, kind)`; the output keeps the input's size (layers scale).

Entry points (bake-stack):
  Source.from_config(cfg)                      cfg: BakeConfig or its json dict (calib, frames_dir, frame_pattern,
                                               src_width, watermark, strobes, repeat_mod, repeat_phase, clip_first,
                                               undistort_f_scale; optional rife_dir)
  Source.live(df) -> (rgb, info)               df: a timeline display frame (attrs or dict: src, interp, a, b, w)
  Source.clean(src) -> (rgb, info)             a real frame (a strobe frame is replaced from its neighbours)
  Source.clean_between(a, b, w) -> (rgb, info) an in-between (RIFE result if present, else DIS flow)
  Source.undistort_layer(img, src, kind)       kind "plate" (watermark out + undistort) or "matte" (undistort only)
  Source.dewatermark(img)                      watermark out of a raw frame or plate at any scale (WatermarkModel
                                               un-blend when BakeConfig.watermark_model names one, else inpaint)
  Source.layer_between(img_a, img_b, a, b, w)  a plate at an in-between: flow-interpolated raw plates, then cleaned
  Source.focal(src, width) / focal_between(a, b, w, width)   raw focal at an image width (output = x f_scale)
info: {"interp": bool, "a", "b", "w", "method": "real" | "rife" | "dis", "f": output focal at the image's width}

    python3 pipeline/court/bake/source.py --config bake_config.json --src N --out check.png   (before/after sheet)
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

_COURT = Path(__file__).resolve().parents[1]
if str(_COURT) not in sys.path:
    sys.path.insert(0, str(_COURT))
import camgeom  # noqa: E402

try:
    from . import interp
except ImportError:  # run as a script
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import interp  # type: ignore  # noqa: E402

DEFAULT_PAD_SRC_PX = 8  # watermark box margin, source px


# ---- lens -------------------------------------------------------------------------------------------------------
def focal_at(f: float, calib_width: int, width: int) -> float:
    """A focal in calibration pixels expressed at another image width (principal point stays at the centre)."""
    return f * width / calib_width


def undistort_maps(width: int, height: int, f: float, k1: float, f_scale: float = 1.0):
    """remap maps (float32) taking the raw distorted image to the pinhole image with focal f * f_scale."""
    cx, cy = camgeom.principal(width, height)
    u, v = np.meshgrid(np.arange(width, dtype=np.float64), np.arange(height, dtype=np.float64))
    xn, yn = (u - cx) / (f * f_scale), (v - cy) / (f * f_scale)
    s = 1.0 + k1 * (xn * xn + yn * yn)
    return (f * xn * s + cx).astype(np.float32), (f * yn * s + cy).astype(np.float32)


def undistort(img: np.ndarray, f: float, k1: float, f_scale: float = 1.0, kind: str = "image") -> np.ndarray:
    """Raw distorted image (focal f at this image's width) -> pinhole image, same size. kind "matte": linear, zero
    outside; "image": bicubic, edge-replicated outside."""
    h, w = img.shape[:2]
    if k1 == 0 and f_scale == 1.0:
        return img.copy()
    mx, my = undistort_maps(w, h, f, k1, f_scale)
    if kind == "matte":
        return cv2.remap(img, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    return cv2.remap(img, mx, my, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def undistort_valid(width: int, height: int, f: float, k1: float, f_scale: float = 1.0) -> np.ndarray:
    """True where the pinhole pixel's source lies inside the raw frame."""
    mx, my = undistort_maps(width, height, f, k1, f_scale)
    return (mx >= -0.5) & (mx <= width - 0.5) & (my >= -0.5) & (my <= height - 0.5)


def undistort_points(u, v, f: float, k1: float, width: int, height: int, f_scale: float = 1.0):
    """Raw (distorted) pixel coordinates -> pinhole pixel coordinates (e.g. a layers box corner)."""
    cx, cy = camgeom.principal(width, height)
    xn, yn = camgeom.undistort_norm((np.asarray(u, float) - cx) / f, (np.asarray(v, float) - cy) / f, k1)
    return f * f_scale * xn + cx, f * f_scale * yn + cy


def distort_points(u, v, f: float, k1: float, width: int, height: int, f_scale: float = 1.0):
    """Pinhole pixel coordinates -> raw (distorted) pixel coordinates."""
    cx, cy = camgeom.principal(width, height)
    xn, yn = (np.asarray(u, float) - cx) / (f * f_scale), (np.asarray(v, float) - cy) / (f * f_scale)
    s = 1.0 + k1 * (xn * xn + yn * yn)
    return f * xn * s + cx, f * yn * s + cy


# ---- watermark --------------------------------------------------------------------------------------------------
def scaled_box(box, src_width: int, width: int, height: int, pad: float = DEFAULT_PAD_SRC_PX):
    """The watermark box (source px at src_width, plus `pad` source px) in an image of this size, rounded out."""
    s = width / src_width
    x0, y0, x1, y1 = box
    return (max(0, math.floor((x0 - pad) * s)), max(0, math.floor((y0 - pad) * s)),
            min(width, math.ceil((x1 + pad) * s)), min(height, math.ceil((y1 + pad) * s)))


def inpaint_watermark(img: np.ndarray, box, src_width: int, pad: float = DEFAULT_PAD_SRC_PX,
                      mask: np.ndarray | None = None) -> np.ndarray:
    """Inpaint the corner watermark of a raw frame or plate at any scale (box in source px at src_width). `mask`
    (optional, the image's size) narrows the fill to the logo's own pixels inside the box."""
    h, w = img.shape[:2]
    x0, y0, x1, y1 = scaled_box(box, src_width, w, h, pad)
    if x1 <= x0 or y1 <= y0:
        return img.copy()
    m = np.zeros((h, w), np.uint8)
    m[y0:y1, x0:x1] = 255
    if mask is not None:
        m &= np.where(mask > 0, 255, 0).astype(np.uint8)
    radius = max(3, round(0.15 * max(x1 - x0, y1 - y0)))
    return cv2.inpaint(img, m, radius, cv2.INPAINT_TELEA)


class WatermarkModel:
    """The semi-transparent overlay as per-pixel opacity alpha and premultiplied colour c (I = (1 - alpha) B + c),
    estimated from many frames: with the camera panning, the background under the box changes while the overlay
    stays, so over time std(I) = (1 - alpha) std(B) and mean(I) = (1 - alpha) mean(B) + c, with mean(B) and std(B)
    filled in from the region around the box (the crowd's statistics vary slowly across the corner). Removing it
    un-blends B = (I - c) / (1 - alpha), so what is behind the logo (a head, the crowd) stays real; where the logo is
    nearly opaque the un-blend is too noisy and an inpaint takes over."""

    def __init__(self, alpha: np.ndarray, c: np.ndarray, region, size):
        self.alpha, self.c = alpha.astype(np.float32), c.astype(np.float32)
        self.region, self.size = tuple(int(v) for v in region), tuple(int(v) for v in size)

    @classmethod
    def fit(cls, frames, box, src_width: int, pad: float = DEFAULT_PAD_SRC_PX, ring: float = 0.5) -> "WatermarkModel":
        n, acc, acc2, size = 0, None, None, None
        for img in frames:
            if size is None:
                size = (img.shape[1], img.shape[0])
                x0, y0, x1, y1 = scaled_box(box, src_width, *size, pad)
                m = int(math.ceil(ring * max(x1 - x0, y1 - y0)))
                region = (max(0, x0 - m), max(0, y0 - m), min(size[0], x1 + m), min(size[1], y1 + m))
                rx0, ry0, rx1, ry1 = region
            crop = img[ry0:ry1, rx0:rx1].astype(np.float64)
            acc = crop if acc is None else acc + crop
            acc2 = crop * crop if acc2 is None else acc2 + crop * crop
            n += 1
        if n < 8:
            raise ValueError("need at least 8 frames to fit the watermark")
        M = acc / n
        S = np.sqrt(np.maximum(acc2 / n - M * M, 0))
        hole = np.zeros(M.shape[:2], np.uint8)
        hole[y0 - ry0:y1 - ry0, x0 - rx0:x1 - rx0] = 255
        rad = max(3, round(0.15 * max(x1 - x0, y1 - y0)))
        fill = lambda a: np.dstack([cv2.inpaint(a[..., k].astype(np.float32), hole, rad, cv2.INPAINT_TELEA) for k in range(3)])  # noqa: E731
        muB, sdB = fill(M), fill(S)
        keep = np.median(S / np.maximum(sdB, 1e-3), axis=2)  # 1 - alpha
        alpha = np.clip(1 - keep, 0, 0.98) * (hole > 0)
        c = (M - (1 - alpha)[..., None] * muB) * (hole > 0)[..., None]
        return cls(alpha, c, region, size)

    def save(self, path: Path) -> None:
        np.savez_compressed(path, alpha=self.alpha, c=self.c, region=np.array(self.region), size=np.array(self.size))

    @classmethod
    def load(cls, path: Path) -> "WatermarkModel":
        z = np.load(path)
        return cls(z["alpha"], z["c"], z["region"], z["size"])

    def at(self, width: int, height: int):
        """(alpha, c, region) for an image of this size."""
        if (width, height) == self.size:
            return self.alpha, self.c, self.region
        sx, sy = width / self.size[0], height / self.size[1]
        x0, y0, x1, y1 = self.region
        r = (int(round(x0 * sx)), int(round(y0 * sy)), int(round(x1 * sx)), int(round(y1 * sy)))
        wh = (max(1, r[2] - r[0]), max(1, r[3] - r[1]))
        return (cv2.resize(self.alpha, wh, interpolation=cv2.INTER_AREA),
                cv2.resize(self.c, wh, interpolation=cv2.INTER_AREA), r)

    def remove(self, img: np.ndarray, hi: tuple = (0.6, 0.85)) -> np.ndarray:
        h, w = img.shape[:2]
        alpha, c, (x0, y0, x1, y1) = self.at(w, h)
        crop = img[y0:y1, x0:x1].astype(np.float32)
        un = (crop - c) / (1 - alpha)[..., None]
        t = np.clip((alpha - hi[0]) / (hi[1] - hi[0]), 0, 1)
        if t.max() > 0:
            m = (t > 0).astype(np.uint8) * 255
            tel = cv2.inpaint(np.clip(un, 0, 255).astype(np.uint8), m, 3, cv2.INPAINT_TELEA).astype(np.float32)
            un = un * (1 - t[..., None]) + tel * t[..., None]
        out = img.copy()
        out[y0:y1, x0:x1] = np.clip(un + 0.5, 0, 255).astype(np.uint8)
        return out


# ---- flashes ----------------------------------------------------------------------------------------------------
def detect_flashes(srcs, luma_means, threshold: float = 8.0, window: int = 9):
    """Frames whose mean luma rises more than `threshold` grey levels over the running median (P39's spike)."""
    y = np.asarray(luma_means, float)
    half = window // 2
    out = []
    for i, s in enumerate(srcs):
        lo, hi = max(0, i - half), min(len(y), i + half + 1)
        if y[i] - np.median(y[lo:hi]) > threshold:
            out.append(s)
    return out


# ---- calibration ------------------------------------------------------------------------------------------------
class CalibFocal:
    """Focal (calib px) per source frame from calib_A.json: linear between solved frames, held past the ends.
    A stand-in until bake-core's cameras give every frame's focal (pass `f_of` to Source to use theirs)."""

    def __init__(self, calib: dict):
        fr = sorted(calib["frames"], key=lambda x: x["source_frame"])
        self.srcs = np.array([x["source_frame"] for x in fr], float)
        self.fs = np.array([x["f"] for x in fr], float)
        self.width, self.height = calib["image_size"]
        k1s = {round(float(x["k1"]), 9) for x in fr}
        self.k1 = float(fr[0]["k1"]) if len(k1s) == 1 else float(np.median([x["k1"] for x in fr]))

    def __call__(self, src: float) -> float:
        return float(np.interp(src, self.srcs, self.fs))


def _get(cfg, key, default=None):
    if isinstance(cfg, dict):
        return cfg.get(key, default)
    return getattr(cfg, key, default)


# ---- the source -------------------------------------------------------------------------------------------------
class Source:
    def __init__(self, frames_dir, frame_pattern: str, f_of: Callable[[float], float], k1: float, src_width: int,
                 watermark=None, strobes=(), repeat_mod: int = 4, repeat_phase: int = 3, clip_first: int = 0,
                 capture_fps: float = 120.0, f_scale: float = 1.0, rife_dir=None, method: str = "dis",
                 time_of: Callable[[int], float] | None = None, cache: int = 48,
                 watermark_model: "WatermarkModel | None" = None):
        self.frames_dir = Path(frames_dir)
        self.pattern = frame_pattern
        self.f_of = f_of
        self.k1 = float(k1)
        self.src_width = int(src_width)
        self.watermark = list(watermark) if watermark else None
        self.strobes = set(int(s) for s in strobes)
        self.repeat_mod, self.repeat_phase, self.first = int(repeat_mod), int(repeat_phase), int(clip_first)
        self.capture_fps = float(capture_fps)
        self.f_scale = float(f_scale)
        self._time_of = time_of
        self._cache, self._cache_n = {}, cache
        self.watermark_model = watermark_model
        self.inbetweens = interp.Inbetweens(self.raw_inpainted, rife_dir=rife_dir, method=method)

    @classmethod
    def from_config(cls, cfg, f_of: Callable[[float], float] | None = None, **kw) -> "Source":
        calib = json.loads(Path(_get(cfg, "calib")).expanduser().read_text())
        cf = CalibFocal(calib)
        src_width = _get(cfg, "src_width") or cf.width
        if f_of is None:
            if cf.width != src_width:
                f_of = lambda s: cf(s) * src_width / cf.width  # noqa: E731
            else:
                f_of = cf
        src = cls(Path(_get(cfg, "frames_dir")).expanduser(), _get(cfg, "frame_pattern", "{src:06d}.jpg"), f_of,
                   cf.k1, src_width, watermark=_get(cfg, "watermark"), strobes=_get(cfg, "strobes", ()) or (),
                   repeat_mod=_get(cfg, "repeat_mod", 4), repeat_phase=_get(cfg, "repeat_phase", 3),
                   clip_first=_get(cfg, "clip_first", 0), capture_fps=_get(cfg, "capture_fps", 120.0),
                   f_scale=_get(cfg, "undistort_f_scale", 1.0) or 1.0, rife_dir=kw.pop("rife_dir", _get(cfg, "rife_dir")),
                   **kw)
        wm = _get(cfg, "watermark_model")
        if wm and src.watermark:
            wm = Path(wm).expanduser()
            if wm.exists():
                src.watermark_model = WatermarkModel.load(wm)
            else:
                src.fit_watermark(save=wm)
        return src

    # frames and times
    def is_repeat(self, src: int) -> bool:
        return src > self.first and src % self.repeat_mod == self.repeat_phase

    def time_of(self, src: int) -> float:
        """True capture time (s since clip_first): the rank of src among the non-repeat frames / capture_fps."""
        if self._time_of is not None:
            return self._time_of(src)
        src = int(src)
        if self.is_repeat(src):
            src -= 1
        m, p = self.repeat_mod, self.repeat_phase
        reps = (src - p) // m - (self.first - p) // m  # repeats in (first, src]
        return (src - self.first - reps) / self.capture_fps

    def usable(self, src: int) -> bool:
        return not self.is_repeat(src) and src not in self.strobes and self.path(src).exists()

    def neighbours(self, src: int):
        a = src - 1
        while a >= self.first and not self.usable(a):
            a -= 1
        b = src + 1
        while b < src + 64 and not self.usable(b):
            b += 1
        if a < self.first or not self.usable(b):
            raise ValueError(f"no usable neighbours around {src}")
        return a, b

    def path(self, src: int) -> Path:
        return self.frames_dir / self.pattern.format(src=int(src))

    def raw(self, src: int) -> np.ndarray:
        img = cv2.imread(str(self.path(src)), cv2.IMREAD_COLOR)
        if img is None:
            raise FileNotFoundError(self.path(src))
        return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)

    def raw_inpainted(self, src: int) -> np.ndarray:
        src = int(src)
        if src not in self._cache:
            if len(self._cache) >= self._cache_n:
                self._cache.pop(next(iter(self._cache)))
            self._cache[src] = self.dewatermark(self.raw(src))
        return self._cache[src]

    def dewatermark(self, img: np.ndarray) -> np.ndarray:
        """Remove the corner watermark from a raw frame or plate at any scale: un-blend with the fitted model when
        there is one, else inpaint the box."""
        if self.watermark_model is not None:
            return self.watermark_model.remove(img)
        if self.watermark:
            return inpaint_watermark(img, self.watermark, self.src_width)
        return img

    def fit_watermark(self, n: int = 240, save: Path | None = None) -> "WatermarkModel":
        """Fit the watermark model on up to n usable frames spread over the clip (and use it from now on)."""
        srcs, miss, s = [], 0, self.first
        while miss < 256 and s < self.first + 100_000:  # every frame file from clip_first on
            if self.path(s).exists():
                miss = 0
                if self.usable(s):
                    srcs.append(s)
            else:
                miss += 1
            s += 1
        pick = [srcs[i] for i in np.linspace(0, len(srcs) - 1, min(n, len(srcs))).round().astype(int)]
        self.watermark_model = WatermarkModel.fit((self.raw(p) for p in pick), self.watermark, self.src_width)
        self._cache.clear()
        if save is not None:
            Path(save).parent.mkdir(parents=True, exist_ok=True)
            self.watermark_model.save(save)
        return self.watermark_model

    # focal at the frame files' width
    def _img_focal(self, f_src: float, width: int) -> float:
        return focal_at(f_src, self.src_width, width)

    def focal(self, src: float, width: int) -> float:
        """Raw (input) focal of a source frame at an image of this width."""
        return self._img_focal(self.f_of(src), width)

    def focal_between(self, a: int, b: int, w: float, width: int) -> float:
        return self._img_focal((1 - w) * self.f_of(a) + w * self.f_of(b), width)

    # live frames
    def clean(self, src: int):
        src = int(src)
        if self.is_repeat(src):
            src -= 1
        if src in self.strobes:
            a, b = self.neighbours(src)
            ta, tb, ts = self.time_of(a), self.time_of(b), self.time_of(src)
            return self.clean_between(a, b, (ts - ta) / (tb - ta))
        img = self.raw_inpainted(src)
        f = self._img_focal(self.f_of(src), img.shape[1])
        return undistort(img, f, self.k1, self.f_scale), {"interp": False, "a": src, "b": src, "w": 0.0,
                                                          "method": "real", "f": f * self.f_scale}

    def clean_between(self, a: int, b: int, w: float):
        mid, how = self.inbetweens.get(int(a), int(b), float(w))
        f = self.focal_between(a, b, w, mid.shape[1])
        return undistort(mid, f, self.k1, self.f_scale), {"interp": True, "a": int(a), "b": int(b), "w": float(w),
                                                          "method": how, "f": f * self.f_scale}

    def live(self, df):
        if _get(df, "interp"):
            return self.clean_between(_get(df, "a"), _get(df, "b"), _get(df, "w"))
        return self.clean(int(round(_get(df, "src"))))

    # layers (plates, mattes): raw distorted at layers scale in, undistorted at the same size out
    def undistort_layer(self, img: np.ndarray, src: float, kind: str = "plate", f_src: float | None = None) -> np.ndarray:
        f = self._img_focal(self.f_of(src) if f_src is None else f_src, img.shape[1])
        if kind == "plate":
            return undistort(self.dewatermark(img), f, self.k1, self.f_scale)
        if kind == "matte":
            return undistort(img, f, self.k1, self.f_scale, kind="matte")
        raise ValueError(kind)

    def layer_between(self, img_a: np.ndarray, img_b: np.ndarray, a: int, b: int, w: float,
                      kind: str = "plate") -> np.ndarray:
        """A plate (or matte) at an in-between: interpolate the raw layers (flow), then undistort with the lerped
        focal. Plates are inpainted before the flow so the static logo does not drag the flow."""
        if kind == "plate":
            img_a, img_b = self.dewatermark(img_a), self.dewatermark(img_b)
        mid = interp.interpolate(img_a, img_b, w)
        f_src = (1 - w) * self.f_of(a) + w * self.f_of(b)
        f = self._img_focal(f_src, mid.shape[1])
        return undistort(mid, f, self.k1, self.f_scale, kind="matte" if kind == "matte" else "image")


def check_sheet(src_obj: Source, src: int) -> np.ndarray:
    """raw | cleaned, with the watermark corner enlarged for both (a real-frame before/after check)."""
    raw = src_obj.raw(src)
    out, info = src_obj.clean(src)
    h, w = raw.shape[:2]
    if src_obj.watermark:
        x0, y0, x1, y1 = scaled_box(src_obj.watermark, src_obj.src_width, w, h, pad=4 * DEFAULT_PAD_SRC_PX)
    else:
        x0, y0, x1, y1 = 0, 0, w // 10, h // 10
    zh = h // 2
    zoom = lambda im: cv2.resize(im[y0:y1, x0:x1], (zh * (x1 - x0) // max(y1 - y0, 1), zh), interpolation=cv2.INTER_NEAREST)  # noqa: E731
    top = np.hstack([raw, out])
    bottom = np.hstack([zoom(raw), zoom(out)])
    bottom = cv2.copyMakeBorder(bottom, 0, 0, 0, max(0, top.shape[1] - bottom.shape[1]), cv2.BORDER_CONSTANT, value=0)
    sheet = np.vstack([top, bottom[:, : top.shape[1]]])
    for x, label in ((10, f"raw {src}"), (w + 10, f"clean f={info['f']:.0f}px k1->0 {info['method']}")):
        cv2.putText(sheet, label, (x, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 0), 2, cv2.LINE_AA)
    return sheet


def main(argv=None):
    ap = argparse.ArgumentParser(description="Before/after check of one source frame (undistort + watermark).")
    ap.add_argument("--config", type=Path, required=True)
    ap.add_argument("--src", type=int, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    s = Source.from_config(json.loads(a.config.read_text()))
    sheet = check_sheet(s, a.src)
    a.out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(a.out), cv2.cvtColor(sheet, cv2.COLOR_RGB2BGR))
    print(a.out)


if __name__ == "__main__":
    main()
