#!/usr/bin/env python3
"""Proportions and posture for an avatar bundle, judged against the person's own footage: a head (with its hair) scaled
about the neck, arms that hang at the sides instead of the fit's A-pose, and a level head.

    python avatar_refine.py <bundle> --out <bundle> [--head 1.10] [--arms 0.17] [--elbow 12] [--pitch -2]

--head  scales every Gaussian by how much it rides on the head (its skin.bin weight on the head, jaw and eyes): a fully
        head Gaussian by the full factor, a neck one by part of it, so there's no seam; the head's joints move with it,
        and so do its blink offsets (expr.bin) and its Reality check twin (reality.ply).
--arms  how far the upper arms hang out from the body's vertical (the sideways part of their direction: about 6 degrees
        at 0.10), a touch forward; the forearms hang on in line (half as far out), the elbows bent forward by --elbow
        degrees, so the hands sit by the thighs. Each correction is worked out on the idle's first frame and applied,
        in the joint's parent frame, to every frame, so the idle's sway is kept.
--pitch where the face points, degrees above level (negative: a little down), set on the first frame by the neck (40%)
        and the head (60%) and applied to every frame the same way.
Writes the bundle (avatar/, dream.json with new bounds, refine.json with what moved). Both the in and out bundle can be
the same folder only via a copy: --out must be a new folder.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import struct
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from lucid_avatars.gaussian_ply import read_ply, write_ply  # noqa: E402
from lucid_avatars.rotations import aa_to_quat, matrix_to_quat, quat_mul, quat_to_aa, quat_to_matrix  # noqa: E402
from lucid_avatars.skinning import read_skin_bin  # noqa: E402
from lucid_avatars.smplx_layout import SMPLX_PARENTS  # noqa: E402

PELVIS, SPINE3, NECK, L_COLLAR, R_COLLAR, HEAD = 0, 9, 12, 13, 14, 15
L_SHOULDER, R_SHOULDER, L_ELBOW, R_ELBOW, JAW, L_EYE, R_EYE = 16, 17, 18, 19, 22, 23, 24
HEAD_JOINTS = (HEAD, JAW, L_EYE, R_EYE)


def rot_x(a: float) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def between(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """The smallest rotation taking direction a to direction b."""
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    v, c = np.cross(a, b), float(a @ b)
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3)
    K = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + K + K @ K * (1 / (1 + c))


def local_mats(frame: dict) -> list[np.ndarray]:
    pose = np.asarray(frame["pose"], dtype=np.float64).reshape(-1, 3)
    L = [quat_to_matrix(aa_to_quat(p)) for p in pose]
    L[0] = quat_to_matrix(quat_mul(np.asarray(frame["root_q"], dtype=np.float64), aa_to_quat(pose[0])))
    return L


def globals_of(L: list[np.ndarray]) -> list[np.ndarray]:
    G: list[np.ndarray] = []
    for j, p in enumerate(SMPLX_PARENTS):
        G.append(L[j] if p < 0 else G[p] @ L[j])
    return G


def set_local(frame: dict, j: int, R: np.ndarray) -> None:
    frame["pose"][j] = quat_to_aa(matrix_to_quat(R)).tolist()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("bundle", type=Path)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--head", type=float, default=1.0)
    p.add_argument("--arms", type=float, default=None)
    p.add_argument("--elbow", type=float, default=12.0)
    p.add_argument("--pitch", type=float, default=None)
    a = p.parse_args()
    if a.out.resolve() == a.bundle.resolve():
        sys.exit("--out must be a new folder (keep the original as it was)")

    dream = json.loads((a.bundle / "dream.json").read_text())
    av = dream["avatar"]
    skel = json.loads((a.bundle / av["skeleton"]).read_text())
    rest = np.asarray(skel["rest"], dtype=np.float64)
    motion = json.loads((a.bundle / av["motion"]).read_text())
    g = read_ply(a.bundle / av["file"])
    idx, q = read_skin_bin(a.bundle / av["skin"])
    report: dict = {"from": a.bundle.name}

    # ---- the head, about the neck, by each Gaussian's own weight on it
    if a.head != 1.0:
        w_head = (np.isin(idx, HEAD_JOINTS) * (q.astype(np.float64) / 255)).sum(1)
        s = 1 + (a.head - 1) * w_head
        neck = rest[NECK]

        def scale(gs):
            gs.xyz = neck + (gs.xyz - neck) * s[:, None]
            gs.scale = gs.scale + np.log(s)[:, None]
            return gs

        g = scale(g)
        for j in HEAD_JOINTS:
            rest[j] = neck + (rest[j] - neck) * a.head
        skel["rest"] = rest.tolist()
        report["head"] = {"factor": a.head, "gaussians": int((w_head > 0.01).sum()), "fully": int((w_head > 0.99).sum())}
        if av.get("expr"):
            raw = (a.bundle / av["expr"]).read_bytes()
            first, count = struct.unpack("<II", raw[:8])
            off = np.frombuffer(raw[8:], dtype="<f2").reshape(count, 10, 3).astype(np.float32)
            off *= s[first:first + count, None, None]
            expr_bytes = struct.pack("<II", first, count) + off.astype("<f2").tobytes()
        reality = scale(read_ply(a.bundle / av["reality"])) if av.get("reality") else None
    else:
        expr_bytes = (a.bundle / av["expr"]).read_bytes() if av.get("expr") else None
        reality = read_ply(a.bundle / av["reality"]) if av.get("reality") else None

    frames = motion["frames"]
    for f in frames:
        f["pose"] = np.asarray(f["pose"], dtype=np.float64).reshape(-1, 3).tolist()

    # ---- the arms hang at the sides, a little forward, elbows a little bent
    if a.arms is not None:
        arms = ((1, L_SHOULDER, L_ELBOW, 20, L_COLLAR), (-1, R_SHOULDER, R_ELBOW, 21, R_COLLAR))

        def angles(G, side, sh, el, wr):
            """Upper arm and forearm, degrees out from the body's vertical (sideways) and forward, in the body's frame."""
            res = {}
            for name, (j, k) in (("upper", (sh, el)), ("fore", (el, wr))):
                d = G[SPINE3].T @ (G[j] @ (rest[k] - rest[j]))
                d /= np.linalg.norm(d)
                res[name] = {"out": round(math.degrees(math.atan2(side * d[0], -d[1])), 1), "forward": round(math.degrees(math.atan2(d[2], -d[1])), 1)}
            return res

        G0 = globals_of(local_mats(frames[0]))
        out = {("left" if s > 0 else "right"): {"before": angles(G0, s, sh, el, wr)} for s, sh, el, wr, _ in arms}
        for side, sh, el, wr, parent in arms:
            # the upper arm: down the body's side, a little out (the body's own left is +x) and a touch forward (+z)
            G = globals_of(local_mats(frames[0]))
            d0 = G[sh] @ (rest[el] - rest[sh])
            Rc = G[parent].T @ between(d0, G[SPINE3] @ np.array([side * a.arms, -1.0, 0.06])) @ G[parent]
            for f in frames:
                set_local(f, sh, Rc @ local_mats(f)[sh])
            # the forearm: on down, nearly in line, the elbow bent a little forward (hands by the thighs, not out)
            G = globals_of(local_mats(frames[0]))
            d1 = G[el] @ (rest[wr] - rest[el])
            Rc2 = G[sh].T @ between(d1, G[SPINE3] @ np.array([side * a.arms * 0.5, -1.0, math.tan(math.radians(a.elbow))])) @ G[sh]
            for f in frames:
                set_local(f, el, Rc2 @ local_mats(f)[el])
        G1 = globals_of(local_mats(frames[0]))
        for s, sh, el, wr, _ in arms:
            out["left" if s > 0 else "right"]["after"] = angles(G1, s, sh, el, wr)
        report["arms"] = {"out": a.arms, "elbowDeg": a.elbow, **out}

    # ---- the head level: where the face points, set on the first frame, kept through the idle
    if a.pitch is not None:
        L0 = local_mats(frames[0])
        G0 = globals_of(L0)
        fwd = G0[HEAD] @ np.array([0.0, 0.0, 1.0])  # SMPL-X's rest face looks along +z
        before = math.degrees(math.asin(np.clip(fwd[1], -1, 1)))
        alpha = math.radians(before - a.pitch)  # a turn about the joints' own x tips the face down by +alpha
        for f in frames:
            L = local_mats(f)
            set_local(f, NECK, L[NECK] @ rot_x(0.4 * alpha))
            set_local(f, HEAD, L[HEAD] @ rot_x(0.6 * alpha))
        G1 = globals_of(local_mats(frames[0]))
        after = math.degrees(math.asin(np.clip((G1[HEAD] @ np.array([0.0, 0.0, 1.0]))[1], -1, 1)))
        report["pitch"] = {"beforeDeg": round(before, 1), "afterDeg": round(after, 1), "target": a.pitch}

    # ---- the bundle
    out = a.out
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(a.bundle, out, ignore=shutil.ignore_patterns("avatar"))
    (out / "avatar").mkdir()
    shutil.copy2(a.bundle / av["skin"], out / av["skin"])
    write_ply(out / av["file"], g)
    if reality is not None:
        write_ply(out / av["reality"], reality)
    if expr_bytes is not None:
        (out / av["expr"]).write_bytes(expr_bytes)
    (out / av["skeleton"]).write_text(json.dumps(skel))
    (out / av["motion"]).write_text(json.dumps(motion))
    # bounds as before: the rest pose's Gaussians, stood on the floor by the motion's root
    lift = float(frames[0]["root_t"][1])
    opaque = g.xyz[1 / (1 + np.exp(-g.opacity.reshape(-1))) > 0.3]
    lo, hi = np.percentile(opaque, 0.05, axis=0), np.percentile(opaque, 99.95, axis=0)
    dream["bounds"] = {"min": [round(float(lo[0]), 3), 0.0, round(float(lo[2]), 3)], "max": [round(float(hi[0]), 3), round(float(hi[1] + lift - (lo[1] + lift)), 3), round(float(hi[2]), 3)]}
    dream["updatedAt"] = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    (out / "dream.json").write_text(json.dumps(dream, indent=2) + "\n")
    (out / "refine.json").write_text(json.dumps(report, indent=1) + "\n")
    print("REFINE_OK", json.dumps(report))


if __name__ == "__main__":
    main()
