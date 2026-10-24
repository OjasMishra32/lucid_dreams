"""Cleaner replays: drop the Gaussians a person isn't made of, frame by frame, from a finished bundle.

A replay trained frame to frame (each frame warm-started from the one before) keeps things no camera saw: a faint copy
of a leg or a head where it was a moment ago, specks and floaters off the body, faint smears reaching past the
silhouette. They cost the training little, so they stay. A person is inside their silhouette from every side, and
lucid.clean_support (GPU, HiPerGator) asks the cameras about every Gaussian; a Gaussian goes only when a test says so:

  outside  the clip's own camera (solved in reconstruction, or refined per frame) sees it outside the real person,
           and so do over 1 - OUTSIDE_SHARE of 4DAnyone's generated views (the masks the reconstruction trained on)
  hull     where the real camera can't tell (out of its picture, or no camera solved): inside the silhouette in under
           HULL_SHARE of the views
  smear    a faint (alpha < SMEAR_ALPHA), long (sigma > SMEAR_SIZE_M) Gaussian, not inside the real person, whose
           axis ends are outside the silhouette in most views
  island   a small clump (summed alpha < ISLAND_MAX_MASS) not attached to the body, on a 2 cm voxel grid, and (with
           cameras) outside the silhouette in over 1 - ISLAND_SHARE of the views: a person is a shell, and a clump
           inside every silhouette is their inside, not a speck. The only test that runs without --support

Nothing the real camera saw on the person's surface goes (it outranks the generated views), and nothing within
KEEP_BALL_M of the tracked basketball (props.json). Either camera alone isn't enough: where 4DAnyone's generated person
and the real one disagree (a fast limb a few centimetres apart), the reconstruction holds both, and dropping what one
side doesn't support leaves a stump on the other (measured: the real camera alone took a whole shin and shoe).

The same Gaussians go from <frame>.spz and <frame>.reality.spz (the "seen vs imagined" copy): their SPZ arrays are
subset as stored, never re-encoded, so what stays is bit-identical. What was dropped, by which test, goes in dream.json's metrics.cleanup.

    PYTHONPATH=pipeline python -m lucid.clean dreams/<id> --support support.npz                  # report only
    PYTHONPATH=pipeline python -m lucid.clean dreams/<id> --support support.npz --keep-out k.npz # for lucid.clean_check
    PYTHONPATH=pipeline python -m lucid.clean dreams/<id> --support support.npz --write [--note check.json]

--write copies every frame it changes to <bundle>/../.clean-backup/<id>/ first and refuses a bundle cleaned already
(metrics.cleanup), so cleaning never compounds. Then regenerate preview.mp4 / thumb.jpg with lucid.hero (a GPU).
The proof, before and after against the real frames: lucid.clean_check (HiPerGator, pipeline/hpg/clean-check.sbatch).
"""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
import struct
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .gaussians import SPZ_MAGIC, Gaussians, read_spz

JOINTS = ["pelvis", "left_hip", "right_hip", "spine1", "left_knee", "right_knee", "spine2", "left_ankle", "right_ankle",
          "spine3", "left_foot", "right_foot", "neck", "left_collar", "right_collar", "head", "left_shoulder",
          "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist"]
J = {n: i for i, n in enumerate(JOINTS)}


@dataclass
class Settings:
    outside_share: float = 0.7  # outside: the real camera says outside the person, and so do over 30% of the views
    hull_share: float = 0.5  # where the real camera can't tell: inside the silhouette in under half the views
    min_views: int = 8  # views are counted only where at least this many have the Gaussian in their picture
    spare_seen: bool = True  # nothing the real camera saw on the person's surface is dropped (it outranks the views)
    smear_share: float = 0.5  # smear: both axis ends inside the silhouette in under this share of the views,
    smear_alpha: float = 0.2  # on a faint (alpha under this)
    smear_size_m: float = 0.015  # and long (sigma over this) Gaussian
    island_voxel_m: float = 0.02
    island_alpha: float = 0.05  # a Gaussian counts toward the voxel grid from this alpha
    island_max_mass: float = 40.0  # summed alpha of a detached clump that may go (the body is ~10^4)
    island_share: float = 0.85  # ...and, with cameras, outside the silhouette in more than 15% of the views
    far_m: float = 0.6  # outside the joints' capsules by more than this (only with --tests far)
    keep_ball_m: float = 0.2  # round the tracked ball: never dropped
    tests: tuple = ("outside", "hull", "smear", "island")


# ---------------------------------------------------------------------------------------------------------------
# the body: capsules round the joints (metres; radii are the limb plus the joints' few centimetres of error)


def capsules(j: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(a [C,3], b [C,3], radius [C]) for one frame's 22 joints."""
    p = lambda n: np.asarray(j[J[n]], float)  # noqa: E731
    unit = lambda v: v / max(np.linalg.norm(v), 1e-6)  # noqa: E731
    segs = [("pelvis", "spine1", 0.16), ("spine1", "spine2", 0.17), ("spine2", "spine3", 0.17), ("spine3", "neck", 0.13),
            ("pelvis", "left_hip", 0.13), ("pelvis", "right_hip", 0.13), ("left_hip", "left_shoulder", 0.12),
            ("right_hip", "right_shoulder", 0.12), ("spine3", "left_collar", 0.12), ("spine3", "right_collar", 0.12),
            ("left_collar", "left_shoulder", 0.11), ("right_collar", "right_shoulder", 0.11),
            ("left_hip", "left_knee", 0.10), ("right_hip", "right_knee", 0.10), ("left_knee", "left_ankle", 0.08),
            ("right_knee", "right_ankle", 0.08), ("left_shoulder", "left_elbow", 0.08),
            ("right_shoulder", "right_elbow", 0.08), ("left_elbow", "left_wrist", 0.065),
            ("right_elbow", "right_wrist", 0.065), ("neck", "head", 0.09)]
    a = [p(x) for x, _, _ in segs]
    b = [p(y) for _, y, _ in segs]
    r = [rad for _, _, rad in segs]
    for side in ("left", "right"):
        ankle, foot = p(f"{side}_ankle"), p(f"{side}_foot")
        fwd = foot - ankle
        fwd[1] = 0
        fwd = unit(fwd)
        a += [ankle, ankle]  # the shoe: toe past the foot joint, heel behind the ankle
        b += [foot + 0.07 * fwd, ankle - 0.07 * fwd - np.array([0, 0.04, 0])]
        r += [0.07, 0.06]
        elbow, wrist = p(f"{side}_elbow"), p(f"{side}_wrist")
        a.append(wrist)
        b.append(wrist + 0.16 * unit(wrist - elbow))  # the hand
        r.append(0.075)
    neck, head = p("neck"), p("head")
    up = unit(head - neck)
    a.append(head)
    b.append(head + 0.1 * up)  # the skull: the head joint is at its base
    r.append(0.13)
    return np.array(a), np.array(b), np.array(r)


def body_distance(points: np.ndarray, caps: tuple[np.ndarray, np.ndarray, np.ndarray], chunk: int = 65536) -> np.ndarray:
    """Distance outside the nearest capsule (negative inside)."""
    a, b, r = caps
    ab = b - a
    ab2 = np.maximum((ab * ab).sum(1), 1e-12)
    out = np.empty(len(points), np.float32)
    for s in range(0, len(points), chunk):
        p = points[s:s + chunk, None, :] - a[None]
        t = np.clip((p * ab[None]).sum(-1) / ab2[None], 0, 1)
        d = np.linalg.norm(p - t[..., None] * ab[None], axis=-1) - r[None]
        out[s:s + chunk] = d.min(1)
    return out


# ---------------------------------------------------------------------------------------------------------------
# islands: connected pieces of a voxel grid of the solid Gaussians


def islands(means: np.ndarray, alpha: np.ndarray, voxel: float, min_alpha: float) -> tuple[np.ndarray, np.ndarray]:
    """(component id per Gaussian, -1 where it isn't in the grid; summed alpha per component)."""
    from scipy import ndimage

    use = alpha >= min_alpha
    if not use.any():
        return np.full(len(means), -1, np.int64), np.zeros(0)
    lo = means[use].min(0) - voxel
    idx = np.floor((means - lo) / voxel).astype(np.int64)
    shape = idx[use].max(0) + 2
    grid = np.zeros(shape, bool)
    iu = idx[use]
    grid[iu[:, 0], iu[:, 1], iu[:, 2]] = True
    lab, n = ndimage.label(grid, structure=np.ones((3, 3, 3), bool))
    comp = np.full(len(means), -1, np.int64)
    inside = np.all((idx >= 0) & (idx < shape), axis=1)
    comp[inside] = lab[idx[inside, 0], idx[inside, 1], idx[inside, 2]] - 1  # -1: an empty voxel (a faint Gaussian alone)
    mass = np.bincount(comp[comp >= 0], alpha[comp >= 0], n) if n else np.zeros(0)
    return comp, mass


# ---------------------------------------------------------------------------------------------------------------


def plan_frame(g: Gaussians, joints: np.ndarray | None, ball: np.ndarray | None, support: dict | None,
               s: Settings) -> tuple[np.ndarray, dict]:
    """Keep mask for one frame and what each test dropped (count, and summed alpha)."""
    n = g.count
    alpha = 1 / (1 + np.exp(-g.opacities.astype(np.float64)))
    keep = np.ones(n, bool)
    why: dict[str, float] = {}
    protected = np.zeros(n, bool)
    if ball is not None:
        protected = np.linalg.norm(g.means - ball, axis=1) < s.keep_ball_m

    def drop(name: str, m: np.ndarray) -> None:
        m = m & keep & ~protected
        why[name] = int(m.sum())
        why[name + "Alpha"] = round(float(alpha[m].sum()), 1)
        keep[m] = False

    spare = np.zeros(n, bool)
    if support is not None:
        if s.spare_seen:
            spare = support["s"] == 1
        views = support["n"].astype(np.float64)
        counted = views >= s.min_views
        share = support["v"] / np.maximum(views, 1)
        if "outside" in s.tests:  # the real camera and the views agree: not the person
            drop("outside", counted & (support["r"] == 0) & (share < s.outside_share))
        if "hull" in s.tests:  # the real camera can't tell (out of its picture, or none): the views decide
            drop("hull", counted & (support["r"] == -1) & (share < s.hull_share) & ~spare)
        if "smear" in s.tests:
            ends = support["e"] / np.maximum(views, 1)
            size = np.exp(g.scales.max(1))
            drop("smear", counted & (support["r"] != 1) & (ends < s.smear_share) & (alpha < s.smear_alpha)
                 & (size > s.smear_size_m) & ~spare)
    if "island" in s.tests:
        comp, mass = islands(g.means, alpha, s.island_voxel_m, s.island_alpha)
        if len(mass):
            body = int(np.argmax(mass))
            detached = (comp >= 0) & (comp != body) & (mass[np.maximum(comp, 0)] < s.island_max_mass) & ~spare
            if support is not None:  # a person is a shell: a clump inside every silhouette is their inside, not a speck
                detached &= ~counted | (share < s.island_share)
            drop("island", detached)
    if "far" in s.tests and joints is not None:
        drop("far", body_distance(g.means.astype(np.float64), capsules(joints)) > s.far_m)
    why["kept"] = int(keep.sum())
    why["total"] = n
    return keep, why


# ---------------------------------------------------------------------------------------------------------------
# bundle I/O


def frame_paths(bundle: Path) -> tuple[dict, list[Path]]:
    dream = json.loads((bundle / "dream.json").read_text())
    fr = dream["frames"]
    pattern = fr.get("spz") or fr["pattern"].replace(".ply", ".spz")
    paths = []
    i = 0
    while (bundle / fr["dir"] / (pattern % i)).exists():
        paths.append(bundle / fr["dir"] / (pattern % i))
        i += 1
    return dream, paths


def ball_track(bundle: Path, dream: dict, n: int) -> list[np.ndarray | None]:
    if not dream.get("props") or not (bundle / dream["props"]).exists():
        return [None] * n
    props = json.loads((bundle / dream["props"]).read_text())
    for o in props.get("objects", []):
        if o.get("kind") == "basketball" and o.get("track"):
            t = o["track"]
            return [np.asarray(t[i], float) if i < len(t) and t[i] is not None else None for i in range(n)]
    return [None] * n


def _plan_one(args) -> tuple[int, np.ndarray, dict]:
    i, path, joints, ball, support, s = args
    g = read_spz(path)
    if support is not None and len(support["v"]) != g.count:
        raise SystemExit(f"{path}: support has {len(support['v'])} Gaussians, the frame {g.count} (made for another version?)")
    keep, why = plan_frame(g, joints, ball, support, s)
    return i, keep, why


def load_support(path: Path | None, n: int) -> list[dict | None]:
    if path is None:
        return [None] * n
    z = np.load(path)
    out: list[dict | None] = []
    for i in range(n):
        if f"v{i}" not in z.files:
            out.append(None)
            continue
        d = {k: z[f"{k}{i}"] for k in ("v", "e", "n", "r")}
        d["s"] = z[f"s{i}"] if f"s{i}" in z.files else np.full(len(d["v"]), -1, np.int8)
        out.append(d)
    return out


def plan_bundle(bundle: Path, s: Settings, jobs: int = 8, frames: list[int] | None = None,
                support: Path | None = None) -> tuple[dict[int, np.ndarray], list[dict]]:
    dream, paths = frame_paths(bundle)
    sup = load_support(support, len(paths))
    joints = None
    if (bundle / "joints.json").exists():
        joints = np.asarray(json.loads((bundle / "joints.json").read_text())["frames"], float)
    balls = ball_track(bundle, dream, len(paths))
    ids = list(range(len(paths))) if frames is None else frames
    work = [(i, paths[i], joints[min(i, len(joints) - 1)] if joints is not None else None, balls[i], sup[i], s) for i in ids]
    keeps, whys = {}, [None] * len(paths)
    with ProcessPoolExecutor(max_workers=jobs) as ex:
        for i, keep, why in ex.map(_plan_one, work, chunksize=1):
            keeps[i] = keep
            whys[i] = why
    return keeps, [w for w in whys if w is not None]


def save_keep(path: Path, keeps: dict[int, np.ndarray]) -> None:
    np.savez_compressed(path, **{f"f{i:06d}": np.packbits(k) for i, k in keeps.items()},
                        **{f"n{i:06d}": np.array(len(k)) for i, k in keeps.items()})


def load_keep(path: Path) -> dict[int, np.ndarray]:
    z = np.load(path)
    out = {}
    for name in z.files:
        if name.startswith("f"):
            i = int(name[1:])
            out[i] = np.unpackbits(z[name])[: int(z[f"n{i:06d}"])].astype(bool)
    return out


def subset_spz(src: Path, dst: Path, keep: np.ndarray) -> int:
    """Keeps the chosen Gaussians of an SPZ v2 file: its arrays subset as stored, so nothing is re-quantised."""
    raw = gzip.decompress(Path(src).read_bytes())
    magic, version, n, degree, fbits, flags, reserved = struct.unpack_from("<IIIBBBB", raw, 0)
    if magic != SPZ_MAGIC or version != 2:
        raise ValueError(f"{src}: not an SPZ v2 file")
    if len(keep) != n:
        raise ValueError(f"{src}: {n} Gaussians, keep mask has {len(keep)}")
    k = (degree + 1) ** 2 - 1
    widths = [9, 1, 3, 3, 3, 3 * k]  # position, alpha, colour, scale, rotation, SH: one array after another
    off, parts = 16, []
    for wd in widths:
        arr = np.frombuffer(raw, np.uint8, n * wd, off).reshape(n, wd) if wd else np.zeros((n, 0), np.uint8)
        parts.append(arr[keep].tobytes())
        off += n * wd
    if off != len(raw):
        raise ValueError(f"{src}: {len(raw) - off} unexpected trailing bytes")
    header = struct.pack("<IIIBBBB", SPZ_MAGIC, 2, int(keep.sum()), degree, fbits, flags, reserved)
    payload = gzip.compress(header + b"".join(parts), compresslevel=6)
    tmp = dst.with_name(dst.name + ".part")
    tmp.write_bytes(payload)
    tmp.replace(dst)
    return len(payload)


def write_bundle(bundle: Path, keeps: dict[int, np.ndarray], whys: list[dict], s: Settings, extra: dict | None = None) -> dict:
    dream, paths = frame_paths(bundle)
    metrics = dream.get("metrics") or {}
    if metrics.get("cleanup"):
        raise SystemExit(f"{bundle}: cleaned already ({metrics['cleanup'].get('at')}); restore from the backup first")
    backup = bundle.parent / ".clean-backup" / dream["id"] / dream["frames"]["dir"]
    backup.mkdir(parents=True, exist_ok=True)
    reality = dream["frames"].get("reality")
    total = 0
    counts = []
    for i, path in enumerate(paths):
        keep = keeps[i]
        pair = [path]
        if reality:
            rp = path.parent / (reality % i)
            if rp.exists():
                pair.append(rp)
        for p in pair:
            if not (backup / p.name).exists():
                shutil.copy2(p, backup / p.name)
        size = subset_spz(path, path, keep)
        total += size
        for p in pair[1:]:
            subset_spz(p, p, keep)
        counts.append(int(keep.sum()))
    dropped = sum(w["total"] - w["kept"] for w in whys)
    before = sum(w["total"] for w in whys)
    tests = {t: sum(w.get(t, 0) for w in whys) for t in s.tests}
    cleanup = {"at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "tool": "lucid.clean",
               "dropped": dropped, "droppedShare": round(dropped / max(before, 1), 4), "byTest": tests,
               "droppedAlpha": round(sum(w.get(t + "Alpha", 0) for w in whys for t in s.tests), 1),
               "gaussiansBefore": int(np.median([w["total"] for w in whys])), "settings": asdict(s)}
    if extra:
        cleanup |= extra
    metrics["cleanup"] = cleanup
    dream["metrics"] = metrics
    dream["frames"]["gaussiansPerFrame"] = int(np.median(counts))
    dream["frames"]["spzBytesTotal"] = total
    dream["updatedAt"] = cleanup["at"]
    tmp = bundle / "dream.json.part"
    tmp.write_text(json.dumps(dream, indent=2))
    tmp.replace(bundle / "dream.json")
    return cleanup


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("bundle", type=Path)
    p.add_argument("--write", action="store_true", help="back up, then drop the Gaussians from the bundle's frames")
    p.add_argument("--keep-out", type=Path, help="save the keep masks (for lucid.clean_check)")
    p.add_argument("--frames", default="", help="comma list: only these frames (report / keep-out only)")
    p.add_argument("--jobs", type=int, default=8)
    p.add_argument("--support", type=Path, help="lucid.clean_support's support.npz for this bundle (HiPerGator)")
    p.add_argument("--set", action="append", default=[], help="override a setting: name=value (e.g. ghost_share=0.8)")
    p.add_argument("--tests", default=",".join(Settings.tests))
    p.add_argument("--note", type=Path, help="JSON to add to metrics.cleanup (e.g. lucid.clean_check's numbers)")
    a = p.parse_args(argv)
    s = Settings()
    for kv in a.set:
        k, v = kv.split("=", 1)
        cur = getattr(s, k)
        setattr(s, k, v.lower() in ("1", "true", "yes") if isinstance(cur, bool) else type(cur)(v))
    s.tests = tuple(t for t in a.tests.split(",") if t)
    frames = [int(x) for x in a.frames.split(",") if x] or None
    if a.write and frames:
        raise SystemExit("--write cleans every frame; leave out --frames")
    if a.support is None and {"hull", "real", "smear"} & set(s.tests):
        print("[clean] no --support: only the island / far tests run (hull, real and smear need the cameras)")
    keeps, whys = plan_bundle(a.bundle, s, a.jobs, frames, a.support)
    tot = sum(w["total"] for w in whys)
    kept = sum(w["kept"] for w in whys)
    by = {t: sum(w.get(t, 0) for w in whys) for t in s.tests}
    by_alpha = {t: round(sum(w.get(t + "Alpha", 0) for w in whys), 1) for t in s.tests}
    print(f"[clean] {a.bundle.name}: {len(whys)} frames, dropped {tot - kept} of {tot} ({100 * (tot - kept) / max(tot, 1):.2f}%)"
          f" by test {json.dumps(by)} alpha {json.dumps(by_alpha)}", flush=True)
    worst = sorted(range(len(whys)), key=lambda k: whys[k]["kept"] - whys[k]["total"])[:5]
    print("[clean] most dropped:", [(sorted(keeps)[k], whys[k]["total"] - whys[k]["kept"]) for k in worst], flush=True)
    if a.keep_out:
        save_keep(a.keep_out, keeps)
        print(f"[clean] keep masks -> {a.keep_out}")
    if a.write:
        extra = json.loads(a.note.read_text()) if a.note else None
        c = write_bundle(a.bundle, keeps, whys, s, extra)
        print("[clean] wrote", json.dumps({k: v for k, v in c.items() if k != "settings"}))
    print("CLEAN_OK", a.bundle.name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
