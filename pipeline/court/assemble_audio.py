"""The crowd for the court bundle (plan 2, Sound): the bed is a seamless crowd loop with its one swell cut out (it
would repeat every loop), and the swell becomes a one-shot fired on the make. Both mono AAC at 48 kHz, one gain for
both so the swell keeps its real size over the bed, the bed at the target loudness (-23 LUFS, <= -1 dBTP: P19).
numpy, the standard library and ffmpeg (ebur128 for the measurement)."""

from __future__ import annotations

import re
import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np


def read_wav(path) -> tuple[np.ndarray, int]:
    with wave.open(str(path)) as w:
        n, sr, ch, sw = w.getnframes(), w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    if sw == 3:
        b = np.frombuffer(raw, np.uint8).reshape(-1, 3)
        x = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16))
        x = np.where(x & 0x800000, x - (1 << 24), x) / float(1 << 23)
    else:
        x = np.frombuffer(raw, {1: np.uint8, 2: np.int16, 4: np.int32}[sw]).astype(np.float64)
        x = (x - 128) / 128 if sw == 1 else x / float(1 << (8 * sw - 1))
    return x.reshape(-1, ch), sr


def write_wav(path, x: np.ndarray, sr: int) -> None:
    x = np.atleast_2d(x.T).T
    pcm = np.round(np.clip(x, -1, 1 - 1 / 32768) * 32768).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(x.shape[1])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def envelope_db(mono: np.ndarray, sr: int, win: float = 0.5, hop: float = 0.05) -> np.ndarray:
    """RMS level in dB over `win`-second windows every `hop` seconds (window i starts at i * hop)."""
    w, h = int(win * sr), int(hop * sr)
    c = np.concatenate([[0.0], np.cumsum(mono.astype(np.float64) ** 2)])
    starts = np.arange(0, len(mono) - w + 1, h)
    return 10 * np.log10((c[starts + w] - c[starts]) / w + 1e-20)


def find_swell(mono: np.ndarray, sr: int, search: tuple[float, float] | None = None, win: float = 0.5,
               hop: float = 0.05, context: float = 4.0, edge_db: float = 1.0) -> tuple[float, float, float]:
    """The crowd's swell: the window that rises most above the running median of the level around it (+-context s),
    widened while it stays edge_db above it. Returns (start s, end s, peak dB above the surroundings)."""
    env = envelope_db(mono, sr, win, hop)
    k = int(context / hop)
    base = np.array([np.median(env[max(0, i - k):i + k + 1]) for i in range(len(env))])
    ex = env - base
    lo, hi = 0, len(env)
    if search:
        lo, hi = max(0, int(search[0] / hop)), min(len(env), int(search[1] / hop) + 1)
    p = lo + int(np.argmax(ex[lo:hi]))
    a = p
    while a > 0 and ex[a - 1] > edge_db:
        a -= 1
    b = p
    while b < len(ex) - 1 and ex[b + 1] > edge_db:
        b += 1
    # window i covers [i hop, i hop + win]: the swell's level is centred on each window
    return a * hop + win / 2, b * hop + win / 2, float(ex[p])


def cut(x: np.ndarray, sr: int, t0: float, t1: float, xfade: float = 0.4) -> np.ndarray:
    """x without [t0, t1): what came before crossfades (equal power, `xfade` s) into what came after. The loop's own
    ends are untouched, so its seam stays seamless."""
    i0, i1, n = int(round(t0 * sr)), int(round(t1 * sr)), int(xfade * sr)
    if i0 < 0 or i1 + n > len(x) or i1 <= i0:
        raise ValueError(f"cut: [{t0}, {t1}) with a {xfade} s crossfade doesn't fit in {len(x) / sr:.2f} s")
    t = (np.arange(n) + 0.5) / n
    fo, fi = np.cos(t * np.pi / 2), np.sin(t * np.pi / 2)
    shape = (-1,) + (1,) * (x.ndim - 1)
    mid = x[i0:i0 + n] * fo.reshape(shape) + x[i1:i1 + n] * fi.reshape(shape)
    return np.concatenate([x[:i0], mid, x[i1 + n:]])


def extract(x: np.ndarray, sr: int, t0: float, t1: float, pre: float = 0.3, post: float = 0.6,
            fade_in: float = 0.3, fade_out: float = 0.6) -> np.ndarray:
    """[t0 - pre, t1 + post) with a raised-cosine fade in and out: the one-shot."""
    a, b = max(0, int((t0 - pre) * sr)), min(len(x), int((t1 + post) * sr))
    y = x[a:b].astype(np.float64).copy()
    shape = (-1,) + (1,) * (y.ndim - 1)
    ni, no = int(fade_in * sr), int(fade_out * sr)
    y[:ni] *= (0.5 - 0.5 * np.cos(np.pi * (np.arange(ni) / ni))).reshape(shape)
    y[-no:] *= (0.5 + 0.5 * np.cos(np.pi * ((np.arange(no) + 1) / no))).reshape(shape)
    return y


def loudness(path) -> dict:
    """Integrated loudness (LUFS) and true peak (dBTP) by ffmpeg's EBU R128 scanner."""
    p = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"],
                       capture_output=True, text=True)
    tail = p.stderr[p.stderr.rfind("Summary:"):]
    i = re.search(r"I:\s+(-?[\d.]+|-inf) LUFS", tail)
    tp = re.search(r"True peak:\s+Peak:\s+(-?[\d.]+|-inf) dBFS", tail)
    if p.returncode != 0 or not i or not tp:
        raise RuntimeError(f"loudness: ffmpeg ebur128 failed on {path}:\n{p.stderr[-800:]}")
    return {"I": float(i.group(1)), "TP": float(tp.group(1))}


def encode(wav, out, gain_db: float, sr_out: int = 48000) -> None:
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(wav), "-af", f"volume={gain_db:.3f}dB",
                    "-ac", "1", "-ar", str(sr_out), "-c:a", "aac", "-b:a", "160k", str(out)], check=True)


def make_audio(x: np.ndarray, sr: int, swell: tuple[float, float], out_dir, lufs: float = -23.0, peak: float = -1.0) -> dict:
    """bed.m4a (x with the swell cut out) at `lufs`, swell.m4a (the swell alone) with the same gain, both mono. If the
    swell's true peak would pass `peak`, its file is lowered and `swellGainDb` gives it back at play time."""
    out_dir = Path(out_dir)
    mono = x.mean(1) if x.ndim == 2 else x
    # the crossfade runs over the 0.4 s before the swell and the 0.4 s after it, so none of the swell stays in the bed
    bed, shot = cut(mono, sr, swell[0] - 0.4, swell[1]), extract(mono, sr, *swell)
    with tempfile.TemporaryDirectory() as d:
        wb, ws = Path(d) / "bed.wav", Path(d) / "swell.wav"
        write_wav(wb, bed, sr)
        write_wav(ws, shot, sr)
        raw = loudness(wb)
        gain = lufs - raw["I"]
        trim = 0.0
        for _ in range(3):  # the encoder's own overshoot is small; re-measure until the bed sits on target
            encode(wb, out_dir / "bed.m4a", gain + trim)
            got = loudness(out_dir / "bed.m4a")
            if got["TP"] > peak:
                raise ValueError(f"the bed's true peak {got['TP']:.1f} dBTP passes {peak} at {lufs} LUFS")
            if abs(got["I"] - lufs) <= 0.3:
                break
            trim += lufs - got["I"]
        sw = loudness(ws)
        over = max(0.0, sw["TP"] + gain + trim - (peak - 0.5))
        encode(ws, out_dir / "swell.m4a", gain + trim - over)
    return {"bedLufs": got["I"], "bedTruePeak": got["TP"], "gainDb": round(gain + trim, 2), "swellGainDb": round(over, 2),
            "swell": [round(swell[0], 3), round(swell[1], 3)], "bedSeconds": round(len(bed) / sr, 3),
            "swellSeconds": round(len(shot) / sr, 3), "channels": 1}
