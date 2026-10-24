#!/usr/bin/env python3
"""An avatar bundle's card preview on black (preview.mp4 + thumb.jpg), the way every replay's is (pipeline/lucid/hero.py):
posed by its own motion through the clip, the camera starting on their front and swaying gently either side (about
34 degrees), the whole body framed. LHM++'s own turntable (lhmpp_avatar.py build) is on white and spends half its time
on the back, which reads as a white box on a black page.

    python avatar_preview.py <bundle dir> [--frames 120] [--sway 34] [--size 1080x1920] [--eye 1.55 --aim 1.25 --fov 40]

--eye puts the camera where a person standing in front of them has their eyes (metres), aimed at --aim (their chest)
through a normal lens (--fov, vertical degrees), as far back as the whole body needs: they look the way they do to
someone in the room. Without it, the camera is level with the middle of the body (a flatter, longer look).

Runs in the LHM++ env (gsplat, pytorch3d: what lhmpp_avatar.posed_gaussians poses with), on a GPU, with LHM++'s repo
as the working directory. Bundle space: the person faces -Z, floor at y = 0.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

FILL = 1.12  # the body's height times this fills the frame's height
FOV = 28.0  # vertical field of view, degrees (lhmpp_avatar's FULL views)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("bundle", type=Path)
    p.add_argument("--frames", type=int, default=120)
    p.add_argument("--sway", type=float, default=34.0, help="degrees either side of their front")
    p.add_argument("--size", default="1080x1920")
    p.add_argument("--eye", type=float, default=None, help="camera height (m): a standing person's eyes")
    p.add_argument("--aim", type=float, default=1.25, help="the height it looks at (m), with --eye")
    p.add_argument("--fov", type=float, default=None, help="vertical field of view (degrees); 40 with --eye")
    a = p.parse_args()

    import imageio.v2 as iio
    import torch
    from gsplat import rasterization
    from PIL import Image

    from lhmpp_avatar import look_at, orbit_eye, posed_gaussians

    W, H = (int(v) for v in a.size.split("x"))
    dream = json.loads((a.bundle / "dream.json").read_text())
    motion = json.loads((a.bundle / dream["avatar"]["motion"]).read_text())
    n_motion = len(motion["frames"])

    # framing from the first pose: the opaque body's height, centred
    gs0 = posed_gaussians(a.bundle, 0)
    ys = gs0["means"][gs0["opacities"] > 0.5][:, 1]
    lo, hi = float(ys.min()), float(ys.max())
    fov = a.fov or (40.0 if a.eye else FOV)
    half = math.radians(fov) / 2
    f = (H / 2) / math.tan(half)
    cy = H / 2
    if a.eye:
        # eye height, looking at the chest, as close as keeps the hair and the soles in 90% of the frame; the frame is
        # then shifted (a shift lens: the image centre moves, the perspective doesn't) so the body sits in its middle
        mid = np.array([0.0, a.aim, 0.0])
        top, bottom = hi + 0.03, lo - 0.02
        dist = 1.8
        while dist < 9:
            pitch = math.atan2(a.eye - a.aim, dist)
            t_top = math.tan(math.atan2(a.eye - top, dist) - pitch)  # below the axis is positive
            t_bot = math.tan(math.atan2(a.eye - bottom, dist) - pitch)
            if f * (t_bot - t_top) <= 0.9 * H:
                break
            dist += 0.02
        cy = H / 2 - f * (t_top + t_bot) / 2
        eye_y = a.eye
    else:
        mid = np.array([0.0, (lo + hi) / 2, 0.0])
        dist = (hi - lo) * FILL / 2 / math.tan(half)
        eye_y = None
    K = torch.tensor([[f, 0, W / 2], [0, f, cy], [0, 0, 1]], dtype=torch.float32, device="cuda")
    black = torch.zeros(1, 3, device="cuda")

    imgs = []
    for k in range(a.frames):
        gs = gs0 if k == 0 else posed_gaussians(a.bundle, k % n_motion)
        angle = a.sway * math.sin(2 * math.pi * k / a.frames)
        cam = orbit_eye(mid, dist, angle)
        if eye_y is not None:
            cam[1] = eye_y
        V = torch.as_tensor(look_at(cam, mid), dtype=torch.float32, device="cuda")
        with torch.no_grad():
            img, _, _ = rasterization(gs["means"], gs["quats"], gs["scales"], gs["opacities"], gs["colors"], V[None], K[None],
                                      W, H, near_plane=0.05, sh_degree=gs["sh_degree"], backgrounds=black)
        imgs.append((img[0].clamp(0, 1).cpu().numpy() * 255).astype(np.uint8))
    part = a.bundle / "preview.part.mp4"
    iio.mimwrite(part, imgs, fps=30, codec="libx264", quality=8, macro_block_size=8)
    part.replace(a.bundle / "preview.mp4")
    Image.fromarray(imgs[0]).save(a.bundle / "thumb.jpg", quality=92)
    view = f"eyes at {a.eye} m, {dist:.2f} m away, {fov:.0f} degree lens" if a.eye else f"level with the body's middle, {fov:.0f} degree lens"
    print(f"PREVIEW_OK {a.bundle}: {a.frames} frames {W}x{H}, black, from the front ({view}), sway {a.sway:.0f} degrees")


if __name__ == "__main__":
    main()
