"""A synthetic moving person, rendered from a 4DAnyone-style camera ring, for testing reconstruction end to end.

    python -m lucid.synthetic --out /tmp/synth --frames 4 --views 24
    python -m lucid.recon --prepared /tmp/synth --out /tmp/synth-recon --iters-first 2000 --iters-warm 500

The person is built from known Gaussians, so a correct trainer must reproduce the renders closely (PSNR well above 30).
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import torch

from .frames import Rig
from .gaussians import SH_C0, Gaussians, write_ply


def look_at(position, target, up=(0.0, 1.0, 0.0)) -> np.ndarray:
    """OpenCV camera-to-world (x right, y down, z forward) in a +Y-up world."""
    f = np.asarray(target, float) - np.asarray(position, float)
    f /= np.linalg.norm(f)
    r = np.cross(f, up)
    r /= np.linalg.norm(r)
    d = np.cross(f, r)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = r, d, f, position
    return m


def camera_ring(views: int, width: int, height: int, radius: float = 3.0, pitches=(-10.0, 15.0)) -> Rig:
    fy = 0.5 * height / math.tan(math.radians(45.0) / 2)
    K = np.array([[fy, 0, width / 2], [0, fy, height / 2], [0, 0, 1.0]])
    poses = []
    per_ring = views // len(pitches)
    for pitch in pitches:
        for i in range(per_ring):
            yaw = 2 * math.pi * i / per_ring
            p = math.radians(pitch)
            pos = [radius * math.cos(p) * math.sin(yaw), 0.9 + radius * math.sin(p), -radius * math.cos(p) * math.cos(yaw)]
            poses.append(look_at(pos, [0.0, 0.9, 0.0]))
    return Rig(np.repeat(K[None], len(poses), 0), np.stack(poses), width, height)


def person(t: float, rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """Points and colours of a stylised person at time t (seconds): legs, striped torso, head, swinging arms."""

    def cylinder(n, base, top, radius):
        h = rng.uniform(0, 1, n)
        a = rng.uniform(0, 2 * math.pi, n)
        axis = np.asarray(top) - np.asarray(base)
        length = np.linalg.norm(axis)
        axis = axis / length
        helper = np.array([1.0, 0, 0]) if abs(axis[0]) < 0.9 else np.array([0, 0, 1.0])
        u = np.cross(axis, helper)
        u /= np.linalg.norm(u)
        v = np.cross(axis, u)
        pts = np.asarray(base) + np.outer(h * length, axis) + radius * (np.outer(np.cos(a), u) + np.outer(np.sin(a), v))
        return pts, h

    swing = 0.6 * math.sin(2 * math.pi * 0.8 * t)
    parts = []
    for side in (-1, 1):
        pts, _ = cylinder(5000, [0.1 * side, 0.0, 0.0], [0.1 * side, 0.9, 0.0], 0.07)
        parts.append((pts, np.tile([0.15, 0.25, 0.55], (len(pts), 1))))
        shoulder = np.array([0.25 * side, 1.4, 0.0])
        hand = shoulder + np.array([0.05 * side, -0.6 * math.cos(swing * side), 0.6 * math.sin(swing * side)])
        pts, _ = cylinder(3000, shoulder, hand, 0.045)
        parts.append((pts, np.tile([0.85, 0.65, 0.5], (len(pts), 1))))
    pts, h = cylinder(12000, [0, 0.9, 0], [0, 1.45, 0], 0.18)
    stripes = (np.floor(h * 8) % 2)[:, None]
    parts.append((pts, stripes * np.array([[0.9, 0.9, 0.9]]) + (1 - stripes) * np.array([[0.8, 0.1, 0.15]])))
    d = rng.normal(size=(6000, 3))
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    parts.append((np.array([0, 1.62, 0]) + 0.11 * d, np.tile([0.85, 0.65, 0.5], (6000, 1)) - 0.25 * (d[:, 1:2] > 0.6)))
    points = np.concatenate([p for p, _ in parts]).astype(np.float32)
    colors = np.clip(np.concatenate([c for _, c in parts]) + rng.normal(0, 0.03, (len(points), 3)), 0, 1)
    return points, colors.astype(np.float32)


def as_gaussians(points: np.ndarray, colors: np.ndarray) -> Gaussians:
    n = len(points)
    return Gaussians(
        points,
        np.full((n, 3), math.log(0.012), np.float32),
        np.tile(np.array([1.0, 0, 0, 0], np.float32), (n, 1)),
        np.full(n, 4.0, np.float32),
        ((colors - 0.5) / SH_C0).reshape(n, 1, 3).astype(np.float32),
        np.zeros((n, 0, 3), np.float32),
    )


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--frames", type=int, default=4)
    p.add_argument("--views", type=int, default=24)
    p.add_argument("--width", type=int, default=704)
    p.add_argument("--height", type=int, default=1280)
    p.add_argument("--fps", type=float, default=25.0)
    p.add_argument("--device", default="cuda:0")
    a = p.parse_args(argv)

    from gsplat import rasterization
    from PIL import Image

    rng = np.random.default_rng(0)
    rig = camera_ring(a.views, a.width, a.height)
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "cameras.json").write_text(json.dumps(rig.to_json()))
    viewmats = torch.as_tensor(rig.world_to_camera, dtype=torch.float32, device=a.device)
    Ks = torch.as_tensor(rig.K, dtype=torch.float32, device=a.device)
    for f in range(a.frames):
        pts, col = person(f / a.fps, rng)
        g = as_gaussians(pts, col)
        if f == 0:
            write_ply(a.out / "truth_000000.ply", g)
            init = pts[rng.choice(len(pts), 4000, replace=False)] + rng.normal(0, 0.01, (4000, 3)).astype(np.float32)
            _write_points(a.out / "init_points.ply", init, np.full_like(init, 0.5))
        t = lambda x: torch.as_tensor(x, dtype=torch.float32, device=a.device)  # noqa: E731
        rgb, alpha, _ = rasterization(
            means=t(g.means),
            quats=t(g.quats),
            scales=torch.exp(t(g.scales)),
            opacities=torch.sigmoid(t(g.opacities)),
            colors=t(g.sh0[:, 0] * SH_C0 + 0.5).clamp(0, 1),
            viewmats=viewmats,
            Ks=Ks,
            width=a.width,
            height=a.height,
        )
        rgba = torch.cat([rgb.clamp(0, 1), alpha], -1).mul(255).round().byte().cpu().numpy()
        d = a.out / "frames" / f"{f:06d}"
        d.mkdir(parents=True, exist_ok=True)
        for v in range(a.views):
            Image.fromarray(rgba[v], mode="RGBA").save(d / f"{v:02d}.png")
        print(f"[synthetic] frame {f}: {len(pts)} Gaussians, {a.views} views")


def _write_points(path: Path, pts: np.ndarray, rgb: np.ndarray) -> None:
    n = len(pts)
    header = (
        "ply\nformat binary_little_endian 1.0\n"
        f"element vertex {n}\nproperty float x\nproperty float y\nproperty float z\n"
        "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n"
    )
    rec = np.zeros(n, dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("r", "u1"), ("g", "u1"), ("b", "u1")])
    rec["x"], rec["y"], rec["z"] = pts.T
    rec["r"], rec["g"], rec["b"] = (np.clip(rgb, 0, 1) * 255).astype(np.uint8).T
    with open(path, "wb") as f:
        f.write(header.encode())
        f.write(rec.tobytes())


if __name__ == "__main__":
    main()
