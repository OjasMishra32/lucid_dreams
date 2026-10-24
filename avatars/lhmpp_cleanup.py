"""Clean an LHM++ avatar bundle for close-up viewing: hands that don't streak, clothes without garbled specks, calmer
hair. Writes the bundle in place (keeps avatar/avatar.raw.ply, avatar/skin.raw.bin the first time).

    python avatars/lhmpp_cleanup.py <bundle dir> --smplx <SMPLX_NEUTRAL.npz>

1. Hands (wrist and finger joints): LHM++ sees hands in few photos, so a handful of big Gaussians cover each one;
   when the fingers curl round a piece they stretch into streaks. Their size is capped (6 mm, axis ratio 3) and each
   one is re-skinned from its nearest SMPL-X vertex (finger-accurate) instead of LHM++'s coarse skinning grid.
2. Clothes (everything but head and hands): a Gaussian whose colour is far from its 24 nearest neighbours' median
   (a garbled logo, a stray speck) takes that median.
3. Hair (head joint, above the eyes): colour blended halfway to its neighbours' median, so it reads as hair, not
   blotches.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
from dataclasses import replace
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from lucid_avatars.gaussian_ply import SH_C0, read_ply, write_ply
from lucid_avatars.head_swap import _smplx_rest, nearest_vertex_skin
from lucid_avatars.motion import Motion
from lucid_avatars.skinning import read_skin_bin, write_skin_bin
from lucid_avatars.smplx_layout import J

HANDS = [J["left_wrist"], J["right_wrist"]] + list(range(25, 55))
HEAD = [J["head"], J["jaw"], J["left_eye"], J["right_eye"]]


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("bundle", type=Path)
    p.add_argument("--smplx", type=Path, required=True)
    p.add_argument("--hand-max-m", type=float, default=0.006)
    p.add_argument("--hand-ratio", type=float, default=3.0)
    p.add_argument("--speck", type=float, default=0.22, help="colour distance from the neighbours' median that counts")
    a = p.parse_args(argv)

    root = a.bundle
    dream = json.loads((root / "dream.json").read_text())
    av = dream["avatar"]
    ply, skin = root / av["file"], root / av["skin"]
    raw_ply, raw_skin = ply.with_name("avatar.raw.ply"), skin.with_name("skin.raw.bin")
    if not raw_ply.exists():
        shutil.copy(ply, raw_ply)
        shutil.copy(skin, raw_skin)
    g = read_ply(raw_ply)
    idx, q = read_skin_bin(raw_skin)
    dom = idx[np.arange(len(idx)), np.argmax(q, 1)].astype(int)
    hands, head = np.isin(dom, HANDS), np.isin(dom, HEAD)
    rgb = np.clip(g.f_dc * SH_C0 + 0.5, 0, 1)
    tree = cKDTree(g.xyz)

    # 1. hands: capped, finger-accurate skin
    scale = g.scale.copy()
    s = scale[hands]
    s = np.minimum(s, math.log(a.hand_max_m))
    s = np.minimum(s, s.min(1, keepdims=True) + math.log(a.hand_ratio))
    scale[hands] = s
    joints, verts, lbs = _smplx_rest(a.smplx, Motion.load(root / av["motion"]).betas)
    h_idx, h_q = nearest_vertex_skin(g.xyz[hands], verts, lbs)
    idx, q = idx.copy(), q.copy()
    idx[hands], q[hands] = h_idx, h_q

    # 2. clothes: specks take their neighbours' median colour
    _, nn = tree.query(g.xyz, k=25)
    med = np.median(rgb[nn[:, 1:]], axis=1)
    far = np.linalg.norm(rgb - med, axis=1) > a.speck
    specks = far & ~hands & ~head
    out = rgb.copy()
    out[specks] = med[specks]

    # 3. hair: halfway to the neighbours
    eyes_y = (joints[J["left_eye"], 1] + joints[J["right_eye"], 1]) / 2
    hair = head & (g.xyz[:, 1] > eyes_y + 0.01)
    out[hair] = 0.5 * out[hair] + 0.5 * med[hair]

    write_ply(ply, replace(g, f_dc=(np.clip(out, 0, 1) - 0.5) / SH_C0, scale=scale))
    write_skin_bin(skin, idx, q)
    report = {"hands": int(hands.sum()), "specks": int(specks.sum()), "hair": int(hair.sum()), "of": len(g)}
    (root / "cleanup.json").write_text(json.dumps(report, indent=2) + "\n")
    print("[cleanup]", report)


if __name__ == "__main__":
    main()
