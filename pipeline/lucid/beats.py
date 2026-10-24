"""beats.json for a bundle: the clip's beat, so a player can pulse on it (the WebXR viewer's floor ring around a dancer,
the count-in on your turn). Optional in any bundle; dream.json names it as "beats": "beats.json".

    { "bpm": 112.4, "times": [0.21, 0.74, ...], "source": "audio" | "motion", "confidence": 0.62 }

times: seconds in the bundle's own clip time (0 = its first frame), the clock the frames, audio.m4a and joints.json share.
confidence: how strongly the envelope repeats at that tempo (its autocorrelation at the beat period over its energy, 0-1).

From the clip's sound when it has any: ffmpeg decodes audio.m4a to mono, numpy does the rest. An onset envelope (spectral
flux of the log-compressed magnitude in 40 log-spaced bands, its local mean taken off), a tempo from the envelope's
autocorrelation weighted toward 120 BPM (a log-normal prior an octave wide), then the beats by dynamic programming
(Ellis 2007, "Beat tracking by dynamic programming": each beat on a strong onset, about one period after the last).

A silent clip (most stock dance clips are) falls back to the body: joints.json's mean joint speed, whose dips are the
moments a dancer hits the beat (the "motion beats" of AIST++, Li et al. 2021), through the same tempo and beat steps.

    python -m lucid.beats dreams/dance-01            # prints what it found
    python -m lucid.beats dreams/dance-01 --write    # writes beats.json and adds "beats" to dream.json

BEATS_OK on success; BEATS_NONE when neither the sound nor the body gives a beat (nothing is written).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

SR = 22050
N_FFT = 1024
HOP = 256
SILENT_DBFS = -60.0  # quieter than this throughout: no sound to find a beat in
BPM_RANGE = (60.0, 200.0)
PRIOR_BPM = 120.0
PRIOR_OCTAVES = 1.0
TIGHTNESS = 100.0  # how hard the beat tracker holds to the tempo (Ellis's alpha)


def decode(path: Path, sr: int = SR) -> np.ndarray:
    """The file's sound as mono float32 at sr (ffmpeg), empty if it has none."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
        capture_output=True,
        check=False,
    )
    if out.returncode != 0:
        raise RuntimeError(f"ffmpeg could not decode {path}: {out.stderr.decode(errors='replace').strip()}")
    return np.frombuffer(out.stdout, dtype=np.float32).copy()


def dbfs(x: np.ndarray) -> float:
    if x.size == 0:
        return -120.0
    return float(20 * np.log10(max(np.sqrt(np.mean(x.astype(np.float64) ** 2)), 1e-6)))


def audio_envelope(x: np.ndarray, sr: int = SR) -> tuple[np.ndarray, float]:
    """Onset strength per STFT frame (frame i is centred at i * HOP / sr) and the envelope's frame rate."""
    pad = np.pad(x, (N_FFT // 2, N_FFT // 2), mode="reflect" if x.size > N_FFT else "constant")
    n = 1 + (pad.size - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n)[:, None]
    mag = np.abs(np.fft.rfft(pad[idx] * np.hanning(N_FFT)[None, :], axis=1))  # (frames, bins)
    freqs = np.fft.rfftfreq(N_FFT, 1 / sr)
    edges = np.geomspace(30.0, min(8000.0, sr / 2 - 1), 41)
    bands = np.stack([mag[:, (freqs >= lo) & (freqs < hi)].sum(1) for lo, hi in zip(edges[:-1], edges[1:])], axis=1)
    comp = np.log1p(1000.0 * bands / max(bands.max(), 1e-9))
    flux = np.maximum(0.0, np.diff(comp, axis=0)).sum(1)
    flux = np.concatenate([[0.0], flux])
    return normalise(flux - moving_mean(flux, int(round(0.4 * sr / HOP)))), sr / HOP


def motion_envelope(joints: dict) -> tuple[np.ndarray, float]:
    """The body's beat strength per bundle frame: how far the mean joint speed dips below its local mean."""
    f = np.asarray(joints["frames"], dtype=np.float64)  # (frames, joints, 3)
    fps = float(joints["fps"])
    v = np.gradient(f, axis=0) * fps
    speed = np.linalg.norm(v, axis=2).mean(1)
    speed = gaussian_smooth(speed, 1.0)
    dip = moving_mean(speed, int(round(0.5 * fps))) - speed
    # upsample to 100 Hz so beats land between frames, not on them
    rate = 100.0
    t = np.arange(speed.size) / fps
    tt = np.arange(0, t[-1] + 1e-9, 1 / rate)
    return normalise(np.interp(tt, t, dip)), rate


def moving_mean(x: np.ndarray, width: int) -> np.ndarray:
    width = max(1, width | 1)
    k = np.ones(width) / width
    return np.convolve(np.pad(x, (width // 2, width // 2), mode="edge"), k, mode="valid")


def gaussian_smooth(x: np.ndarray, sigma: float) -> np.ndarray:
    r = int(np.ceil(3 * sigma))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    return np.convolve(np.pad(x, (r, r), mode="edge"), k / k.sum(), mode="valid")


def normalise(env: np.ndarray) -> np.ndarray:
    env = np.maximum(env, 0.0)
    s = env.std()
    return env / s if s > 1e-9 else env * 0.0


def tempo(env: np.ndarray, rate: float) -> tuple[float, float]:
    """(bpm, confidence) from the envelope's autocorrelation, weighted toward PRIOR_BPM."""
    e = env - env.mean()
    n = e.size
    ac = np.correlate(e, e, mode="full")[n - 1 :]
    if ac[0] <= 0:
        return 0.0, 0.0
    ac = ac / ac[0]
    lo = int(np.floor(rate * 60.0 / BPM_RANGE[1]))
    hi = min(n - 2, int(np.ceil(rate * 60.0 / BPM_RANGE[0])))
    if hi <= lo + 1:
        return 0.0, 0.0
    lags = np.arange(lo, hi + 1)
    bpms = 60.0 * rate / lags
    # an unbiased autocorrelation: a short clip has fewer pairs at long lags
    unbiased = ac[lags] * n / (n - lags)
    prior = np.exp(-0.5 * (np.log2(bpms / PRIOR_BPM) / PRIOR_OCTAVES) ** 2)
    score = np.maximum(unbiased, 0) * prior
    k = int(np.argmax(score))
    lag = float(lags[k])
    if 0 < k < len(lags) - 1:  # parabolic peak between lags (only for a real peak, never more than half a lag)
        a, b, c = score[k - 1], score[k], score[k + 1]
        den = a - 2 * b + c
        if den < -1e-12:
            lag += float(np.clip(0.5 * (a - c) / den, -0.5, 0.5))
    return 60.0 * rate / lag, float(np.clip(unbiased[k], 0.0, 1.0))


def track(env: np.ndarray, rate: float, bpm: float) -> np.ndarray:
    """Beat frames (fractional) by dynamic programming: strong onsets about one period apart."""
    period = 60.0 * rate / bpm
    n = env.size
    score = env.astype(np.float64).copy()
    back = np.full(n, -1)
    lo, hi = int(round(period / 2)), int(round(2 * period))
    for i in range(n):
        start, stop = max(0, i - hi), i - lo
        if stop <= start:
            continue
        prev = np.arange(start, stop)
        cost = -TIGHTNESS * np.log((i - prev) / period) ** 2
        cand = score[prev] + cost
        j = int(np.argmax(cand))
        if cand[j] > 0:
            score[i] += cand[j]
            back[i] = prev[j]
    # the last beat: the best-scoring frame among the last period's local maxima
    tail = np.arange(max(0, n - int(np.ceil(period))), n)
    i = int(tail[np.argmax(score[tail])])
    beats = [i]
    while back[i] >= 0:
        i = int(back[i])
        beats.append(i)
    beats = np.array(beats[::-1], dtype=np.float64)
    # sub-frame: each beat on the envelope's own peak (parabolic) within a frame either side
    out = []
    for b in beats.astype(int):
        if 0 < b < n - 1:
            a, c, d = env[b - 1], env[b], env[b + 1]
            den = a - 2 * c + d
            out.append(b + (float(np.clip(0.5 * (a - d) / den, -0.5, 0.5)) if den < -1e-12 else 0.0))
        else:
            out.append(float(b))
    return np.array(out)


def fill(times: np.ndarray, bpm: float, duration: float) -> np.ndarray:
    """The beat grid across the whole clip: a gap the tracker left (a held pose, a quiet bar) gets its missing beats,
    and the grid runs to both ends of the clip at the tempo."""
    if times.size == 0 or not 0 < bpm < 1000:
        return times
    period = 60.0 / bpm
    out = [float(times[0])]
    for t in times[1:]:
        gap = t - out[-1]
        k = int(round(gap / period))
        for j in range(1, k):
            out.append(out[-1] + gap / k)
        out.append(float(t))
    while out[0] - period >= -0.02:
        out.insert(0, out[0] - period)
    while out[-1] + period <= duration + 0.02:
        out.append(out[-1] + period)
    return np.clip(np.array(out), 0.0, duration)


def find(bundle: Path, audio: str | None = None) -> dict | None:
    """The beat of a bundle, or None when neither its sound nor its body has one."""
    dream = json.loads((bundle / "dream.json").read_text())
    duration = float(dream.get("durationS") or 0)
    track_name = audio or dream.get("audio")
    env = rate = None
    source = None
    if track_name and (bundle / track_name).exists():
        x = decode(bundle / track_name)
        level = dbfs(x)
        print(f"[beats] {track_name}: {x.size / SR:.2f} s, {level:.1f} dBFS")
        if level > SILENT_DBFS:
            env, rate = audio_envelope(x)
            source = "audio"
            duration = duration or x.size / SR
        else:
            print("[beats] the clip is silent: trying the body")
    if env is None and dream.get("joints") and (bundle / dream["joints"]).exists():
        joints = json.loads((bundle / dream["joints"]).read_text())
        env, rate = motion_envelope(joints)
        source = "motion"
        duration = duration or (len(joints["frames"]) - 1) / float(joints["fps"])
    if env is None or not env.any():
        return None
    bpm, conf = tempo(env, rate)
    if bpm <= 0:
        return None
    times = fill(track(env, rate, bpm) / rate, bpm, duration)
    if times.size >= 2:  # the tempo the beats actually keep, which the grid was fitted to
        bpm = 60.0 / float(np.median(np.diff(times)))
    return {
        "bpm": round(bpm, 1),
        "times": [round(float(t), 3) for t in times],
        "source": source,
        "confidence": round(conf, 2),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("bundle", type=Path)
    ap.add_argument("--audio", help="the track to read (default: dream.json's audio)")
    ap.add_argument("--write", action="store_true", help="write beats.json and add it to dream.json")
    a = ap.parse_args(argv)
    beats = find(a.bundle, a.audio)
    if not beats:
        print("BEATS_NONE")
        return 1
    print(f"[beats] {beats['bpm']} BPM from the {beats['source']}, {len(beats['times'])} beats, confidence {beats['confidence']}")
    print(f"[beats] times {beats['times']}")
    if a.write:
        (a.bundle / "beats.json").write_text(json.dumps(beats, indent=2) + "\n")
        path = a.bundle / "dream.json"
        dream = json.loads(path.read_text())
        if dream.get("beats") != "beats.json":
            dream["beats"] = "beats.json"
            path.write_text(json.dumps(dream, indent=2) + "\n")
        print(f"[beats] wrote {a.bundle / 'beats.json'}")
    print("BEATS_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
