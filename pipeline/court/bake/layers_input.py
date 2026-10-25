"""The one adapter between the layers agent's files and the bake: everything about their format lives here.

Today it reads the synthetic contract (synth.py's layers2-shaped folder: people.json, plates/<src>.jpg,
mattes/<src>/<id>.png). When the layers agent's own format is final (its OUTPUTS.md in the private data root's layers folder),
only this file changes: providers.py asks for exactly these methods and nothing else.

    has_frame(src) -> bool                       plate and people exist for this source frame
    plate_raw(src) -> RGB uint8                  raw distorted background plate at the layers' own scale
    frame_people(src) -> [LayerPerson]           id, foot (court x, 0, z), order (0 nearest), raw matte (8-bit, same size as
                                                 the plate, raw distorted); people without a matte file are left out
    optional(name) -> image | None               F's extra files (freeze-clean.png, stands-mask.png, inpaint-mask.png)
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass(frozen=True)
class LayerPerson:
    id: str
    foot: tuple[float, float, float]
    order: int
    matte: np.ndarray


class LayersFiles:
    """The layers agent's out/ folder (the data contract): people.json, plates/<src>.jpg, mattes/<src>/<id>.png (+ optional
    freeze-clean.png, stands-mask.png, inpaint-mask.png for F)."""

    def __init__(self, root: Path):
        self.root = Path(root)
        doc = json.loads((self.root / "people.json").read_text())
        self.scale = doc.get("scale", 1.0)
        self.frames = {int(k): v for k, v in doc["frames"].items()}

    def plate_path(self, src: int) -> Path:
        return self.root / "plates" / f"{src:06d}.jpg"

    def matte_path(self, src: int, pid: str) -> Path:
        return self.root / "mattes" / f"{src:06d}" / f"{pid}.png"

    def frame_people(self, src: int) -> list[LayerPerson]:
        out = []
        for e in self.frames.get(src, []):
            m = self.matte_raw(src, e["id"])
            if m is not None:
                out.append(LayerPerson(e["id"], (float(e["foot"][0]), 0.0, float(e["foot"][2])), int(e.get("order", 0)), m))
        return out

    def has_frame(self, src: int) -> bool:
        return self.plate_path(src).exists() and src in self.frames

    def plate_raw(self, src: int) -> np.ndarray:
        img = cv2.imread(str(self.plate_path(src)), cv2.IMREAD_COLOR)
        if img is None:
            raise FileNotFoundError(self.plate_path(src))
        return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)

    def matte_raw(self, src: int, pid: str) -> np.ndarray | None:
        return cv2.imread(str(self.matte_path(src, pid)), cv2.IMREAD_GRAYSCALE)

    def optional(self, name: str) -> np.ndarray | None:
        p = self.root / name
        if not p.exists():
            return None
        return cv2.imread(str(p), cv2.IMREAD_UNCHANGED)
