"""The stance of each trained freeze at K in court space: sole to sole, along and across the source camera's line of
sight, the depth check of the pick (the source camera can't see depth; another camera's measure is the reference).

    python3 -I court_stance.py --clips <local run folders> [--ref stance,along,across] <fetched run or seed dir>...

The freeze (the recon's PLY, else its bundle's PLY taken back through dream.json's placement) is put into court space
through its solved camera (source-camera-<K>.json): every Gaussian keeps the pixel it had there, seen from the run's
still camera (court-run.json), and the depth along those rays is scaled until its soles stand on the floor. The soles
are its solid Gaussians within 4 cm of its lowest ones, split into two feet. Writes stance.json beside each recon's
json ({stance, along, across, soles, scale, ref}) and prints a line each. --ref carries the measured stance from the
private notes (never a default here).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from court_grid_report import pick_runs  # noqa: E402

SOLE_BAND = 0.04  # m above the lowest solid points
LOW_PCT = 0.5  # the lowest points: this percentile, so a stray Gaussian under the floor doesn't set it


def read_ply_xyz(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """(positions, opacity logits) from a binary little-endian 3DGS PLY of float properties."""
    data = Path(path).read_bytes()
    end = data.index(b"end_header\n") + len(b"end_header\n")
    head = data[:end].decode("ascii").splitlines()
    n = next(int(x.split()[2]) for x in head if x.startswith("element vertex"))
    names = [x.split()[2] for x in head if x.startswith("property float")]
    arr = np.frombuffer(data, dtype=np.dtype([(k, "<f4") for k in names]), count=n, offset=end)
    return np.stack([arr["x"], arr["y"], arr["z"]], 1).astype(float), arr["opacity"].astype(float)


def write_ply_xyz(path: Path, P: np.ndarray, opacity: np.ndarray):
    head = (f"ply\nformat binary_little_endian 1.0\nelement vertex {len(P)}\nproperty float x\nproperty float y\n"
            "property float z\nproperty float opacity\nend_header\n")
    rows = np.c_[P, opacity].astype("<f4")
    Path(path).write_bytes(head.encode("ascii") + rows.tobytes())


def to_court(P: np.ndarray, cam: dict, still: dict) -> np.ndarray:
    """Recon-world points -> court metres: same pixel in the still camera, depth scaled until the soles touch y = 0."""
    c2w = np.asarray(cam["camera_to_world"], float)
    Ks, Kc = np.asarray(cam["K"], float), np.asarray(still["K"], float)
    pc = (P - c2w[:3, 3]) @ c2w[:3, :3]  # solved camera's coordinates (x right, y down, z forward)
    H = np.linalg.inv(Kc) @ Ks  # the solved camera's pixel grid in the still camera's rays
    q = pc @ H.T
    R = np.asarray(still["R"], float)  # camera-from-world
    a = q @ R  # those rays in court axes, still at the recon's depth
    C = np.asarray(still["C"], float)
    lo = float(np.percentile(a[:, 1], LOW_PCT))
    if lo >= 0:
        raise ValueError("the still camera is not above the freeze's lowest points")
    return C + (-C[1] / lo) * a


def stance_of(X: np.ndarray, alpha: np.ndarray, cam_C) -> dict:
    """Sole to sole on the floor, split along / across the horizontal line from the soles to the camera."""
    S = X[alpha >= 0.5]
    lo = np.percentile(S[:, 1], LOW_PCT)
    soles = S[S[:, 1] <= lo + SOLE_BAND][:, [0, 2]]
    axis = np.linalg.svd(soles - soles.mean(0), full_matrices=False)[2][0]
    t = (soles - soles.mean(0)) @ axis
    c = np.stack([soles[t <= np.median(t)].mean(0), soles[t > np.median(t)].mean(0)])
    for _ in range(20):  # two feet: k-means from the two ends of the soles' long axis
        lab = np.argmin(((soles[:, None] - c[None]) ** 2).sum(-1), 1)
        c = np.stack([soles[lab == i].mean(0) if (lab == i).any() else c[i] for i in (0, 1)])
    mid = c.mean(0)
    view = mid - np.asarray(cam_C, float)[[0, 2]]
    view /= np.linalg.norm(view)
    d = c[1] - c[0]
    along = float(d @ view)
    return {"stance": round(float(np.linalg.norm(d)), 3), "along": round(abs(along), 3),
            "across": round(float(np.sqrt(max(0.0, d @ d - along * along))), 3),
            "soles": [[round(float(v), 3) for v in p] for p in c]}


def run_dir(rec: Path) -> Path:
    return rec.parent.parent if re.fullmatch(r"seed\d+(?:-[a-z0-9-]+)?", rec.parent.name) else rec.parent


def freeze_points(rec: Path, run: Path) -> tuple[np.ndarray, np.ndarray, dict] | None:
    """(points, opacity logits, the solved camera in their space): the recon's own PLY, else its bundle's."""
    cams = sorted(rec.glob("source-camera-*.json"))
    if not cams:
        return None
    cam = json.loads(cams[0].read_text())
    plys = sorted((rec / "frames").glob("*.ply"))
    if plys:
        P, op = read_ply_xyz(plys[0])
        return P, op, cam
    bundle = run / ("bundle-" + rec.name[len("recon-"):])
    plys = sorted((bundle / "frames").glob("*.ply"))
    if not plys or not (bundle / "dream.json").exists():
        return None
    pl = json.loads((bundle / "dream.json").read_text())["placement"]
    rot, t = np.asarray(pl["rot"], float), np.asarray(pl["t"], float)
    c2w = np.asarray(cam["camera_to_world"], float)
    c2w[:3, :3], c2w[:3, 3] = rot @ c2w[:3, :3], rot @ c2w[:3, 3] + t
    P, op = read_ply_xyz(plys[0])
    return P, op, {**cam, "camera_to_world": c2w.tolist()}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("runs", type=Path, nargs="+")
    ap.add_argument("--clips", type=Path, required=True, help="the local run folders (their court-run.json)")
    ap.add_argument("--ref", default=None, help="the measured stance, along, across (m), from the private notes")
    a = ap.parse_args(argv)
    ref = dict(zip(("stance", "along", "across"), map(float, a.ref.split(",")))) if a.ref else None
    for run in pick_runs(a.runs):
        for rec in sorted(run.glob("recon-*")):
            if not (rec.is_dir() and re.fullmatch(r"recon-(?!metrics)(.+)-(\d+k)", rec.name)):
                continue
            got = freeze_points(rec, run)
            cr = a.clips / run_dir(rec).name / "court-run.json"
            if got is None or not cr.exists():
                print(f"{run.name} {rec.name}: no PLY, solved camera or court-run.json: no stance")
                continue
            P, op, cam = got
            still = json.loads(cr.read_text())["still"]
            X = to_court(P, cam, still)
            out = stance_of(X, 1 / (1 + np.exp(-op)), still["C"]) | {"ref": ref}
            (rec / "stance.json").write_text(json.dumps(out, indent=1))
            vs = f" (measured {ref['stance']}: {out['stance'] - ref['stance']:+.2f} m)" if ref else ""
            print(f"{run_dir(rec).name}/{run.name} {rec.name}: stance {out['stance']} m, along {out['along']} / "
                  f"across {out['across']}{vs}")


if __name__ == "__main__":
    main()
