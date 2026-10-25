"""A synthetic clip with known everything, for the show-bake tests (no broadcast numbers anywhere).

What it imitates (each piece is a known truth the tests can check against):
- a fixed camera on the floor's long axis looking down the court, panning, tilting and zooming slowly, with one
  radial lens term k1 (calib_A.json's model: xn = x_cam/z; xd = xn (1 + k1 |xn|^2); u = f xd + cx);
- a textured floor with painted lines, a textured back wall (the stands), and people as upright textured cut-outs
  ("cards") standing on the floor and moving on known paths, one passing behind another;
- a real high-speed clip in a slower container: every `repeat_period`-th container frame (src % period == phase) is
  an exact repeat of the frame before it; the others are successive captures at `capture_fps`;
- arena strobes: whole-frame flashes on chosen captures (their repeat copies flash too);
- a semi-transparent broadcast watermark in the top-left corner, in raw (distorted) pixels, on top of everything.

Times: `t` is real (capture) time in seconds since the first container frame. A container frame `src` (an int,
`first` .. `first + n_frames - 1`) shows capture `capture_of(src)` taken at `time_of(src)`. A fractional src between
two unique (non-repeat) frames a < b means the fraction (src - a) / (b - a) of the way from a's capture to b's.

Writes (write_clip): frames/<src:06d>.png (the raw container frames), calib_A.json (calib-A's schema), truth.json,
bake_config.json (synthetic), layers2/out/ (the layers -> stack data contract: people.json, plates/, mattes/,
mosaic.png + mosaic.json).

    python3 pipeline/court/bake/synth.py OUT_DIR [--frames 200]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

import cv2
import numpy as np

_COURT = Path(__file__).resolve().parents[1]
if str(_COURT) not in sys.path:
    sys.path.insert(0, str(_COURT))
import camgeom  # noqa: E402

K_matrix = camgeom.K_matrix
CAMERA_MODEL = ("x_cam = R (X - C); xn = x_cam/z; xd = xn (1 + k1 |xn|^2); u = f xd + cx; v = f yd + cy; "
                "cx = (W-1)/2, cy = (H-1)/2")


@dataclass(frozen=True)
class Person:
    id: str
    base: tuple  # (x, z) floor point at t = 0 before the swing, metres
    swing: tuple  # (x amplitude, z amplitude), metres
    period: float  # seconds
    phase: float  # radians
    drift: tuple  # (vx, vz), m/s
    height: float
    width: float
    shirt: tuple  # RGB
    shorts: tuple

    def foot(self, t: float) -> np.ndarray:
        w = 2 * math.pi * t / self.period + self.phase
        x = self.base[0] + self.swing[0] * (math.sin(w) - math.sin(self.phase)) + self.drift[0] * t
        z = self.base[1] + self.swing[1] * (math.sin(w) - math.sin(self.phase)) + self.drift[1] * t
        return np.array([x, 0.0, z])


DEFAULT_PEOPLE = (
    Person("p0", (5.0, 1.9), (0.0, 1.0), 1.4, 0.0, (0.8, 0.0), 1.93, 0.56, (40, 90, 200), (20, 40, 120)),
    Person("p1", (7.9, 0.6), (0.0, 1.4), 1.2, math.pi, (0.0, 0.0), 2.05, 0.62, (235, 235, 225), (200, 60, 50)),
    Person("p2", (3.6, -0.6), (1.5, 0.0), 2.0, 0.0, (0.0, 1.0), 1.84, 0.55, (200, 40, 40), (240, 240, 240)),
)


@dataclass(frozen=True)
class Spec:
    width: int = 384
    height: int = 216
    n_frames: int = 200  # container frames
    first: int = 100  # source frame number of the first container frame (not 0, to catch index slips)
    source_fps: float = 60.0
    capture_fps: float = 180.0
    repeat_period: int = 5
    repeat_phase: int = 2  # src % period == phase -> exact repeat of src - 1
    strobes: tuple = (126, 139)  # unique srcs that flash (126's repeat 127 flashes too)
    k1: float = 1.6
    hfov_deg: float = 15.0
    camera: tuple = (-15.0, 1.1, 3.2)
    target: tuple = (6.0, 1.0, 1.2)
    yaw_deg_per_s: float = 1.6
    pitch_deg_per_s: float = -0.5
    zoom_per_s: float = 0.10
    watermark_frac: tuple = (0.0, 0.0, 0.052, 0.093)  # x0, y0, x1, y1 as fractions of width/height
    watermark_alpha: float = 0.5
    flash_gain: float = 0.65  # flashed = (1 - g) img + g 255
    layers_scale: float = 0.5  # layers px per source px (people.json `scale`)
    supersample: int = 2
    seed: int = 7
    people: tuple = field(default=DEFAULT_PEOPLE)


def _noise(rng, h, w, scales=(2, 6, 18), weights=(0.5, 0.3, 0.2)):
    out = np.zeros((h, w), np.float32)
    for s, wt in zip(scales, weights):
        n = rng.standard_normal((h, w)).astype(np.float32)
        n = cv2.GaussianBlur(n, (0, 0), s)
        out += wt * n / (n.std() + 1e-6)
    return out


class SynthClip:
    """Renders the synthetic scene at any real time; frame(src) is the raw container frame."""

    FLOOR_RES = 0.02  # m per texture px
    FLOOR_X = (-12.0, 20.0)
    FLOOR_Z = (-9.0, 9.0)
    WALL_X = 20.0
    WALL_RES = 0.03
    WALL_Z = (-16.0, 16.0)
    WALL_Y = (0.0, 9.0)
    SPRITE_RES = 0.01

    def __init__(self, spec: Spec = Spec()):
        self.spec = spec
        self.W, self.H = spec.width, spec.height
        self.cx, self.cy = camgeom.principal(self.W, self.H)
        self.C = np.array(spec.camera, float)
        self.yaw0, self.pitch0 = camgeom.yaw_pitch_of(np.array(spec.target) - self.C)
        self.f0 = (self.W / 2) / math.tan(math.radians(spec.hfov_deg / 2))
        self.first = spec.first
        self.srcs = list(range(spec.first, spec.first + spec.n_frames))
        self._cap = {}
        c = -1
        for s in self.srcs:
            if not self.is_repeat(s):
                c += 1
            self._cap[s] = c
        self.unique = [s for s in self.srcs if not self.is_repeat(s)]
        flashed = set(spec.strobes)
        for s in spec.strobes:
            r = s + 1
            while r in self._cap and self.is_repeat(r):
                flashed.add(r)
                r += 1
        self.flash_srcs = sorted(flashed & set(self.srcs))
        self.slow = spec.capture_fps / (spec.source_fps * (spec.repeat_period - 1) / spec.repeat_period)
        self.people = list(spec.people)
        self.person_ids = [p.id for p in self.people]
        rng = np.random.default_rng(spec.seed)
        self._floor = self._make_floor(rng)
        self._wall = self._make_wall(rng)
        self._sprites = {p.id: self._make_sprite(rng, p) for p in self.people}
        self.watermark_box, self.watermark_mask = self._make_watermark()
        self._frames = {}

    # ---- time -------------------------------------------------------------------------------------------------
    def is_repeat(self, src: int) -> bool:
        s = self.spec
        return src > s.first and src % s.repeat_period == s.repeat_phase

    def capture_of(self, src: int) -> int:
        return self._cap[int(src)]

    def time_of(self, src: float) -> float:
        """Real time of a (possibly fractional) source frame."""
        if float(src).is_integer():
            return self._cap[int(src)] / self.spec.capture_fps
        lo = max(u for u in self.unique if u <= src)
        hi = min(u for u in self.unique if u > lo)
        a = (src - lo) / (hi - lo)
        return (1 - a) * self.time_of(lo) + a * self.time_of(hi)

    # ---- camera -----------------------------------------------------------------------------------------------
    def camera(self, t: float):
        """(R world->camera (OpenCV axes), f px) at real time t."""
        s = self.spec
        yaw = self.yaw0 + math.radians(s.yaw_deg_per_s) * t
        pitch = self.pitch0 + math.radians(s.pitch_deg_per_s) * t
        R = camgeom.rot_from_dir(camgeom.dir_from_yaw_pitch(yaw, pitch))
        return R, self.f0 * (1 + s.zoom_per_s * t)

    def foot_pixel(self, pid: str, t: float, distorted: bool = False):
        p = self.people[self.person_ids.index(pid)]
        R, f = self.camera(t)
        u, v, _ = camgeom.project(p.foot(t), R, self.C, f, self.spec.k1 if distorted else 0.0, self.cx, self.cy)
        return float(u), float(v)

    # ---- textures ---------------------------------------------------------------------------------------------
    def _make_floor(self, rng):
        r = self.FLOOR_RES
        w = int((self.FLOOR_X[1] - self.FLOOR_X[0]) / r)
        h = int((self.FLOOR_Z[1] - self.FLOOR_Z[0]) / r)
        x = self.FLOOR_X[0] + (np.arange(w) + 0.5) * r
        z = self.FLOOR_Z[0] + (np.arange(h) + 0.5) * r
        X, Z = np.meshgrid(x, z)
        plank = np.floor(Z / 0.07)
        tone = (np.sin(plank * 12.9898) * 43758.5453) % 1.0  # per-plank tone
        n = _noise(rng, h, w, scales=(1.5, 5, 20), weights=(0.45, 0.35, 0.2))
        base = np.array([196, 150, 98], np.float32)
        img = base[None, None, :] * (0.82 + 0.12 * tone[..., None] + 0.08 * n[..., None])
        seam = (np.abs(Z / 0.07 - np.round(Z / 0.07)) < 0.08)
        img[seam] *= 0.8
        line = np.zeros((h, w), bool)
        for zz in (-2.44, 2.44):  # lane edges
            line |= (np.abs(Z - zz) < 0.025) & (X > 8.3) & (X < 14.33)
        line |= (np.abs(X - 8.3) < 0.025) & (np.abs(Z) < 2.44)  # free-throw line
        rr = np.hypot(X - 13.0, Z)
        line |= (np.abs(rr - 6.75) < 0.025) & (X < 13.0)  # an arc
        line |= np.abs(X) < 0.025  # half-court line
        img[line] = (245, 245, 240)
        return np.clip(img, 0, 255).astype(np.float32)

    def _make_wall(self, rng):
        r = self.WALL_RES
        w = int((self.WALL_Z[1] - self.WALL_Z[0]) / r)
        h = int((self.WALL_Y[1] - self.WALL_Y[0]) / r)
        img = np.zeros((h, w, 3), np.float32)
        for ch, (a, b) in enumerate(((30, 160), (30, 120), (40, 150))):
            n = _noise(rng, h, w, scales=(1.0, 3, 10), weights=(0.5, 0.3, 0.2))
            img[..., ch] = a + (b - a) * (0.5 + 0.25 * n)
        rows = (np.arange(h) * r) % 0.9 < 0.08  # stand rows
        img[rows] *= 0.5
        board = slice(int(0.9 / r), int(1.7 / r))  # an LED board strip
        img[board] = np.array([20, 60, 160], np.float32) + 60 * _noise(rng, img[board].shape[0], w)[..., None]
        return np.clip(img, 0, 255).astype(np.float32)

    def _make_sprite(self, rng, p: Person):
        """RGBA cut-out in (a = across, h = up) metres: columns -0.5..0.5 m, rows top (h = 2.3) to bottom (0)."""
        r = self.SPRITE_RES
        w, h = int(1.0 / r), int(2.3 / r)
        a = -0.5 + (np.arange(w) + 0.5) * r
        hh = 2.3 - (np.arange(h) + 0.5) * r
        A, Hh = np.meshgrid(a, hh)
        H0 = p.height
        head_r = 0.12 * H0 / 1.95
        neck = H0 - 2 * head_r
        half = p.width / 2
        hw = np.where(Hh < 0.47 * H0, 0.62 * half, np.where(Hh < 0.8 * H0, half, 0.9 * half))
        legs_gap = (Hh < 0.42 * H0) & (np.abs(A) < 0.06)
        body = (Hh >= 0) & (Hh <= neck) & (np.abs(A) <= hw) & ~legs_gap
        head = A ** 2 + (Hh - (H0 - head_r)) ** 2 <= head_r ** 2
        alpha = (body | head).astype(np.float32)
        skin = np.array([150, 105, 80], np.float32)
        col = np.empty((h, w, 3), np.float32)
        col[:] = skin
        torso = (Hh >= 0.47 * H0) & (Hh <= neck)
        shorts = (Hh >= 0.32 * H0) & (Hh < 0.47 * H0)
        shoes = Hh < 0.05 * H0
        col[torso] = p.shirt
        col[shorts] = p.shorts
        col[shoes] = (30, 30, 30)
        n = _noise(rng, h, w, scales=(1.0, 3.0, 8.0), weights=(0.4, 0.4, 0.2))
        col *= (0.85 + 0.12 * n)[..., None]
        num = torso & (np.abs(A) < 0.12) & (np.abs(Hh - 0.66 * H0) < 0.1) & ((np.floor(A / 0.04) + np.floor(Hh / 0.05)) % 2 == 0)
        col[num] = col[num] * 0.25
        stripe = torso & (np.abs(Hh - 0.74 * H0 - 0.06 * np.sin(A * 9)) < 0.015)
        col[stripe] = 255 - col[stripe]
        return np.dstack([np.clip(col, 0, 255), alpha * 255]).astype(np.float32)

    def _make_watermark(self):
        s = self.spec
        x0, y0, x1, y1 = (int(round(s.watermark_frac[0] * self.W)), int(round(s.watermark_frac[1] * self.H)),
                          int(round(s.watermark_frac[2] * self.W)), int(round(s.watermark_frac[3] * self.H)))
        m = np.zeros((self.H, self.W), np.float32)
        ss = 4
        bw, bh = (x1 - x0) * ss, (y1 - y0) * ss
        logo = np.zeros((bh, bw), np.uint8)
        c = (bw // 2, bh // 2)
        rad = min(bw, bh) // 2 - ss
        cv2.circle(logo, c, rad, 255, max(ss, rad // 4))
        cv2.line(logo, (bw // 5, bh * 4 // 5), (bw * 4 // 5, bh // 5), 255, max(ss, rad // 4))
        cv2.rectangle(logo, (bw * 2 // 5, bh * 2 // 5), (bw * 3 // 5, bh * 3 // 5), 255, -1)
        small = cv2.resize(logo, (x1 - x0, y1 - y0), interpolation=cv2.INTER_AREA).astype(np.float32) / 255
        m[y0:y1, x0:x1] = small * s.watermark_alpha
        return (x0, y0, x1, y1), m

    # ---- rendering --------------------------------------------------------------------------------------------
    def _grid(self, w, h, scale, ss):
        """Source-pixel coordinates of every subsample of a (w x h) output at `scale` source px per output px."""
        sub = (np.arange(ss) + 0.5) / ss - 0.5
        uo = (np.arange(w)[:, None] + sub[None, :]).reshape(-1)
        vo = (np.arange(h)[:, None] + sub[None, :]).reshape(-1)
        u = (uo + 0.5) / scale - 0.5
        v = (vo + 0.5) / scale - 0.5
        return np.meshgrid(u, v)

    @staticmethod
    def _sample(tex, tx, ty):
        return cv2.remap(tex, tx.astype(np.float32), ty.astype(np.float32), cv2.INTER_LINEAR,
                         borderMode=cv2.BORDER_REFLECT)

    @staticmethod
    def _undistort_radial(xd, yd, k1):
        """xd = xn (1 + k1 |xn|^2) inverted by a radial lookup table (exact to ~1e-7 in normalised units)."""
        rd = np.sqrt(xd * xd + yd * yd)
        rmax = float(rd.max()) * 1.001 + 1e-6
        rn = np.linspace(0.0, rmax, 4097)
        if k1 < 0:
            rn = rn[1.0 + 3.0 * k1 * rn * rn > 0]
        rdt = rn * (1.0 + k1 * rn * rn)
        scale = np.ones_like(rn)
        scale[1:] = rn[1:] / rdt[1:]
        s = np.interp(rd, rdt, scale).astype(np.float32)
        return xd * s, yd * s

    def _trace(self, u, v, R, f, k1, cx, cy, t, people=True):
        """Colour (h, w, 3) float32 and per-person visible coverage {id: (h, w)} for pixel grids u, v."""
        sh = u.shape
        xd = ((u - cx) / f).astype(np.float32).ravel()
        yd = ((v - cy) / f).astype(np.float32).ravel()
        xn, yn = self._undistort_radial(xd, yd, k1) if k1 else (xd, yd)
        R32 = np.asarray(R, np.float32)
        # world ray = R^T (xn, yn, 1), column by column (small matmuls are slow under BLAS thread contention)
        dx = R32[0, 0] * xn + R32[1, 0] * yn + R32[2, 0]
        dy = R32[0, 1] * xn + R32[1, 1] * yn + R32[2, 1]
        dz = R32[0, 2] * xn + R32[1, 2] * yn + R32[2, 2]
        C = self.C.astype(np.float32)
        with np.errstate(divide="ignore", invalid="ignore"):
            s_f = np.where(dy < -1e-9, -C[1] / dy, np.inf).astype(np.float32)
            s_w = np.where(dx > 1e-9, (self.WALL_X - C[0]) / dx, np.inf).astype(np.float32)
        use_floor = s_f < s_w
        s_bg = np.where(use_floor, s_f, s_w)
        ok = np.isfinite(s_bg)
        s_bg = np.where(ok, s_bg, 0)
        px, py, pz = C[0] + s_bg * dx, C[1] + s_bg * dy, C[2] + s_bg * dz
        fx = np.where(use_floor, (px - self.FLOOR_X[0]) / self.FLOOR_RES - 0.5, 0)
        fz = np.where(use_floor, (pz - self.FLOOR_Z[0]) / self.FLOOR_RES - 0.5, 0)
        wz = np.where(use_floor, 0, (pz - self.WALL_Z[0]) / self.WALL_RES - 0.5)
        wy = np.where(use_floor, 0, (self.WALL_Y[1] - py) / self.WALL_RES - 0.5)
        floor = self._sample(self._floor, fx.reshape(sh), fz.reshape(sh)).reshape(-1, 3)
        wall = self._sample(self._wall, wz.reshape(sh), wy.reshape(sh)).reshape(-1, 3)
        img = np.where(use_floor[:, None], floor, wall)
        img[~ok] = 10.0
        cover = {}
        if people:
            order = sorted(self.people, key=lambda p: -np.linalg.norm(p.foot(t) - self.C))  # far first
            alphas = []
            for p in order:
                F = p.foot(t)
                n = self.C - F
                n[1] = 0
                n /= np.linalg.norm(n)
                tv = np.cross(camgeom.UP, n)
                den = n[0] * dx + n[2] * dz
                num = float((F - self.C) @ n)
                s_p = num / np.where(np.abs(den) > 1e-9, den, 1e-9)
                rel = C - F.astype(np.float32)
                a = float(rel @ tv) + s_p * (tv[0] * dx + tv[2] * dz)
                hgt = C[1] + s_p * dy
                tx = (a + 0.5) / self.SPRITE_RES - 0.5
                ty = (2.3 - hgt) / self.SPRITE_RES - 0.5
                rgba = cv2.remap(self._sprites[p.id], tx.astype(np.float32).reshape(sh), ty.astype(np.float32).reshape(sh),
                                 cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0).reshape(-1, 4)
                al = (rgba[:, 3] / 255) * (s_p > 0)
                img = img * (1 - al[:, None]) + rgba[:, :3] * al[:, None]
                alphas.append((p.id, al))
            for i, (pid, al) in enumerate(alphas):
                vis = al.copy()
                for _, nearer in alphas[i + 1:]:
                    vis *= 1 - nearer
                cover[pid] = vis.reshape(sh)
        return img.reshape(*sh, 3), cover

    def _render(self, R, f, k1, t, w, h, scale, people, cx=None, cy=None):
        ss = self.spec.supersample
        u, v = self._grid(w, h, scale, ss)
        img, cover = self._trace(u, v, R, f, k1, self.cx if cx is None else cx, self.cy if cy is None else cy, t, people)

        def down(x):  # box filter over each ss x ss block (INTER_AREA is exact for an integer factor)
            return x if ss == 1 else cv2.resize(np.ascontiguousarray(x, np.float32), (w, h), interpolation=cv2.INTER_AREA)

        return down(img), {k: down(c) for k, c in cover.items()}

    def render(self, t: float, *, distorted: bool = False, people: bool = True, watermark: bool = False,
               flash: bool = False, scale: float = 1.0, masks: bool = False):
        """The scene at real time t as uint8 RGB (or {id: float visible coverage 0..1} with masks=True).
        distorted: the raw lens (k1) instead of a pinhole; watermark/flash: the broadcast overlay / an arena strobe;
        scale: output px per source px (an output pixel centre i maps to source (i + 0.5) / scale - 0.5)."""
        R, f = self.camera(t)
        w, h = int(round(self.W * scale)), int(round(self.H * scale))
        img, cover = self._render(R, f, self.spec.k1 if distorted else 0.0, t, w, h, scale, people or masks)
        if masks:
            return cover
        if flash:
            g = self.spec.flash_gain
            img = (1 - g) * img + g * 255
        if watermark:
            m = self.watermark_mask if scale == 1.0 else cv2.resize(self.watermark_mask, (w, h), interpolation=cv2.INTER_AREA)
            img = img * (1 - m[..., None]) + 255 * m[..., None]
        return np.clip(img + 0.5, 0, 255).astype(np.uint8)

    def frame(self, src: int) -> np.ndarray:
        """The raw container frame: distorted, watermarked, flashed if a strobe, repeats exact copies."""
        src = int(src)
        if self.is_repeat(src):
            return self.frame(src - 1)
        if src not in self._frames:
            if len(self._frames) > 64:
                self._frames.clear()
            self._frames[src] = self.render(self.time_of(src), distorted=True, watermark=True,
                                            flash=src in self.flash_srcs)
        return self._frames[src]

    def gt(self, src: float) -> np.ndarray:
        """Ground truth for a (fractional) source frame: the clean pinhole render at its real time."""
        return self.render(self.time_of(src))

    def gt_at(self, a: int, b: int, w: float) -> np.ndarray:
        """Ground truth for the in-between w of the way from real frame a's capture to b's (a, b whole srcs)."""
        return self.render((1 - w) * self.time_of(a) + w * self.time_of(b))

    def gt_masks(self, src: float) -> dict:
        return self.render(self.time_of(src), masks=True)

    def mosaic(self):
        """A people-free, undistorted, wider still view (the fixed-centre background mosaic stand-in)."""
        tm = self.time_of(self.srcs[len(self.srcs) // 2])
        R, f = self.camera(tm)
        w, h = self.W * 2, self.H * 2
        fm = f * 1.2
        img, _ = self._render(R, fm, 0.0, tm, w, h, 1.0, False, cx=(w - 1) / 2, cy=(h - 1) / 2)
        cam = {"R": R.tolist(), "C": self.C.tolist(), "f": fm, "k1": 0.0, "cx": (w - 1) / 2, "cy": (h - 1) / 2,
               "width": w, "height": h, "synthetic": True}
        return np.clip(img + 0.5, 0, 255).astype(np.uint8), cam

    # ---- json -------------------------------------------------------------------------------------------------
    def calib(self) -> dict:
        s = self.spec
        frames = []
        for src in self.srcs:
            R, f = self.camera(self.time_of(src))
            frames.append({
                "t": src - s.first, "file": f"{src:06d}.png", "C": self.C.tolist(), "f": f, "k1": s.k1,
                "K": K_matrix(f, self.W, self.H).tolist(), "R": R.tolist(), "tvec": (-R @ self.C).tolist(),
                "feature_rms_px": 0.0, "line_offset_px": 0.0, "n_line_samples": 0, "source_frame": src,
                "time_in_clip_s": src / s.source_fps,
                "hfov_deg": math.degrees(2 * math.atan(self.W / 2 / f)),
                "vfov_deg": math.degrees(2 * math.atan(self.H / 2 / f)),
            })
        return {
            "version": 1, "synthetic": True, "image_size": [self.W, self.H], "n_frames": len(frames),
            "frames_dir": "frames", "world": "metres; origin centre court on the floor; x along the length; y up",
            "camera_model": CAMERA_MODEL, "k1_mode": "shared", "C": self.C.tolist(), "segments": [],
            "frames": frames, "keyframes": [], "summary": {}, "model_overrides": {}, "priors": {},
            "source": {"clip": "synthetic", "fps": f"{s.source_fps:g}",
                       "window": f"source frames {self.srcs[0]}-{self.srcs[-1]} (t = source_frame - {s.first})",
                       "resolution": [self.W, self.H]},
            "fields": {
                "C": "camera centre, metres, court frame",
                "frames[].R": "world->camera rotation, OpenCV camera axes (x right, y down, z forward): x_cam = R (X - C)",
                "frames[].f": f"focal length, px at {self.W}x{self.H}",
                "frames[].k1": "radial term: xn = x_cam/z; xd = xn (1 + k1 |xn|^2); u = f xd + cx; v = f yd + cy",
                "frames[].K": "pinhole intrinsics, principal point = image centre ((W-1)/2, (H-1)/2)",
            },
            "spot": [5.0, 1.9],
        }

    def truth(self) -> dict:
        s = self.spec
        return {
            "synthetic": True, "first": s.first, "last": self.srcs[-1], "width": self.W, "height": self.H,
            "source_fps": s.source_fps, "capture_fps": s.capture_fps, "slow": self.slow,
            "repeat": {"period": s.repeat_period, "phase": s.repeat_phase},
            "flash_srcs": self.flash_srcs, "k1": s.k1,
            "watermark": {"box": list(self.watermark_box), "alpha": s.watermark_alpha},
            "frames": [{"src": src, "capture": self._cap[src], "time": self.time_of(src), "repeat": self.is_repeat(src),
                        "flash": src in self.flash_srcs} for src in self.srcs],
            "people": [asdict(p) for p in self.people],
        }

    def bake_config(self, root: Path) -> dict:
        """A synthetic bake_config.json (the real one is private; bake-core's config.py owns the schema)."""
        s = self.spec
        u = self.unique
        freeze = u[int(len(u) * 0.7)]
        while freeze in self.flash_srcs:
            freeze = u[u.index(freeze) + 1]
        root = Path(root).resolve()
        return {  # bake-core's BakeConfig keys, plus where the synthetic inputs live
            "synthetic": True,
            "capture_fps": s.capture_fps, "source_fps": s.source_fps,
            "src_width": self.W, "src_height": self.H,
            "clip_first": s.first, "play_start": s.first, "pass1_end": None,
            "pass2_start": u[int(len(u) * 0.15)], "freeze": freeze, "make": u[int(len(u) * 0.95)],
            "clip_end": self.srcs[-1],
            "repeat_mod": s.repeat_period, "repeat_phase": s.repeat_phase,
            "strobes": self.flash_srcs, "watermark": list(self.watermark_box),
            "pass2_speed": 0.6, "ease_seconds": [1.2, 1.0, 0.8], "display_hz": [72, 90],
            "calib": str(root / "calib_A.json"), "undistort_f_scale": 1.0,
            "frames_dir": str(root / "frames"), "frame_pattern": "{src:06d}.png",
            "layers": str(root / "layers2" / "out"), "out": str(root / "bundle" / "video"), "tmp": str(root / "tmp"),
        }


def _box(m, thr=0.5):
    ys, xs = np.nonzero(m > thr)
    if len(xs) == 0:
        return None
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]


def write_layers(out: Path, clip: SynthClip) -> None:
    """The layers -> stack contract (people.json, plates/, mattes/, mosaic) from the scene's truth."""
    out = Path(out)
    (out / "plates").mkdir(parents=True, exist_ok=True)
    sc = clip.spec.layers_scale
    frames = {}
    for src in clip.srcs:
        t = clip.time_of(src)
        full = clip.render(t, distorted=True, masks=True)
        small = clip.render(t, distorted=True, masks=True, scale=sc)
        C = clip.C
        ents = []
        for p in clip.people:
            box = _box(full[p.id])
            if box is None or (small[p.id] > 0.5).sum() < 4:
                continue
            ents.append({"id": p.id, "box": box, "foot": [float(v) for v in p.foot(t)],
                         "_d": float(np.linalg.norm(p.foot(t) - C))})
        ents.sort(key=lambda e: e["_d"])
        md = out / "mattes" / f"{src:06d}"
        md.mkdir(parents=True, exist_ok=True)
        for i, e in enumerate(ents):
            e["order"] = i
            del e["_d"]
            cv2.imwrite(str(md / f"{e['id']}.png"), np.clip(small[e["id"]] * 255 + 0.5, 0, 255).astype(np.uint8))
        frames[str(src)] = ents
        plate = clip.render(t, distorted=True, people=False, watermark=True, flash=src in clip.flash_srcs, scale=sc)
        cv2.imwrite(str(out / "plates" / f"{src:06d}.jpg"), cv2.cvtColor(plate, cv2.COLOR_RGB2BGR),
                    [cv2.IMWRITE_JPEG_QUALITY, 95])
    ids = {p.id: {"name": f"synthetic person {p.id}", "height_m": p.height} for p in clip.people}
    (out / "people.json").write_text(json.dumps({"scale": sc, "frames": frames, "ids": ids, "synthetic": True}))
    mos, cam = clip.mosaic()
    cv2.imwrite(str(out / "mosaic.png"), cv2.cvtColor(mos, cv2.COLOR_RGB2BGR))
    (out / "mosaic.json").write_text(json.dumps(cam, indent=1))


def write_clip(out: Path, clip: SynthClip | None = None, layers: bool = True) -> SynthClip:
    clip = clip or SynthClip()
    out = Path(out)
    (out / "frames").mkdir(parents=True, exist_ok=True)
    for src in clip.srcs:
        cv2.imwrite(str(out / "frames" / f"{src:06d}.png"), cv2.cvtColor(clip.frame(src), cv2.COLOR_RGB2BGR))
    (out / "calib_A.json").write_text(json.dumps(clip.calib(), indent=1))
    (out / "truth.json").write_text(json.dumps(clip.truth(), indent=1))
    (out / "bake_config.json").write_text(json.dumps(clip.bake_config(out), indent=1))
    if layers:
        write_layers(out / "layers2" / "out", clip)
    return clip


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("out", type=Path)
    ap.add_argument("--frames", type=int, default=Spec.n_frames)
    ap.add_argument("--width", type=int, default=Spec.width)
    ap.add_argument("--height", type=int, default=Spec.height)
    ap.add_argument("--no-layers", action="store_true")
    a = ap.parse_args(argv)
    clip = write_clip(a.out, SynthClip(Spec(width=a.width, height=a.height, n_frames=a.frames)), not a.no_layers)
    print(f"synthetic clip: {len(clip.srcs)} frames {clip.srcs[0]}-{clip.srcs[-1]} -> {a.out}")


if __name__ == "__main__":
    main()
