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
    lo, hi = np.asarray(dream["bounds"]["min"], float), np.asarray(dream["bounds"]["max"], float)
    height = float(hi[1] - lo[1])
    middle = float((lo[1] + hi[1]) / 2)
    centre = (float((lo[0] + hi[0]) / 2), float((lo[2] + hi[2]) / 2))
    radius = FILL * height / 2 / TAN_HALF_FOV + float(hi[2] - lo[2]) / 2
    w, h = (int(v) for v in size.split("x"))
    fps = float(dream.get("fps", 25))
    part = bundle / "preview.part.mp4"  # renamed once whole, so a failed run never leaves a broken preview
    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", f"{fps:g}", "-i", "-",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart", str(part)],
        stdin=subprocess.PIPE,
    )
    try:
        for k, p in enumerate(paths):
            angle = sway * math.sin(2 * math.pi * k / len(paths))  # front, one side, the other, front: a seamless loop
            frame = render(read_spz(p), orbit_camera(angle, radius, middle + 0.05 * height, middle, centre), w, h, np.zeros(3), device)
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
    print("HERO_OK", bundle, len(paths), "frames", flush=True)


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
