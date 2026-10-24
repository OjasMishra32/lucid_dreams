"""P42 for each trained freeze: did it keep the real frame's camera and its silhouette?

    python3 -I court_p42.py [--clips <local run folders>] <fetched run or seed dir>...

Per freeze recon (recon-<variant>-<cap>k) it passes when the focal was held at the run's FOCAL (focalHeld, focal ==
used.json's FOCAL: the wrong-focal guard) and the trained render from its solved camera covers the real mask at K with
IoU >= 0.95 (iouFinal). Both silhouettes come from the recon's own peek-source-<K>.jpg (the real crop with its mask |
the render, on one plain background); pixels the recon ignored (that run's ignore/<K>.png, which holds the people in
front and the band along the player's edge) don't count when --clips has the run's local folder. iouSolve is the
camera solver's IoU before the real frame trained anything: a diagnostic only. Writes p42.json beside each recon's
json and prints a line each. A seed re-run under a tag (seed1-mgpu) stands in for its seed.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from court_grid_report import pick_runs  # noqa: E402

BAR = 0.95
FOCAL_TOL = 0.05  # px: focal and FOCAL are both written to a tenth


def silhouette(img: np.ndarray, bg: np.ndarray, thr: int = 16) -> np.ndarray:
    """Everything not connected to the border through background-coloured pixels (a white kit inside stays body)."""
    off = (np.abs(img.astype(int) - bg.astype(int)).max(2) > thr).astype(np.uint8)
    h, w = off.shape
    flood = np.pad(1 - off, 1, constant_values=1).astype(np.uint8)
    cv2.floodFill(flood, None, (0, 0), 2)
    return flood[1:h + 1, 1:w + 1] != 2


def run_dir(rec: Path) -> Path:
    return rec.parent.parent if re.fullmatch(r"seed\d+(?:-[a-z0-9-]+)?", rec.parent.name) else rec.parent


def ignore_for(rec: Path, k: int, source: dict, clips: Path | None) -> np.ndarray | None:
    """The run's ignore at K cut and scaled like the recon's crop of the real frame, or None."""
    if clips is None:
        return None
    p = clips / run_dir(rec).name / "ignore" / f"{k:06d}.png"
    ig = cv2.imread(str(p), cv2.IMREAD_GRAYSCALE)
    if ig is None or "crop" not in source or "size" not in source:
        return None
    x0, y0, x1, y1 = source["crop"]
    w, h = source["size"]
    return cv2.resize(ig[y0:y1, x0:x1], (w, h), interpolation=cv2.INTER_AREA) >= 128


def check(rec: Path, clips: Path | None = None) -> dict:
    rep = json.loads(next(rec.glob("recon-*.json")).read_text())
    src = rep.get("source") or {}
    used = json.loads((rec / "used.json").read_text()) if (rec / "used.json").exists() else {}
    k = int(used.get("K", (rep.get("frames") or [{}])[0].get("frame", -1)))
    out = {"K": k, "iouSolve": src.get("iou"), "focalHeld": bool(src.get("focalHeld")), "focal": src.get("focal"),
           "FOCAL": used.get("FOCAL"), "iouFinal": None, "ignoreApplied": False, "bar": BAR}
    peek = cv2.imread(str(rec / f"peek-source-{k:06d}.jpg"))
    if peek is not None:
        w = peek.shape[1] // 2
        real, render = peek[:, :w], peek[:, w:2 * w]
        bg = np.median(np.concatenate([real[:4].reshape(-1, 3), real[-4:].reshape(-1, 3)]), 0)
        a, b = silhouette(real, bg), silhouette(render, bg)
        valid = np.ones_like(a)
        ig = ignore_for(rec, k, src, clips)
        if ig is not None and ig.shape == a.shape:
            valid, out["ignoreApplied"] = ~ig, True
        union = ((a | b) & valid).sum()
        out["iouFinal"] = round(float((a & b & valid).sum() / union), 4) if union else None
    focal_ok = (out["focalHeld"] and out["focal"] is not None and out["FOCAL"] is not None
                and abs(float(out["focal"]) - float(out["FOCAL"])) <= FOCAL_TOL)
    out["pass"] = bool(focal_ok and out["iouFinal"] is not None and out["iouFinal"] >= BAR)
    return out


def freeze_recons(run: Path) -> list[Path]:
    return [d for d in sorted(run.glob("recon-*"))
            if d.is_dir() and re.fullmatch(r"recon-(?!metrics)(.+)-(\d+k)", d.name)]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("runs", type=Path, nargs="+")
    ap.add_argument("--clips", type=Path, default=None, help="the local run folders (their ignore/<K>.png)")
    a = ap.parse_args(argv)
    for run in pick_runs(a.runs):
        for rec in freeze_recons(run):
            r = check(rec, a.clips)
            (rec / "p42.json").write_text(json.dumps(r, indent=1))
            name = f"{run_dir(rec).name}/{run.name}" if run != run_dir(rec) else run.name
            print(f"{name} {rec.name}: P42 {'PASS' if r['pass'] else 'FAIL'}  iouFinal {r['iouFinal']}"
                  f"{'' if r['ignoreApplied'] else ' (no ignore)'}  iouSolve {r['iouSolve']}  focal {r['focal']}"
                  f" (FOCAL {r['FOCAL']}, held {r['focalHeld']})")


if __name__ == "__main__":
    main()
