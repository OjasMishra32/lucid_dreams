"""Head distillation, the plain part: a strong head model (UIKA) as a teacher for fresh, opaque SMPL-X-head Gaussians.

Consenting people only (AGENTS.md rule 5), with head_swap's gate. Pasting a head model's own Gaussians onto a body
failed (LAM's were a 25%-opacity shell that falls apart outside its renderer), so instead:

1. The teacher (`uika_views.py`, UIKA's env) renders its neutral head from ~90 views around a sphere band in its own
   renderer: per view an RGBA PNG and the camera (intrinsics, OpenCV world-to-camera in UIKA's FLAME frame) in
   cameras.json, plus UIKA's FLAME mesh for that head (flame.npy, 5023 vertices, the same frame).
2. The student (`head_distill.py`, 4DAnyone's env, gsplat): UIKA's FLAME mesh is fitted to the avatar's rest-pose
   SMPL-X head through SMPL-X's FLAME vertex ids (head_swap.umeyama, refused over 3 cm RMS) and every camera is carried
   into the avatar's frame with that similarity; the body's head goes above the jaw-line seam exactly as in the head
   swap's cross-fade; new Gaussians start on the SMPL-X head's faces above the seam (area-weighted samples), coloured
   from the teacher's views, and are fitted to the teacher's RGBA with the frozen body rendered too. Their opacity is
   floor + (1 - floor) sigmoid(raw), so every kept one stays at least half opaque, and the ones that want to vanish
   are pruned. Each is skinned from its own SMPL-X face's vertices (barycentric blend, top 4).
3. The bundle `<avatar>-head...` (head last in avatar.ply, reality.ply, head_distill.json), then any_face's blinks.

Everything here is numpy, so it is tested anywhere; the GPU scripts only call it.
"""

from __future__ import annotations

import json
import math
import shutil
from dataclasses import replace
from pathlib import Path

import numpy as np

from . import head_swap as H
from .gaussian_ply import SH_C0, Gaussians, read_ply, write_ply
from .skinning import SKIN_FILE, quantize_top4, write_skin_bin
from .smplx_layout import J

DISTILL_FILE = "head_distill.json"  # next to dream.json: the fit's numbers; marks a bundle the distill may redo
VIEWS_DIR = "views"  # in the teacher folder: <view>.png (RGBA) + cameras.json
CAMERAS_FILE = "cameras.json"
FLAME_FILE = "flame.npy"  # in the teacher folder, next to views/
PHOTO_SUFFIXES = (".jpg", ".jpeg", ".png")
TEACHER = "UIKA (ant-research, CVPR 2026, MIT): a folder of photos -> FLAME Gaussian head"
CAMERA_FRAME = "UIKA's FLAME frame (metres, +Y up, the face looks along +Z); OpenCV cameras: x right, y down, z forward"

VIEW_SIZE = 1024  # teacher render, square
VIEW_DISTANCE_M = 0.8  # camera to target (UIKA's own orbit sits 0.7-1.1 m from the head)
VIEW_HALF_EXTENT_M = 0.24  # half the frame's height at the target: crown with hair to the neck
MIN_VIEWS = 24
HOLDOUT_EVERY = 8  # every 8th teacher view is held out for the final PSNR/SSIM

N_HEAD = 100_000  # new Gaussians on the SMPL-X head before pruning
OPACITY_FLOOR = 0.5  # every kept Gaussian is at least this opaque (times the seam's fade-in)
PRUNE_BELOW = 0.05  # sigmoid(raw) under this: the Gaussian wants to vanish, so it goes
MIN_FACING = 0.2  # cosine between a surface normal and the view direction for a view to colour that point


# ---------------------------------------------------------------- consent

def _in_held(person: str, held: str | Path | None) -> list[str]:
    return [f"{person} in dreams/.held"] if held and person in H.held_ids(held) else []


def teacher_consent_errors(person: str, photos: str | Path, out: str | Path, held: str | Path | None) -> list[str]:
    """Why the teacher mustn't run (empty if it may): the person has to be in head_swap.CONSENTED (a plain id, never
    a public figure), the photos have to be their own folder (data/avatars/faces/<person>), the output their own
    teacher folder (data/avatars/heads/<person>/uika), and they mustn't be in dreams/.held (`held`)."""
    errors = []
    if not H.BUNDLE_ID.fullmatch(person or ""):
        return [f"person {person!r} isn't a plain id (lowercase letters, digits and dashes)"]
    if person not in H.CONSENTED:
        errors.append(f"{person!r} hasn't given consent for a photoreal face (CONSENTED in head_swap.py; AGENTS.md "
                      "rule 5)")
    p = Path(photos).resolve()
    if p.name != person or p.parent.name != "faces":
        errors.append(f"{photos} isn't {person}'s own photos folder (data/avatars/faces/{person})")
    o = Path(out).resolve()
    if o.name != "uika" or o.parent.name != person or o.parent.parent.name != "heads":
        errors.append(f"{out} isn't {person}'s own teacher folder (data/avatars/heads/{person}/uika)")
    return errors + _in_held(person, held)


def distill_consent_errors(person: str, bundle: str | Path, teacher: str | Path, held: str | Path | None = None,
                           new_id: str | None = None) -> list[str]:
    """head_swap.consent_errors (CONSENTED, their own avatar, a new `<person>-...` id, nothing in dreams/.held), where
    only an earlier distill (head_distill.json) may be replaced, never a head swap or any other bundle; plus: the
    teacher is the person's own (data/avatars/heads/<person>/uika, and its cameras.json names them)."""
    errors = H.consent_errors(person, bundle, held, new_id, made_by=DISTILL_FILE)
    t = Path(teacher).resolve()
    if t.name != "uika" or t.parent.name != person or t.parent.parent.name != "heads":
        errors.append(f"{teacher} isn't {person}'s own teacher folder (data/avatars/heads/{person}/uika)")
    cams = t / VIEWS_DIR / CAMERAS_FILE
    if cams.is_file():
        try:
            named = json.loads(cams.read_text()).get("person")
        except (ValueError, AttributeError):
            named = None
        if named != person:
            errors.append(f"{cams} was rendered for {named!r}, not {person!r}")
    return errors


def photo_paths(folder: str | Path) -> list[Path]:
    """The person's photos: .jpg, .jpeg and .png (any case) in the folder itself, by name; hidden files skipped."""
    return sorted(p for p in Path(folder).iterdir()
                  if p.is_file() and not p.name.startswith(".") and p.suffix.lower() in PHOTO_SUFFIXES)


# ---------------------------------------------------------------- cameras

def look_at_w2c(eye: np.ndarray, target: np.ndarray, up=(0.0, 1.0, 0.0)) -> np.ndarray:
    """4x4 OpenCV world-to-camera (x right, y down, z forward) at `eye` looking at `target`, world `up` up."""
    eye, target = np.asarray(eye, dtype=np.float64), np.asarray(target, dtype=np.float64)
    z = target - eye
    z /= np.linalg.norm(z)
    x = np.cross(z, np.asarray(up, dtype=np.float64))  # forward x up = right
    if np.linalg.norm(x) < 1e-9:
        raise ValueError("looking straight along the up direction")
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    w2c = np.eye(4)
    w2c[:3, :3] = np.stack([x, y, z])
    w2c[:3, 3] = -w2c[:3, :3] @ eye
    return w2c


def view_angles() -> list[tuple[float, float]]:
    """(yaw, elevation) in degrees of the teacher's views: yaw -90..+90 every 10 degrees at four elevations (most
    views on the face), then the top, the back of the head (hair, ears) and from below (chin, jaw). 91 views. Yaw is
    about +Y from the face's front (+Z), positive toward +X."""
    angles = [(float(y), float(e)) for e in (0, 20, -20, 40) for y in range(-90, 91, 10)]
    angles += [(float(y), 70.0) for y in (0, 90, 180, -90)]
    angles += [(float(y), 10.0) for y in (120, 150, 180, -150, -120)]
    angles += [(float(y), 40.0) for y in (135, 180, -135)]
    angles += [(float(y), -45.0) for y in (-45, 0, 45)]
    return angles


def focal_for(size: int, distance: float, half_extent: float) -> float:
    """The focal length (pixels) that fits `half_extent` metres at `distance` into half a `size` frame."""
    return size / 2 * distance / half_extent


def view_cameras(target: np.ndarray, distance: float = VIEW_DISTANCE_M, size: int = VIEW_SIZE,
                 half_extent: float = VIEW_HALF_EXTENT_M) -> list[dict]:
    """The teacher's cameras: one focal, one distance, all looking at `target` (the FLAME head's centre)."""
    f = focal_for(size, distance, half_extent)
    K = [[f, 0.0, size / 2], [0.0, f, size / 2], [0.0, 0.0, 1.0]]
    views = []
    for i, (yaw, elev) in enumerate(view_angles()):
        a, e = math.radians(yaw), math.radians(elev)
        eye = np.asarray(target, dtype=np.float64) + distance * np.array(
            [math.sin(a) * math.cos(e), math.sin(e), math.cos(a) * math.cos(e)])
        views.append({"file": f"{i:03d}.png", "yawDeg": yaw, "elevDeg": elev, "K": K,
                      "w2c": look_at_w2c(eye, target).tolist()})
    return views


def write_cameras(path: str | Path, views: list[dict], size: int, person: str, extra: dict | None = None) -> None:
    doc = {"person": person, "frame": CAMERA_FRAME, "width": size, "height": size, "flame": FLAME_FILE,
           **(extra or {}),
           "views": [{"file": v["file"], "yawDeg": v["yawDeg"], "elevDeg": v["elevDeg"],
                      "K": np.asarray(v["K"], dtype=np.float64).tolist(),
                      "w2c": np.asarray(v["w2c"], dtype=np.float64).tolist()} for v in views]}
    Path(path).write_text(json.dumps(doc, indent=1) + "\n")


def read_cameras(path: str | Path, check_files: bool = True) -> tuple[dict, list[dict]]:
    """(header, views) from cameras.json, every view validated: a plain file name next to it (that exists), K with
    positive focals and the principal point inside the frame, w2c a rigid 4x4 (orthonormal rotation, det +1,
    bottom row 0 0 0 1); at least MIN_VIEWS, no file twice. Raises ValueError naming the first problem."""
    path = Path(path)
    doc = json.loads(path.read_text())
    w, h = doc.get("width"), doc.get("height")
    if not (isinstance(w, int) and isinstance(h, int) and w > 0 and h > 0):
        raise ValueError(f"{path}: width/height must be positive integers")
    views = doc.get("views") or []
    if len(views) < MIN_VIEWS:
        raise ValueError(f"{path}: {len(views)} views, need at least {MIN_VIEWS}")
    seen, out = set(), []
    for i, v in enumerate(views):
        name = v.get("file", "")
        if not isinstance(name, str) or Path(name).name != name or name.startswith(".") or not name:
            raise ValueError(f"{path}: view {i} file {name!r} isn't a plain file name")
        if name in seen:
            raise ValueError(f"{path}: {name} appears twice")
        seen.add(name)
        if check_files and not (path.parent / name).is_file():
            raise ValueError(f"{path}: {name} is missing")
        K, w2c = np.asarray(v.get("K"), dtype=np.float64), np.asarray(v.get("w2c"), dtype=np.float64)
        if K.shape != (3, 3) or K[0, 0] <= 0 or K[1, 1] <= 0 or not (0 < K[0, 2] < w and 0 < K[1, 2] < h):
            raise ValueError(f"{path}: view {i} K isn't a pinhole camera for {w}x{h}")
        R = w2c[:3, :3] if w2c.shape == (4, 4) else None
        if R is None or not np.allclose(w2c[3], [0, 0, 0, 1]) or not np.allclose(R @ R.T, np.eye(3), atol=1e-4) \
                or np.linalg.det(R) < 0:
            raise ValueError(f"{path}: view {i} w2c isn't a rigid 4x4 world-to-camera")
        out.append({**v, "K": K, "w2c": w2c, "path": path.parent / name})
    header = {k: v for k, v in doc.items() if k != "views"}
    return header, out


def camera_to_avatar(w2c: np.ndarray, s: float, R: np.ndarray, t: np.ndarray) -> np.ndarray:
    """The world-to-camera that sees the avatar's frame (x_a = s R x + t) exactly as w2c saw the teacher's: same
    pixels, depths in the avatar's metres (s times the teacher's)."""
    w2c = np.asarray(w2c, dtype=np.float64)
    Rc, tc = w2c[:3, :3], w2c[:3, 3]
    out = np.eye(4)
    out[:3, :3] = Rc @ np.asarray(R, dtype=np.float64).T
    out[:3, 3] = s * tc - out[:3, :3] @ np.asarray(t, dtype=np.float64)
    return out


def project(K: np.ndarray, w2c: np.ndarray, points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """((n, 2) pixel coordinates, (n,) depths) of world points (pixel centres at +0.5, as gsplat)."""
    cam = np.asarray(points, dtype=np.float64) @ np.asarray(w2c)[:3, :3].T + np.asarray(w2c)[:3, 3]
    z = cam[:, 2]
    uv = cam[:, :2] / np.where(np.abs(z) < 1e-12, 1e-12, z)[:, None] @ np.asarray(K)[:2, :2].T + np.asarray(K)[:2, 2]
    return uv, z


def split_views(n: int, every: int = HOLDOUT_EVERY) -> tuple[np.ndarray, np.ndarray]:
    """(train, held-out) view indices: every `every`-th view from every // 2 is held out, never none."""
    held = np.arange(every // 2, n, every)
    if len(held) == 0:
        held = np.array([n // 2])
    return np.setdiff1d(np.arange(n), held), held


# ---------------------------------------------------------------- the new head's surface

def dominant_joint(weights: np.ndarray) -> np.ndarray:
    return np.argmax(np.asarray(weights), axis=1)


def head_faces(faces: np.ndarray, verts: np.ndarray, lbs_weights: np.ndarray, seam_lo: float) -> np.ndarray:
    """Indices of the SMPL-X faces whose three vertices are all head, jaw or eye dominant and that reach above
    `seam_lo` (the bottom of the seam's band)."""
    faces = np.asarray(faces)
    head_v = np.isin(dominant_joint(lbs_weights), H.HEAD_JOINTS)
    ok = head_v[faces].all(axis=1) & (np.asarray(verts)[faces, 1].max(axis=1) > seam_lo)
    return np.flatnonzero(ok)


def _face_geometry(verts: np.ndarray, faces: np.ndarray, face_ids: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    tri = np.asarray(verts, dtype=np.float64)[np.asarray(faces)[face_ids]]
    cross = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    norm = np.linalg.norm(cross, axis=1)
    return 0.5 * norm, cross / np.maximum(norm, 1e-20)[:, None]


def sample_surface(verts: np.ndarray, faces: np.ndarray, face_ids: np.ndarray, n: int, seed: int = 0
                   ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """(face index, barycentric (n, 3), point (n, 3), unit face normal (n, 3)): n points uniformly by area over the
    faces `face_ids` of the mesh (seeded, so the same head every run). Normals follow the faces' winding (SMPL-X's
    point outward)."""
    face_ids = np.asarray(face_ids)
    if len(face_ids) == 0:
        raise ValueError("no faces to sample: no SMPL-X face is head, jaw or eye above the seam")
    area, normal = _face_geometry(verts, faces, face_ids)
    rng = np.random.default_rng(seed)
    pick = rng.choice(len(face_ids), size=n, p=area / area.sum())
    r1, r2 = rng.random(n), rng.random(n)
    s = np.sqrt(r1)
    bary = np.stack([1 - s, s * (1 - r2), s * r2], axis=1)
    fid = face_ids[pick]
    pts = np.einsum("nk,nkx->nx", bary, np.asarray(verts, dtype=np.float64)[np.asarray(faces)[fid]])
    return fid, bary, pts, normal[pick]


def face_skin(face_idx: np.ndarray, bary: np.ndarray, faces: np.ndarray, lbs_weights: np.ndarray
              ) -> tuple[np.ndarray, np.ndarray]:
    """skin.bin records: each point blends its face's three vertices' SMPL-X weights by its barycentric
    coordinates, then the top 4 (quantize_top4)."""
    lbs = np.asarray(lbs_weights, dtype=np.float64)
    return quantize_top4(np.einsum("nk,nkj->nj", np.asarray(bary, dtype=np.float64), lbs[np.asarray(faces)[face_idx]]))


def initial_log_scale(verts: np.ndarray, faces: np.ndarray, face_ids: np.ndarray, n: int) -> float:
    """log of a starting isotropic size: half the mean spacing of n samples over those faces."""
    area, _ = _face_geometry(verts, faces, np.asarray(face_ids))
    return math.log(0.5 * math.sqrt(area.sum() / n))


# ---------------------------------------------------------------- opacity floor, seam

def _sigmoid(x):
    return 1 / (1 + np.exp(-np.asarray(x, dtype=np.float64)))


def floor_alpha(raw: np.ndarray, floor: float = OPACITY_FLOOR) -> np.ndarray:
    """The student's opacity: floor + (1 - floor) sigmoid(raw), never under the floor (head_distill.py's torch
    version is the same formula)."""
    return floor + (1 - floor) * _sigmoid(raw)


def raw_for_alpha(alpha: float, floor: float = OPACITY_FLOOR) -> float:
    if not floor < alpha < 1:
        raise ValueError(f"alpha {alpha} isn't between the floor {floor} and 1")
    p = (alpha - floor) / (1 - floor)
    return math.log(p / (1 - p))


def ply_opacity(raw: np.ndarray, fade: np.ndarray, floor: float = OPACITY_FLOOR) -> np.ndarray:
    """The PLY's opacity logit for the fitted head: floor_alpha(raw) times the seam's fade-in (1 above the band)."""
    a = np.clip(floor_alpha(raw, floor) * np.asarray(fade, dtype=np.float64), 1e-6, 1 - 1e-6)
    return np.log(a / (1 - a))


def keep_mask(raw: np.ndarray, below: float = PRUNE_BELOW) -> np.ndarray:
    """False for Gaussians that want to vanish (sigmoid(raw) under `below`: the fit pushed them to the floor)."""
    return _sigmoid(raw) >= below


def opacity_stats(alpha: np.ndarray, in_band: np.ndarray) -> dict:
    alpha, in_band = np.asarray(alpha, dtype=np.float64), np.asarray(in_band, dtype=bool)
    out = alpha[~in_band]
    return {"count": int(len(alpha)), "inSeamBand": int(in_band.sum()),
            "minOutsideBand": round(float(out.min()), 4) if len(out) else None,
            "median": round(float(np.median(alpha)), 4) if len(alpha) else None,
            "mean": round(float(alpha.mean()), 4) if len(alpha) else None,
            "shareAtLeastHalf": round(float((alpha >= 0.5 - 1e-6).mean()), 4) if len(alpha) else None}


def seam_height(rest: np.ndarray, offset: float = 0.0) -> float:
    """The jaw-line seam's height in the rest pose, as head_swap.swap_bundle puts it."""
    return float(np.asarray(rest)[J["jaw"], 1] - H.SEAM_BELOW_JAW_M + offset)


def seam_fade(y: np.ndarray, seam_y: float, band: float = H.BAND_M) -> np.ndarray:
    """The new head's fade-in over the band below the seam (0 at seam - band, 1 from the seam up): head_swap's
    cross_fade, for Gaussians whose opacity is fitted rather than given."""
    return np.clip((np.asarray(y, dtype=np.float64) - (seam_y - band)) / band, 0, 1)


def cut_body(body: Gaussians, idx: np.ndarray, q: np.ndarray, seam_y: float
             ) -> tuple[Gaussians, np.ndarray, dict[str, int]]:
    """(the body kept, its mask, what of it still shows above the seam by joint): head_swap.cross_fade on the body
    (its head, jaw and eye Gaussians above the seam go; neck and head ones fade out over the band below it)."""
    dominant = idx[np.arange(len(idx)), np.argmax(q, axis=1)].astype(np.int64)
    empty = Gaussians(np.zeros((0, 3)), np.zeros((0, 3)), np.zeros((0, 0)), np.zeros(0), np.zeros((0, 3)),
                      np.zeros((0, 4)))
    body_k, keep, _, _ = H.cross_fade(body, dominant, empty, seam_y)
    above = (body_k.xyz[:, 1] > seam_y) & (_sigmoid(body_k.opacity) > 0.05)
    names, counts = np.unique(dominant[keep][above], return_counts=True)
    return body_k, keep, {H.JOINT_NAMES[j]: int(c) for j, c in zip(names, counts)}


def loss_weight(y_ref: np.ndarray, a_ref: np.ndarray, y_body: np.ndarray, a_body: np.ndarray, seam_lo: float,
                solid: float = 0.5, d_ref: np.ndarray | None = None, d_body: np.ndarray | None = None,
                margin: float = 0.005) -> np.ndarray:
    """Per pixel, whether the fit looks there (float32 0/1). y_ref/a_ref: the teacher's FLAME surface rendered in the
    avatar's frame (height and alpha); y_body/a_body: the frozen body alone. Where the teacher's FLAME is, its height
    decides (its neck under the seam isn't ours to fit, the body's neck is there); elsewhere (hair, background) the
    pixel counts unless the body's own surface below the seam covers it (shoulders, chest: the teacher has none).
    With depths (d_ref, d_body: expected depth of each), the body below the seam in front of the teacher's head
    (the chest under the chin, seen from below) hides it, so that pixel doesn't count either."""
    flame = np.asarray(a_ref) > solid
    head = flame & (np.asarray(y_ref) >= seam_lo)
    body_below = (np.asarray(a_body) > solid) & (np.asarray(y_body) < seam_lo)
    if d_ref is not None and d_body is not None:
        head &= ~(body_below & (np.asarray(d_body) < np.asarray(d_ref) - margin))
    return np.where(flame, head, ~body_below).astype(np.float32)


# ---------------------------------------------------------------- colour from the teacher, metrics

def project_colours(points: np.ndarray, normals: np.ndarray, views: list[tuple[np.ndarray, np.ndarray, np.ndarray]],
                    min_facing: float = MIN_FACING) -> tuple[np.ndarray, np.ndarray]:
    """((n, 3) RGB in 0..1, (n,) how many views coloured each point): every view (K, w2c, RGBA float HxWx4) that
    faces a point (normal toward the camera by at least min_facing) and whose teacher alpha there is solid gives its
    pixel, weighted by the facing. No occlusion test: the head is nearly convex and the fit corrects the rest.
    Points no view saw take the median colour of the ones that were."""
    points, normals = np.asarray(points, dtype=np.float64), np.asarray(normals, dtype=np.float64)
    acc, wsum, seen = np.zeros((len(points), 3)), np.zeros(len(points)), np.zeros(len(points), dtype=np.int64)
    for K, w2c, rgba in views:
        h, w = rgba.shape[:2]
        uv, z = project(K, w2c, points)
        eye = -np.asarray(w2c)[:3, :3].T @ np.asarray(w2c)[:3, 3]
        to_eye = eye - points
        facing = (normals * to_eye).sum(1) / np.maximum(np.linalg.norm(to_eye, axis=1), 1e-12)
        u, v = np.floor(uv[:, 0]).astype(np.int64), np.floor(uv[:, 1]).astype(np.int64)
        ok = (z > 0) & (facing >= min_facing) & (u >= 0) & (u < w) & (v >= 0) & (v < h)
        px = np.zeros((len(points), 4))
        px[ok] = rgba[v[ok], u[ok]]
        ok &= px[:, 3] > 0.5
        acc[ok] += facing[ok, None] * px[ok, :3]
        wsum[ok] += facing[ok]
        seen += ok
    rgb = np.zeros((len(points), 3))
    has = wsum > 0
    rgb[has] = acc[has] / wsum[has, None]
    rgb[~has] = np.median(rgb[has], axis=0) if has.any() else 0.5
    return np.clip(rgb, 0, 1), seen


def mask_box(mask: np.ndarray, pad: int = 8) -> tuple[int, int, int, int] | None:
    """(top, bottom, left, right), bottom/right exclusive, of the mask's pixels grown by pad and kept in the image."""
    rows, cols = np.flatnonzero(np.asarray(mask).any(1)), np.flatnonzero(np.asarray(mask).any(0))
    if not len(rows):
        return None
    h, w = np.asarray(mask).shape
    return (max(0, rows[0] - pad), min(h, rows[-1] + 1 + pad), max(0, cols[0] - pad), min(w, cols[-1] + 1 + pad))


def masked_psnr(pred: np.ndarray, gt: np.ndarray, mask: np.ndarray) -> float | None:
    """PSNR (images in 0..1) over the mask's pixels only; None for an empty mask."""
    m = np.asarray(mask, dtype=bool)
    if not m.any():
        return None
    mse = float(((np.asarray(pred, dtype=np.float64) - gt) ** 2)[m].mean())
    return float("inf") if mse == 0 else -10 * math.log10(mse)


# ---------------------------------------------------------------- the bundle

def merge_gaussians(body: Gaussians, head: Gaussians) -> Gaussians:
    """Body then head, the head's missing colour bands zero (view-independent colour)."""
    n_rest = max(body.f_rest.shape[1], head.f_rest.shape[1])
    pad = lambda g: np.pad(g.f_rest, ((0, 0), (0, n_rest - g.f_rest.shape[1])))  # noqa: E731
    return Gaussians(xyz=np.concatenate([body.xyz, head.xyz]), f_dc=np.concatenate([body.f_dc, head.f_dc]),
                     f_rest=np.concatenate([pad(body), pad(head)]),
                     opacity=np.concatenate([body.opacity, head.opacity]),
                     scale=np.concatenate([body.scale, head.scale]),
                     rotation=np.concatenate([body.rotation, head.rotation]))


# what an avatar bundle may carry that describes the old face or another step's output: never copied
_STALE = ("*.work", "preview.mp4", "preview.part.mp4", "thumb.jpg", "head_swap.json", DISTILL_FILE, "face.json",
          "compare.png", "blink.png", "lips.json", "voice.m4a")


def write_distilled_bundle(bundle: str | Path, dreams_dir: str | Path, new_id: str, body_k: Gaussians,
                           keep_b: np.ndarray, idx: np.ndarray, q: np.ndarray, head: Gaussians, h_idx: np.ndarray,
                           h_q: np.ndarray, seen_head: np.ndarray, report: dict, name: str | None = None) -> Path:
    """dreams_dir/new_id: the source avatar with its head cut (body_k, keep_b of the source's Gaussians; idx/q the
    source's skin.bin) and the distilled head appended as one range at the end, its skin.bin (h_idx, h_q),
    reality.ply (the body's own seen/imagined, and the head's `seen_head`; imagined ones tinted as head_swap does) and
    head_distill.json (`report` plus counts). The old face's preview, thumb and expr.bin are left out (the GPU step
    renders new ones; any_face rebuilds expr.bin). Never replaces the source or a bundle the distill didn't write."""
    src = Path(bundle)
    out = Path(dreams_dir) / new_id
    if out.resolve() == src.resolve():
        raise ValueError("the distill writes a new bundle; give it a new id")
    if out.exists() and not (out / DISTILL_FILE).is_file():
        raise ValueError(f"{out} exists and isn't a head distill: it is never replaced")
    dream = json.loads((src / "dream.json").read_text())
    av = dream["avatar"]
    seen_b = np.ones(len(keep_b), dtype=bool)
    if av.get("reality"):
        seen_b = np.isclose(read_ply(src / av["reality"]).f_dc, read_ply(src / av["file"]).f_dc,
                            atol=1e-5).all(axis=1)
    seen = np.concatenate([seen_b[keep_b], np.asarray(seen_head, dtype=bool)])
    merged = merge_gaussians(body_k, head)

    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(src, out, ignore=shutil.ignore_patterns(*_STALE))
    if av.get("expr"):
        (out / av["expr"]).unlink(missing_ok=True)  # indexed into the old avatar.ply
    write_ply(out / av["file"], merged)
    write_skin_bin(out / av.get("skin", SKIN_FILE), np.concatenate([idx[keep_b], h_idx]),
                   np.concatenate([q[keep_b], h_q]))
    tint = merged.f_dc.copy()
    tint[~seen] = 0.5 * tint[~seen] + 0.5 * (H.REALITY_TINT - 0.5) / SH_C0
    write_ply(out / H.REALITY_FILE, replace(merged, f_dc=tint))

    report = {**report, "from": dream["id"], "teacher": TEACHER, "bodyKept": int(keep_b.sum()),
              "bodyDropped": int((~keep_b).sum()), "headGaussians": len(head),
              "headFirst": int(keep_b.sum())}
    (out / DISTILL_FILE).write_text(json.dumps(report, indent=2) + "\n")
    avatar = {k: v for k, v in av.items() if k not in ("expr", "exprChannels")}
    avatar["reality"] = H.REALITY_FILE
    dream.update(id=new_id, name=name or f"{dream['name']} (UIKA head)", preview=None, thumb=None, avatar=avatar)
    dream.pop("voice", None)
    dream["metrics"] = {**(dream.get("metrics") or {}), "seenFraction": round(float(seen.mean()), 4)}
    dream["source"] = {**(dream.get("source") or {}),
                       "head": {"model": TEACHER, "method": "distilled: fresh opaque SMPL-X-head Gaussians fitted to "
                                "the teacher's renders", "from": dream_id(src)}}
    (out / "dream.json").write_text(json.dumps(dream, indent=2) + "\n")
    return out


def dream_id(bundle: str | Path) -> str:
    return H.dream_id_of(Path(bundle))
