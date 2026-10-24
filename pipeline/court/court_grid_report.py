"""The freeze grid's numbers side by side, one row per run and variant, from each recon's own report.

    python3 court_grid_report.py <run dir>...      (e.g. $L/runs/court-*)

held-out = PSNR/SSIM on every 8th generated view, left out of training (the metrics recon); real = PSNR against the
real 4K frame on its non-ignored pixels; face = the same on the face crop; iou = the real camera's silhouette match
when it was solved; focal = the focal it ended with (focalHeld: ours, held). Missing numbers print as "-".
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def first_frame(path: Path) -> tuple[dict, dict]:
    files = sorted(path.glob("recon-*.json"))
    if not files:
        return {}, {}
    rep = json.loads(files[0].read_text())
    return (rep.get("frames") or [{}])[0], rep.get("source") or {}


def fmt(v, nd=2):
    return "-" if v is None else (f"{v:.{nd}f}" if isinstance(v, float) else str(v))


def rows(run: Path):
    for d in sorted(run.glob("recon-*")):
        m = re.fullmatch(r"recon-(?!metrics)(.+?)-(\d+k)", d.name)
        if not m:
            continue
        variant, cap = m.groups()
        fr, src = first_frame(d)
        held, _ = first_frame(run / f"recon-metrics-{variant}")
        yield [run.name, variant, cap, fmt(held.get("psnr")), fmt(held.get("ssim"), 3), fmt(fr.get("sourcePsnr")),
               fmt(fr.get("facePsnr")), fmt(src.get("iou"), 3), fmt(src.get("focal"), 1), fmt(src.get("focalHeld")),
               fmt(fr.get("gaussians"))]


def main(argv=None):
    runs = [Path(p) for p in (argv if argv is not None else sys.argv[1:])]
    head = ["run", "variant", "cap", "held-out dB", "held SSIM", "real dB", "face dB", "iou", "focal", "held", "gaussians"]
    table = [head] + [r for run in runs for r in rows(run)]
    widths = [max(len(r[i]) for r in table) for i in range(len(head))]
    for r in table:
        print("  ".join(c.ljust(w) for c, w in zip(r, widths)))


if __name__ == "__main__":
    main()
