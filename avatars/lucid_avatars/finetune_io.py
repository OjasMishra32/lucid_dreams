"""Plain-numpy pieces of the fine-tune on 4DAnyone's views (digs_finetune.py): cameras, view and frame choice, results.

4DAnyone's rig (cameras.json): OpenCV cameras, camera_to_world, in its metric +Y-up world. DiGS takes one 20-float
camera per view: [fx, fy, cx, cy] then the 4x4 world-to-camera matrix, row-major.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

METRICS = (
    ("psnr", "PSNR (dB)", "{:.2f}"), ("ssim", "SSIM", "{:.3f}"), ("lpips", "LPIPS (lower is better)", "{:.3f}"),
    ("psnrPerson", "PSNR, person crop (dB)", "{:.2f}"), ("ssimPerson", "SSIM, person crop", "{:.3f}"),
    ("lpipsPerson", "LPIPS, person crop", "{:.3f}"),
)


def cosine_factor(step: int, steps: int, floor: float = 0.05) -> float:
    """Learning-rate multiplier: 1 at the start, cosine down to `floor` at the end (applied to every group's own lr)."""
    return floor + (1 - floor) * 0.5 * (1 + np.cos(np.pi * min(step, steps) / steps))


def digs_cameras(K: np.ndarray, camera_to_world: np.ndarray, width: int, height: int,
                 tol_px: float = 1.0) -> np.ndarray:
    """(V, 20) float32 DiGS cameras. DiGS's visibility renderer assumes a centred principal point, so refuse others."""
    K = np.asarray(K, dtype=np.float64)
    off = np.abs(K[:, :2, 2] - [width / 2, height / 2]).max(axis=1)
    if (off > tol_px).any():
        raise ValueError(f"views {np.flatnonzero(off > tol_px).tolist()} have an off-centre principal point; "
                         "DiGS needs it at the image centre")
    w2c = np.linalg.inv(np.asarray(camera_to_world, dtype=np.float64))
    intr = np.stack([K[:, 0, 0], K[:, 1, 1], K[:, 0, 2], K[:, 1, 2]], axis=1)
    return np.concatenate([intr, w2c.reshape(-1, 16)], axis=1).astype(np.float32)


def split_views(views: int, held_out: int) -> tuple[list[int], list[int]]:
    """(train, held-out) view indices, the held-out ones evenly spread round the ring."""
    if held_out >= views:
        raise ValueError(f"can't hold out {held_out} of {views} views")
    held = sorted({round(i * views / held_out) for i in range(held_out)})
    return [v for v in range(views) if v not in held], held


def spread_frames(frames: int, k: int) -> list[int]:
    """k frame indices spread evenly over [0, frames), first and last included."""
    if k >= frames:
        return list(range(frames))
    return sorted({round(i * (frames - 1) / (k - 1)) for i in range(k)})


def on_white(rgba: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """uint8 RGBA (..., 4) to RGB on white in 0..1 (DiGS renders on white) and alpha in 0..1."""
    x = np.asarray(rgba, dtype=np.float32) / 255
    alpha = x[..., 3]
    return x[..., :3] * alpha[..., None] + (1 - alpha[..., None]), alpha


def write_results(path: str | Path, before: dict, after: dict, setup: dict) -> None:
    delta = {k: round(after[k] - before[k], 6) for k, _, _ in METRICS if k in before and k in after}
    data = {"before": before, "after": after, "delta": delta, "setup": setup,
            "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    Path(path).write_text(json.dumps(data, indent=2) + "\n")


def results_markdown(before: dict, after: dict) -> str:
    """The before/after table for the README and the slides."""
    rows = ["| Held-out views | One photo (DiGS) | + fine-tune on 4DAnyone views | Change |",
            "| --- | --- | --- | --- |"]
    for key, label, fmt in METRICS:
        if key in before and key in after:
            d = after[key] - before[key]
            rows.append(f"| {label} | {fmt.format(before[key])} | {fmt.format(after[key])} | "
                        f"{'+' if d >= 0 else '-'}{fmt.format(abs(d))} |")
    return "\n".join(rows)
