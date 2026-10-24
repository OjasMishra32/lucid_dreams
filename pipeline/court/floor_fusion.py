"""Court Side: the floor from above, fused from every frame of the source video (stream E, the world's look).

The bundle's court/floor.jpg is a top-down picture of the real floor (assemble.py floor_from_mosaic: layers' 1080p
pan mosaic, 20 mm texels). From the seat the headset resolves ~2 mm across the camera's ray and the 1080p source
~1.7 mm, so across the ray that texture throws away most of the detail; along the ray (a low camera, grazing light)
the source itself is the limit, and 4K halves it. This rebuilds the floor straight from the full-resolution source:
every unique frame is warped onto a top-down grid (finer across the ray than along it), people (layers' masks,
floor-level person boxes) and any fixed overlay are left out, and each texel is a robust fusion of every frame that
saw it: a per-texel median, a per-frame sub-pixel shift against it (the registration's own error), then a mean
weighted by each frame's footprint on the floor and its motion blur, over the samples near the median.

Everything about the broadcast comes in as files and arguments (cams.json, the video, masks, frame lists): nothing
here is specific to one clip. Camera model (layers' cams.json, calib_A's): x_cam = R (X - C); xn = x_cam / z;
xd = xn (1 + k1 |xn|^2); u = f xd + cx, at the cams' own image size (scaled to the video's).

  floor_fusion.py plan   --cams cams.json --video-size 3840x2160 --court 28.65x15.24 --res 0.008x0.0025 --tiles 72
                         [--frames A-B] [--dups diffs.npy] --out plan.json
  floor_fusion.py tile   --plan plan.json --tile N --cams cams.json --video source.mp4 [--masks dir/%06d.png]
                         [--det det.json] [--exclude x0,y0,x1,y1 ...] --out tiles/
  floor_fusion.py stitch --plan plan.json --tiles tiles/ --out master/      (floor.png, count.png)
  floor_fusion.py ship   --master master/ --size 2048x1088 --out court/     (floor.jpg, floor-seen.png)
  floor_fusion.py sheet  --court court.json --before floor.jpg --after floor.jpg --out sheet.png
  floor_fusion.py probe  --video source.mp4                                 (can this python decode it?)
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Iterator

import cv2
import numpy as np

log = logging.getLogger("floor_fusion")

MARGIN = 8  # texels round each tile, so a per-frame shift never pulls in a hole at the tile's edge
MAX_SHIFT = 3.0  # texels: a larger registration correction is a bad match, not a shift
MIN_COUNT = 3  # samples a texel needs to count as seen
BAND = 10.0  # luma levels: samples this close to the median (or 2.5 robust sigmas) take part in the mean
CHUNK = 65536  # texels per sort in the median


@dataclass
class Cam:
    """One frame's camera in the video's pixels (see the module doc)."""

    R: np.ndarray
    f: float
    cx: float
    cy: float
    k1: float
    C: np.ndarray
    blur: float = 0.0  # pixels of motion blur (half the camera's turn between neighbouring frames)


def undistort(xd: np.ndarray, yd: np.ndarray, k1: float, it: int = 8) -> tuple[np.ndarray, np.ndarray]:
    """Invert xd = xn (1 + k1 r^2) (Newton on the radius)."""
    rd = np.hypot(xd, yd)
    r = rd.copy()
    for _ in range(it):
        r = r - (r + k1 * r ** 3 - rd) / (1 + 3 * k1 * r * r)
    s = np.where(rd > 1e-12, r / np.maximum(rd, 1e-12), 1.0)
    return xd * s, yd * s


def load_cams(cams: dict | str | Path, video_width: int, frames: Iterable[int] | None = None,
              skip: Iterable[int] = ()) -> dict[int, Cam]:
    """cams.json (or its dict) at the video's size: repeats (a copy of another frame) and strobes are left out, as
    are `skip` (frames that are byte-for-byte repeats in the source); `frames` limits the set."""
    c = json.loads(Path(cams).read_text()) if not isinstance(cams, dict) else cams
    s = video_width / c["size"][0]
    C = np.asarray(c["C"], float)
    keep = None if frames is None else set(frames)
    skip = set(skip)
    out = {}
    for k, v in c["frames"].items():
        n = int(k)
        if (keep is not None and n not in keep) or n in skip or v.get("repeat_of") is not None or v.get("strobe"):
            continue
        out[n] = Cam(np.asarray(v["R"], float), v["f"] * s, (c["cx"] + 0.5) * s - 0.5, (c["cy"] + 0.5) * s - 0.5,
                     float(c["k1"]), C)
    ns = sorted(out)
    for i, n in enumerate(ns):
        a, b = out[ns[max(0, i - 1)]], out[ns[min(len(ns) - 1, i + 1)]]
        turn = np.linalg.norm(cv2.Rodrigues(b.R @ a.R.T)[0]) / max(1, min(len(ns) - 1, i + 1) - max(0, i - 1))
        out[n].blur = 0.5 * turn * out[n].f
    return out


def project(cam: Cam, P: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """World points (..., 3) to pixels: (u, v, in front)."""
    x = (P - cam.C) @ cam.R.T
    z = x[..., 2]
    ok = z > 1e-6
    zs = np.where(ok, z, 1.0)
    xn, yn = x[..., 0] / zs, x[..., 1] / zs
    s = 1 + cam.k1 * (xn * xn + yn * yn)
    return cam.f * xn * s + cam.cx, cam.f * yn * s + cam.cy, ok


def grid(nx: int, nz: int, length: float, width: float) -> tuple[np.ndarray, np.ndarray]:
    """Texel centres along x (columns) and z (rows) of the court's top-down grid (row 0 at z = -width/2)."""
    return (np.arange(nx) + 0.5) * (length / nx) - length / 2, (np.arange(nz) + 0.5) * (width / nz) - width / 2


def make_plan(cams: dict[int, Cam], frames: list[int], length: float, width: float, res_x: float, res_z: float,
              tiles: int, size: tuple[int, int]) -> dict:
    """The grid, the floor any frame sees (on a 0.1 m lattice), and ~`tiles` tiles over its bounding box, each
    listing the frames that see any of it. Tiles nobody sees are dropped."""
    nx, nz = int(round(length / res_x)), int(round(width / res_z))
    W, H = size
    lx, lz = grid(int(length / 0.1), int(width / 0.1), length, width)
    X, Z = np.meshgrid(lx, lz)
    P = np.stack([X, np.zeros_like(X), Z], -1)
    seen_by = {}
    any_seen = np.zeros(X.shape, bool)
    for n in frames:
        u, v, ok = project(cams[n], P)
        inside = ok & (u >= 0) & (u <= W - 1) & (v >= 0) & (v <= H - 1)
        if inside.any():
            seen_by[n] = inside
            any_seen |= inside
    if not any_seen.any():
        raise SystemExit("no frame sees the court")
    zi, xi = np.nonzero(any_seen)
    # the lattice's bbox in grid texels (one lattice cell of slack each way)
    x0 = max(0, int((lx[xi.min()] - 0.1 + length / 2) / res_x))
    x1 = min(nx, int(np.ceil((lx[xi.max()] + 0.1 + length / 2) / res_x)))
    z0 = max(0, int((lz[zi.min()] - 0.1 + width / 2) / res_z))
    z1 = min(nz, int(np.ceil((lz[zi.max()] + 0.1 + width / 2) / res_z)))
    # near-square tiles in metres, ~`tiles` of them
    wm, hm = (x1 - x0) * res_x, (z1 - z0) * res_z
    tx = max(1, int(round(np.sqrt(tiles * wm / hm))))
    tz = max(1, int(round(tiles / tx)))
    xs = np.linspace(x0, x1, tx + 1).round().astype(int)
    zs = np.linspace(z0, z1, tz + 1).round().astype(int)
    out = []
    for j in range(tz):
        for i in range(tx):
            a, b, c, d = xs[i], xs[i + 1], zs[j], zs[j + 1]
            # the lattice cells inside this tile, with the margin
            mx = (lx >= (a - MARGIN) * res_x - length / 2) & (lx <= (b + MARGIN) * res_x - length / 2)
            mz = (lz >= (c - MARGIN) * res_z - width / 2) & (lz <= (d + MARGIN) * res_z - width / 2)
            cell = mz[:, None] & mx[None, :]
            fr = sorted(n for n, s in seen_by.items() if (s & cell).any())
            if fr:
                out.append(dict(id=len(out), x0=int(a), x1=int(b), z0=int(c), z1=int(d), frames=fr))
    return dict(length=length, width=width, nx=nx, nz=nz, res=[length / nx, width / nz], size=[W, H],
                bbox=[x0, x1, z0, z1], tiles=out)


def tile_points(plan: dict, t: dict) -> tuple[np.ndarray, tuple[int, int]]:
    """The tile's texel centres with the margin, as world points (h, w, 3)."""
    gx, gz = grid(plan["nx"], plan["nz"], plan["length"], plan["width"])
    rx, rz = plan["res"]
    ix = np.arange(t["x0"] - MARGIN, t["x1"] + MARGIN)
    iz = np.arange(t["z0"] - MARGIN, t["z1"] + MARGIN)
    x = (ix + 0.5) * rx - plan["length"] / 2
    z = (iz + 0.5) * rz - plan["width"] / 2
    X, Z = np.meshgrid(x, z)
    return np.stack([X, np.zeros_like(X), Z], -1), (len(iz), len(ix))


def frame_weight(cam: Cam, P: np.ndarray) -> float:
    """How much a frame's sample is worth at P: 1 / its pixel's footprint on the floor (r^3 / (f^2 h)), less for
    motion blur."""
    r = float(np.linalg.norm(P - cam.C))
    area = r ** 3 / (cam.f ** 2 * max(cam.C[1], 0.1))
    return 1.0 / area / (1.0 + cam.blur ** 2)


def warp(frame: np.ndarray, cam: Cam, P: np.ndarray, mask: np.ndarray | None, exclude: list[tuple] = (),
         mask_scale: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    """One frame onto the tile's texels: (rgb uint8 (h, w, 3), valid bool (h, w)). `mask` (people, at the cams' size,
    non-zero = leave out) and `exclude` rects (cams' pixels) are read at the same rays."""
    H, W = frame.shape[:2]
    u, v, ok = project(cam, P)
    u32, v32 = u.astype(np.float32), v.astype(np.float32)
    rgb = cv2.remap(frame, u32, v32, cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT)
    valid = ok & (u >= 1) & (u <= W - 2) & (v >= 1) & (v <= H - 2)
    mu, mv = (u + 0.5) / mask_scale - 0.5, (v + 0.5) / mask_scale - 0.5
    if mask is not None:
        m = cv2.remap(mask, mu.astype(np.float32), mv.astype(np.float32), cv2.INTER_NEAREST,
                     borderMode=cv2.BORDER_CONSTANT, borderValue=255)
        valid &= m == 0
    for x0, y0, x1, y1 in exclude:
        valid &= ~((mu >= x0) & (mu < x1) & (mv >= y0) & (mv < y1))
    return rgb, valid


def luma(rgb: np.ndarray) -> np.ndarray:
    """BGR uint8 to luma (float32)."""
    return (0.0722 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.2126 * rgb[..., 2]).astype(np.float32)


def median_luma(Y: np.ndarray, V: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per texel over frames (F, n): the median luma of the valid samples, a robust sigma (IQR / 1.35) and the count."""
    F, n = Y.shape
    med = np.zeros(n, np.float32)
    sig = np.zeros(n, np.float32)
    cnt = V.sum(0).astype(np.int32)
    for a in range(0, n, CHUNK):
        b = min(n, a + CHUNK)
        S = np.where(V[:, a:b], Y[:, a:b], np.inf)
        S.sort(0)
        c = cnt[a:b]
        k = np.arange(b - a)
        has = c > 0
        q = lambda p: S[np.clip(((c - 1) * p).round().astype(int), 0, F - 1), k]  # noqa: E731
        with np.errstate(invalid="ignore"):  # inf - inf where a texel has under 4 samples (not used)
            med[a:b] = np.where(has, q(0.5), 0)
            sig[a:b] = np.where(c >= 4, (q(0.75) - q(0.25)) / 1.35, 0)
    return med, sig, cnt


def estimate_shift(Y: np.ndarray, valid: np.ndarray, ref: np.ndarray) -> tuple[float, float]:
    """The sub-texel (dx, dz) that moves Y onto ref (phase correlation; where Y isn't valid it takes ref's value),
    (0, 0) when the match is weak or the shift is implausibly large."""
    if valid.mean() < 0.3:
        return 0.0, 0.0
    a = np.where(valid, Y, ref).astype(np.float32)
    win = cv2.createHanningWindow(a.shape[::-1], cv2.CV_32F)
    (sx, sy), resp = cv2.phaseCorrelate(a, ref.astype(np.float32), win)
    if resp < 0.05 or abs(sx) > MAX_SHIFT or abs(sy) > MAX_SHIFT:
        return 0.0, 0.0
    return float(sx), float(sy)


def shift(img: np.ndarray, dx: float, dz: float, interp: int) -> np.ndarray:
    M = np.float32([[1, 0, dx], [0, 1, dz]])
    return cv2.warpAffine(img, M, (img.shape[1], img.shape[0]), flags=interp, borderMode=cv2.BORDER_CONSTANT)


def fuse(samples: list[np.ndarray], valid: list[np.ndarray], weights: list[float], align: bool = True
         ) -> tuple[np.ndarray, np.ndarray, list[tuple[float, float]]]:
    """The robust fusion of one tile's frames: (bgr uint8 (h, w, 3), count uint16 (h, w), per-frame shifts)."""
    h, w = samples[0].shape[:2]
    V = np.stack([v.reshape(-1) for v in valid])
    Y = np.stack([luma(s).reshape(-1) for s in samples])
    med, _, _ = median_luma(Y, V)
    shifts = [(0.0, 0.0)] * len(samples)
    if align:
        ref = med.reshape(h, w)
        for i in range(len(samples)):
            dx, dz = estimate_shift(Y[i].reshape(h, w), valid[i], ref)
            if dx or dz:
                shifts[i] = (dx, dz)
                samples[i] = shift(samples[i], dx, dz, cv2.INTER_CUBIC)
                # a sample is valid only where every texel it came from was
                v = shift(valid[i].astype(np.uint8) * 255, dx, dz, cv2.INTER_LINEAR) == 255
                valid[i] = v
                V[i] = v.reshape(-1)
                Y[i] = luma(samples[i]).reshape(-1)
        med, sig, cnt = median_luma(Y, V)
    else:
        med, sig, cnt = median_luma(Y, V)
    band = np.maximum(BAND, 2.5 * sig)
    acc = np.zeros((h * w, 3), np.float64)
    wsum = np.zeros(h * w, np.float64)
    used = np.zeros(h * w, np.int32)
    for i, s in enumerate(samples):
        keep = V[i] & (np.abs(Y[i] - med) <= band)
        acc[keep] += weights[i] * s.reshape(-1, 3)[keep]
        wsum[keep] += weights[i]
        used += keep
    out = np.where(wsum[:, None] > 0, acc / np.maximum(wsum, 1e-30)[:, None], 0)
    count = np.where(cnt >= MIN_COUNT, used, 0)
    return np.clip(out.round(), 0, 255).astype(np.uint8).reshape(h, w, 3), count.astype(np.uint16).reshape(h, w), shifts


def run_tiles(plan: dict, tiles: list[int], cams: dict[int, Cam], frames: Iterable[tuple[int, np.ndarray]],
              masks: Callable[[int], np.ndarray | None] | None, out: Path, exclude: list[tuple] = (),
              mask_scale: float | None = None) -> list[dict]:
    """Fuse tiles from one pass over (n, frame) pairs (frames a tile doesn't need are skipped) and write, per tile,
    tile-NNN.png (BGR), tile-NNN-count.png (16-bit) and tile-NNN.json (frames used, shifts, seconds) to `out`."""
    out.mkdir(parents=True, exist_ok=True)
    jobs = []
    for k in tiles:
        t = plan["tiles"][k]
        P, (h, w) = tile_points(plan, t)
        jobs.append(dict(id=k, need=set(t["frames"]), P=P, h=h, w=w, centre=P[h // 2, w // 2], samples=[], valid=[],
                         weights=[], used=[]))
    t0 = time.time()
    for n, frame in frames:
        js = [j for j in jobs if n in j["need"]]
        if not js:
            continue
        cam = cams[n]
        m = masks(n) if masks else None
        ms = mask_scale or (plan["size"][0] / m.shape[1] if m is not None else 1.0)
        for j in js:
            rgb, ok = warp(frame, cam, j["P"], m, exclude, ms)
            if ok.mean() < 0.002:
                continue
            j["samples"].append(rgb)
            j["valid"].append(ok)
            j["weights"].append(frame_weight(cam, j["centre"]))
            j["used"].append(n)
    t1 = time.time()
    infos = []
    for j in jobs:
        h, w = j["h"], j["w"]
        stem = out / f"tile-{j['id']:03d}"
        if not j["samples"]:
            rgb, count, shifts = np.zeros((h, w, 3), np.uint8), np.zeros((h, w), np.uint16), []
        else:
            rgb, count, shifts = fuse(j["samples"], j["valid"], j["weights"])
        j["samples"] = j["valid"] = None
        core = (slice(MARGIN, h - MARGIN), slice(MARGIN, w - MARGIN))
        cv2.imwrite(str(stem) + ".png", rgb[core])
        cv2.imwrite(str(stem) + "-count.png", count[core])
        info = dict(tile=j["id"], frames=j["used"], shifts=[[round(a, 3), round(b, 3)] for a, b in shifts],
                    decodeSeconds=round(t1 - t0, 1), seconds=round(time.time() - t0, 1),
                    seen=float((count[core] > 0).mean()))
        Path(str(stem) + ".json").write_text(json.dumps(info))
        log.info("tile %d: %d frames, %.0f%% seen, %.0f s", j["id"], len(j["used"]), 100 * info["seen"],
                 info["seconds"])
        infos.append(info)
    return infos


def run_tile(plan: dict, tile: int, cams: dict[int, Cam], frames: Iterable[tuple[int, np.ndarray]],
             masks: Callable[[int], np.ndarray | None] | None, out: Path, exclude: list[tuple] = (),
             mask_scale: float | None = None) -> dict:
    """run_tiles for one tile."""
    return run_tiles(plan, [tile], cams, frames, masks, out, exclude, mask_scale)[0]


def stitch(plan: dict, tiles: Path) -> tuple[np.ndarray, np.ndarray]:
    """The whole court's grid from the tiles: (bgr uint8 (nz, nx, 3), count uint16 (nz, nx)); unseen texels are 0."""
    rgb = np.zeros((plan["nz"], plan["nx"], 3), np.uint8)
    count = np.zeros((plan["nz"], plan["nx"]), np.uint16)
    missing = []
    for t in plan["tiles"]:
        stem = tiles / f"tile-{t['id']:03d}"
        a = cv2.imread(str(stem) + ".png", cv2.IMREAD_COLOR)
        c = cv2.imread(str(stem) + "-count.png", cv2.IMREAD_UNCHANGED)
        if a is None or c is None:
            missing.append(t["id"])
            continue
        rgb[t["z0"]:t["z1"], t["x0"]:t["x1"]] = a
        count[t["z0"]:t["z1"], t["x0"]:t["x1"]] = c
    if missing:
        raise SystemExit(f"tiles missing: {missing}")
    return rgb, count


def ship(rgb: np.ndarray, count: np.ndarray, size: tuple[int, int]) -> tuple[np.ndarray, np.ndarray, list[float]]:
    """The bundle's floor at `size` (w, h): (floor bgr uint8, seen bool, hardwood sRGB 0-1 in RGB order); unseen
    floor is the hardwood colour (the median of the seen floor), as assemble.py writes it."""
    seen_full = count >= MIN_COUNT
    w, h = size
    # area-average only the seen texels, so the unseen black never bleeds into the floor's edge
    wgt = cv2.resize(seen_full.astype(np.float32), (w, h), interpolation=cv2.INTER_AREA)
    acc = cv2.resize(rgb.astype(np.float32) * seen_full[..., None], (w, h), interpolation=cv2.INTER_AREA)
    seen = wgt >= 0.5
    img = acc / np.maximum(wgt, 1e-6)[..., None]
    hard_bgr = np.median(img[seen], 0) if seen.any() else np.array([84.0, 133.0, 181.0])
    floor = np.where(seen[..., None], img, np.round(hard_bgr))
    return np.clip(floor.round(), 0, 255).astype(np.uint8), seen, [round(float(v) / 255, 3) for v in hard_bgr[::-1]]


def seat_sheet(court: dict, floors: dict[str, np.ndarray], px_per_deg: float = 19.0) -> np.ndarray:
    """Before/after crops of the floor as the judge sees it: from the seat (eye 1.15 m, looking at the pair) and
    walking (standing 1 m from the pair, looking at the floor by them), at the headset's angular resolution."""
    L, Wd = court["court"]["length"], court["court"]["width"]
    pc = np.asarray(court["seat"]["pairCentre"], float)
    cam = np.asarray(court["camera"]["centre"], float)
    ax = (cam - pc)[[0, 2]]
    ax /= np.linalg.norm(ax)
    seat = pc + np.array([ax[0], 0, ax[1]]) * court["seat"]["distance"]
    views = [("seat", seat + [0, 1.15, 0], pc + [0, 0.3, 0]),
             ("walking", pc + np.array([ax[0], 0, ax[1]]) * 1.0 + [0.6, 1.6, 0.6], pc + [0.3, 0, 0.3])]
    f = px_per_deg * 180 / np.pi
    Wv, Hv = 900, 560
    rows = []
    for name, eye, target in views:
        fwd = target - eye
        fwd /= np.linalg.norm(fwd)
        right = np.cross(fwd, [0.0, 1.0, 0.0])
        right /= np.linalg.norm(right)
        down = np.cross(fwd, right)
        ys, xs = np.mgrid[0:Hv, 0:Wv].astype(float)
        d = ((xs - Wv / 2)[..., None] * right + (ys - Hv / 2)[..., None] * down + f * fwd)
        t = -eye[1] / np.where(d[..., 1] < -1e-9, d[..., 1], np.nan)
        X, Z = eye[0] + t * d[..., 0], eye[2] + t * d[..., 2]
        row = []
        for label, img in floors.items():
            nz, nx = img.shape[:2]
            u = ((X + L / 2) / L * nx - 0.5).astype(np.float32)
            v = ((Z + Wd / 2) / Wd * nz - 0.5).astype(np.float32)
            r = cv2.remap(img, u, v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
            r[~np.isfinite(t)] = 0
            cv2.putText(r, f"{name}: {label} ({nx}x{nz})", (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
            row.append(r)
        rows.append(np.concatenate(row, 1))
    return np.concatenate(rows, 0)


# ---------------- the video ----------------

def read_frames(video: str, wanted: Iterable[int]) -> Iterator[tuple[int, np.ndarray]]:
    """(n, BGR frame) for each wanted frame index (0-based, in order), decoding the video once from the start.
    OpenCV first; PyAV or an ffmpeg binary if this OpenCV can't decode the codec (AV1 needs a dav1d/aom build)."""
    want = sorted(set(wanted))
    if not want:
        return
    last = want[-1]
    for reader in (_read_cv2, _read_av, _read_ffmpeg):
        try:
            it = reader(video)
            first = next(it)
        except Exception as e:  # noqa: BLE001 - try the next decoder
            log.info("%s can't decode %s: %s", reader.__name__, video, e)
            continue
        log.info("decoding %s with %s", video, reader.__name__)
        ws = set(want)
        n, frame = 0, first
        while True:
            if n in ws:
                yield n, frame
            if n >= last:
                return
            try:
                frame = next(it)
            except StopIteration:
                raise SystemExit(f"{video} ended at frame {n}, wanted up to {last}") from None
            n += 1
    raise SystemExit(f"no decoder here reads {video}")


def _read_cv2(video: str) -> Iterator[np.ndarray]:
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise RuntimeError("not opened")
    ok, f = cap.read()
    if not ok or f is None:
        raise RuntimeError("no first frame")
    yield f
    while True:
        ok, f = cap.read()
        if not ok:
            return
        yield f


def _read_av(video: str) -> Iterator[np.ndarray]:
    import av

    with av.open(video) as c:
        s = c.streams.video[0]
        s.thread_type = "AUTO"
        for fr in c.decode(s):
            yield fr.to_ndarray(format="bgr24")


def _read_ffmpeg(video: str) -> Iterator[np.ndarray]:
    exe = "ffmpeg"
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001 - fall back to PATH
        pass
    probe = subprocess.run([exe, "-v", "error", "-i", video, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "bgr24",
                            "-"], capture_output=True, check=True)
    cap = cv2.VideoCapture(video)  # the size only (opening works even without the codec)
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if W * H * 3 != len(probe.stdout):
        raise RuntimeError("frame size unknown")
    p = subprocess.Popen([exe, "-v", "error", "-i", video, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                         stdout=subprocess.PIPE)
    try:
        while True:
            b = p.stdout.read(W * H * 3)
            if len(b) < W * H * 3:
                return
            yield np.frombuffer(b, np.uint8).reshape(H, W, 3)
    finally:
        p.kill()


def single_frame(plan: dict, cams: dict[int, Cam], n: int, frame: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """One frame alone on the whole grid (for comparison): (bgr, valid)."""
    gx, gz = grid(plan["nx"], plan["nz"], plan["length"], plan["width"])
    X, Z = np.meshgrid(gx, gz)
    P = np.stack([X, np.zeros_like(X), Z], -1)
    return warp(frame, cams[n], P, None)


# ---------------- the command line ----------------

def _pair(s: str, typ=float) -> tuple:
    a, b = s.lower().split("x")
    return typ(a), typ(b)


def _dups(path: str | None) -> set[int]:
    """Frames that repeat the one before (layers' diffs: frame i+1 vs i below 0.5)."""
    if not path:
        return set()
    d = np.load(path)
    return {int(k) + 1 for k in np.where(d < 0.5)[0]}


def _people(masks: str | None, det: str | None, cams_json: dict) -> Callable[[int], np.ndarray | None] | None:
    """The people mask per frame at the cams' size: layers' union masks dilated 15 px, plus floor-level person
    boxes from det.json (as layers' mosaic.py leaves them out)."""
    if not masks and not det:
        return None
    W, H = cams_json["size"]
    boxes = json.loads(Path(det).read_text()) if det else {}
    kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    cache: dict[int, np.ndarray] = {}

    def get(n: int) -> np.ndarray | None:
        if n in cache:
            return cache[n]
        m = np.zeros((H, W), np.uint8)
        if masks:
            p = masks % n
            img = cv2.imread(p, cv2.IMREAD_GRAYSCALE)
            if img is not None:
                m = np.maximum(m, cv2.dilate((img > 0).astype(np.uint8) * 255, kern))
        for x0, y0, x1, y1, *_ in boxes.get(str(n), []):
            h = y1 - y0
            if h < 60:
                continue
            px, py = 0.12 * (x1 - x0) + 4, 0.05 * h + 4
            m[max(0, int(y0 - py)):int(y1 + py) + 1, max(0, int(x0 - px)):int(x1 + px) + 1] = 255
        cache.clear()
        cache[n] = m
        return m

    return get


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan")
    p.add_argument("--cams", required=True)
    p.add_argument("--video-size", required=True)
    p.add_argument("--court", required=True, help="LENGTHxWIDTH metres")
    p.add_argument("--res", required=True, help="RES_XxRES_Z metres per texel")
    p.add_argument("--tiles", type=int, default=72)
    p.add_argument("--frames", help="A-B, inclusive")
    p.add_argument("--dups")
    p.add_argument("--out", required=True)
    t = sub.add_parser("tile")
    t.add_argument("--plan", required=True)
    t.add_argument("--tile", type=int, nargs="+", required=True, help="tile ids (one decode serves them all)")
    t.add_argument("--cams", required=True)
    t.add_argument("--video", required=True)
    t.add_argument("--masks", help="printf pattern at the cams' size, e.g. dir/%%06d.png")
    t.add_argument("--det")
    t.add_argument("--exclude", nargs="*", default=[], help="x0,y0,x1,y1 in the cams' pixels")
    t.add_argument("--out", required=True)
    s = sub.add_parser("stitch")
    s.add_argument("--plan", required=True)
    s.add_argument("--tiles", required=True)
    s.add_argument("--out", required=True)
    h = sub.add_parser("ship")
    h.add_argument("--master", required=True)
    h.add_argument("--size", required=True, help="WxH")
    h.add_argument("--out", required=True)
    pr = sub.add_parser("probe")
    pr.add_argument("--video", required=True)
    pr.add_argument("--frames", type=int, default=60)
    k = sub.add_parser("sheet")
    k.add_argument("--court", required=True)
    k.add_argument("--before", required=True)
    k.add_argument("--after", required=True)
    k.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    if a.cmd == "plan":
        cj = json.loads(Path(a.cams).read_text())
        W, H = _pair(a.video_size, int)
        fr = None
        if a.frames:
            lo, hi = (int(v) for v in a.frames.split("-"))
            fr = range(lo, hi + 1)
        cams = load_cams(cj, W, fr, _dups(a.dups))
        L, Wd = _pair(a.court)
        rx, rz = _pair(a.res)
        plan = make_plan(cams, sorted(cams), L, Wd, rx, rz, a.tiles, (W, H))
        Path(a.out).write_text(json.dumps(plan))
        nf = len({n for t in plan["tiles"] for n in t["frames"]})
        print(f"PLAN {len(plan['tiles'])} tiles over {plan['nx']}x{plan['nz']} texels, {nf} frames")
    elif a.cmd == "tile":
        plan = json.loads(Path(a.plan).read_text())
        cj = json.loads(Path(a.cams).read_text())
        cams = load_cams(cj, plan["size"][0])
        wanted = sorted({n for k in a.tile for n in plan["tiles"][k]["frames"]})
        ex = [tuple(float(v) for v in e.split(",")) for e in a.exclude]
        infos = run_tiles(plan, a.tile, cams, read_frames(a.video, wanted), _people(a.masks, a.det, cj),
                          Path(a.out), ex, plan["size"][0] / cj["size"][0])
        for info in infos:
            print(f"TILE_OK {info['tile']} frames {len(info['frames'])} seen {info['seen']:.3f} {info['seconds']} s")
    elif a.cmd == "stitch":
        plan = json.loads(Path(a.plan).read_text())
        rgb, count = stitch(plan, Path(a.tiles))
        out = Path(a.out)
        out.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out / "floor.png"), rgb)
        cv2.imwrite(str(out / "count.png"), count)
        print(f"STITCH_OK {rgb.shape[1]}x{rgb.shape[0]}, {100 * (count >= MIN_COUNT).mean():.1f}% of the court seen")
    elif a.cmd == "ship":
        m = Path(a.master)
        rgb = cv2.imread(str(m / "floor.png"), cv2.IMREAD_COLOR)
        count = cv2.imread(str(m / "count.png"), cv2.IMREAD_UNCHANGED)
        floor, seen, hardwood = ship(rgb, count, _pair(a.size, int))
        out = Path(a.out)
        out.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out / "floor.jpg"), floor, [cv2.IMWRITE_JPEG_QUALITY, 92])
        cv2.imwrite(str(out / "floor-seen.png"), (seen * 255).astype(np.uint8))
        print(f"SHIP_OK {floor.shape[1]}x{floor.shape[0]}, {100 * seen.mean():.1f}% seen, hardwood {hardwood}")
    elif a.cmd == "probe":
        t0 = time.time()
        got = [n for n, f in read_frames(a.video, range(a.frames))]
        print(f"PROBE_OK {len(got)} frames in {time.time() - t0:.1f} s")
    elif a.cmd == "sheet":
        court = json.loads(Path(a.court).read_text())
        sheet = seat_sheet(court, {"before": cv2.imread(a.before), "after": cv2.imread(a.after)})
        cv2.imwrite(a.out, sheet)
        print(f"SHEET_OK {a.out}")


if __name__ == "__main__":
    sys.exit(main())
