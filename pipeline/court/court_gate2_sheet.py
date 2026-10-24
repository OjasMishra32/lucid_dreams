"""Gate-2 sheet: for each fetched Court Side run, the clip and 4DAnyone's views 00/04/08/12 (and any other views
fetched) at the freeze frame K (the whole fetched ring in two rows: the Janus / doubled-figure gate looks at every
view), and, when a freeze has been trained, its peeks (the real frame | render with its P42, its stance in court
space and the held-out --depth-view's PSNR, then the views' ground truth | render) and its bundle's orbit preview every
45 degrees (180 = the back of the head).

    python3 -I court_gate2_sheet.py --out gate2.jpg [--height 480] <run dir>...

A run dir is what a job copied back ($L/runs/<id>, or <id>/seed<k>): prepped.mp4, views/videos/NN.mp4, recon-*/.
K comes from <run>/court-run.json, else a recon's used.json, else --clips <local runs dir>/<id>/court-run.json (the id
is the run dir's name, or its parent's for a seed<k> folder). Missing pieces show as labelled grey tiles.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from court_grid_report import pick_runs  # noqa: E402  (one folder per seed: seed1-mgpu stands in for seed1)

VIEWS = ("00", "04", "08", "12")  # always shown (a missing one as a grey tile), with any other views fetched
GREY = (90, 90, 90)


def views_of(run: Path) -> list[str]:
    return sorted(set(VIEWS) | {p.stem for p in (run / "views" / "videos").glob("[0-9][0-9].mp4")})


def split_views(run: Path) -> tuple[list[str], list[str]]:
    """The ring in two halves (one row each). Which views show the player's back depends on the run (the ring follows
    4DAnyone's canonical body, not the camera), so the Janus / doubled-figure gate looks at all of them."""
    v = views_of(run)
    return v[:(len(v) + 1) // 2], v[(len(v) + 1) // 2:]


def run_id(run: Path) -> str:
    return run.parent.name if run.name.startswith("seed") else run.name


def find_k(run: Path, clips: Path | None) -> int | None:
    for p in [run / "court-run.json", *sorted(run.glob("recon-*/used.json")),
              *([clips / run_id(run) / "court-run.json"] if clips else [])]:
        if p.exists():
            return int(json.loads(p.read_text())["K"])
    return None


def frame_at(video: Path, n: int) -> np.ndarray | None:
    if not video.exists():
        return None
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-vf", f"select=eq(n\\,{n})", "-vframes", "1",
                        "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True)
    img = cv2.imdecode(np.frombuffer(p.stdout, np.uint8), cv2.IMREAD_COLOR) if p.stdout else None
    return img


def tile(img: np.ndarray | None, h: int, label: str, sub: str | list = "") -> np.ndarray:
    if img is None:
        t = np.full((h, h * 9 // 16, 3), GREY, np.uint8)
        label += " (missing)"
    else:
        t = cv2.resize(img, (max(1, round(img.shape[1] * h / img.shape[0])), h), interpolation=cv2.INTER_AREA)
    cv2.putText(t, label, (6, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2, cv2.LINE_AA)
    for i, line in enumerate([sub] if isinstance(sub, str) else sub):
        if line:
            cv2.putText(t, line, (6, 44 + 20 * i), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1, cv2.LINE_AA)
    return t


def stance_text(rec: Path) -> str:
    """court_stance.py's sole-to-sole stance in court space (along / across the source camera), vs the measured one."""
    if not (rec / "stance.json").exists():
        return ""
    st = json.loads((rec / "stance.json").read_text())
    ref = st.get("ref") or {}
    return f"stance {st['stance']:.2f} ({st['along']:.2f}/{st['across']:.2f})" + (
        f" vs {ref['stance']:.2f}" if "stance" in ref else "")


def depth_text(run: Path, rec: Path, depth_view: str | None) -> str:
    """The held-out PSNR of the real view that sees the source camera's depth axis (when this freeze held it out)."""
    if not depth_view:
        return ""
    from court_grid_report import held_out_views, report

    variant = re.fullmatch(r"recon-(.+)-\d+k", rec.name)
    if not variant:
        return ""
    v = held_out_views(run, variant.group(1), report(run / f"recon-metrics-{variant.group(1)}")[0]).get(depth_view)
    return f"held-out {depth_view} {v:.2f} dB" if v is not None else f"{depth_view} trained (not held out)"


def p42_text(rec: Path, clips: Path | None) -> str:
    """The freeze's P42 (court_p42.py): its p42.json, else measured now from its peek of the real frame."""
    if (rec / "p42.json").exists():
        r = json.loads((rec / "p42.json").read_text())
    elif any(rec.glob("recon-*.json")) and any(rec.glob("peek-source-*.jpg")):
        from court_p42 import check

        r = check(rec, clips)
    else:
        return ""
    return f"P42 {'PASS' if r.get('pass') else 'FAIL'} iou {r.get('iouFinal')}"


def rows_for(run: Path, h: int, clips: Path | None, depth_view: str | None = None) -> list[np.ndarray]:
    k = find_k(run, clips)
    name = f"{run_id(run)}{'/' + run.name if run.name.startswith('seed') else ''}"
    if k is None:
        return [tile(None, h, f"{name}: no K")]
    row = [tile(frame_at(run / "prepped.mp4", k), h, f"{name} clip k={k}")]
    first, second = split_views(run)
    row += [tile(frame_at(run / "views" / "videos" / f"{v}.mp4", k), h, f"view {v}") for v in first]
    out = [np.hstack(row), np.hstack([tile(frame_at(run / "views" / "videos" / f"{v}.mp4", k), h, f"view {v}")
                                      for v in second])]
    for rec in sorted(run.glob("recon-*")):
        if not rec.is_dir():
            continue
        peeks = [rec / f"peek-source-{k:06d}.jpg", rec / f"peek-{k:06d}.jpg"]
        if any(p.exists() for p in peeks):
            imgs = [cv2.imread(str(p)) if p.exists() else None for p in peeks]
            notes = [p42_text(rec, clips), stance_text(rec), depth_text(run, rec, depth_view)]
            out.append(np.hstack([tile(imgs[0], h, f"{rec.name} real | render", notes),
                                  tile(imgs[1], h, "views gt | render")]))
    for b in sorted(run.glob("bundle-*/preview.mp4")):
        out.append(orbit_row(b, h))
    return out


def frame_count(video: Path) -> int:
    p = subprocess.run(["ffprobe", "-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries",
                        "stream=nb_read_packets", "-of", "csv=p=0", str(video)], capture_output=True, text=True)
    return int(p.stdout.strip() or 0)


def orbit_row(preview: Path, h: int) -> np.ndarray:
    """A trained freeze from every side: its bundle's orbit preview (one turn, angle 0 = the person's front) every 45
    degrees. 180 is the back of the head: the Janus check on the 3D result itself."""
    n = frame_count(preview)
    tiles = []
    for i in range(8):
        label = f"{preview.parent.name} 0" if i == 0 else ("BACK 180" if i == 4 else str(45 * i))
        tiles.append(tile(frame_at(preview, n * i // 8) if n else None, h, label))
    return np.hstack(tiles)


def stack(rows: list[np.ndarray]) -> np.ndarray:
    w = max(r.shape[1] for r in rows)
    return np.vstack([np.pad(r, ((0, 4), (0, w - r.shape[1]), (0, 0))) for r in rows])


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("runs", type=Path, nargs="+")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--height", type=int, default=480)
    ap.add_argument("--clips", type=Path, default=None, help="local run folders, for K when the fetch has none")
    ap.add_argument("--depth-view", default=None, help="the real view that sees the source camera's depth axis: its "
                                                       "held-out PSNR goes on each freeze")
    a = ap.parse_args(argv)
    rows = [r for run in pick_runs(a.runs) for r in rows_for(run, a.height, a.clips, a.depth_view)]
    cv2.imwrite(str(a.out), stack(rows), [cv2.IMWRITE_JPEG_QUALITY, 90])
    print(f"{a.out}: {len(a.runs)} runs, {len(rows)} rows")


if __name__ == "__main__":
    main()
