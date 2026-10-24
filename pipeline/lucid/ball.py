"""The basketball as the reconstruction has it: its centre per frame, in bundle coordinates, for props.json.

Orange alone isn't enough: skin is orange too (shins, forearms, a face), and a frame-by-frame pick jumps from knee to
head at 40 m/s. So a candidate has to be a ball: a compact cluster of orange Gaussians about a ball's size that is
orange all the way round (a limb seen from one side isn't). With the clip's body joints (joints.json) a candidate also
has to sit off the body: more than 20 cm from the head's centre and more than 11 cm from the axis of every limb, which
a held ball does (its centre is a radius out from the palm) and skin never does. Then the track is what moves like one
ball: candidates linked frame to frame at no more than 15 m/s, the longest such chains kept (any that don't overlap in
time, at least 4 frames each). Frames between or outside them are null, so players fade the ball in and out.

Re-track a bundle that's already exported (SPZ frames, joints.json if it has one; keeps the hoop):

    PYTHONPATH=pipeline python -m lucid.ball dreams/<id> [--write]
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np

from .gaussians import Gaussians, read_spz

SH_C0 = 0.28209479177387814
MAX_SPEED = 15.0  # m/s: faster than any shot or pass leaves a hand
MIN_CHAIN = 4  # frames
HEAD_CLEAR = 0.2  # m from the head's centre (the head joint + 9 cm up)
LIMB_CLEAR = 0.11  # m from a limb's axis
LIMBS = [("left_hip", "left_knee"), ("right_hip", "right_knee"), ("left_knee", "left_ankle"), ("right_knee", "right_ankle"),
         ("left_ankle", "left_foot"), ("right_ankle", "right_foot"), ("left_shoulder", "left_elbow"),
         ("right_shoulder", "right_elbow"), ("left_elbow", "left_wrist"), ("right_elbow", "right_wrist"), ("pelvis", "neck")]

# 32 nearly even directions (a Fibonacci sphere): how much of the way round a cluster is orange
_k = np.arange(32) + 0.5
_phi = np.arccos(1 - 2 * _k / 32)
_th = np.pi * (1 + 5**0.5) * _k
DIRS = np.stack([np.cos(_th) * np.sin(_phi), np.cos(_phi), np.sin(_th) * np.sin(_phi)], 1)


def candidates(g: Gaussians, radius: float = 0.12) -> list[tuple[np.ndarray, int, float]]:
    """Ball-like orange clusters in one frame: (centre, Gaussian count, coverage 0-1 of the directions round it)."""
    from scipy.spatial import cKDTree

    rgb = np.clip(g.sh0[:, 0] * SH_C0 + 0.5, 0, 1)
    a = 1 / (1 + np.exp(-g.opacities))
    r, gg, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    orange = (a > 0.3) & (r - b > 0.32) & (gg < 0.72 * r) & (gg > 0.25 * r) & (r > 0.35)
    pts = g.means[orange]
    out = []
    if len(pts) < 40:
        return out
    tree = cKDTree(pts)
    seen = np.zeros(len(pts), bool)
    for i in np.argsort(-tree.query_ball_point(pts, 0.04, return_length=True))[:200]:
        if seen[i]:
            continue
        idx = tree.query_ball_point(pts[i], radius * 1.3)
        if len(idx) < 40:
            seen[idx] = True
            continue
        # seeded on its surface, the first pick is a cap: look again from its middle until it settles on the whole ball
        for _ in range(4):
            c = np.median(pts[idx], 0)
            idx = tree.query_ball_point(c, radius * 1.6)
        idx = tree.query_ball_point(np.median(pts[idx], 0), radius * 1.3)
        q = pts[idx]
        c = np.median(q, 0)
        seen[tree.query_ball_point(c, radius * 1.5)] = True  # one ball, one candidate
        ext = np.percentile(q, 90, 0) - np.percentile(q, 10, 0)
        if ext.max() >= radius * 2.6 or ext.min() <= radius * 0.5:
            continue
        u = q - c
        u /= np.linalg.norm(u, axis=1, keepdims=True) + 1e-9
        cover = float((np.max(u @ DIRS.T, axis=0) > 0.85).mean())
        out.append((c, len(idx), cover))
    return out


def _seg(p: np.ndarray, a: np.ndarray, b: np.ndarray) -> float:
    ab = b - a
    t = np.clip((p - a) @ ab / max(ab @ ab, 1e-9), 0, 1)
    return float(np.linalg.norm(p - (a + t * ab)))


def off_body(c: np.ndarray, joints: np.ndarray, names: list[str]) -> bool:
    """A ball's centre, not skin: clear of the head and of every limb's axis."""
    n = {k: i for i, k in enumerate(names)}
    if np.linalg.norm(c - (joints[n["head"]] + [0, 0.09, 0])) < HEAD_CLEAR:
        return False
    return all(_seg(c, joints[n[x]], joints[n[y]]) >= LIMB_CLEAR for x, y in LIMBS if x in n and y in n)


def chains(cands: list[list[tuple[np.ndarray, int]]], fps: float) -> list[list[tuple[int, np.ndarray]]]:
    """The tracks of one ball: candidates linked across frames (gaps up to 2 missing frames) at no more than MAX_SPEED,
    longest first; chains overlapping a kept one in time are dropped."""
    nodes = [(f, k) for f, cs in enumerate(cands) for k in range(len(cs))]
    best: dict[tuple[int, int], tuple[float, tuple[int, int] | None]] = {}
    for f, k in nodes:
        c, n = cands[f][k]
        score, prev = 1 + min(n, 400) / 4000, None
        for df in (1, 2, 3):
            pf = f - df
            if pf < 0:
                break
            for pk, (pc, _) in enumerate(cands[pf]):
                if np.linalg.norm(c - pc) * fps / df <= MAX_SPEED and (pf, pk) in best:
                    s = best[(pf, pk)][0] + 1 + min(n, 400) / 4000
                    if s > score:
                        score, prev = s, (pf, pk)
        best[(f, k)] = (score, prev)
    used: set[int] = set()
    out = []
    for end in sorted(best, key=lambda e: -best[e][0]):
        chain, e = [], end
        while e is not None:
            chain.append(e)
            e = best[e][1]
        chain.reverse()
        span = set(range(chain[0][0], chain[-1][0] + 1))
        if len(chain) < MIN_CHAIN or span & used:
            continue
        used |= span
        out.append([(f, cands[f][k][0]) for f, k in chain])
    return out


def drop_hovering(track: list, joints: dict, fps: float) -> list:
    """A ball away from both hands (over 30 cm from either wrist) and off the floor is in flight, so it falls: a stretch
    of 3+ such frames whose height doesn't curve down like one (fitted acceleration above -2 m/s^2) was something else
    orange, and goes."""
    n = {k: i for i, k in enumerate(joints["names"])}
    free = []
    for f, x in enumerate(track):
        ok = x is not None and f < len(joints["frames"]) and x[1] > 0.35
        if ok:
            jf = np.asarray(joints["frames"][f], float)
            ok = min(np.linalg.norm(np.asarray(x) - jf[n[w]]) for w in ("left_wrist", "right_wrist")) > 0.3
        free.append(ok)
    # runs of known free frames: a known frame in a hand ends a run, a gap of unknown frames only if it's long
    runs: list[list[int]] = []
    for f, x in enumerate(track):
        if x is None:
            continue
        if not free[f]:
            runs.append([])
        elif runs and runs[-1] and f - runs[-1][-1] <= 6:
            runs[-1].append(f)
        else:
            runs.append([f])
    out = list(track)
    for known in runs:
        if len(known) >= 3:
            t = np.array(known) / fps
            accel = 2 * np.polyfit(t, [track[i][1] for i in known], 2)[0]
            if accel > -2:
                for i in known:
                    out[i] = None
    # and nothing but gravity turns it: a free frame whose velocity differs from the step before it by over 4 m/s
    # (more than a hand could have given it, with no hand there) wasn't the ball
    prev = None  # (frame, velocity) of the last step
    last = None
    for f, x in enumerate(out):
        if x is None:
            continue
        if last is not None and f - last <= 3:
            v = (np.asarray(x) - np.asarray(out[last])) * fps / (f - last)
            if free[f] and prev is not None and np.linalg.norm(v - prev) > 4 + 9.8 * (f - last) / fps:
                out[f] = None
                continue
            prev = v
        else:
            prev = None
        last = f
    return out


def drop_islands(track: list, shortest: int = 3) -> list:
    """A sighting that lasts under `shortest` frames (gaps of up to 2 unknown frames still join one) is a flicker,
    not a ball: it goes, so a player never flashes one in."""
    out = list(track)
    known = [f for f, x in enumerate(track) if x is not None]
    run: list[int] = []
    for f in known + [None]:
        if f is not None and run and f - run[-1] <= 3:
            run.append(f)
            continue
        if run and len(run) < shortest:
            for i in run:
                out[i] = None
        run = [f] if f is not None else []
    return out


def track_ball(frames: list[Gaussians], fps: float, joints: dict | None = None, radius: float = 0.12) -> dict | None:
    """props.json's basketball, or None when nothing moves like one ball for MIN_CHAIN frames. joints: joints.json's
    content (same frames as these)."""
    names = joints["names"] if joints else None
    cands = []
    for f, g in enumerate(frames):
        keep = []
        for c, n, cover in candidates(g, radius):
            if cover < 0.75:
                continue
            if joints and f < len(joints["frames"]) and not off_body(c, np.asarray(joints["frames"][f], float), names):
                continue
            keep.append((c, n))
        cands.append(keep)
    found = chains(cands, fps)
    if not found:
        return None
    track: list[list[float] | None] = [None] * len(frames)
    for chain in found:
        for f, c in chain:
            track[f] = [round(float(v), 4) for v in c]
    if joints:
        track = drop_hovering(track, joints, fps)
    track = drop_islands(track)
    if sum(x is not None for x in track) < MIN_CHAIN:
        return None
    return {"kind": "basketball", "radius": radius, "track": track, "source": "reconstruction" + (" + joints" if joints else "")}


def speeds(track: list, fps: float) -> list[float]:
    """Frame-to-frame speeds where both ends are known (m/s)."""
    return [math.dist(a, b) * fps for a, b in zip(track, track[1:]) if a is not None and b is not None]


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("bundle", type=Path)
    p.add_argument("--write", action="store_true", help="replace props.json's basketball (the hoop stays)")
    a = p.parse_args(argv)
    dream = json.loads((a.bundle / "dream.json").read_text())
    fps = float(dream.get("fps", 25))
    pattern = (dream.get("frames") or {}).get("spz", "%06d.spz")
    frames = [read_spz(a.bundle / "frames" / (pattern % i)) for i in range(dream["frameCount"])]
    jp = a.bundle / "joints.json"
    joints = json.loads(jp.read_text()) if jp.exists() else None
    ball = track_ball(frames, fps, joints)
    if ball is None:
        print("BALL_NONE: nothing moves like one ball")
    else:
        known = [i for i, x in enumerate(ball["track"]) if x is not None]
        sp = speeds(ball["track"], fps)
        print(f"BALL_OK {len(known)} of {len(frames)} frames ({known[0]}-{known[-1]}), top speed {max(sp, default=0):.1f} m/s, "
              f"source {ball['source']}")
    if not a.write:
        return
    pp = a.bundle / "props.json"
    props = json.loads(pp.read_text()) if pp.exists() else {"fps": fps, "objects": []}
    props["objects"] = [o for o in props["objects"] if o.get("kind") != "basketball"]
    if ball:
        props["objects"].insert(0, ball)
    pp.write_text(json.dumps(props, indent=2))
    print(f"wrote {pp}")


if __name__ == "__main__":
    main()
