"""A black-and-white photo still makes a person in natural colour.

From a greyscale photo the avatar model guesses colour for some patches and not others (half-tinted, ghostly skin).
So the colour is set by body part instead, keeping the photo's light and shade: each Gaussian's dominant joint
(skin.bin) says head, hands or body; skin goes to a natural skin ramp, dark hair to dark brown, the body to a
charcoal suit with a white shirt where it's bright. The reality file keeps its blue "imagined" tint.

    python -m lucid.monochrome <bundle dir> <source photo>     (does nothing unless the photo is greyscale)
"""

from __future__ import annotations

import json
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np

from .gaussians import read_ply, write_ply

SH_C0 = 0.28209479
LUMA = np.array([0.299, 0.587, 0.114])


def is_greyscale(photo: Path, max_chroma: float = 12.0) -> bool:
    """Judged by the most colourful pixels, not the average: a grey suit on a white wall is still a colour photo
    (Carlsen's: 95th-percentile chroma 38), a black-and-white scan stays near 0 (Fischer's: 0)."""
    from PIL import Image

    img = np.asarray(Image.open(photo).convert("RGB").resize((256, 256)), dtype=np.float32)
    return float(np.percentile(img.max(axis=2) - img.min(axis=2), 95)) < max_chroma


HEAD = [12, 15, 22, 23, 24]               # neck, head, jaw, eyes
HANDS = [20, 21] + list(range(25, 55))     # wrists and fingers


def dominant_joint(skin_bin: Path, n: int) -> np.ndarray:
    rec = np.frombuffer(skin_bin.read_bytes(), dtype=np.uint8).reshape(n, 8)
    return rec[np.arange(n), np.argmax(rec[:, 4:], axis=1)]


def colourise(path: Path, joints: np.ndarray, keep_blue: bool) -> int:
    g = read_ply(path)
    rgb = g.sh0[:, 0, :] * SH_C0 + 0.5
    lum = np.clip(rgb @ LUMA, 0, 1)
    head, hands = np.isin(joints, HEAD), np.isin(joints, HANDS)
    body = ~(head | hands)
    y = g.means[:, 1]
    top = head & (y > np.percentile(y[head], 55)) if head.any() else head
    hair = top & (lum < 0.42)
    skin = (head & ~hair) | hands
    t = np.clip((lum - 0.15) / 0.75, 0, 1)[:, None]
    out = np.empty_like(rgb)
    lo, hi = np.array([0.42, 0.29, 0.24]), np.array([0.96, 0.80, 0.70])
    out[skin] = (lo + (hi - lo) * t)[skin]
    out[hair] = (np.array([0.20, 0.14, 0.10]) * (0.6 + lum[:, None]))[hair]
    shirt = body & (lum > 0.68)
    out[shirt] = (np.array([0.93, 0.93, 0.91]) * (0.85 + 0.15 * lum[:, None]))[shirt]
    suit = body & ~shirt
    out[suit] = (np.array([0.24, 0.25, 0.29]) * (0.5 + 1.1 * lum[:, None]))[suit]
    if keep_blue:  # what the photo never saw stays blue in Reality check
        blue = (rgb[:, 2] > rgb[:, 0] + 0.15) & (rgb.max(1) - rgb.min(1) > 0.15)
        out[blue] = rgb[blue]
    write_ply(path, replace(g, sh0=((np.clip(out, 0, 1) - 0.5) / SH_C0)[:, None, :].astype(np.float32),
                            shN=np.zeros_like(g.shN)))
    return len(g.means)


def main(bundle: str, photo: str) -> None:
    root, photo_path = Path(bundle), Path(photo)
    if not is_greyscale(photo_path):
        print("[monochrome] colour photo: unchanged")
        return
    dream = json.loads((root / "dream.json").read_text())
    avatar = dream.get("avatar") or {}
    ply = root / avatar.get("file", "avatar/avatar.ply")
    n = len(read_ply(ply).means)
    joints = dominant_joint(root / avatar.get("skin", "avatar/skin.bin"), n)
    colourise(ply, joints, keep_blue=False)
    if avatar.get("reality") and (root / avatar["reality"]).exists():
        colourise(root / avatar["reality"], joints, keep_blue=True)
    dream["look"] = "colourised"
    (root / "dream.json").write_text(json.dumps(dream, indent=2))
    print(f"[monochrome] greyscale photo: {n} Gaussians colourised by body part")


if __name__ == "__main__":
    main(*sys.argv[1:3])
