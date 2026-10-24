"""A replay's card preview (preview.mp4, thumb.jpg), rendered from the bundle's own SPZ frames: the camera starts on
their face and sways gently either side (about 34 degrees) while they move, the whole body framed over the whole clip.
A full orbit spends half its time on the back, which the camera never saw; this keeps to the side people look at
first and still shows they're 3D.

  python -m lucid.hero <bundle dir> [<bundle dir> ...] [--size 1080x1920] [--sway 0.6]

Bundle space: the person faces -Z (export.orbit_camera's angle 0 is in front of them), floor at y = 0.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
from pathlib import Path

import numpy as np

from lucid.export import orbit_camera, render
from lucid.gaussians import read_spz

FILL = 1.12  # the body's height times this fills the frame's height
TAN_HALF_FOV = math.tan(math.radians(40.0) / 2)  # export.render's vertical field of view


def hero(bundle: Path, size: str, sway: float, device: str) -> None:
    from PIL import Image

    dream = json.loads((bundle / "dream.json").read_text())
    frames = dream["frames"]
    pattern = frames.get("spz") or frames["pattern"].replace(".ply", ".spz")
    paths = [bundle / frames["dir"] / (pattern % i) for i in range(dream["frameCount"])]
    paths = [p for p in paths if p.exists()]
    if not paths:
        raise SystemExit(f"{bundle}: no SPZ frames")
    # where they are in every frame (their solid Gaussians): the frame holds the whole clip's height (a jump included)
    # and follows them across the floor, smoothed, so someone who runs or jumps never leaves the picture
    frames_g = [read_spz(p) for p in paths]
    tops, bottoms, centres = [], [], []
    for g in frames_g:
        solid = g.means[g.opacities > 0]
        solid = solid if len(solid) > 100 else g.means
        tops.append(np.percentile(solid[:, 1], 99.5))
        bottoms.append(np.percentile(solid[:, 1], 0.5))
        centres.append(np.median(solid[:, [0, 2]], 0))
    low, high = min(0.0, float(np.min(bottoms))), float(np.max(tops))
    height = high - low
    middle = (low + high) / 2
    track = np.asarray(centres)
    kernel = np.hanning(15) / np.hanning(15).sum()
    track = np.stack([np.convolve(np.pad(track[:, i], 7, mode="edge"), kernel, mode="valid") for i in range(2)], 1)
    spread = float(np.ptp(track[:, 0]) + np.ptp(track[:, 1]))  # how far they travel: a little more room
    radius = FILL * height / 2 / TAN_HALF_FOV + 0.3 + 0.25 * spread
    w, h = (int(v) for v in size.split("x"))
    fps = float(dream.get("fps", 25))
    part = bundle / "preview.part.mp4"  # renamed once whole, so a failed run never leaves a broken preview
    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", f"{fps:g}", "-i", "-",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart", str(part)],
        stdin=subprocess.PIPE,
    )
    try:
        for k, g in enumerate(frames_g):
            angle = sway * math.sin(2 * math.pi * k / len(frames_g))  # front, one side, the other, front: a seamless loop
            centre = (float(track[k, 0]), float(track[k, 1]))
            frame = render(g, orbit_camera(angle, radius, middle + 0.05 * height, middle, centre), w, h, np.zeros(3), device)
            if k == 0:
                Image.fromarray(frame).save(bundle / "thumb.jpg", quality=92)
            ff.stdin.write(frame.tobytes())
        ff.stdin.close()
    except BaseException:
        ff.kill()
        part.unlink(missing_ok=True)
        raise
    if ff.wait() != 0:
        part.unlink(missing_ok=True)
        raise SystemExit("ffmpeg failed writing preview.mp4")
    part.replace(bundle / "preview.mp4")
    print("HERO_OK", bundle, len(frames_g), "frames", flush=True)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("bundles", type=Path, nargs="+")
    ap.add_argument("--size", default="1080x1920")
    ap.add_argument("--sway", type=float, default=0.6, help="radians either side of the front")
    ap.add_argument("--device", default="cuda")
    a = ap.parse_args(argv)
    for b in a.bundles:
        hero(b, a.size, a.sway, a.device)


if __name__ == "__main__":
    main()
