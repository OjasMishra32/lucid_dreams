"""One more real view of the freeze: another calibrated camera's frame at the same instant, cropped around one player,
in the form recon's --extra-sources reads.

    python3 -I extra_view.py --video <clip> --calib <that camera's calibration> --frame N --masks <dir> \
        --player NAME [--with NAME,...] [--front NAME,...] --out <dir> [--margin 32]

Masks are <masks>/<name>.png or <masks>/<name>/<N:06d>.png (white = them). The frame is warped into its own camera
with the lens distortion taken out (pinhole, same R and f), then cropped natively (never rescaled) to the smallest 9:16
window around the player. Writes <out>/<out name>.mkv (FFV1, that one frame), masks/000000.png (the player and what
they carry, minus who's in front), ignore/000000.png (who's in front of them), focal.txt (f in these pixels) and
camera.json (R, C, K of the crop, in the calibration's court frame). In --extra-sources: {"video": <out>/<name>.mkv,
"offset": -K, "masks": <out>/masks, "ignore": <out>/ignore, "focal": <focal.txt>, "weight": w}.
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


def read_mask(masks: Path, name: str, n: int, w: int, h: int) -> np.ndarray:
    flat = masks / f"{name}.png"
    path = flat if flat.exists() else masks / name / f"{n:06d}.png"
    m = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if m is None:
        raise FileNotFoundError(f"{path}: no mask")
    if m.shape != (h, w):
        m = cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR)
    return m.astype(np.float32) / 255.0


def read_matte(masks: Path, name: str, n: int, w: int, h: int) -> np.ndarray:
    """The soft matte (<name>-alpha.png, or <name>-alpha/<n>.png) when one was made, else the binary mask."""
    for soft in (masks / f"{name}-alpha.png", masks / f"{name}-alpha" / f"{n:06d}.png"):
        if soft.exists():
            return read_mask(soft.parent, soft.stem, n, w, h)
    return read_mask(masks, name, n, w, h)


def make_view(video: Path, calib_path: Path, frame: int, masks: Path, player: str, carried: list[str],
              front: list[str], out: Path, margin: int = 32, grow: int = 3, near: int = 200) -> dict:
    calib = json.loads(Path(calib_path).read_text())
    w, h = calib["image_size"]
    fr = calib["frames"][st.frame_index(calib, frame)]
    still = st.ref_still_camera(calib, frame)
    raw = {who: read_mask(masks, who, frame, w, h) for who in [player, *carried, *front]}
    alpha_native = pc.player_alpha(raw[player], [raw[c] for c in carried], [raw[o] for o in front], grow)
    box = pc.mask_box_on_canvas(alpha_native, still, fr, w, h)
    if box is None:
        raise SystemExit(f"the {player} mask is empty")
    cw, ch, _ = pc.clip_window(box, 2, 2, (10 ** 6, 10 ** 6), margin)
    x0, y0 = pc.fit_crop(box, cw, ch, w, h, margin)
    maps = st.crop_maps(still, fr, w, h, x0, y0, cw, ch)
    frames = pc.decode_frames(Path(video), {frame}, w, h)
    _, rgb = next(frames)
    frames.close()
    img = pc.warp(rgb, maps, cv2.INTER_LANCZOS4)
    wm = {who: pc.warp(m, maps, cv2.INTER_LINEAR) for who, m in raw.items()}
    fronts = [wm[o] for o in front]
    soft = [pc.warp(read_matte(masks, who, frame, w, h), maps, cv2.INTER_LINEAR) for who in [player, *carried]]
    alpha = pc.player_alpha(soft[0], soft[1:], fronts, grow)
    ignore = pc.ignore_mask(wm[player], fronts, grow, near) * (alpha <= 0)
    out.mkdir(parents=True, exist_ok=True)
    enc = pc.Encoder(out / f"{out.name}.mkv", cw, ch)
    enc.write(img)
    enc.close()
    pc.write_png(out / "masks" / "000000.png", alpha)
    pc.write_png(out / "ignore" / "000000.png", ignore)
    K = np.array(still["K"], float)
    focal = round(float(K[0, 0]), 1)
    (out / "focal.txt").write_text(f"{focal}\n")
    cam = {"frame": frame, "player": player, "size": [cw, ch], "crop": [x0, y0, cw, ch], "R": still["R"], "C": still["C"],
           "K": [[focal, 0, round(K[0, 2] - x0, 3)], [0, focal, round(K[1, 2] - y0, 3)], [0, 0, 1]], "focal": focal,
           "playerPx": round(box[3] - box[1]),
           "note": "pinhole camera of the video's pixels: x_cam = R (X - C), court metres; lens distortion removed",
           "calib": {"path": str(calib_path), "sha256": pc.sha256(Path(calib_path))}}
    (out / "camera.json").write_text(json.dumps(cam, indent=1))
    cv2.imwrite(str(out / "check.jpg"), cv2.cvtColor(pc.composite(img, alpha, (128, 128, 128)), cv2.COLOR_RGB2BGR))
    return cam


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
    names = lambda s: [x for x in s.split(",") if x]  # noqa: E731
    cam = make_view(a.video, a.calib, a.frame, a.masks, a.player, names(a.carried), names(a.front), a.out, a.margin,
                    a.grow, a.near)
    print(f"{a.player} at frame {a.frame}: {cam['size'][0]}x{cam['size'][1]} crop at ({cam['crop'][0]},{cam['crop'][1]}), "
          f"player {cam['playerPx']} px tall, focal {cam['focal']} -> {a.out}")


if __name__ == "__main__":
    main()
