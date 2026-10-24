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
   trousers to luminance L (dark trousers where LHM++ guessed light, mottled jeans), and --legs-solid A makes them at
   least A opaque (LHM++ leaves hips half see-through where hands sat in pockets).
8. Solid, crisp clothes: --drop-faint T drops faint large Gaussians on clothes (the smoke round a silhouette and
   under a seated person), --cloth-solid A makes the rest at least A opaque, --fill-cloth F widens each along the
   surface to F times its spacing (no see-through patches, no holes). --reskin-hips: the seat and the backs of the
   thighs follow the thighs (SMPL-X's own weights) instead of hanging from the pelvis when he sits. --feet-lum L: one
   dark leather for the shoes; --cloth-hue F: one colour for each fabric.
9. Streaks and floaters: --light-streaks D gives a Gaussian D lighter than its 16 neighbours their colour,
   --no-needles R caps the longest axis at R times the middle one, --back-smear D sets how much lighter than the
   jacket back's dark half a smear is (0.15 by default), --skin-consistent gives a Gaussian whose joint disagrees with
   70% of its neighbours their weights (no sliver left behind when he moves), --drop-lonely M drops clothes
   Gaussians whose 8 nearest average further than M.
10. --shirt-clean tie|open: the shirt between the lapels one white, grey blotches gone; with tie, the tie one dark
   cloth (widths measured per centimetre of height from the colours). --relight-legs F: the trousers lit by a soft key
   light through SMPL-X's normals, so knees and shins have shape when he sits.
11. --rebuild-hands N: fresh hands, N flat opaque discs per hand on SMPL-X's hand surface, skinned as SMPL-X, shaded
   as a hand (darker between the fingers and in the joint creases, nails, lighter palms, a faint mottle), toned to
   --hand-rgb (the face's skin) when given.
12. --keep-colours: the geometry and solidity passes only; a white kit keeps the photos' colours for
   lhmpp_avatar.py whites.
"""

from __future__ import annotations

import argparse
import json
import math
import re
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


def face_normals_at(verts: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Unit vertex normals of a mesh (area-weighted face normals; SMPL-X's winding points them outward)."""
    tri = verts[faces]
    fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    vn = np.zeros_like(verts)
    for k in range(3):
        np.add.at(vn, faces[:, k], fn)
    return vn / np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)


def disc_quats(normals: np.ndarray) -> np.ndarray:
    """[w, x, y, z] rotations that turn +z onto each unit normal (a flat Gaussian lying on the surface)."""
    n = np.asarray(normals, dtype=np.float64)
    q = np.stack([1 + n[:, 2], -n[:, 1], n[:, 0], np.zeros(len(n))], 1)
    q[n[:, 2] < -0.999] = [0.0, 1.0, 0.0, 0.0]
    return q / np.linalg.norm(q, axis=1, keepdims=True)


def hand_shading(p: np.ndarray, n: np.ndarray, hand_v: np.ndarray, joints: np.ndarray, side: str,
                 seed: int = 0, strength: float = 1.0, mottle_amp: float = 0.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """What makes a hand read as a hand at arm's length, measured in the rest pose (palms down, fingers straight):
    (shade multiplier, nail mask, palm mask) per surface point p with unit normal n. Shade darkens where the hand
    hides from the light (a finger's side next to the next finger, the webbing between them: the share of the hand's
    own vertices within 12 mm above the point's tangent plane), along a thin crease across each finger at every
    joint (knuckles on the back, deeper lines on the palm), and carries a faint 2-5 mm skin mottle. Nails are the
    outer half of each fingertip's back; the palm is everything facing down."""
    m = len(p)
    occ = np.zeros(m)
    for k, nb in enumerate(cKDTree(hand_v).query_ball_point(p, 0.012)):
        if nb:
            occ[k] = np.mean((hand_v[nb] - p[k]) @ n[k] > 0.0015)
    shade = 1 - 0.42 * strength * np.clip(occ / 0.35, 0, 1) ** 1.2

    dorsal, palm_n = n[:, 1], -n[:, 1]  # T-pose, palms down: the back of the hand faces +Y
    crease = np.zeros(m)
    nail = np.zeros(m, dtype=bool)
    wrist = joints[J[f"{side}_wrist"]]
    fingers = ("index", "middle", "pinky", "ring", "thumb")
    chains = []
    for f in fingers:
        c = [wrist] + [joints[J[f"{side}_{f}{k}"]] for k in (1, 2, 3)]
        tip = c[3] - c[2]
        chains.append(c + [c[3] + 0.025 * tip / np.linalg.norm(tip)])

    def seg_dist(a, b):
        ab = b - a
        t = np.clip(((p - a) @ ab) / (ab @ ab), 0, 1)
        return np.linalg.norm(p - (a + t[:, None] * ab), axis=1)

    owner = np.argmin(np.stack([np.min([seg_dist(c[k], c[k + 1]) for k in range(4)], axis=0) for c in chains]), 0)
    for fi, (f, chain) in enumerate(zip(fingers, chains)):
        mine = owner == fi
        for k in (1, 2, 3):  # a crease across the finger at each joint (the knuckle, the two finger joints)
            axis = chain[k] - chain[k - 1]
            axis /= np.linalg.norm(axis)
            along = (p - chain[k]) @ axis
            crease = np.maximum(crease, mine * np.exp(-((along / 0.0011) ** 2)))
        # the nail: past the last joint, the outer part of the fingertip, on its back
        tip_axis = chain[3] - chain[2]
        tip_axis /= np.linalg.norm(tip_axis)
        along = (p - chain[3]) @ tip_axis
        tipm = mine & (along > 0)
        reach = np.percentile(along[tipm], 99) if tipm.sum() > 8 else 0.02
        up = n @ (np.array([0.0, 1.0, 0.0]) if f != "thumb" else np.array([0.0, 0.7, 0.7]) / math.sqrt(0.98))
        nail |= tipm & (along > 0.35 * reach) & (along < 0.97 * reach) & (up > 0.55)
    depth = np.where(dorsal > 0.3, 0.13, np.where(palm_n > 0.3, 0.24, 0.17))
    shade *= 1 - strength * depth * crease

    rng = np.random.default_rng(seed)
    mottle = np.zeros(m)
    for _ in range(8):
        k = rng.normal(size=3)
        k *= 2 * math.pi / (rng.uniform(0.002, 0.005) * np.linalg.norm(k))
        mottle += np.cos(p @ k + rng.uniform(0, 2 * math.pi))
    shade *= 1 + mottle_amp * mottle / math.sqrt(8 / 2)
    return shade, nail, palm_n > 0.35


def hand_gaussians(verts: np.ndarray, faces: np.ndarray, lbs: np.ndarray, joints: np.ndarray, skin_xyz: np.ndarray,
                   skin_rgb: np.ndarray, per_hand: int, seed: int = 0, tone: np.ndarray | None = None,
                   shading: float = 1.0) -> dict:
    """Fresh hands on the SMPL-X hand surface (both, from just behind the wrist to the fingertips): flat opaque
    discs on the skin, coloured from the nearest Gaussians of the person's own skin (skin_xyz/skin_rgb, k = 12),
    moved to `tone` (the face's skin, so hands and face match) when given, then shaded as a hand (hand_shading:
    darker between the fingers and in the joint creases, lighter nails and palm, a faint mottle), skinned exactly as
    SMPL-X (its face's three vertices' weights by barycentric blend). The discs are small (0.7 of their spacing, a
    second layer 1.15 of it 1.2 mm in, so nothing shows through), so neighbouring fingers stay apart.
    Returns xyz, rgb, log scale, rotation, skin idx/q."""
    from lucid_avatars.head_distill_core import face_skin, sample_surface

    dom = np.argmax(lbs, axis=1)
    out = {k: [] for k in ("xyz", "rgb", "scale", "rot", "idx", "q")}
    for side in ("left", "right"):
        wrist, elbow = joints[J[f"{side}_wrist"]], joints[J[f"{side}_elbow"]]
        along = (wrist - elbow) / np.linalg.norm(wrist - elbow)
        mine = [J[f"{side}_wrist"]] + [j for j in range(25, 55) if (j < 40) == (side == "left")]
        ok_v = np.isin(dom, mine) & (((verts - wrist) @ along) > -0.015)
        fids = np.flatnonzero(ok_v[faces].all(axis=1))
        if len(fids) == 0:
            continue
        fid, bary, p, n = sample_surface(verts, faces, fids, per_hand, seed=seed)
        tri = verts[faces[fids]]
        area = 0.5 * np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1).sum()
        spacing = math.sqrt(area / per_hand)
        d, i = cKDTree(skin_xyz).query(p, k=min(24, len(skin_xyz)))
        w = 1 / (d + 0.003)
        rgb = (skin_rgb[i] * w[..., None]).sum(1) / w.sum(1, keepdims=True)
        lum_s = rgb @ LUM
        ratio = lum_s / max(float(np.median(lum_s)), 1e-3)
        if tone is not None:  # one skin tone (e.g. the face's), only the sampled skin's gentle light and shade (8%)
            rgb = np.asarray(tone, dtype=np.float64)[None] * np.clip(ratio, 0.92, 1.08)[:, None]
        else:  # the person's own hand skin, its photo light kept (within 20%), its median hue (no cuff or room in it)
            hue = np.median(rgb / np.maximum(lum_s, 1e-3)[:, None], axis=0)
            rgb = hue[None] * (float(np.median(lum_s)) * np.clip(ratio, 0.8, 1.2))[:, None]
        shade, nail, palm = hand_shading(p, n, verts[ok_v], joints, side, seed=seed, strength=shading)
        lum = (rgb @ LUM)[:, None]
        rgb[palm] = lum[palm] + 0.8 * (rgb[palm] - lum[palm])  # palms: less pigment
        rgb[palm] *= 1.07
        nail_rgb = np.clip(lum[nail] * np.array([1.18, 1.0, 0.97]) + 0.12, 0, 1)  # pale, a little pink
        rgb[nail] = 0.55 * min(shading, 1.0) * nail_rgb + (1 - 0.55 * min(shading, 1.0)) * rgb[nail]
        rgb = rgb * shade[:, None]
        h_idx, h_q = face_skin(fid, bary, faces, lbs)
        for depth, width, dim in ((0.0003, 0.7, 1.0), (-0.0012, 1.15, 0.9)):
            out["xyz"].append(p + depth * n)
            out["rgb"].append(np.clip(rgb * dim, 0, 1))
            out["scale"].append(np.log(np.tile([width * spacing, width * spacing, 0.0003], (len(p), 1))))
            out["rot"].append(disc_quats(n))
            out["idx"].append(h_idx)
            out["q"].append(h_q)
    return {k: np.concatenate(v) for k, v in out.items() if v}


def _edges(x: np.ndarray, b: np.ndarray, evidence: np.ndarray, nb: int, pct: tuple[float, float], least: int,
           extend: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """Per height bin, the left and right edges (percentiles of x) of `evidence`, smoothed over 5 bins, gaps between
    measured bins filled, nothing past them (nan) unless `extend` (then the nearest measured edges carry on)."""
    lo, hi = np.full(nb, np.nan), np.full(nb, np.nan)
    for k in range(nb):
        e = evidence & (b == k)
        if e.sum() >= least:
            lo[k], hi[k] = np.percentile(x[e], pct)
    ok = np.flatnonzero(np.isfinite(lo))
    if len(ok) == 0:
        return lo, hi
    for v in (lo, hi):
        f = np.interp(np.arange(nb), ok, v[ok])
        v[:] = [np.median(f[max(0, k - 2):k + 3]) for k in range(nb)]
        if not extend:
            v[: ok[0]] = np.nan
            v[ok[-1] + 1:] = np.nan
    return lo, hi


def shirt_paint(xyz: np.ndarray, rgb: np.ndarray, cand: np.ndarray, top_y: float, bottom_y: float, mode: str,
                jacket_lum: float, margin: float = 0.008) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The shirt between the lapels as one cloth, in the rest pose (front +Z). Per centimetre of height between top_y
    and bottom_y the shirt's left and right edges are measured from its white among the candidates `cand`, smoothed
    over 5 cm and never extended past the heights that show it. Inside them (less `margin`):
      tie   the tie is the grey band down the middle (between the jacket's darkness and the shirt's white, among
            grey neighbours, its edges measured the same way): it takes the band's median colour with 15% of its own shading (no light flecks);
            everything else takes one clean white (the shirt's brightest third, half way to neutral, as
            lhmpp_avatar.py whites does) under a soft gradient: the shirt's own light and shade blurred over its 32
            nearest (within 12%), a little darker toward the lapels.
      open  anything darker than that white (a muddy streak down an open collar) takes the white, same gradient.
    Returns (rgb, painted shirt ids, tie ids)."""
    out = rgb.copy()
    lum = rgb @ LUM
    sat = rgb.max(1) - rgb.min(1)
    x, y = xyz[:, 0], xyz[:, 1]
    zone = cand & (y <= top_y) & (y >= bottom_y)
    white_e = zone & (lum > 0.5) & (sat < 0.2)
    empty = np.array([], dtype=np.int64)
    if white_e.sum() < 50:
        return out, empty, empty
    nb = int(np.ceil((top_y - bottom_y) / 0.01))
    b = np.clip(((top_y - y) / 0.01).astype(int), 0, nb - 1)
    lo, hi = _edges(x, b, white_e, nb, (3, 97), 6)
    l_b, h_b = lo[b], hi[b]
    inside = zone & np.isfinite(l_b) & (x > l_b + margin) & (x < h_b - margin)
    light = inside & (lum > 0.5) & (sat < 0.2)
    if light.sum() < 20:
        return out, empty, empty
    bright = light & (lum >= np.percentile(lum[light], 67))
    white = np.median(rgb[bright], axis=0)
    white = 0.5 * white + 0.5 * white.mean()
    ids = np.flatnonzero(inside)
    nn = cKDTree(xyz[ids]).query(xyz[ids], k=min(33, len(ids)))[1]
    soft = np.clip(np.median(lum[ids][nn], axis=1) / max(float(np.median(lum[light])), 1e-3), 0.88, 1.0)
    edge = np.minimum(x[ids] - l_b[ids], h_b[ids] - x[ids]) / np.maximum((h_b[ids] - l_b[ids]) / 2, 1e-3)
    shade = soft * (0.94 + 0.06 * np.clip(2 * edge, 0, 1))
    tie = np.zeros(len(rgb), dtype=bool)
    if mode == "tie":
        z_ids = np.flatnonzero(inside)
        ctx = np.zeros(len(rgb))
        ctx[z_ids] = np.median(lum[z_ids][cKDTree(xyz[z_ids]).query(xyz[z_ids], k=min(17, len(z_ids)))[1][:, 1:]], axis=1)
        band = inside & (lum > jacket_lum + 0.03) & (lum < 0.45) & (ctx < 0.45)  # grey among grey, not a speck on white
        t_lo, t_hi = _edges(x, b, band, nb, (3, 97), 6, extend=True)  # the tie runs as far as the shirt
        tie = inside & np.isfinite(t_lo[b]) & (x > t_lo[b]) & (x < t_hi[b])
        if tie.sum() >= 20:
            tie_c = np.median(rgb[tie & band], axis=0)
            t_l = max(float(tie_c @ LUM), 1e-3)
            out[tie] = np.clip(tie_c[None] * np.clip(1 + 0.15 * (lum[tie] / t_l - 1), 0.85, 1.15)[:, None], 0, 1)
        else:
            tie[:] = False
        paint = inside & ~tie
    else:
        paint = inside & (lum < float(white @ LUM) - 0.08)
    sel = paint[ids]
    out[ids[sel]] = np.clip(white[None] * shade[sel, None], 0, 1)
    return out, ids[sel], np.flatnonzero(tie)


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
    p.add_argument("--legs-solid", type=float, default=None, help="with --legs-lum: the trousers' least opacity (no see-through hips)")
    p.add_argument("--feet-lum", type=float, default=None, help="the shoes' luminance (dark shoes without grey patches)")
    p.add_argument("--cloth-hue", type=float, default=0.0, help="share of each fabric's colour pulled to its median (one jacket colour)")
    p.add_argument("--reskin-hips", action="store_true", help="hip and seat Gaussians skinned from the nearest SMPL-X vertices (no smoke under a seated person)")
    p.add_argument("--drop-faint", type=float, default=None, help="clothes: drop Gaussians fainter than this and over 5 mm (smoky edges)")
    p.add_argument("--cloth-solid", type=float, default=None, help="clothes: the least opacity of the rest (no see-through patches)")
    p.add_argument("--fill-cloth", type=float, default=None, help="clothes: each Gaussian at least this times its spacing across the surface (no holes)")
    p.add_argument("--rebuild-hands", type=int, default=0, help="fresh hands on the SMPL-X surface, this many Gaussians per hand (0 = keep LHM++'s)")
    p.add_argument("--no-needles", type=float, default=None, help="clothes: the longest axis at most this times the middle one (no streaks)")
    p.add_argument("--light-streaks", type=float, default=None, help="clothes: a Gaussian this much lighter than its 16 neighbours' median takes it")
    p.add_argument("--relight-legs", type=float, default=None, help="the trousers shaded by a soft key light from above and in front, this strong (knees, shins)")
    p.add_argument("--skin-consistent", action="store_true", help="a Gaussian whose joint differs from its neighbours' takes their weights (no floaters when posed)")
    p.add_argument("--drop-lonely", type=float, default=None, help="drop clothes Gaussians whose 8 nearest are on average further than this (m)")
    p.add_argument("--hand-shading", type=float, default=1.0, help="with --rebuild-hands: strength of the shading between the fingers, the creases and the nails (0-1)")
    p.add_argument("--hand-rgb", type=str, default=None, help="with --rebuild-hands: the hands' skin colour R,G,B or R:G:B (0-1), e.g. the face's, so they match")
    p.add_argument("--from-current", action="store_true", help="start from the bundle as it is (passes another tool made stay), not from avatar.raw.ply")
    p.add_argument("--keep-colours", action="store_true", help="skip the suit-minded colour passes (specks, sleeve logos, back smears, trouser blobs): a white kit keeps its colours for lhmpp_avatar.py whites")
    p.add_argument("--back-collar-m", type=float, default=None, help="the back pass reaches up to this far above the neck joint (m; the shirt collar's band above it stays); default 5 cm below it")
    p.add_argument("--back-smear", type=float, default=0.15, help="a Gaussian on the jacket's back this much lighter than its dark half's median is a smear")
    p.add_argument("--shirt-clean", choices=["tie", "open"], default=None,
                   help="the shirt between the lapels one clean white (grey blotches go) and, with tie, the tie one dark cloth")
    a = p.parse_args(argv)

    root = a.bundle
    dream = json.loads((root / "dream.json").read_text())
    av = dream["avatar"]
    ply, skin = root / av["file"], root / av["skin"]
    raw_ply, raw_skin = ply.with_name("avatar.raw.ply"), skin.with_name("skin.raw.bin")
    if not raw_ply.exists():
        shutil.copy(ply, raw_ply)
        shutil.copy(skin, raw_skin)
    g = read_ply(ply if a.from_current else raw_ply)  # --from-current: on top of passes already made, not over them
    idx, q = read_skin_bin(skin if a.from_current else raw_skin)
    dom = idx[np.arange(len(idx)), np.argmax(q, 1)].astype(int)
    hands, head = np.isin(dom, HANDS), np.isin(dom, HEAD)
    head_report = root / "uika_head.json"
    head_first = None
    if a.body_only and head_report.is_file():  # a head model's head (the range a distill fitted) is left alone
        head_first = int(json.loads(head_report.read_text())["head"]["first"])
        head[head_first:] = True
        hands[head_first:] = False
        if a.rebuild_hands:
            raise SystemExit("--rebuild-hands would put hands after the head model's range: not with uika_head.json")
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

    # 1a. --reskin-hips: LHM++'s skinning grid gives the seat and the backs of the thighs to the pelvis, so when he sits
    # they stay behind and hang under him as smoke. Below the hip joints they take the nearest SMPL-X vertices' weights
    # (4, by distance), so they go where the thigh goes; the crease rule below then gives each one a single joint.
    HIPS = [J["pelvis"], J["left_hip"], J["right_hip"], J["spine1"]]
    reskinned = hands & False
    if a.reskin_hips:
        hip_y = (joints[J["left_hip"], 1] + joints[J["right_hip"], 1]) / 2
        reskinned = np.isin(dom, HIPS) & (g.xyz[:, 1] < hip_y - 0.02) & ~hands
        lower = np.flatnonzero(np.isin(np.argmax(lbs, 1), HIPS + [J["left_knee"], J["right_knee"]]))
        if reskinned.any() and len(lower) > 16:
            from lucid_avatars.skinning import blend_vertex_weights, quantize_top4

            d_v, i_v = cKDTree(verts[lower]).query(g.xyz[reskinned], k=4)
            idx[reskinned], q[reskinned] = quantize_top4(blend_vertex_weights(np.asarray(lbs)[lower], i_v, d_v))

    # 1b. the hip crease: Gaussians shared between the torso and a thigh stretch into streaks when he sits (90 degrees
    # of hip flexion pulls them both ways). Each one follows only its strongest joint, and can't be a needle.
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
    top = -0.05 if a.back_collar_m is None else a.back_collar_m  # with --back-collar-m, up to the shirt collar's band
    if a.back_collar_m is not None:
        TORSO_J = TORSO_J + [J["neck"]]
    back = np.isin(dom, TORSO_J) & (g.xyz[:, 2] < joints[J["spine3"], 2] - 0.02) & (g.xyz[:, 1] < joints[J["neck"], 1] + top) & ~hands
    smear = back & False
    if back.sum() > 64:
        lum = out @ np.array([0.299, 0.587, 0.114])
        dark = back & (lum < np.percentile(lum[back], 50))
        smear = back & (lum > np.percentile(lum[back], 50) + a.back_smear)
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

    if a.keep_colours:  # a kit the suit-minded colour passes would spoil (tennis whites): the photos' colours stay
        out = rgb.copy()

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
    opacity = g.opacity.copy()
    solid = toned & (1 / (1 + np.exp(-opacity)) > 0.02) if a.legs_solid else toned & False
    if solid.any():  # LHM++ leaves the hips half see-through where hands sat in pockets
        floor = math.log(a.legs_solid / (1 - a.legs_solid))
        opacity[solid] = np.maximum(opacity[solid], floor)

    # 2d'. --feet-lum: the shoes one dark leather (grey patches were highlights and guesses), 30% of their shading kept
    FEET = [J["left_ankle"], J["right_ankle"], J["left_foot"], J["right_foot"]]
    shoes = np.isin(dom, FEET) & ~hands
    if a.feet_lum is not None and shoes.sum() > 64:
        lum = out[shoes] @ LUM
        base = np.median(out[shoes], axis=0)
        tone = float(base @ LUM) + 0.25 * (base - float(base @ LUM))
        tone = tone * (a.feet_lum / max(float(tone @ LUM), 1e-3))
        shade = np.clip(1 + 0.3 * (lum / max(float(np.median(lum)), 1e-3) - 1), 0.6, 1.4)
        out[shoes] = np.clip(tone[None] * shade[:, None], 0, 1)

    # 2d''. --cloth-hue F: each fabric (the jacket, the trousers) one colour: the main fabric's chroma pulled F of the way
    # to its median (a navy jacket whose back came out brown); brightness, and other colours on the part, stay
    hued = 0
    if a.cloth_hue > 0:
        for part in (np.isin(dom, JACKET) & ~hands, trousers):
            ids = np.flatnonzero(part)
            if len(ids) < 64:
                continue
            fab = ids[np.linalg.norm(out[ids] - np.median(out[ids], axis=0), axis=1) < 0.2]
            lum = (out[fab] @ LUM)[:, None]
            chroma = out[fab] - lum
            target = np.median(chroma, axis=0)
            out[fab] = np.clip(lum + (1 - a.cloth_hue) * chroma + a.cloth_hue * target, 0, 1)
            hued += len(fab)

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

    # 8. solid, crisp clothes (not the head, neck or hands): faint large Gaussians are the smoke round a silhouette and
    # under a seated person, so they go (--drop-faint); the rest are at least --cloth-solid opaque, and each is at least
    # --fill-cloth times its spacing wide along the surface, so no patch is see-through and no hole shows the room
    keep = np.ones(len(g), dtype=bool)
    clothes = ~hands & ~head & (dom != J["neck"])
    alpha = 1 / (1 + np.exp(-opacity))
    faint = clothes & False
    if a.drop_faint:
        faint = clothes & (alpha < a.drop_faint) & (np.exp(scale.max(1)) > 0.005)
        keep &= ~faint
    firm = clothes & False
    if a.cloth_solid:
        firm = clothes & keep & (alpha > 0.02) & (alpha < a.cloth_solid)
        opacity[firm] = math.log(a.cloth_solid / (1 - a.cloth_solid))
    widened = 0
    if a.fill_cloth:  # inside one colour only: a white shirt Gaussian at a dark lapel's edge stays its size
        _, nn9 = cKDTree(xyz).query(xyz, k=9)
        inside = np.linalg.norm(out - np.median(out[nn9], axis=1), axis=1) < 0.12
        ids = np.flatnonzero(clothes & keep & inside)
        d_n, _ = cKDTree(xyz[ids]).query(xyz[ids], k=5)
        want = np.log(np.clip(a.fill_cloth * d_n[:, 1:].mean(1), 1e-4, 0.015))
        order = np.argsort(scale[ids], axis=1)
        srt = np.take_along_axis(scale[ids], order, 1)
        before = srt.copy()
        srt[:, 1] = np.maximum(srt[:, 1], want)  # the two axes along the surface (flatten left the third across it)
        srt[:, 2] = np.maximum(srt[:, 2], want)
        widened = int((srt != before).any(1).sum())
        s_new = np.empty_like(srt)
        np.put_along_axis(s_new, order, srt, 1)
        scale[ids] = s_new

    # 9. streaks: on clothes, a Gaussian much lighter than its neighbours (a white thread of shirt over a lapel, a grey
    # streak on a dark sleeve) takes their median colour, and none is longer than --no-needles times its middle axis
    streaks = clothes & False
    if a.light_streaks:
        _, nn17 = cKDTree(xyz).query(xyz, k=17)
        med17 = np.median(out[nn17[:, 1:]], axis=1)
        streaks = clothes & keep & ((out @ LUM) - (med17 @ LUM) > a.light_streaks)
        out[streaks] = med17[streaks]
    needled = 0
    if a.no_needles:
        ids = np.flatnonzero(clothes & keep)
        order = np.argsort(scale[ids], axis=1)
        srt = np.take_along_axis(scale[ids], order, 1)
        cap = srt[:, 1] + math.log(a.no_needles)
        needled = int((srt[:, 2] > cap).sum())
        srt[:, 2] = np.minimum(srt[:, 2], cap)
        s_new = np.empty_like(srt)
        np.put_along_axis(s_new, order, srt, 1)
        scale[ids] = s_new

    # 9b. --shirt-clean tie|open: the shirt between the lapels, one cloth (shirt_paint): LHM++ garbles it into grey
    # blotches (worst where the photos were black and white) and an open collar into a muddy streak
    shirt_n = tie_n = 0
    if a.shirt_clean:
        TORSO_F = [J[k] for k in ("pelvis", "spine1", "spine2", "spine3", "neck", "left_collar", "right_collar")]
        neck_j, s3 = joints[J["neck"]], joints[J["spine3"]]
        cand = keep & np.isin(dom, TORSO_F) & ~hands & ~head & (xyz[:, 2] > s3[2] + 0.02) \
            & (np.abs(xyz[:, 0] - neck_j[0]) < 0.14)
        jacket_lum = float(np.percentile((out @ LUM)[cand], 30))  # the jacket either side of the shirt
        top = neck_j[1] - 0.05 if a.shirt_clean == "tie" else neck_j[1] + 0.035
        out, shirt_ids, tie_ids = shirt_paint(xyz, out, cand, top, joints[J["pelvis"], 1] + 0.05, a.shirt_clean, jacket_lum)
        shirt_n, tie_n = len(shirt_ids), len(tie_ids)

    # 10. trousers with shape: LHM++'s guessed shading was noise, and toning them flattened them, so they are lit
    # again by a soft key light from above and in front, through SMPL-X's own normals (knees, shins and the tops of
    # the thighs when he sits)
    relit = 0
    if a.relight_legs:
        faces = np.asarray(np.load(a.smplx, allow_pickle=True)["f"], dtype=np.int64)
        vn = face_normals_at(verts, faces)
        legs_l = keep & (np.isin(dom, TROUSERS + [J["left_ankle"], J["right_ankle"]])) & ~hands
        n_g = vn[cKDTree(verts).query(xyz[legs_l])[1]]
        key = np.array([0.0, 0.75, 0.66]) / np.linalg.norm([0.0, 0.75, 0.66])
        shade = (1 - a.relight_legs) + a.relight_legs * (0.55 + 0.6 * np.clip(n_g @ key, 0, 1))
        out[legs_l] = np.clip(out[legs_l] * shade[:, None], 0, 1)
        relit = int(legs_l.sum())

    # 11. skinning that agrees with the neighbours: a Gaussian whose strongest joint isn't the one most of its 16
    # nearest follow (at least 70% of them) takes their average weights, so no sliver stays behind when the arm or the
    # leg moves; and lonely ones (--drop-lonely) go
    consistent = 0
    if a.skin_consistent:
        body_m = keep & ~hands & ~head
        bi = np.flatnonzero(body_m)
        _, nn = cKDTree(xyz[bi]).query(xyz[bi], k=17)
        dom_now = idx[np.arange(len(idx)), np.argmax(q, 1)].astype(np.int64)
        nb_dom = dom_now[bi][nn[:, 1:]]
        maj = np.array([np.bincount(r).argmax() for r in nb_dom])
        share = (nb_dom == maj[:, None]).mean(1)
        handish = np.isin(maj, HANDS) | np.isin(dom_now[bi], HANDS)  # sleeves never take the fingers' weights
        odd = (dom_now[bi] != maj) & (share >= 0.7) & ~handish
        if odd.any():
            from lucid_avatars.skinning import quantize_top4

            W = np.zeros((len(bi), 55))
            np.add.at(W, (np.repeat(np.arange(len(bi)), 4), idx[bi].reshape(-1).astype(np.int64)), q[bi].reshape(-1) / 255.0)
            avg = W[nn[:, 1:]].mean(1)
            ni, nq = quantize_top4(avg[odd])
            idx[bi[odd]], q[bi[odd]] = ni, nq
            consistent = int(odd.sum())
    lonely_n = 0
    if a.drop_lonely:
        d9, _ = cKDTree(xyz).query(xyz, k=9)
        lonely = clothes & keep & (d9[:, 1:].mean(1) > a.drop_lonely)
        keep &= ~lonely
        lonely_n = int(lonely.sum())

    # 12. --rebuild-hands N: LHM++ sees hands in few photos, so its hands are blurs with no fingers, smeared into the
    # cuffs. They go (every finger Gaussian and the wrist ones past the wrist) and fresh ones are laid on SMPL-X's hand,
    # coloured from his own skin there, skinned as SMPL-X: fingers that read as fingers and bend as fingers.
    new_hands = None
    if a.rebuild_hands > 0:
        faces = np.asarray(np.load(a.smplx, allow_pickle=True)["f"], dtype=np.int64)
        old_hand = np.zeros(len(g), dtype=bool)
        for side in ("left", "right"):
            wrist, elbow = joints[J[f"{side}_wrist"]], joints[J[f"{side}_elbow"]]
            along = (wrist - elbow) / np.linalg.norm(wrist - elbow)
            fingers = [j for j in range(25, 55) if (j < 40) == (side == "left")]
            past = ((xyz - wrist) @ along) > 0.0
            old_hand |= np.isin(dom, fingers) | ((dom == J[f"{side}_wrist"]) & past)
        lum_h, sat_h = out @ LUM, out.max(1) - out.min(1)
        skin_like = old_hand & (lum_h > 0.3) & (sat_h > 0.08)
        if skin_like.sum() < 50:
            skin_like = old_hand
        tone = np.array([float(v) for v in re.split(r"[,:/]", a.hand_rgb)]) if a.hand_rgb else None
        if tone is not None and tone.shape != (3,):
            raise SystemExit(f"--hand-rgb wants R,G,B (or R:G:B), not {a.hand_rgb}")
        new_hands = hand_gaussians(verts, faces, np.asarray(lbs), joints, xyz[skin_like], out[skin_like],
                                   a.rebuild_hands, tone=tone, shading=a.hand_shading)
        keep &= ~old_hand

    g_out = replace(g, xyz=xyz, f_dc=(np.clip(out, 0, 1) - 0.5) / SH_C0, scale=scale, rotation=rotation, opacity=opacity)
    if not keep.all():
        g_out = replace(g_out, xyz=g_out.xyz[keep], f_dc=g_out.f_dc[keep], f_rest=g_out.f_rest[keep],
                        opacity=g_out.opacity[keep], scale=g_out.scale[keep], rotation=g_out.rotation[keep])
    idx_out, q_out = idx[keep], q[keep]
    if new_hands:
        m = len(new_hands["xyz"])
        g_out = replace(g_out, xyz=np.concatenate([g_out.xyz, new_hands["xyz"]]),
                        f_dc=np.concatenate([g_out.f_dc, (new_hands["rgb"] - 0.5) / SH_C0]),
                        f_rest=np.concatenate([g_out.f_rest, np.zeros((m, g_out.f_rest.shape[1]))]),
                        opacity=np.concatenate([g_out.opacity, np.full(m, math.log(0.97 / 0.03))]),
                        scale=np.concatenate([g_out.scale, new_hands["scale"]]),
                        rotation=np.concatenate([g_out.rotation, new_hands["rot"]]))
        idx_out = np.concatenate([idx_out, new_hands["idx"]])
        q_out = np.concatenate([q_out, new_hands["q"]])
    write_ply(ply, g_out)
    write_skin_bin(skin, idx_out, q_out)
    if head_first is not None and not keep[:head_first].all():  # the head range moved up with the body's drops
        rep = json.loads(head_report.read_text())
        rep["head"]["first"] = int(keep[:head_first].sum())
        head_report.write_text(json.dumps(rep, indent=2) + "\n")
    report = {"hands": int(hands.sum()), "crease": int(crease.sum()), "specks": int(specks.sum()), "sleeveLogos": int(logo.sum()),
              "trouserBlobs": int(blob.sum()), "backSmears": int(smear.sum()), "hair": int(hair.sum()), "mute": a.mute,
              "deflated": int(slim.sum()) if a.deflate < 1 else 0, "deflate": a.deflate,
              "flattened": int(flat.sum()) if a.flatten < 1 else 0, "flatten": a.flatten,
              "smoothCloth": a.smooth_cloth, "clothSmoothed": int(cloth.sum()) if a.smooth_cloth > 0 else 0,
              "evenCloth": a.even_cloth, "evened": evened, "legsLum": a.legs_lum, "legsToned": int(toned.sum()), "legsSolid": int(solid.sum()),
              "feetLum": a.feet_lum, "clothHue": a.cloth_hue, "hued": hued, "reskinnedHips": int(reskinned.sum()),
              "droppedFaint": int(faint.sum()), "madeSolid": int(firm.sum()), "widened": widened,
              "lightStreaks": int(streaks.sum()), "needlesCapped": needled, "legsRelit": relit, "skinConsistent": consistent,
              "lonelyDropped": lonely_n, "backSmear": a.back_smear, "backCollarM": a.back_collar_m, "shirtClean": a.shirt_clean, "shirtBlotches": shirt_n, "tieEvened": tie_n, "handRgb": a.hand_rgb, "fromCurrent": a.from_current, "headFirst": head_first, "handShading": a.hand_shading, "newHandGaussians": int(len(new_hands["xyz"])) if new_hands else 0,
              "of": len(g), "kept": int(keep.sum()) + (len(new_hands["xyz"]) if new_hands else 0)}
    (root / "cleanup.json").write_text(json.dumps(report, indent=2) + "\n")
    print("[cleanup]", report)


if __name__ == "__main__":
    main()
