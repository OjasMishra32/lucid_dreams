"""Check the built library: every clip valid, under 1 MB, soles on the floor, loops seamless, facing -Z at the start;
and pictures of the test avatar's own Gaussians posed by each clip at its key frames.

    python check.py <out dir for pictures>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import motionlib as ml  # noqa: E402
import render  # noqa: E402
from build import OUT  # noqa: E402
from lucid_avatars.motion import validate_motion_dict  # noqa: E402


def arrays(c):
    fr = c["frames"]
    return (np.array([f["root_q"] for f in fr]), np.array([f["root_t"] for f in fr]), np.array([f["pose"] for f in fr]))


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    rest = ml.neutral_rest()
    soles = ml.SolePoints()
    pts = render.AvatarPoints()
    index = json.loads((OUT / "index.json").read_text())
    print(f"{'clip':13} {'frames':>6} {'kB':>5} {'sole min/med mm':>16} {'face0 deg':>9} {'seam/step mm':>13}")
    for name, e in index["clips"].items():
        c = json.loads((OUT / e["file"]).read_text())
        assert not validate_motion_dict(c), name
        assert e["bytes"] < 1_000_000, name
        q, t, p = arrays(c)
        P, G = ml.fk(rest, q, t, p)
        low = soles.lowest(P, G) * 1000
        f = ml.body_forward(P)[:3].mean(axis=0)
        face = np.degrees(np.arctan2(f[0], -f[1]))  # 0 = facing -Z
        rel = P[:, :22] - P[:, [0]]
        step = np.linalg.norm(np.diff(rel, axis=0), axis=-1).mean(axis=1)
        seam = f"{np.linalg.norm(rel[0] - rel[-1], axis=-1).mean() * 1000:5.1f}/{np.median(step) * 1000:4.1f}" \
            if c["loop"] else "-"
        print(f"{name:13} {len(c['frames']):6d} {e['bytes'] / 1000:5.0f} {low.min():7.1f}/{np.median(low):6.1f} "
              f"{face:9.1f} {seam:>13}")
        ev = c.get("events") or {}
        n = len(c["frames"])
        keys = sorted(set([0, n // 3, (2 * n) // 3, n - 1] + list(ev.values())))
        render.avatar_frames(c, rest, pts, out / f"{name}_avatar.png", keys,
                             title=f"{name}: test avatar posed (front from -Z, side from +X); events {ev}")


if __name__ == "__main__":
    main()
