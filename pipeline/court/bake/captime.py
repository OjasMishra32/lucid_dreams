"""Source container frame <-> true capture time.

The clip is a real high-speed capture shown slow, with every `repeat_mod`-th container frame an exact repeat of the
one before it (frame s repeats s - 1 when s % repeat_mod == repeat_phase). The shot's first frame is always real (the
frame before it belongs to another shot). Real frames are evenly spaced captures, so the true capture time of real
frame s is (its rank among the shot's real frames) / capture_fps, 0 at the shot's first frame. A repeat has the time of
the frame it repeats.

Strobe frames are real captures that must not be shown: they are "real" (they have a time) but not "usable"; a display
time that lands on one is an in-between of the nearest usable real frames around it (interp True, src = the strobe).

Fractional source frames: src is piecewise linear in capture time through the real frames, so an in-between at
fraction w between real frames a and b is src = a + w (b - a). `bracket(src)` / `sample(t)` invert it.
"""
from __future__ import annotations

from bisect import bisect_left, bisect_right
from dataclasses import dataclass

import numpy as np

from .config import BakeConfig


@dataclass(frozen=True)
class Sample:
    """What to show for one capture time: real frame src (interp False, a = b = src, w = 0) or an in-between of the
    usable real frames a < b at fraction w (interp True; src = the fractional source frame, or a strobe's own index)."""

    t: float
    src: float
    interp: bool
    a: int
    b: int
    w: float


class CapTime:
    def __init__(self, first: int, last: int, capture_fps: float, repeat_mod: int = 4, repeat_phase: int = 3,
                 strobes=()):
        if last <= first:
            raise ValueError("expected last > first")
        self.first, self.last, self.capture_fps = first, last, float(capture_fps)
        self.repeat_mod, self.repeat_phase = repeat_mod, repeat_phase
        self.real_frames = [s for s in range(first, last + 1) if self._real(s)]
        self._rank = {s: i for i, s in enumerate(self.real_frames)}
        self.strobes = frozenset(s for s in strobes if first <= s <= last)
        self.usable_frames = [s for s in self.real_frames if s not in self.strobes]
        self._t_real = np.arange(len(self.real_frames)) / self.capture_fps
        self._t_usable = [self._rank[s] / self.capture_fps for s in self.usable_frames]

    @classmethod
    def from_config(cls, cfg: BakeConfig) -> "CapTime":
        return cls(cfg.clip_first, cfg.clip_end, cfg.capture_fps, cfg.repeat_mod, cfg.repeat_phase, cfg.strobes)

    def _real(self, s: int) -> bool:
        return s == self.first or s % self.repeat_mod != self.repeat_phase

    def is_real(self, s: int) -> bool:
        return self.first <= s <= self.last and self._real(s)

    def is_usable(self, s: int) -> bool:
        return self.is_real(s) and s not in self.strobes

    def time_of(self, s: int) -> float:
        """Capture time (s) of whole source frame s; a repeat gets the time of the real frame before it."""
        if not (self.first <= s <= self.last):
            raise ValueError(f"source frame {s} is outside the shot [{self.first}, {self.last}]")
        while not self._real(s):
            s -= 1
        return self._rank[s] / self.capture_fps

    @property
    def duration(self) -> float:
        return (len(self.real_frames) - 1) / self.capture_fps

    def src_at(self, t: float) -> float:
        """The fractional source frame at capture time t (piecewise linear through the real frames)."""
        return float(np.interp(t, self._t_real, self.real_frames))

    def time_of_src(self, src: float) -> float:
        """Inverse of src_at for any source position (whole real frames, fractions between real frames)."""
        return float(np.interp(src, self.real_frames, self._t_real))

    def sample(self, t: float, tol_frames: float) -> Sample:
        """What to show at capture time t. A usable real frame within tol_frames capture frames is shown as is;
        otherwise an in-between of the usable real frames around t."""
        eps = 1e-9 / self.capture_fps
        if t < -eps or t > self.duration + eps:
            raise ValueError(f"capture time {t:.6f} s is outside the shot [0, {self.duration:.6f}]")
        t = min(max(t, 0.0), self.duration)
        tu = self._t_usable
        i = bisect_left(tu, t)
        tol = max(tol_frames, 1e-6) / self.capture_fps
        for k in (i - 1, i):
            if 0 <= k < len(tu) and abs(tu[k] - t) <= tol:
                s = self.usable_frames[k]
                return Sample(tu[k], float(s), False, s, s, 0.0)
        j = bisect_right(tu, t)
        if j == 0 or j >= len(tu):
            raise ValueError(f"capture time {t:.6f} s has no usable real frame on both sides")
        a, b = self.usable_frames[j - 1], self.usable_frames[j]
        w = (t - tu[j - 1]) / (tu[j] - tu[j - 1])
        return Sample(t, self.src_at(t), True, a, b, float(w))

    def bracket(self, src: float) -> tuple[int, int, float]:
        """(a, b, w) for a source position: the usable real frames around it and the time fraction between them
        (a == b, w == 0 for a usable real frame)."""
        s = self.sample(self.time_of_src(src), 1e-6)
        return s.a, s.b, s.w


def detect_repeats(diffs: np.ndarray, first: int, last: int, rel: float = 0.2, half: int = 6) -> list[int]:
    """Repeat frames in [first + 1, last] from per-frame differences: diffs[i] = mean |frame i+1 - frame i|.
    A frame is a repeat when its difference to the previous frame is under `rel` x the local median."""
    d = np.asarray(diffs, float)
    out = []
    for s in range(first + 1, last + 1):
        i = s - 1
        if i >= len(d):
            break
        lo, hi = max(first, i - half), min(len(d), i + half + 1)
        if d[i] < rel * np.median(d[lo:hi]):
            out.append(s)
    return out


def check_repeat_phase(diffs: np.ndarray, cfg: BakeConfig) -> list[str]:
    """Problems with cfg's repeat phase against the clip's measured differences (empty when it matches)."""
    found = detect_repeats(diffs, cfg.clip_first, cfg.clip_end)
    want = [s for s in range(cfg.clip_first + 1, cfg.clip_end + 1) if s % cfg.repeat_mod == cfg.repeat_phase]
    if found == want:
        return []
    missing = sorted(set(want) - set(found))
    extra = sorted(set(found) - set(want))
    phases = sorted({s % cfg.repeat_mod for s in found})
    return [f"repeat phase mismatch: measured repeats have phase {phases} (mod {cfg.repeat_mod}), config says "
            f"{cfg.repeat_phase}; {len(missing)} expected repeats not found (first {missing[:5]}), "
            f"{len(extra)} unexpected (first {extra[:5]})"]
