"""Look at a GVHMR fit against its video: the in-camera skeleton drawn over the real frames, plus wrist / foot / heading
curves, so strokes can be trimmed and contact frames picked by eye.

    python inspect_clip.py <npz> <video> <out_prefix> [--every 3] [--start 0] [--end -1]
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import motionlib as ml  # noqa: E402
from lucid_avatars.rotations import aa_to_quat  # noqa: E402
from lucid_avatars.smplx_layout import SMPLX_PARENTS, J  # noqa: E402

BONES = [(j, p) for j, p in enumerate(SMPLX_PARENTS[:22]) if p >= 0]


def side_color(j):
    from lucid_avatars.smplx_layout import JOINT_NAMES
    n = JOINT_NAMES[j]
    return "#ff3b30" if n.startswith("right") else "#0a84ff" if n.startswith("left") else "#ffd60a"


def incam_joints(d):
    T = len(d["transl"])
    pose = np.zeros((T, 55, 3))
    pose[:, 1:22] = d["body_pose"].reshape(T, 21, 3)
    rest = d["rest_joints"]
    # incam transl is SMPL-X transl in camera space: pelvis = transl + J0
    P, _ = ml.fk(rest, aa_to_quat(d["incam_global_orient"]), d["incam_transl"], pose)
    return P


def project(P, K):
    uv = np.einsum("tab,tjb->tja", K, P)
    return uv[..., :2] / uv[..., 2:3]


def read_frames(video, idx, scale_w):
    import matplotlib.image as mpimg  # noqa: F401
    out = {}
    tmp = Path("/tmp") if False else None
    for i in idx:
        cmd = ["ffmpeg", "-v", "error", "-i", str(video), "-vf", f"select=eq(n\\,{i}),scale={scale_w}:-2",
               "-vframes", "1", "-f", "image2pipe", "-vcodec", "png", "-"]
        png = subprocess.check_output(cmd)
        from io import BytesIO
        import matplotlib.pyplot as plt
        out[i] = plt.imread(BytesIO(png), format="png")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("npz")
    ap.add_argument("video")
    ap.add_argument("out")
    ap.add_argument("--every", type=int, default=3)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--end", type=int, default=-1)
    ap.add_argument("--cols", type=int, default=10)
    ap.add_argument("--width", type=int, default=0)
    ap.add_argument("--crop", default="", help="x0,y0,x1,y1 in source pixels")
    args = ap.parse_args()

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    d = ml.load_gvhmr(args.npz)
    T = len(d["transl"])
    end = T if args.end < 0 else min(T, args.end)
    fps = float(d["fps"])
    W, H = int(d["width"]), int(d["height"])

    # curves (world, GVHMR frame: +Y up)
    rest = ml.neutral_rest()
    m = ml.gvhmr_motion(d, rest)
    P, G = ml.fk(rest, m.root_q, m.root_t, m.pose)
    vel = np.gradient(P, axis=0) * fps
    sp = np.linalg.norm(vel, axis=-1)
    fwd = ml.body_forward(P)
    heading = np.degrees(np.unwrap(np.arctan2(fwd[:, 0], fwd[:, 1])))
    fig, ax = plt.subplots(4, 1, figsize=(16, 11), sharex=True)
    f = np.arange(T)
    ax[0].plot(f, sp[:, J["right_wrist"]], "r", label="R wrist speed")
    ax[0].plot(f, sp[:, J["left_wrist"]], "b", label="L wrist speed")
    ax[0].legend(); ax[0].set_ylabel("m/s")
    ax[1].plot(f, P[:, J["right_wrist"], 1], "r", label="R wrist y")
    ax[1].plot(f, P[:, J["left_wrist"], 1], "b", label="L wrist y")
    ax[1].plot(f, P[:, J["head"], 1], "k", label="head y")
    ax[1].legend()
    ax[2].plot(f, P[:, J["right_ankle"], 1], "r", label="R ankle y")
    ax[2].plot(f, P[:, J["left_ankle"], 1], "b", label="L ankle y")
    ax[2].plot(f, d["vmin_y"] - d["vmin_y"].min(), "k", label="lowest vertex")
    ax[2].legend()
    ax[3].plot(f, heading, "k", label="heading deg")
    ax3 = ax[3].twinx()
    ax3.plot(f, np.linalg.norm(vel[:, 0, [0, 2]], axis=1), "g", label="pelvis horiz speed")
    ax[3].legend(loc="upper left"); ax3.legend(loc="upper right")
    for a in ax:
        a.grid(alpha=0.3)
        a.set_xticks(np.arange(0, T, 10))
    ax[3].set_xlabel(f"frame ({fps:g} fps)")
    fig.tight_layout()
    fig.savefig(args.out + "_curves.png", dpi=70)
    plt.close(fig)

    # skeleton over video
    Pc = incam_joints(d)
    uv = project(Pc, d["K"])
    idx = list(range(args.start, end, args.every))
    sw = args.width or (240 if H > W else 320)
    frames = read_frames(args.video, idx, sw)
    s = sw / W
    cols = args.cols
    rows = (len(idx) + cols - 1) // cols
    x0, y0, x1, y1 = (0, 0, W, H) if not args.crop else [float(v) for v in args.crop.split(",")]
    cw, ch = (x1 - x0) * s, (y1 - y0) * s
    fig, axs = plt.subplots(rows, cols, figsize=(cols * cw / 80, rows * ch / 80), squeeze=False)
    for k, i in enumerate(idx):
        a = axs[k // cols][k % cols]
        a.imshow(frames[i])
        for j, p in BONES:
            a.plot([uv[i, j, 0] * s, uv[i, p, 0] * s], [uv[i, j, 1] * s, uv[i, p, 1] * s], color=side_color(j), lw=1.6)
        a.set_xlim(x0 * s, x1 * s)
        a.set_ylim(y1 * s, y0 * s)
        a.text(x0 * s + 4, y0 * s + 14, f"{i}", color="yellow", fontsize=9, bbox=dict(facecolor="black", alpha=0.5, pad=1))
        a.set_axis_off()
    for k in range(len(idx), rows * cols):
        axs[k // cols][k % cols].set_axis_off()
    fig.subplots_adjust(0, 0, 1, 1, 0.01, 0.01)
    fig.savefig(args.out + (f"_{args.start}-{end}" if args.start or args.end > 0 else "") + "_overlay.jpg", dpi=80)
    plt.close(fig)
    print("wrote", args.out + "_curves.png", args.out + "_overlay.jpg")


if __name__ == "__main__":
    main()
