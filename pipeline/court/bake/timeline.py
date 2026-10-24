"""The show timeline: every display frame at t = n / displayHz -> a capture time -> a source frame (real or in-between).

Segments, in stream order (format.ts ShowSegments; inclusive, contiguous, never overlapping):
  pass1   real speed (1x), from the start of play to pass1_end (F by default); grid anchored so its last frame is
          exactly pass1_end.
  pass2   pass2_speed (cfg.pass2_speed_for(hz): 0.6 at 72 Hz, 0.75 at 90 Hz), from pass2_start through the make to clip_end; grid anchored on F, so F is on it and, with
          capture_fps x pass2_speed == displayHz, every pass-2 frame is a real captured frame.
  ease i  one per ease length, earliest start first: n = round(seconds x hz) frames (k = 1..n), speed pass2_speed ->
          0 by 1 - smootherstep, frame n is F. Entered from the pass-2 frame n/2 steps before F (`start`), which is
          exactly where the curve begins (clock.ts easeTau), so n must be even.
  resume  from F on (frame k = 1..), 0 -> pass2_speed by smootherstep over round(resume_ramp_s x hz) frames, then
          steady, to clip_end.
cutoff = the last ease start. IDR frames = every segment's first frame.

tau is real (capture) time relative to F, in seconds; t is capture time from the shot's first frame (captime).
The curve functions mirror apps/webxr/src/court/clock.ts exactly (a test compares them through node).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from .captime import CapTime
from .config import BakeConfig


# ---------------- clock.ts curves (keep identical) ----------------

def smootherstep(u: float) -> float:
    x = min(1.0, max(0.0, u))
    return x * x * x * (x * (6 * x - 15) + 10)


def _smootherstep_integral(u: float) -> float:
    x = min(1.0, max(0.0, u))
    return x ** 6 - 3 * x ** 5 + 2.5 * x ** 4


def ease_travel(u: float) -> float:
    x = min(1.0, max(0.0, u))
    return 2 * (x - _smootherstep_integral(x))


def ramp_travel(u: float) -> float:
    return 2 * _smootherstep_integral(u)


def ease_frame_count(seconds: float, hz: float) -> int:
    """JavaScript's Math.round(seconds x hz) (halves round up, unlike Python's round)."""
    return int(math.floor(seconds * hz + 0.5))


def ease_tau(k: int, n: int, hz: float, speed: float) -> float:
    distance = speed * n / hz / 2
    return -distance * (1 - ease_travel(k / n))


def resume_tau(k: int, n: int, hz: float, speed: float) -> float:
    ramp = speed * n / hz / 2
    return ramp * ramp_travel(k / n) if k <= n else ramp + speed * (k - n) / hz


# ---------------- the timeline ----------------

@dataclass(frozen=True)
class DisplayFrame:
    i: int  # show frame index in the stream
    segment: str  # "pass1" | "pass2" | "ease0".. | "resume"
    tau: float  # ideal real time relative to F, s
    t: float  # capture time shown (after snapping to a real frame), s from the shot's first frame
    src: float  # source frame shown: whole for a real frame (and a strobe replacement), fractional for an in-between
    interp: bool
    a: int  # usable real frames around it (a == b == src for a real frame)
    b: int
    w: float  # time fraction from a to b


@dataclass
class Timeline:
    hz: int
    pass2_speed: float
    freeze: int
    make: int
    frames: list[DisplayFrame]
    segments: dict
    cutoff: int
    idr: list[int]
    _by_seg: dict = field(default_factory=dict, repr=False)

    def frames_of(self, segment: str) -> list[DisplayFrame]:
        if segment == "ease":
            return [f for f in self.frames if f.segment.startswith("ease")]
        return [f for f in self.frames if f.segment == segment]

    def format_block(self) -> dict:
        """The court.json video fields this timeline decides (or a hz90 fallback's segments/cutoff)."""
        return {"displayHz": self.hz, "pass2Speed": self.pass2_speed, "segments": self.segments,
                "cutoff": self.cutoff, "freezeSource": self.freeze, "makeSource": self.make}

    def fallback_block(self) -> dict:
        """video.fallbacks.hz90's timeline fields (format.ts ShowFallbacks.hz90): its own speed, segments, cutoff."""
        return {"displayHz": self.hz, "pass2Speed": self.pass2_speed, "segments": self.segments,
                "cutoff": self.cutoff}

    def interp_share(self) -> float:
        return sum(f.interp for f in self.frames) / len(self.frames)

    def summary(self) -> dict:
        s = self.segments
        counts = {"pass1": s["pass1"][1] - s["pass1"][0] + 1, "pass2": s["pass2"][1] - s["pass2"][0] + 1}
        for i, e in enumerate(s["eases"]):
            counts[f"ease{i} ({e['seconds']} s)"] = e["frames"][1] - e["frames"][0] + 1
        counts["resume"] = s["resume"][1] - s["resume"][0] + 1
        interp = {}
        for name in ["pass1", "pass2", "resume"] + [f"ease{i}" for i in range(len(s["eases"]))]:
            fr = self.frames_of(name)
            interp[name] = round(sum(f.interp for f in fr) / len(fr), 4)
        return {"hz": self.hz, "frames": len(self.frames), "counts": counts, "cutoff": self.cutoff,
                "ease_starts": [e["start"] for e in s["eases"]], "idr": len(self.idr),
                "interp_share": round(self.interp_share(), 4), "interp_by_segment": interp,
                "seconds": round(len(self.frames) / self.hz, 3)}


def _snap_tol(cfg: BakeConfig, step_s: float) -> float:
    """Snap tolerance in capture frames: cfg.snap_tol at full steps, shrinking with the step so a slow ease never
    holds a real frame for several display frames."""
    return cfg.snap_tol * min(1.0, abs(step_s) * cfg.capture_fps)


def build(cfg: BakeConfig, hz: int, cap: CapTime | None = None) -> Timeline:
    cap = cap or CapTime.from_config(cfg)
    for s, what in ((cfg.freeze, "freeze"), (cfg.play_start, "play_start"), (cfg.f_end, "pass1_end")):
        if not cap.is_usable(s):
            raise ValueError(f"{what} {s} must be a usable real frame (not a repeat or strobe)")
    t_f = cap.time_of(cfg.freeze)
    v = cfg.pass2_speed_for(hz)
    step2 = v / hz
    eps = 1e-9

    rows: list[tuple[str, float, float]] = []  # (segment, tau, step from the previous position on its path)

    # pass 1: 1x, last frame exactly on pass1_end
    t_end1 = cap.time_of(cfg.f_end)
    n1 = int(math.floor((t_end1 - cap.time_of(cfg.play_start)) * hz + eps))
    for k in range(n1, -1, -1):
        rows.append(("pass1", t_end1 - k / hz - t_f, 1 / hz))

    # pass 2: grid anchored on F
    m_lo = int(math.ceil((cap.time_of(cfg.pass2_start) - t_f) / step2 - eps))
    m_hi = int(math.floor((cap.time_of(cfg.clip_end) - t_f) / step2 + eps))
    p2_first = len(rows)
    for m in range(m_lo, m_hi + 1):
        rows.append(("pass2", m * step2, step2))

    # eases, earliest start (longest) first
    ease_meta = []
    for i, seconds in enumerate(cfg.ease_seconds):
        n = ease_frame_count(seconds, hz)
        if n % 2:
            raise ValueError(f"ease of {seconds} s at {hz} Hz has {n} frames: it must be even so the ease starts on "
                             f"pass 2's grid (n/2 steps before F)")
        m_start = -n // 2
        if m_start < m_lo:
            raise ValueError(f"pass 2 starts too late for the {seconds} s ease: it needs a pass-2 frame {n // 2} "
                             f"steps before F")
        first = len(rows)
        prev = ease_tau(0, n, hz, v)
        for k in range(1, n + 1):
            tau = ease_tau(k, n, hz, v)
            rows.append((f"ease{i}", tau, tau - prev))
            prev = tau
        ease_meta.append({"start": p2_first + (m_start - m_lo), "frames": [first, len(rows) - 1],
                          "seconds": round(n / hz, 4)})

    # resume: from F through the make to clip_end
    nr = ease_frame_count(cfg.resume_ramp_s, hz)
    r_first = len(rows)
    t_last = cap.time_of(cfg.clip_end)
    k, prev = 1, 0.0
    while True:
        tau = resume_tau(k, nr, hz, v)
        if t_f + tau > t_last + eps:
            break
        rows.append(("resume", tau, tau - prev))
        prev, k = tau, k + 1
    if len(rows) == r_first:
        raise ValueError("the resume is empty: clip_end is at F")

    frames = []
    for i, (seg, tau, step) in enumerate(rows):
        t = t_f + tau
        if abs(tau) < 1e-12:
            tau, t = 0.0, t_f
        s = cap.sample(t, _snap_tol(cfg, step))
        src = s.src if s.interp and abs(s.src - round(s.src)) >= 1e-9 else float(round(s.src))
        frames.append(DisplayFrame(i, seg, tau, s.t, src, s.interp, s.a, s.b, s.w))

    segs = {"pass1": [0, p2_first - 1], "pass2": [p2_first, p2_first + (m_hi - m_lo)],
            "resume": [r_first, len(rows) - 1], "eases": ease_meta}
    idr = sorted([0, p2_first, r_first] + [e["frames"][0] for e in ease_meta])
    return Timeline(hz, v, cfg.freeze, cfg.make, frames, segs, ease_meta[-1]["start"], idr)


# ---------------- checks (P6) ----------------

def _paths(tl: Timeline) -> list[tuple[str, list[float], list[float]]]:
    """The playback paths a viewer can see, as (name, ideal taus, shown capture times)."""
    s = tl.segments
    fr = tl.frames
    out = []
    p1 = fr[s["pass1"][0]: s["pass1"][1] + 1]
    out.append(("pass1", [f.tau for f in p1], [f.t for f in p1]))
    p2 = fr[s["pass2"][0]: s["pass2"][1] + 1]
    out.append(("pass2", [f.tau for f in p2], [f.t for f in p2]))
    for i, e in enumerate(s["eases"]):
        lead = fr[s["pass2"][0]: e["start"] + 1]
        ease = fr[e["frames"][0]: e["frames"][1] + 1]
        path = lead + ease
        out.append((f"pass2->ease{i}", [f.tau for f in path], [f.t for f in path]))
        alone = [fr[e["start"]]] + ease
        out.append((f"ease{i}", [f.tau for f in alone], [f.t for f in alone]))
    f_frame = fr[s["eases"][0]["frames"][1]]
    rs = [f_frame] + fr[s["resume"][0]: s["resume"][1] + 1]
    out.append(("F->resume", [f.tau for f in rs], [f.t for f in rs]))
    return out


def check(tl: Timeline, cfg: BakeConfig) -> dict:
    """P6 numbers: speed change per display frame on the ideal curve (<= 0.02), motion max/median of the shown
    steps (<= 2.5) on every path, plus structural checks. `errors` is empty when all hold."""
    errors = []
    max_dv, max_ratio, ratios = 0.0, 0.0, {}
    for name, taus, ts in _paths(tl):
        speed = np.diff(taus) * tl.hz
        if len(speed) > 1:
            dv = float(np.max(np.abs(np.diff(speed))))
            max_dv = max(max_dv, dv)
            if dv > 0.02 + 1e-12:
                errors.append(f"{name}: speed changes by {dv:.4f} in one display frame (> 0.02)")
        steps = np.abs(np.diff(ts))
        moving = steps[steps > 1e-12]
        if len(moving):
            ratio = float(moving.max() / np.median(moving))
            ratios[name] = round(ratio, 3)
            max_ratio = max(max_ratio, ratio)
            if ratio > 2.5:
                errors.append(f"{name}: motion max/median {ratio:.2f} (> 2.5)")
        if np.any(np.diff(ts) < -1e-12):
            errors.append(f"{name}: shown time goes backwards")
    for seg in ("pass2", "resume"):
        fr = tl.frames_of(seg)
        if not (fr[0].src < cfg.make < fr[-1].src):
            errors.append(f"{seg} never passes the make (source {cfg.make}): it shows {fr[0].src}-{fr[-1].src}")
    for i, e in enumerate(tl.segments["eases"]):
        last = tl.frames[e["frames"][1]]
        if last.interp or last.src != cfg.freeze:
            errors.append(f"ease{i} does not end on F")
    return {"errors": errors, "max_speed_change": round(max_dv, 5), "max_motion_ratio": round(max_ratio, 3),
            "motion_ratio_by_path": ratios}
