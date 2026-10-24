"""Feet on the floor: a replay bundle measured and, if asked, moved up or down so its planted feet touch y = 0.

The export stands the person on the floor from the first frame, and a reconstruction can leave the soles a few cm
off (a lifted heel on frame 0, a faint floor patch under the feet). This measures, per frame, the lowest solid point
(0.3rd percentile of the heights of Gaussians at least half opaque), and shifts the whole bundle by one constant so
that the lowest of those touches the floor: frames and their reality copies, joints.json, the ball's track in
props.json and dream.json's bounds and placement, so everything that lines up with the person keeps lining up. The
hoop stays where it is: its rim is regulation height above the real floor.

    PYTHONPATH=pipeline python -m lucid.floor dreams/<id>            # measure
    PYTHONPATH=pipeline python -m lucid.floor dreams/<id> --write    # shift by the measured amount
    PYTHONPATH=pipeline python -m lucid.floor dreams/<id> --shift -0.02 --write
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .gaussians import Gaussians, read_spz, write_spz


def lowest_solid(g: Gaussians, pct: float = 0.3) -> float:
    a = 1 / (1 + np.exp(-g.opacities))
    y = g.means[a > 0.5, 1] if (a > 0.5).sum() > 100 else g.means[:, 1]
    return float(np.percentile(y, pct))


def frame_paths(bundle: Path, dream: dict) -> list[Path]:
    f = dream.get("frames") or {}
    out = []
    for key in ("spz", "reality"):
        pattern = f.get(key)
        if pattern:
            out += [bundle / f.get("dir", "frames") / (pattern % i) for i in range(dream["frameCount"])]
    return [p for p in out if p.exists()]


def measure(bundle: Path, dream: dict) -> list[float]:
    pattern = (dream.get("frames") or {}).get("spz", "%06d.spz")
    return [lowest_solid(read_spz(bundle / "frames" / (pattern % i))) for i in range(dream["frameCount"])]


def shift_bundle(bundle: Path, dream: dict, dy: float) -> None:
    for p in frame_paths(bundle, dream):
        g = read_spz(p)
        g.means[:, 1] += dy
        write_spz(p, g)
    jp = bundle / "joints.json"
    if jp.exists():
        j = json.loads(jp.read_text())
        j["frames"] = [[[x, round(y + dy, 5), z] for x, y, z in fr] for fr in j["frames"]]
        jp.write_text(json.dumps(j))
    pp = bundle / "props.json"
    if pp.exists():
        props = json.loads(pp.read_text())
        for o in props.get("objects", []):
            if o.get("kind") == "basketball" and o.get("track"):
                o["track"] = [None if t is None else [t[0], round(t[1] + dy, 4), t[2]] for t in o["track"]]
        pp.write_text(json.dumps(props, indent=2))
    if dream.get("bounds"):
        for k in ("min", "max"):
            dream["bounds"][k][1] = round(dream["bounds"][k][1] + dy, 4)
    if dream.get("placement"):
        dream["placement"]["t"][1] = round(dream["placement"]["t"][1] + dy, 6)
    dream.setdefault("metrics", {})["floorShift"] = round(dy + (dream.get("metrics") or {}).get("floorShift", 0.0), 4)
    dream["updatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    (bundle / "dream.json").write_text(json.dumps(dream, indent=2))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("bundle", type=Path)
    p.add_argument("--shift", type=float, default=None, help="metres to move it up (+) or down (-); default: -lowest")
    p.add_argument("--write", action="store_true")
    a = p.parse_args(argv)
    dream = json.loads((a.bundle / "dream.json").read_text())
    lows = np.array(measure(a.bundle, dream))
    print(f"lowest solid point per frame: min {lows.min() * 100:.1f} cm, median {np.median(lows) * 100:.1f} cm, "
          f"max {lows.max() * 100:.1f} cm")
    dy = -float(lows.min()) if a.shift is None else a.shift
    print(f"shift {dy * 100:+.1f} cm" + ("" if a.write else " (not written: --write)"))
    if a.write and abs(dy) > 1e-4:
        shift_bundle(a.bundle, dream, dy)
        print("FLOOR_OK")


if __name__ == "__main__":
    main()
