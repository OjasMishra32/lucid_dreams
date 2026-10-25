"""Polish headset footage into selects for the cut: each pick trimmed, conformed to 30 fps and steadied.

A headset recording shakes with every small head movement. For each pick this measures how far each frame moved from
the one before (phase correlation on a small grey copy), sums that into the camera's path, smooths the path with a
Gaussian (a turn of the head stays, the jitter on top of it goes) and crops every frame back onto the smooth path,
zoomed in just enough to hide the edges. Sound comes along untouched. numpy and ffmpeg only.

  avatars/.venv/bin/python demo/film/steady.py demo/film/selects.json      every select in the list
  avatars/.venv/bin/python demo/film/steady.py demo/film/selects.json rally  the ones whose name contains "rally"

selects.json: [{"name": "tennis-rally", "src": "quest/tennis-1.mp4", "in": 27.7, "out": 33.3,
                "smooth": 0.06, "zoom": 1.08}, ...]   (smooth: seconds, default 0.1; zoom default 1.06)   (paths relative to ~/Downloads/lucid-video)
Writes ~/Downloads/lucid-video/selects/<name>.mp4 (1920x1080, 30 fps, H.264 crf 14, AAC) and <name>.json (the path).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path.home() / "Downloads" / "lucid-video"
OUT = ROOT / "selects"
W, H, FPS = 1920, 1080, 30
AW, AH = 480, 270  # analysis size (a quarter)


def frames(src: Path, t0: float, dur: float, w: int, h: int, fmt: str) -> np.ndarray:
    """The pick's frames at 30 fps, as uint8 (n, h, w) for gray or (n, h, w, 3) for rgb24."""
    ch = 1 if fmt == "gray" else 3
    r = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t0:.3f}", "-i", str(src), "-t", f"{dur:.3f}",
                        "-vf", f"fps={FPS},scale={w}:{h}:flags=area", "-pix_fmt", fmt, "-f", "rawvideo", "-"],
                       capture_output=True, check=True)
    a = np.frombuffer(r.stdout, np.uint8)
    n = a.size // (w * h * ch)
    return a[: n * w * h * ch].reshape((n, h, w) if ch == 1 else (n, h, w, ch))


def shift_between(a: np.ndarray, b: np.ndarray, win: np.ndarray) -> tuple[float, float, float]:
    """How far the picture moved from a to b, in pixels (dx, dy), and how sure (the correlation peak: ~0.3-0.9 on
    texture, ~0.02 on plain sky): phase correlation with a sub-pixel peak."""
    fa = np.fft.fft2((a - a.mean()) * win)
    fb = np.fft.fft2((b - b.mean()) * win)
    r = fb * np.conj(fa)
    r /= np.abs(r) + 1e-9
    c = np.fft.ifft2(r).real
    py, px = np.unravel_index(np.argmax(c), c.shape)
    h, w = c.shape

    def sub(m1: float, m0: float, p1: float) -> float:
        d = m1 - 2 * m0 + p1
        return 0.0 if abs(d) < 1e-12 else 0.5 * (m1 - p1) / d

    dx = px + sub(c[py, (px - 1) % w], c[py, px], c[py, (px + 1) % w])
    dy = py + sub(c[(py - 1) % h, px], c[py, px], c[(py + 1) % h, px])
    if dx > w / 2:
        dx -= w
    if dy > h / 2:
        dy -= h
    return float(dx), float(dy), float(c[py, px])


def gaussian(x: np.ndarray, sigma: float) -> np.ndarray:
    if sigma <= 0:
        return x.copy()
    k = int(np.ceil(sigma * 3))
    t = np.arange(-k, k + 1)
    g = np.exp(-0.5 * (t / sigma) ** 2)
    g /= g.sum()
    p = np.pad(x, (k, k), mode="reflect")
    return np.convolve(p, g, mode="valid")


def steady(sel: dict) -> None:
    src = ROOT / sel["src"]
    t0, dur = float(sel["in"]), float(sel["out"]) - float(sel["in"])
    zoom = float(sel.get("zoom", 1.06))
    smooth = float(sel.get("smooth", 0.1))  # seconds: the Gaussian's sigma on the path (longer fights real head turns)

    # the path: per-frame motion on a small grey copy, summed
    g = frames(src, t0, dur, AW, AH, "gray").astype(np.float32)
    win = np.outer(np.hanning(AH), np.hanning(AW)).astype(np.float32)
    steps = np.array([(0.0, 0.0, 1.0)] + [shift_between(g[i - 1], g[i], win) for i in range(1, len(g))])
    # plain sky (looking up at a toss) has nothing to lock onto: those frames take their neighbours' motion
    ok = steps[:, 2] > 0.06
    idx = np.arange(len(steps))
    if ok.sum() >= 2:
        for k in range(2):
            steps[~ok, k] = np.interp(idx[~ok], idx[ok], steps[ok, k])
    d = steps[:, :2] * (W / AW)
    # a head turn faster than this per frame is a real move (or a mis-measure): never fight it
    d = np.clip(d, -120, 120)
    path = np.cumsum(d, axis=0)
    smooth_path = np.stack([gaussian(path[:, k], smooth * FPS) for k in range(2)], axis=1)
    fix = smooth_path - path  # move each frame by this to put it on the smooth path
    mx, my = W * (1 - 1 / zoom) / 2, H * (1 - 1 / zoom) / 2
    # a soft limit at the crop's edge: a hard one would let the picture jump the moment it lets go
    fix[:, 0] = mx * np.tanh(fix[:, 0] / mx)
    fix[:, 1] = my * np.tanh(fix[:, 1] / my)

    # the picture: every frame cropped onto the smooth path (bilinear for the sub-pixel part), scaled back to full size
    cw, chh = int(round(W / zoom)) // 2 * 2, int(round(H / zoom)) // 2 * 2
    OUT.mkdir(parents=True, exist_ok=True)
    dst = OUT / f"{sel['name']}.mp4"
    enc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{cw}x{chh}", "-r", str(FPS), "-i", "-",
         "-ss", f"{t0:.3f}", "-t", f"{dur:.3f}", "-i", str(src),
         "-map", "0:v", "-map", "1:a?", "-vf", f"scale={W}:{H}:flags=lanczos,setsar=1",
         "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k",
         "-shortest", "-movflags", "+faststart", str(dst)],
        stdin=subprocess.PIPE)
    full = frames(src, t0, dur, W, H, "rgb24")
    n = min(len(full), len(fix))
    for i in range(n):
        # the crop's top-left: centred, then moved against the shake (moving the content by +fix = the window by -fix)
        x = (W - cw) / 2 - fix[i, 0]
        y = (H - chh) / 2 - fix[i, 1]
        x0, y0 = int(np.floor(x)), int(np.floor(y))
        fx, fy = x - x0, y - y0
        x0 = min(max(x0, 0), W - cw - 1)
        y0 = min(max(y0, 0), H - chh - 1)
        f = full[i].astype(np.float32)
        a = f[y0:y0 + chh, x0:x0 + cw]
        b = f[y0:y0 + chh, x0 + 1:x0 + cw + 1]
        c = f[y0 + 1:y0 + chh + 1, x0:x0 + cw]
        e = f[y0 + 1:y0 + chh + 1, x0 + 1:x0 + cw + 1]
        out = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy
        enc.stdin.write(np.clip(out + 0.5, 0, 255).astype(np.uint8).tobytes())
    enc.stdin.close()
    enc.wait()
    jitter = lambda p: float(np.abs(np.diff(p, n=2, axis=0)).mean())  # mean frame-to-frame change in velocity, px
    report = {"src": sel["src"], "in": t0, "out": t0 + dur, "frames": n, "zoom": zoom, "smooth": smooth,
              "jitterBefore": round(jitter(path), 2), "jitterAfter": round(jitter(path + fix), 2),
              "unsure": int((~ok).sum()), "maxFix": [round(float(np.abs(fix[:, 0]).max()), 1), round(float(np.abs(fix[:, 1]).max()), 1)]}
    (OUT / f"{sel['name']}.json").write_text(json.dumps(report, indent=1))
    print(sel["name"], report)


def main() -> None:
    sels = json.loads(Path(sys.argv[1]).read_text())
    want = sys.argv[2] if len(sys.argv) > 2 else ""
    for s in sels:
        if want in s["name"]:
            steady(s)


if __name__ == "__main__":
    main()
