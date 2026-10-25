"""Review raw footage for the film: for every clip in ~/Downloads/lucid-video/{quest,phone}, a contact sheet (one frame
a second, 8 across, frame k is second k) and a per-second score of what's usable: sharpness (Laplacian variance),
shake (frame-to-frame change), brightness (black or loading frames) and frozen stretches. Writes
~/Downloads/lucid-video/scan/<clip>.jpg and scan/report.json, best seconds first per clip.

  avatars/.venv/bin/python demo/film/scan.py            every clip
  avatars/.venv/bin/python demo/film/scan.py chess      clips whose name contains "chess"
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path.home() / "Downloads" / "lucid-video"
OUT = ROOT / "scan"
VIDEO = {".mp4", ".mov", ".m4v", ".mkv", ".webm"}
W = 192  # analysis width (height follows the clip's aspect)
RATE = 4  # analysis frames per second


def probe(p: Path) -> dict:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate",
                        "-of", "json", str(p)], capture_output=True, text=True)
    j = json.loads(r.stdout or "{}")
    v = next((s for s in j.get("streams", []) if s.get("codec_type") == "video"), {})
    num, den = (v.get("r_frame_rate") or "0/1").split("/")
    return {
        "duration": float(j.get("format", {}).get("duration", 0) or 0),
        "width": v.get("width"),
        "height": v.get("height"),
        "fps": round(float(num) / max(1.0, float(den)), 2),
        "audio": any(s.get("codec_type") == "audio" for s in j.get("streams", [])),
    }


def frames(p: Path, w: int, h: int) -> np.ndarray:
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(p), "-vf", f"fps={RATE},scale={w}:{h}", "-f", "rawvideo",
                        "-pix_fmt", "gray", "-"], capture_output=True)
    a = np.frombuffer(r.stdout, np.uint8)
    n = a.size // (w * h)
    return a[: n * w * h].reshape(n, h, w).astype(np.float32)


def sheet(p: Path, out: Path, dur: float) -> None:
    rows = max(1, int(np.ceil(dur / 8)))
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(p), "-vf", f"fps=1,scale=240:-2,tile=8x{rows}:padding=4:color=black",
                    "-frames:v", "1", "-q:v", "4", str(out)], check=False)


def score(f: np.ndarray) -> list[dict]:
    lap = np.abs(f[:, :-2, 1:-1] + f[:, 2:, 1:-1] + f[:, 1:-1, :-2] + f[:, 1:-1, 2:] - 4 * f[:, 1:-1, 1:-1])
    sharp = lap.var(axis=(1, 2))
    bright = f.mean(axis=(1, 2))
    diff = np.r_[0.0, np.abs(np.diff(f, axis=0)).mean(axis=(1, 2))]
    out = []
    for s in range(int(np.ceil(len(f) / RATE))):
        sl = slice(s * RATE, (s + 1) * RATE)
        out.append({
            "t": s,
            "sharp": round(float(np.median(sharp[sl])), 1),
            "shake": round(float(np.median(diff[sl])), 2),
            "bright": round(float(np.median(bright[sl])), 1),
            "frozen": bool(np.max(diff[sl]) < 0.3) if s > 0 else False,
        })
    if out:
        sh = np.array([o["sharp"] for o in out])
        mv = np.array([o["shake"] for o in out])
        sn = sh / max(1e-6, np.percentile(sh, 90))
        # movement is good up to a point (people move); above the clip's own 75th percentile it's the head shaking
        calm = 1 - np.clip((mv - np.percentile(mv, 50)) / max(1e-6, np.percentile(mv, 90) - np.percentile(mv, 50)), 0, 1)
        for o, a, c in zip(out, sn, calm):
            dark = o["bright"] < 18
            o["score"] = round(float(0 if dark or o["frozen"] else 0.6 * min(a, 1.2) + 0.4 * c), 3)
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    words = [w.lower() for w in sys.argv[1:]]
    clips = sorted(p for d in ("quest", "phone") for p in (ROOT / d).glob("*") if p.suffix.lower() in VIDEO
                   and all(w in p.name.lower() for w in words))
    report_path = OUT / "report.json"
    report = json.loads(report_path.read_text()) if report_path.exists() else {}
    for p in clips:
        info = probe(p)
        if not info["width"]:
            continue
        h = int(round(W * info["height"] / info["width"] / 2) * 2)
        secs = score(frames(p, W, h))
        sheet(p, OUT / f"{p.parent.name}-{p.stem}.jpg", info["duration"])
        best = sorted((s for s in secs if s["score"] > 0), key=lambda s: -s["score"])[:6]
        report[f"{p.parent.name}/{p.name}"] = {**info, "best": [s["t"] for s in best], "seconds": secs}
        print(f"{p.parent.name}/{p.name}: {info['duration']:.1f} s {info['width']}x{info['height']} {info['fps']} fps "
              f"audio={info['audio']} best seconds {[s['t'] for s in best]}")
    report_path.write_text(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
