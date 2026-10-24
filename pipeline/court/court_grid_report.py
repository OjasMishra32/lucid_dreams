"""The freeze grid's numbers side by side, one row per run (or seed) and variant, from each recon's own report.

    python3 court_grid_report.py [--rank] <run dir>...      (e.g. $L/runs/court-*  or  $L/runs/court-main-s2/seed*)

held-out real = PSNR on the real views a variant did NOT train on (its metrics recon carries them at weight 0); views =
PSNR/SSIM on every 8th generated view, left out (the metrics recon); real A = PSNR against A's 4K frame on its
non-ignored pixels; face = the same on the face crop; iou = A's silhouette match when solved; focal = the focal it ended
with (held: ours). --rank sorts best first: held-out real, then held-out views, then iou. Missing numbers print "-".
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def report(path: Path) -> tuple[dict, dict]:
    files = sorted(path.glob("recon-*.json"))
    if not files:
        return {}, {}
    rep = json.loads(files[0].read_text())
    return (rep.get("frames") or [{}])[0], rep.get("source") or {}


def held_out_real(run: Path, variant: str, frame: dict) -> float | None:
    xs = run / f"recon-metrics-{variant}.extra.json"
    if not xs.exists():
        return None
    names = [Path(e["video"]).stem for e in json.loads(xs.read_text()) if not e.get("weight")]
    vals = [frame[f"sourcePsnr.{n}"] for n in names if f"sourcePsnr.{n}" in frame]
    return sum(vals) / len(vals) if vals else None


def fmt(v, nd=2):
    return "-" if v is None else (f"{v:.{nd}f}" if isinstance(v, float) else str(v))


def rows(run: Path):
    label = f"{run.parent.name}/{run.name}" if run.name.startswith("seed") else run.name
    for d in sorted(run.glob("recon-*")):
        m = re.fullmatch(r"recon-(?!metrics)(.+)-(\d+k)", d.name)
        if not m or not d.is_dir():
            continue
        variant, cap = m.groups()
        fr, src = report(d)
        held, _ = report(run / f"recon-metrics-{variant}")
        yield {"run": label, "variant": variant, "cap": cap, "realHeld": held_out_real(run, variant, held),
               "views": held.get("psnr"), "ssim": held.get("ssim"), "realA": fr.get("sourcePsnr"),
               "face": fr.get("facePsnr"), "iou": src.get("iou"), "focal": src.get("focal"), "held": src.get("focalHeld"),
               "gaussians": fr.get("gaussians")}


def main(argv=None):
    args = list(argv if argv is not None else sys.argv[1:])
    rank = "--rank" in args
    runs = [Path(p) for p in args if p != "--rank"]
    table = [r for run in runs for r in rows(run)]
    if rank:
        neg = lambda v: -v if v is not None else float("inf")  # noqa: E731
        table.sort(key=lambda r: (neg(r["realHeld"]), neg(r["views"]), neg(r["iou"])))
    head = ["run", "variant", "cap", "held-out real dB", "held-out views dB", "views SSIM", "real A dB", "face dB",
            "iou", "focal", "held", "gaussians"]
    keys = ["run", "variant", "cap", "realHeld", "views", "ssim", "realA", "face", "iou", "focal", "held", "gaussians"]
    nd = {"ssim": 3, "iou": 3, "focal": 1}
    out = [head] + [[fmt(r[k], nd.get(k, 2)) for k in keys] for r in table]
    widths = [max(len(r[i]) for r in out) for i in range(len(head))]
    for r in out:
        print("  ".join(c.ljust(w) for c, w in zip(r, widths)))


if __name__ == "__main__":
    main()
