"""The slide number for voice-driven lips: SyncNet confidence of a front face render, before and after.

Plain parts (numpy only); the renders are `lips_render.py` (GPU) and SyncNet itself runs in `lips_sync_score.py`
(`hpg/syncnet.sbatch`).

  after    the bundle as `lips.py` made it: expr = mouth0..mouth8 (the voice) + blink, with voice.m4a
  before   the same avatar, camera and audio with the mouth channels zeroed: the living idle, blinking, mouth shut
  scores   SyncNet (Chung and Zisserman, joonson/syncnet_python, MIT): LSE-C = Confidence (median over offsets of the
           clip's mean distance minus its minimum), LSE-D = Min dist, and the AV offset in frames. Both renders go
           through the same crop and the same audio, so the only difference is the mouth.

Consenting people only (lips.py's gate, head_swap.voice_consent_errors, before anything is read): the bundle must be
their own voice-driven bundle. Never a public figure.
"""

from __future__ import annotations

import math
import re
from pathlib import Path

import numpy as np

from .head_swap import voice_consent_errors
from .lips import LIPS_FILE, resample

FPS = 25                  # SyncNet's video rate (SyncNetInstance.py: video 25 fps, audio 16 kHz)
CROP_PX = 224             # SyncNet's input size
MIN_CLIP_S = 2.0          # it drops the last 5 frames and wants a few seconds for a median that means anything
SYNC_FILE = "lips_sync.json"
MODEL = "syncnet_v2.model"
MIN_HORIZONTAL = 0.1      # a face looking this close to straight up or down has no front
NOTE = ("SyncNet on our own front face render of the speaking avatar with its own voice (not the Quest, not a real "
        "video): before = the same avatar and audio with the mouth channels zeroed (idle and blink only), after = "
        "mouth driven by the voice. Published real-video LSE-C is about 6-8 on LRS2; the before/after delta is the claim.")

_PATTERNS = {"offset": re.compile(r"AV offset:\s*(-?\d+)"), "dist": re.compile(r"Min dist:\s*(\S+)"),
             "conf": re.compile(r"Confidence:\s*(\S+)")}


# ---------------------------------------------------------------- SyncNet's output

def parse_syncnet(text: str) -> dict:
    """{"offset": int, "dist": float, "conf": float} from SyncNetInstance.evaluate's output (its logger lines, or the
    print lines of older checkouts); the last report if several. ValueError on a missing or non-finite value."""
    out: dict = {}
    for key, pat in _PATTERNS.items():
        found = pat.findall(text)
        if not found:
            raise ValueError(f"no '{key}' line in SyncNet's output")
        if key == "offset":
            out[key] = int(found[-1])
            continue
        try:
            value = float(found[-1])
        except ValueError as e:
            raise ValueError(f"SyncNet's {key} {found[-1]!r} is not a number") from e
        if not math.isfinite(value):
            raise ValueError(f"SyncNet's {key} is {value}")
        out[key] = value
    return out


# ---------------------------------------------------------------- before: idle, no mouth

def before_expr(expr: np.ndarray, channels) -> np.ndarray:
    """A copy of per-frame expr (T, len(channels)) with every channel whose name starts with `mouth` zeroed, by name
    from the bundle's `exprChannels`; the blink (and anything else) is kept."""
    expr = np.asarray(expr, dtype=np.float64)
    channels = list(channels)
    if expr.ndim != 2 or expr.shape[1] != len(channels):
        raise ValueError(f"expr {expr.shape} doesn't fit the {len(channels)} channels {channels}")
    mouth = [i for i, name in enumerate(channels) if name.startswith("mouth")]
    if not mouth:
        raise ValueError(f"no mouth channel in {channels}: this isn't a voice-driven bundle (lips.py), nothing to zero")
    out = expr.copy()
    out[:, mouth] = 0.0
    return out


# ---------------------------------------------------------------- 25 fps

def frame_plan(n_src: int, fps_src: float, clip_s: float, fps_out: int = FPS) -> tuple[int, np.ndarray]:
    """(n_out, source motion frame per output frame): 25 fps frames over the clip (the partial last frame dropped, so
    audio and video are the same length), each taking the nearest motion frame in time."""
    if clip_s < MIN_CLIP_S:
        raise ValueError(f"the clip is {clip_s:.2f} s, too short for SyncNet (want at least {MIN_CLIP_S:.0f} s)")
    if n_src / fps_src < clip_s - 1.0 / fps_src:
        raise ValueError(f"the motion covers {n_src / fps_src:.2f} s but the clip is {clip_s:.2f} s")
    n_out = int(math.floor(clip_s * fps_out + 1e-9))
    idx = np.clip(np.rint(np.arange(n_out) / fps_out * fps_src), 0, n_src - 1).astype(np.int64)
    return n_out, idx


def resample_expr(expr: np.ndarray, fps_in: float, n_out: int, fps_out: int = FPS) -> np.ndarray:
    """(n_out, channels): expr read at 25 fps by linear interpolation (the last frame held beyond the end)."""
    return resample(np.asarray(expr, dtype=np.float64), fps_in, fps_out, n_out)


# ---------------------------------------------------------------- the camera and the crops

def front_angle(forward) -> float:
    """lucid.export.orbit_camera's angle that puts the camera in front of a face looking along `forward` (world; only
    its horizontal part counts): rest pose faces +Z -> pi, the idle's yaw-pi pose faces -Z -> 0."""
    f = np.asarray(forward, dtype=np.float64).reshape(3)
    h = math.hypot(f[0], f[2])
    if h < MIN_HORIZONTAL * np.linalg.norm(f):
        raise ValueError(f"face direction {f.tolist()} is nearly vertical: no front to put a camera on")
    return math.atan2(f[0], -f[2])


def render_size(factor: int) -> int:
    """The render's side: a whole multiple of the 224 crop, so the crop is an exact box average."""
    return CROP_PX * int(factor)


def box_down(img: np.ndarray, k: int) -> np.ndarray:
    """(H, W, C) uint8 averaged over k x k blocks (the 224 crop from the full-resolution render)."""
    h, w, c = img.shape
    if k < 1 or h % k or w % k:
        raise ValueError(f"a {w}x{h} image doesn't divide into {k}x{k} blocks")
    mean = img.reshape(h // k, k, w // k, k, c).astype(np.float64).mean(axis=(1, 3))
    return np.rint(mean).astype(np.uint8)


# ---------------------------------------------------------------- the report

def _score(name: str, s: dict) -> dict:
    try:
        offset, dist, conf = int(s["offset"]), float(s["dist"]), float(s["conf"])
    except (KeyError, TypeError, ValueError) as e:
        raise ValueError(f"{name} score needs offset, dist and conf: {s!r}") from e
    if not (math.isfinite(dist) and math.isfinite(conf)):
        raise ValueError(f"{name} score is not finite: {s!r}")
    return {"conf": round(conf, 4), "dist": round(dist, 4), "offset": offset}


def sync_report(before: dict, after: dict, *, person: str, bundle: str, clip_s: float, frames: int,
                model: str = MODEL, **extra) -> dict:
    """lips_sync.json: {before, after: {conf, dist, offset}, deltaConf, deltaDist, improved, model, fps, clipS, ...}."""
    b, a = _score("before", before), _score("after", after)
    return {"person": person, "bundle": bundle, "before": b, "after": a,
            "deltaConf": round(a["conf"] - b["conf"], 4), "deltaDist": round(a["dist"] - b["dist"], 4),
            "improved": a["conf"] > b["conf"], "model": model, "fps": FPS, "clipS": round(float(clip_s), 3),
            "frames": int(frames), "crop": f"{CROP_PX}x{CROP_PX}", "note": NOTE, **extra}


def sync_line(report: dict) -> str:
    return f"SYNC conf before {report['before']['conf']:.2f} after {report['after']['conf']:.2f}"


# ---------------------------------------------------------------- the gate

def sync_consent_errors(person: str, bundle: str | Path, held: str | Path | None = None) -> list[str]:
    """Why this bundle mustn't be rendered and scored (empty if it may): lips.py's own gate (VOICE_CONSENTED, their own
    avatar, nothing in dreams/.held), and the bundle has to be that person's voice-driven bundle (lips.json, and
    dream.json's source.voice.person is them). Raises FileNotFoundError without a dream.json: nothing is read before."""
    import json

    bundle = Path(bundle)
    errors = voice_consent_errors(person, bundle, held, None)
    if not (bundle / LIPS_FILE).is_file():
        errors.append(f"{bundle.name} has no {LIPS_FILE}: not a voice-driven bundle (lips.sbatch makes one)")
    voice = ((json.loads((bundle / "dream.json").read_text()).get("source") or {}).get("voice") or {})
    if voice.get("person") != person:
        errors.append(f"{bundle.name}'s voice is not {person}'s (dream.json source.voice.person: "
                      f"{voice.get('person')!r}): only their own voice drives their face")
    return errors
