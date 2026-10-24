"""The freeze grid's numbers side by side, one row per run (or seed) and variant, from each recon's own report.

    python3 court_grid_report.py [--rank] [--pick [--depth-view NAME] [--sweep ROOT]] <run dir>...
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
source camera's depth axis; "stance" instead ranks by court_stance.py's distance to the measured stance, for runs
where that view never solved), then the rest; the last word is the eye. --sweep ROOT adds qa-sweep's verdict per
freeze (ROOT/**/sweep.json, matched by run, seed and bundle): more than one face in any of its views drops the freeze
like a P42 failure, and its worst-view floater score breaks ties, after the views and the depth view are compared in
steps (0.25 dB; 2 cm of stance) and in qa-sweep's own steps of half a percent of the body.
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

DB_STEP, STANCE_STEP, FLOATER_STEP = 0.25, 0.02, 0.005  # what counts as a tie before the next key decides


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
               "reals": int(reals.group(1)) if reals else None, "sweep": None}


def load_sweeps(root: Path) -> dict:
    """{(run id, seed folder or "", recon folder): qa-sweep's summary} from every sweep.json under root (its candidate
    name is <run id>/[<seed>/]bundle-<variant>-<cap>k/<frame>)."""
    out = {}
    for f in sorted(Path(root).rglob("sweep.json")):
        sw = json.loads(f.read_text())
        parts = sw.get("name", "").split("/")
        if len(parts) not in (3, 4) or not parts[-2].startswith("bundle-"):
            continue
        rid, seed = parts[0], parts[1] if len(parts) == 4 else ""
        out[(rid, seed, "recon-" + parts[-2][len("bundle-"):])] = sw["summary"] | {"complete": sw.get("complete", True)}
    return out


def pick_order(table: list[dict], depth_view: str | None = None, margin: float = 0.5) -> list[dict]:
    """One run's freezes in pick order (the eye gate comes first, by hand): see the module's --pick."""
    ok = [r for r in table if not (r["p42"] is not None and not r["p42"].get("pass"))
          and not (r.get("sweep") and r["sweep"].get("max_faces", 0) > 1)]
    r01 = [r for r in ok if r["reals"] in (0, 1)]
    r2 = [r for r in ok if (r["reals"] or 0) >= 2]
    best = max((r["views"] for r in r01 if r["views"] is not None), default=None)
    first = [r for r in r2 if r["views"] is not None and (best is None or r["views"] >= best - margin)]
    def depth(r):  # higher is better: a held-out view's PSNR, or how close the stance is to the measured one
        if depth_view == "stance":
            st = r["stance"] or {}
            ref = (st.get("ref") or {}).get("stance")
            return -abs(st["stance"] - ref) if ref is not None and "stance" in st else None
        return r["byView"].get(depth_view) if depth_view else r["realHeld"]
    neg = lambda v: -v if v is not None else float("inf")  # noqa: E731
    step = lambda v, d: None if v is None else math.floor(v / d)  # noqa: E731
    dstep = STANCE_STEP if depth_view == "stance" else DB_STEP
    def floater(r):  # qa-sweep's worst-view floater share of the body, in its own steps (none swept: last)
        return math.floor(r["sweep"]["worst_floater_frac"] / FLOATER_STEP) if r.get("sweep") else math.inf
    by_views = lambda r: (neg(step(r["views"], DB_STEP)), floater(r), neg(r["views"]))  # noqa: E731
    return (sorted(first, key=by_views)
            + sorted(r01, key=lambda r: (neg(step(depth(r), dstep)), floater(r), neg(r["views"])))
            + sorted([r for r in r2 if r not in first], key=by_views))


def main(argv=None):
    args = list(argv if argv is not None else sys.argv[1:])
    rank, pick = "--rank" in args, "--pick" in args
    depth_view = args[args.index("--depth-view") + 1] if "--depth-view" in args else None
    sweep = args[args.index("--sweep") + 1] if "--sweep" in args else None
    skip = {"--rank", "--pick", "--depth-view", depth_view, "--sweep", sweep}
    runs = pick_runs([Path(p) for p in args if p not in skip])
    table = [r for run in runs for r in rows(run)]
    sweeps = load_sweeps(Path(sweep)) if sweep else {}
    for r in table:
        r["sweep"] = sweeps.get((r["id"], r["seed"], r["recon"]))
    if rank:
        neg = lambda v: -v if v is not None else float("inf")  # noqa: E731
        table.sort(key=lambda r: (neg(r["realHeld"]), neg(r["views"]), neg(r["iou"])))
    for r in table:
        r["byViewText"] = " ".join(f"{n} {v:.2f}" for n, v in r["byView"].items()) or None
        r["p42Text"] = (f"{'PASS' if r['p42'].get('pass') else 'FAIL'} {r['p42'].get('iouFinal', 0):.3f}"
                        if r["p42"] else None)
        st = r["stance"]
        r["stanceText"] = f"{st['stance']:.2f} ({st['along']:.2f}/{st['across']:.2f})" if st else None
        sw = r["sweep"]
        r["sweepText"] = (f"{sw['max_faces']} / {100 * sw['worst_floater_frac']:.1f}%{'' if sw.get('complete') else ' (part)'}"
                          if sw else None)
    head = ["run", "variant", "cap", "held-out real dB", "by view", "held-out views dB", "views SSIM", "real A dB",
            "face dB", "iou", "P42", "stance m (along/across)", "faces / floaters", "focal", "held", "gaussians"]
    keys = ["run", "variant", "cap", "realHeld", "byViewText", "views", "ssim", "realA", "face", "iou", "p42Text",
            "stanceText", "sweepText", "focal", "held", "gaussians"]
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
