"""BakeConfig: every number the show bake needs about the footage.

The real numbers (frame indices, the repeat phase, the watermark box, the clip, paths) live only in a private JSON outside
the repo: `--config`, else $COURT_BAKE_CONFIG, else work/bake/bake_config.json under the private data root. The defaults
in this file are synthetic: a made-up clip shaped like a high-speed capture shown slow with every 5th container frame a
repeat, small enough for tests.

The private data root is a folder this repo never names: $COURT_DATA, or bake.py's --data-root (the flag wins). There is
no default. It holds the clip, the decoded frames, the layers, the work folders and the assembled bundle; the helpers
below derive every private path from it, so no path to it (or to anything in it) is written in code.

Frame numbers are source-container frame indices (0 = first decoded frame). Times are real (capture) seconds.
"""
from __future__ import annotations

import dataclasses
import json
import os
from dataclasses import dataclass, field
from pathlib import Path

ENV_DATA_ROOT = "COURT_DATA"
ENV_CONFIG = "COURT_BAKE_CONFIG"
CHECKOUT = Path(__file__).resolve().parents[3]  # this repo's top folder: private data must never live inside it


class DataRootError(ValueError):
    """No usable private data root (or no config that could be found without one)."""


def data_root(flag: str | os.PathLike | None = None) -> Path | None:
    """The private data root: `flag` (bake.py's --data-root) if given, else $COURT_DATA, else None. There is no default.
    A flag that is given but empty (`--data-root "$UNSET"`) is no root: it does not fall back to the environment."""
    raw = os.environ.get(ENV_DATA_ROOT, "") if flag is None else str(flag)
    return Path(raw).expanduser() if raw else None


def inside_checkout(path: str | os.PathLike) -> bool:
    """Does `path` (resolved, relative to the working directory) lie in this repo's checkout?"""
    p = Path(path).expanduser().resolve()
    return p == CHECKOUT or CHECKOUT in p.parents


def require_data_root(flag: str | os.PathLike | None = None) -> Path:
    """data_root(), which must exist as a folder outside this checkout; a clear error naming both ways to give it otherwise."""
    root = data_root(flag)
    if root is None:
        raise DataRootError(f"no private data root: set ${ENV_DATA_ROOT} or pass --data-root DIR (the folder that holds the clip, the frames, the layers and the work and bundle folders)")
    if not root.is_dir():
        raise DataRootError(f"the private data root {root} is not a folder")
    if inside_checkout(root):
        raise DataRootError(f"the private data root {root} is inside this checkout: private data stays outside every checkout")
    return root


def bundle_dir(root: Path) -> Path:
    """The assembled court-side bundle (stream G's assemble.py rebuilds and swaps it: the bake never writes there)."""
    return root / "bundle" / "court-side"


def staging_dir(root: Path) -> Path:
    return root / "work" / "show"


def default_config_path(root: Path) -> Path:
    return root / "work" / "bake" / "bake_config.json"


def tmp_dir(root: Path) -> Path:
    return root / "work" / "bake" / "tmp"


def frames_dir(root: Path) -> Path:
    """The decoded 1080p source frames."""
    return root / "work" / "layers" / "f1080"


@dataclass(frozen=True)
class BakeConfig:
    # rates
    capture_fps: float = 180.0  # distinct real frames per second of action
    source_fps: float = 60.0  # container rate
    src_width: int = 384
    src_height: int = 216
    # the uncut shot and the show's landmarks (source frames)
    clip_first: int = 12  # first frame of the uncut shot (always a real frame: its predecessor is another shot)
    play_start: int = 12  # pass 1 starts here (the single knob if pass 1 must start later)
    pass1_end: int | None = None  # pass 1 ends here; None = the freeze frame
    pass2_start: int = 120  # pass 2 (the slow replay) starts here
    freeze: int = 300  # F: every ease lands on it (must be a real, non-strobe frame)
    make: int = 380  # the ball drops through the net
    clip_end: int = 400  # pass 2 and the resume run to here (inclusive)
    # the repeat pattern: frame s is a repeat of s - 1 when s % repeat_mod == repeat_phase (and s > clip_first)
    repeat_mod: int = 5
    repeat_phase: int = 2
    strobes: tuple[int, ...] = (331, 332, 341)  # flash frames to replace from neighbours (repeats of a strobe too)
    watermark: tuple[int, int, int, int] = (0, 0, 20, 20)  # [x0, y0, x1, y1] source pixels, to inpaint
    # playback
    pass2_speed: float = 0.6  # x real time; where capture_fps * pass2_speed == display Hz, every pass-2 frame is a real frame
    pass2_speed_90: float | None = 0.75  # the 90 Hz bake's own speed (same rule at 90 Hz); None = pass2_speed
    ease_seconds: tuple[float, ...] = (1.2, 1.0, 0.8)  # earliest start first
    resume_ramp_s: float = 0.8
    display_hz: tuple[int, ...] = (72, 90)
    snap_tol: float = 0.1  # a real frame within this many capture frames (x the local step, capped at 1) is shown as is
    near_real: float = 0.02  # ... and always within this many capture frames (sub-pixel: an in-between that close
    #                          would differ from the real frame by less than its own interpolation error)
    # cameras
    calib: str = ""  # calib_A.json-schema file; "" = none (synthetic tests pass their own)
    undistort_f_scale: float = 1.0  # output focal / solved focal of the undistorted pinhole image (source.py's choice)
    camera_hold_edge: bool = False  # TEST ONLY: frames outside the calibration take the nearest solved camera
    # where the inputs and outputs live (bake.py / source.py; "" = not set)
    clip: str = ""  # the source clip (real run's full-resolution freeze): relative to the data root, or absolute / ~; "" = none
    frames_dir: str = ""  # decoded source frames
    frame_pattern: str = "{src:06d}.png"
    layers: str = ""  # the layers agent's out/ (people.json, plates/, mattes/)
    out: str = ""  # the bundle's video/ folder
    tmp: str = ""  # scratch
    rife_dir: str = ""  # fetched RIFE results (needs.json + images); "" = Mac DIS-flow fallback
    watermark_model: str = ""  # .npz watermark model (source.py fits and saves it there when missing)
    synthetic: bool = False  # written by synth.py
    notes: dict = field(default_factory=dict, compare=False)

    def pass2_speed_for(self, hz: int) -> float:
        """Pass 2's speed (and every ease's start speed, the resume's target) for a bake at `hz`."""
        if hz == 90 and self.pass2_speed_90 is not None:
            return self.pass2_speed_90
        return self.pass2_speed

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
        if self.pass2_speed_90 is not None and not (0 < self.pass2_speed_90 < 1):
            e.append("expected 0 < pass2_speed_90 < 1")
        if list(self.ease_seconds) != sorted(self.ease_seconds, reverse=True):
            e.append("expected ease_seconds longest first (earliest start first)")
        if not (0 <= self.snap_tol < 0.5):
            e.append("expected 0 <= snap_tol < 0.5 (capture frames): 0.5 or more would hold real frames")
        if not (0 <= self.near_real < 0.5):
            e.append("expected 0 <= near_real < 0.5 (capture frames)")
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


def load(path: str | os.PathLike | None = None, root: str | os.PathLike | None = None) -> BakeConfig:
    """The private config: `path`, else $COURT_BAKE_CONFIG, else work/bake/bake_config.json under the data root
    (`root`, else $COURT_DATA). Without any of them: DataRootError."""
    named = path or os.environ.get(ENV_CONFIG)
    if named:
        p = Path(named).expanduser()
    else:
        root = data_root(root)
        if root is None:
            raise DataRootError(f"no bake config: pass --config FILE, set ${ENV_CONFIG}, or give the private data root (${ENV_DATA_ROOT} or --data-root DIR)")
        p = default_config_path(root)
    with open(p) as fh:
        return from_dict(json.load(fh))


def to_dict(cfg: BakeConfig) -> dict:
    d = dataclasses.asdict(cfg)
    for k in ("strobes", "ease_seconds", "display_hz", "watermark"):
        d[k] = list(d[k])
    return d
