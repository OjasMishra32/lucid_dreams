"""The song's beats, so cuts land on them: onset strength from spectral flux, the tempo from its autocorrelation, then
the beat grid that best fits the onsets, plus the loudest moments (drops) and the quiet stretches. Writes
~/Downloads/lucid-video/scan/beats.json.

  avatars/.venv/bin/python demo/film/beats.py music/track.mp3
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path.home() / "Downloads" / "lucid-video"
SR = 22050
HOP = 512


def main(src: str) -> None:
    path = ROOT / src if not Path(src).is_absolute() else Path(src)
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True)
    x = np.frombuffer(r.stdout, np.float32)
    n = 2048
    win = np.hanning(n).astype(np.float32)
    frames = np.lib.stride_tricks.sliding_window_view(x, n)[::HOP] * win
    mag = np.abs(np.fft.rfft(frames, axis=1))
    logm = np.log1p(mag)
    flux = np.r_[0, np.maximum(0, np.diff(logm, axis=0)).sum(axis=1)]
    flux = (flux - flux.mean()) / (flux.std() + 1e-9)
    fps = SR / HOP
    # tempo between 60 and 180 bpm from the onset envelope's autocorrelation
    ac = np.correlate(flux, flux, "full")[len(flux) - 1:]
    lags = np.arange(len(ac))
    lo, hi = int(fps * 60 / 180), int(fps * 60 / 60)
    lag = lo + int(np.argmax(ac[lo:hi]))
    bpm = 60 * fps / lag
    # the phase whose grid catches the most onset energy
    phase = int(np.argmax([flux[p::lag].sum() for p in range(lag)]))
    beats = [round(float(i / fps), 3) for i in range(phase, len(flux), lag)]
    rms = np.sqrt((frames ** 2).mean(axis=1))
    sec = np.array([rms[int(s * fps):int((s + 1) * fps)].mean() for s in range(int(len(rms) / fps))])
    loud = sec / (sec.max() + 1e-9)
    drops = [int(i) for i in np.argsort(-np.r_[0, np.diff(loud)])[:6]]
    quiet = [int(i) for i, v in enumerate(loud) if v < 0.25]
    out = {"bpm": round(float(bpm), 1), "beats": beats, "loudness_per_second": [round(float(v), 3) for v in loud],
           "rises": sorted(drops), "quiet_seconds": quiet, "duration": round(len(x) / SR, 2)}
    (ROOT / "scan").mkdir(parents=True, exist_ok=True)
    (ROOT / "scan" / "beats.json").write_text(json.dumps(out))
    print(f"{path.name}: {out['duration']} s, {out['bpm']} bpm, {len(beats)} beats, biggest rises at {sorted(drops)} s")


if __name__ == "__main__":
    main(sys.argv[1])
