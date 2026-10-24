"""Court Side assembly: the private real data -> the private court bundle (court.json + every file it names), as
apps/webxr/src/court/format.ts defines it. Every piece comes from the real data when it has landed and from the
synthetic stand-in otherwise, labelled as such (assembly.json beside court.json, and --report), so the bundle always
loads end to end and real pieces drop in without code changes.

    python3 -I pipeline/court/assemble.py --config <private assemble.json> [--out <bundle dir>] [--standin <dir>]
    python3 -I pipeline/court/assemble.py --config <...> --validate [--strict]   # check an assembled bundle
    python3 -I pipeline/court/assemble.py --config <...> --report                # provenance, placement, splat budget

The bundle is written beside --out and swapped in whole (the previous one is kept as <out>.prev). It must live outside
every checkout (serve.mjs refuses one inside): the private data folder's bundle/court-side, named by the config's
`out` (or --out).

Config (private, never in git: every number about the footage lives there). Every key is optional; a missing piece
is the stand-in's.
  title, caption, credit
  source      {freezeSource, sourceFps, captureFps, slow}: the source clip's timing (camera A)
  calib       calibration JSON (calib_A.json layout: C, image_size, frames[{source_frame, R (camera-from-world), f}],
              summary.click_reproj_px): camera.centre, every show frame's camera, camera F
  show        a folder laid out as the bundle's video/ (show.h264, frames.json, cards.json, freeze.png, ...) plus
              video.json = the court.json `video` block (paths relative to the bundle) and optionally
              {"camera": {sourceFps, captureFps, slow, centre}} for the clip it was baked from
  court       {floor, floorSeen, hardwood}: the top-down floor from the footage
  players     [{id, name, splats (PLY, y up, feet on y = 0: the export's bundle space), reality (export's
              .reality.spz), spz (the plain .spz, optional), place ("feet" | "camera"), foot ([x, z] or a list of
              them: the calibrated soles), camera (the source camera: {centre} in the PLY's space, or a recon
              source-camera JSON + placement for "camera"), metrics {heldOutPsnr}}]
  ball        {centre: [x, y, z]} | {pixel: [u, v] in F's source pixels, depthFrom: <player id>}
  extras      folder of <id>/extra.json manifests ({id, name, kind, file, reality, pose, foot, height, shadow?,
              reflection?}, paths relative to the manifest)
  stands      {proxy: [...], cards: [{id, image, quad}]} (court.json's freeze.stands with local image paths)
  audio       {loop: wav, swell: [t0, t1] (found in the loop when absent), search: [a, b], lufs}
  seat        {distance, distanceRange, clear}
  clips       the folder of the clips' run folders (<id>/court-run.json: the still camera each clip was cut with)
  cameras     {C: calibration JSON of camera C}: where extras posed from C were seen from
  light       overrides of the light field's levels
  metrics     {seatPsnr: {...}}: measured elsewhere (handoff_check.py), copied in
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
for _k in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ.setdefault(_k, "2")  # a shared Mac: two threads (run it under nice -n 10); heavy work goes to HiPerGator
import numpy as np  # noqa: E402

import assemble_audio as au  # noqa: E402
import assemble_geom as geo  # noqa: E402
import assemble_splats as sp  # noqa: E402

REPO = HERE.parents[1]
WEBXR = REPO / "apps" / "webxr"
DEFAULT_STANDIN = WEBXR / "scripts" / "court" / "out" / "standin"

LABEL = "Real footage, rebuilt in 3D. Not affiliated with the NBA or the players."
BALL_RADIUS = 0.1195  # a 23.9 cm ball
# the rulebook court (NBA): 94 x 50 ft; the ring's centre 5.25 ft in from the baseline at 10 ft; the board's face
# 4 ft in, 6 x 3.5 ft, its bottom 6 in under the ring
LENGTH, WIDTH = 28.65, 15.24
RIM = [12.725, 3.05, 0.0]
BOARD_X, BOARD_HALF, BOARD_Y = 13.106, 0.915, (2.90, 3.97)
LIGHT = {"crowd": 0.45, "floor": 0.30, "pair": 1.0, "stands": 0.6, "penumbra": 1.5, "alternative": {"crowd": 0.16, "floor": 0.14}}
SEAT = {"distance": 5.0, "distanceRange": [4, 7], "clear": 1.0}
SPLAT_BUDGET = 500_000  # visible at the worst pose until the Quest says more (plan 8)
PATH_EXT = re.compile(r"\.(h264|json|png|jpg|jpeg|webp|ply|glb|bin|m4a|mp4|wav|spz)$", re.I)


def expand(p) -> Path:
    return Path(os.path.expanduser(str(p)))


def rnd(v, d=4):
    return [round(float(x), d) for x in v]


# the images under the show that the assembly can stand in for while the bake hasn't made them
PLATE_KEYS = ("freezeClean", "standsMask", "inpaintMask")
# every field format.ts declares as a bundle path (a string under one of these keys, anywhere in court.json)
PATH_KEYS = {"floor", "floorSeen", "file", "frames", "cards", "freeze", "freezeClean", "standsMask", "inpaintMask", "element",
             "splats", "reality", "proxy", "image", "bed"}


def declared_paths(o, key: str | None = None) -> list[str]:
    """Every bundle-relative file path in a court.json block: the string values of format.ts's path fields."""
    out = []
    if isinstance(o, dict):
        for k, v in o.items():
            out += declared_paths(v, k)
    elif isinstance(o, list):
        for v in o:
            out += declared_paths(v, key)
    elif isinstance(o, str) and key in PATH_KEYS:
        out.append(o)
    return out


bundle_paths = declared_paths


def _norm(p) -> str:
    """A path as the file system sees it: symlinks resolved, and case-folded on macOS (its disks ignore case)."""
    r = os.path.realpath(os.path.expanduser(str(p)))
    return r.casefold() if sys.platform == "darwin" else r


def checkouts() -> list[Path]:
    """This repo's main checkout and every worktree of it."""
    p = subprocess.run(["git", "-C", str(REPO), "worktree", "list", "--porcelain"], capture_output=True, text=True)
    roots = [Path(ln[len("worktree "):]) for ln in p.stdout.splitlines() if ln.startswith("worktree ")]
    return roots or [REPO]


def is_bundle(p: Path) -> bool:
    """A bundle this tool assembled: its assembly.json is there with its provenance."""
    try:
        a = json.loads((p / "assembly.json").read_text())
    except (OSError, ValueError):
        return False
    return isinstance(a, dict) and "assembledAt" in a and "pieces" in a


def rotate_into(out: Path, new: Path) -> Path | None:
    """Swap the freshly written `new` in as `out`; the bundle that was there is renamed <out>.prev-<UTC time> (never
    deleted). Refuses an `out` that isn't a bundle this tool made, and a .prev name that is taken."""
    prev = None
    if out.exists() or out.is_symlink():
        if out.is_symlink() or not out.is_dir() or not is_bundle(out):
            raise ValueError(f"{out} exists and isn't a bundle assemble.py made: refusing to move it")
        prev = out.parent / f"{out.name}.prev-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}"
        if prev.exists() or prev.is_symlink():
            raise ValueError(f"{prev} already exists: refusing to overwrite it")
        guard_out(prev)
        out.rename(prev)
    new.rename(out)
    return prev


def guard_out(out: Path) -> None:
    """The bundle never goes inside a checkout (Vite and the tunnel serve them, and git would see it: P36), nor holds
    one; refused before anything is written."""
    o = _norm(out)
    for root in checkouts():
        r = _norm(root)
        if o == r or o.startswith(r + os.sep) or r.startswith(o + os.sep):
            raise ValueError(f"refusing to write the bundle at {out}: it is inside (or holds) the checkout {root} (P36)")


def safe_rel(rel) -> str:
    """A bundle path as format.ts allows it: relative, no "..", no backslash, no scheme, no home; else ValueError."""
    if not isinstance(rel, str) or not rel.strip():
        raise ValueError(f"not a bundle path: {rel!r}")
    if rel.startswith(("/", "~")) or "\\" in rel or "://" in rel or ":" in rel.split("/")[0] or ".." in rel.split("/"):
        raise ValueError(f"{rel!r}: a bundle path must be relative and stay inside the bundle")
    return rel


def inside(path, root) -> bool:
    p, r = _norm(path), _norm(root)
    return p == r or p.startswith(r + os.sep)


class Writer:
    """Collects the bundle's files in a fresh folder (made by this run) and records where each piece came from. Every
    destination stays inside that folder; a source handed over by another stream must sit inside that stream's folder
    and must not be a symlink."""

    def __init__(self, root: Path):
        self.root = root
        self.pieces: dict[str, dict] = {}
        self.notes: list[str] = []
        self.deferred: list[str] = []  # show images to make once camera F is known

    def piece(self, name: str, real: bool, detail: str, **extra) -> None:
        self.pieces[name] = {"source": "real" if real else "stand-in", "detail": detail, **extra}

    def path(self, rel: str) -> Path:
        p = self.root / safe_rel(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        if not inside(p.parent, self.root) or p.is_symlink():
            raise ValueError(f"{rel!r} would land outside the bundle being written")
        return p

    def copy(self, src: Path, rel: str, within: Path | None = None) -> str:
        src = Path(src)
        if within is not None and (src.is_symlink() or not inside(src, within)):
            raise ValueError(f"{src}: not a plain file inside {within}")
        dst = self.path(rel)
        shutil.copyfile(src, dst, follow_symlinks=False)
        shutil.copystat(src, dst, follow_symlinks=False)  # its own time, so a show found in the bundle is settled
        return rel

    def json(self, rel: str, obj, indent=None) -> str:
        self.path(rel).write_text(json.dumps(obj, indent=indent, ensure_ascii=False))
        return rel


# ---------------------------------------------------------------- the pieces

def show_dir(cfg: dict) -> tuple[Path | None, str]:
    """The real show's folder (holding video.json) and whose cameras its frames use: "show" (the ones it was baked
    with, the default when its frames.json carries q and f) or "calib" (re-read from the calibration). Without a
    `show` in the config, a video.json the bake wrote into the current bundle's own video/ counts (it is copied
    into the new bundle before the old one is moved aside)."""
    show = cfg.get("show")
    if not show:
        here = expand(cfg["out"]) / "video" if cfg.get("out") else None
        return (here, "show") if here is not None and (here / "video.json").exists() else (None, "calib")
    d = expand(show["dir"] if isinstance(show, dict) else show)
    return (d if (d / "video.json").exists() else None), (show.get("cameras", "show") if isinstance(show, dict) else "show")


def staged(d: Path, rel: str) -> Path:
    """A show file named "video/..." in the bundle: <d>/video/... in a staging folder, <d>/... in a video folder."""
    p = d / rel
    return p if p.exists() or p.is_symlink() else d / rel.split("/", 1)[-1]


class ShowRejected(ValueError):
    """A staged show that can't be taken as it is (unsafe path, incomplete, or changed while it was copied)."""


OWN_PLATES = {"freezeClean": "video/freeze-clean.png", "standsMask": "video/stands-mask.png"}


def take_show(w: Writer, d: Path, manifest: dict) -> tuple[dict, list]:
    """Copy a staged show into the bundle whole, or raise ShowRejected (and copy nothing that stays): every path it
    names inside the bundle, every source a plain file inside its folder, all of them there and settled, and none
    changed between before and after the copy (a producer replacing a file mid-copy would mix two bakes)."""
    video = json.loads(json.dumps(manifest["video"] if "video" in manifest else manifest))
    try:
        for rel in bundle_paths(video):
            safe_rel(rel)
    except ValueError as e:
        raise ShowRejected(str(e)) from None
    # the plates the assembly made last time (carried in video.json) are not the bake's: make them again
    for k in manifest.get("assembledPlates", []):
        video.pop(k, None)
    for k, rel in OWN_PLATES.items():  # format.ts needs these two: name them even if the bake doesn't yet
        video.setdefault(k, rel)
    ours = set(manifest.get("assembledPlates", []))
    w.deferred = [k for k in OWN_PLATES if k in ours or not staged(d, video[k]).is_file()]
    if isinstance(video.get("inpaintMask"), str) and not staged(d, video["inpaintMask"]).is_file():
        del video["inpaintMask"]
    names = [rel for rel in dict.fromkeys(bundle_paths(video)) if not any(video.get(k) == rel for k in w.deferred)]
    srcs = {rel: staged(d, rel) for rel in names}
    bad = [rel for rel, p in srcs.items() if p.is_symlink() or not inside(p, d)]
    if bad:
        raise ShowRejected(f"not plain files inside {d}: {', '.join(bad)}")
    missing = [rel for rel, p in srcs.items() if not p.is_file() or p.stat().st_size == 0]
    if missing:
        raise ShowRejected(f"isn't complete yet (missing {', '.join(missing)})")
    now = dt.datetime.now().timestamp()
    fresh = [rel for rel, p in srcs.items() if now - p.stat().st_mtime < 60]
    if fresh:
        raise ShowRejected(f"is still being written ({', '.join(fresh)})")
    stat = lambda p: (p.stat().st_size, p.stat().st_mtime_ns)  # noqa: E731
    before = {rel: stat(p) for rel, p in srcs.items()} | {"video.json": stat(d / "video.json")}
    copied = []
    try:
        for rel, p in srcs.items():
            w.copy(p, rel, within=d)
            copied.append(rel)
        after = {rel: stat(p) for rel, p in srcs.items()} | {"video.json": stat(d / "video.json")}
        changed = [rel for rel in before if before[rel] != after[rel]]
        if changed:
            raise ShowRejected(f"changed while it was copied ({', '.join(changed)})")
    except BaseException:
        for rel in copied:  # files this run copied: gone again
            (w.root / rel).unlink(missing_ok=True)
        raise
    frames = json.loads((w.root / video["frames"]).read_text())
    # carried into the bundle, so a show found there is found again next time (with the plates that were ours)
    w.json("video/video.json", {**manifest, "video": {k: v for k, v in video.items() if k not in w.deferred},
                                "assembledPlates": list(w.deferred)}, indent=1)
    return video, frames


def show_piece(w: Writer, cfg: dict, standin: Path, S: dict, calib: geo.CalibTrack | None):
    """The video block, its frames.json (each show frame's own camera) and the rest of video/; the timing of the clip
    the frames count in. Returns (video block, frames, timing {sourceFps, captureFps, slow, centre?})."""
    d, cams = show_dir(cfg)
    real = False
    if d is not None:
        manifest = json.loads((d / "video.json").read_text())
        try:
            video, frames = take_show(w, d, manifest)
            timing = manifest.get("camera", {})
            real = True
            w.piece("show", True, str(d))
            if cams == "show" and not all("q" in fr and "f" in fr for fr in frames):
                cams = "calib"
        except ShowRejected as e:
            w.notes.append(f"the staged show at {d} {e}: the stand-in's is used")
            w.deferred = []
    if not real:
        video = json.loads(json.dumps(S["video"]))
        for rel in bundle_paths(video):
            w.copy(standin / rel, rel, within=standin)
        frames = json.loads((standin / video["frames"]).read_text())
        timing = {k: S["camera"][k] for k in ("sourceFps", "captureFps", "slow")}
        w.piece("show", False, "stand-in show stream, frames, cards and freeze images (synthetic players)")
    if real and cams == "show":
        if "centre" not in timing:
            raise ValueError(f"{d / 'video.json'}: camera.centre is needed with the show's own cameras (the centre it was baked with)")
        if calib is not None and np.linalg.norm(np.subtract(timing["centre"], calib.C)) > 0.01:
            w.notes.append(f"the show's cameras have centre {timing['centre']}, the calibration {rnd(calib.C, 3)}: the show's are used")
        w.piece("cameras", True, "the show's own per-frame cameras (the ones it was baked with)")
    elif calib is not None:
        # the show's clock -> the calibrated clip's source frames: the same moment F, the same real time
        src_cfg = cfg.get("source", {})
        f_show = video["freezeSource"]
        f_real = f_show if real else src_cfg.get("freezeSource", f_show)
        rate_show = timing.get("sourceFps", 1) * timing.get("slow", 1)
        rate_real = rate_show if real else src_cfg.get("sourceFps", rate_show) * src_cfg.get("slow", 1)
        k = rate_real / rate_show

        def recamera(frs: list) -> None:
            for fr in frs:
                q, f = calib.at(f_real + (fr["src"] - f_show) * k)
                fr["q"], fr["f"] = rnd(q, 9), round(float(f), 4)

        recamera(frames)
        hz90 = (video.get("fallbacks") or {}).get("hz90")
        if hz90 and hz90.get("frames"):
            other = json.loads((w.root / hz90["frames"]).read_text())
            recamera(other)
            w.json(hz90["frames"], other)
        timing = {**timing, "centre": rnd(calib.C)}
        w.piece("cameras", True, f"every show frame's camera from the calibration ({calib.clamped} frames outside its "
                f"range {calib.range} held at its ends)", clamped=calib.clamped)
        if calib.clamped:
            w.pieces["cameras"]["source"] = "partial"
    else:
        w.piece("cameras", False, "the stand-in show's own cameras")
    w.json(video["frames"], frames)
    return video, frames, timing


def camera_block(cfg: dict, S: dict, timing: dict, calib: geo.CalibTrack | None, real_show: bool) -> dict:
    """The source camera: the centre the frames' cameras go with, the calibrated image, and the timing of the clip the
    show's frames count in (the stand-in show keeps its own clock; a real show's manifest, else the config's `source`)."""
    if calib is None and not real_show:
        return dict(S["camera"])
    t = {**cfg.get("source", {}), **timing} if real_show else timing
    missing = [k for k in ("sourceFps", "captureFps", "slow", "centre") if k not in t]
    if missing:
        raise ValueError(f"the show's clip is missing {missing} (video.json's camera, or the config's source and calib)")
    W, H = calib.size if calib is not None else (S["camera"]["width"], S["camera"]["height"])
    return {"centre": rnd(t["centre"]), "width": W, "height": H, "cx": (W - 1) / 2, "cy": (H - 1) / 2, "k1": 0,
            "sourceFps": t["sourceFps"], "captureFps": t["captureFps"], "slow": t["slow"]}


def floor_from_mosaic(img: np.ndarray, count: np.ndarray, hole: np.ndarray | None, canvas: dict, res: float = 0.02):
    """The whole court from above (FloorRect [-L/2, -W/2, L/2, W/2]: columns along +x, rows along +z, `res` m per
    pixel) out of a still camera's people-free pan mosaic (RGB; `count` > 0 where a frame filled it, `hole` where it
    was inpainted): (floor RGB uint8, seen bool, hardwood sRGB 0-1 = the median of the seen floor). Unseen floor is the
    hardwood colour; the canvas camera is a pinhole, x_cam = R (X - C), its K in the mosaic's pixels."""
    import cv2

    K, Rcw, C = np.asarray(canvas["K"], float), np.asarray(canvas["R"], float), np.asarray(canvas["C"], float)
    nx, nz = int(round(LENGTH / res)), int(round(WIDTH / res))
    x = (np.arange(nx) + 0.5) * res - LENGTH / 2
    z = (np.arange(nz) + 0.5) * res - WIDTH / 2
    X, Z = np.meshgrid(x, z)
    P = np.stack([X, np.zeros_like(X), Z], -1).reshape(-1, 3)
    c = (P - C) @ Rcw.T
    front = c[:, 2] > 0.1
    zc = np.where(front, c[:, 2], 1.0)
    u = (K[0, 0] * c[:, 0] / zc + K[0, 2]).reshape(nz, nx).astype(np.float32)
    v = (K[1, 1] * c[:, 1] / zc + K[1, 2]).reshape(nz, nx).astype(np.float32)
    H, W = img.shape[:2]
    inside = front.reshape(nz, nx) & (u >= 0) & (u <= W - 1) & (v >= 0) & (v <= H - 1)
    rgb = cv2.remap(np.ascontiguousarray(img), u, v, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    ui, vi = np.clip(np.round(u), 0, W - 1).astype(int), np.clip(np.round(v), 0, H - 1).astype(int)
    seen = inside & (count[vi, ui] > 0)
    if hole is not None:
        seen &= hole[vi, ui] == 0
    hardwood = (np.median(rgb[seen], 0) / 255.0) if seen.any() else np.array([0.71, 0.52, 0.33])
    floor = np.where(seen[..., None], rgb, np.round(hardwood * 255)).astype(np.uint8)
    return floor, seen, [round(float(h), 3) for h in hardwood]


def stands_mask(cam: geo.Cam, width: int, height: int, margin: float = 0.5) -> np.ndarray:
    """White where camera F's ray doesn't land on the court floor (within `margin` of its lines): the stands, the
    crowd, the baseline rows and the arena above; black on the floor (players stand on it, so they stay black)."""
    c = cam.scaled(width)
    u, v = np.meshgrid(np.arange(width, dtype=float), np.arange(height, dtype=float))
    d = c.rays(u.ravel(), v.ravel())
    t = np.where(d[:, 1] < -1e-9, -c.C[1] / np.where(d[:, 1] < -1e-9, d[:, 1], -1.0), np.inf)
    X = c.C + np.where(np.isfinite(t), t, 0.0)[:, None] * d
    floor = np.isfinite(t) & (np.abs(X[:, 0]) <= LENGTH / 2 + margin) & (np.abs(X[:, 2]) <= WIDTH / 2 + margin)
    return np.where(floor, 0, 255).astype(np.uint8).reshape(height, width)


def fill_plates(w: Writer, video: dict, camF: geo.Cam) -> None:
    """The show images the bake hasn't made yet, so the bundle stays whole: the clean plate is frame F itself (the
    players not yet painted out), the stands mask comes from camera F and the court."""
    import cv2

    if not w.deferred:
        return
    fz = cv2.imread(str(w.root / video["freeze"]), cv2.IMREAD_UNCHANGED)
    H, W = fz.shape[:2]
    for k in w.deferred:
        if k == "freezeClean":
            w.copy(w.root / video["freeze"], video[k])
            w.piece("show:freezeClean", False, "frame F itself: the clean plate isn't baked yet (the players are still in it)")
        elif k == "standsMask":
            sp.write_png(w.path(video[k]), stands_mask(camF, W, H))
            w.piece("show:standsMask", False, "from camera F and the court: everything off the floor (the bake's mask isn't made yet)")


def court_piece(w: Writer, cfg: dict, standin: Path, S: dict) -> dict:
    c = cfg.get("court") or {}
    block = {"length": LENGTH, "width": WIDTH, "rim": RIM,
             "backboard": [[BOARD_X, BOARD_Y[0], -BOARD_HALF], [BOARD_X, BOARD_Y[0], BOARD_HALF],
                           [BOARD_X, BOARD_Y[1], BOARD_HALF], [BOARD_X, BOARD_Y[1], -BOARD_HALF]]}
    m = c.get("mosaic") or {}
    if m.get("image") and expand(m["image"]).exists():
        import cv2

        img = cv2.cvtColor(cv2.imread(str(expand(m["image"])), cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
        count = cv2.imread(str(expand(m["count"])), cv2.IMREAD_UNCHANGED) if m.get("count") else np.ones(img.shape[:2], np.uint16)
        hole = cv2.imread(str(expand(m["hole"])), cv2.IMREAD_UNCHANGED) if m.get("hole") else None
        canvas = json.loads(expand(m["camera"]).read_text())
        floor, seen, hardwood = floor_from_mosaic(img, count, hole, canvas, m.get("res", 0.02))
        cv2.imwrite(str(w.path("court/floor.jpg")), cv2.cvtColor(floor, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 90])
        sp.write_png(w.path("court/floor-seen.png"), (seen * 255).astype(np.uint8))
        block.update({"floor": "court/floor.jpg", "floorSeen": "court/floor-seen.png", "hardwood": c.get("hardwood", hardwood)})
        w.piece("floor", True, f"top-down from the pan mosaic ({100 * seen.mean():.1f}% of the court seen), hardwood {hardwood}")
    elif c.get("floor") and expand(c["floor"]).exists():
        block["floor"] = w.copy(expand(c["floor"]), "court/floor" + expand(c["floor"]).suffix)
        block["floorSeen"] = w.copy(expand(c["floorSeen"]), "court/floor-seen.png")
        block["hardwood"] = c["hardwood"]
        w.piece("floor", True, str(expand(c["floor"]).parent))
    else:
        block["floor"] = w.copy(standin / S["court"]["floor"], S["court"]["floor"])
        block["floorSeen"] = w.copy(standin / S["court"]["floorSeen"], S["court"]["floorSeen"])
        block["hardwood"] = c.get("hardwood", S["court"]["hardwood"])
        w.piece("floor", False, "stand-in top-down floor and floor-seen mask")
    return block


def frame_camera(court_cam: dict, frames: list, video: dict) -> geo.Cam:
    """Camera F in source pixels: the camera of the last frame of the first ease (every ease ends on it)."""
    fr = frames[video["segments"]["eases"][0]["frames"][1]]
    c = court_cam
    return geo.Cam(np.asarray(c["centre"], float), geo.quat_to_matrix(fr["q"]), float(fr["f"]), c["cx"], c["cy"], c["width"], c["height"])


def standin_camera_f(S: dict, standin: Path) -> geo.Cam:
    frames = json.loads((standin / S["video"]["frames"]).read_text())
    return frame_camera(S["camera"], frames, S["video"])


def resolve_run(slot: dict, clips: Path | None = None) -> dict:
    """A player slot filled in from a fetched freeze run (court-job.sbatch's results): {"run": dir, "variant":
    "raw-default-r1", "cap": "300k"} names recon-<variant>-<cap>/ (frames/<K>.ply in the recon's own world,
    source-camera-<K:06d>.json = the A frame's solved camera there, and the recon's report: P42's iou, focal,
    focalHeld; the real frame's PSNR), bundle-<variant>-<cap>/ (the export: frames/000000.ply in its bundle space with
    dream.json's placement, .spz, .reality.spz in the same Gaussian order), and recon-metrics-<variant>/ for the
    held-out PSNR against the generated views. court-run.json (the still camera the clip was cut with) comes from
    `clips`/<run id>/. Keys already in the slot win."""
    if not slot.get("run"):
        return slot
    run = expand(slot["run"])
    v, cap = slot.get("variant"), slot.get("cap")
    if not (v and cap):
        found = sorted(d.name[len("recon-"):] for d in run.glob("recon-*") if d.is_dir() and not d.name.startswith("recon-metrics-"))
        if len(found) != 1:
            raise ValueError(f"{run}: name the player's variant and cap (recons here: {found or 'none'})")
        v, cap = re.fullmatch(r"(.+)-(\d+k)", found[0]).groups()
    b, r = run / f"bundle-{v}-{cap}", run / f"recon-{v}-{cap}"
    out = dict(slot)
    cams = sorted(p for p in r.glob("source-camera-*.json") if re.fullmatch(r"source-camera-\d{6}\.json", p.name))
    if cams:
        out.setdefault("sourceCamera", str(cams[0]))
    k = re.search(r"(\d{6})", cams[0].name).group(1) if cams else None
    if "splats" not in slot:
        if k and (r / "frames" / f"{k}.ply").exists():
            out["splats"], out["splatsSpace"] = str(r / "frames" / f"{k}.ply"), "recon"
        else:
            out["splats"], out["splatsSpace"] = str(b / "frames" / "000000.ply"), "bundle"
    out.setdefault("reality", str(b / "frames" / "000000.reality.spz"))
    out.setdefault("spz", str(b / "frames" / "000000.spz"))
    out.setdefault("dream", str(b / "dream.json"))
    if clips is not None and "courtRun" not in slot:
        out["courtRun"] = str(clips / run.name / "court-run.json")

    def report(d: Path) -> tuple[dict, dict]:
        files = sorted(d.glob("recon-*.json"))
        rep = json.loads(files[0].read_text()) if files else {}
        return (rep.get("frames") or [{}])[0], rep.get("source") or {}

    fr, src = report(r)
    held = report(run / f"recon-metrics-{v}")[0].get("psnr")
    out["run_report"] = {"variant": v, "cap": cap, "iou": src.get("iou"), "focal": src.get("focal"), "focalHeld": src.get("focalHeld"),
                         "sourcePsnr": fr.get("sourcePsnr"), "facePsnr": fr.get("facePsnr"), "gaussians": fr.get("gaussians"),
                         "heldOutPsnr": held}
    out["metrics"] = {**(slot.get("metrics") or {}), **({"heldOutPsnr": held} if held is not None else {})}
    return out


def recon_cameras(slot: dict) -> tuple[geo.Cam, geo.Cam]:
    """(the run's solved source camera in the PLY's own space, the court camera it was cut from): recon's
    source-camera-<K>.json (the recon's world, OpenCV camera_to_world, K for source-4k.mkv's crop), taken into the
    export's bundle space with dream.json's `placement` (x' = rot x + t) when the PLY is the export's
    (splatsSpace "bundle"), and court-run.json's still camera (court space, camera-from-world R, K with the crop's
    own principal point)."""
    c = json.loads(expand(slot["sourceCamera"]).read_text())
    run = json.loads(expand(slot["courtRun"]).read_text())
    rot, t = np.eye(3), np.zeros(3)
    if slot.get("splatsSpace", "bundle") == "bundle":
        pl = json.loads(expand(slot["dream"]).read_text())["placement"]
        rot, t = np.asarray(pl["rot"], float), np.asarray(pl["t"], float)
    c2w = np.asarray(c["camera_to_world"], float)
    K = np.asarray(c["K"], float)
    W, H = int(c["image_width"]), int(c["image_height"])
    src = geo.Cam(rot @ c2w[:3, 3] + t, rot @ c2w[:3, :3], float(K[0, 0]), float(K[0, 2]), float(K[1, 2]), W, H)
    st = run["still"]
    Ks = np.asarray(st["K"], float)
    dst = geo.Cam(np.asarray(st["C"], float), np.asarray(st["R"], float).T, float(Ks[0, 0]), float(Ks[0, 2]), float(Ks[1, 2]), W, H)
    return src, dst


def place_player(w: Writer, slot: dict, i: int, standin: Path, S: dict, camF: geo.Cam, camF_standin: geo.Cam) -> dict:
    """One main player: their Gaussians placed in court space, the reality copy, the splat-depth proxy from camera F,
    capsules, bounds, floor maps. Returns the court.json entry plus private diagnostics under "_"."""
    pid = slot.get("id") or S["freeze"]["players"][i]["id"]
    real = bool(slot.get("splats")) and expand(slot["splats"]).exists()
    if real:
        s = sp.read_ply(expand(slot["splats"]))
        cam_pos = np.array([0.0, 1.0, -25.0])  # the export turns the source camera onto -z
        name = slot.get("name", pid)
    else:
        sp_in = S["freeze"]["players"][i]
        s = sp.read_ply(standin / sp_in["splats"])
        cam_pos = camF_standin.C
        name = f"{slot.get('name', sp_in['name'])} (stand-in body)"
    feet = slot.get("foot")
    feet = np.asarray(feet, float).reshape(-1, 2) if feet is not None else None
    P = sp.solid(s)
    need = ("sourceCamera", "courtRun") + (("dream",) if slot.get("splatsSpace", "bundle") == "bundle" else ())
    has_cams = real and all(slot.get(k) and expand(slot[k]).exists() for k in need)
    if has_cams:
        src_cam, dst_cam = recon_cameras(slot)
        cam_pos = src_cam.C
        # the clip was cut from the calibration's camera F: say so if the bundle's camera F isn't that camera
        drift = (geo.rot_angle_deg(dst_cam.R, camF.R), float(np.linalg.norm(dst_cam.C - camF.C)), dst_cam.f / camF.f - 1)
        if drift[0] > 0.01 or drift[1] > 0.01 or abs(drift[2]) > 1e-4:
            w.notes.append(f"{pid}: the clip's still camera differs from the bundle's camera F by {drift[0]:.3f} deg, "
                           f"{drift[1]:.3f} m, focal {100 * drift[2]:+.3f}%")
    if slot.get("place", "camera" if has_cams else "feet") == "camera":
        if not has_cams:
            raise ValueError(f"{pid}: place 'camera' needs sourceCamera, dream and courtRun")
        sim, info = geo.place_by_camera(P, src_cam, dst_cam)
        if feet is not None:
            info["vsFeet"] = round(float(np.linalg.norm(sp.contact_points_xz(sim.apply(P)) - feet.mean(0))), 3)
    else:
        if feet is None:
            # no calibrated soles: keep the stand-in's own spot (its feet in the stand-in court)
            feet = sp.solid(s)[:, [0, 2]][sp.solid(s)[:, 1] < 0.05].mean(0, keepdims=True)
            w.notes.append(f"{pid}: no calibrated foot point; kept where the stand-in stood")
        sim, info = geo.place_by_feet(P, cam_pos, feet.mean(0), camF.C)
    base = f"players/{pid}"
    if real:
        seen = seen_of(s, expand(slot["reality"]) if slot.get("reality") else None, expand(slot["spz"]) if slot.get("spz") else None, w, pid,
                       same_space=slot.get("splatsSpace", "bundle") == "bundle")
    else:
        seen = seen_of(s, standin / S["freeze"]["players"][i]["reality"], None)
    b = body_files(w, base, s, sim, seen, camF)
    Pp, rect = b["P"], b["rect"]
    contact = sp.contact_points_xz(Pp)
    entry = {
        "id": pid, "name": name, "splats": f"{base}/freeze.ply", "reality": f"{base}/reality.ply", "proxy": f"{base}/proxy.glb",
        "bounds": sp.bounds(Pp), "seenFraction": round(float(seen.mean()), 3),
        "capsules": [{k: c[k] for k in ("a", "b", "r")} for c in sp.body_capsules(Pp)],
        "shadow": {"image": f"{base}/shadow.png", "rect": rect}, "reflection": {"image": f"{base}/reflection.png", "rect": rect},
        "_": {"sim": sim, "contact": contact, "count": b["count"], "placement": {k: (round(v, 4) if isinstance(v, float) else v) for k, v in info.items()},
              "height": round(float(np.percentile(Pp[:, 1], 99.5)), 3)},
    }
    if slot.get("run_report"):
        rr = dict(slot["run_report"])
        if slot.get("courtRun") and expand(slot["courtRun"]).exists():
            rr["FOCAL"] = json.loads(expand(slot["courtRun"]).read_text()).get("FOCAL")
        entry["_"]["run"] = rr
    if feet is not None:
        entry["_"]["footError"] = round(float(np.linalg.norm(contact - feet.mean(0))), 3)
    w.piece(f"player:{pid}", real, str(expand(slot["splats"])) if real else f"stand-in body '{S['freeze']['players'][i]['id']}' re-placed at the calibrated feet")
    return entry


def mask_centroid(path: Path, source_width: int):
    """The centroid of a binary mask (white = it) in source pixels (the mask may be at another width: pixel centres
    scale as u' = (u + 0.5) s - 0.5); None when the mask is empty."""
    import cv2

    m = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if m is None:
        raise ValueError(f"{path}: not an image")
    ys, xs = np.nonzero(m > 127)
    if not len(xs):
        return None
    s = source_width / m.shape[1]
    return (float(xs.mean()) + 0.5) * s - 0.5, (float(ys.mean()) + 0.5) * s - 0.5


def ball_piece(w: Writer, cfg: dict, S: dict, players: list, camF: geo.Cam, splats_by_id: dict, k1F: float = 0.0) -> dict:
    """The ball at F (plan 2: placed by hand, a 23.9 cm sphere; F's ball pixels are projected onto it at runtime and
    its unseen side is Reality-marked there). From the config: its centre, or F's ball pixel (`pixel` in the bundle's
    undistorted source pixels, or `pixelRaw` in the raw frame, undone with camera F's k1) on F's ray at the holder's
    depth: their nearest Gaussians on that ray, or while their body is the stand-in's, the vertical plane through
    their soles facing the camera."""
    b = cfg.get("ball") or {}
    first = players[0]["id"]
    erase = [{"player": p["id"], "radius": 0.15} for p in players[:1]]
    if b.get("centre"):
        w.piece("ball", True, "config centre")
        return {"centre": rnd(b["centre"]), "radius": BALL_RADIUS, "erase": erase}
    px = b.get("pixel")
    raw = b.get("pixelRaw")
    if b.get("mask") and expand(b["mask"]).exists():
        raw = mask_centroid(expand(b["mask"]), camF.w) or raw  # the SAM mask's centroid at F, in the raw frame
    if raw:
        b = {**b, "pixelRaw": raw}
    if b.get("pixelRaw"):
        import assemble_stands as stx

        xn, yn = stx.undistort(np.array([(b["pixelRaw"][0] - camF.cx) / camF.f]), np.array([(b["pixelRaw"][1] - camF.cy) / camF.f]), k1F)
        px = [camF.cx + camF.f * float(xn[0]), camF.cy + camF.f * float(yn[0])]
    holder = b.get("depthFrom")
    if px and holder in splats_by_id:
        ray = camF.rays(np.array([px[0]]), np.array([px[1]]))[0]
        P = splats_by_id[holder]
        t = (P - camF.C) @ ray
        off = np.linalg.norm((P - camF.C) - np.outer(t, ray), axis=1)
        near = t[off < BALL_RADIUS]
        real_body = w.pieces.get(f"player:{holder}", {}).get("source") == "real"
        if len(near) >= 10:
            centre = camF.C + (np.percentile(near, 10) + BALL_RADIUS) * ray
            how = f"F's ball pixel at {holder}'s depth there"
        elif not real_body:
            p = next(pl for pl in players if pl["id"] == holder)
            foot = np.array([p["_"]["contact"][0], 0.0, p["_"]["contact"][1]])
            n = np.array([ray[0], 0.0, ray[2]])
            centre = camF.C + float((foot - camF.C) @ n / (ray @ n)) * ray
            how = f"F's ball pixel at the depth of {holder}'s soles (the body is still the stand-in's)"
        else:
            raise ValueError(f"ball: fewer than 10 of {holder}'s Gaussians lie on the ball's ray; check the ball pixel")
        w.piece("ball", True, how, pixel=rnd(px, 2))
        return {"centre": rnd(centre), "radius": BALL_RADIUS, "erase": [{"player": holder, "radius": 0.15}]}
    # the stand-in ball, carried with the first player's placement (it sits in their hand)
    sim = players[0]["_"]["sim"]
    w.piece("ball", False, f"stand-in ball carried with {first}'s placement")
    return {"centre": rnd(sim.apply(np.asarray(S["freeze"]["ball"]["centre"], float))), "radius": BALL_RADIUS, "erase": erase}


def read_extra(m: Path) -> dict | None:
    """One extras manifest, normalised; None while its model hasn't landed (`file` empty or missing) or when it is left
    out (kind "out"). The extras stream's layout: pose {camera: "C..."}, foot {xz: [x, z]}, height_m, files relative
    to the manifest, "space": "court" for a model it already placed in court metres, reality "all" (nothing seen as
    drawn: all tinted) or the export's .reality.spz in the model's Gaussian order."""
    e = json.loads(m.read_text())
    loc = lambda p: None if not p else (expand(p) if str(p).startswith(("~", "/")) else m.parent / p)  # noqa: E731
    f = loc(e.get("file"))
    if e.get("kind") == "out" or f is None or not f.exists():
        return None
    pose = e.get("pose")
    cam = pose.get("camera", "A") if isinstance(pose, dict) else (pose or "A")
    foot = e.get("foot")
    xz = foot["xz"] if isinstance(foot, dict) else [foot[0], foot[2]]
    calib = (foot.get("calibration") if isinstance(foot, dict) else None) or e.get("calibration")
    reality = "all" if e.get("reality") == "all" else loc(e.get("reality"))
    return {"id": e["id"], "name": e.get("name"), "kind": e.get("kind", "splats"), "file": f, "reality": reality,
            "spz": loc(e.get("spz")), "pose": "C" if str(cam).upper().startswith("C") else "A", "foot": [float(xz[0]), 0.0, float(xz[1])],
            "height": float(e.get("height", e.get("height_m", 0)) or 0), "space": e.get("space", "bundle"),
            "cameraCentre": e.get("cameraCentre"), "calibration": calib, "shadow": e.get("shadow"), "reflection": e.get("reflection"), "dir": m.parent}


def extra_camera(e: dict, cfg: dict, camF: geo.Cam) -> np.ndarray:
    """The centre of the camera that gave an extra's pose (the export turned that camera onto -z)."""
    if e["cameraCentre"]:
        return np.asarray(e["cameraCentre"], float)
    if e["pose"] == "C":
        c = (cfg.get("cameras") or {}).get("C")
        if c:
            return np.asarray(json.loads(expand(c).read_text())["C"], float)
        raise ValueError(f"extra {e['id']}: posed from camera C, but neither its cameraCentre nor the config's cameras.C is given")
    return camF.C


def body_files(w: Writer, base: str, s: sp.Splats, sim: geo.Similarity, seen: np.ndarray, camF: geo.Cam | None = None) -> dict:
    """A body placed in court space: freeze.ply, reality.ply, proxy.glb (camera F's depth mesh, when camF is given),
    shadow.png and reflection.png under `base`. Returns the placed points and the floor rect."""
    placed = s.transformed(sim)
    keep = placed.alpha > 0.5
    keep = keep if keep.sum() > 100 else np.ones(len(placed), bool)
    P = placed.pos[keep]
    sp.write_ply(w.path(f"{base}/freeze.ply"), placed)
    sp.write_ply(w.path(f"{base}/reality.ply"), sp.reality(placed, seen))
    if camF is not None:
        w.path(f"{base}/proxy.glb").write_bytes(sp.proxy_glb(placed.pos, placed.alpha, camF, name=f"{Path(base).name}-proxy"))
    rect = sp.floor_rect(P)
    shadow, refl = sp.floor_maps(P, placed.alpha[keep], placed.rgb[keep], rect)
    sp.write_png(w.path(f"{base}/shadow.png"), shadow)
    sp.write_png(w.path(f"{base}/reflection.png"), refl)
    return {"P": P, "rect": rect, "count": len(placed), "seen": float(seen.mean())}


def seen_of(s: sp.Splats, reality, spz: Path | None, w: Writer | None = None, who: str = "", same_space: bool = True) -> np.ndarray:
    """What the cameras saw: from the export's .reality.spz, or a reality PLY in the same order (unchanged colour =
    seen). Without either everything counts as seen, and the assembly notes it (rule 6: never pass invention off as
    real, so the Reality check of such a body is incomplete until its reality file lands)."""
    if reality == "all":  # no camera saw it as it is drawn: all of it is tinted
        return np.zeros(len(s), bool)
    if reality is not None and reality.exists():
        if reality.suffix == ".spz":
            return sp.seen_from_spz(s, reality, spz if spz and spz.exists() else None, check_positions=same_space)
        r = sp.read_ply(reality)
        if len(r) == len(s):
            return np.all(np.isclose(r.dc, s.dc), 1)
    if w is not None:
        w.notes.append(f"{who}: no reality file in its order ({reality}): nothing is marked imagined on it")
    return np.ones(len(s), bool)


def others_piece(w: Writer, cfg: dict, standin: Path, S: dict, spots: list, camF: geo.Cam) -> list:
    d = expand(cfg["extras"]) if cfg.get("extras") else None
    manifests = sorted(d.glob("*/extra.json")) if d and d.exists() else []
    out, planned = [], []
    for m in manifests:
        e = read_extra(m)
        if e is None:
            if json.loads(m.read_text()).get("kind") != "out":
                planned.append(m.parent.name)
            continue
        base = f"others/{e['id']}"
        ent = {"id": e["id"], "kind": e["kind"], "pose": e["pose"], "foot": rnd(e["foot"])}
        if e["name"]:
            ent["name"] = e["name"]
        if e["kind"] == "relief":
            ent["file"] = w.copy(e["file"], f"{base}/relief.glb", within=e["dir"])
            ent["reality"] = w.copy(e["reality"], f"{base}/reality.glb", within=e["dir"])
            for k in ("shadow", "reflection"):
                ent[k] = {"image": w.copy(e["dir"] / e[k]["image"], f"{base}/{k}.png", within=e["dir"]), "rect": e[k]["rect"]}
            ent["height"] = e["height"] or round(float(glb_bounds(e["file"])[1][1]), 3)
        else:
            if e["file"].is_symlink() or not inside(e["file"], e["dir"]):
                raise ValueError(f"extra {e['id']}: {e['file']} is not a plain file inside {e['dir']}")
            s = sp.read_ply(e["file"])
            P0 = sp.solid(s)
            if e["space"] == "court":
                sim = geo.Similarity(1.0, np.eye(3), np.zeros(3))
            else:
                sim, _ = geo.place_by_feet(P0, [0.0, 1.0, -25.0], e["foot"][::2], extra_camera(e, cfg, camF))
            b = body_files(w, base, s, sim, seen_of(s, e["reality"], e["spz"], w, f"extra {e['id']}", same_space=False))
            ent["file"], ent["reality"] = f"{base}/freeze.ply", f"{base}/reality.ply"
            top = round(float(np.percentile(b["P"][:, 1], 99.5)), 3)
            # the declared foot and listed height stay: --validate holds the model to them (P12)
            if e["height"]:
                ent["height"] = e["height"]
            else:
                ent["height"] = top
                w.notes.append(f"extra {e['id']}: no listed height; court.json carries the model's own ({top:.2f} m)")
            ent["shadow"] = {"image": f"{base}/shadow.png", "rect": b["rect"]}
            ent["reflection"] = {"image": f"{base}/reflection.png", "rect": b["rect"]}
        chest = np.array([ent["foot"][0], 0.6 * ent["height"], ent["foot"][2]])
        ent["maxRayAngle"] = round(max(geo.angle_deg(chest - camF.C, chest - np.array([q[0], 1.6, q[2]])) for q in spots), 2)
        out.append(ent)
        w.piece(f"extra:{e['id']}", True, str(e["file"]))
    if planned:
        w.notes.append(f"extras not landed yet: {', '.join(planned)}")
    if not out:
        for o in S["freeze"]["others"]:
            ent = json.loads(json.dumps(o))
            for rel in bundle_paths(ent):
                w.copy(standin / rel, rel, within=standin)
            out.append(ent)
            w.piece(f"extra:{o['id']}", False, "stand-in extra where the stand-in put it")
    return out


def make_stands(cfg: dict) -> dict:
    """Triangulate the stands from the config's frame pairs (stands.triangulate: {"a": {calib, frames}, "b": {calib,
    frames}, "pairs": [[a_frame, b_frame], ...]}, frames = a folder of <frame:06d>.png the calibration was solved on)
    and write the proxy planes to stands.proxyFile. Slow (SIFT on 4K frames), so it is its own step."""
    import cv2

    import assemble_stands as stx

    t = cfg["stands"]["triangulate"]
    calibs = {k: json.loads(expand(t[k]["calib"]).read_text()) for k in ("a", "b")}

    def calcam(k: str, n: int) -> stx.CalCam:
        c = calibs[k]
        fr = next(f for f in c["frames"] if f["source_frame"] == n)
        W, H = c["image_size"]
        return stx.CalCam(geo.Cam(np.asarray(c["C"], float), np.asarray(fr["R"], float).T, float(fr["f"]), (W - 1) / 2, (H - 1) / 2, W, H), float(fr.get("k1", 0.0)))

    pts, per_pair = [], []
    for a, b in t["pairs"]:
        ia = cv2.imread(str(expand(t["a"]["frames"]) / f"{a:06d}.png"))
        ib = cv2.imread(str(expand(t["b"]["frames"]) / f"{b:06d}.png"))
        X, err = stx.triangulate_frames(ia, calcam("a", a), ib, calcam("b", b), max_err=t.get("maxErrPx", 3.0))
        pts.append(X)
        per_pair.append({"pair": [a, b], "points": int(len(X)), "medianErrPx": round(float(np.median(err)), 2) if len(err) else None})
    X = np.concatenate(pts) if pts else np.zeros((0, 3))
    planes, rep = stx.stands_planes(X)
    out = {"proxy": planes, "report": {**rep, "pairs": per_pair}}
    path = expand(cfg["stands"]["proxyFile"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=1))
    return out


def stands_piece(w: Writer, cfg: dict, standin: Path, S: dict) -> dict:
    """The stands proxy measured from two cameras (stands.proxyFile, made by --make-stands) and the depth cards in
    the config; without a measured proxy, the stand-in's proxy and card."""
    st = cfg.get("stands") or {}
    pf = expand(st["proxyFile"]) if st.get("proxyFile") else None
    if pf is not None and pf.exists():
        made = json.loads(pf.read_text())
        block = {"proxy": made["proxy"], "cards": []}
        for c in st.get("cards", []):
            block["cards"].append({"id": c["id"], "image": w.copy(expand(c["image"]), f"stands/{c['id']}.png"), "quad": c["quad"]})
        rep = made.get("report", {})
        up = rep.get("upper", {})
        if rep.get("guessed"):
            w.piece("stands", False, f"stands planes guessed: only {rep.get('front', {}).get('n')} triangulated points with enough parallax")
        else:
            w.piece("stands", True, f"front plane at x = {rep.get('front', {}).get('x')} m from {rep.get('points')} triangulated points; "
                    f"upper plane {'fitted' if up.get('fit') else 'guessed 1.5 m behind (no points that high)'}")
        if not block["cards"]:
            w.notes.append("stands: no depth cards yet (front row, photographers, ref): they need the clean plate and its people mattes")
        return block
    block = json.loads(json.dumps(S["freeze"]["stands"]))
    for rel in bundle_paths(block):
        w.copy(standin / rel, rel, within=standin)
    w.piece("stands", False, "stand-in stands proxy and front-row card")
    return block


def crowd_sources(n: int, loop_s: float) -> list[dict]:
    """>= 4 HRTF sources in the stands (P31): behind the play's basket and along both sidelines, each playing the bed
    from its own offset so no two are in step."""
    at = [[LENGTH / 2 + 2.0, 4.0, -7.0], [LENGTH / 2 + 2.0, 4.5, 0.0], [LENGTH / 2 + 2.0, 4.0, 7.0],
          [6.0, 4.0, WIDTH / 2 + 2.0], [6.0, 4.0, -WIDTH / 2 - 2.0], [-4.0, 4.5, WIDTH / 2 + 2.0], [-4.0, 4.5, -WIDTH / 2 - 2.0]][:n]
    return [{"at": a, "offsetS": round(i * loop_s / len(at), 2)} for i, a in enumerate(at)]


def audio_piece(w: Writer, cfg: dict, standin: Path, S: dict) -> dict:
    a = cfg.get("audio") or {}
    if a.get("loop") and expand(a["loop"]).exists():
        x, sr = au.read_wav(expand(a["loop"]))
        if a.get("swell"):
            t0, t1, db = a["swell"][0], a["swell"][1], None
        else:
            t0, t1, db = au.find_swell(x.mean(1), sr, tuple(a["search"]) if a.get("search") else None)
        info = au.make_audio(x, sr, (t0, t1), w.path("audio"), lufs=a.get("lufs", -23.0))
        info["swellAboveDb"] = None if db is None else round(db, 2)
        w.piece("audio", True, f"{expand(a['loop']).name}: swell {t0:.2f}-{t1:.2f} s cut out and made a one-shot", **info)
        return {"bed": "audio/bed.m4a", "lufs": round(info["bedLufs"], 1), "sources": crowd_sources(6, info["bedSeconds"]),
                "oneShots": [{"file": "audio/swell.m4a", "at": "make", "gainDb": info["swellGainDb"]},
                             {"file": "audio/swell.m4a", "at": "stepIn", "gainDb": round(info["swellGainDb"] - 12, 2)}],
                "events": []}
    block = json.loads(json.dumps(S["audio"]))
    for rel in bundle_paths(block):
        w.copy(standin / rel, rel, within=standin)
    w.piece("audio", False, "stand-in crowd noise")
    return block


def metrics_piece(cfg: dict, calib_json: dict | None, camF: geo.Cam, frames: list, players: list) -> dict:
    rep = {"median": None, "p95": None}
    if calib_json and (calib_json.get("summary") or {}).get("click_reproj_px"):
        px = calib_json["summary"]["click_reproj_px"]
        rep = {k: round(math.degrees(math.atan(px[k] / camF.f)), 5) for k in ("median", "p95")}
    held = {p["id"]: (cfg_player(cfg, p["id"]).get("metrics") or {}).get("heldOutPsnr") for p in players}
    seat = (cfg.get("metrics") or {}).get("seatPsnr", {"players": None, "background": None})
    interp = sum(1 for f in frames if f["interp"]) / len(frames)
    return {"reprojDeg": rep, "heldOutPsnrVsGenerated": held, "seatPsnr": seat, "interpShare": round(interp, 4)}


def cfg_player(cfg: dict, pid: str) -> dict:
    return next((p for p in cfg.get("players", []) if p.get("id") == pid), {})


# ---------------------------------------------------------------- assembly

def assemble(cfg: dict, standin: Path, out: Path) -> dict:
    guard_out(out)
    standin = standin.resolve()
    clips = expand(cfg["clips"]) if cfg.get("clips") else None
    cfg = {**cfg, "players": [resolve_run(p, clips) for p in cfg.get("players", [])]}
    S = json.loads((standin / "court.json").read_text())
    calib_json = json.loads(expand(cfg["calib"]).read_text()) if cfg.get("calib") else None
    calib = geo.CalibTrack(calib_json) if calib_json else None
    if (out.exists() or out.is_symlink()) and not (out.is_dir() and not out.is_symlink() and is_bundle(out)):
        raise ValueError(f"{out} exists and isn't a bundle assemble.py made: refusing to replace it")
    out.parent.mkdir(parents=True, exist_ok=True)
    import tempfile

    tmp = Path(tempfile.mkdtemp(prefix=f".{out.name}.tmp-", dir=out.parent))  # new, empty, ours
    guard_out(tmp)
    w = Writer(tmp)
    try:
        video, frames, timing = show_piece(w, cfg, standin, S, calib)
        real_show = w.pieces["show"]["source"] == "real"
        camera = camera_block(cfg, S, timing, calib, real_show)
        camF = frame_camera(camera, frames, video)
        camF_standin = standin_camera_f(S, standin)
        fill_plates(w, video, camF)
        court = court_piece(w, cfg, standin, S)
        slots = cfg.get("players") or [{} for _ in S["freeze"]["players"]]
        players = [place_player(w, slot, i % len(S["freeze"]["players"]), standin, S, camF, camF_standin) for i, slot in enumerate(slots)]
        splats_by_id = {p["id"]: sp.solid(sp.read_ply(tmp / p["splats"])) for p in players}
        k1F = 0.0
        if calib is not None:
            f_real = (cfg.get("source") or {}).get("freezeSource", video["freezeSource"])
            k1F = calib.k1[int(np.argmin(np.abs(np.asarray(calib.src) - f_real)))]
        ball = ball_piece(w, cfg, S, players, camF, splats_by_id, k1F)
        seat_cfg = {**SEAT, **(cfg.get("seat") or {})}
        pair = np.mean([p["_"]["contact"] for p in players], 0)
        pair_centre = [round(float(pair[0]), 3), 0.0, round(float(pair[1]), 3)]
        # the walking spots are the runtime's (seatmath.ts); these approximations only size the extras' maxRayAngle
        spots = geo.viewing_spots(pair_centre, camF.C, [(p["bounds"]["min"], p["bounds"]["max"]) for p in players], seat_cfg["clear"])
        seat = {"ray": "freeze", "distance": seat_cfg["distance"], "distanceRange": seat_cfg["distanceRange"],
                "pairCentre": pair_centre, "clear": seat_cfg["clear"]}
        w.piece("seat", any(w.pieces[f"player:{p['id']}"]["source"] == "real" for p in players) or bool(cfg.get("players")),
                "Decision W: the pair's centre from the placed soles")
        others = others_piece(w, cfg, standin, S, spots, camF)
        stands = stands_piece(w, cfg, standin, S)
        audio = audio_piece(w, cfg, standin, S)
        light = {**LIGHT, **(cfg.get("light") or {})}
        w.piece("light", True, "plan 3.3 levels (both sets)")
        metrics = metrics_piece(cfg, calib_json, camF, frames, players)
        meta_real = all(k in cfg for k in ("title", "caption", "credit"))
        w.piece("text", meta_real, "config title, caption and credit" if meta_real else "stand-in text")
        stand_in = [k for k, v in w.pieces.items() if v["source"] == "stand-in"]
        court_json = {
            "version": 1,
            "title": cfg.get("title", "Court Side") + (" (hybrid: stand-in pieces)" if stand_in else ""),
            "caption": cfg.get("caption", S["caption"]),
            "label": LABEL,
            "credit": cfg.get("credit", S["credit"]) + (f" Stand-in pieces: {', '.join(stand_in)}." if stand_in else ""),
            "court": court, "camera": camera, "video": video, "light": light, "seat": seat,
            "freeze": {"players": [{k: v for k, v in p.items() if k != "_"} for p in players], "ball": ball,
                       "others": others, "stands": stands},
            "audio": audio, "metrics": metrics,
        }
        w.json("court.json", court_json, indent=1)
        diag = {
            "assembledAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "generator": "court-side assemble.py",
            "standin": str(standin), "config": {k: v for k, v in cfg.items() if k in ("calib", "show", "extras")},
            "pieces": w.pieces, "notes": w.notes,
            "players": {p["id"]: {**{k: v for k, v in p["_"].items() if k not in ("sim", "contact")},
                                  "similarity": p["_"]["sim"].as_json(), "contact": rnd(p["_"]["contact"], 3)} for p in players},
            "splats": {"players": sum(p["_"]["count"] for p in players)},
            "cameraF": {"centre": rnd(camF.C), "axis": rnd(camF.axis, 6), "f": round(camF.f, 2)},
        }
        w.json("assembly.json", diag, indent=1)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    prev = rotate_into(out, tmp)
    diag["previous"] = str(prev) if prev else None
    return diag


# ---------------------------------------------------------------- validation

def annexb_units(data: bytes) -> list[tuple[int, int]]:
    """(nal type, offset of its payload) for every NAL unit of an Annex B stream."""
    out, i, n = [], 0, len(data)
    while True:
        j = data.find(b"\x00\x00\x01", i)
        if j < 0 or j + 3 >= n:
            return out
        out.append((data[j + 3] & 0x1F, j + 3))
        i = j + 3


def h264_info(path: Path) -> dict:
    """The stream's codec string (from its SPS), its pictures (a slice whose first_mb_in_slice is 0 starts one: ue(v)
    0 is a single 1 bit, the top bit of the byte after the NAL header, so a multi-slice picture counts once and an
    AUD with nothing behind it counts nothing), which pictures are IDR, and its access units as the app splits them
    (annexb.ts splitAnnexB: at each AUD, NAL 9): `badAus` counts units holding other than exactly one picture, and
    pictures before the first AUD (the app drops those)."""
    data = path.read_bytes()
    units = annexb_units(data)
    sps = next((o for t, o in units if t == 7), None)
    codec = None if sps is None else "avc1.%02x%02x%02x" % (data[sps + 1], data[sps + 2], data[sps + 3])
    frame, idr_frames, aus, pics_in_au, bad_aus, orphans = -1, [], 0, None, 0, 0
    for t, o in units:
        if t == 9:
            if pics_in_au is not None and pics_in_au != 1:
                bad_aus += 1
            aus += 1
            pics_in_au = 0
        elif t in (1, 5) and o + 1 < len(data) and data[o + 1] & 0x80:
            frame += 1
            if t == 5:
                idr_frames.append(frame)
            if pics_in_au is None:
                orphans += 1
            else:
                pics_in_au += 1
    if pics_in_au is not None and pics_in_au != 1:
        bad_aus += 1
    return {"codec": codec, "frames": frame + 1, "idr": len(idr_frames), "idrFrames": idr_frames, "bytes": len(data),
            "aus": aus, "badAus": bad_aus, "orphans": orphans}


def decode_info(path: Path) -> dict:
    """What a real decoder makes of the stream (ffprobe decodes every frame): the size of every frame, how many
    decode, and any decoder complaints."""
    p = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=width,height",
                        "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    sizes = [tuple(int(x) for x in ln.split(",")[:2]) for ln in p.stdout.split() if ln.count(",") >= 1]
    first = sizes[0] if sizes else (None, None)
    return {"width": first[0], "height": first[1], "decoded": len(sizes), "sizes": sorted(set(sizes)),
            "errors": p.stderr.strip()[-300:] if p.returncode or p.stderr.strip() else ""}


def glb_bounds(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """The box of every mesh position in a GLB, from its accessors' min/max (glTF requires them on POSITION).
    Node transforms aren't applied, so a GLB that has any is refused: a bundle relief carries court-space vertices."""
    data = Path(path).read_bytes()
    if len(data) < 20 or data[:4] != b"glTF":
        raise ValueError(f"{path}: not a GLB")
    jlen = int.from_bytes(data[12:16], "little")
    js = json.loads(data[20:20 + jlen])
    if any(k in n for n in js.get("nodes", []) for k in ("matrix", "translation", "rotation", "scale")):
        raise ValueError(f"{path}: has node transforms; bake them into the vertices (court space)")
    los, his = [], []
    for m in js.get("meshes", []):
        for prim in m.get("primitives", []):
            a = js["accessors"][prim["attributes"]["POSITION"]]
            if "min" not in a or "max" not in a:
                raise ValueError(f"{path}: a POSITION accessor without min/max")
            los.append(a["min"])
            his.append(a["max"])
    if not los:
        raise ValueError(f"{path}: no mesh positions")
    return np.min(los, 0), np.max(his, 0)


def check_stream(bundle: Path, label: str, s: dict, n_frames: int, seg: dict, errs: list, info: list) -> None:
    """One encoded stream against what court.json says of it: codec, size, frame count (parsed and decoded) and an
    IDR picture at every segment start."""
    f = s["file"]
    h, d = h264_info(bundle / f), decode_info(bundle / f)
    info.append(f"{f} ({label}): {d['width']}x{d['height']}, {h['frames']} frames ({d['decoded']} decode), {h['idr']} IDR, "
                f"{h['codec']}, {h['bytes'] / 1e6:.1f} MB")
    if h["codec"] != str(s["codec"]).lower():
        errs.append(f"{f}: its SPS says {h['codec']}, court.json says {s['codec']}")
    if d["sizes"] != [(s["width"], s["height"])]:
        got = ", ".join(f"{w_}x{h_}" for w_, h_ in d["sizes"]) or "nothing"
        errs.append(f"{f}: frames decode at {got}, court.json says {s['width']}x{s['height']} for every frame")
    if h["orphans"] or h["badAus"] or h["aus"] != h["frames"]:
        errs.append(f"{f}: the app splits frames at each access unit delimiter (NAL 9): {h['aus']} delimiters for "
                    f"{h['frames']} pictures, {h['orphans']} picture(s) before the first, {h['badAus']} unit(s) not holding exactly one")
    if h["frames"] != n_frames or d["decoded"] != n_frames:
        errs.append(f"{f}: {h['frames']} frame(s) in the stream and {d['decoded']} decode, its frames.json has {n_frames}")
    if d["errors"]:
        errs.append(f"{f}: the decoder complains: {d['errors']}")
    starts = sorted({seg["pass1"][0], seg["pass2"][0], seg["resume"][0], *(e["frames"][0] for e in seg["eases"])})
    missing = [x for x in starts if x not in set(h["idrFrames"])]
    if missing:
        errs.append(f"{f}: no IDR frame at segment start(s) {missing} (IDR frames at {h['idrFrames'][:12]})")


def node_validate(bundle: Path, webxr: Path) -> list[str]:
    """format.ts's own validators (validateCourt, validateFrames, validateCards when it exists) on the bundle."""
    fmt = webxr / "src" / "court" / "format.ts"
    script = (
        "const [fmt, dir] = process.argv.slice(-2);"
        "const fs = await import('node:fs'); const url = await import('node:url'); const path = await import('node:path');"
        "const m = await import(url.pathToFileURL(fmt).href);"
        "const read = (p) => JSON.parse(fs.readFileSync(path.join(dir, p), 'utf8'));"
        "const court = read('court.json'); let errs = m.validateCourt(court);"
        "const check = (c, tag) => { const frames = read(c.video.frames); let e = m.validateFrames(frames, c);"
        "  if (!e.length && m.validateCards && c.video.cards) e = m.validateCards(read(c.video.cards), c, frames);"
        "  return e.map((x) => tag + x); };"
        "if (!errs.length) errs = check(court, '');"
        "if (!errs.length && court.video.fallbacks && court.video.fallbacks.hz90 && m.chooseStream) errs = check(m.chooseStream(court, 'hz90'), 'hz90 ');"
        "console.log(JSON.stringify(errs));"
    )
    p = subprocess.run(["node", "--experimental-transform-types", "--no-warnings", "--input-type=module", "-e", script, str(fmt), str(bundle)],
                       capture_output=True, text=True)
    if p.returncode != 0:
        return [f"format.ts could not run: {p.stderr.strip()[-600:]}"]
    return json.loads(p.stdout.strip().splitlines()[-1])


def validate(bundle: Path, webxr: Path, strict: bool = False) -> tuple[list[str], list[str], list[str]]:
    """(errors, pending, info). Errors: format.ts's, missing or unreadable files, sizes and codecs that disagree with
    court.json, coordinates that make no sense. Pending: what isn't measured or real yet."""
    errs, pending, info = [], [], []
    cj = bundle / "court.json"
    if not cj.exists():
        return [f"no court.json in {bundle}"], [], []
    errs += [f"format.ts: {e}" for e in node_validate(bundle, webxr)]
    court = json.loads(cj.read_text())
    # every file named is there and readable
    for rel in sorted(set(bundle_paths(court))):
        p = bundle / rel
        if rel.startswith("/") or ".." in Path(rel).parts or "://" in rel:
            errs.append(f"{rel}: outside the bundle")
        elif not p.is_file() or p.stat().st_size == 0:
            errs.append(f"{rel}: missing or empty")
    if errs:
        return errs, pending, info
    v = court["video"]
    frames = json.loads((bundle / v["frames"]).read_text())
    check_stream(bundle, "main", v, len(frames), v["segments"], errs, info)
    fb = v.get("fallbacks") or {}
    if isinstance(fb.get("small"), dict):  # the same show frame for frame
        check_stream(bundle, "small", fb["small"], len(frames), v["segments"], errs, info)
    if isinstance(fb.get("hz90"), dict):  # its own frames and segments
        hz = fb["hz90"]
        check_stream(bundle, "hz90", hz, len(json.loads((bundle / hz["frames"]).read_text())), hz["segments"], errs, info)
    import cv2
    fz = cv2.imread(str(bundle / v["freeze"]), cv2.IMREAD_UNCHANGED)
    cam = court["camera"]
    if fz is None:
        errs.append(f"{v['freeze']}: not an image")
    else:
        if abs(fz.shape[0] - fz.shape[1] * cam["height"] / cam["width"]) > 1:
            errs.append(f"{v['freeze']}: {fz.shape[1]}x{fz.shape[0]} is not the source's aspect")
        for k in ("freezeClean", "standsMask", "inpaintMask"):
            if v.get(k):
                im = cv2.imread(str(bundle / v[k]), cv2.IMREAD_UNCHANGED)
                if im is None or im.shape[:2] != fz.shape[:2]:
                    errs.append(f"{v[k]}: not the size of {v['freeze']}")
    # players
    total = 0
    for p in court["freeze"]["players"]:
        s = sp.read_ply(bundle / p["splats"])
        r = sp.read_ply(bundle / p["reality"])
        total += len(s)
        if len(r) != len(s):
            errs.append(f"{p['reality']}: {len(r)} Gaussians, {p['splats']} has {len(s)}")
        P = sp.solid(s)
        lo, hi = np.percentile(P, 0.5, 0), np.percentile(P, 99.5, 0)
        if abs(lo[1]) > 0.03:
            errs.append(f"{p['id']}: lowest points at y = {lo[1]:.3f} m, not on the floor")
        if not 1.5 <= hi[1] <= 3.3:
            errs.append(f"{p['id']}: top at {hi[1]:.2f} m: not a person's height")
        if abs(lo[0]) > LENGTH / 2 + 2 or abs(lo[2]) > WIDTH / 2 + 2:
            errs.append(f"{p['id']}: stands off the court at ({lo[0]:.1f}, {lo[2]:.1f})")
        pos, idx = sp.read_glb((bundle / p["proxy"]).read_bytes())
        if not len(pos) or idx.max() >= len(pos):
            errs.append(f"{p['proxy']}: an empty or broken mesh")
    asm_pieces = json.loads((bundle / "assembly.json").read_text()).get("pieces", {}) if (bundle / "assembly.json").exists() else {}
    for o in court["freeze"]["others"]:
        problems = []
        if o["file"].endswith(".glb"):
            try:
                lo3, hi3 = glb_bounds(bundle / o["file"])
            except ValueError as e:
                errs.append(f"{o['id']}: {e}")
                continue
            lo, top = float(lo3[1]), float(hi3[1])
            foot_xz = (lo3[[0, 2]] + hi3[[0, 2]]) / 2  # a relief is thin: its box's middle stands on its foot
            c = (lo3 + hi3) / 2
        else:
            s = sp.read_ply(bundle / o["file"])
            total += len(s)
            P = sp.solid(s)
            lo, top = float(np.percentile(P[:, 1], 0.5)), float(np.percentile(P[:, 1], 99.5))
            foot_xz = sp.contact_points_xz(P)
            c = P.mean(0)
        off = float(np.linalg.norm(foot_xz - [o["foot"][0], o["foot"][2]]))
        if off > 0.3:
            problems.append(f"its soles are {off:.2f} m from its foot point {o['foot']}")
        if abs(lo) > 0.05:
            problems.append(f"lowest points at y = {lo:.3f} m, not on the floor")
        if o.get("height") and abs(top / o["height"] - 1) > 0.03:
            problems.append(f"{top:.2f} m tall, court.json says {o['height']} m (P12: 3%)")
        if abs(c[0]) > LENGTH / 2 + 3 or abs(c[2]) > WIDTH / 2 + 3:
            problems.append(f"stands off the court at ({c[0]:.1f}, {c[2]:.1f})")
        stand_in = asm_pieces.get(f"extra:{o['id']}", {}).get("source") == "stand-in"
        for pr in problems:
            (pending if stand_in and not strict else errs).append(f"{o['id']}: {pr}" + (" (a stand-in)" if stand_in else ""))
    info.append(f"splats: {total} in all ({len(court['freeze']['players'])} players + {len(court['freeze']['others'])} extras), budget {SPLAT_BUDGET}")
    if total > SPLAT_BUDGET:
        errs.append(f"splats: {total} Gaussians is over the {SPLAT_BUDGET} budget (plan 8)")
    b = court["freeze"]["ball"]
    near = min(geo.box_distance_xz(b["centre"], (p["bounds"]["min"], p["bounds"]["max"])) for p in court["freeze"]["players"])
    if near > 0.5 or not 0.1 < b["centre"][1] < 3.5:
        errs.append(f"freeze.ball.centre {b['centre']}: not with a player")
    # the seat: F's ray passes the pair
    eases = v["segments"]["eases"]
    fF = frames[eases[0]["frames"][1]]
    C = np.asarray(cam["centre"], float)
    ax = geo.quat_to_matrix(fF["q"])[:, 2]
    pc = np.asarray(court["seat"]["pairCentre"], float)
    h = ax[[0, 2]] / np.linalg.norm(ax[[0, 2]])
    d = (pc - C)[[0, 2]]
    miss = abs(float(h[0] * d[1] - h[1] * d[0]))
    if float(h @ d) <= 0:
        errs.append("seat.pairCentre: it is behind camera F")
    info.append(f"seat: camera F's ray passes {miss:.2f} m from the pair's centre (on the floor)")
    if miss > 2.0:
        errs.append(f"seat.pairCentre: camera F's ray passes {miss:.2f} m from it")
    # audio
    a = court["audio"]
    try:
        bed = au.loudness(bundle / a["bed"])
        info.append(f"{a['bed']}: {bed['I']:.1f} LUFS, {bed['TP']:.1f} dBTP")
        if abs(bed["I"] - -23) > 1 or bed["TP"] > -1:
            errs.append(f"{a['bed']}: {bed['I']:.1f} LUFS / {bed['TP']:.1f} dBTP (P19: -23 +/- 1, <= -1 dBTP)")
    except RuntimeError as e:
        errs.append(str(e))
    # what isn't real or measured yet
    m = court["metrics"]
    for k in ("median", "p95"):
        if m["reprojDeg"].get(k) is None:
            pending.append(f"metrics.reprojDeg.{k}")
    for grp in ("heldOutPsnrVsGenerated", "seatPsnr"):
        for k, x in m[grp].items():
            if x is None:
                pending.append(f"metrics.{grp}.{k}")
    asm = bundle / "assembly.json"
    if asm.exists():
        A_ = json.loads(asm.read_text())
        for pid, d in A_["players"].items():
            rr = d.get("run")
            if not rr:
                if A_["pieces"].get(f"player:{pid}", {}).get("source") == "real":
                    (errs if strict else pending).append(f"{pid} (P42): not measured: no freeze run report (focalHeld, focal, IoU) for this body")
                continue
            # P42: the real view really trained the freeze
            if not rr.get("focalHeld"):
                errs.append(f"{pid} (P42): the recon didn't hold the calibrated focal (focalHeld {rr.get('focalHeld')})")
            if rr.get("FOCAL") is not None and (rr.get("focal") is None or abs(rr["focal"] - rr["FOCAL"]) > 0.5):
                errs.append(f"{pid} (P42): the recon's focal {rr.get('focal')} isn't the run's FOCAL {rr['FOCAL']}")
            if (rr.get("iou") or 0) < 0.95:
                errs.append(f"{pid} (P42): the real frame's silhouette IoU {rr.get('iou')} is under 0.95")
            info.append(f"{pid}: {rr['variant']}-{rr['cap']}, real-frame PSNR {rr.get('sourcePsnr')}, face {rr.get('facePsnr')}, "
                        f"held-out {rr.get('heldOutPsnr')}, iou {rr.get('iou')}")
        for k, pc_ in json.loads(asm.read_text())["pieces"].items():
            if pc_["source"] != "real":
                pending.append(f"{k}: {pc_['detail']}")
    if strict and pending:
        errs += [f"pending: {x}" for x in pending]
    return errs, pending, info


def check_frames(bundle: Path, out_dir: Path, width: int = 768) -> list[Path]:
    """Small JPEGs of the assembled show to look at by eye: the live region at the middle of pass 1 (the watch), the
    middle of the first ease, its last frame (F), and freeze.png. Decoded by ffmpeg from the bundle's own stream."""
    court = json.loads((bundle / "court.json").read_text())
    v = court["video"]
    seg = v["segments"]
    e0 = seg["eases"][0]["frames"]
    picks = {"watch": (seg["pass1"][0] + seg["pass1"][1]) // 2, "mid-ease": (e0[0] + e0[1]) // 2, "at-F": e0[1]}
    x, y, rw, rh = v["regions"]["live"]
    out_dir.mkdir(parents=True, exist_ok=True)
    made = []
    for name, n in picks.items():
        dst = out_dir / f"{name}-show{n:04d}.jpg"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(bundle / v["file"]), "-vf",
                        f"select=eq(n\\,{n}),crop={rw}:{rh}:{x}:{y},scale={width}:-2", "-frames:v", "1", "-q:v", "3", str(dst)], check=True)
        made.append(dst)
    dst = out_dir / "freeze-png.jpg"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(bundle / v["freeze"]), "-vf", f"scale={width}:-2", "-q:v", "3", str(dst)], check=True)
    return made + [dst]


def report(bundle: Path) -> str:
    asm = json.loads((bundle / "assembly.json").read_text())
    court = json.loads((bundle / "court.json").read_text())
    lines = [f"bundle {bundle} (assembled {asm['assembledAt']})"]
    for k, v in asm["pieces"].items():
        lines.append(f"  {v['source']:8} {k}: {v['detail']}")
    for pid, d in asm["players"].items():
        pl = d["placement"]
        lines.append(f"  place {pid}: {pl['mode']} scale {pl.get('scale', 1):.3f}"
                     + (f" tilt {pl['tilt_deg']:.2f} deg" if "tilt_deg" in pl else "")
                     + (f", soles {d['footError'] * 100:.1f} cm from the calibrated point" if "footError" in d else "")
                     + f", height {d['height']:.2f} m, {d['count']} splats")
    lines.append(f"  seat: pair centre {court['seat']['pairCentre']}, D' {court['seat']['distance']} m")
    lines += [f"  note: {n}" for n in asm["notes"]]
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--config", required=True, help="the private assemble.json (outside the repo)")
    ap.add_argument("--out", default=None)
    ap.add_argument("--standin", default=str(DEFAULT_STANDIN))
    ap.add_argument("--webxr", default=str(WEBXR), help="the apps/webxr checkout whose format.ts validates the bundle")
    ap.add_argument("--validate", action="store_true", help="check the assembled bundle (no assembly)")
    ap.add_argument("--strict", action="store_true", help="with --validate: anything pending fails too")
    ap.add_argument("--report", action="store_true", help="print provenance and placement of the assembled bundle")
    ap.add_argument("--make-stands", action="store_true", help="triangulate the stands proxy (stands.triangulate -> stands.proxyFile)")
    ap.add_argument("--check-frames", default=None, help="write small JPEGs of the assembled show (watch, mid-ease, F) to this folder")
    a = ap.parse_args(argv)
    cfg = json.loads(expand(a.config).read_text())
    if not (a.out or cfg.get("out")):
        ap.error("no bundle folder: give --out or the config's `out`")
    out = expand(a.out or cfg["out"])
    if a.check_frames:
        for p in check_frames(out, expand(a.check_frames)):
            print(f"FRAME {p}")
        return 0
    if a.make_stands:
        made = make_stands(cfg)
        print(f"STANDS {expand(cfg['stands']['proxyFile'])}: {json.dumps(made['report'])}")
        return 0
    if a.validate or a.report:
        if a.report:
            print(report(out))
        if a.validate:
            errs, pending, info = validate(out, expand(a.webxr), a.strict)
            for x in info:
                print(f"INFO {x}")
            for x in pending:
                print(f"PENDING {x}")
            for x in errs:
                print(f"FAIL {x}")
            print(f"VALIDATE {'OK' if not errs else 'FAILED'} {out} ({len(errs)} errors, {len(pending)} pending)")
            return 0 if not errs else 1
        return 0
    if not (expand(a.standin) / "court.json").exists():
        print(f"no stand-in at {a.standin}: run node apps/webxr/scripts/court/standin.mjs first", file=sys.stderr)
        return 2
    diag = assemble(cfg, expand(a.standin), out)
    real = sorted(k for k, v in diag["pieces"].items() if v["source"] == "real")
    stand = sorted(k for k, v in diag["pieces"].items() if v["source"] != "real")
    print(f"ASSEMBLED {out}\n  real: {', '.join(real) or '-'}\n  stand-in: {', '.join(stand) or '-'}")
    for n in diag["notes"]:
        print(f"  note: {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
