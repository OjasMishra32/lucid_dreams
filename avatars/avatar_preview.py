#!/usr/bin/env python3
"""An avatar bundle's card preview on black (preview.mp4 + thumb.jpg), the way every replay's is (pipeline/lucid/hero.py):
posed by its own motion through the clip, the camera starting on their front and swaying gently either side (about
34 degrees), the whole body framed. LHM++'s own turntable (lhmpp_avatar.py build) is on white and spends half its time
on the back, which reads as a white box on a black page.

    python avatar_preview.py <bundle dir> [--frames 120] [--sway 34] [--size 1080x1920]

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
    mid = np.array([0.0, (lo + hi) / 2, 0.0])
    dist = (hi - lo) * FILL / 2 / math.tan(math.radians(FOV) / 2)
    f = (H / 2) / math.tan(math.radians(FOV) / 2)
    K = torch.tensor([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1]], dtype=torch.float32, device="cuda")
    black = torch.zeros(1, 3, device="cuda")

    imgs = []
    for k in range(a.frames):
        gs = gs0 if k == 0 else posed_gaussians(a.bundle, k % n_motion)
        angle = a.sway * math.sin(2 * math.pi * k / a.frames)
        V = torch.as_tensor(look_at(orbit_eye(mid, dist, angle), mid), dtype=torch.float32, device="cuda")
        with torch.no_grad():
            img, _, _ = rasterization(gs["means"], gs["quats"], gs["scales"], gs["opacities"], gs["colors"], V[None], K[None],
                                      W, H, near_plane=0.05, sh_degree=gs["sh_degree"], backgrounds=black)
        imgs.append((img[0].clamp(0, 1).cpu().numpy() * 255).astype(np.uint8))
    part = a.bundle / "preview.part.mp4"
    iio.mimwrite(part, imgs, fps=30, codec="libx264", quality=8, macro_block_size=8)
    part.replace(a.bundle / "preview.mp4")
    Image.fromarray(imgs[0]).save(a.bundle / "thumb.jpg", quality=92)
    print(f"PREVIEW_OK {a.bundle}: {a.frames} frames {W}x{H}, black, from the front, sway {a.sway:.0f} degrees")


if __name__ == "__main__":
    main()
