#!/usr/bin/env python3
"""A distilled face on the back of the head the photos really saw: one bundle from two of the same person.

    python head_merge.py --face <dreams/x-head-2> --back <dreams/x-lhm> --out <dreams/new-id> [--cut -0.02]

A head distill (head_distill.py) fits fresh Gaussians to UIKA's renders of a head, and UIKA is only sure of what its
photos showed: a face from the front and the sides. When the body's own photos went all the way round (LHM++ from a
turn-around video), the back of its head is the real one. This keeps the distilled head in front of a vertical plane
`--cut` metres from the head joint along the face's direction (negative: behind it, past the ears) and puts the
LHM++ Gaussians the distill dropped (above its seam) back behind that plane. The head stays one contiguous range at the
end of avatar.ply (body, then the back of the head, then the face), so expr.bin (blinks: `first`, `count`, the
offsets) and reality.ply follow it exactly; skin.bin is carried from each source. Both bundles must be the same person
on the same rig (the face's was distilled from the back's). Writes avatar/, dream.json and merge.json; render its
preview with avatar_preview.py.
"""

from __future__ import annotations

import argparse
import json
import shutil
import struct
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from lucid_avatars.gaussian_ply import Gaussians, read_ply, write_ply  # noqa: E402
from lucid_avatars.skinning import read_skin_bin, write_skin_bin  # noqa: E402

HEAD, JAW, L_EYE, R_EYE = 15, 22, 23, 24


def take(g: Gaussians, i: np.ndarray) -> Gaussians:
    return Gaussians(g.xyz[i], g.f_dc[i], g.f_rest[i], g.opacity[i], g.scale[i], g.rotation[i])


def cat(*gs: Gaussians) -> Gaussians:
    return Gaussians(*(np.concatenate([getattr(g, k) for g in gs]) for k in ("xyz", "f_dc", "f_rest", "opacity", "scale", "rotation")))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--face", type=Path, required=True, help="the head-distilled bundle (its face is kept)")
    p.add_argument("--back", type=Path, required=True, help="the bundle it was distilled from (the back of its head)")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--cut", type=float, default=-0.02, help="metres from the head joint along the face's direction")
    p.add_argument("--name", default=None)
    a = p.parse_args()

    fd = json.loads((a.face / "dream.json").read_text())
    bd = json.loads((a.back / "dream.json").read_text())
    fa, ba = fd["avatar"], bd["avatar"]
    rest = np.asarray(json.loads((a.face / fa["skeleton"]).read_text())["rest"])
    rest_b = np.asarray(json.loads((a.back / ba["skeleton"]).read_text())["rest"])
    if rest.shape != rest_b.shape or np.abs(rest - rest_b).max() > 1e-4:
        sys.exit("the two bundles are on different rigs: not the same person's avatar")
    report = json.loads((a.face / "head_distill.json").read_text()) if (a.face / "head_distill.json").exists() else {}
    seam_y = float(report.get("seamY", rest[HEAD][1] - 0.03))

    F = read_ply(a.face / fa["file"])
    B = read_ply(a.back / ba["file"])
    f_idx, f_q = read_skin_bin(a.face / fa["skin"])
    b_idx, b_q = read_skin_bin(a.back / ba["skin"])
    raw = (a.face / fa["expr"]).read_bytes()
    first, count = struct.unpack("<II", raw[:8])
    expr = np.frombuffer(raw[8:], dtype="<f2").reshape(count, 10, 3)
    if first + count != len(F):
        sys.exit(f"expr.bin covers {first}..{first + count}, avatar.ply has {len(F)}: the head isn't the last range")
    R = read_ply(a.face / fa["reality"]) if fa.get("reality") else None

    # the face's direction in the rig's rest pose: from the head joint to between the eyes
    fwd = (rest[L_EYE] + rest[R_EYE]) / 2 - rest[HEAD]
    fwd[1] = 0
    fwd /= np.linalg.norm(fwd)
    depth = lambda xyz: (xyz - rest[HEAD]) @ fwd  # noqa: E731

    head = np.arange(first, len(F))
    keep_face = head[depth(F.xyz[head]) >= a.cut]
    # the back's head: what the distill dropped (above its seam, on the head's joints), behind the plane
    head_joints = np.isin(b_idx[:, 0], [HEAD, JAW, L_EYE, R_EYE, 12])
    back = np.flatnonzero((B.xyz[:, 1] > seam_y) & head_joints & (depth(B.xyz) < a.cut))
    body = np.arange(first)

    G = cat(take(F, body), take(B, back), take(F, keep_face))
    idx = np.concatenate([f_idx[body], b_idx[back], f_idx[keep_face]])
    q = np.concatenate([f_q[body], b_q[back], f_q[keep_face]])
    new_first = len(body) + len(back)
    new_expr = expr[keep_face - first]

    out = a.out
    if out.exists():
        shutil.rmtree(out)
    (out / "avatar").mkdir(parents=True)
    write_ply(out / "avatar/avatar.ply", G)
    write_skin_bin(out / "avatar/skin.bin", idx, q)
    (out / "avatar/expr.bin").write_bytes(struct.pack("<II", new_first, len(keep_face)) + new_expr.astype("<f2").tobytes())
    if R is not None:
        write_ply(out / "avatar/reality.ply", cat(take(R, body), take(B, back), take(R, keep_face)))  # the photos saw the back
    for f in ("skeleton", "motion"):
        shutil.copy2(a.face / fa[f], out / "avatar" / Path(fa[f]).name)
    dream = dict(fd)
    dream["id"] = out.name
    if a.name:
        dream["name"] = a.name
    dream["avatar"] = {k: (f"avatar/{Path(v).name}" if k in ("file", "skin", "skeleton", "motion", "reality", "expr") and v else v) for k, v in fa.items()}
    for f in ("preview", "thumb"):
        if fd.get(f) and (a.face / fd[f]).exists():
            shutil.copy2(a.face / fd[f], out / fd[f])
    (out / "dream.json").write_text(json.dumps(dream, indent=2) + "\n")
    merge = {"face": a.face.name, "back": a.back.name, "cutM": a.cut, "seamY": seam_y, "body": int(len(body)),
             "backOfHead": int(len(back)), "face_kept": int(len(keep_face)), "face_dropped": int(len(head) - len(keep_face)),
             "first": int(new_first), "gaussians": int(len(G))}
    (out / "merge.json").write_text(json.dumps(merge, indent=1) + "\n")
    print("MERGE_OK", json.dumps(merge))


if __name__ == "__main__":
    main()
