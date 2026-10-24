"""Build the tennis motion library: apps/webxr/public/tennis/motions/<name>.json + index.json.

    python build.py --npz <dir of gvhmr_clip.py outputs> [--only serve,forehand] [--check <dir for pictures>]

Each clip: GVHMR's fit of one freely licensed video (SOURCES), cut to the stroke, retargeted to SMPL-X neutral
(betas 0), resampled to 30 fps, turned to face -Z with the pelvis over x = z = 0 at the start, soles on y = 0, planted
feet locked (lucid_avatars.foot_contact), a racket grip in the right hand. Strokes carry events (frame numbers at
30 fps) and the right wrist's pose at contact; loops end one frame before they start again; travel loops carry a root
velocity the game scales.

Pipeline: gvhmr.sbatch runs gvhmr_clip.py on HiPerGator for each source video (npz of GVHMR's world fit);
inspect_clip.py draws that fit over the video with wrist / foot / heading curves to choose the frames and contacts
below; build.py writes the clips; check.py verifies them (valid, < 1 MB, soles on y = 0, loop seams, facing) and poses
the test avatar's Gaussians with each clip; render.py draws stick-figure strips. Needs numpy, scipy (+ matplotlib for
pictures), and avatars/ on the path (added below).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import replace
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation as Rot

sys.path.insert(0, str(Path(__file__).resolve().parent))
import motionlib as ml  # noqa: E402
from lucid_avatars.foot_contact import FootLockParams, format_report, lock_feet  # noqa: E402
from lucid_avatars.motion import validate_motion_dict  # noqa: E402
from lucid_avatars.smplx_layout import J  # noqa: E402

OUT = ml.REPO / "apps" / "webxr" / "public" / "tennis" / "motions"

PEXELS = "Pexels License (free to use and modify, no attribution required; credited anyway)"
SOURCES = {
    "4902145": {"title": "A Tennis layer Serving The Ball From The Baseline", "creator": "Antoni Shkraba",
                "url": "https://www.pexels.com/video/4902145/", "license": PEXELS},
    "7648646": {"title": "Sportsman Hitting the Squash Ball with Racket", "creator": "Artem Podrez",
                "url": "https://www.pexels.com/video/7648646/", "license": PEXELS},
    "7648844": {"title": "A Man Playing Tennis", "creator": "Artem Podrez",
                "url": "https://www.pexels.com/video/7648844/", "license": PEXELS},
    "7334474": {"title": "Happy Man Celebrating His Win", "creator": "Pavel Danilyuk",
                "url": "https://www.pexels.com/video/7334474/", "license": PEXELS},
    "7187058": {"title": "A Man Running in the Soccer Field", "creator": "RDNE Stock project",
                "url": "https://www.pexels.com/video/7187058/", "license": PEXELS},
    "8402119": {"title": "Brawny Man Doing Ladder Exercise Outdoors", "creator": "RDNE Stock project",
                "url": "https://www.pexels.com/video/8402119/", "license": PEXELS},
    "38997478": {"title": "Indoor Tennis Practice with Ball Machine", "creator": "Sapol Churanon",
                 "url": "https://www.pexels.com/video/38997478/", "license": PEXELS},
}

# Source frame numbers are the video's own (its native fps). time_scale > 1 for slow-motion footage.
CLIPS: dict[str, dict] = {
    "serve": dict(src="4902145", start=116, end=184, orient="hit",
                  events={"tossRelease": 141, "tossPeak": 150, "contact": 160},
                  about="Flat first serve, ready stance side-on -> ball bounce done -> toss -> trophy -> contact -> "
                        "landing on the front foot. Turned so the ball goes to -Z."),
    "forehand": dict(src="7648646", start=186, end=254, orient="start", events={"contact": 222},
                     about="Right-handed forehand (a tennis forehand with a wooden racket, filmed on a squash court): "
                           "ready facing -Z -> unit turn -> swing -> contact in front at hip height -> follow-through "
                           "over the left shoulder -> back to ready."),
    "backhand": dict(src="7648844", start=164, end=246, orient="start", events={"contact": 191},
                     about="One-handed backhand: ready facing -Z -> shoulder turn -> swing -> wide follow-through "
                           "(both arms out) -> recovery."),
    "celebrate": dict(src="7334474", start=4, end=168, segments=[(4, 84), (126, 168)], orient="start", orientFrames=(40, 100),
                      events={},
                      about="Both fists thrown up in a V, held, then lowered (the long hold in the footage is cut "
                            "and cross-faded). Faces -Z during the V; turns in from about 75 degrees to the right."),
    "fistPump": dict(src="7334474", start=240, end=320, orient="start", events={},
                     about="'Yes!': fists clenched at the chest, leans back looking up, two pumps."),
}

# Loops: a cycle [start, start + period] (source frames) is searched inside `search` for the best match of pose and
# velocity at the wrap; `period` bounds it. travel loops: root x/z motion goes to rootVelocity.
LOOPS: dict[str, dict] = {
    "ready": dict(src="38997478", search=(380, 560), period=(70, 140), travel=False,
                  about="Ready stance between shots: knees bent, racket in front, weight shifting. Loops."),
    "run": dict(src="7187058", search=(80, 112), period=(12, 22), travel=True,
                footLock=dict(enter_speed=0.6, exit_speed=0.9, enter_height=0.05, exit_height=0.08, min_frames=2,
                              blend=2),
                about="Forward run cycle (two steps). Travels toward -Z; the motion is in place and rootVelocity "
                      "(per frame, m/s, x/z) carries the travel. Loops."),
    "shuffleLeft": dict(src="8402119", search=(98, 134), period=(10, 26), travel=True, orient="body",
                        footLock=dict(enter_speed=0.5, exit_speed=0.8, min_frames=2, blend=2),
                        about="Lateral quick-feet shuffle in an athletic stance, facing -Z and moving to the player's "
                              "left (-X). In place; rootVelocity carries the travel. Loops."),
}


def src_to_out(f_src: float, c: dict, fps_src: float) -> int:
    return int(round((f_src - c["start"]) / fps_src / c.get("time_scale", 1.0) * ml.FPS))


def _r4(a):
    a = np.round(np.asarray(a, dtype=np.float64), 4)
    a[a == 0] = 0.0  # no -0.0
    return a.tolist()


def clip_json(name: str, m, extra: dict) -> dict:
    frames = [{"root_t": _r4(t), "root_q": _r4(q / np.linalg.norm(q)), "pose": _r4(p)}
              for t, q, p in zip(m.root_t, m.root_q, m.pose)]
    d = {"name": name, "fps": ml.FPS, "betas": [0.0] * 10, "frames": frames}
    d.update(extra)
    errors = validate_motion_dict(d)
    if errors:
        raise SystemExit(f"{name}: invalid motion: {errors[:3]}")
    return d


def wrist_at(m, rest, f: int) -> dict:
    """The racket hand at frame f, in the clip's own space (metres, +Y up, the clip's root as given)."""
    P, G = ml.fk(rest, m.root_q, m.root_t, m.pose)
    q = Rot.from_matrix(G[f, J["right_wrist"]]).as_quat()
    fore = P[f, J["right_wrist"]] - P[f, J["right_elbow"]]
    grip, head, _ = ml.racket_points(P, G)
    hv = (head[min(f + 1, len(P) - 1)] - head[max(f - 1, 0)]) * ml.FPS / 2
    wv = (P[min(f + 1, len(P) - 1), J["right_wrist"]] - P[max(f - 1, 0), J["right_wrist"]]) * ml.FPS / 2
    return {"frame": int(f), "rightWrist": _r4(P[f, J["right_wrist"]]),
            "rightWristQuat": _r4(q / np.linalg.norm(q)),
            "rightWristVelocity": _r4(wv),
            "rightForearmDir": _r4(fore / np.linalg.norm(fore)),
            "racketHead": _r4(head[f]), "racketHeadVelocity": _r4(hv),
            "racketDir": _r4((head[f] - grip[f]) / np.linalg.norm(head[f] - grip[f])),
            "pelvis": _r4(P[f, J["pelvis"]])}


def prepare(npz_dir: Path, src: str, rest, sigma: float = 1.0):
    d = ml.load_gvhmr(npz_dir / f"{src}.npz")
    m = ml.gvhmr_motion(d, rest)
    return d, ml.smooth(m, sigma)


def build_stroke(name: str, c: dict, npz_dir: Path, rest, soles) -> tuple[dict, dict]:
    d, m = prepare(npz_dir, c["src"], rest, c.get("sigma", 1.0))
    fps_src = m.fps
    if c.get("segments"):
        parts = [ml.resample(m, a, b, c.get("time_scale", 1.0)) for a, b in c["segments"]]
        m = parts[0]
        for part in parts[1:]:
            m = ml.concat(m, part, 8)
    else:
        m = ml.resample(m, c["start"], c["end"], c.get("time_scale", 1.0))
    ev = {k: src_to_out(v, c, fps_src) for k, v in c.get("events", {}).items()}
    if c.get("mirror"):
        m = ml.mirror(m)
    if c["orient"] == "hit" and "contact" in ev:
        P, _ = ml.fk(rest, m.root_q, m.root_t, m.pose)
        f = ev["contact"]
        v = P[min(f + 1, len(P) - 1), J["right_wrist"]] - P[max(f - 1, 0), J["right_wrist"]]
        m = ml.face_minus_z(m, rest, forward=v[[0, 2]] / np.linalg.norm(v[[0, 2]]))
    else:
        a, b = c.get("orientFrames", (0, 6))  # output frames whose mean facing becomes -Z
        m = ml.face_minus_z(m, rest, frames=slice(a, b))
    m = ml.to_floor(m, rest, soles)
    m, rep = lock_feet(m, rest, FootLockParams(**c.get("footLock", {})))
    m = ml.to_floor(m, rest, soles, percentile=2.0)  # the lock flattens planted feet: put those soles on y = 0
    m = ml.clamp_above_floor(m, rest, soles)
    m = ml.with_grip(m)
    P, G = ml.fk(rest, m.root_q, m.root_t, m.pose)
    extra = {"loop": False, "durationS": round((m.num_frames - 1) / ml.FPS, 4), "events": ev}
    if "contact" in ev:
        extra["contactFrame"] = ev["contact"]
        extra["contactPose"] = wrist_at(m, rest, ev["contact"])
    if "tossPeak" in ev:
        lw = P[ev["tossPeak"], J["left_wrist"]]
        extra["tossPeak"] = {"frame": ev["tossPeak"], "leftWrist": _r4(lw)}
    extra["source"] = {**SOURCES[c["src"]], "frames": c.get("segments") or [c["start"], c["end"]], "sourceFps": fps_src,
                       "timeScale": c.get("time_scale", 1.0)}
    extra["about"] = c.get("about", "")
    sp = np.linalg.norm(np.gradient(P[:, J["right_wrist"]], axis=0) * ml.FPS, axis=1)
    stats = {"frames": m.num_frames, "peakRightWristSpeed": round(float(sp.max()), 2),
             "footLock": format_report(rep)}
    return clip_json(name, m, extra), stats


def mirror_clip(clip: dict, name: str) -> dict:
    fr = clip["frames"]
    m = ml.Motion(fps=clip["fps"], betas=np.zeros(10), root_t=np.array([f["root_t"] for f in fr]),
                  root_q=np.array([f["root_q"] for f in fr]), pose=np.array([f["pose"] for f in fr]))
    m = ml.with_grip(ml.mirror(m))
    extra = {k: v for k, v in clip.items() if k not in ("name", "fps", "betas", "frames")}
    if "rootVelocity" in extra:
        extra["rootVelocity"] = [[-v[0], v[1]] for v in extra["rootVelocity"]]
        mv = extra["meanVelocity"]
        extra["meanVelocity"] = [-mv[0], mv[1], mv[2]]
    extra["about"] = clip["about"].replace("left (-X)", "right (+X)") + " Mirror image of shuffleLeft."
    extra["mirrored"] = True
    return clip_json(name, m, extra)


def build_loop(name: str, c: dict, npz_dir: Path, rest, soles) -> tuple[dict, dict]:
    d, m = prepare(npz_dir, c["src"], rest, c.get("sigma", 1.0))
    fps_src = m.fps
    if "start" in c:
        s, per, cost = c["start"], c["periodFrames"], float("nan")
    else:
        lo, hi = c["search"]
        s, per, cost = ml.best_cycle(m, rest, (lo, hi - c["period"][0]), c["period"])
    m = ml.resample(m, s, s + per, c.get("time_scale", 1.0))  # last frame = the wrap (== frame 0 of the next cycle)
    if c.get("mirror"):
        m = ml.mirror(m)
    P, _ = ml.fk(rest, m.root_q, m.root_t, m.pose)
    if c["travel"] and c.get("orient", "travel") == "travel":
        v = P[-1, 0] - P[0, 0]
        m = ml.face_minus_z(m, rest, forward=v[[0, 2]] / np.linalg.norm(v[[0, 2]]))
    else:
        m = ml.face_minus_z(m, rest, frames=slice(0, m.num_frames))
    m = ml.to_floor(m, rest, soles)
    m, rep = lock_feet(m, rest, FootLockParams(**c.get("footLock", {})))
    m = ml.clamp_above_floor(m, rest, soles)
    loop, vel = ml.make_loop(m, travel=c["travel"])
    loop = ml.to_floor(loop, rest, soles, percentile=2.0)
    loop = ml.clamp_above_floor(loop, rest, soles)
    extra = {"loop": True, "durationS": round(loop.num_frames / ml.FPS, 4), "events": {}}
    if c["travel"]:
        loop, v = ml.split_root_motion(loop, vel)
        extra["rootVelocity"] = [_r4(x) for x in v]
        extra["meanVelocity"] = _r4([vel[0], 0.0, vel[2]])
    else:
        loop = ml.center_xz(loop, rest)
    loop = ml.with_grip(loop)
    extra["source"] = {**SOURCES[c["src"]], "frames": [int(s), int(s + per)], "sourceFps": fps_src,
                       "timeScale": c.get("time_scale", 1.0)}
    extra["about"] = c.get("about", "")
    stats = {"frames": loop.num_frames, "cycle": (int(s), int(per), round(cost, 4)), "footLock": format_report(rep),
             "meanVelocity": np.round(vel, 3).tolist()}
    return clip_json(name, loop, extra), stats


def write_index(rest):
    """index.json from every clip file on disk (so a partial --only build keeps the rest listed)."""
    clips = {}
    for f in sorted(OUT.glob("*.json")):
        if f.name == "index.json":
            continue
        c = json.loads(f.read_text())
        entry = {"file": f.name, "frames": len(c["frames"]), "durationS": c["durationS"], "loop": c["loop"],
                 "events": c.get("events", {}), "bytes": f.stat().st_size, "about": c.get("about", "")}
        for k in ("contactFrame", "contactPose", "tossPeak", "meanVelocity", "mirrored"):
            if k in c:
                entry[k] = c[k]
        if "meanVelocity" in c:
            entry["speed"] = round(float(np.hypot(c["meanVelocity"][0], c["meanVelocity"][2])), 3)
        src = c["source"]
        entry["source"] = {k: src[k] for k in ("creator", "title", "url", "license", "frames")}
        clips[c["name"]] = entry
    order = ["ready", "run", "shuffleLeft", "shuffleRight", "forehand", "backhand", "serve", "celebrate", "fistPump"]
    clips = {k: clips[k] for k in order if k in clips} | {k: v for k, v in clips.items() if k not in order}
    from lucid_avatars.retarget import leg_length
    index = {
        "about": "Real tennis movement for the WebXR tennis game: SMPL-X motion.json clips (AGENTS.md, Dream bundle; "
                 "avatars/README.md, motion.json and skinning) captured with GVHMR (the copy bundled in 4DAnyone) "
                 "from freely licensed Pexels videos, cleaned by apps/webxr/scripts/tennis_motion/build.py.",
        "fps": ml.FPS,
        "coordinates": "Metres, +Y up, soles on y = 0, right-handed player, the opponent toward -Z. Clips start "
                       "facing -Z with the pelvis over x = z = 0 (loops: centred over the cycle), except: serve is "
                       "turned so the racket head travels toward -Z at contact (it starts side-on, left shoulder "
                       "to the net, about 45 degrees), and celebrate faces -Z during its V.",
        "body": {"betas": [0.0] * 10, "model": "SMPL-X neutral",
                 "restPelvis": _r4(rest[0]), "legLength": round(leg_length(rest), 4),
                 "skeleton": "dreams/test-avatar/avatar/skeleton.json (the same neutral rest joints)",
                 "retarget": "Joint rotations play on any SMPL-X avatar as they are. For an avatar whose rest skeleton "
                             "has pelvis J0' and leg length L' (avatars/lucid_avatars/retarget.py leg_length): "
                             "s = L' / legLength; root_t' = s * (root_t + restPelvis) - J0'; scale rootVelocity "
                             "and contact positions by s too."},
        "frames": "frames[i] = {root_t, root_q [x,y,z,w], pose: 55 x axis-angle}, applied exactly as SMPL-X applies "
                  "transl, global_orient and the joint rotations; pose[0] is zero. Right hand holds a racket grip "
                  "(hand_poses fist at 0.9), left hand relaxed.",
        "events": "Frame numbers (0-based, at fps). contact: racket meets ball. serve: tossRelease (ball leaves the "
                  "left hand), tossPeak (ball at its highest), contact.",
        "contactPose": "For strokes (contactFrame = events.contact), the racket hand at the contact frame in the clip's space: rightWrist (the joint), "
                   "rightWristQuat (its world rotation, [x,y,z,w]), velocities in m/s, and an estimated racket: "
                   "racketHead = grip + 0.50 m along racketDir, with racketDir fixed in the hand at 45 degrees between "
                   "the fingers and the thumb (a shake-hands grip; GVHMR tracks neither fingers nor the racket, so "
                   "treat it as a starting point and line the ball up with racketHead).",
        "loops": "loop: true clips end one frame before they repeat (frame N-1 flows into frame 0). Travel loops "
                 "(run, shuffles) are in place: root_t x/z are 0 and rootVelocity[i] = [vx, vz] m/s is the per-frame "
                 "horizontal velocity of the footage (mean + surge); position += rootVelocity[i] * scale * dt. "
                 "meanVelocity is its average and speed its length (m/s).",
        "clips": clips,
    }
    (OUT / "index.json").write_text(json.dumps(index, indent=1) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--npz", required=True, type=Path)
    ap.add_argument("--only", default="")
    ap.add_argument("--check", type=Path, default=None)
    args = ap.parse_args()
    rest = ml.neutral_rest()
    soles = ml.SolePoints()
    only = set(filter(None, args.only.split(",")))
    OUT.mkdir(parents=True, exist_ok=True)
    built = {}
    for name, c in CLIPS.items():
        if only and name not in only:
            continue
        clip, stats = build_stroke(name, c, args.npz, rest, soles)
        built[name] = clip
        print(f"[{name}] {stats['frames']} frames, peak right wrist {stats['peakRightWristSpeed']} m/s, events "
              f"{clip.get('events')}")
        print(stats["footLock"])
    for name, c in LOOPS.items():
        if only and name not in only:
            continue
        clip, stats = build_loop(name, c, args.npz, rest, soles)
        built[name] = clip
        print(f"[{name}] loop {stats['frames']} frames, cycle {stats['cycle']}, mean velocity {stats['meanVelocity']}")
        print(stats["footLock"])
    if "shuffleLeft" in built:  # the mirror image moves right; the grip goes back on the right hand
        built["shuffleRight"] = mirror_clip(built["shuffleLeft"], "shuffleRight")
    for name, clip in built.items():
        (OUT / f"{name}.json").write_text(json.dumps(clip, separators=(",", ":")))
    write_index(rest)
    if args.check:
        import render
        args.check.mkdir(parents=True, exist_ok=True)
        for name, clip in built.items():
            render.stick_strip(clip, rest, args.check / f"{name}_strip.png", every=3, title=name)
    return built


if __name__ == "__main__":
    main()
