"""Overdraw maps for the website's Frame budget section, from one real frame of each person.

Spark draws every Gaussian as a quad out to k standard deviations along its projected axes, whatever its opacity.
Seen face on from 1.8 m, this counts how many of those quads cover each 5 mm of the person (the layers the GPU paints
there), then averages to 1 cm cells. Three states per person: every Gaussian as Spark draws it by default, what the
headset draws (the 160k that add most, apps/webxr/src/xr/budget.ts), and the governor's lowest level
(apps/webxr/src/xr/quality.ts). Writes public/media/overdraw.bin (uint8 cells, log scale) and
components/tech/overdraw.json (sizes, scales and the pixels shaded per eye).

  avatars/.venv/bin/python apps/web/scripts/overdraw.py
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "pipeline"))
from lucid.gaussians import read_spz  # noqa: E402

PEOPLE = [("jump", "lebron-shot", 50), ("dancer", "dance-01", 60)]
CELL = 0.005  # metres per counting cell
OUT = 2  # counting cells per stored cell (1 cm)
U0, U1, Y0, Y1 = -0.7, 0.7, -0.05, 2.15
EYE_W, FOV, Z = 1832, 96.0, 1.8  # Quest 3S per eye, horizontal field of view, viewing distance
STATES = [
    {"key": "all", "budget": None, "k": math.sqrt(8), "alpha": 0.5 / 255, "res": 0.8},
    {"key": "headset", "budget": 160_000, "k": 2.83, "alpha": 0.5 / 255, "res": 0.7},
    {"key": "load", "budget": 160_000, "k": 1.9, "alpha": 0.03, "res": 0.7},
]


def quat_to_mat(q: np.ndarray) -> np.ndarray:
    w, x, y, z = (q / np.linalg.norm(q, axis=1, keepdims=True)).T
    return np.stack(
        [
            np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], 1),
            np.stack([2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], 1),
            np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], 1),
        ],
        1,
    )


def layers(u, y, e1, e2, a1, a2) -> np.ndarray:
    """How many quads (centre u, y; half extents a1, a2 along unit axes e1, e2) cover each counting cell."""
    nu = round((U1 - U0) / CELL)
    ny = round((Y1 - Y0) / CELL)
    grid = np.zeros(nu * ny, np.int32)
    reach = np.maximum(np.abs(e1[:, 0]) * a1 + np.abs(e2[:, 0]) * a2, np.abs(e1[:, 1]) * a1 + np.abs(e2[:, 1]) * a2)
    r = np.ceil(reach / CELL).astype(int)
    for rr in np.unique(r):
        sel = np.nonzero(r == rr)[0]
        off = np.arange(-rr, rr + 1)
        du, dy = [g.ravel() for g in np.meshgrid(off, off)]
        for chunk in np.array_split(sel, max(1, len(sel) * du.size // 4_000_000 + 1)):
            iu = np.floor((u[chunk] - U0) / CELL).astype(int)[:, None] + du[None]
            iy = np.floor((y[chunk] - Y0) / CELL).astype(int)[:, None] + dy[None]
            cu = U0 + (iu + 0.5) * CELL - u[chunk][:, None]
            cy = Y0 + (iy + 0.5) * CELL - y[chunk][:, None]
            p1 = cu * e1[chunk, 0:1] + cy * e1[chunk, 1:2]
            p2 = cu * e2[chunk, 0:1] + cy * e2[chunk, 1:2]
            inside = (np.abs(p1) <= a1[chunk][:, None]) & (np.abs(p2) <= a2[chunk][:, None])
            inside &= (iu >= 0) & (iu < nu) & (iy >= 0) & (iy < ny)
            np.add.at(grid, (iy * nu + iu)[inside], 1)
    return grid.reshape(ny, nu)


def main() -> None:
    meta = {"cell": CELL * OUT, "u": [U0, U1], "y": [Y0, Y1], "z": Z, "people": {}}
    blobs = []
    offset = 0
    for key, dream, frame in PEOPLE:
        g = read_spz(ROOT / "dreams" / dream / "frames" / f"{frame:06d}.spz")
        s = np.exp(g.scales.astype(np.float64))
        a = 1 / (1 + np.exp(-g.opacities.astype(np.float64)))
        R = quat_to_mat(g.quats.astype(np.float64))
        cov = np.einsum("nij,nj,nkj->nik", R, s * s, R)[:, :2, :2]  # x and y: face on, the viewer looking down +Z
        lam, vec = np.linalg.eigh(cov)
        sig = np.sqrt(np.maximum(lam, 1e-12))
        # the person faces -Z, so the viewer sees their +X on the left
        u = -g.means[:, 0].astype(np.float64)
        y = g.means[:, 1].astype(np.float64)
        e1 = vec[:, :, 1] * np.array([-1.0, 1.0])
        e2 = vec[:, :, 0] * np.array([-1.0, 1.0])
        ss = np.sort(s, 1)
        order = np.argsort(-(a * ss[:, 1] * ss[:, 2]))  # what the headset keeps first (budget.ts)
        maps = []
        info = []
        for st in STATES:
            keep = order if st["budget"] is None else order[: st["budget"]]
            keep = keep[a[keep] >= st["alpha"]]
            k = st["k"]
            grid = layers(u[keep], y[keep], e1[keep], e2[keep], k * sig[keep, 1], k * sig[keep, 0])
            ny, nu = grid.shape
            coarse = grid.reshape(ny // OUT, OUT, nu // OUT, OUT).mean((1, 3))
            f = EYE_W * st["res"] / (2 * math.tan(math.radians(FOV / 2)))
            area = float((4 * k * k * sig[keep, 0] * sig[keep, 1]).sum())  # m², the quads' total, face on
            eye = (EYE_W * st["res"]) * (1920 * st["res"])
            maps.append(coarse[::-1])  # top row first
            info.append(
                {
                    "key": st["key"],
                    "drawn": int(len(keep)),
                    "k": round(k, 2),
                    "alpha": round(st["alpha"], 3),
                    "res": st["res"],
                    "pixels": round(area * (f / Z) ** 2),
                    "eyePixels": round(eye),
                    "peak": round(float(np.percentile(coarse[coarse > 0], 99.5)), 1),
                }
            )
        top = max(m.max() for m in maps)
        h, w = maps[0].shape
        for m, i in zip(maps, info):
            q = np.round(255 * np.log1p(m) / np.log1p(top)).astype(np.uint8)
            blobs.append(q.tobytes())
            i["offset"] = offset
            offset += q.size
        meta["people"][key] = {"dream": dream, "frame": frame, "n": int(len(g.means)), "w": w, "h": h, "top": round(float(top), 1), "states": info}
        print(key, [(i["key"], i["drawn"], f'{i["pixels"] / 1e6:.0f} M', i["peak"]) for i in info])
    (ROOT / "apps/web/public/media/overdraw.bin").write_bytes(b"".join(blobs))
    (ROOT / "apps/web/components/tech/overdraw.json").write_text(json.dumps(meta, indent=1) + "\n")


if __name__ == "__main__":
    main()
