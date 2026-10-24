"""cards.json: per display frame, one card per person in the lit region (id, foot, box, tile, order).

A card says where a person is (foot point on the floor, court metres), where their box sits in the live region
(live-region pixels) and where their matte sits in the matte atlas (mattes-region pixels); the runtime stands the card
upright at the foot and cuts it by the matte, so nobody shows twice through a gap and nobody tears (P43).

Inputs are the layers contract (people.json): per source frame, each person's id, box, foot and depth order. Boxes here
are already in live-region pixels of the undistorted frame (bake.py converts them, or takes them from the matte with
`box_from_matte`). The ball's card is out of scope until the layers data has one.

Tiles: the atlas is split into equal slots; a person keeps their slot across frames (stable per id), so their tile never
moves. The box is scaled into the slot with its aspect kept, never above 1:1, with a small gutter so bilinear sampling
cannot bleed into a neighbour. In-between frames interpolate box and foot between the two real neighbours.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Mapping, Sequence

import numpy as np

from pipeline.court.bake.stack import Layout

Box = tuple[float, float, float, float]


@dataclass(frozen=True)
class Person:
    """One person in one frame: box in live-region pixels, foot in court space (y = 0), order 0 = nearest the camera."""

    id: str
    box: Box
    foot: tuple[float, float, float]
    order: float = 0


def box_from_matte(matte: np.ndarray, threshold: int = 127, pad: int = 2) -> tuple[int, int, int, int] | None:
    """The padded bounding box (x0, y0, x1, y1) of the matte's person pixels, clipped to the image; None if empty."""
    ys, xs = np.nonzero(matte > threshold)
    if len(xs) == 0:
        return None
    h, w = matte.shape[:2]
    return (max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad), min(w, int(xs.max()) + 1 + pad), min(h, int(ys.max()) + 1 + pad))


class TileSlots:
    """Persistent atlas slots: an id keeps its slot while present and for `hold` frames after; then the slot is reusable."""

    def __init__(self, layout: Layout, n_slots: int = 6, gutter: int = 2, hold: int = 72):
        self.layout, self.n, self.gutter, self.hold = layout, n_slots, gutter, hold
        _, _, mw, _ = layout.mattes
        self.edges = [round(i * mw / n_slots) for i in range(n_slots + 1)]
        self.owner: list[str | None] = [None] * n_slots
        self.last_seen: list[int] = [-(10**9)] * n_slots
        self.frame = -1
        self.dropped: list[tuple[str, int]] = []

    def assign(self, ids: Sequence[str]) -> dict[str, int]:
        """Slots for this frame's ids, most important first (it is the caller's priority when slots run out)."""
        self.frame += 1
        got: dict[str, int] = {}
        have = {o: i for i, o in enumerate(self.owner) if o is not None}
        for pid in ids:
            if pid in have:
                got[pid] = have[pid]
                self.last_seen[have[pid]] = self.frame
        for pid in ids:
            if pid in got:
                continue
            free = [i for i in range(self.n) if i not in got.values() and (self.owner[i] is None or self.frame - self.last_seen[i] > self.hold)]
            if not free:  # evict the slot whose owner has been away longest, if anyone is away at all
                away = [i for i in range(self.n) if i not in got.values()]
                if not away:
                    self.dropped.append((pid, self.frame))
                    continue
                free = away
            slot = min(free, key=lambda i: (self.last_seen[i], i))
            self.owner[slot] = pid
            self.last_seen[slot] = self.frame
            got[pid] = slot
        return got

    def tile(self, slot: int, box: Sequence[int]) -> list[int]:
        """The box scaled into the slot, aspect kept, never above 1:1, top-left inside the gutter: [u0, v0, u1, v1]."""
        g = self.gutter
        _, _, _, mh = self.layout.mattes
        bw, bh = box[2] - box[0], box[3] - box[1]
        room_w, room_h = self.edges[slot + 1] - self.edges[slot] - 2 * g, mh - 2 * g
        s = min(1.0, room_w / bw, room_h / bh)
        tw, th = max(1, min(room_w, int(bw * s))), max(1, min(room_h, int(bh * s)))
        u0, v0 = self.edges[slot] + g, g
        return [u0, v0, u0 + tw, v0 + th]


def clip_box(box: Sequence[float], size: tuple[int, int], min_side: int = 2) -> list[int] | None:
    """A whole-pixel box clipped to (width, height); None when too small to be a card."""
    x0, y0 = max(0, math.floor(box[0])), max(0, math.floor(box[1]))
    x1, y1 = min(size[0], math.ceil(box[2])), min(size[1], math.ceil(box[3]))
    return [x0, y0, x1, y1] if x1 - x0 >= min_side and y1 - y0 >= min_side else None


def build_cards(layout: Layout, people: Sequence[Person], slots: TileSlots) -> list[dict]:
    """The cards of one display frame (format.ts ShowCard), ordered front to back with unique orders 0, 1, 2..."""
    live_size = (layout.live[2], layout.live[3])
    boxed = []
    for p in people:
        b = clip_box(p.box, live_size)
        if b:
            boxed.append((p, b))
    # priority when slots run out: the biggest first
    area = lambda pb: (pb[1][2] - pb[1][0]) * (pb[1][3] - pb[1][1])
    ranked = sorted(boxed, key=lambda pb: (-area(pb), pb[0].id))
    got = slots.assign([p.id for p, _ in ranked])
    kept = [(p, b) for p, b in boxed if p.id in got]
    kept.sort(key=lambda pb: (pb[0].order, pb[0].id))
    cards = []
    for order, (p, b) in enumerate(kept):
        cards.append({"id": p.id, "foot": [round(float(p.foot[0]), 4), 0.0, round(float(p.foot[2]), 4)], "box": b, "tile": slots.tile(got[p.id], b), "order": order})
    return cards


class PeopleTrack:
    """People per source frame (the layers contract) -> the people of any (fractional) source frame."""

    def __init__(self, people_by_src: Mapping[int, Sequence[Person]], max_gap: int = 3):
        self.by_src = {int(k): list(v) for k, v in people_by_src.items()}
        self.max_gap = max_gap

    def _near(self, start: int, step: int) -> int | None:
        for d in range(self.max_gap + 1):
            k = start + step * d
            if k in self.by_src:
                return k
        return None

    def at(self, src: float) -> list[Person]:
        whole = int(round(src))
        if abs(src - whole) < 1e-9 and whole in self.by_src:
            return list(self.by_src[whole])
        lo, hi = math.floor(src), math.ceil(src)
        if lo == hi:  # a whole source frame with no entry: the nearest on either side
            ka, kb = self._near(lo - 1, -1), self._near(lo + 1, +1)
        else:
            ka, kb = self._near(lo, -1), self._near(hi, +1)
        if ka is None and kb is None:
            return []
        if ka is None or kb is None or ka == kb:
            return list(self.by_src[ka if ka is not None else kb])
        t = (src - ka) / (kb - ka)
        a = {p.id: p for p in self.by_src[ka]}
        b = {p.id: p for p in self.by_src[kb]}
        out: list[Person] = []
        for pid in sorted(set(a) | set(b)):
            if pid in a and pid in b:
                pa, pb = a[pid], b[pid]
                lerp = lambda u, v: u + (v - u) * t
                out.append(Person(pid, tuple(lerp(u, v) for u, v in zip(pa.box, pb.box)), tuple(lerp(u, v) for u, v in zip(pa.foot, pb.foot)), lerp(pa.order, pb.order)))  # type: ignore[arg-type]
            elif pid in a and t < 0.5:
                out.append(a[pid])
            elif pid in b and t >= 0.5:
                out.append(b[pid])
        # in-between orders: rank the interpolated depth so every card has its own
        ranked = sorted(out, key=lambda p: (p.order, p.id))
        rank = {p.id: i for i, p in enumerate(ranked)}
        return [replace(p, order=rank[p.id]) for p in out]


def cards_for_frames(
    layout: Layout,
    srcs: Sequence[float],
    track: PeopleTrack,
    n_slots: int = 6,
    gutter: int = 2,
    hold: int = 72,
) -> tuple[list[dict], list[tuple[str, int]]]:
    """cards.json for display frames whose source frames are `srcs`, plus the people that found no slot ((id, frame))."""
    slots = TileSlots(layout, n_slots, gutter, hold)
    out = [{"cards": build_cards(layout, track.at(s), slots)} for s in srcs]
    return out, slots.dropped
