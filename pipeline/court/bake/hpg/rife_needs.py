"""The RIFE job's input list: every in-between the show needs, from bake-core's timeline (Mac side).

Collects (a, b, w) from every interp frame of the 72 Hz and 90 Hz timelines (strobe replacements included, and each
strobe's own neighbour in-between in case a consumer cleans that frame directly), deduplicated, plus held-out checks
(a, m, c): real frames a < m < c, consecutive usable ones, where RIFE's a -> c at m's time is scored against the real m.
Writes needs.json (interp.write_needs: each pair's output file name) and frames.txt (the frame files to upload).

    python3 pipeline/court/bake/hpg/rife_needs.py --out <private bake dir>/rife [--config bake_config.json]
        [--play-start N] [--frames-dir DIR]   (config default: bake.config.load())
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import sys
from pathlib import Path

_COURT = Path(__file__).resolve().parents[2]
if str(_COURT) not in sys.path:
    sys.path.insert(0, str(_COURT))
from bake import captime, config, interp, timeline  # noqa: E402


def strobe_pairs(cap: captime.CapTime):
    out = []
    for s in sorted(cap.strobes):
        if not cap.is_real(s):
            continue
        a = max(u for u in cap.usable_frames if u < s)
        b = min(u for u in cap.usable_frames if u > s)
        ta, tb = cap.time_of(a), cap.time_of(b)
        out.append((a, b, (cap.time_of(s) - ta) / (tb - ta)))
    return out


def holdout_checks(cap: captime.CapTime, lo: int, hi: int, n: int = 24):
    u = [s for s in cap.usable_frames if lo <= s <= hi]
    trip = [(u[i - 1], u[i], u[i + 1]) for i in range(1, len(u) - 1)]
    if not trip:
        return []
    step = max(1, len(trip) // n)
    out = []
    for a, m, c in trip[::step][:n]:
        ta, tm, tc = cap.time_of(a), cap.time_of(m), cap.time_of(c)
        out.append((a, m, c, (tm - ta) / (tc - ta)))
    return out


def needs(cfg: config.BakeConfig):
    cap = captime.CapTime.from_config(cfg)
    pairs, counts = [], {}
    for hz in cfg.display_hz:
        tl = timeline.build(cfg, hz, cap)
        ip = [(f.a, f.b, f.w) for f in tl.frames if f.interp]
        counts[hz] = {"frames": len(tl.frames), "interp": len(ip)}
        pairs += ip
    pairs += strobe_pairs(cap)
    lo = min(min(a, b) for a, b, _ in pairs) if pairs else cfg.play_start
    hi = max(max(a, b) for a, b, _ in pairs) if pairs else cfg.clip_end
    return pairs, holdout_checks(cap, lo, hi), counts


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--config", type=Path, default=None)
    ap.add_argument("--play-start", type=int, default=None, help="override BakeConfig.play_start")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--frames-dir", type=Path, default=None, help="to report the upload size")
    ap.add_argument("--pattern", default="{src:06d}.jpg")
    ap.add_argument("--ext", default=".jpg", help="the job's output format (.jpg q95 or .png)")
    a = ap.parse_args(argv)
    cfg = config.load(a.config)
    if a.play_start is not None:
        cfg = dataclasses.replace(cfg, play_start=a.play_start)
    pairs, checks, counts = needs(cfg)
    man = interp.write_needs(pairs, a.out / "needs.json", frame_pattern=a.pattern, ext=a.ext, checks=checks)
    names = [a.pattern.format(src=s) for s in man["frames"]]
    (a.out / "frames.txt").write_text("\n".join(names) + "\n")
    rep = {"timelines": counts, "inbetweens": len(man["pairs"]), "checks": len(man["checks"]),
           "frames": len(names), "range": [man["frames"][0], man["frames"][-1]] if names else None}
    if a.frames_dir is not None:
        missing = [n for n in names if not (a.frames_dir / n).exists()]
        rep["upload_mb"] = round(sum((a.frames_dir / n).stat().st_size for n in names if (a.frames_dir / n).exists()) / 1e6, 1)
        rep["missing"] = missing[:10]
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
