"""One layered display frame: the live frame, its background plate and the matte atlas stacked in one image.

The numbers are the format's (apps/webxr/src/court/format.ts ShowVideoInfo.regions, the stand-in's STREAM): a 1536 x 2160
frame is live 1536 x 864 + plate 1536 x 864 + matte atlas 1536 x 432. A fallback keeps the shape scaled by its width
(`Layout.scaled`). All images here are RGB uint8; mattes are 8-bit (255 = the person).

`stack_frame` is pure image work: where each card sits (box, tile) is decided by cards.py, the images come from the caller
(source.py/interp.py for real footage, synth.py for tests).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

import cv2
import numpy as np

Region = tuple[int, int, int, int]  # x, y, width, height in stream pixels


@dataclass(frozen=True)
class Layout:
    """The stacked frame: where each region sits (stream pixels)."""

    width: int = 1536
    live: Region = (0, 0, 1536, 864)
    plate: Region = (0, 864, 1536, 864)
    mattes: Region = (0, 1728, 1536, 432)

    @property
    def height(self) -> int:
        return max(r[1] + r[3] for r in (self.live, self.plate, self.mattes))

    def scaled(self, width: int) -> "Layout":
        """The same layout at another width (a fallback stream); every region must land on whole, even pixels."""
        s = width / self.width

        def sc(r: Region) -> Region:
            out = tuple(int(round(v * s)) for v in r)
            if any(abs(v * s - o) > 1e-6 for v, o in zip(r, out)) or any(o % 2 for o in out):
                raise ValueError(f"width {width}: region {r} does not scale to whole even pixels (got {out}); 4:2:0 needs even sizes")
            return out  # type: ignore[return-value]

        if width % 2:
            raise ValueError(f"width {width} is odd: 4:2:0 needs even sizes")
        return Layout(width, sc(self.live), sc(self.plate), sc(self.mattes))

    def regions_json(self) -> dict:
        return {"live": list(self.live), "plate": list(self.plate), "mattes": list(self.mattes)}


MAIN = Layout()
SMALL = MAIN.scaled(1280)


def synthetic_layout(width: int = 256) -> Layout:
    """A tiny layout with the format's proportions, for tests and the synthetic clip (256 -> 256 x 360)."""
    return MAIN.scaled(width)


def fit(img: np.ndarray, region: Region, what: str) -> np.ndarray:
    """An RGB image resized into a region (its aspect must match the region's, within a pixel)."""
    h, w = img.shape[:2]
    rw, rh = region[2], region[3]
    if abs(h * rw / w - rh) > 1.0:
        raise ValueError(f"{what}: a {w}x{h} image does not match the {rw}x{rh} region's aspect")
    if (w, h) == (rw, rh):
        return img
    return cv2.resize(img, (rw, rh), interpolation=cv2.INTER_AREA if w > rw else cv2.INTER_CUBIC)


def crop_resize(matte: np.ndarray, box: Sequence[float], live_size: tuple[int, int], size: tuple[int, int]) -> np.ndarray:
    """The matte under a live-region box, resized to (width, height). `matte` may be at any resolution of the live frame."""
    mh, mw = matte.shape[:2]
    sx, sy = mw / live_size[0], mh / live_size[1]
    x0, x1 = max(0, int(np.floor(box[0] * sx))), min(mw, int(np.ceil(box[2] * sx)))
    y0, y1 = max(0, int(np.floor(box[1] * sy))), min(mh, int(np.ceil(box[3] * sy)))
    if x1 <= x0 or y1 <= y0:
        return np.zeros((size[1], size[0]), np.uint8)
    crop = matte[y0:y1, x0:x1]
    if (crop.shape[1], crop.shape[0]) == size:
        return crop
    shrink = crop.shape[1] >= size[0] and crop.shape[0] >= size[1]
    return cv2.resize(crop, size, interpolation=cv2.INTER_AREA if shrink else cv2.INTER_LINEAR)


def render_atlas(layout: Layout, cards: Sequence[Mapping], mattes: Mapping[str, np.ndarray]) -> np.ndarray:
    """The matte atlas region as an 8-bit grey image (height x width of the mattes region): each card's matte in its tile."""
    _, _, mw, mh = layout.mattes
    atlas = np.zeros((mh, mw), np.uint8)
    live_size = (layout.live[2], layout.live[3])
    for card in cards:
        matte = mattes[card["id"]]
        if matte.ndim == 3:
            matte = matte[..., 0]
        tx0, ty0, tx1, ty1 = card["tile"]
        atlas[ty0:ty1, tx0:tx1] = crop_resize(matte, card["box"], live_size, (tx1 - tx0, ty1 - ty0))
    return atlas


def stack_frame(
    layout: Layout,
    live: np.ndarray,
    plate: np.ndarray | None = None,
    cards: Sequence[Mapping] = (),
    mattes: Mapping[str, np.ndarray] | None = None,
) -> np.ndarray:
    """One stacked RGB frame (layout.height x layout.width x 3).

    `plate=None` is live-only stacking: the plate region is the live frame (nobody is cut out, so pass no cards then).
    Cards (cards.py) need their id's matte in `mattes`; a missing matte is a KeyError.
    """
    out = np.zeros((layout.height, layout.width, 3), np.uint8)
    live_r = fit(live, layout.live, "live")
    plate_r = live_r if plate is None else fit(plate, layout.plate, "plate")
    x, y, w, h = layout.live
    out[y : y + h, x : x + w] = live_r
    x, y, w, h = layout.plate
    out[y : y + h, x : x + w] = plate_r
    if cards:
        atlas = render_atlas(layout, cards, mattes or {})
        x, y, w, h = layout.mattes
        out[y : y + h, x : x + w] = atlas[..., None]
    return out
