"""A rigged test avatar for the WebXR viewer's live skinning: the SMPL-X body as Gaussians, waving.

Not a person: a neutral grey body sampled from the SMPL-X template, skinned with SMPL-X's own weights, so the
viewer's GPU skinning can be checked against lucid_avatars' reference before real DiGS avatars exist. Also writes
reference.json (the reference skinning transforms for two frames) for the viewer's numeric check.

    cd avatars && uv run python ../apps/webxr/scripts/make_test_avatar.py ~/Downloads/models/smplx/SMPLX_NEUTRAL.npz
Writes <repo>/dreams/test-avatar/ (git-ignored: SMPL-X is licensed, so derived data never goes in the repo).
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

from lucid_avatars.bundle import write_avatar_bundle
from lucid_avatars.gaussian_ply import Gaussians
from lucid_avatars.motion import Motion
from lucid_avatars.skinning import quantize_top4, rest_joints, skeleton_dict, skin_matrices
from lucid_avatars.smplx_layout import J, NUM_JOINTS

REPO = Path(__file__).resolve().parents[3]
N_POINTS = 120_000
FPS = 30
SECONDS = 4.0


def sample_surface(verts, faces, weights, n, rng):
    a, b, c = (verts[faces[:, k]] for k in range(3))
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    tri = rng.choice(len(faces), size=n, p=area / area.sum())
    u, v = rng.random(n), rng.random(n)
    flip = u + v > 1
    u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
    bary = np.stack([1 - u - v, u, v], axis=1)
    f = faces[tri]
    xyz = np.einsum("nk,nkc->nc", bary, verts[f])
    w = np.einsum("nk,nkj->nj", bary, weights[f])
    return xyz, w / w.sum(axis=1, keepdims=True)


def wave_motion(stand_y: float) -> Motion:
    n = round(SECONDS * FPS)
    t = np.arange(n) / FPS
    pose = np.zeros((n, NUM_JOINTS, 3))
    pose[:, J["left_shoulder"], 2] = -1.2  # left arm down
    pose[:, J["left_elbow"], 1] = -0.2
    pose[:, J["right_shoulder"], 2] = 0.15  # right upper arm out, forearm up, waving side to side
    pose[:, J["right_elbow"], 2] = -1.35 + 0.4 * np.sin(2 * math.pi * 1.5 * t)
    pose[:, J["spine2"], 1] = 0.12 * np.sin(2 * math.pi * 0.5 * t)  # a gentle twist
    pose[:, J["head"], 1] = -0.15 * np.sin(2 * math.pi * 0.5 * t)
    half = math.pi / 2
    root_q = np.tile([0.0, math.sin(half), 0.0, math.cos(half)], (n, 1))  # 180 degrees about +Y: face -Z
    root_t = np.zeros((n, 3))
    root_t[:, 1] = stand_y
    return Motion(fps=FPS, betas=np.zeros(10), root_t=root_t, root_q=root_q, pose=pose)


def main(npz: str):
    m = np.load(npz, allow_pickle=True)
    rest, verts = rest_joints(m["v_template"], m["shapedirs"], m["J_regressor"], np.zeros(10))
    rng = np.random.default_rng(0)
    xyz, w = sample_surface(verts, m["f"].astype(np.int64), np.asarray(m["weights"], dtype=np.float64), N_POINTS, rng)
    idx, q = quantize_top4(w)
    shade = 0.62 + 0.18 * (xyz[:, 1] - xyz[:, 1].min()) / np.ptp(xyz[:, 1]) + 0.03 * rng.standard_normal(len(xyz))
    rgb = np.clip(np.stack([shade, shade * 0.97, shade * 0.94], axis=1), 0, 1)
    g = Gaussians(
        xyz=xyz,
        f_dc=(rgb - 0.5) / 0.28209479,
        f_rest=np.zeros((len(xyz), 0)),
        opacity=np.full(len(xyz), 4.0),
        scale=np.full((len(xyz), 3), math.log(0.0045)),
        rotation=np.tile([1.0, 0.0, 0.0, 0.0], (len(xyz), 1)),
    )
    motion = wave_motion(stand_y=-float(verts[:, 1].min()))
    root = write_avatar_bundle(REPO / "dreams", "test-avatar", "Test avatar (SMPL-X, waving)", g, motion,
                               skin=(idx, q), skeleton=skeleton_dict(rest))
    ref = {}
    for k in (0, 17):
        M = skin_matrices(rest, motion.root_q[k], motion.root_t[k], motion.pose[k])
        ref[str(k)] = np.round(M, 6).tolist()
    (root / "reference.json").write_text(json.dumps(ref))
    print(root, len(xyz), "Gaussians")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else str(Path.home() / "Downloads/models/smplx/SMPLX_NEUTRAL.npz"))
