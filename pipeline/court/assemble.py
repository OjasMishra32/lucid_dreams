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
  seat        {distance, distanceRange, closer, clear, ringArea}
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
SEAT = {"distance": 5.0, "distanceRange": [4, 7], "closer": 2.0, "clear": 1.0, "ringArea": [4.5, 5.5]}
SPLAT_BUDGET = 500_000  # visible at the worst pose until the Quest says more (plan 8)
PATH_EXT = re.compile(r"\.(h264|json|png|jpg|jpeg|ply|glb|m4a|mp4|spz)$", re.I)


def expand(p) -> Path:
    return Path(os.path.expanduser(str(p)))


def rnd(v, d=4):
    return [round(float(x), d) for x in v]


def bundle_paths(o) -> list[str]:
    """Every bundle-relative file path named anywhere in a court.json block."""
    out = []
    if isinstance(o, dict):
        for v in o.values():
            out += bundle_paths(v)
    elif isinstance(o, list):
        for v in o:
            out += bundle_paths(v)
    elif isinstance(o, str) and PATH_EXT.search(o) and "/" in o and not o.startswith(("/", "http")):
        out.append(o)
    return out


class Writer:
    """Collects the bundle's files in a fresh folder and records where each piece came from."""

    def __init__(self, root: Path):
        self.root = root
        self.pieces: dict[str, dict] = {}
        self.notes: list[str] = []

    def piece(self, name: str, real: bool, detail: str, **extra) -> None:
        self.pieces[name] = {"source": "real" if real else "stand-in", "detail": detail, **extra}

    def path(self, rel: str) -> Path:
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def copy(self, src: Path, rel: str) -> str:
        shutil.copyfile(src, self.path(rel))
        return rel

    def json(self, rel: str, obj, indent=None) -> str:
        self.path(rel).write_text(json.dumps(obj, indent=indent, ensure_ascii=False))
        return rel


# ---------------------------------------------------------------- the pieces

def show_dir(cfg: dict) -> tuple[Path | None, str]:
    """The real show's folder (holding video.json) and whose cameras its frames use: "show" (the ones it was baked
    with, the default when its frames.json carries q and f) or "calib" (re-read from the calibration)."""
    show = cfg.get("show")
    if not show:
        return None, "calib"
    d = expand(show["dir"] if isinstance(show, dict) else show)
    return (d if (d / "video.json").exists() else None), (show.get("cameras", "show") if isinstance(show, dict) else "show")


def show_piece(w: Writer, cfg: dict, standin: Path, S: dict, calib: geo.CalibTrack | None):
    """The video block, its frames.json (each show frame's own camera) and the rest of video/; the timing of the clip
    the frames count in. Returns (video block, frames, timing {sourceFps, captureFps, slow, centre?})."""
    d, cams = show_dir(cfg)
    real = d is not None
    if real:
        manifest = json.loads((d / "video.json").read_text())
        video = manifest["video"] if "video" in manifest else manifest
        timing = manifest.get("camera", {})
        for rel in bundle_paths(video):
            w.copy(d / (rel.split("/", 1)[1] if rel.startswith("video/") else rel), rel)
        frames = json.loads((d / Path(video["frames"]).name).read_text())
        w.piece("show", True, str(d))
        own = all("q" in fr and "f" in fr for fr in frames)
        if cams == "show" and not own:
            cams = "calib"
    else:
        video = json.loads(json.dumps(S["video"]))
        for rel in bundle_paths(video):
            w.copy(standin / rel, rel)
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
        for fr in frames:
            q, f = calib.at(f_real + (fr["src"] - f_show) * k)
            fr["q"], fr["f"] = rnd(q, 9), round(float(f), 4)
        timing = {**timing, "centre": rnd(calib.C)}
        w.piece("cameras", True, f"every show frame's camera from the calibration ({calib.clamped} frames outside its "
                f"range {calib.range} held at its ends)", clamped=calib.clamped)
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


def recon_cameras(slot: dict) -> tuple[geo.Cam, geo.Cam]:
    """(the run's solved source camera in the PLY's bundle space, the court camera it was cut from) from the run's
    files: recon's source-camera-<K>.json (the rig's world, OpenCV camera_to_world, K for source-4k.mkv's crop), the
    export's dream.json `placement` (rig -> bundle: x' = rot x + t) and court-run.json's still camera (court space,
    camera-from-world R, K with the crop's own principal point)."""
    c = json.loads(expand(slot["sourceCamera"]).read_text())
    pl = json.loads(expand(slot["dream"]).read_text())["placement"]
    run = json.loads(expand(slot["courtRun"]).read_text())
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
    has_cams = real and all(slot.get(k) and expand(slot[k]).exists() for k in ("sourceCamera", "dream", "courtRun"))
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
    placed = s.transformed(sim)
    Pp = sp.solid(placed)
    base = f"players/{pid}"
    sp.write_ply(w.path(f"{base}/freeze.ply"), placed)
    if real and slot.get("reality") and expand(slot["reality"]).exists():
        seen = sp.seen_from_spz(s, expand(slot["reality"]), expand(slot["spz"]) if slot.get("spz") else None)
    else:
        r = sp.read_ply(standin / S["freeze"]["players"][i]["reality"]) if not real else None
        seen = np.all(np.isclose(r.dc, s.dc), 1) if r is not None and len(r) == len(s) else np.ones(len(s), bool)
    sp.write_ply(w.path(f"{base}/reality.ply"), sp.reality(placed, seen))
    w.path(f"{base}/proxy.glb").write_bytes(sp.proxy_glb(placed.pos, placed.alpha, camF, name=f"{pid}-proxy"))
    rect = sp.floor_rect(Pp)
    keep = placed.alpha > 0.5
    shadow, refl = sp.floor_maps(Pp, placed.alpha[keep] if keep.sum() > 100 else placed.alpha,
                                 placed.rgb[keep] if keep.sum() > 100 else placed.rgb, rect)
    sp.write_png(w.path(f"{base}/shadow.png"), shadow)
    sp.write_png(w.path(f"{base}/reflection.png"), refl)
    contact = sp.contact_points_xz(Pp)
    entry = {
        "id": pid, "name": name, "splats": f"{base}/freeze.ply", "reality": f"{base}/reality.ply", "proxy": f"{base}/proxy.glb",
        "bounds": sp.bounds(Pp), "seenFraction": round(float(seen.mean()), 3),
        "capsules": [{k: c[k] for k in ("a", "b", "r")} for c in sp.body_capsules(Pp)],
        "shadow": {"image": f"{base}/shadow.png", "rect": rect}, "reflection": {"image": f"{base}/reflection.png", "rect": rect},
        "_": {"sim": sim, "contact": contact, "count": len(placed), "placement": {k: (round(v, 4) if isinstance(v, float) else v) for k, v in info.items()},
              "height": round(float(np.percentile(Pp[:, 1], 99.5)), 3)},
    }
    if feet is not None:
        entry["_"]["footError"] = round(float(np.linalg.norm(contact - feet.mean(0))), 3)
    w.piece(f"player:{pid}", real, str(expand(slot["splats"])) if real else f"stand-in body '{S['freeze']['players'][i]['id']}' re-placed at the calibrated feet")
    return entry


def ball_piece(w: Writer, cfg: dict, S: dict, players: list, camF: geo.Cam, splats_by_id: dict) -> dict:
    b = cfg.get("ball") or {}
    first = players[0]["id"]
    erase = [{"player": p["id"], "radius": 0.15} for p in players[:1]]
    if b.get("centre"):
        w.piece("ball", True, "config centre")
        return {"centre": rnd(b["centre"]), "radius": BALL_RADIUS, "erase": erase}
    if b.get("pixel") and b.get("depthFrom") in splats_by_id:
        # F's ball pixel on its ray, at the holding player's depth there (the ball's visible face is at the hand)
        ray = camF.rays(np.array([b["pixel"][0]]), np.array([b["pixel"][1]]))[0]
        P = splats_by_id[b["depthFrom"]]
        t = (P - camF.C) @ ray
        off = np.linalg.norm((P - camF.C) - np.outer(t, ray), axis=1)
        near = t[off < BALL_RADIUS]
        if len(near) < 10:
            raise ValueError(f"ball: fewer than 10 of {b['depthFrom']}'s Gaussians lie on the ball's ray")
        centre = camF.C + (np.percentile(near, 10) + BALL_RADIUS) * ray
        w.piece("ball", True, f"F's ball pixel at {b['depthFrom']}'s depth")
        return {"centre": rnd(centre), "radius": BALL_RADIUS, "erase": [{"player": b["depthFrom"], "radius": 0.15}]}
    # the stand-in ball, carried with the first player's placement (it sits in their hand)
    sim = players[0]["_"]["sim"]
    w.piece("ball", False, f"stand-in ball carried with {first}'s placement")
    return {"centre": rnd(sim.apply(np.asarray(S["freeze"]["ball"]["centre"], float))), "radius": BALL_RADIUS, "erase": erase}


def others_piece(w: Writer, cfg: dict, standin: Path, S: dict, spots: list, camF: geo.Cam) -> list:
    d = expand(cfg["extras"]) if cfg.get("extras") else None
    manifests = sorted(d.glob("*/extra.json")) if d and d.exists() else []
    out = []
    for m in manifests:
        e = json.loads(m.read_text())
        base = f"others/{e['id']}"
        ent = {"id": e["id"], "kind": e["kind"], "pose": e["pose"], "foot": rnd(e["foot"]), "height": e["height"]}
        if e.get("name"):
            ent["name"] = e["name"]
        for k in ("file", "reality"):
            src = m.parent / e[k]
            ent[k] = w.copy(src, f"{base}/{k if k == 'reality' else 'freeze'}{src.suffix}")
        chest = np.array([e["foot"][0], 0.6 * e["height"], e["foot"][2]])
        ent["maxRayAngle"] = round(max(geo.angle_deg(chest - camF.C, chest - np.array([s[0], 1.6, s[2]])) for s in spots), 2)
        for k in ("shadow", "reflection"):
            if e.get(k):
                ent[k] = {"image": w.copy(m.parent / e[k]["image"], f"{base}/{k}.png"), "rect": e[k]["rect"]}
        if "shadow" not in ent or "reflection" not in ent:
            s = sp.read_ply(m.parent / e["file"]) if e["file"].endswith(".ply") else None
            if s is None:
                raise ValueError(f"{m}: a relief needs its own shadow and reflection images")
            P = sp.solid(s)
            rect = sp.floor_rect(P)
            sh, rf = sp.floor_maps(P, np.ones(len(P)), np.full((len(P), 3), 0.5), rect)
            sp.write_png(w.path(f"{base}/shadow.png"), sh)
            sp.write_png(w.path(f"{base}/reflection.png"), rf)
            ent["shadow"] = {"image": f"{base}/shadow.png", "rect": rect}
            ent["reflection"] = {"image": f"{base}/reflection.png", "rect": rect}
        out.append(ent)
        w.piece(f"extra:{e['id']}", True, str(m.parent))
    if not out:
        for o in S["freeze"]["others"]:
            ent = json.loads(json.dumps(o))
            for rel in bundle_paths(ent):
                w.copy(standin / rel, rel)
            ent["name"] = f"{o.get('name', o['id'])}"
            out.append(ent)
            w.piece(f"extra:{o['id']}", False, "stand-in extra where the stand-in put it")
    return out


def stands_piece(w: Writer, cfg: dict, standin: Path, S: dict) -> dict:
    st = cfg.get("stands")
    if st:
        block = {"proxy": st["proxy"], "cards": []}
        for c in st.get("cards", []):
            block["cards"].append({"id": c["id"], "image": w.copy(expand(c["image"]), f"stands/{c['id']}.png"), "quad": c["quad"]})
        w.piece("stands", True, "config stands")
        return block
    block = json.loads(json.dumps(S["freeze"]["stands"]))
    for rel in bundle_paths(block):
        w.copy(standin / rel, rel)
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
        w.copy(standin / rel, rel)
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
    standin = standin.resolve()
    S = json.loads((standin / "court.json").read_text())
    calib_json = json.loads(expand(cfg["calib"]).read_text()) if cfg.get("calib") else None
    calib = geo.CalibTrack(calib_json) if calib_json else None
    tmp = out.parent / f".{out.name}.tmp-{os.getpid()}"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)
    w = Writer(tmp)
    try:
        video, frames, timing = show_piece(w, cfg, standin, S, calib)
        real_show = w.pieces["show"]["source"] == "real"
        camera = camera_block(cfg, S, timing, calib, real_show)
        camF = frame_camera(camera, frames, video)
        camF_standin = standin_camera_f(S, standin)
        court = court_piece(w, cfg, standin, S)
        slots = cfg.get("players") or [{} for _ in S["freeze"]["players"]]
        players = [place_player(w, slot, i % len(S["freeze"]["players"]), standin, S, camF, camF_standin) for i, slot in enumerate(slots)]
        splats_by_id = {p["id"]: sp.solid(sp.read_ply(tmp / p["splats"])) for p in players}
        ball = ball_piece(w, cfg, S, players, camF, splats_by_id)
        seat_cfg = {**SEAT, **(cfg.get("seat") or {})}
        pair = np.mean([p["_"]["contact"] for p in players], 0)
        pair_centre = [round(float(pair[0]), 3), 0.0, round(float(pair[1]), 3)]
        spots = geo.viewing_spots(pair_centre, camF.C, [(p["bounds"]["min"], p["bounds"]["max"]) for p in players], seat_cfg["clear"])
        seat = {"ray": "freeze", "distance": seat_cfg["distance"], "distanceRange": seat_cfg["distanceRange"],
                "pairCentre": pair_centre, "closer": seat_cfg["closer"], "clear": seat_cfg["clear"], "spots": spots,
                "ringArea": seat_cfg["ringArea"]}
        w.piece("seat", any(w.pieces[f"player:{p['id']}"]["source"] == "real" for p in players) or bool(cfg.get("players")),
                "Decision W: pair centre from the placed soles, spots cleared of both bodies")
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
            "assembledAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
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
    prev = out.parent / f"{out.name}.prev"
    if out.exists():
        if prev.exists():
            shutil.rmtree(prev)
        out.rename(prev)
    tmp.rename(out)
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
    data = path.read_bytes()
    units = annexb_units(data)
    sps = next((o for t, o in units if t == 7), None)
    codec = None if sps is None else "avc1.%02x%02x%02x" % (data[sps + 1], data[sps + 2], data[sps + 3])
    aud = sum(1 for t, _ in units if t == 9)
    # with an AUD per frame, frames = AUDs; else count slices whose first_mb_in_slice is 0 (top bit of the next byte)
    frames = aud if aud else sum(1 for t, o in units if t in (1, 5) and data[o + 1] & 0x80)
    idr = sum(1 for t, _ in units if t == 5)
    return {"codec": codec, "frames": frames, "idr": idr, "bytes": len(data)}


def node_validate(bundle: Path, webxr: Path) -> list[str]:
    """format.ts's own validators (validateCourt, validateFrames, validateCards when it exists) on the bundle."""
    fmt = webxr / "src" / "court" / "format.ts"
    script = (
        "const [fmt, dir] = process.argv.slice(-2);"
        "const fs = await import('node:fs'); const url = await import('node:url'); const path = await import('node:path');"
        "const m = await import(url.pathToFileURL(fmt).href);"
        "const read = (p) => JSON.parse(fs.readFileSync(path.join(dir, p), 'utf8'));"
        "const court = read('court.json'); let errs = m.validateCourt(court);"
        "if (!errs.length) { const frames = read(court.video.frames); errs = m.validateFrames(frames, court);"
        "  if (!errs.length && m.validateCards && court.video.cards) errs = m.validateCards(read(court.video.cards), court, frames); }"
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
        if not p.is_file() or p.stat().st_size == 0:
            errs.append(f"{rel}: missing or empty")
    if errs:
        return errs, pending, info
    v = court["video"]
    frames = json.loads((bundle / v["frames"]).read_text())
    h = h264_info(bundle / v["file"])
    info.append(f"{v['file']}: {h['frames']} frames, {h['idr']} IDR, {h['codec']}, {h['bytes'] / 1e6:.1f} MB")
    if h["codec"] != v["codec"].lower():
        errs.append(f"{v['file']}: its SPS says {h['codec']}, court.json says {v['codec']}")
    if h["frames"] != len(frames):
        errs.append(f"{v['file']}: {h['frames']} frames, frames.json has {len(frames)}")
    nseg = 3 + len(v["segments"]["eases"])
    if h["idr"] < nseg:
        errs.append(f"{v['file']}: {h['idr']} IDR frames for {nseg} segments (each starts with one)")
    for k, fb in (v.get("fallbacks") or {}).items():
        if isinstance(fb, dict) and fb.get("file"):
            hf = h264_info(bundle / fb["file"])
            if hf["codec"] != fb["codec"].lower():
                errs.append(f"{fb['file']}: its SPS says {hf['codec']}, court.json says {fb['codec']}")
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
    for o in court["freeze"]["others"]:
        if o["file"].endswith(".ply"):
            total += len(sp.read_ply(bundle / o["file"]))
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
        for k, pc_ in json.loads(asm.read_text())["pieces"].items():
            if pc_["source"] != "real":
                pending.append(f"{k}: {pc_['detail']}")
    if strict and pending:
        errs += [f"pending: {x}" for x in pending]
    return errs, pending, info


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
    lines.append(f"  seat: pair centre {court['seat']['pairCentre']}, D' {court['seat']['distance']} m, spots {court['seat']['spots']}")
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
    a = ap.parse_args(argv)
    cfg = json.loads(expand(a.config).read_text())
    if not (a.out or cfg.get("out")):
        ap.error("no bundle folder: give --out or the config's `out`")
    out = expand(a.out or cfg["out"])
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
