"""Which frames of a phone video make a good photo folder for LHM++ (numpy only; video_frames.py does the decoding).

LHM++ shapes one person from up to 16 photos, so a family clip should give it the sharpest frames that also differ
from each other (a turn, another pose), not twelve copies of the best one.

Per sampled frame, over the person's region (a box in fractions of the frame, else the centre 60%):
  sharpness   variance of the Laplacian of the grey, block-downscaled region (values are only comparable inside one
              clip with one box: the downscale factor depends on the region's size)
  signature   a 24 x 24 grey thumbnail of the same region, contrast-normalised, so two signatures are close when the
              person looks the same and far when they turned, moved or the scene changed
Rejected first, with the reason counted: mostly black or white, flat (a fade), either side of a cut (a transition),
far less sharp than the clip's best (blurred). Then a greedy pick: start from the sharpest frame; each next frame is
the allowed candidate (at least `min_gap` seconds from every pick, at least `dup` signature distance from every pick,
so no near-duplicates) that maximises its distance to the nearest pick, weighted by its sharpness. If that can't reach
8 frames, the gap and the duplicate limit are halved (up to 3 times, then the gap goes to 0) rather than returning
fewer; if it still can't, the result says so instead of padding with clones. Never more than 16 (LHM++'s limit).
"""

from __future__ import annotations

import math
import struct
import zlib
from dataclasses import dataclass, field

import numpy as np

MAX_FRAMES = 16  # lhmpp_avatar.py reads at most this many photos
MIN_FRAMES = 8
SIG_SIZE = (24, 24)
CENTRE_BOX = (0.2, 0.2, 0.8, 0.8)
SHARP_SIDE = 256  # the region is block-downscaled to at most this many pixels on its long side before the Laplacian
DUP = 0.2  # signature distance under which two frames are the same picture
CUT = 0.75  # signature distance between neighbouring samples that means a cut
BLUR_FRAC = 0.35  # sharper than this fraction of the clip's 90th-percentile sharpness, or it is blurred
STD_FLOOR = 0.05


# ------------------------------------------------------------------------------------------------ pixels
def to_grey(rgb: np.ndarray) -> np.ndarray:
    """(H, W, 3) values 0..255 (uint8 or float) -> (H, W) luma in 0..1."""
    a = np.asarray(rgb, dtype=np.float64)
    if a.ndim == 2:
        return a / 255.0
    return (a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114) / 255.0


def crop_box(img: np.ndarray, box: tuple[float, float, float, float] | None) -> np.ndarray:
    """The region `box` (x0, y0, x1, y1 as fractions of the frame; None: the centre 60%)."""
    x0, y0, x1, y1 = box or CENTRE_BOX
    h, w = img.shape[:2]
    r0, r1 = int(round(y0 * h)), max(int(round(y1 * h)), int(round(y0 * h)) + 1)
    c0, c1 = int(round(x0 * w)), max(int(round(x1 * w)), int(round(x0 * w)) + 1)
    return img[r0:r1, c0:c1]


def block_downscale(img: np.ndarray, max_side: int) -> np.ndarray:
    """Mean over whole blocks, by the smallest integer factor that brings the long side to `max_side` or less."""
    h, w = img.shape[:2]
    f = math.ceil(max(h, w) / max_side)
    if f <= 1:
        return np.asarray(img, dtype=np.float64)
    hh, ww = h // f, w // f
    a = np.asarray(img[: hh * f, : ww * f], dtype=np.float64)
    return a.reshape(hh, f, ww, f, *a.shape[2:]).mean(axis=(1, 3))


def resize_area(g: np.ndarray, h: int, w: int) -> np.ndarray:
    """(H, W) -> (h, w) by the mean of each cell (an integral image, so any ratio works)."""
    g = np.asarray(g, dtype=np.float64)
    H, W = g.shape
    if H < h or W < w:  # smaller than the target: nearest, there is nothing to average
        return g[np.minimum(np.arange(h) * H // h, H - 1)][:, np.minimum(np.arange(w) * W // w, W - 1)]
    r = np.floor(np.linspace(0, H, h + 1)).astype(int)
    c = np.floor(np.linspace(0, W, w + 1)).astype(int)
    S = np.zeros((H + 1, W + 1))
    S[1:, 1:] = g.cumsum(0).cumsum(1)
    tot = S[np.ix_(r[1:], c[1:])] - S[np.ix_(r[:-1], c[1:])] - S[np.ix_(r[1:], c[:-1])] + S[np.ix_(r[:-1], c[:-1])]
    return tot / (np.diff(r)[:, None] * np.diff(c)[None, :])


def laplacian_variance(grey: np.ndarray) -> float:
    """Variance of the 4-neighbour Laplacian over the interior: the usual sharpness number (0 for a flat image)."""
    g = np.asarray(grey, dtype=np.float64)
    if g.shape[0] < 3 or g.shape[1] < 3:
        return 0.0
    lap = g[:-2, 1:-1] + g[2:, 1:-1] + g[1:-1, :-2] + g[1:-1, 2:] - 4.0 * g[1:-1, 1:-1]
    return float(lap.var())


def sharpness(rgb: np.ndarray, box: tuple[float, float, float, float] | None = None, max_side: int = SHARP_SIDE) -> float:
    """Laplacian variance of the grey, block-downscaled region (see the module docstring on comparing values)."""
    return laplacian_variance(to_grey(block_downscale(crop_box(np.asarray(rgb), box), max_side)))


# ------------------------------------------------------------------------------------------------ signatures
def signature(rgb: np.ndarray, box: tuple[float, float, float, float] | None = None) -> np.ndarray:
    """The region as a 24 x 24 grey thumbnail, 0..1 (not yet contrast-normalised: junk_reason wants the raw levels)."""
    return resize_area(to_grey(crop_box(np.asarray(rgb), box)), *SIG_SIZE)


def normalize(sig: np.ndarray) -> np.ndarray:
    s = np.asarray(sig, dtype=np.float64).reshape(-1)
    return (s - s.mean()) / max(float(s.std()), STD_FLOOR)


def signature_distance(a: np.ndarray, b: np.ndarray) -> float:
    """Mean absolute difference of the contrast-normalised thumbnails: 0 = the same picture (brightness aside),
    about 1 = unrelated."""
    return float(np.abs(normalize(a) - normalize(b)).mean())


def junk_reason(sig: np.ndarray) -> str | None:
    """'black', 'white' or 'flat' (a fade or a blank wall) when the region is no picture of anybody, else None."""
    s = np.asarray(sig, dtype=np.float64)
    if np.percentile(s, 90) < 0.10:
        return "black"
    if np.percentile(s, 10) > 0.92:
        return "white"
    if s.std() < 0.04:
        return "flat"
    return None


def transition_flags(sigs: list[np.ndarray], cut: float = CUT, max_share: float = 1 / 3) -> np.ndarray:
    """Frames on either side of a jump between neighbouring samples (a cut or a whip pan: the first frames after
    are often half-decoded or blurred). If more than `max_share` of the clip would go, the clip is simply busy and
    nothing is flagged."""
    n = len(sigs)
    flags = np.zeros(n, dtype=bool)
    if n < 2:
        return flags
    Z = np.stack([normalize(s) for s in sigs])
    jump = np.abs(Z[1:] - Z[:-1]).mean(axis=1) > cut
    flags[:-1] |= jump
    flags[1:] |= jump
    return np.zeros(n, dtype=bool) if flags.mean() > max_share else flags


# ------------------------------------------------------------------------------------------------ picking
@dataclass(frozen=True)
class Pick:
    indices: list[int]  # into the sampled frames, in time order
    rejected: dict[str, int] = field(default_factory=dict)  # reason -> frames
    relaxed: int = 0  # how many times the gap and duplicate limit were halved to reach MIN_FRAMES
    note: str | None = None  # set when fewer than the minimum could be found, and why


def default_min_gap(duration_s: float, count: int) -> float:
    """Seconds between picks: spread `count` picks over the clip twice over, but within 0.25..1 s."""
    return float(min(max(duration_s / (2 * max(count, 1)), 0.25), 1.0))


def _greedy(cand, times, scores, Z, count, gap, dup) -> list[int]:
    rel = scores / max(float(scores[cand].max()), 1e-12)
    first = int(cand[int(np.argmax(scores[cand]))])
    picked = [first]
    used = cand == first
    mind = np.abs(Z[cand] - Z[first]).mean(axis=1)
    tdiff = np.abs(times[cand] - times[first])
    while len(picked) < count:
        ok = (mind >= dup) & (tdiff >= gap - 1e-9) & ~used
        if not ok.any():
            break
        value = np.where(ok, mind * (0.5 + 0.5 * rel[cand]), -1.0)
        j = int(np.argmax(value))
        k = int(cand[j])
        picked.append(k)
        used[j] = True
        mind = np.minimum(mind, np.abs(Z[cand] - Z[k]).mean(axis=1))
        tdiff = np.minimum(tdiff, np.abs(times[cand] - times[k]))
    return picked


def pick_frames(times, scores, sigs, count: int = 10, min_gap: float = 0.5, dup: float = DUP,
                blur_frac: float = BLUR_FRAC) -> Pick:
    """The frames to keep: see the module docstring. `times` (s), `scores` (sharpness) and `sigs` (signature) are per
    sampled frame."""
    if count < 1:
        raise ValueError("count must be at least 1")
    count = min(int(count), MAX_FRAMES)
    times = np.asarray(times, dtype=np.float64)
    scores = np.asarray(scores, dtype=np.float64)
    n = len(times)
    if n == 0:
        return Pick([], {}, 0, "no frames were decoded from the video")
    rejected: dict[str, int] = {}

    def reject(i, why):
        rejected[why] = rejected.get(why, 0) + 1

    alive = []
    for i in range(n):
        why = junk_reason(sigs[i])
        reject(i, why) if why else alive.append(i)
    flags = transition_flags([sigs[i] for i in alive])
    kept = []
    for i, bad in zip(alive, flags):
        reject(i, "transition") if bad else kept.append(i)
    if kept:
        floor = blur_frac * float(np.percentile(scores[kept], 90))
        kept, blurred = [i for i in kept if scores[i] >= floor], [i for i in kept if scores[i] < floor]
        for i in blurred:
            reject(i, "blurred")
    if not kept:
        return Pick([], rejected, 0, "no usable frames: every sampled frame was black, flat, a transition or blurred")

    cand = np.asarray(kept)
    Z = np.stack([normalize(s) for s in sigs])
    want = min(MIN_FRAMES, count)
    best, best_relax = [], 0
    for relax, (g, d) in enumerate([(min_gap, dup), (min_gap / 2, dup / 2), (min_gap / 4, dup / 4), (0.0, dup / 8)]):
        picked = _greedy(cand, times, scores, Z, count, g, d)
        if len(picked) > len(best):
            best, best_relax = picked, relax
        if len(picked) >= want:
            break
    note = None
    if len(best) < want:
        note = (f"only {len(best)} distinct sharp frame(s) found (wanted at least {want}): the clip is short, still, "
                "dark or blurred; film a longer one where the person turns and moves a little")
    return Pick(sorted(best), rejected, best_relax, note)


# ------------------------------------------------------------------------------------------------ the person's box
def find_person_box(stack: np.ndarray, pad: float = 0.1) -> tuple[float, float, float, float] | None:
    """A box (fractions) around what moves in a clip filmed on a still camera: `stack` is (N, h, w) small grey frames.
    None when nothing moves, or when most of the frame does (hand-held: the camera moves, not the person) or the box
    would be under 4% or over 85% of the frame, so the caller falls back to the centre."""
    g = np.asarray(stack, dtype=np.float64)
    if g.ndim != 3 or len(g) < 2:
        return None
    energy = np.abs(np.diff(g, axis=0)).mean(axis=0)
    peak = float(np.percentile(energy, 99))
    if peak < 1e-3:
        return None
    active = energy > 0.2 * peak
    if active.mean() > 0.5:
        return None
    rows, cols = np.flatnonzero(active.any(axis=1)), np.flatnonzero(active.any(axis=0))
    h, w = energy.shape
    x0, x1, y0, y1 = cols[0] / w, (cols[-1] + 1) / w, rows[0] / h, (rows[-1] + 1) / h
    px, py = (x1 - x0) * pad, (y1 - y0) * pad
    box = (max(0.0, x0 - px), max(0.0, y0 - py), min(1.0, x1 + px), min(1.0, y1 + py))
    area = (box[2] - box[0]) * (box[3] - box[1])
    return box if 0.04 <= area <= 0.85 else None


def parse_box(text: str) -> tuple[float, float, float, float]:
    """'x0,y0,x1,y1' as fractions of the frame (0 = left/top). ValueError for anything else."""
    try:
        v = tuple(float(p) for p in text.split(","))
    except ValueError:
        raise ValueError(f"box {text!r}: expected four numbers x0,y0,x1,y1") from None
    if len(v) != 4 or not all(0.0 <= p <= 1.0 for p in v):
        raise ValueError(f"box {text!r}: expected four fractions between 0 and 1 (x0,y0,x1,y1)")
    if v[2] - v[0] < 0.05 or v[3] - v[1] < 0.05:
        raise ValueError(f"box {text!r}: x1 must exceed x0 and y1 exceed y0 by at least 0.05")
    return v  # type: ignore[return-value]


# ------------------------------------------------------------------------------------------------ contact sheet
def png_bytes(rgb: np.ndarray) -> bytes:
    """An 8-bit RGB PNG, no Pillow."""
    a = np.ascontiguousarray(rgb, dtype=np.uint8)
    h, w, _ = a.shape
    raw = np.concatenate([np.zeros((h, 1), np.uint8), a.reshape(h, w * 3)], axis=1).tobytes()

    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def contact_sheet(tiles: list[np.ndarray], cols: int = 4, pad: int = 4, bg: int = 24) -> np.ndarray:
    """Equal-sized (h, w, 3) uint8 tiles in a grid, row by row."""
    if not tiles:
        return np.zeros((0, 0, 3), np.uint8)
    th, tw = tiles[0].shape[:2]
    cols = max(1, min(cols, len(tiles)))
    rows = -(-len(tiles) // cols)
    sheet = np.full((rows * th + (rows + 1) * pad, cols * tw + (cols + 1) * pad, 3), bg, np.uint8)
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        y, x = pad + r * (th + pad), pad + c * (tw + pad)
        sheet[y:y + th, x:x + tw] = t
    return sheet
