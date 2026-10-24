"""What the head swap's expressions need from FLAME 2023 (LAM's own copy), in one small npz: the template, the faces
and the 100 expression directions. FLAME's pickle holds chumpy arrays, so this runs in LAM's env (it has chumpy):

  PYTHONPATH=avatars $L/envs/lam/bin/python avatars/flame_expr_npz.py flame2023.pkl FLAME_masks.pkl flame2023_expr.npz

hpg/head-swap.sbatch runs it once. It also checks face_expr's eye constants against FLAME itself (the eyeball ids
against FLAME_masks.pkl, each eyelid list beside its eyeball, an opening round each eye with an upper and a lower
lid), and fits the blink on FLAME's own template and prints how far it shuts, so a wrong id or a blink that doesn't
shut stops here, not on someone's face. The npz stays
on HiPerGator: FLAME's licence doesn't let us publish it.
"""

from __future__ import annotations

import pickle
import sys

import numpy as np

from lucid_avatars.face_expr import EYES, FLAME_VERTS, _eye, blink_field

N_SHAPE = 300  # FLAME's shapedirs: 300 shape components, then the expressions (LAM slices them the same way)
LID_NEAR_EYE = 2.0  # eyeball radii: every eyelid vertex sits this close to its own eye's centre
MAX_OPEN = 0.2  # a blink that leaves the template's eyes more open than this isn't shipped


def arr(x) -> np.ndarray:
    return np.asarray(getattr(x, "r", x))  # chumpy arrays hold their values in .r


def extract(model: dict, masks: dict) -> dict[str, np.ndarray]:
    v = arr(model["v_template"]).astype(np.float64)
    faces = arr(model["f"]).astype(np.int64)
    sd = arr(model["shapedirs"])
    if v.shape != (FLAME_VERTS, 3) or sd.shape[:2] != (FLAME_VERTS, 3) or sd.shape[2] < N_SHAPE + 10:
        raise ValueError(f"not FLAME: v_template {v.shape}, shapedirs {sd.shape}")
    for (eyeball, lid), side in zip(EYES, ("left", "right")):
        mask = np.sort(arr(masks[f"{side}_eyeball"]).astype(np.int64))
        if not np.array_equal(mask, eyeball):
            raise ValueError(f"FLAME_masks {side}_eyeball isn't vertices {eyeball[0]}..{eyeball[-1]}: face_expr's "
                             "eyeball ids are wrong")
        c = v[eyeball].mean(0)
        r = np.linalg.norm(v[eyeball] - c, axis=1).mean()
        far = np.linalg.norm(v[lid] - c, axis=1).max() / r
        if far > LID_NEAR_EYE:
            raise ValueError(f"face_expr's {side} eyelid reaches {far:.1f} eyeball radii from the {side} eye: wrong ids")
        _, _, up, lo, _ = _eye(v, eyeball, lid)  # an upper and a lower lid to shut, or ValueError
        print(f"[expr] {side} eye: eyeball radius {r * 1000:.1f} mm, lid list {len(lid)}, upper lid {len(up)}, "
              f"lower lid {len(lo)} vertices")
    expr = sd[:, :, N_SHAPE:N_SHAPE + 100].astype(np.float32)
    _, report = blink_field(v, expr)  # the blink on FLAME's own template: it must shut before any head gets it
    print(f"[expr] blink on FLAME's template: {report}")
    if report["openFraction"] > MAX_OPEN:
        raise ValueError(f"the blink leaves FLAME's eyes {report['openFraction']:.0%} open (> {MAX_OPEN:.0%})")
    return {"v_template": v, "faces": faces, "expr_dirs": expr}


def main() -> int:
    pkl, masks_pkl, out = sys.argv[1:4]
    with open(pkl, "rb") as f:
        model = pickle.load(f, encoding="latin1")
    with open(masks_pkl, "rb") as f:
        masks = pickle.load(f, encoding="latin1")
    z = extract(model, masks)
    np.savez(out, **z)
    print(f"[expr] FLAME extract: {len(z['faces'])} faces, {z['expr_dirs'].shape[2]} expressions -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
