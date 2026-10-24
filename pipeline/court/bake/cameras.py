"""Per display frame camera, frames.json, and validation against format.ts (read only, through node).

The solve (calib_A.json schema): one centre C, per container frame R (world->camera, OpenCV axes), f and k1 at the
source size; principal point at the image centre. The bundle wants world-from-camera quaternions [x, y, z, w]
(q = R^T), the solve's own camera for each real frame (never smoothed) and, for an in-between at fraction w between
real frames a and b, slerp(q_a, q_b, w) and lerp(f_a, f_b, w). The bake undistorts every frame (source.py) keeping
the principal point at the centre and f scaled by cfg.undistort_f_scale, so k1 is 0 in the bundle.

Frames outside the solve's coverage fail closed (CameraCoverageError). cfg.camera_hold_edge (TEST ONLY, never for a
shipped bundle) gives them the nearest solved camera and marks each one `held`.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation

from .config import BakeConfig
from .timeline import Timeline


class CameraCoverageError(ValueError):
    pass


@dataclass(frozen=True)
class SolvedCamera:
    q: tuple  # world-from-camera [x, y, z, w]
    f: float


@dataclass(frozen=True)
class Solve:
    width: int
    height: int
    centre: tuple
    k1: float
    frames: dict  # source frame -> SolvedCamera


@dataclass(frozen=True)
class FrameCamera:
    q: tuple
    f: float  # after undistortion (source pixels)
    cx: float
    cy: float
    held: bool = False  # TEST ONLY: borrowed from the nearest solved frame


def load_calib(path) -> Solve:
    with open(Path(path).expanduser()) as fh:
        doc = json.load(fh)
    w, h = (int(x) for x in doc["image_size"])
    k1s = {round(float(fr["k1"]), 9) for fr in doc["frames"]}
    if len(k1s) != 1:
        raise ValueError(f"calibration has {len(k1s)} different k1 values: per-frame k1 is not supported")
    ref = None
    frames = {}
    for fr in sorted(doc["frames"], key=lambda x: x["source_frame"]):
        R = np.asarray(fr["R"], float)
        if not np.allclose(R @ R.T, np.eye(3), atol=1e-6):
            raise ValueError(f"frame {fr['source_frame']}: R is not a rotation")
        q = Rotation.from_matrix(R.T).as_quat()  # world-from-camera, [x, y, z, w]
        if ref is None:
            ref = q if q[3] >= 0 else -q
        if np.dot(q, ref) < 0:  # one hemisphere for the whole clip
            q = -q
        frames[int(fr["source_frame"])] = SolvedCamera(tuple(float(x) for x in q), float(fr["f"]))
    return Solve(w, h, tuple(float(x) for x in doc["C"]), float(k1s.pop()), frames)


def slerp(qa, qb, w: float) -> tuple:
    a, b = np.asarray(qa, float), np.asarray(qb, float)
    d = float(np.dot(a, b))
    if d < 0:
        b, d = -b, -d
    if d > 1 - 1e-12:
        q = a + w * (b - a)
    else:
        th = np.arccos(min(1.0, d))
        q = (np.sin((1 - w) * th) * a + np.sin(w * th) * b) / np.sin(th)
    q = q / np.linalg.norm(q)
    return tuple(float(x) for x in q)


def _ranges(frames: list[int], gap: int = 2) -> str:
    """'a-b, c-d' spans, bridging gaps of up to `gap` (the repeat frames a timeline never asks for)."""
    out, start, prev = [], None, None
    for s in sorted(set(frames)):
        if start is None:
            start = prev = s
        elif s <= prev + gap:
            prev = s
        else:
            out.append(f"{start}-{prev}" if start != prev else str(start))
            start = prev = s
    if start is not None:
        out.append(f"{start}-{prev}" if start != prev else str(start))
    return ", ".join(out)


def cameras_for(tl: Timeline, sol: Solve, cfg: BakeConfig) -> list[FrameCamera]:
    cx, cy = (sol.width - 1) / 2, (sol.height - 1) / 2
    solved = sorted(sol.frames)
    missing: dict[str, list[int]] = {}
    for f in tl.frames:
        for s in {f.a, f.b}:
            if s not in sol.frames:
                missing.setdefault(f.segment, []).append(s)
    if missing and not cfg.camera_hold_edge:
        detail = "; ".join(f"{seg}: source frames {_ranges(v)}" for seg, v in missing.items())
        raise CameraCoverageError(f"no solved camera (calibration covers {solved[0]}-{solved[-1]}) for {detail}")

    def cam(s: int) -> tuple[SolvedCamera, bool]:
        if s in sol.frames:
            return sol.frames[s], False
        near = min(solved, key=lambda x: (abs(x - s), x))
        return sol.frames[near], True

    out = []
    k = cfg.undistort_f_scale
    for f in tl.frames:
        ca, ha = cam(f.a)
        if not f.interp:
            out.append(FrameCamera(ca.q, ca.f * k, cx, cy, ha))
            continue
        cb, hb = cam(f.b)
        out.append(FrameCamera(slerp(ca.q, cb.q, f.w), ((1 - f.w) * ca.f + f.w * cb.f) * k, cx, cy, ha or hb))
    return out


def source_camera_block(sol: Solve, cfg: BakeConfig) -> dict:
    """court.json `camera` (format.ts SourceCamera) for the undistorted bundle."""
    src_frames_per_real_s = cfg.capture_fps * cfg.repeat_mod / (cfg.repeat_mod - 1)
    return {"centre": list(sol.centre), "width": sol.width, "height": sol.height,
            "cx": (sol.width - 1) / 2, "cy": (sol.height - 1) / 2, "k1": 0,
            "sourceFps": cfg.source_fps, "captureFps": cfg.capture_fps,
            "slow": src_frames_per_real_s / cfg.source_fps}


def video_json_camera(sol: Solve, cfg: BakeConfig) -> dict:
    """video.json's `camera` for stream G: the centre the frames' q/f go with, and the three rates."""
    b = source_camera_block(sol, cfg)
    return {k: b[k] for k in ("centre", "sourceFps", "captureFps", "slow")}


def frames_json(tl: Timeline, cams: list[FrameCamera]) -> list[dict]:
    """video/frames.json entries (format.ts ShowFrame, plus `segment`, which readers ignore)."""
    if len(cams) != len(tl.frames):
        raise ValueError("one camera per display frame expected")
    if any(c.held for c in cams):
        raise CameraCoverageError("refusing to write frames.json with held (test-only) cameras")
    out = []
    for f, c in zip(tl.frames, cams):
        src = int(f.src) if float(f.src).is_integer() else round(f.src, 6)
        out.append({"src": src, "interp": bool(f.interp), "q": [round(x, 12) for x in c.q], "f": round(c.f, 4),
                    "segment": f.segment})
    return out


def write_frames_json(path, tl: Timeline, cams: list[FrameCamera]) -> list[dict]:
    entries = frames_json(tl, cams)
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(entries, separators=(",", ":")))
    os.replace(tmp, p)
    return entries


# ---------------- format.ts / clock.ts through node (read only) ----------------

_TS_FILES = ("format.ts", "clock.ts")
_REF = "origin/court-side"
_TS_PATH = "apps/webxr/src/court/"


def _ts_source_dir(dst: Path) -> bool:
    """Copy format.ts and clock.ts into dst: from $COURT_FORMAT_DIR if set, else `git show origin/court-side:...`
    from this checkout. Never touches a checkout's files."""
    env = os.environ.get("COURT_FORMAT_DIR")
    if env:
        for n in _TS_FILES:
            shutil.copy(Path(env) / n, dst / n)
        return True
    repo = Path(__file__).resolve().parent
    for n in _TS_FILES:
        r = subprocess.run(["git", "-C", str(repo), "show", f"{_REF}:{_TS_PATH}{n}"], capture_output=True, text=True)
        if r.returncode != 0:
            return False
        (dst / n).write_text(r.stdout)
    return True


_RUNNER = r"""
import { readFileSync } from "node:fs";
const [, , dir, job] = process.argv;
const fmt = await import(dir + "/format.ts");
const clock = await import(dir + "/clock.ts");
const j = JSON.parse(readFileSync(job, "utf8"));
const out = {};
if (j.frames) {
  const v = j.video;
  // validateCourt on a court holding only our video fields: keep the errors about the fields we write
  const mine = ["video.segments", "video.cutoff", "video.pass2Speed", "video.displayHz", "video.freezeSource"];
  out.court = fmt.validateCourt({ video: v }).filter((e) => mine.some((m) => e.startsWith(m)));
  out.frames = out.court.length ? [] : fmt.validateFrames(j.frames, { video: v });
}
if (j.curves) {
  out.curves = j.curves.map(([n, hz]) => {
    const c = [];
    for (let k = 0; k <= n; k++) c.push(clock.easeTau(k, n, hz, j.speed));
    for (let k = 1; k <= n + 2; k++) c.push(clock.resumeTau(k, n, hz, j.speed));
    return c;
  });
}
process.stdout.write(JSON.stringify(out));
"""


def _run_node(job: dict) -> dict | None:
    if shutil.which("node") is None:
        return None
    with tempfile.TemporaryDirectory(prefix="bake-fmt-") as d:
        dp = Path(d)
        if not _ts_source_dir(dp):
            return None
        (dp / "run.mjs").write_text(_RUNNER)
        (dp / "job.json").write_text(json.dumps(job))
        r = subprocess.run(["node", str(dp / "run.mjs"), str(dp), str(dp / "job.json")], capture_output=True,
                           text=True, timeout=120)
        if r.returncode != 0:
            raise RuntimeError(f"format.ts runner failed: {r.stderr.strip()[-2000:]}")
        return json.loads(r.stdout)


def validate_with_format_ts(entries: list[dict], tl: Timeline) -> list[str] | None:
    """format.ts validateFrames on these entries (and validateCourt's checks of the segment block); None when node
    or origin/court-side's format.ts is unavailable."""
    out = _run_node({"frames": entries, "video": tl.format_block()})
    return None if out is None else out["court"] + out["frames"]


def run_clock_ts_curves(pairs, speed: float) -> dict | None:
    """clock.ts easeTau(k=0..n) + resumeTau(k=1..n+2) for each (n, hz); None when unavailable."""
    out = _run_node({"curves": [list(p) for p in pairs], "speed": speed})
    return None if out is None else {tuple(p): c for p, c in zip(pairs, out["curves"])}
