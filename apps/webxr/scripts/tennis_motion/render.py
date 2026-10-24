"""Pictures of finished clips, to check them by eye: stick figures from the front (the opponent's view, from -Z), the
side (+X) and above, every few frames, with the floor, the contact frame in green and a rough racket line from the
right hand; and the test avatar's own Gaussians posed at a few frames (the same LBS the players run)."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import motionlib as ml  # noqa: E402
from lucid_avatars.smplx_layout import JOINT_NAMES, SMPLX_PARENTS, J  # noqa: E402

BONES = [(j, p) for j, p in enumerate(SMPLX_PARENTS[:22]) if p >= 0]


def _color(j):
    n = JOINT_NAMES[j]
    return "#e5484d" if n.startswith("right") else "#3e63dd" if n.startswith("left") else "#444"


def views(P):
    """front (from -Z: screen x = -world x), side (from +X: screen x = -world z), top (screen x = x, up = -z)."""
    return {
        "front": np.stack([-P[..., 0], P[..., 1]], -1),
        "side": np.stack([-P[..., 2], P[..., 1]], -1),
        "top": np.stack([P[..., 0], -P[..., 2]], -1),
    }


def stick_strip(clip: dict, rest, out_path, every: int = 3, title: str = "", cols: int = 12,
                view_names=("front", "side", "top")):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    frames = clip["frames"]
    root_q = np.array([f["root_q"] for f in frames])
    root_t = np.array([f["root_t"] for f in frames])
    pose = np.array([f["pose"] for f in frames])
    P, G = ml.fk(rest, root_q, root_t, pose)
    n = len(frames)
    ev = clip.get("events") or {}
    marks = {v: k for k, v in ev.items()}
    idx = sorted(set(list(range(0, n, every)) + list(marks) + [n - 1]))
    V = views(P)
    grip, head, tip = ml.racket_points(P, G)
    RV = views(tip)
    WV = views(grip)
    HV = views(head)
    groups = [idx[i:i + cols] for i in range(0, len(idx), cols)]
    nv = len(view_names)
    fig, axs = plt.subplots(nv * len(groups), cols, figsize=(cols * 1.6, nv * len(groups) * 1.75), squeeze=False)
    lim = {"front": ((-1.2, 1.2), (-0.05, 2.5)), "side": ((-1.2, 1.2), (-0.05, 2.5)), "top": ((-1.2, 1.2), (-1.2, 1.2))}
    for g, grp in enumerate(groups):
        for r, name in enumerate(view_names):
            for c in range(cols):
                a = axs[g * nv + r][c]
                a.set_xticks([])
                a.set_yticks([])
                if c >= len(grp):
                    a.set_axis_off()
                    continue
                i = grp[c]
                v = V[name][i]
                hi = i in marks
                for j, p in BONES:
                    a.plot([v[j, 0], v[p, 0]], [v[j, 1], v[p, 1]], color="#1a7f37" if hi else _color(j), lw=1.5)
                a.plot([WV[name][i, 0], RV[name][i, 0]], [WV[name][i, 1], RV[name][i, 1]], color="#b08800", lw=1.1)
                a.add_patch(__import__("matplotlib.patches", fromlist=["Circle"]).Circle(
                    (HV[name][i, 0], HV[name][i, 1]), 0.12, fill=False, color="#b08800", lw=0.8))
                if name != "top":
                    a.axhline(0, color="#999", lw=0.6)
                else:
                    a.plot([0], [0], "+", color="#999")
                    a.annotate("", xy=(0, 1.0), xytext=(0, 0.6), arrowprops=dict(arrowstyle="->", color="#bbb"))
                a.set_xlim(*lim[name][0])
                a.set_ylim(*lim[name][1])
                a.set_aspect("equal")
                if r == 0:
                    a.set_title(f"{i}" + (f" {marks[i]}" if hi else ""), fontsize=8, color="#1a7f37" if hi else "black")
                if c == 0:
                    a.set_ylabel(name, fontsize=8)
    fig.suptitle(title + "   (front: seen from -Z, the opponent; side: from +X; top: -Z is up, arrow)", fontsize=9)
    fig.subplots_adjust(0.02, 0.01, 0.99, 0.95, 0.03, 0.12)
    fig.savefig(out_path, dpi=80)
    plt.close(fig)


class AvatarPoints:
    def __init__(self, max_points=40000):
        from lucid_avatars.gaussian_ply import SH_C0, read_ply
        from lucid_avatars.skinning import read_skin_bin

        g = read_ply(ml.TEST_AVATAR / "avatar" / "avatar.ply")
        idx, w = read_skin_bin(ml.TEST_AVATAR / "avatar" / "skin.bin")
        alpha = 1 / (1 + np.exp(-g.opacity))
        keep = np.flatnonzero(alpha > 0.4)
        rng = np.random.default_rng(0)
        if len(keep) > max_points:
            keep = rng.choice(keep, max_points, replace=False)
        self.xyz, self.idx, self.w = g.xyz[keep], idx[keep], w[keep]
        self.rgb = np.clip(0.5 + SH_C0 * g.f_dc[keep], 0, 1)


def avatar_frames(clip: dict, rest, pts: AvatarPoints, out_path, frames_idx, title=""):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fr = [clip["frames"][i] for i in frames_idx]
    root_q = np.array([f["root_q"] for f in fr])
    root_t = np.array([f["root_t"] for f in fr])
    pose = np.array([f["pose"] for f in fr])
    P, G = ml.fk(rest, root_q, root_t, pose)
    X = ml.pose_points(rest, P, G, pts.xyz, pts.idx, pts.w)
    fig, axs = plt.subplots(2, len(frames_idx), figsize=(len(frames_idx) * 2.0, 2 * 2.9), squeeze=False)
    for c, i in enumerate(frames_idx):
        for r, name in enumerate(("front", "side")):
            a = axs[r][c]
            v = views(X[c])[name]
            depth = X[c][:, 2] if name == "front" else -X[c][:, 0]  # nearer to the viewer drawn last
            order = np.argsort(-depth) if name == "front" else np.argsort(-depth)
            a.scatter(v[order, 0], v[order, 1], s=0.15, c=pts.rgb[order], linewidths=0)
            a.axhline(0, color="#999", lw=0.6)
            a.set_xlim(-1.2, 1.2)
            a.set_ylim(-0.05, 2.3)
            a.set_aspect("equal")
            a.set_xticks([])
            a.set_yticks([])
            if r == 0:
                a.set_title(str(i), fontsize=8)
    fig.suptitle(title, fontsize=9)
    fig.subplots_adjust(0.01, 0.01, 0.99, 0.92, 0.02, 0.02)
    fig.savefig(out_path, dpi=100)
    plt.close(fig)
