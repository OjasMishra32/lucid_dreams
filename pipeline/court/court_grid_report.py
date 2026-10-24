"""The freeze grid's numbers side by side, one row per run (or seed) and variant, from each recon's own report.

    python3 court_grid_report.py [--rank] [--pick [--depth-view NAME]] <run dir>...
        (e.g. $L/runs/court-*  or  $L/runs/court-main-s2/seed*)

A seed re-run under a tag (seed1-mgpu, or any seed<N>-<tag>) stands in for seed N: of the folders for one seed, the
one with results is used, the newest when several have them, so no seed is counted twice.

held-out real = PSNR on the real views a variant did NOT train on (its metrics recon carries them at weight 0); views =
PSNR/SSIM on every 8th generated view, left out (the metrics recon); real A = PSNR against A's 4K frame on its
non-ignored pixels; face = the same on the face crop; iou = A's silhouette match when solved; focal = the focal it ended
with (held: ours); by view = each held-out real view's PSNR; P42 and stance = court_p42.py's and court_stance.py's files
beside the recon, when made. --rank sorts best first: held-out real, then held-out views, then iou. Missing numbers
print "-". --pick then orders each run's freezes, after the eye gate (no Janus face, no doubled figure: by eye on the
gate sheet): a P42 failure drops out; an r2 freeze (trained on every real view) comes first when its held-out views PSNR
is within 0.5 dB of the best r0/r1; the r0/r1 ones follow, ranked by --depth-view (the held-out real view that sees the
source camera's depth axis), then the rest; the last word is the eye.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def seed_of(run: Path) -> int | None:
    m = re.fullmatch(r"seed(\d+)(?:-[a-z0-9-]+)?", run.name)
    return int(m.group(1)) if m else None


def _results(run: Path) -> tuple[int, float]:
    files = [f for f in run.rglob("*") if f.is_file()]
    done = any(run.glob("recon-*/recon-*.json")) * 2 + any(run.glob("views/videos/*.mp4"))
    return done, max((f.stat().st_mtime for f in files), default=0.0)


def pick_runs(runs: list[Path]) -> list[Path]:
    """One folder per (run, seed): the one with results (recons over views over nothing), then the newest."""
    best: dict = {}
    for r in runs:
        key = (str(r.parent), seed_of(r)) if seed_of(r) is not None else (str(r), None)
        if key not in best or _results(r) > _results(best[key]):
            best[key] = r
    keep = set(map(str, best.values()))
    return [r for r in runs if str(r) in keep]


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


def held_out_views(run: Path, variant: str, frame: dict) -> dict:
    xs = run / f"recon-metrics-{variant}.extra.json"
    if not xs.exists():
        return {}
    names = [Path(e["video"]).stem for e in json.loads(xs.read_text()) if not e.get("weight")]
    return {n: frame[f"sourcePsnr.{n}"] for n in names if f"sourcePsnr.{n}" in frame}


def _json(path: Path) -> dict | None:
    return json.loads(path.read_text()) if path.exists() else None


def fmt(v, nd=2):
    return "-" if v is None else (f"{v:.{nd}f}" if isinstance(v, float) else str(v))


def rows(run: Path):
    seeded = seed_of(run) is not None
    label = f"{run.parent.name}/{run.name}" if seeded else run.name
    for d in sorted(run.glob("recon-*")):
        m = re.fullmatch(r"recon-(?!metrics)(.+)-(\d+k)", d.name)
        if not m or not d.is_dir():
            continue
        variant, cap = m.groups()
        fr, src = report(d)
        held, _ = report(run / f"recon-metrics-{variant}")
        reals = re.search(r"-r(\d+)$", variant)
        yield {"run": label, "variant": variant, "cap": cap, "realHeld": held_out_real(run, variant, held),
               "views": held.get("psnr"), "ssim": held.get("ssim"), "realA": fr.get("sourcePsnr"),
               "face": fr.get("facePsnr"), "iou": src.get("iou"), "focal": src.get("focal"), "held": src.get("focalHeld"),
               "gaussians": fr.get("gaussians"), "byView": held_out_views(run, variant, held),
               "p42": _json(d / "p42.json"), "stance": _json(d / "stance.json"), "recon": d.name,
               "id": run.parent.name if seeded else run.name, "seed": run.name if seeded else "",
               "reals": int(reals.group(1)) if reals else None}


def pick_order(table: list[dict], depth_view: str | None = None, margin: float = 0.5) -> list[dict]:
    """One run's freezes in pick order (the eye gate comes first, by hand): see the module's --pick."""
    ok = [r for r in table if not (r["p42"] is not None and not r["p42"].get("pass"))]
    r01 = [r for r in ok if r["reals"] in (0, 1)]
    r2 = [r for r in ok if (r["reals"] or 0) >= 2]
    best = max((r["views"] for r in r01 if r["views"] is not None), default=None)
    first = [r for r in r2 if r["views"] is not None and (best is None or r["views"] >= best - margin)]
    depth = lambda r: r["byView"].get(depth_view) if depth_view else r["realHeld"]  # noqa: E731
    neg = lambda v: -v if v is not None else float("inf")  # noqa: E731
    return (sorted(first, key=lambda r: neg(r["views"])) + sorted(r01, key=lambda r: (neg(depth(r)), neg(r["views"])))
            + sorted([r for r in r2 if r not in first], key=lambda r: neg(r["views"])))


def main(argv=None):
    args = list(argv if argv is not None else sys.argv[1:])
    rank, pick = "--rank" in args, "--pick" in args
    depth_view = args[args.index("--depth-view") + 1] if "--depth-view" in args else None
    skip = {"--rank", "--pick", "--depth-view", depth_view}
    runs = pick_runs([Path(p) for p in args if p not in skip])
    table = [r for run in runs for r in rows(run)]
    if rank:
        neg = lambda v: -v if v is not None else float("inf")  # noqa: E731
        table.sort(key=lambda r: (neg(r["realHeld"]), neg(r["views"]), neg(r["iou"])))
    for r in table:
        r["byViewText"] = " ".join(f"{n} {v:.2f}" for n, v in r["byView"].items()) or None
        r["p42Text"] = (f"{'PASS' if r['p42'].get('pass') else 'FAIL'} {r['p42'].get('iouFinal', 0):.3f}"
                        if r["p42"] else None)
        st = r["stance"]
        r["stanceText"] = f"{st['stance']:.2f} ({st['along']:.2f}/{st['across']:.2f})" if st else None
    head = ["run", "variant", "cap", "held-out real dB", "by view", "held-out views dB", "views SSIM", "real A dB",
            "face dB", "iou", "P42", "stance m (along/across)", "focal", "held", "gaussians"]
    keys = ["run", "variant", "cap", "realHeld", "byViewText", "views", "ssim", "realA", "face", "iou", "p42Text",
            "stanceText", "focal", "held", "gaussians"]
    nd = {"ssim": 3, "iou": 3, "focal": 1}
    out = [head] + [[fmt(r[k], nd.get(k, 2)) for k in keys] for r in table]
    widths = [max(len(r[i]) for r in out) for i in range(len(head))]
    for r in out:
        print("  ".join(c.ljust(w) for c, w in zip(r, widths)))
    if pick:
        for rid in dict.fromkeys(r["id"] for r in table):
            order = pick_order([r for r in table if r["id"] == rid], depth_view)
            print(f"pick {rid}: " + "  ".join(f"{i}. {(r['seed'] + ' ') if r['seed'] else ''}{r['recon']}"
                                             for i, r in enumerate(order, 1))
                  + "  (after the eye gate; the eye has the last word)")


if __name__ == "__main__":
    main()
