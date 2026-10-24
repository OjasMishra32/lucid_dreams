"""A black-and-white photo makes a black-and-white person.

From a greyscale photo the avatar model guesses colour for some patches and not others (half-tinted skin), so the
honest look is the photo's own: every Gaussian to its luminance. The reality file keeps its blue "imagined" tint.

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


def to_grey(path: Path, keep_blue: bool) -> int:
    g = read_ply(path)
    rgb = g.sh0[:, 0, :] * SH_C0 + 0.5
    y = np.repeat((rgb @ LUMA)[:, None], 3, axis=1)
    if keep_blue:  # the reality file's tint marks what the photo never saw: leave it blue
        blue = (rgb[:, 2] > rgb[:, 0] + 0.15) & (rgb.max(1) - rgb.min(1) > 0.15)
        y = np.where(blue[:, None], rgb, y)
    write_ply(path, replace(g, sh0=((y - 0.5) / SH_C0)[:, None, :].astype(np.float32), shN=np.zeros_like(g.shN)))
    return len(g.means)


def main(bundle: str, photo: str) -> None:
    root, photo_path = Path(bundle), Path(photo)
    if not is_greyscale(photo_path):
        print("[monochrome] colour photo: unchanged")
        return
    dream = json.loads((root / "dream.json").read_text())
    avatar = dream.get("avatar") or {}
    n = to_grey(root / avatar.get("file", "avatar/avatar.ply"), keep_blue=False)
    if avatar.get("reality") and (root / avatar["reality"]).exists():
        to_grey(root / avatar["reality"], keep_blue=True)
    dream["look"] = "monochrome"
    (root / "dream.json").write_text(json.dumps(dream, indent=2))
    print(f"[monochrome] greyscale photo: {n} Gaussians set to black and white")


if __name__ == "__main__":
    main(*sys.argv[1:3])
