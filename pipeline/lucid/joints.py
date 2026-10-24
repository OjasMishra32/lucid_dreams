"""joints.json for a replay bundle: the clip's body joints in bundle space, one entry per bundle frame, so a player can
compare your body with theirs (the WebXR viewer's Follow along). Optional in any bundle; dream.json names it as
"joints": "joints.json".

    { "fps": 25, "names": ["pelvis", ...22 SMPL-X body joints], "frames": [[[x, y, z], ...], ...], "source": "gvhmr" }

Bundle space: metres, +Y up, floor at y = 0, the person's front faces -Z; "left"/"right" are the person's own.

The chain is the one the reconstruction already went through: GVHMR's world-frame SMPL-X fit (the run's views/gvhmr)
-> 4DAnyone's world, where the reconstruction lives (avatars/gvhmr_motion.py recomputes motion_world_to_canonical_world
exactly as 4DAnyone does; 4DAnyone doesn't save it) -> the export's placement (dream.json "placement": rot | t).
Joint positions are SMPL-X forward kinematics of the rest joints for the clip's mean betas (lucid_avatars.skinning),
taken from the source frame nearest in time to each bundle frame (as props.json's ball track is).

HiPerGator, per run (CPU is enough):

    source $L/code/pipeline/hpg/env.sh && cd $L/repos/4DAnyone
    python $L/repos/lucid_dreams/avatars/gvhmr_motion.py --device cpu \\
        --gvhmr $RUN/views/gvhmr --out $RUN/views/gvhmr/motion_world.json
    PYTHONPATH=$L/repos/lucid_dreams/pipeline:$L/repos/lucid_dreams/avatars python -m lucid.joints $RUN/bundle \\
        --motion $RUN/views/gvhmr/motion_world.json --write

It checks the joints against the reconstruction before writing (the head joint under the head's Gaussians, the pelvis
in the middle of the hips', planted ankles at ankle height over the feet's lowest Gaussians) and prints the errors;
--write saves joints.json and adds "joints" to dream.json. JOINTS_OK on success, JOINTS_OFF when the check fails.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "avatars"))
from lucid_avatars.motion import Motion  # noqa: E402
from lucid_avatars.skinning import rest_joints, skin_matrices  # noqa: E402
from lucid_avatars.smplx_layout import JOINT_NAMES  # noqa: E402

from .gaussians import read_spz  # noqa: E402

BODY = JOINT_NAMES[:22]
J = {n: i for i, n in enumerate(BODY)}
DEFAULT_MODEL = "third_party/GVHMR/inputs/checkpoints/body_models/smplx/SMPLX_NEUTRAL.npz"


def body_joints(motion: Motion, rest: np.ndarray) -> np.ndarray:
    """(N, 22, 3) posed body joints in the motion's world: M_j applied to rest joint j."""
    out = np.empty((motion.num_frames, len(BODY), 3))
    for i, (t, q, p) in enumerate(zip(motion.root_t, motion.root_q, motion.pose)):
        M = skin_matrices(rest, q, t, p)
        out[i] = (np.einsum("jab,jb->ja", M[:, :3, :3], rest) + M[:, :3, 3])[: len(BODY)]
    return out


def to_bundle(points: np.ndarray, placement: dict) -> np.ndarray:
    rot, t = np.asarray(placement["rot"], dtype=np.float64), np.asarray(placement["t"], dtype=np.float64)
    return points @ rot.T + t


def per_bundle_frame(points: np.ndarray, n_frames: int) -> np.ndarray:
    """The source frame nearest in time to each bundle frame (both span the clip)."""
    src = np.rint(np.arange(n_frames) * (len(points) - 1) / max(n_frames - 1, 1)).astype(int)
    return points[src]


def check(bundle: Path, dream: dict, joints: np.ndarray, every: int = 6, max_points: int = 80000) -> dict:
    """How well the joints sit in the reconstruction, over every `every`th frame (metres; medians and 90th percentiles).

    head_xz:   head joint to the centroid of the Gaussians around and above it, across the floor (frames with both
               hands away from the head)
    head_up:   that centroid's height above the head joint (the SMPL-X head joint is at the skull base: ~0.05-0.10)
    pelvis_xz: pelvis to the centroid of the hips' Gaussians, across the floor
    ankle_up:  a planted ankle's height above the lowest Gaussians under it (the ankle joint: ~0.06-0.09)
    inside:    share of joints with the body's Gaussians all round them (at least 40 within 15 cm)
    """
    fr = dream["frames"]
    pattern = fr.get("spz") or fr.get("pattern")
    rng = np.random.default_rng(0)
    rows: dict[str, list[float]] = {k: [] for k in ("head_xz", "head_up", "pelvis_xz", "ankle_up", "inside")}
    fps = float(dream.get("fps", 25))
    for i in range(0, len(joints), every):
        path = bundle / fr["dir"] / (pattern % i)
        if not path.exists():
            continue
        g = read_spz(path)
        alpha = 1 / (1 + np.exp(-g.opacities))
        pts = g.means[alpha > 0.5].astype(np.float64)
        if len(pts) > max_points:
            pts = pts[rng.choice(len(pts), max_points, replace=False)]
        j = joints[i]
        horiz = lambda c: np.hypot(pts[:, 0] - c[0], pts[:, 2] - c[2])  # noqa: E731
        head, lw, rw = j[J["head"]], j[J["left_wrist"]], j[J["right_wrist"]]
        if min(np.linalg.norm(lw - head), np.linalg.norm(rw - head)) > 0.3:
            sel = (horiz(head) < 0.2) & (pts[:, 1] > head[1] - 0.06) & (pts[:, 1] < head[1] + 0.3)
            if sel.sum() > 200:
                c = pts[sel].mean(axis=0)
                rows["head_xz"].append(float(np.hypot(*(c - head)[[0, 2]])))
                rows["head_up"].append(float(c[1] - head[1]))
        pelvis = j[J["pelvis"]]
        sel = (horiz(pelvis) < 0.22) & (np.abs(pts[:, 1] - pelvis[1]) < 0.06)
        if sel.sum() > 200:
            rows["pelvis_xz"].append(float(np.hypot(*(pts[sel].mean(axis=0) - pelvis)[[0, 2]])))
        for side in ("left_ankle", "right_ankle"):
            a = j[J[side]]
            prev = joints[max(0, i - 1), J[side]]
            planted = np.linalg.norm(a - prev) * fps < 0.25 and a[1] < 0.2
            near = horiz(a) < 0.1
            if planted and near.sum() > 50:
                rows["ankle_up"].append(float(a[1] - np.percentile(pts[near, 1], 1)))
        inside = 0
        for p in j:
            inside += int((np.linalg.norm(pts - p, axis=1) < 0.15).sum() >= 40)
        rows["inside"].append(inside / len(j))
    stat = lambda v: {"median": round(float(np.median(v)), 3), "p90": round(float(np.percentile(v, 90)), 3), "n": len(v)} if v else None  # noqa: E731
    return {k: stat(v) for k, v in rows.items()}


def passes(report: dict) -> bool:
    """Head over the head and pelvis in the hips to within 8 cm, planted ankles at ankle height (within 5 cm of it)."""
    ok = True
    for key, limit in (("head_xz", 0.08), ("pelvis_xz", 0.08)):
        if report[key] and report[key]["median"] > limit:
            ok = False
    if report["ankle_up"] and abs(report["ankle_up"]["median"] - 0.075) > 0.05:
        ok = False
    if report["inside"] and report["inside"]["median"] < 0.8:
        ok = False
    return ok


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("bundle", type=Path, help="the dream bundle (dream.json + frames)")
    p.add_argument("--motion", type=Path, required=True, help="avatars/gvhmr_motion.py's output for this run")
    p.add_argument("--model", type=Path, default=Path(DEFAULT_MODEL), help="SMPLX_NEUTRAL.npz (GVHMR's)")
    p.add_argument("--every", type=int, default=6, help="check every n-th frame against the reconstruction")
    p.add_argument("--write", action="store_true", help="save joints.json and name it in dream.json")
    p.add_argument("--force", action="store_true", help="write even if the check fails")
    a = p.parse_args(argv)

    dream_path = a.bundle / "dream.json"
    dream = json.loads(dream_path.read_text())
    if "placement" not in dream:
        raise SystemExit(f"{dream_path}: no placement (re-export the bundle)")
    motion = Motion.load(a.motion)
    model = np.load(a.model, allow_pickle=True)
    rest, _ = rest_joints(model["v_template"], model["shapedirs"], model["J_regressor"], motion.betas)
    world = body_joints(motion, rest)
    joints = per_bundle_frame(to_bundle(world, dream["placement"]), int(dream["frameCount"]))
    report = check(a.bundle, dream, joints, every=a.every)
    ok = passes(report)
    print(f"[joints] {dream['id']}: {json.dumps(report)}")
    if a.write and (ok or a.force):
        out = {"fps": dream.get("fps", motion.fps), "names": BODY, "frames": np.round(joints, 3).tolist(), "source": "gvhmr"}
        part = a.bundle / "joints.json.part"
        part.write_text(json.dumps(out, separators=(",", ":")))
        part.replace(a.bundle / "joints.json")
        dream["joints"] = "joints.json"
        dream["updatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        tmp = dream_path.with_suffix(".json.part")
        tmp.write_text(json.dumps(dream, indent=2))
        tmp.replace(dream_path)
        print(f"[joints] wrote {a.bundle / 'joints.json'} ({len(joints)} frames)")
    print(("JOINTS_OK " if ok else "JOINTS_OFF ") + dream["id"])
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
