"""One more real view of the freeze: another calibrated camera's frame at the same instant, cropped around one player.

    python3 -I extra_view.py --video <clip> --calib <that camera's calibration> --frame N --masks <dir> \
        --player NAME [--with NAME,...] [--front NAME,...] --out <dir> [--margin 32]

Masks are <masks>/<name>.png or <masks>/<name>/<N:06d>.png (white = them). The frame is warped into its own camera
with the lens distortion taken out (pinhole, same R and f), then cropped natively (never rescaled) to the smallest 9:16
window around the player. Writes <out>/frame.png, mask.png (the player and what they carry, minus who's in front),
ignore.png (who's in front of them), focal.txt (f in these pixels) and camera.json (R, C, K of the crop, in the
calibration's court frame), the layout of each run's real/<view>/<player>/.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cv2  # noqa: E402
import numpy as np  # noqa: E402

import player_clip as pc  # noqa: E402
import stabilize as st  # noqa: E402


def _read(path: Path, w: int, h: int) -> np.ndarray:
    m = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if m is None:
        raise FileNotFoundError(f"{path}: no mask")
    if m.shape != (h, w):
        m = cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR)
    return m.astype(np.float32) / 255.0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--video", type=Path, required=True)
    ap.add_argument("--calib", type=Path, required=True)
    ap.add_argument("--frame", type=int, required=True)
    ap.add_argument("--masks", type=Path, required=True)
    ap.add_argument("--player", required=True)
    ap.add_argument("--with", dest="carried", default="")
    ap.add_argument("--front", default="")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--margin", type=int, default=32)
    ap.add_argument("--grow", type=int, default=3)
    ap.add_argument("--near", type=int, default=200)
    a = ap.parse_args(argv)
    calib = json.loads(a.calib.read_text())
    w, h = calib["image_size"]
    fr = calib["frames"][st.frame_index(calib, a.frame)]
    still = st.ref_still_camera(calib, a.frame)
    names = lambda s: [x for x in s.split(",") if x]  # noqa: E731
    raw = {who: _read(a.masks / f"{who}.png" if (a.masks / f"{who}.png").exists() else a.masks / who / f"{a.frame:06d}.png",
                      w, h) for who in [a.player, *names(a.carried), *names(a.front)]}
    alpha_native = pc.player_alpha(raw[a.player], [raw[c] for c in names(a.carried)], [raw[o] for o in names(a.front)],
                                   a.grow)
    box = pc.mask_box_on_canvas(alpha_native, still, fr, w, h)
    if box is None:
        raise SystemExit(f"the {a.player} mask is empty")
    cw, ch, _ = pc.clip_window(box, 2, 2, (10 ** 6, 10 ** 6), a.margin)
    x0, y0 = pc.fit_crop(box, cw, ch, w, h, a.margin)
    maps = st.crop_maps(still, fr, w, h, x0, y0, cw, ch)
    frames = pc.decode_frames(a.video, {a.frame}, w, h)
    _, rgb = next(frames)
    frames.close()
    img = pc.warp(rgb, maps, cv2.INTER_LANCZOS4)
    wm = {who: pc.warp(m, maps, cv2.INTER_LINEAR) for who, m in raw.items()}
    front = [wm[o] for o in names(a.front)]
    alpha = pc.player_alpha(wm[a.player], [wm[c] for c in names(a.carried)], front, a.grow)
    ignore = pc.ignore_mask(wm[a.player], front, a.grow, a.near) * (alpha <= 0)
    a.out.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(a.out / "frame.png"), cv2.cvtColor(img, cv2.COLOR_RGB2BGR))
    pc.write_png(a.out / "mask.png", alpha)
    pc.write_png(a.out / "ignore.png", ignore)
    K = np.array(still["K"], float)
    focal = round(float(K[0, 0]), 1)
    (a.out / "focal.txt").write_text(f"{focal}\n")
    (a.out / "camera.json").write_text(json.dumps({
        "frame": a.frame, "player": a.player, "size": [cw, ch], "crop": [x0, y0, cw, ch], "R": still["R"], "C": still["C"],
        "K": [[focal, 0, round(K[0, 2] - x0, 3)], [0, focal, round(K[1, 2] - y0, 3)], [0, 0, 1]],
        "note": "pinhole camera of frame.png's pixels: x_cam = R (X - C), court metres; lens distortion removed",
        "calib": {"path": str(a.calib), "sha256": pc.sha256(a.calib)}}, indent=1))
    print(f"{a.player} at frame {a.frame}: {cw}x{ch} crop at ({x0},{y0}), player {round(box[3] - box[1])} px tall, "
          f"focal {focal} -> {a.out}")


if __name__ == "__main__":
    main()
