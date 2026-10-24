"""BakeConfig: every number the show bake needs about the footage.

The real numbers (frame indices, the repeat phase, the watermark box, paths) live only in a private JSON outside the
repo (default below, or $COURT_BAKE_CONFIG). The defaults in this file are synthetic: a made-up clip shaped like the
real one (high-speed capture shown slow with every 4th container frame a repeat), small enough for tests.

Frame numbers are source-container frame indices (0 = first decoded frame). Times are real (capture) seconds.
"""
from __future__ import annotations

import dataclasses
import json
import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_PATH = Path.home() / "court-side-data" / "luka" / "work" / "bake" / "bake_config.json"


@dataclass(frozen=True)
class BakeConfig:
    # rates
    capture_fps: float = 120.0  # distinct real frames per second of action
    source_fps: float = 60000 / 1001  # container rate
    src_width: int = 384
    src_height: int = 216
    # the uncut shot and the show's landmarks (source frames)
    clip_first: int = 11  # first frame of the uncut shot (always a real frame: its predecessor is another shot)
    play_start: int = 11  # pass 1 starts here (the single knob if pass 1 must start later)
    pass1_end: int | None = None  # pass 1 ends here; None = the freeze frame
    pass2_start: int = 120  # pass 2 (the slow replay) starts here
    freeze: int = 300  # F: every ease lands on it (must be a real, non-strobe frame)
    make: int = 380  # the ball drops through the net
    clip_end: int = 400  # pass 2 and the resume run to here (inclusive)
    # the repeat pattern: frame s is a repeat of s - 1 when s % repeat_mod == repeat_phase (and s > clip_first)
    repeat_mod: int = 4
    repeat_phase: int = 3
    strobes: tuple[int, ...] = (330, 331, 342)  # flash frames to replace from neighbours (repeats of a strobe too)
    watermark: tuple[int, int, int, int] = (2, 1, 20, 19)  # [x0, y0, x1, y1] source pixels, to inpaint
    # playback
    pass2_speed: float = 0.6  # x real time; capture_fps * pass2_speed = 72 makes every 72 Hz pass-2 frame real
    ease_seconds: tuple[float, ...] = (1.2, 1.0, 0.8)  # earliest start first
    resume_ramp_s: float = 0.8
    display_hz: tuple[int, ...] = (72, 90)
    snap_tol: float = 0.1  # a real frame within this many capture frames (x the local step, capped at 1) is shown as is
    # cameras
    calib: str = ""  # calib_A.json-schema file; "" = none (synthetic tests pass their own)
    undistort_f_scale: float = 1.0  # output focal / solved focal of the undistorted pinhole image (source.py's choice)
    camera_hold_edge: bool = False  # TEST ONLY: frames outside the calibration take the nearest solved camera
    notes: dict = field(default_factory=dict, compare=False)

    @property
    def f_end(self) -> int:
        """Pass 1's last source frame."""
        return self.freeze if self.pass1_end is None else self.pass1_end

    def validate(self) -> list[str]:
        e = []
        if not (self.clip_first <= self.pass2_start < self.freeze <= self.make <= self.clip_end):
            e.append("expected clip_first <= pass2_start < freeze <= make <= clip_end")
        if not self.clip_first <= self.play_start:
            e.append("expected clip_first <= play_start")
        if not (self.play_start < self.f_end <= self.clip_end):
            e.append("expected play_start < pass1_end <= clip_end")
        if self.freeze % self.repeat_mod == self.repeat_phase:
            e.append(f"freeze {self.freeze} is a repeat frame")
        if self.freeze in self.strobes:
            e.append(f"freeze {self.freeze} is a strobe frame")
        if not (0 < self.pass2_speed < 1):
            e.append("expected 0 < pass2_speed < 1")
        if list(self.ease_seconds) != sorted(self.ease_seconds, reverse=True):
            e.append("expected ease_seconds longest first (earliest start first)")
        if not (0 <= self.repeat_phase < self.repeat_mod):
            e.append("expected 0 <= repeat_phase < repeat_mod")
        return e


def _coerce(name: str, value):
    if name in ("strobes", "ease_seconds", "display_hz", "watermark") and value is not None:
        return tuple(value)
    return value


def from_dict(d: dict) -> BakeConfig:
    names = {f.name for f in dataclasses.fields(BakeConfig)}
    unknown = sorted(k for k in set(d) - names if not k.startswith("_"))
    if unknown:
        raise ValueError(f"bake config: unknown keys {unknown}")
    cfg = BakeConfig(**{k: _coerce(k, v) for k, v in d.items() if k in names})
    errors = cfg.validate()
    if errors:
        raise ValueError("bake config: " + "; ".join(errors))
    return cfg


def load(path: str | os.PathLike | None = None) -> BakeConfig:
    """The private config: `path`, else $COURT_BAKE_CONFIG, else DEFAULT_PATH."""
    p = Path(path or os.environ.get("COURT_BAKE_CONFIG") or DEFAULT_PATH).expanduser()
    with open(p) as fh:
        return from_dict(json.load(fh))


def to_dict(cfg: BakeConfig) -> dict:
    d = dataclasses.asdict(cfg)
    for k in ("strobes", "ease_seconds", "display_hz", "watermark"):
        d[k] = list(d[k])
    return d
