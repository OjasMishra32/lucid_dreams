"""One player's 4DAnyone clip from a calibrated broadcast angle, plus the real frame the freeze is trained against.

    python3 -I player_clip.py --config <private config.json> [--sets a,b] [--measure-only] [--allow-partial]

Everything about the footage (the clip, its calibration, the masks, the freeze frame, the windows) comes from the
private config, never from defaults here. Per clip set (one player, one stride):
  1. The window: n frames on the clip's grid of unique frames (a high-speed replay repeats every `mod`-th frame at
     `phase`), every `stride`-th one, with the reference frame (the freeze) at index k.
  2. The still camera is the reference frame's own camera (its R and f, no lens distortion; stabilize.py), so frame
     k of the clip is that frame. Each player's mask boxes over the window are mapped onto it and their union sets one
     FIXED crop (crop[0] x crop[1], never rescaled; CropDoesNotFit says how much more it needed).
  3. Each frame is warped into that crop and composited onto a plain background with the player's mask (plus what
     they carry). Whoever is in front of them is cut out of their mask (a few pixels grown) and the hole stays
     background: never the other person's pixels. Re-timed into a 25 fps container.
Writes <out>/<set>/: clip-lossless.mkv (FFV1), input.mp4, input.framemd5, source-4k.mkv (FFV1, k + 1 frames: black,
then the reference frame's real pixels in the same crop), masks/ and ignore/ (<k:06d>.png at the crop's size),
measure.json, court-run.json, job.json, and sheet.jpg / edge-k.png / k-vs-ref.png to check by eye; and per run id
<out>/runs/<id>/ (hard links + that id's job.json and court-run.json): exactly the folder to upload for that run.

Config keys: video, calib, masks (<masks>/<name>/<frame:06d>.png, white = them), out, ref, repeat [mod, phase],
repeat_range [first, last], crop [w, h], margin, bg [r, g, b], grow, near, n (121), matte (false: true composites
with <masks>/<name>-alpha/ where it exists), sets {name: {player, with,
front, stride, k}}, runs {id: {set, turbo}}. `front` lists who is nearer the camera than the player.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cv2  # noqa: E402
import numpy as np  # noqa: E402

import stabilize as st  # noqa: E402

FRAMES = 121  # 4DAnyone takes exactly this many
FPS = 25  # the container rate lucid.prep_clip resamples to anyway, so prep changes nothing
COVERED = 0.02  # a frame "needs fill" when the people in front cover this share of the player's own area
CLIP_MAX = (2160, 3840)  # the largest portrait clip 4DAnyone has run here (4K portrait)
VIEWS = (704, 1280)  # 4DAnyone's generated views


class CropDoesNotFit(ValueError):
    pass


# --- the window ---------------------------------------------------------------------------------------------------


def unique_frames(lo: int, hi: int, mod: int, phase: int) -> list[int]:
    """Frames lo..hi (inclusive) that are not the replay's repeats (n % mod == phase)."""
    return [n for n in range(lo, hi + 1) if n % mod != phase]


def window(ref: int, stride: int, k: int, n: int = FRAMES, mod: int = 4, phase: int = 3,
           valid: tuple[int, int] | None = None) -> list[int]:
    """n unique frames, every stride-th one on the unique grid, with `ref` at index k."""
    if ref % mod == phase:
        raise ValueError(f"frame {ref} is a repeat")
    if not 0 <= k < n or stride < 1:
        raise ValueError(f"k={k} stride={stride} for {n} frames")
    def walk(step: int, count: int) -> list[int]:
        out, m = [], ref
        while len(out) < count:
            m += step
            if m % mod != phase:
                out.append(m)
        return out
    grid = walk(-1, stride * k)[::-1] + [ref] + walk(1, stride * (n - 1 - k))
    frames = grid[::stride]
    if valid is not None and (frames[0] < valid[0] or frames[-1] > valid[1]):
        raise ValueError(f"window {frames[0]}-{frames[-1]} leaves the range {valid[0]}-{valid[1]} where the "
                         "repeat pattern was measured")
    return frames


# --- masks and layers ---------------------------------------------------------------------------------------------


def _disk(r: int) -> np.ndarray:
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def grow_mask(m: np.ndarray, r: int) -> np.ndarray:
    return m if r <= 0 else cv2.dilate(m, _disk(r))


def player_alpha(own: np.ndarray, carried: list[np.ndarray], front: list[np.ndarray], grow: int) -> np.ndarray:
    """The player's matte: their mask and what they carry, minus everyone in front of them (grown a little, so no
    edge of the other person survives)."""
    a = own.astype(np.float32).copy()
    for c in carried:
        a = np.maximum(a, c)
    for o in front:
        a *= 1.0 - np.clip(grow_mask(o.astype(np.float32), grow), 0, 1)
    return np.clip(a, 0, 1)


def ignore_mask(own: np.ndarray, front: list[np.ndarray], grow: int, near: int) -> np.ndarray:
    """White where someone in front of the player covers them: the front people's masks (grown) near the player."""
    if not front:
        return np.zeros(own.shape, np.float32)
    ig = np.zeros(own.shape, np.float32)
    for o in front:
        ig = np.maximum(ig, grow_mask(o.astype(np.float32), grow))
    region = grow_mask((own > 0.5).astype(np.uint8), near).astype(np.float32)
    return np.clip(ig, 0, 1) * region


def composite(rgb: np.ndarray, alpha: np.ndarray, bg) -> np.ndarray:
    a = alpha[..., None].astype(np.float32)
    out = rgb.astype(np.float32) * a + np.asarray(bg, np.float32) * (1 - a)
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


def _hull(m: np.ndarray) -> np.ndarray:
    pts = cv2.findNonZero((m > 0.5).astype(np.uint8))
    out = np.zeros(m.shape, np.uint8)
    if pts is not None:
        cv2.fillConvexPoly(out, cv2.convexHull(pts), 1)
    return out


def covered_fraction(own: np.ndarray, front: list[np.ndarray]) -> float:
    """Share of the player's own area that people in front of them cover, counted over the player's convex hull."""
    area = float((own > 0.5).sum())
    if area == 0 or not front:
        return 0.0
    hull = _hull(own)
    cover = np.zeros(own.shape, bool)
    for o in front:
        cover |= (o > 0.5) & (hull > 0)
    return float(cover.sum()) / area


def load_matte(masks: Path, name: str, n: int, w: int, h: int, use: bool = True) -> np.ndarray:
    """The soft matte <masks>/<name>-alpha/<n>.png when asked for (config "matte": true) and made, else the binary
    mask."""
    soft = masks / f"{name}-alpha" / f"{n:06d}.png"
    return load_mask(soft.parent, n, w, h) if use and soft.exists() else load_mask(masks / name, n, w, h)


def load_mask(folder: Path, n: int, w: int, h: int) -> np.ndarray:
    path = Path(folder) / f"{n:06d}.png"
    m = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if m is None:
        raise FileNotFoundError(f"{path}: every frame of the window needs a mask")
    if m.shape != (h, w):
        m = cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR)
    return m.astype(np.float32) / 255.0


# --- geometry -----------------------------------------------------------------------------------------------------


def mask_box_on_canvas(mask: np.ndarray, still: dict, fr: dict, w: int, h: int):
    """Bounding box (x0, y0, x1, y1) of a frame's mask on the still camera's canvas, or None if it's empty."""
    cs, _ = cv2.findContours((mask > 0.5).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cs:
        return None
    p = np.concatenate([c.reshape(-1, 2) for c in cs]).astype(float)
    # pixel centres sit at integers: the mask's outer edge is half a pixel out
    p = np.concatenate([p + d for d in ((-0.5, -0.5), (0.5, -0.5), (-0.5, 0.5), (0.5, 0.5))])
    u, v = st.canvas_points(still, fr, w, h, p[:, 0], p[:, 1])
    return float(u.min()), float(v.min()), float(u.max()), float(v.max())


def fit_crop(box, cw: int, ch: int, fw: int, fh: int, margin: int) -> tuple[int, int]:
    """Top-left of a cw x ch window holding `box` with `margin` all round: centred across, the reference frame's own
    rows down (both pulled inside the reference frame when that still holds the box)."""
    x0, y0, x1, y1 = box
    need = (x1 - x0 + 2 * margin, y1 - y0 + 2 * margin)
    if need[0] > cw or need[1] > ch:
        raise CropDoesNotFit(f"the path needs {int(np.ceil(need[0]))}x{int(np.ceil(need[1]))} px with its margin; "
                             f"the crop is {cw}x{ch}")

    def place(lo, hi, size, frame, pref):
        first, last = int(np.ceil(hi + margin - size)), int(np.floor(lo - margin))
        want = min(max(pref, 0), frame - size) if size <= frame else (lo + hi) / 2 - size / 2
        x = int(round(min(max(want, first), last)))
        if x % 2 and x + 1 <= last:
            x += 1
        elif x % 2 and x - 1 >= first:
            x -= 1
        return x

    return (place(x0, x1, cw, fw, (x0 + x1) / 2 - cw / 2), place(y0, y1, ch, fh, 0))


def clip_window(box, cw: int, ch: int, cap: tuple[int, int], margin: int) -> tuple[int, int, float]:
    """The smallest 9:16 window (even sides, never under cw x ch) holding `box` with its margin, and the scale that
    brings it under `cap` (1.0 when it already fits: native pixels)."""
    x0, y0, x1, y1 = box
    even = lambda v: int(np.ceil(v / 2)) * 2  # noqa: E731
    w = even(max(cw, x1 - x0 + 2 * margin, (y1 - y0 + 2 * margin) * 9 / 16))
    h = even(max(ch, w * 16 / 9))
    return w, h, min(1.0, cap[0] / w, cap[1] / h)


# --- video I/O ----------------------------------------------------------------------------------------------------


class Encoder:
    """Raw RGB frames piped into ffmpeg (FFV1, planar RGB: lossless) at FPS."""

    def __init__(self, path: Path, w: int, h: int):
        self.path = path
        self.n = 0
        self.p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                                   "-s", f"{w}x{h}", "-framerate", str(FPS), "-i", "-", "-c:v", "ffv1", "-level", "3",
                                   "-pix_fmt", "gbrp", str(path)], stdin=subprocess.PIPE)

    def write(self, rgb: np.ndarray):
        self.p.stdin.write(np.ascontiguousarray(rgb).tobytes())
        self.n += 1

    def close(self):
        self.p.stdin.close()
        if self.p.wait() != 0:
            raise RuntimeError(f"ffmpeg failed writing {self.path}")


def run(cmd: list[str]):
    subprocess.run(cmd, check=True)


def probe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height,r_frame_rate,nb_read_frames,pix_fmt", "-of", "json", str(path)],
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)["streams"][0]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def decode_frames(video: Path, wanted: set[int], w: int, h: int):
    """(n, rgb) for every wanted frame, n = decoded frame number from 0 (as the calibration counts them). Decoded by
    ffmpeg with the clip's own BT.709 matrix and full chroma interpolation (PyAV's rgb24 is ~2 levels off on these)."""
    lo, hi = min(wanted), max(wanted)
    vf = (f"select='between(n\\,{lo}\\,{hi})',scale=in_color_matrix=bt709:in_range=tv:out_range=pc:"
          "flags=accurate_rnd+full_chroma_int+lanczos,format=rgb24")
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(video), "-vf", vf, "-fps_mode", "passthrough",
                          "-f", "rawvideo", "-"], stdout=subprocess.PIPE)
    size = w * h * 3
    try:
        for n in range(lo, hi + 1):
            buf = p.stdout.read(size)
            if len(buf) < size:
                raise ValueError(f"{video} ends before frame {hi}")
            if n in wanted:
                yield n, np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        p.kill()
        p.stdout.close()
        p.wait()


# --- the build ----------------------------------------------------------------------------------------------------


def expand(cfg: dict) -> dict:
    cfg = dict(cfg)
    for key in ("video", "calib", "masks", "out"):
        cfg[key] = Path(os.path.expanduser(cfg[key]))
    return cfg


def plan_set(cfg: dict, name: str, calib: dict, still: dict, frames_by_n: dict, allow_partial: bool) -> dict:
    s = cfg["sets"][name]
    w, h = calib["image_size"]
    cw, ch = cfg["crop"]
    mod, phase = cfg["repeat"]
    win = window(cfg["ref"], s["stride"], s["k"], cfg.get("n", FRAMES), mod, phase, tuple(cfg["repeat_range"]))
    masks = cfg["masks"]
    who_with, who_front = s.get("with", []), s.get("front", [])
    missing_cal = [n for n in win if n not in frames_by_n]
    if missing_cal and not allow_partial:
        raise SystemExit(f"[{name}] {len(missing_cal)} window frames have no calibration "
                         f"({missing_cal[0]}..{missing_cal[-1]}); the calibration covers "
                         f"{min(frames_by_n)}..{max(frames_by_n)}")
    boxes, covered, mags, skipped = {}, {}, {}, []
    for n in win:
        if n not in frames_by_n:
            skipped.append(n)
            continue
        try:
            own = load_mask(masks / s["player"], n, w, h)
            carried = [load_mask(masks / c, n, w, h) for c in who_with]
            front = [load_mask(masks / o, n, w, h) for o in who_front]
        except FileNotFoundError:
            if not allow_partial:
                raise
            skipped.append(n)
            continue
        fr = frames_by_n[n]
        box = mask_box_on_canvas(player_alpha(own, carried, front, cfg.get("grow", 3)), still, fr, w, h)
        if box is None:
            raise SystemExit(f"[{name}] the {s['player']} mask of frame {n} is empty")
        boxes[n] = box
        covered[n] = round(covered_fraction(own, front), 4)
        mags[n] = round(still["f0"] / fr["f"], 3)
    if not boxes:
        raise SystemExit(f"[{name}] no frame of the window has both a calibration and masks yet")
    b = np.array(list(boxes.values()))
    union = (float(b[:, 0].min()), float(b[:, 1].min()), float(b[:, 2].max()), float(b[:, 3].max()))
    out = {"set": name, "player": s["player"], "stride": s["stride"], "k": s["k"], "window": [win[0], win[-1]],
           "frames": win, "union": [round(x, 1) for x in union],
           "unionSize": [round(union[2] - union[0], 1), round(union[3] - union[1], 1)],
           "measured": len(boxes), "skipped": skipped,
           "fill": [n for n, c in covered.items() if c >= COVERED], "covered": covered,
           "maxCovered": max(covered.values()), "magnification": [min(mags.values()), max(mags.values())],
           "boxes": {str(n): [round(x, 1) for x in v] for n, v in boxes.items()}}
    margin = cfg.get("margin", 32)
    # the clip for 4DAnyone: one fixed 9:16 window over the whole path (native pixels up to clip_max, else scaled)
    wc, hc, sc = clip_window(union, cw, ch, tuple(cfg.get("clip_max", CLIP_MAX)), margin)
    size = [wc, hc] if sc == 1 else [int(wc * sc) // 2 * 2, int(hc * sc) // 2 * 2]
    out["clip"] = {"window": [*fit_crop(union, wc, hc, w, h, margin), wc, hc], "scale": round(sc, 4), "size": size}
    # how tall the player stands: in the clip, and in 4DAnyone's 704x1280 views if it fits the union of their masks
    # (+4%) into that frame, as fdanyone/geometry/crop.py does
    hs = {n: b[3] - b[1] for n, b in boxes.items()}
    hk = hs.get(cfg["ref"], float(np.median(list(hs.values()))))
    fit_views = min(VIEWS[0] / (out["unionSize"][0] * 1.04), VIEWS[1] / (out["unionSize"][1] * 1.04))
    out["heights"] = {"canvasAtK": round(hk), "inputAtK": round(hk * sc), "viewsAtK": round(hk * fit_views),
                      "inputMedian": round(float(np.median(list(hs.values()))) * sc)}
    # the real frame the freeze trains against: cw x ch native pixels around the player at the reference frame
    if cfg["ref"] in boxes:
        try:
            out["crop"] = [*fit_crop(boxes[cfg["ref"]], cw, ch, w, h, margin), cw, ch]
        except CropDoesNotFit as e:
            out["error"] = f"at the reference frame {e}"
    return out


def write_png(path: Path, m: np.ndarray):
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), np.clip(np.rint(m * 255), 0, 255).astype(np.uint8))


def warp(rgb, maps, interp):
    mu, mv, ok = maps
    out = cv2.remap(rgb, mu, mv, interp, borderMode=cv2.BORDER_CONSTANT)
    out[~ok] = 0
    return out


def layers(rgb, n, s, maps, cfg, w, h):
    """The frame warped into a canvas window, with the player's matte there (soft where a matte exists) and the warped
    binary masks of the player and of who's in front (for ignore)."""
    img = warp(rgb, maps, cv2.INTER_LANCZOS4)
    m = cfg["masks"]
    wm = lambda f: warp(f, maps, cv2.INTER_LINEAR)  # noqa: E731
    own, front = wm(load_mask(m / s["player"], n, w, h)), [wm(load_mask(m / o, n, w, h)) for o in s.get("front", [])]
    soft = [wm(load_matte(m, x, n, w, h, cfg.get("matte", False))) for x in [s["player"], *s.get("with", [])]]
    return img, own, front, player_alpha(soft[0], soft[1:], front, cfg.get("grow", 3))


def build(cfg: dict, names: list[str], plans: dict, calib: dict, still: dict, frames_by_n: dict):
    w, h = calib["image_size"]
    bg, ref = cfg.get("bg", [128, 128, 128]), cfg["ref"]
    state = {}
    for name in names:
        p = plans[name]
        d = cfg["out"] / name
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True)
        state[name] = {"dir": d, "enc": Encoder(d / "clip-lossless.mkv", *p["clip"]["size"]), "frames": set(p["frames"])}
    wanted = set().union(*(s["frames"] for s in state.values())) | {ref}
    ref_png = Path(calib.get("frames_dir", "")) / f"{ref:06d}.png"
    for n, rgb in decode_frames(cfg["video"], wanted, w, h):
        if n == ref and ref_png.exists():  # the calibration's own copy of the frame: the numbering must agree
            mine = cv2.cvtColor(cv2.imread(str(ref_png)), cv2.COLOR_BGR2RGB)
            diff = np.abs(mine.astype(int) - rgb.astype(int)).mean() if mine.shape == rgb.shape else 255
            if diff > 1.0:  # a decoder's rounding is well under 1 level; the next frame is ~10 away
                raise SystemExit(f"decoded frame {n} differs from {ref_png} by {diff:.2f}: frame numbering disagrees")
        fr = frames_by_n[n]
        for name in names:
            sst = state[name]
            if n not in sst["frames"]:
                continue
            p, s = plans[name], cfg["sets"][name]
            x0, y0, wc, hc = p["clip"]["window"]
            img, own, front, alpha = layers(rgb, n, s, st.crop_maps(still, fr, w, h, x0, y0, wc, hc), cfg, w, h)
            comp = composite(img, alpha, bg)
            if p["clip"]["scale"] < 1:
                comp = cv2.resize(comp, tuple(p["clip"]["size"]), interpolation=cv2.INTER_AREA)
            sst["enc"].write(comp)
            sst.setdefault("first", comp)
            sst["last"] = comp
            if n == ref:
                x0, y0, cw, ch = p["crop"]
                maps = st.crop_maps(still, fr, w, h, x0, y0, cw, ch)
                img, own, front, alpha = layers(rgb, n, s, maps, cfg, w, h)
                ig = ignore_mask(own, front, cfg.get("grow", 3), cfg.get("near", 200)) * (alpha <= 0)
                # how far taking the lens out moved the reference frame's pixels, on the player
                gu, gv = np.meshgrid(np.arange(x0, x0 + cw), np.arange(y0, y0 + ch))
                lens = np.hypot(maps[0] - gu, maps[1] - gv)[alpha > 0.5]
                sst["K"] = {"real": img, "comp": comp, "alpha": alpha, "ignore": ig, "raw": _raw_crop(rgb, x0, y0, cw, ch),
                            "lensShiftPx": [round(float(np.median(lens)), 2), round(float(lens.max()), 2)]}
    for name in names:
        finish_set(cfg, name, plans[name], state[name], still)


def _raw_crop(rgb, x0, y0, cw, ch):
    """The reference frame's own pixels in the crop window (black off the frame), lens distortion untouched."""
    out = np.zeros((ch, cw, 3), np.uint8)
    H, W = rgb.shape[:2]
    a, b = max(0, x0), max(0, y0)
    c, d = min(W, x0 + cw), min(H, y0 + ch)
    if c > a and d > b:
        out[b - y0:d - y0, a - x0:c - x0] = rgb[b:d, a:c]
    return out


def finish_set(cfg: dict, name: str, p: dict, sst: dict, still: dict):
    d, k = sst["dir"], p["k"]
    sst["enc"].close()
    n = cfg.get("n", FRAMES)
    if sst["enc"].n != n:
        raise SystemExit(f"[{name}] wrote {sst['enc'].n} frames, need {n}")
    x0, y0, cw, ch = p["crop"]
    if "K" not in sst:
        raise SystemExit(f"[{name}] the reference frame was never decoded")
    color = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(d / "clip-lossless.mkv"), "-vf",
         f"setpts=N/{FPS}/TB,scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p", "-r", str(FPS),
         "-c:v", "libx264", "-preset", "slow", "-crf", str(cfg.get("crf", 10)), *color, "-movflags", "+faststart",
         str(d / "input.mp4")])
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(d / "input.mp4"), "-f", "framemd5", str(d / "input.framemd5")])
    md5 = [x.split(",")[-1].strip() for x in (d / "input.framemd5").read_text().splitlines()
           if x and not x.startswith("#")]
    info = probe(d / "input.mp4")
    if len(md5) != n or len(set(md5)) != n or info["r_frame_rate"] != f"{FPS}/1" or int(info["nb_read_frames"]) != n:
        raise SystemExit(f"[{name}] input.mp4: {len(md5)} frames, {len(set(md5))} distinct, {info['r_frame_rate']}")
    Kd = sst["K"]
    src = Encoder(d / "source-4k.mkv", cw, ch)
    black = np.zeros((ch, cw, 3), np.uint8)
    for _ in range(k):
        src.write(black)
    src.write(Kd["real"])
    src.close()
    write_png(d / "masks" / f"{k:06d}.png", Kd["alpha"])
    write_png(d / "ignore" / f"{k:06d}.png", Kd["ignore"])
    K = np.array(still["K"], float)
    focal = round(float(K[0, 0]), 1)
    run_rec = {"set": name, "player": p["player"], "K": k, "FOCAL": focal, "stride": p["stride"],
               "window": p["window"], "frames": p["frames"], "crop": p["crop"], "clip": p["clip"], "containerFps": FPS,
               "fill": p["fill"], "maxCovered": p["maxCovered"], "magnification": p["magnification"],
               "lensShiftPx": Kd["lensShiftPx"],
               "still": {"refFrame": cfg["ref"], "R": still["R"], "C": still["C"],
                         "K": [[focal, 0, round(K[0, 2] - x0, 3)], [0, focal, round(K[1, 2] - y0, 3)], [0, 0, 1]],
                         "note": "pinhole camera of source-4k.mkv's pixels (crop): the reference frame's own R and "
                                 "f; the clip's window is the same camera shifted (and scaled by clip.scale)"},
               "calib": {"path": str(cfg["calib"]), "sha256": sha256(cfg["calib"])},
               "video": {"path": str(cfg["video"]), "sha256": sha256(cfg["video"])},
               "created": dt.datetime.now().astimezone().isoformat(timespec="seconds")}
    (d / "court-run.json").write_text(json.dumps(run_rec, indent=1))
    _sheets(d, sst, k)
    extras = build_extras(cfg, name, d)
    run_rec["extras"] = extras
    (d / "court-run.json").write_text(json.dumps(run_rec, indent=1))
    for rid, r in cfg.get("runs", {}).items():
        if r["set"] == name:
            write_run(cfg, d, rid, r, run_rec)


def build_extras(cfg: dict, name: str, d: Path) -> list[dict]:
    """The other cameras' frames of the freeze (config "extras", in order) around this set's player, each as recon's
    --extra-sources wants it, in <set>/real/<view>/; real/extras.json lists the ones made with their weights."""
    import extra_view

    s, made = cfg["sets"][name], []
    shutil.rmtree(d / "real", ignore_errors=True)
    for e in cfg.get("extras", []):
        try:
            cam = extra_view.make_view(Path(os.path.expanduser(e["video"])), Path(os.path.expanduser(e["calib"])),
                                       e["frame"], Path(os.path.expanduser(e["masks"])), s["player"], s.get("with", []),
                                       s.get("front", []), d / "real" / e["name"], cfg.get("margin", 32),
                                       cfg.get("grow", 3), cfg.get("near", 200), cfg.get("matte", False))
        except FileNotFoundError as err:
            print(f"[{name}] extra view {e['name']} skipped: {err}")
            continue
        made.append({"name": e["name"], "weight": e.get("weight", 1.0), "focal": cam["focal"], "size": cam["size"],
                     "playerPx": cam["playerPx"]})
    if made:
        (d / "real" / "extras.json").write_text(json.dumps(made, indent=1))
    return made


def add_extras(cfg: dict, name: str):
    """--extras-only: the other real views into an already built set and every run folder of it."""
    d = cfg["out"] / name
    rec_path = d / "court-run.json"
    if not rec_path.exists():
        raise SystemExit(f"[{name}] not built yet: {d}")
    run_rec = json.loads(rec_path.read_text())
    run_rec["extras"] = build_extras(cfg, name, d)
    rec_path.write_text(json.dumps(run_rec, indent=1))
    for rid, r in cfg.get("runs", {}).items():
        rd = cfg["out"] / "runs" / rid
        if r["set"] != name or not rd.exists():
            continue
        shutil.rmtree(rd / "real", ignore_errors=True)
        _link_real(d, rd)
        rec = json.loads((rd / "court-run.json").read_text())
        rec["extras"] = run_rec["extras"]
        (rd / "court-run.json").write_text(json.dumps(rec, indent=1))
    print(f"[{name}] other real views: {[e['name'] for e in run_rec['extras']] or 'none'}")


def _link_real(d: Path, rd: Path):
    if (d / "real").exists():
        for f in sorted((d / "real").rglob("*")):
            t = rd / f.relative_to(d)
            if f.is_dir():
                t.mkdir(parents=True, exist_ok=True)
            elif f.suffix != ".jpg":
                t.parent.mkdir(parents=True, exist_ok=True)
                os.link(f, t)


def job_json(rid: str, turbo: bool, focal: float) -> dict:
    return {"id": rid, "name": "Court Side", "kind": "replay", "turbo": bool(turbo), "viewsPerLayer": 16,
            "layerPitches": [-10, 15, 35], "fps": FPS, "frames": FRAMES, "startS": 0, "intent": "",
            "sourceVideo": "source-4k.mkv", "sourceMasks": "masks", "sourceIgnore": "ignore", "sourceFocal": focal}


def write_run(cfg: dict, d: Path, rid: str, r: dict, run_rec: dict):
    if not rid.startswith("court-"):
        raise SystemExit(f"run id {rid} must start with court-")
    rd = cfg["out"] / "runs" / rid
    if rd.exists():
        shutil.rmtree(rd)
    for sub in ("masks", "ignore"):
        (rd / sub).mkdir(parents=True)
        for f in (d / sub).iterdir():
            os.link(f, rd / sub / f.name)
    for f in ("input.mp4", "source-4k.mkv"):
        os.link(d / f, rd / f)
    _link_real(d, rd)
    (rd / "court-run.json").write_text(json.dumps({"id": rid, **run_rec}, indent=1))
    (rd / "job.json").write_text(json.dumps(job_json(rid, r.get("turbo", False), run_rec["FOCAL"]), indent=1))


def _label(img, text):
    out = img.copy()
    scale = max(0.3, img.shape[0] / 1500)
    cv2.putText(out, text, (8, int(36 * scale) + 4), cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 0), max(1, int(2 * scale)),
                cv2.LINE_AA)
    return out


def _sheets(d: Path, sst: dict, k: int):
    """sheet.jpg (first, k, last of the clip; the real frame k; its mask and ignore), edge-k.png (where the people in
    front meet the player at k, 3x), k-vs-ref.png (the reference frame's own pixels | frame k of source-4k | 8x diff)."""
    Kd = sst["K"]
    m3 = lambda m: np.repeat((np.clip(m, 0, 1) * 255).astype(np.uint8)[..., None], 3, -1)  # noqa: E731
    fit = lambda im: cv2.resize(im, (round(im.shape[1] * 720 / im.shape[0]), 720), interpolation=cv2.INTER_AREA)  # noqa: E731
    row = [_label(fit(sst["first"]), "first"), _label(fit(Kd["comp"]), f"k={k}"), _label(fit(sst["last"]), "last"),
           _label(fit(Kd["real"]), "source k"), _label(fit(m3(Kd["alpha"])), "mask k"),
           _label(fit(m3(Kd["ignore"])), "ignore k")]
    sheet = np.concatenate(row, 1)
    cv2.imwrite(str(d / "sheet.jpg"), cv2.cvtColor(sheet, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 90])
    contact = (grow_mask((Kd["alpha"] > 0.5).astype(np.uint8), 8) > 0) & (Kd["ignore"] > 0)
    if contact.any():  # where the people in front meet the player
        ys, xs = np.nonzero(contact)
        cx, cy = int(np.median(xs)), int(np.median(ys))
    else:  # no one in front: the head
        ys, xs = np.nonzero(Kd["alpha"] > 0.5)
        head = ys < ys.min() + 300
        cx, cy = int(xs[head].mean()), int(ys.min()) + 100
    r = 110
    H, W = Kd["alpha"].shape
    a, b = int(np.clip(cx - r, 0, W - 2 * r)), int(np.clip(cy - r, 0, H - 2 * r))
    tiles = [Kd["real"][b:b + 2 * r, a:a + 2 * r], Kd["comp"][b:b + 2 * r, a:a + 2 * r],
             m3(Kd["ignore"][b:b + 2 * r, a:a + 2 * r])]
    edge = np.concatenate([cv2.resize(t, (6 * r, 6 * r), interpolation=cv2.INTER_NEAREST) for t in tiles], 1)
    cv2.imwrite(str(d / f"edge-{k}.png"), cv2.cvtColor(edge, cv2.COLOR_RGB2BGR))
    diff = np.clip(np.abs(Kd["raw"].astype(int) - Kd["real"].astype(int)) * 8, 0, 255).astype(np.uint8)
    cmp_ = np.concatenate([_label(Kd["raw"], "reference frame, own pixels"), _label(Kd["real"], "source-4k frame k"),
                           _label(diff, "|diff| x8")], 1)
    cv2.imwrite(str(d / "k-vs-ref.png"), cv2.cvtColor(cmp_, cv2.COLOR_RGB2BGR))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=Path, required=True)
    ap.add_argument("--sets", default="", help="comma-separated clip sets (default: all)")
    ap.add_argument("--measure-only", action="store_true", help="union boxes and crops only; no video decoded")
    ap.add_argument("--extras-only", action="store_true",
                    help="add the config's other real views to sets already built (and their run folders); no clip work")
    ap.add_argument("--allow-partial", action="store_true",
                    help="measure only the frames that already have a calibration and masks (implies --measure-only)")
    a = ap.parse_args(argv)
    cfg = expand(json.loads(a.config.read_text()))
    names = [x for x in a.sets.split(",") if x] or list(cfg["sets"])
    if a.extras_only:
        for name in names:
            add_extras(cfg, name)
        return
    calib = json.loads(cfg["calib"].read_text())
    frames_by_n = {st.source_frame(fr, t): fr for t, fr in enumerate(calib["frames"])}
    still = st.ref_still_camera(calib, cfg["ref"])
    plans = {name: plan_set(cfg, name, calib, still, frames_by_n, a.allow_partial) for name in names}
    cfg["out"].mkdir(parents=True, exist_ok=True)
    for name, p in plans.items():
        (cfg["out"] / f"measure-{name}.json").write_text(json.dumps(p, indent=1))
        c = p["clip"]
        fit = (f"clip window {c['window'][2]}x{c['window'][3]} at ({c['window'][0]},{c['window'][1]}) scale "
               f"{c['scale']} -> {c['size'][0]}x{c['size'][1]}; source crop "
               + (str(p["crop"]) if "crop" in p else f"NONE: {p.get('error', 'no mask at the reference frame')}"))
        print(f"[{name}] {p['player']} stride {p['stride']} window {p['window'][0]}-{p['window'][1]} k={p['k']}: "
              f"union {p['unionSize'][0]:.0f}x{p['unionSize'][1]:.0f} px over {p['measured']} frames; {fit}; "
              f"player {p['heights']['inputAtK']} px tall at k in input.mp4, ~{p['heights']['viewsAtK']} px in the "
              f"views; {len(p['fill'])} frames need fill (max covered {p['maxCovered']:.1%}); "
              f"magnified {p['magnification'][0]}-{p['magnification'][1]}x"
              + (f"; {len(p['skipped'])} frames not measured yet" if p["skipped"] else ""))
    if a.measure_only or a.allow_partial:
        return
    bad = [n for n, p in plans.items() if "crop" not in p]
    if bad:
        raise SystemExit(f"not built: {', '.join(bad)} (their paths don't fit the crop)")
    build(cfg, names, plans, calib, still, frames_by_n)
    for name in names:
        print(f"[{name}] -> {cfg['out'] / name}")


if __name__ == "__main__":
    main()
