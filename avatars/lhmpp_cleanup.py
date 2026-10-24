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
5. --deflate F: LHM++ wraps an average body in a clothing layer 2-6 cm thick, so people come out puffy (bell-shaped
   hips, a belly from the side). Each Gaussian (not head, not hands) keeps its first centimetre off the SMPL-X body
   and only F of the rest, measured in the rest pose, where arms and torso are apart.
6. --flatten F: clothes and skin are thin surfaces, but LHM++ fills them with round blobs, so from the side every
   edge is smoke. Each Gaussian (not hands, not hair) keeps only F of its thickness across the local surface (the
   normal of its 16 nearest neighbours): from the front nothing changes, from the side the silhouette is crisp.
7. --smooth-cloth N: LHM++'s cloth is mottled (a suit reads as light and dark patches, jeans as smears). N passes of
   a bilateral colour filter over each cloth Gaussian's 16 nearest cloth neighbours (2 cm in space, 0.08 in colour):
   one fabric with soft shading, while strong edges (lapels, the collar, shirt and tie) stay. --even-cloth F evens
   the large-scale brightness of each part's main fabric (the jacket, the trousers) by F; --legs-lum L darkens the
   trousers to luminance L (dark trousers where LHM++ guessed light, mottled jeans).
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
from scipy.spatial.transform import Rotation

from lucid_avatars.gaussian_ply import SH_C0, read_ply, write_ply
from lucid_avatars.head_swap import _smplx_rest, nearest_vertex_skin
from lucid_avatars.motion import Motion
from lucid_avatars.skinning import read_skin_bin, write_skin_bin
from lucid_avatars.smplx_layout import J

HANDS = [J["left_wrist"], J["right_wrist"]] + list(range(25, 55))
HEAD = [J["head"], J["jaw"], J["left_eye"], J["right_eye"]]
LUM = np.array([0.299, 0.587, 0.114])
JACKET = [J[k] for k in ("spine1", "spine2", "spine3", "left_collar", "right_collar", "left_shoulder", "right_shoulder",
                         "left_elbow", "right_elbow")]
TROUSERS = [J[k] for k in ("pelvis", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle")]


def bilateral_colours(xyz: np.ndarray, rgb: np.ndarray, passes: int, sigma_m: float = 0.02, sigma_c: float = 0.08,
                      k: int = 16) -> np.ndarray:
    """rgb (n, 3) after `passes` of an edge-preserving filter: each point's colour becomes the average of itself and
    its k nearest neighbours (positions xyz), weighted by closeness in space (sigma_m) and in colour (sigma_c), so
    noise within one fabric evens out while an edge between two colours (a lapel, a collar, a tie) stays."""
    if passes <= 0 or len(xyz) <= k:
        return rgb
    d, nb = cKDTree(xyz).query(xyz, k=k + 1)  # the point itself first
    ws = np.exp(-(d**2) / (2 * sigma_m**2))
    c = np.asarray(rgb, dtype=np.float64).copy()
    for _ in range(passes):
        w = ws * np.exp(-((c[nb] - c[:, None]) ** 2).sum(-1) / (2 * sigma_c**2))
        c = (w[..., None] * c[nb]).sum(1) / w.sum(1, keepdims=True)
    return c


def even_brightness(xyz: np.ndarray, rgb: np.ndarray, part: np.ndarray, f: float, k: int = 64,
                    main: float = 0.15) -> tuple[np.ndarray, int]:
    """rgb with the large-scale brightness of the part's main fabric (colours within `main` of the part's median)
    pulled by f toward the part's median brightness: a jacket without light and dark patches. Other colours on the
    part (a shirt, a tie, a pocket square) stay."""
    ids = np.flatnonzero(part)
    if f <= 0 or len(ids) <= k:
        return rgb, 0
    fab = ids[np.linalg.norm(rgb[ids] - np.median(rgb[ids], axis=0), axis=1) < main]
    if len(fab) <= k:
        return rgb, 0
    lum = rgb[fab] @ LUM
    local = lum[cKDTree(xyz[fab]).query(xyz[fab], k=k)[1]].mean(1)
    gain = 1 + f * (np.median(lum) / np.maximum(local, 1e-3) - 1)
    out = rgb.copy()
    out[fab] = np.clip(rgb[fab] * gain[:, None], 0, 1)
    return out, len(fab)


def main(argv=None) -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("bundle", type=Path)
    p.add_argument("--smplx", type=Path, required=True)
    p.add_argument("--hand-max-m", type=float, default=0.006)
    p.add_argument("--hand-ratio", type=float, default=3.0)
    p.add_argument("--speck", type=float, default=0.22, help="colour distance from the neighbours' median that counts")
    p.add_argument("--mute", type=float, default=1.0, help="share of guessed colour the torso's clothes keep (1 = all)")
    p.add_argument("--deflate", type=float, default=1.0, help="share of clothing thickness beyond 1 cm each Gaussian keeps (1 = all)")
    p.add_argument("--deflate-legs", type=float, default=None, help="the same for the legs (default: --deflate); a jacket hem skinned to the hips sits there")
    p.add_argument("--body-only", action="store_true", help="leave the head as it is (a sharp head from a head model: UIKA, LAM)")
    p.add_argument("--flatten", type=float, default=1.0, help="share of thickness across the surface each Gaussian keeps (1 = all)")
    p.add_argument("--smooth-cloth", type=int, default=0, help="passes of the edge-preserving cloth filter (0 = off)")
    p.add_argument("--cloth-sigma-m", type=float, default=0.02, help="its reach in space (m)")
    p.add_argument("--cloth-sigma-c", type=float, default=0.08, help="its reach in colour (0-1 RGB)")
    p.add_argument("--even-cloth", type=float, default=0.0, help="share of the jacket's and trousers' large-scale brightness patches evened out")
    p.add_argument("--legs-lum", type=float, default=None, help="the trousers' luminance (dark trousers for light, mottled jeans)")
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

    # 2b'. the back of a jacket is one cloth too: light smears below the collar on the back (the rest pose faces +Z)
    # take the jacket's colour; the shirt collar itself, at the neck, stays
    TORSO_J = [J["spine1"], J["spine2"], J["spine3"], J["left_collar"], J["right_collar"]]
    back = np.isin(dom, TORSO_J) & (g.xyz[:, 2] < joints[J["spine3"], 2] - 0.02) & (g.xyz[:, 1] < joints[J["neck"], 1] - 0.05) & ~hands
    smear = back & False
    if back.sum() > 64:
        lum = out @ np.array([0.299, 0.587, 0.114])
        dark = back & (lum < np.percentile(lum[back], 50))
        smear = back & (lum > np.percentile(lum[back], 50) + 0.15)
        out[smear] = np.median(out[dark], axis=0)

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

    # 2d. --legs-lum: the trousers become one dark cloth (their median colour, a quarter of its hue kept, at luminance
    # L) with 30% of their own shading; a light shirt tail over the belt, in the front middle, stays
    trousers = np.isin(dom, TROUSERS) & ~hands
    toned = trousers & False
    if a.legs_lum is not None and trousers.sum() > 64:
        lum = out @ LUM
        pelvis = joints[J["pelvis"]]
        tail = (lum >= 0.55) & (np.abs(g.xyz[:, 0] - pelvis[0]) < 0.08) & (g.xyz[:, 2] > pelvis[2])  # the front middle
        toned = trousers & ~tail
        base = np.median(out[toned], axis=0)
        tone = float(base @ LUM) + 0.25 * (base - float(base @ LUM))
        tone = tone * (a.legs_lum / max(float(tone @ LUM), 1e-3))
        shade = np.clip(1 + 0.3 * (lum[toned] / max(float(np.median(lum[toned])), 1e-3) - 1), 0.6, 1.4)
        out[toned] = np.clip(tone[None] * shade[:, None], 0, 1)

    # 2e. one fabric: the jacket's and trousers' large-scale light and dark patches evened, then the edge-preserving
    # filter over every cloth Gaussian (not the head, not the hands)
    evened = 0
    for part in (np.isin(dom, JACKET) & ~hands, trousers):
        out, n_even = even_brightness(g.xyz, out, part, a.even_cloth)
        evened += n_even
    cloth = ~hands & ~head
    if a.smooth_cloth > 0 and cloth.sum() > 32:
        out[cloth] = bilateral_colours(g.xyz[cloth], out[cloth], a.smooth_cloth, a.cloth_sigma_m, a.cloth_sigma_c)

    # 3. hair: halfway to the neighbours
    eyes_y = (joints[J["left_eye"], 1] + joints[J["right_eye"], 1]) / 2
    hair = head & (g.xyz[:, 1] > eyes_y + 0.01)
    if a.body_only:
        hair &= False
    out[hair] = 0.5 * out[hair] + 0.5 * med[hair]

    # 4. guessed colour on the torso's clothes, muted (skin is on the head, neck and hands, which keep theirs)
    torso = np.isin(dom, [J["pelvis"], J["spine1"], J["spine2"], J["spine3"]]) & ~hands
    grey = (out[torso] @ np.array([0.299, 0.587, 0.114]))[:, None]
    out[torso] = grey + a.mute * (out[torso] - grey)

    # 5. slimmer: the clothing layer pulled toward the body beyond its first centimetre, each Gaussian toward its own
    # part (a jacket hem toward the hips, never onto the thigh in front of it)
    xyz = g.xyz.copy()
    slim = ~hands & ~head
    if a.deflate < 1 and slim.any():
        TORSO = [J[k] for k in ("pelvis", "spine1", "spine2", "spine3", "neck", "left_collar", "right_collar")]
        ARMS = [J[k] for k in ("left_shoulder", "right_shoulder", "left_elbow", "right_elbow")]
        LEGS = [J[k] for k in ("left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle", "left_foot", "right_foot")]
        vpart = np.argmax(np.asarray(lbs), 1)
        legs_f = a.deflate if a.deflate_legs is None else a.deflate_legs
        for part, f in ((TORSO, a.deflate), (ARMS, a.deflate), (LEGS, legs_f)):
            mine = slim & np.isin(dom, part)
            vs = verts[np.isin(vpart, part)]
            if f >= 1 or not mine.any() or len(vs) < 16:
                continue
            off, near_v = cKDTree(vs).query(xyz[mine])
            keep = np.where(off > 0.01, 0.01 + f * (off - 0.01), off)
            xyz[mine] = vs[near_v] + (xyz[mine] - vs[near_v]) * (keep / np.maximum(off, 1e-9))[:, None]

    # 6. thin surfaces: each Gaussian squashed along its local surface normal (a sticker on the cloth, not a blob)
    rotation = g.rotation.copy()
    flat = ~hands & ~(head if a.body_only else hair)
    if a.flatten < 1 and flat.any():
        _, near = cKDTree(xyz).query(xyz[flat], k=17)
        nb = xyz[near] - xyz[near].mean(1, keepdims=True)
        normal = np.linalg.eigh(np.einsum("nki,nkj->nij", nb, nb))[1][:, :, 0]  # least spread: across the surface
        quat = rotation[flat] / np.linalg.norm(rotation[flat], axis=1, keepdims=True)
        R = Rotation.from_quat(quat[:, [1, 2, 3, 0]]).as_matrix()
        cov = R @ (np.exp(2 * scale[flat])[:, :, None] * np.transpose(R, (0, 2, 1)))
        squash = np.eye(3) - (1 - a.flatten) * normal[:, :, None] * normal[:, None, :]
        var, axes = np.linalg.eigh(squash @ cov @ squash)
        axes[np.linalg.det(axes) < 0, :, 0] *= -1  # a proper rotation
        rotation[flat] = Rotation.from_matrix(axes).as_quat()[:, [3, 0, 1, 2]]
        scale[flat] = 0.5 * np.log(np.maximum(var, 0.0008**2))

    write_ply(ply, replace(g, xyz=xyz, f_dc=(np.clip(out, 0, 1) - 0.5) / SH_C0, scale=scale, rotation=rotation))
    write_skin_bin(skin, idx, q)
    report = {"hands": int(hands.sum()), "crease": int(crease.sum()), "specks": int(specks.sum()), "sleeveLogos": int(logo.sum()),
              "trouserBlobs": int(blob.sum()), "backSmears": int(smear.sum()), "hair": int(hair.sum()), "mute": a.mute,
              "deflated": int(slim.sum()) if a.deflate < 1 else 0, "deflate": a.deflate,
              "flattened": int(flat.sum()) if a.flatten < 1 else 0, "flatten": a.flatten,
              "smoothCloth": a.smooth_cloth, "clothSmoothed": int(cloth.sum()) if a.smooth_cloth > 0 else 0,
              "evenCloth": a.even_cloth, "evened": evened, "legsLum": a.legs_lum, "legsToned": int(toned.sum()),
              "of": len(g)}
    (root / "cleanup.json").write_text(json.dumps(report, indent=2) + "\n")
    print("[cleanup]", report)


if __name__ == "__main__":
    main()
