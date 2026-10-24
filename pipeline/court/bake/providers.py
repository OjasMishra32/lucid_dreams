"""Adapters from the footage-side modules (source.py, interp.py, the layers' files, cameras.py) to bake.py's interfaces.

`SourceProvider` yields, per display frame, the live frame (real or in-between), its plate, per-person mattes and the
people (id, box in live-region pixels, foot, order) the cards are cut from. A real frame uses the real files; an
in-between's live and plate come from interp.py, its mattes are composed here (`compose_matte`): each neighbour's matte
is cut at that neighbour's box, resized to the interpolated box and blended by the time fraction, so the matte follows
the moving body without needing a flow for a binary shape.
"""

from __future__ import annotations

from typing import Sequence

import cv2
import numpy as np

from pipeline.court.bake import stack


def compose_matte(live_size: tuple[int, int], box_t: Sequence[float], parts: Sequence[tuple[np.ndarray, Sequence[float], float]]) -> np.ndarray:
    """A full-frame matte (live_size = width, height; 8-bit) that is, inside box_t, the weighted blend of each part.

    A part is (matte, box_of_that_matte_in_live_pixels, weight); the matte may be at any resolution of the live frame.
    Each part is cut at its own box and resized to box_t's size, so a person who moved or grew between the two real
    frames is aligned before blending. Weights are normalised.
    """
    w, h = live_size
    out = np.zeros((h, w), np.uint8)
    x0, y0, x1, y1 = (int(np.floor(box_t[0])), int(np.floor(box_t[1])), int(np.ceil(box_t[2])), int(np.ceil(box_t[3])))
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
    if x1 <= x0 or y1 <= y0:
        return out
    total = sum(p[2] for p in parts)
    acc = np.zeros((y1 - y0, x1 - x0), np.float32)
    for matte, box, weight in parts:
        if matte.ndim == 3:
            matte = matte[..., 0]
        # the part's box mapped onto the (clipped) target box: cut the part at its own box, then place it by box_t's frame
        bw, bh = box_t[2] - box_t[0], box_t[3] - box_t[1]
        cut = stack.crop_resize(matte, box, (w, h), (max(1, int(round(bw))), max(1, int(round(bh)))))
        ox, oy = int(round(x0 - box_t[0])), int(round(y0 - box_t[1]))
        piece = cut[max(0, oy) : max(0, oy) + (y1 - y0), max(0, ox) : max(0, ox) + (x1 - x0)]
        acc[: piece.shape[0], : piece.shape[1]] += piece.astype(np.float32) * (weight / total)
    out[y0:y1, x0:x1] = np.clip(acc + 0.5, 0, 255).astype(np.uint8)
    return out


# ---------------------------------------------------------------- the footage-side provider

import dataclasses
import json
import time
from dataclasses import dataclass
from pathlib import Path

from pipeline.court.bake import cameras as cam_mod
from pipeline.court.bake import cards as cards_mod
from pipeline.court.bake import config as config_mod
from pipeline.court.bake import timeline as timeline_mod
from pipeline.court.bake.bake import Layers
from pipeline.court.bake.layers_input import LayersFiles
from pipeline.court.bake.cards import Person
from pipeline.court.bake.stack import Layout


@dataclass
class RealLayers:
    """One real frame's layers: raw plate, undistorted plate (lazy), undistorted mattes, people with boxes in live pixels."""

    plate_raw: np.ndarray
    plate: np.ndarray
    mattes: dict
    people: list


class SourceProvider:
    """bake.Provider over source.py (live frames, undistortion, in-betweens) and the layers' files (plates, mattes, people)."""

    def __init__(self, cfg, source, layout: Layout, layers: LayersFiles | None, cache: int = 8, matte_pad: int = 2, freeze_source=None):
        self.cfg, self.source, self.layout, self.files = cfg, source, layout, layers
        self.freeze_source = freeze_source  # a Source over F's full-resolution frame: F's live region and freeze.png come from it
        self.cache_n, self.pad = cache, matte_pad
        self._cache: dict[int, RealLayers] = {}
        self.methods: dict[str, int] = {}  # live frames by origin: real / rife / dis (every render counts, retries too)

    # one real frame's layers (cached: an in-between needs both neighbours, the next frame the same pair again)
    def real(self, src: int) -> RealLayers:
        if src in self._cache:
            return self._cache[src]
        L = self.files
        raw = L.plate_raw(src)
        plate = self.source.undistort_layer(raw, src, "plate")
        mattes, people = {}, []
        live_w = self.layout.live[2]
        for e in L.frame_people(src):
            m = self.source.undistort_layer(e.matte, src, "matte")
            box = cards_mod.box_from_matte(m, pad=self.pad)
            if box is None:
                continue
            s = live_w / m.shape[1]
            mattes[e.id] = m
            people.append(Person(e.id, tuple(v * s for v in box), (e.foot[0], 0.0, e.foot[2]), e.order))
        if len(self._cache) >= self.cache_n:
            self._cache.pop(next(iter(self._cache)))
        self._cache[src] = RealLayers(raw, plate, mattes, people)
        return self._cache[src]

    def layers(self, df) -> Layers:
        if self.freeze_source is not None and not df.interp and int(round(df.src)) == self.cfg.freeze:
            live, info = self.freeze_source.clean(self.cfg.freeze)  # F itself: the sharpest frame there is, downscaled by the stacker
        else:
            live, info = self.source.live(df)
        self.methods[info["method"]] = self.methods.get(info["method"], 0) + 1
        if self.files is None:
            return Layers(live)
        if not df.interp:
            r = self.real(int(round(df.src)))
            return Layers(live, r.plate, r.mattes, r.people)
        a, b, w = int(df.a), int(df.b), float(df.w)
        ra, rb = self.real(a), self.real(b)
        plate = self.source.layer_between(ra.plate_raw, rb.plate_raw, a, b, w, "plate")
        people = cards_mod.blend_people(ra.people, rb.people, w)
        live_size = (self.layout.live[2], self.layout.live[3])
        in_a = {p.id: p for p in ra.people}
        in_b = {p.id: p for p in rb.people}
        mattes = {}
        for p in people:
            parts = []
            if p.id in in_a:
                parts.append((ra.mattes[p.id], in_a[p.id].box, 1 - w if p.id in in_b else 1.0))
            if p.id in in_b:
                parts.append((rb.mattes[p.id], in_b[p.id].box, w if p.id in in_a else 1.0))
            mattes[p.id] = compose_matte(live_size, p.box, parts)
        return Layers(live, plate, mattes, people)

    # F and its files
    def freeze(self) -> np.ndarray:
        return (self.freeze_source or self.source).clean(self.cfg.freeze)[0]

    def _like_freeze(self, img: np.ndarray, nearest: bool = False) -> np.ndarray:
        h, w = self.freeze().shape[:2]
        if img.shape[:2] == (h, w):
            return img
        return cv2.resize(img, (w, h), interpolation=cv2.INTER_NEAREST if nearest else cv2.INTER_CUBIC)

    def freeze_clean(self) -> np.ndarray | None:
        if self.files is None:
            return None
        img = self.files.optional("freeze-clean.png")
        if img is not None:
            return self._like_freeze(cv2.cvtColor(img[..., :3], cv2.COLOR_BGR2RGB) if img.ndim == 3 else img)
        if not self.files.plate_path(self.cfg.freeze).exists():
            return None
        return self._like_freeze(self.real(self.cfg.freeze).plate)

    def _mask(self, name: str) -> np.ndarray | None:
        img = self.files.optional(name) if self.files else None
        if img is None:
            return None
        if img.ndim == 3:
            img = img[..., 0]
        return self._like_freeze(img, nearest=True)

    def stands_mask(self):
        return self._mask("stands-mask.png")

    def inpaint_mask(self):
        return self._mask("inpaint-mask.png")


class CoreCameras:
    """bake.Cameras over bake-core's cameras.py and the calibration."""

    def __init__(self, cfg, solve):
        self.cfg, self.solve = cfg, solve

    def frames_json(self, tl) -> list:
        return cam_mod.frames_json(tl, cam_mod.cameras_for(tl, self.solve, self.cfg))

    def camera_block(self) -> dict:
        return cam_mod.video_json_camera(self.solve, self.cfg)

    def source_size(self) -> tuple[int, int]:
        return (self.solve.width, self.solve.height)


def needed_sources(timelines) -> set[int]:
    """Every real source frame some display frame of these timelines shows or is made from."""
    out = set()
    for tl in timelines.values():
        for f in tl.frames:
            out |= {int(f.a), int(f.b)}
    return out


def extract_frame(clip: Path, n: int, dest: Path) -> Path:
    """Frame n (0 = first decoded frame) of a video as a lossless PNG (cached)."""
    import subprocess

    dest.parent.mkdir(parents=True, exist_ok=True)
    if not dest.exists():
        tmp = dest.with_suffix(".part.png")
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-threads", "2", "-i", str(clip), "-vf", f"select=eq(n\\,{n})", "-fps_mode", "passthrough", "-frames:v", "1", str(tmp)], check=True)
        tmp.replace(dest)
    return dest


def freeze_source_for(cfg, src, clip: Path | None, tmp: Path, warnings: list):
    """A Source over F's full-resolution frame (decoded from the clip), checked against the 1080p set's F; None if no clip."""
    import dataclasses as dc
    from pipeline.court.bake import source as source_mod

    if not clip or not Path(clip).expanduser().exists():
        return None
    png = extract_frame(Path(clip).expanduser(), cfg.freeze, tmp / "f4k" / f"{cfg.freeze:06d}.png")
    full = cv2.cvtColor(cv2.imread(str(png)), cv2.COLOR_BGR2RGB)
    ref = src.raw(cfg.freeze)
    small = cv2.resize(full, (ref.shape[1], ref.shape[0]), interpolation=cv2.INTER_AREA)
    mad = float(np.abs(small.astype(np.float32) - ref.astype(np.float32)).mean())
    if mad > 6:  # jpg + resize differences are ~1-3 grey levels; a different frame is far more
        warnings.append(f"the clip's frame {cfg.freeze} does not match the 1080p set's (MAD {mad:.1f}): full-resolution freeze not used")
        return None
    cfg4 = dc.replace(cfg, frames_dir=str(png.parent), frame_pattern="{src:06d}.png")
    return source_mod.Source.from_config(cfg4, f_of=lambda s: src.f_of(s))


class MissingInput(RuntimeError):
    """An input the bake needs is not there yet (named in the message); nothing was written."""


def build_run(cfg, out_dir: Path, opts, bake_fn, label: str = "", freeze_clip: Path | None = None) -> dict:
    """Timelines (every display Hz of the config), the source, the layers (when every needed frame has them), cameras -> bake_fn."""
    from pipeline.court.bake import source as source_mod

    calib = Path(cfg.calib).expanduser()
    if not calib.is_file():
        raise MissingInput(f"the calibration {calib} does not exist yet: nothing was baked")
    frames = Path(cfg.frames_dir).expanduser()
    if not frames.is_dir():
        raise MissingInput(f"the source frames folder {frames} does not exist: nothing was baked")
    timelines = {hz: timeline_mod.build(cfg, hz) for hz in cfg.display_hz}
    warnings = []
    layers = None
    root = Path(cfg.layers).expanduser() if cfg.layers else None
    if root and (root / "people.json").exists():
        files = LayersFiles(root)
        need = sorted(needed_sources(timelines))
        missing = [s for s in need if not files.has_frame(s)]
        if missing:
            warnings.append(f"layers incomplete ({len(missing)} of {len(need)} source frames have no plate/people): live-only stacking")
        else:
            layers = files
    else:
        warnings.append("no layers data (people.json): live-only stacking, no cards")
    solve = cam_mod.load_calib(cfg.calib)
    src = source_mod.Source.from_config(cfg, f_of=lambda s: _solved_f(solve, s))
    tmp = Path(cfg.tmp).expanduser() if cfg.tmp else Path.home() / "court-side-data" / "luka" / "work" / "bake" / "tmp"
    fsrc = freeze_source_for(cfg, src, freeze_clip, tmp, warnings)
    provider = SourceProvider(cfg, src, opts.layout, layers, freeze_source=fsrc)
    opts.make_source = cfg.make
    t0 = time.time()
    report = bake_fn(timelines, provider, CoreCameras(cfg, solve), Path(out_dir), opts, main_hz=72)
    report["warnings"] = warnings + report.get("warnings", [])
    report["seconds"] = round(time.time() - t0, 1)
    report["live_only"] = layers is None
    return report


def _solved_f(solve, s: float) -> float:
    """The solve's focal at a (possibly fractional) source frame: linear between solved frames (as cameras.py lerps)."""
    keys = sorted(solve.frames)
    lo = max((k for k in keys if k <= s), default=keys[0])
    hi = min((k for k in keys if k >= s), default=keys[-1])
    if lo == hi:
        return solve.frames[lo].f
    w = (s - lo) / (hi - lo)
    return (1 - w) * solve.frames[lo].f + w * solve.frames[hi].f


def synth_run(work, out, config, opts, bake_fn) -> dict:
    """The synthetic clip end to end: writes it into `work` if it is not there, bakes into work/show/video."""
    from pipeline.court.bake import synth

    work = Path(work)
    cfg_path = Path(config) if config else work / "bake_config.json"
    if not cfg_path.exists():
        synth.write_clip(work)
    cfg = config_mod.load(cfg_path)
    return build_run(cfg, Path(out) if out else work / "show", opts, bake_fn)


REAL_FRAMES = Path.home() / "court-side-data" / "luka" / "work" / "layers" / "f1080"


REAL_CLIP = Path.home() / "court-side-data" / "luka" / "A-main-615.mp4"


def real_run(work, out, config, opts, bake_fn) -> dict:
    cfg = config_mod.load(config)
    if not cfg.frames_dir:  # the private config may leave the decoded frames' folder out: the 1080p set (jpg) is the default
        cfg = dataclasses.replace(cfg, frames_dir=str(REAL_FRAMES), frame_pattern="{src:06d}.jpg")
    from pipeline.court.bake import bake as bake_mod

    return build_run(cfg, bake_mod.check_out_dir(out) if out else bake_mod.STAGING, opts, bake_fn, freeze_clip=None if opts.no_freeze_4k else REAL_CLIP)
