"""Clean an LHM++ avatar bundle for close-up viewing: hands that don't streak, clothes without garbled specks, calmer
hair. Writes the bundle in place (keeps avatar/avatar.raw.ply, avatar/skin.raw.bin the first time).

    python avatars/lhmpp_cleanup.py <bundle dir> --smplx <SMPLX_NEUTRAL.npz>

1. Hands (wrist and finger joints): LHM++ sees hands in few photos, so a handful of big Gaussians cover each one;
   when the fingers curl round a piece they stretch into streaks. Their size is capped (6 mm, axis ratio 3) and each
   one is re-skinned from its nearest SMPL-X vertex (finger-accurate) instead of LHM++'s coarse skinning grid.
   The hip crease (Gaussians shared by the torso and a thigh) follows one joint and can't be a needle, so a seated
   avatar's jacket hem doesn't streak over the lap.
2. Clothes (everything but head and hands): a Gaussian whose colour is far from its 24 nearest neighbours' median
   (a garbled logo, a stray speck) takes that median.
   Trousers are one cloth too: a light blob on a thigh or hip side (a newspaper or a hand in one of the photos) takes
   the cloth colour; the shirt down the middle stays.
3. Hair (head joint, above the eyes): colour blended halfway to its neighbours' median, so it reads as hair, not
   blotches.
4. --mute F (for avatars colourised from black and white photos): the torso's clothes keep their brightness but only F
   of their guessed colour, so a tie the photos showed only in grey doesn't come out loud.
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
    p.add_argument("--mute", type=float, default=1.0, help="share of guessed colour the torso's clothes keep (1 = all)")
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

    # 1b. the hip crease: Gaussians shared between the torso and a thigh stretch into streaks when he sits (90 degrees
    # of hip flexion pulls them both ways). Each one follows only its strongest joint, and can't be a needle.
    HIPS = [J["pelvis"], J["left_hip"], J["right_hip"], J["spine1"]]
    w = q.astype(np.float32) / 255.0
    top = w.max(1)
    shared = np.isin(idx, HIPS).sum(1) >= 2
    crease = shared & (top < 0.85) & ~hands
    one = np.zeros_like(q)
    one[:, 0] = 255
    best = idx[np.arange(len(idx)), np.argmax(q, 1)]
    idx[crease] = np.stack([best[crease]] + [best[crease]] * 3, 1)
    q[crease] = one[crease]
    sc = scale[crease]
    scale[crease] = np.minimum(sc, sc.min(1, keepdims=True) + math.log(2.5))

    # 2. clothes: specks take their neighbours' median colour
    _, nn = tree.query(g.xyz, k=25)
    med = np.median(rgb[nn[:, 1:]], axis=1)
    far = np.linalg.norm(rgb - med, axis=1) > a.speck
    specks = far & ~hands & ~head
    out = rgb.copy()
    out[specks] = med[specks]

    # 2b. sleeves: a jacket arm is one cloth; light clusters on it are garbled logos (bigger than a speck)
    ARMS = [J["left_collar"], J["right_collar"], J["left_shoulder"], J["right_shoulder"], J["left_elbow"], J["right_elbow"]]
    arms = np.isin(dom, ARMS)
    if arms.sum() > 64:
        lum = out @ np.array([0.299, 0.587, 0.114])
        cloth = np.median(out[arms & (lum < np.percentile(lum[arms], 60))], axis=0)
        logo = arms & (lum > np.percentile(lum[arms], 60) + 0.12)
        out[logo] = cloth * (0.9 + 0.2 * np.clip(lum[logo, None], 0, 1))
    else:
        logo = arms & False

    # 2c. trousers: a light blob on a thigh or the side of the hips takes the cloth colour (the shirt runs down the middle)
    LEGS = [J["left_hip"], J["right_hip"], J["left_knee"], J["right_knee"]]
    legs = (np.isin(dom, LEGS) | ((dom == J["pelvis"]) & (np.abs(g.xyz[:, 0]) > 0.07))) & ~hands
    blob = legs & False
    if legs.sum() > 64:
        lum = out @ np.array([0.299, 0.587, 0.114])
        mid = np.median(lum[legs])
        blob = legs & (lum > mid + 0.25)
        trousers = np.median(out[legs & (lum <= mid)], axis=0)
        out[blob] = trousers * (0.9 + 0.2 * np.clip(lum[blob, None] - mid, 0, 1))

    # 3. hair: halfway to the neighbours
    eyes_y = (joints[J["left_eye"], 1] + joints[J["right_eye"], 1]) / 2
    hair = head & (g.xyz[:, 1] > eyes_y + 0.01)
    out[hair] = 0.5 * out[hair] + 0.5 * med[hair]

    # 4. guessed colour on the torso's clothes, muted (skin is on the head, neck and hands, which keep theirs)
    torso = np.isin(dom, [J["pelvis"], J["spine1"], J["spine2"], J["spine3"]]) & ~hands
    grey = (out[torso] @ np.array([0.299, 0.587, 0.114]))[:, None]
    out[torso] = grey + a.mute * (out[torso] - grey)

    write_ply(ply, replace(g, f_dc=(np.clip(out, 0, 1) - 0.5) / SH_C0, scale=scale))
    write_skin_bin(skin, idx, q)
    report = {"hands": int(hands.sum()), "crease": int(crease.sum()), "specks": int(specks.sum()), "sleeveLogos": int(logo.sum()),
              "trouserBlobs": int(blob.sum()), "hair": int(hair.sum()), "mute": a.mute, "of": len(g)}
    (root / "cleanup.json").write_text(json.dumps(report, indent=2) + "\n")
    print("[cleanup]", report)


if __name__ == "__main__":
    main()
