"""strums.json for a guitar bundle: when the teacher strums and which way, so a player can show the rhythm as a lane of
arrows and judge yours against it (the WebXR viewer's play-along). Optional in any bundle; dream.json names it as
"strums": "strums.json".

    { "times": [0.08, 0.54, ...], "down": [false, true, ...], "source": "audio" | "video", "hand": "right_wrist",
      "directionFrom": "joints" | "video", "agreement": 0.9, "createdAt": "..." }

times: seconds in the bundle's own clip time (0 = its first frame), the clock its frames, audio.m4a and joints.json share.
down: true for a down strum (the hand moving toward the floor, low E to high E). Only times and down are the contract;
the rest says how they were found.

From the clip's sound when it has any: ffmpeg decodes it to mono, numpy does the rest. The onset strength is the spectral
flux of the log-compressed magnitude (a strum is a broadband attack: every string at once), its local mean taken off;
peaks are picked above a moving median plus a few median absolute deviations, at least 70 ms apart.

A silent clip falls back to the picture. Stock footage often carries a digital-silence track (guitar-01's is -91 dBFS
throughout), so the strumming hand is watched instead: skin-coloured pixels in a box round the hand over the sound hole,
the hand's end of that blob followed frame to frame, and its speed across the strings is the onset strength, through
the same peak picking (a strum crosses the strings at the hand's fastest). The box is found by itself (where skin
changes most, round the hand that moves most up and down) or given with --hand. The source clip must be the one the
bundle was cut from, on the bundle's clock: the run's prepped.mp4 (bundle frame i is its frame i).

Down or up: the strumming wrist in joints.json (the wrist with the most up-and-down motion once its slow drift is
taken off), its vertical velocity at each strum, wherever it moves clearly there; else the picture's own direction.
The joints are GVHMR's, smoothed, so a strum shows there as a few millimetres; the picture shows it as centimetres.

    python -m lucid.strums dreams/guitar-01 --clip runs/guitar-01/prepped.mp4            # prints what it found
    python -m lucid.strums dreams/guitar-01 --clip ... --write                            # writes strums.json, adds "strums"
    python -m lucid.strums dreams/guitar-01 --clip ... --sheet check.png --listen check.mp4   # to look and listen

--sheet draws the hand at every strum (frame before, at, after; green border down, orange up); --listen writes the clip
with a click at every strum (low down, high up) to watch and hear against the hand. STRUMS_OK on success, STRUMS_NONE
when neither the sound nor the picture gives strums (nothing is written).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

SR = 22050
N_FFT = 512  # 23 ms: short enough to place an attack, long enough to see a chord's partials
HOP = 128  # 5.8 ms: a strum's attack lands within a hop
LEAD = 0.009  # s: the flux peaks as the attack enters the window, this much before it
SILENT_DBFS = -60.0  # quieter than this throughout: nothing to hear
AUDIO_GAP = 0.07  # s between strums at least (sixteenths at 200 BPM are 75 ms)
VIDEO_GAP = 0.2  # s: a hand at 25 fps can't strum twice in five frames
WIDTH = 540  # the picture is read at this width (half of a 1080 x 1920 clip)
HAND_BAND = 55  # px at WIDTH: the hand's end of the skin blob (the forearm runs in from the box's other side)
STROKE_PX = 4.0  # px at WIDTH a stroke must travel (about a centimetre on a person filling the frame; strums go 3-10 cm)
STROKE_SPEED = 15.0  # px/s at WIDTH a stroke must reach (a still hand's tracking jitter stays well under this)
JOINT_MIN_SPEED = 0.004  # m/s: below this the joints don't say which way the hand went


# ---------------------------------------------------------------- shared


def pick_peaks(env: np.ndarray, rate: float, min_gap: float, k: float = 3.0, floor: float = 0.25,
               window: float = 1.0) -> np.ndarray:
    """Indices of the envelope's peaks: local maxima above a moving median + k median absolute deviations, and above
    floor x the envelope's 95th percentile (a quiet passage's noise never counts), at least min_gap seconds apart (the
    stronger of two close ones wins)."""
    n = len(env)
    if n < 3 or not np.any(env > 0):
        return np.zeros(0, int)
    half = max(1, int(window * rate / 2))
    padded = np.pad(env, half, mode="reflect")
    med = np.array([np.median(padded[i:i + 2 * half + 1]) for i in range(n)])
    mad = np.array([np.median(np.abs(padded[i:i + 2 * half + 1] - med[i])) for i in range(n)])
    thresh = np.maximum(med + k * mad, floor * np.percentile(env, 95))
    cand = [i for i in range(1, n - 1) if env[i] >= env[i - 1] and env[i] > env[i + 1] and env[i] > thresh[i]]
    gap = max(1, int(round(min_gap * rate)))
    keep: list[int] = []
    for i in sorted(cand, key=lambda i: -env[i]):
        if all(abs(i - j) >= gap for j in keep):
            keep.append(i)
    return np.array(sorted(keep), int)


def refine(env: np.ndarray, i: int) -> float:
    """A peak's index to a fraction of a step (the parabola through it and its neighbours)."""
    if i <= 0 or i >= len(env) - 1:
        return float(i)
    a, b, c = env[i - 1], env[i], env[i + 1]
    d = a - 2 * b + c
    return float(i) if abs(d) < 1e-12 else i + 0.5 * (a - c) / d


# ---------------------------------------------------------------- sound


def decode_audio(path: Path, sr: int = SR) -> np.ndarray:
    """The file's sound as mono float32 at sr, empty if it has none."""
    out = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", str(sr),
                          "-f", "f32le", "-"], capture_output=True, check=False)
    if out.returncode != 0:
        return np.zeros(0, np.float32)
    return np.frombuffer(out.stdout, dtype=np.float32).copy()


def peak_dbfs(x: np.ndarray) -> float:
    return -120.0 if x.size == 0 else float(20 * np.log10(max(float(np.max(np.abs(x))), 1e-6)))


def onset_envelope(x: np.ndarray, sr: int = SR) -> tuple[np.ndarray, float]:
    """Spectral flux of the log-compressed magnitude (80 Hz - 8 kHz) less its quarter-second local mean (signed):
    (envelope, frames per second). Envelope frame k is centred on sample k * HOP."""
    pad = np.pad(x.astype(np.float64), (N_FFT // 2, N_FFT // 2), mode="reflect")
    n = 1 + (len(pad) - N_FFT) // HOP
    if n < 2:
        return np.zeros(0), sr / HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n)[:, None]
    mag = np.abs(np.fft.rfft(pad[idx] * np.hanning(N_FFT), axis=1))
    f = np.fft.rfftfreq(N_FFT, 1 / sr)
    band = (f >= 80) & (f <= 8000)
    logm = np.log1p(1000 * mag[:, band])
    flux = np.maximum(0, np.diff(logm, axis=0)).sum(1)
    flux = np.concatenate([flux[:1], flux])  # (the first frame has nothing before it to rise from)
    rate = sr / HOP
    k = max(1, int(0.25 * rate))  # take off a quarter-second local mean: a sustained chord isn't an onset
    local = np.convolve(np.pad(flux, k, mode="edge"), np.ones(2 * k + 1) / (2 * k + 1), mode="valid")
    return flux - local, rate


def audio_strums(x: np.ndarray, sr: int = SR) -> np.ndarray:
    """Strum times (s) heard in the sound. A peak must stand out of the room's own noise as well as its neighbours:
    ten median absolute deviations of the whole envelope above its median (a quiet room's flux never gets there)."""
    resid, rate = onset_envelope(x, sr)
    if not resid.size:
        return np.zeros(0)
    med = float(np.median(resid))
    room = med + 10 * float(np.median(np.abs(resid - med)))
    env = np.maximum(0, resid)
    peaks = [i for i in pick_peaks(env, rate, AUDIO_GAP, k=4.0, floor=0.05, window=1.0) if env[i] > room]
    if peaks:
        loud = max(env[i] for i in peaks)
        peaks = [i for i in peaks if env[i] > 0.05 * loud]
    return np.array([refine(env, i) / rate + LEAD for i in peaks])


# ---------------------------------------------------------------- picture


def decode_video(path: Path, width: int = WIDTH) -> tuple[np.ndarray, float]:
    """Every frame as RGB uint8 at `width` (height kept in proportion, even), and the frame rate."""
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                            "stream=width,height,r_frame_rate", "-of", "json", str(path)],
                           capture_output=True, text=True, check=True)
    s = json.loads(probe.stdout)["streams"][0]
    num, den = (int(v) for v in s["r_frame_rate"].split("/"))
    height = int(round(s["height"] * width / s["width"] / 2)) * 2
    raw = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vf", f"scale={width}:{height}",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, height, width, 3), num / den


def skin_mask(rgb: np.ndarray) -> np.ndarray:
    """Lit skin (YCbCr), tuned on guitar-01 to leave out a rosewood fretboard (darker, less red) and black clothes."""
    c = rgb.astype(np.float32)
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cr = 128 + 0.5 * r - 0.4187 * g - 0.0813 * b
    cb = 128 - 0.1687 * r - 0.3313 * g + 0.5 * b
    return (cr > 144) & (cr < 178) & (cb > 85) & (cb < 125) & (y > 58)


def hand_track(skin: np.ndarray, box: tuple[int, int, int, int]) -> tuple[np.ndarray, np.ndarray]:
    """The hand's position (x, y px) per frame inside the box: the end of the skin blob away from where the forearm
    comes in (the box side the skin touches most). NaN where there's no skin."""
    x0, y0, x1, y1 = box
    m = skin[:, y0:y1, x0:x1]
    n, h, w = m.shape
    left, right = m[:, :, :3].sum(), m[:, :, -3:].sum()
    from_left = left >= right
    xs = np.broadcast_to(np.arange(w)[None, :], (h, w))
    ys = np.broadcast_to(np.arange(h)[:, None], (h, w))
    out = np.full((n, 2), np.nan)
    for i in range(n):
        mi = m[i]
        if mi.sum() < 30:
            continue
        if from_left:
            sel = mi & (xs > np.percentile(xs[mi], 97) - HAND_BAND)
        else:
            sel = mi & (xs < np.percentile(xs[mi], 3) + HAND_BAND)
        out[i] = xs[sel].mean() + x0, ys[sel].mean() + y0
    for k in range(2):  # short dropouts: carried across
        v = out[:, k]
        bad = np.isnan(v)
        if bad.all():
            break
        v[bad] = np.interp(np.flatnonzero(bad), np.flatnonzero(~bad), v[~bad])
    return out[:, 0], out[:, 1]


def find_hand_box(skin: np.ndarray, fps: float) -> tuple[int, int, int, int]:
    """Where the strumming hand is: of the two places skin changes most in the middle band of the frame (a guitar is
    played between the chest and the lap), the one whose hand moves most up and down."""
    n, H, W = skin.shape
    var = skin.astype(np.float32).std(0)
    bs = 20
    vb = var[: H // bs * bs, : W // bs * bs].reshape(H // bs, bs, W // bs, bs).mean((1, 3))
    rows = np.arange(vb.shape[0]) * bs
    vb[(rows < 0.25 * H) | (rows > 0.65 * H)] = 0
    bw, bh = int(0.35 * W), int(0.19 * H)
    boxes = []
    for k in np.argsort(vb.ravel())[::-1]:
        r, c = divmod(int(k), vb.shape[1])
        cx, cy = c * bs + bs // 2, r * bs + bs // 2
        if vb[r, c] <= 0 or any(abs(cx - bx) < bw * 0.6 and abs(cy - by) < bh * 0.6 for bx, by in boxes):
            continue
        boxes.append((cx, cy))
        if len(boxes) == 2:
            break
    best, score = None, -1.0
    for cx, cy in boxes:
        box = (max(0, cx - bw // 2), max(0, cy - bh // 2), min(W, cx + bw // 2), min(H, cy + bh // 2))
        _, y = hand_track(skin, box)
        if np.isnan(y).all():
            continue
        s = float(np.std(np.gradient(y) * fps))
        if s > score:
            best, score = box, s
    if best is None:
        raise ValueError("no hand found in the picture")
    return best


def strokes(vy: np.ndarray, rate: float, min_gap: float = VIDEO_GAP) -> np.ndarray:
    """A hand strumming goes down and up across the strings: each stroke runs from one turn to the next (vy changes
    sign; a slow moment inside a stroke doesn't split it), and strikes the strings where it's fastest. Indices of
    those fastest moments, for strokes fast and long enough to be strums (a hand resting on the strings, shaking a
    little, makes neither)."""
    n = len(vy)
    if n < 3:
        return np.zeros(0, int)
    speed = np.abs(vy)
    p95 = float(np.percentile(speed, 95))
    if p95 <= 0:
        return np.zeros(0, int)
    dead = 0.1 * p95
    sign = np.zeros(n, int)
    last = 0
    for i in range(n):
        if speed[i] > dead:
            last = 1 if vy[i] > 0 else -1
        sign[i] = last
    moving = np.flatnonzero(sign)
    if not len(moving):
        return np.zeros(0, int)
    sign[: moving[0]] = sign[moving[0]]  # a slow start belongs to the first stroke
    cuts = [0] + [i for i in range(1, n) if sign[i] != sign[i - 1] and sign[i - 1] != 0] + [n]
    segs = [(a, b) for a, b in zip(cuts[:-1], cuts[1:]) if b > a and sign[a] != 0]
    travel = np.array([abs(vy[a:b].sum()) / rate for a, b in segs])
    if not len(segs):
        return np.zeros(0, int)
    keep_travel = 0.25 * float(np.median(travel))
    out: list[int] = []
    for (a, b), d in zip(segs, travel):
        i = a + int(np.argmax(speed[a:b]))
        if i in (0, n - 1):  # fastest at the clip's edge: its strike was before the clip, or comes after it
            continue
        if speed[i] < max(0.3 * p95, STROKE_SPEED) or d < max(keep_travel, STROKE_PX):
            continue
        if out and (i - out[-1]) < min_gap * rate:
            if speed[i] > speed[out[-1]]:
                out[-1] = i
            continue
        out.append(i)
    return np.array(out, int)


def video_strums(rgb: np.ndarray, fps: float, box: tuple[int, int, int, int] | None = None) -> dict:
    """Strums seen in the picture: times (s), down (bool: the hand moving down the frame), the box, the hand's track."""
    skin = skin_mask(rgb)
    box = box or find_hand_box(skin, fps)
    x, y = hand_track(skin, box)
    vy = np.convolve(np.pad(np.gradient(y) * fps, 1, mode="edge"), [0.25, 0.5, 0.25], mode="valid")  # px/s, + down
    env = np.abs(vy)
    peaks = strokes(vy, fps)
    times = np.array([refine(env, i) / fps for i in peaks])
    return {"times": times, "down": np.array([vy[i] > 0 for i in peaks], bool), "frames": peaks, "box": box,
            "hand": np.stack([x, y], 1), "env": env, "vy": vy}


# ---------------------------------------------------------------- the strumming wrist


def strumming_wrist(joints: dict) -> str:
    """The wrist with the most up-and-down motion once its slow drift (a 1 s mean) is taken off."""
    names = joints["names"]
    frames = np.asarray(joints["frames"], dtype=np.float64)
    fps = float(joints.get("fps", 25))
    k = max(1, int(fps / 2))
    best, energy = "right_wrist", -1.0
    for w in ("right_wrist", "left_wrist"):
        if w not in names:
            continue
        y = frames[:, names.index(w), 1]
        trend = np.convolve(np.pad(y, k, mode="edge"), np.ones(2 * k + 1) / (2 * k + 1), mode="valid")
        e = float(np.std(y - trend))
        if e > energy:
            best, energy = w, e
    return best


def joint_directions(joints: dict, times: np.ndarray, wrist: str) -> np.ndarray:
    """At each time, +1 if the wrist is moving up, -1 down, 0 when it barely moves (bundle +Y is up)."""
    names = joints["names"]
    fps = float(joints.get("fps", 25))
    y = np.asarray(joints["frames"], dtype=np.float64)[:, names.index(wrist), 1]
    vy = np.convolve(np.pad(np.gradient(y) * fps, 1, mode="edge"), [0.25, 0.5, 0.25], mode="valid")
    v = np.interp(np.asarray(times) * fps, np.arange(len(vy)), vy)
    return np.where(np.abs(v) < JOINT_MIN_SPEED, 0, np.sign(v)).astype(int)


# ---------------------------------------------------------------- checks to look at and listen to


def contact_sheet(rgb: np.ndarray, found: dict, out: Path) -> None:
    """Per strum, the hand's box at the frame before, at and after it; border green for down, orange for up."""
    x0, y0, x1, y1 = found["box"]
    tiles = []
    for f, down in zip(found["frames"], found["down"]):
        row = []
        for k in (f - 1, f, f + 1):
            k = int(np.clip(k, 0, len(rgb) - 1))
            t = rgb[k, y0:y1, x0:x1].copy()
            hx, hy = found["hand"][k]
            cx, cy = int(hx - x0), int(hy - y0)
            t[max(0, cy - 2):cy + 2, max(0, cx - 2):cx + 2] = (255, 255, 0)
            row.append(t)
        tile = np.concatenate(row, 1)
        colour = (40, 220, 90) if down else (255, 150, 0)
        tile[:4], tile[-4:], tile[:, :4], tile[:, -4:] = colour, colour, colour, colour
        tiles.append(tile)
    cols = 3
    while len(tiles) % cols:
        tiles.append(np.zeros_like(tiles[0]))
    sheet = np.concatenate([np.concatenate(tiles[r:r + cols], 1) for r in range(0, len(tiles), cols)], 0)
    h, w = sheet.shape[:2]
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-i", "-",
                    str(out)], input=np.ascontiguousarray(sheet).tobytes(), check=True)


def click_track(times: np.ndarray, down: np.ndarray, seconds: float, sr: int = 48000) -> np.ndarray:
    """A short click at every strum: 600 Hz for down, 1500 Hz for up."""
    x = np.zeros(int(seconds * sr) + sr // 10, np.float32)
    t = np.arange(int(0.04 * sr)) / sr
    for s, d in zip(times, down):
        burst = (np.sin(2 * np.pi * (600 if d else 1500) * t) * np.exp(-t / 0.008)).astype(np.float32) * 0.6
        i = int(s * sr)
        x[i:i + len(burst)] += burst[: len(x) - i]
    return x


def listen(clip: Path, times: np.ndarray, down: np.ndarray, seconds: float, out: Path) -> None:
    """The clip's first `seconds`, with the click track as its sound."""
    sr = 48000
    wav = out.with_suffix(".clicks.f32")
    wav.write_bytes(click_track(times, down, seconds, sr).tobytes())
    try:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(clip), "-f", "f32le", "-ar", str(sr), "-ac", "1",
                        "-i", str(wav), "-map", "0:v", "-map", "1:a", "-t", f"{seconds:.3f}", "-c:v", "libx264",
                        "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", str(out)], check=True)
    finally:
        wav.unlink(missing_ok=True)


# ---------------------------------------------------------------- main


def find(bundle: Path, clip: Path | None, box: tuple[int, int, int, int] | None = None) -> dict:
    dream = json.loads((bundle / "dream.json").read_text())
    duration = float(dream.get("durationS") or dream["frameCount"] / dream["fps"])
    joints = json.loads((bundle / dream["joints"]).read_text()) if dream.get("joints") else None
    sound = None
    for path in [p for p in (bundle / dream["audio"] if dream.get("audio") else None, clip) if p]:
        if Path(path).exists():
            sound = Path(path)
            break
    x = decode_audio(sound) if sound else np.zeros(0, np.float32)
    level = peak_dbfs(x)
    print(f"[strums] sound: {sound.name if sound else 'none'}, peak {level:.1f} dBFS", flush=True)
    result: dict = {"rgb": None}
    if level > SILENT_DBFS:
        times = audio_strums(x)
        result.update(source="audio", times=times, down=None)
    elif clip and clip.exists():
        print(f"[strums] silent: reading the strumming hand in {clip.name}", flush=True)
        rgb, fps = decode_video(clip)
        found = video_strums(rgb, fps, box)
        result.update(source="video", times=found["times"], down=found["down"], found=found, rgb=rgb, fps=fps)
    else:
        result.update(source=None, times=np.zeros(0), down=None)
    keep = result["times"] < duration
    result["times"] = result["times"][keep]
    if result["down"] is not None:
        result["down"] = result["down"][keep]
    if result.get("found"):
        f = result["found"]
        for k in ("frames", "down", "times"):
            f[k] = f[k][keep]
    # which way: the strumming wrist where it says, else the picture
    seen = result["down"]
    direction_from = "video" if seen is not None else "default"
    down = seen.copy() if seen is not None else np.ones(len(result["times"]), bool)
    agreement = None
    wrist = None
    if joints is not None and len(result["times"]):
        wrist = strumming_wrist(joints)
        dirs = joint_directions(joints, result["times"], wrist)
        said = dirs != 0
        if said.any():
            if seen is not None:
                agreement = float(np.mean((dirs[said] < 0) == seen[said]))
            down[said] = dirs[said] < 0
            direction_from = "joints" if said.all() else f"joints ({int(said.sum())} of {len(said)}), else {direction_from}"
    result.update(down=down, wrist=wrist, directionFrom=direction_from, agreement=agreement, duration=duration)
    return result


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("bundle", type=Path)
    ap.add_argument("--clip", type=Path, help="the source clip on the bundle's clock (the run's prepped.mp4)")
    ap.add_argument("--hand", help="x0,y0,x1,y1: the strumming hand's box, in pixels of the clip read 540 wide")
    ap.add_argument("--write", action="store_true", help="write strums.json and add it to dream.json")
    ap.add_argument("--sheet", type=Path, help="a contact sheet of the hand at every strum (png)")
    ap.add_argument("--listen", type=Path, help="the clip with a click at every strum (mp4)")
    a = ap.parse_args(argv)
    box = tuple(int(v) for v in a.hand.split(",")) if a.hand else None
    r = find(a.bundle, a.clip, box)  # type: ignore[arg-type]
    times, down = r["times"], r["down"]
    if not len(times):
        print("STRUMS_NONE: no sound and no picture of the hand to read", flush=True)
        sys.exit(1)
    gaps = np.diff(times)
    print(f"[strums] {len(times)} strums from the {r['source']}, direction from {r['directionFrom']}"
          + (f" (agrees with the picture on {r['agreement']:.0%})" if r["agreement"] is not None else ""), flush=True)
    if r.get("found"):
        print(f"[strums] hand box {r['found']['box']} (px at {WIDTH} wide), strumming wrist {r['wrist']}", flush=True)
    if len(gaps):
        print(f"[strums] gaps {np.round(gaps, 3).tolist()} s (median {np.median(gaps):.3f})", flush=True)
    for t, d in zip(times, down):
        print(f"  {t:6.3f} s  {'down' if d else 'up'}", flush=True)
    if a.sheet and r.get("found"):
        contact_sheet(r["rgb"], r["found"], a.sheet)
        print(f"[strums] sheet {a.sheet}", flush=True)
    if a.listen and a.clip:
        listen(a.clip, times, down, r["duration"], a.listen)
        print(f"[strums] listen {a.listen}", flush=True)
    if a.write:
        out = {"times": [round(float(t), 3) for t in times], "down": [bool(d) for d in down], "source": r["source"],
               "hand": r["wrist"], "directionFrom": r["directionFrom"],
               "agreement": None if r["agreement"] is None else round(r["agreement"], 3),
               "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
        (a.bundle / "strums.json").write_text(json.dumps(out, indent=1) + "\n")
        meta = a.bundle / "dream.json"
        dream = json.loads(meta.read_text())
        dream["strums"] = "strums.json"
        meta.write_text(json.dumps(dream, indent=2) + "\n")
        print(f"[strums] wrote {a.bundle / 'strums.json'}", flush=True)
    print("STRUMS_OK", len(times), flush=True)


if __name__ == "__main__":
    main()
