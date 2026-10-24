"""A sharp, solid head for an SMPL-X avatar, from many photos: UIKA as the teacher, distilled onto the avatar's body.

UIKA (ant-research/UIKA, CVPR 2026, MIT) turns a folder of photos of one person into ~130K Gaussians on FLAME.
Pasting a head model's Gaussians onto a body failed before (LAM's were a thin, low-opacity shell). UIKA's turn out
opaque and gsplat draws them exactly as UIKA's renderer does (checked every run: 56 dB on Magnus), but as they come
they don't belong on a body: a shirt collar grown from the photos, gaps and a skin-coloured smear at the back where
no photo looked, a neck that isn't the body's. So the head is distilled:

  teacher  (UIKA's env, UIKA's repo as the working directory; an L4)
           UIKA's neutral head (FLAME at rest: mouth closed, eyes open) rendered from 104 views all around
           (yaw every 15 degrees at pitch -20, 0, 15, 30, plus the crown from above), RGBA with UIKA's own alpha,
           in its own renderer; the cameras; UIKA's FLAME mesh; and UIKA's Gaussians themselves (gaussians.npz,
           the small exporter UIKA lacks).
  distill  (gsplat) UIKA's FLAME is aligned to the avatar's rest-pose SMPL-X head (SMPL-X's FLAME vertex ids,
           Umeyama). UIKA's head is edited (edit_uika, FLAME's regions): the collar, the FLAME boundary ring and
           anything standing off the head go; behind the ears, where no photo looked, the hair is repainted from the
           hair the photos saw and the nape from the neck skin they saw (UIKA's own strand detail kept); an opaque
           shell on the SMPL-X scalp, just under UIKA's hair, closes its gaps (scalp_shell). The body's head goes
           above a seam 3 cm under UIKA's chin (head_distill_core.cut_body), and the teacher's views are the edited
           head on the frozen body, faded in over the band below the seam, so the seam is fitted in context. Fresh
           Gaussians start there and are fitted with gsplat (L1 + D-SSIM, an alpha loss, opacity at least
           OPACITY_FLOOR so the head is solid, sizes capped and never needles, densified where the fit is poor,
           pruned where it wants nothing), each skinned from its nearest SMPL-X head/neck/jaw vertices. The bundle
           is the source avatar with avatar.ply + skin.bin replaced.
  finish   after lhmpp_cleanup.py has cleaned the body (its hair blur is for LHM++'s blotches, so the new head keeps
           its fitted colours): every head Gaussian posed through motion.json, preview.mp4, thumb.jpg, validated.
  judge    (gsplat, InsightFace) portraits of the old and new avatar at 1.8 m with a 14 degree field of view
           (front, 45, 90, 180, posed by motion frame 0, as lhmpp_avatar.py renders), ArcFace identity against the
           photos (InsightFace's and LHM++'s yardstick), face sharpness.

Who (AGENTS.md rule 5): consenting people (head_swap.CONSENTED), and the chess opponents the project lead approved,
public figures from freely licensed photos only (credited in dream.json, labelled "Not affiliated" at the board,
never speaking). Nobody in dreams/.held.

  python uika_head.py teacher --person magnus-carlsen --photos faces/magnus-carlsen --use c11,c31,c42,c46 \
      --out heads/magnus-carlsen/uika --uika repos/UIKA
  python uika_head.py distill --person magnus-carlsen --avatar dreams/magnus-carlsen-lhm \
      --teacher heads/magnus-carlsen/uika --smplx SMPLX_NEUTRAL.npz --flame-ids SMPL-X__FLAME_vertex_ids.npy \
      --flame-masks FLAME_masks.pkl --id magnus-carlsen-uika
  python uika_head.py finish dreams/magnus-carlsen-uika   (after lhmpp_cleanup.py)
  python uika_head.py judge --old dreams/magnus-carlsen-lhm --new dreams/magnus-carlsen-uika \
      --photos faces/magnus-carlsen --out <folder>
hpg/uika-distill.sbatch runs them all (and lhmpp_cleanup.py between distill and finish).
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import replace
from pathlib import Path

import numpy as np

from lucid_avatars import head_distill_core as D
from lucid_avatars import head_swap as H
from lucid_avatars.gaussian_ply import SH_C0, Gaussians, read_ply, write_ply
from lucid_avatars.smplx_layout import J

# AGENTS.md rule 5: a public figure only from freely licensed photos, credited, labelled "Not affiliated", never
# speaking. These are the chess opponents the project lead approved; add one only with their photos' licence.
OPPONENTS = {
    "magnus-carlsen": "Photos: Ralf Roletschek, 2015-10-10, CC BY-SA 3.0 (Wikimedia Commons)",
    "bobby-fischer": "Photos: 1966 portrait (AP, John Lent), public domain; Amsterdam, March 1972, Anefo / Nationaal "
                     "Archief (Bert Verhoeff, W. Punt), CC0; Wikimedia Commons; black and white, colourised with DDColor",
}

GAUSSIANS_FILE = "gaussians.npz"  # in the teacher folder: UIKA's own Gaussians at rest, in its FLAME frame
TEACHER_PITCH = (-20.0, 0.0, 15.0, 30.0)
TEACHER_YAW_STEP = 15.0
CROWN_PITCH = 60.0  # the crown: a standing player looks down at a seated opponent's hair

OPACITY_FLOOR = 0.5  # every kept head Gaussian is at least this opaque (times the seam's fade-in)
PRUNE_BELOW = 0.05  # sigmoid(raw) under this: the fit wants it gone
MIN_SCALE_M, MAX_SCALE_M = 2e-4, 0.012
MAX_AXIS_RATIO = 6.0  # longest axis over shortest: nothing needles
MAX_OFFSET_M = 0.015  # a Gaussian stays this close to where it started (UIKA's surface or the SMPL-X head)
OFFSET_FREE_M = 0.004
SKIN_K = 6  # nearest SMPL-X vertices blended for a head Gaussian's skin weights
SKIN_JOINTS = (J["head"], J["jaw"], J["neck"], J["left_eye"], J["right_eye"])


# ---------------------------------------------------------------- who

def gate_errors(person: str, held: str | Path | None = None) -> list[str]:
    """Why this head mustn't be built (empty if it may)."""
    if not H.BUNDLE_ID.fullmatch(person or ""):
        return [f"person {person!r} isn't a plain id (lowercase letters, digits and dashes)"]
    errors = []
    if person not in H.CONSENTED and person not in OPPONENTS:
        errors.append(f"{person!r} is neither a consenting person (head_swap.CONSENTED) nor an approved opponent "
                      "(OPPONENTS in uika_head.py; AGENTS.md rule 5)")
    if held and person in H.held_ids(held):
        errors.append(f"{person} in dreams/.held")
    return errors


# ---------------------------------------------------------------- the teacher's cameras

def teacher_angles() -> list[tuple[float, float]]:
    """(yaw, pitch) in degrees: yaw all around every TEACHER_YAW_STEP at each TEACHER_PITCH, then the crown from
    CROWN_PITCH at eight yaws. Yaw is about +Y from the face's front (+Z), positive toward +X."""
    yaws = np.arange(-180.0, 180.0, TEACHER_YAW_STEP)
    angles = [(float(y), p) for p in TEACHER_PITCH for y in yaws]
    return angles + [(float(y), CROWN_PITCH) for y in range(-180, 180, 45)]


def teacher_cameras(target: np.ndarray, distance: float, size: int, half_extent: float) -> list[dict]:
    f = D.focal_for(size, distance, half_extent)
    K = [[f, 0.0, size / 2], [0.0, f, size / 2], [0.0, 0.0, 1.0]]
    views = []
    for i, (yaw, pitch) in enumerate(teacher_angles()):
        a, e = math.radians(yaw), math.radians(pitch)
        eye = np.asarray(target, dtype=np.float64) + distance * np.array(
            [math.sin(a) * math.cos(e), math.sin(e), math.cos(a) * math.cos(e)])
        views.append({"file": f"{i:03d}.png", "yawDeg": yaw, "elevDeg": pitch, "K": K,
                      "w2c": D.look_at_w2c(eye, target).tolist()})
    return views


def cmd_teacher(a) -> int:
    refused = gate_errors(a.person, a.held)
    if refused:
        print("REFUSED", *refused, sep="\n     ")
        return 2
    photos = D.photo_paths(a.photos)
    if a.use:
        want = [w.strip() for w in a.use.replace(":", ",").split(",") if w.strip()]
        photos = [p for p in photos if p.stem in want]
        if len(photos) != len(want):
            print(f"[uika] asked for {want}, found {[p.name for p in photos]} in {a.photos}")
            return 1
    photos = [p.resolve() for p in photos]
    if not photos:
        print(f"no photos in {a.photos}")
        return 1
    out, uika = a.out.resolve(), a.uika.resolve()

    import os

    import torch
    from omegaconf import OmegaConf
    from PIL import Image

    from uika_views import chunks, to_rgba  # Vishal's teacher: the same UIKA calls, the same RGBA

    os.chdir(uika)  # UIKA's config names its weights and FLAME files relative to its repo
    sys.path.insert(0, str(uika))  # its packages (uika, tools) live there too
    torch._dynamo.config.disable = True
    from uika.models.rendering.flame_model.base_flame import FlameHead
    from uika.runners.infer.checkpoint import build_model_from_config, load_checkpoint_into_model
    from uika.runners.infer.reference import infer_encoder_patch_size, load_references

    t0 = time.time()
    cfg = OmegaConf.load("configs/infer_uika.yaml")
    base = OmegaConf.load(cfg.base_config)
    del cfg["base_config"]
    cfg = OmegaConf.merge(base, cfg)
    inf = cfg.inference
    device = torch.device(a.device)
    model = build_model_from_config(cfg, skip_pretrained_weights=True).to(device)
    report = load_checkpoint_into_model(model, inf.checkpoint, strict=False, fail_on_shape_mismatch=True)
    counts = {k: len(getattr(report, k)) for k in ("loaded", "missing", "unexpected", "mismatched")}
    print(f"[uika] checkpoint {inf.checkpoint}: {counts}")
    if counts["loaded"] == 0:
        return 1
    model.to(torch.float32).eval()
    print(f"[uika] model ready in {time.time() - t0:.0f} s")

    refs = Path(tempfile.mkdtemp(prefix="uika-refs-"))
    try:
        for i, ph in enumerate(photos):
            (refs / f"{i:02d}{ph.suffix.lower()}").symlink_to(ph)
        references = load_references(
            refs, source_size=int(inf.source_size), patch_size=infer_encoder_patch_size(str(cfg.model.encoder_type)),
            matting_weights=inf.matting.weights, head_detection_weights=inf.head_detection.weights,
            head_expand_scale=float(inf.head_detection.expand_scale),
            head_confidence_threshold=float(inf.head_detection.confidence_threshold), device=device,
            background_color=1.0)
    finally:
        shutil.rmtree(refs, ignore_errors=True)
    print(f"[uika] {len(references.paths)} photos ({', '.join(p.name for p in photos)}), masks from "
          f"{sorted(set(references.mask_sources))}")
    out.mkdir(parents=True, exist_ok=True)
    ref_img = references.images.float().cpu().numpy()  # what UIKA saw, for a look
    if ref_img.ndim == 4:
        tiles = [np.clip(im.transpose(1, 2, 0) if im.shape[0] == 3 else im, 0, 1) for im in ref_img]
        Image.fromarray((np.concatenate(tiles, 1) * 255).astype(np.uint8)).save(out / "references.png")

    fm = model.renderer.flame_model
    zeros = lambda *s: torch.zeros(*s, device=device)  # noqa: E731
    with torch.no_grad():
        flame = FlameHead.forward(fm, zeros(1, fm.n_shape_params), zeros(1, fm.n_expr_params), zeros(1, 3),
                                  zeros(1, 3), zeros(1, 3), zeros(1, 6), zeros(1, 3))["animated"][0]
    flame = flame.detach().cpu().numpy().astype(np.float64)
    target = 0.5 * (flame.min(0) + flame.max(0))
    print(f"[uika] FLAME extent {np.ptp(flame, axis=0).round(3).tolist()} m, centre {target.round(4).tolist()}")

    views = teacher_cameras(target, a.distance, a.size, a.half_extent)
    part = out / (D.VIEWS_DIR + ".part")
    shutil.rmtree(part, ignore_errors=True)
    part.mkdir(parents=True)
    images = references.images.unsqueeze(0).to(device, torch.float32)
    masks = references.masks.unsqueeze(0).to(device, torch.float32)
    rgba_all, exported = [], None
    t1 = time.time()
    for s, e in chunks(len(views), a.chunk):
        n = e - s
        w2c = torch.tensor(np.stack([v["w2c"] for v in views[s:e]]), dtype=torch.float32)
        intr = torch.eye(4).repeat(n, 1, 1)
        intr[:, :3, :3] = torch.tensor(np.stack([v["K"] for v in views[s:e]]), dtype=torch.float32)
        flame_params = {"betas": zeros(1, fm.n_shape_params), "expr": zeros(1, n, fm.n_expr_params),
                        "rotation": zeros(1, n, 3), "neck_pose": zeros(1, n, 3), "jaw_pose": zeros(1, n, 3),
                        "eyes_pose": zeros(1, n, 6), "translation": zeros(1, n, 3)}
        with torch.no_grad():
            res = model(images, masks, render_c2ws=torch.linalg.inv(w2c)[None].to(device),
                        render_intrs=intr[None].to(device), render_bg_colors=zeros(1, n, 3),
                        flame_params=flame_params, render_h=a.size, render_w=a.size)
        if exported is None:  # UIKA's Gaussians at rest (every view's are the same: FLAME doesn't move)
            gs = res["3dgs"][0][0]
            exported = {k: getattr(gs, k).detach().float().cpu().numpy().reshape(len(gs.xyz), -1)
                        for k in ("xyz", "opacity", "scaling", "rotation", "shs")}
        rgb, alpha = res["comp_rgb"][0].float().cpu().numpy(), res["comp_mask"][0].float().cpu().numpy()
        for k, v in enumerate(views[s:e]):
            rgba = to_rgba(rgb[k], alpha[k])
            Image.fromarray(rgba, "RGBA").save(part / v["file"])
            rgba_all.append(rgba)
        print(f"[uika] views {s}-{e - 1}; alpha coverage {float((alpha > 0.5).mean()):.3f}")
    print(f"[uika] {len(views)} views in {time.time() - t1:.0f} s")

    ex = exported
    print(f"[uika] {len(ex['xyz'])} Gaussians: opacity median {np.median(ex['opacity']):.3f}, "
          f"share >= 0.5 {float((ex['opacity'] >= 0.5).mean()):.3f}; scale median "
          f"{np.median(ex['scaling']) * 1000:.2f} mm; colour range {ex['shs'].min():.2f}..{ex['shs'].max():.2f}")
    np.savez_compressed(out / GAUSSIANS_FILE, xyz=ex["xyz"], opacity=ex["opacity"][:, 0], scale=ex["scaling"],
                        rotation_wxyz=ex["rotation"], rgb=ex["shs"][:, :3],
                        note=np.array("UIKA's Gaussians at rest in its FLAME frame, activated (opacity 0..1, scale "
                                      "in metres, rotation as the rasterizer takes it, RGB as its colors_precomp)"))
    commit = subprocess.run(["git", "-C", str(uika), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    D.write_cameras(part / D.CAMERAS_FILE, views, a.size, a.person, {
        "teacher": D.TEACHER, "uikaCommit": commit or None, "photos": [ph.name for ph in photos],
        "credit": OPPONENTS.get(a.person),
        "expression": "FLAME at rest: expression, jaw, eyes, neck and head pose zero; shape zero (UIKA's cano_shape)",
        "background": "black; PNG colour is straight, alpha is UIKA's soft alpha",
        "targetM": target.round(6).tolist(), "distanceM": a.distance, "halfExtentM": a.half_extent,
        "checkpointLoad": counts, "seconds": round(time.time() - t0, 1)})
    D.read_cameras(part / D.CAMERAS_FILE)
    np.save(out / D.FLAME_FILE, flame.astype(np.float32))
    level = [i for i, v in enumerate(views) if v["elevDeg"] in (0.0, CROWN_PITCH)]
    sheet = [np.asarray(Image.fromarray(rgba_all[i]).convert("RGB").resize((160, 160))) for i in level]
    cols = 12
    rows = [np.concatenate(sheet[r:r + cols] + [np.zeros_like(sheet[0])] * (cols - len(sheet[r:r + cols])), 1)
            for r in range(0, len(sheet), cols)]
    Image.fromarray(np.concatenate(rows, 0)).save(out / "contact.png")
    final = out / D.VIEWS_DIR
    shutil.rmtree(final, ignore_errors=True)
    part.rename(final)
    print(f"[uika] teacher done in {time.time() - t0:.0f} s: {final}")
    print("UIKA_TEACHER_OK")
    return 0


# ---------------------------------------------------------------- the student: plain parts

REPORT_FILE = "uika_head.json"  # in the new bundle: the fit's numbers; marks a bundle this step may redo
_NOT_COPIED = ("*.work", "preview.mp4", "preview.part.mp4", "thumb.jpg", "cleanup.json", "avatar.raw.ply",
               "skin.raw.bin", "reality.ply", "expr.bin", "head_swap.json", D.DISTILL_FILE, "face.json", "compare.png",
               "blink.png", "lips.json", "voice.m4a", REPORT_FILE)


def logit(p: np.ndarray) -> np.ndarray:
    p = np.clip(np.asarray(p, dtype=np.float64), 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def uika_gaussians(npz: Path, s: float, R: np.ndarray, t: np.ndarray) -> tuple[Gaussians, np.ndarray]:
    """(UIKA's exported Gaussians carried into the avatar's frame by x -> s R x + t, their opacity 0..1)."""
    u = np.load(npz)
    n = len(u["xyz"])
    g = Gaussians(xyz=u["xyz"].astype(np.float64), f_dc=(u["rgb"].astype(np.float64) - 0.5) / SH_C0,
                  f_rest=np.zeros((n, 0)), opacity=logit(u["opacity"]),
                  scale=np.log(np.maximum(u["scale"].astype(np.float64), 1e-7)),
                  rotation=u["rotation_wxyz"].astype(np.float64))
    return H.transform_gaussians(g, s, R, t), np.clip(u["opacity"].astype(np.float64), 0, 1)


def clamp_log_scales(ls, lo: float, hi: float, ratio: float = MAX_AXIS_RATIO, needle: float = 3.0):
    """Sizes kept in [lo, hi] (logs), the shortest axis at least 1/ratio of the longest (no paper-thin discs) and the
    middle one at least 1/needle of it (no needles). Works on numpy arrays and torch tensors (in place for torch)."""
    try:
        import torch
    except ImportError:  # pragma: no cover
        torch = None
    if torch is not None and isinstance(ls, torch.Tensor):
        ls.clamp_(lo, hi)
        srt, order = ls.sort(dim=1)
        mid = torch.maximum(srt[:, 1], srt[:, 2] - math.log(needle))
        low = torch.maximum(srt[:, 0], srt[:, 2] - math.log(ratio))
        ls.scatter_(1, order, torch.stack([low, mid, srt[:, 2]], 1))
        return ls
    ls = np.clip(np.asarray(ls, dtype=np.float64), lo, hi)
    order = np.argsort(ls, axis=1)
    srt = np.take_along_axis(ls, order, 1)
    srt[:, 1] = np.maximum(srt[:, 1], srt[:, 2] - math.log(needle))
    srt[:, 0] = np.maximum(srt[:, 0], srt[:, 2] - math.log(ratio))
    out = np.empty_like(ls)
    np.put_along_axis(out, order, srt, 1)
    return out


def skin_candidates(verts: np.ndarray, lbs: np.ndarray, floor_y: float) -> np.ndarray:
    """The SMPL-X vertices a head Gaussian may take its skin from: head, jaw, neck or eye dominant, above floor_y."""
    dom = np.argmax(lbs, axis=1)
    return np.flatnonzero(np.isin(dom, SKIN_JOINTS) & (verts[:, 1] > floor_y))


def nearest_skin(points: np.ndarray, verts: np.ndarray, lbs: np.ndarray, candidates: np.ndarray, k: int = SKIN_K
                 ) -> tuple[np.ndarray, np.ndarray]:
    """skin.bin records: each point blends its k nearest candidate vertices' SMPL-X weights by inverse distance; the
    eyes' weights go to the head (a Gaussian on the eyelid mustn't turn with the gaze); then the top 4."""
    from scipy.spatial import cKDTree

    from lucid_avatars.skinning import blend_vertex_weights, quantize_top4

    d, i = cKDTree(verts[candidates]).query(points, k=k)
    w = blend_vertex_weights(lbs[candidates], np.reshape(i, (len(points), k)), np.reshape(d, (len(points), k)))
    w[:, J["head"]] += w[:, J["left_eye"]] + w[:, J["right_eye"]]
    w[:, [J["left_eye"], J["right_eye"]]] = 0
    return quantize_top4(w)


def ssim_torch(x, y, window: int = 11, sigma: float = 1.5):
    """SSIM of two (H, W, 3) images in 0..1 (torch), Gaussian window, as 3DGS trains with."""
    import torch
    import torch.nn.functional as F

    g = torch.exp(-((torch.arange(window, device=x.device, dtype=x.dtype) - window // 2) ** 2) / (2 * sigma ** 2))
    g = g / g.sum()
    w = (g[:, None] * g[None, :]).expand(3, 1, window, window).contiguous()
    a, b = x.permute(2, 0, 1)[None], y.permute(2, 0, 1)[None]
    f = lambda z: F.conv2d(z, w, padding=window // 2, groups=3)  # noqa: E731
    mu_a, mu_b = f(a), f(b)
    saa, sbb, sab = f(a * a) - mu_a ** 2, f(b * b) - mu_b ** 2, f(a * b) - mu_a * mu_b
    c1, c2 = 0.01 ** 2, 0.03 ** 2
    return (((2 * mu_a * mu_b + c1) * (2 * sab + c2)) / ((mu_a ** 2 + mu_b ** 2 + c1) * (saa + sbb + c2))).mean()


def extent(xyz: np.ndarray, alpha: np.ndarray, above_y: float, solid: float = 0.3) -> dict:
    """Width (x), depth (z) between the 1st and 99th percentiles and the top (99.5th) of the solid points above y."""
    p = xyz[(alpha > solid) & (xyz[:, 1] > above_y)]
    if len(p) < 100:
        return {"n": int(len(p))}
    q = lambda c, lo, hi: float(np.percentile(p[:, c], hi) - np.percentile(p[:, c], lo))  # noqa: E731
    return {"n": int(len(p)), "widthM": round(q(0, 1, 99), 4), "depthM": round(q(2, 1, 99), 4),
            "topM": round(float(np.percentile(p[:, 1], 99.5)), 4),
            "centreXZ": [round(float(np.median(p[:, 0])), 4), round(float(np.median(p[:, 2])), 4)]}


# FLAME's rest frame (metres, +Y up, the face looks along +Z): where the photos could see. Close-ups are frontal and
# three-quarter, so behind the ears UIKA imagines the head, and from four photos it imagines it badly (skin-coloured
# smears, a stray tuft). There the hair is repainted from the hair the photos did see.
BACK_Z = (-0.060, -0.045)  # FLAME z: fully repainted behind the first, untouched in front of the second
NAPE_Y = (-0.080, -0.060)  # FLAME y: the nape hairline, fading in over this range
SEEN_HAIR = {"zMin": -0.040, "yMin": 0.030}  # scalp Gaussians in front of zMin and above yMin: hair the photos saw
STANDOFF_M = {"hair": 0.045, "back": 0.030, "other": 0.030}  # furthest from its FLAME vertex (UIKA
# keeps the person's shape in offsets from the mean FLAME, so a face Gaussian may sit 2 cm off; a collar 4 cm)
HAIR_REGIONS = ("scalp", "forehead", "left_ear", "right_ear")
NECK_REGIONS = ("neck", "boundary")
COLLAR_REACH_M = 0.03  # a head model's neck under seam + this is checked against the body's collar
SMOOTH_K = 256  # seen Gaussians averaged for a repainted colour (smooth across the back of the head)
CHIN_GAP_M = 0.03  # the seam sits this far under the chin (UIKA's face and lips): the whole jaw and upper neck are
# UIKA's, and the cross-fade to the body's neck falls low on the neck, by the collar


def flame_regions(masks: dict, n: int) -> np.ndarray:
    """One region name per FLAME vertex from FLAME_masks.pkl (later masks win where they overlap; 'face' first, so the
    finer ones (eyes, nose, lips, ears) and 'neck'/'boundary' take precedence)."""
    out = np.full(n, "other", dtype=object)
    order = ["face", "scalp", "forehead"] + [k for k in masks if k not in ("face", "scalp", "forehead")]
    for k in order:
        if k in masks:
            out[np.asarray(masks[k], dtype=np.int64)] = k
    return out


def edit_uika(g: Gaussians, alpha: np.ndarray, near: np.ndarray, dist: np.ndarray, flame_rest: np.ndarray,
              regions: np.ndarray, k: int = 24) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict, np.ndarray]:
    """(keep mask, new RGB (n, 3), repaint weight (n,), counts, the seen hair) for UIKA's Gaussians: drop what isn't
    head (the shirt collar UIKA grew from the photos, the FLAME boundary ring, anything standing off its FLAME vertex
    further than hair can) and repaint what the photos never saw: behind the ears and above the nape the colour of
    the nearest seen hair, below the nape the colour of the nearest seen neck skin, each plus UIKA's own detail
    there (its colour minus its local mean). `near`/`dist`: each Gaussian's nearest FLAME vertex and the distance to
    it; `flame_rest`: FLAME's vertices in its own frame."""
    from scipy.spatial import cKDTree

    rgb = np.clip(0.5 + SH_C0 * g.f_dc, 0, 1)
    reg = regions[near]
    v = flame_rest[near]
    hair, neck = np.isin(reg, HAIR_REGIONS), np.isin(reg, NECK_REGIONS)
    behind = np.clip((BACK_Z[1] - v[:, 2]) / (BACK_Z[1] - BACK_Z[0]), 0, 1)
    above_nape = np.clip((v[:, 1] - NAPE_Y[0]) / (NAPE_Y[1] - NAPE_Y[0]), 0, 1)
    back_w = behind * above_nape * ((reg == "scalp") | neck)  # hair; not the ears
    skin_w = behind * (1 - above_nape) * neck  # the back of the neck under the hairline
    lum = rgb @ np.array([0.299, 0.587, 0.114])
    sat = rgb.max(1) - rgb.min(1)
    low = neck | (hair & (v[:, 1] < -0.03))
    eyes = np.isin(reg, ("left_eyeball", "right_eyeball", "eye_region", "left_eye_region", "right_eye_region"))
    # clothes on the neck (the front, and the back under the hairline): a pale shirt or a dark jacket collar is greyer
    # than skin (skin saturation ~0.3-0.5); behind the hairline dark grey is hair, so it stays
    neck_skin_zone = neck & ((v[:, 2] > BACK_Z[1]) | (above_nape < 0.5))
    cloth = neck_skin_zone & (((lum > 0.55) & (sat < 0.25)) | ((lum < 0.3) & (sat < 0.1)))
    shirt = (reg == "boundary") | cloth | (low & (((lum > 0.7) & (sat < 0.2)) | ((lum > 0.45) & (sat < 0.12)))) \
        | (~eyes & (lum > 0.85) & (sat < 0.12))  # and white specks, but the eyes' whites stay
    limit = np.where(hair | neck, STANDOFF_M["hair"], STANDOFF_M["other"])  # a thick neck sits well off FLAME's
    limit = np.where((back_w > 0.5) | (skin_w > 0.5), STANDOFF_M["back"], limit)  # no tuft, no hanging bits behind
    keep = (alpha > 0.02) & ~shirt & (dist <= limit)
    seen = keep & (reg == "scalp") & (v[:, 2] >= SEEN_HAIR["zMin"]) & (v[:, 1] >= SEEN_HAIR["yMin"])
    seen_skin = keep & neck & (v[:, 2] >= SEEN_HAIR["zMin"]) & (sat > 0.15) & (lum < 0.7)
    new = rgb.copy()
    painted = np.zeros(len(rgb), dtype=bool)
    for weight, source in ((back_w, seen), (skin_w, seen_skin)):
        paint = keep & (weight > 0)
        if source.sum() < k or not paint.any():
            continue
        kb = min(int(source.sum()), SMOOTH_K)  # many neighbours: no seam where the nearest side flips
        d, i = cKDTree(g.xyz[source]).query(g.xyz[paint], k=kb)
        w_ = 1 / (d + 0.01)
        base = (rgb[source][i] * w_[..., None]).sum(1) / w_.sum(1, keepdims=True)
        _, j = cKDTree(g.xyz[paint]).query(g.xyz[paint], k=k)
        detail = np.clip(rgb[paint] - rgb[paint][j].mean(1), -0.06, 0.06)  # UIKA's strands, not its bright lines
        w = weight[paint, None]
        new[paint] = np.clip(w * (base + 0.6 * detail) + (1 - w) * new[paint], 0, 1)
        painted |= paint
    counts = {"shirt": int((shirt & (alpha > 0.02)).sum()), "standoff": int(((dist > limit) & (alpha > 0.02)).sum()),
              "invisible": int((alpha <= 0.02).sum()), "seenHair": int(seen.sum()), "seenNeck": int(seen_skin.sum()),
              "repaintedHair": int((keep & (back_w > 0)).sum()), "repaintedNeck": int((keep & (skin_w > 0)).sum())}
    return keep, new, back_w + skin_w, counts, seen


SHELL_N = 40_000  # points sampled on the SMPL-X head for the shell, before keeping the scalp behind the hairline
SHELL_DEPTH_M = 0.003  # under the SMPL-X scalp: UIKA's hair sits ~1.4 cm out, so the shell shows only through gaps
SHELL_UNDER_M = 0.003  # in a gap the shell rises to the local hair height (UIKA's nearest opaque Gaussians) less this
SHELL_SIZE_M = (0.003, 0.003, 0.0006)  # flat discs along the scalp
SHELL_FRONT_Z = 0.0  # FLAME z: only the top and back of the scalp (in front of this the forehead hairline begins)


def scalp_shell(verts: np.ndarray, faces: np.ndarray, lbs: np.ndarray, seam_lo: float, flame_a: np.ndarray,
                flame_rest: np.ndarray, regions: np.ndarray, hair_xyz: np.ndarray, hair_rgb: np.ndarray,
                solid_xyz: np.ndarray, hair_lift: float, seed: int = 0, k: int = 24) -> Gaussians:
    """Opaque flat Gaussians on the avatar's SMPL-X scalp (behind the hairline, above the seam band), a few mm in,
    facing out, coloured like the nearest hair the photos saw (a little darker: the hair's inner layer). Each shell
    point sits just under the local height of UIKA's opaque hair (`solid_xyz`) over the scalp (at most `hair_lift`,
    the seen hair's height), so a gap is closed at the hair's surface, never as a dent or a bulge."""
    from scipy.spatial import cKDTree

    fids = D.head_faces(faces, verts, lbs, seam_lo)
    _, _, p, n = D.sample_surface(verts, faces, fids, SHELL_N, seed=seed)
    near = cKDTree(flame_a).query(p)[1]
    reg, v = regions[near], flame_rest[near]
    back = (v[:, 2] < BACK_Z[1]) & (v[:, 1] > NAPE_Y[0])
    ok = (((reg == "scalp") & (v[:, 2] < SHELL_FRONT_Z)) | (np.isin(reg, NECK_REGIONS) & back)) & (p[:, 1] > seam_lo)
    p, n = p[ok], n[ok]
    if len(solid_xyz) >= k:  # the local height of UIKA's hair over the scalp, along the scalp's normal
        _, j = cKDTree(solid_xyz).query(p, k=k)
        height = np.median(((solid_xyz[j] - p[:, None]) * n[:, None]).sum(-1), axis=1)
        rise = np.clip(height - SHELL_UNDER_M, -SHELL_DEPTH_M, hair_lift)
    else:
        rise = np.full(len(p), -SHELL_DEPTH_M)
    p = p + rise[:, None] * n
    if len(p) == 0 or len(hair_xyz) < k:
        return Gaussians(np.zeros((0, 3)), np.zeros((0, 3)), np.zeros((0, 0)), np.zeros(0), np.zeros((0, 3)),
                         np.zeros((0, 4)))
    _, i = cKDTree(hair_xyz).query(p, k=min(len(hair_xyz), SMOOTH_K))
    noise = np.random.default_rng(seed).normal(0.0, 1.0, len(p))
    noise = noise[cKDTree(p).query(p, k=8)[1]].mean(1)  # mottled over a few mm, not per Gaussian
    jitter = 1.0 + 0.25 * noise[:, None]  # hair isn't one flat colour
    rgb = np.clip(0.85 * hair_rgb[i].mean(1) * jitter, 0, 1)
    q = np.stack([1 + n[:, 2], -n[:, 1], n[:, 0], np.zeros(len(n))], 1)  # turns +z onto the normal
    q[n[:, 2] < -0.999] = [0.0, 1.0, 0.0, 0.0]
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    return Gaussians(xyz=p, f_dc=(rgb - 0.5) / SH_C0, f_rest=np.zeros((len(p), 0)), opacity=logit(np.full(len(p), 0.95)),
                     scale=np.log(np.tile(SHELL_SIZE_M, (len(p), 1))), rotation=q)


def through_collar(xyz: np.ndarray, is_neck: np.ndarray, cloth_xyz: np.ndarray, neck_xz: np.ndarray, below_y: float,
                   reach: float = 0.02, margin: float = 0.002) -> np.ndarray:
    """True for the head model's neck Gaussians (`is_neck`) under `below_y` that sit at or outside the body's clothes
    next to them, measured out from the neck's vertical axis (`neck_xz`): a thick neck poking through a collar."""
    from scipy.spatial import cKDTree

    out = np.zeros(len(xyz), dtype=bool)
    cand = np.flatnonzero(is_neck & (xyz[:, 1] < below_y))
    if len(cand) == 0 or len(cloth_xyz) == 0:
        return out
    d, j = cKDTree(cloth_xyz).query(xyz[cand])
    r_head = np.linalg.norm(xyz[cand][:, [0, 2]] - neck_xz, axis=1)
    r_cloth = np.linalg.norm(cloth_xyz[j][:, [0, 2]] - neck_xz, axis=1)
    out[cand] = (d < reach) & (r_head > r_cloth - margin)
    return out


def own_bundle_errors(person: str, src: Path, new_id: str) -> list[str]:
    """The body has to be the person's own avatar, and the new bundle a new <person>-... id that never replaces a
    bundle this step didn't write."""
    errors = []
    sid = json.loads((src / "dream.json").read_text()).get("id", "")
    if sid != person and not sid.startswith(f"{person}-"):
        errors.append(f"{src.name} (id {sid!r}) isn't {person}'s own avatar")
    if not H.BUNDLE_ID.fullmatch(new_id) or not new_id.startswith(f"{person}-") or new_id == sid:
        errors.append(f"new id {new_id!r} must be a new {person}-... id")
    out = src.parent / new_id
    if out.exists() and not (out / REPORT_FILE).is_file():
        errors.append(f"{out} exists and wasn't written by uika_head.py: it is never replaced")
    return errors


# ---------------------------------------------------------------- the student: the fit (gsplat)

def cmd_distill(a) -> int:
    refused = gate_errors(a.person, a.held) + own_bundle_errors(a.person, a.avatar, a.id)
    if refused:
        print("REFUSED", *refused, sep="\n     ")
        return 2

    import torch
    from gsplat import rasterization
    from PIL import Image
    from scipy.spatial import cKDTree

    from lucid_avatars.motion import Motion
    from lucid_avatars.skinning import SKELETON_FILE, SKIN_FILE, read_skin_bin, write_skin_bin

    t0 = time.time()
    dev = a.device
    rng = np.random.default_rng(a.seed)
    torch.manual_seed(a.seed)

    # ---- the avatar (before any cleanup: lhmpp_cleanup.py runs once on the result), its SMPL-X, the teacher
    src = a.avatar
    dream = json.loads((src / "dream.json").read_text())
    av = dream["avatar"]
    ply, skin = src / av["file"], src / av.get("skin", SKIN_FILE)
    raw_ply, raw_skin = ply.with_name("avatar.raw.ply"), skin.with_name("skin.raw.bin")
    if a.body == "raw" and raw_ply.is_file() and raw_skin.is_file():  # lhmpp_cleanup.py runs once, on the result
        ply, skin = raw_ply, raw_skin
    body = read_ply(ply)
    idx, q = read_skin_bin(skin)
    if len(idx) != len(body):
        print(f"FAILED {skin.name} has {len(idx)} records for {len(body)} Gaussians in {ply.name}")
        return 1
    print(f"[avatar] {dream['id']}: {len(body)} Gaussians from {ply.name}, SH degree {body.sh_degree}")
    rest = np.asarray(json.loads((src / av.get("skeleton", SKELETON_FILE)).read_text())["rest"], dtype=np.float64)
    joints, verts, lbs = H._smplx_rest(a.smplx, Motion.load(src / av["motion"]).betas)
    err = float(np.abs(joints - rest).max())
    print(f"[avatar] skeleton.json vs SMPL-X with the bundle's betas: {err * 1000:.2f} mm")
    if err > H.MAX_SKELETON_ERR_M:
        print("FAILED the avatar's rest pose isn't this SMPL-X's")
        return 1
    faces = np.asarray(np.load(a.smplx, allow_pickle=True)["f"], dtype=np.int64)
    ids = np.load(a.flame_ids).astype(np.int64).reshape(-1)
    header, views = D.read_cameras(a.teacher / D.VIEWS_DIR / D.CAMERAS_FILE)
    flame_u = np.load(a.teacher / D.FLAME_FILE).astype(np.float64)
    s, R, t = H.umeyama(flame_u, verts[ids])
    rms = float(np.sqrt((((s * flame_u @ R.T + t) - verts[ids]) ** 2).sum(1).mean()))
    print(f"[align] UIKA's FLAME -> the SMPL-X head: scale {s:.4f}, RMS {rms * 1000:.1f} mm")
    if rms > H.MAX_ALIGN_RMS_M:
        print("FAILED alignment over 3 cm RMS: wrong ids or mesh?")
        return 1
    W, Ht = int(header["width"]), int(header["height"])
    Ks = [v["K"] for v in views]
    w2cs = [D.camera_to_avatar(v["w2c"], s, R, t) for v in views]
    train, held = D.split_views(len(views))
    rgba_u8 = []
    for v in views:
        img = np.asarray(Image.open(v["path"]).convert("RGBA"))
        if img.shape[:2] != (Ht, W):
            raise SystemExit(f"{v['path']} is {img.shape[1]}x{img.shape[0]}, cameras.json says {W}x{Ht}")
        rgba_u8.append(img)
    front = min(range(len(views)), key=lambda i: abs(views[i]["yawDeg"]) + abs(views[i]["elevDeg"]))

    T = lambda x: torch.as_tensor(np.ascontiguousarray(x), dtype=torch.float32, device=dev)  # noqa: E731
    Kt, Vt = T(np.stack(Ks)), T(np.stack(w2cs))

    def raster(means, quats, scales, opac, colors, i, mode="RGB", packed=True):
        return rasterization(means=means, quats=quats, scales=scales, opacities=opac, colors=colors,
                             viewmats=Vt[i:i + 1], Ks=Kt[i:i + 1], width=W, height=Ht, render_mode=mode,
                             packed=packed)

    # ---- UIKA's own Gaussians in the avatar's frame: the exporter's check, the head's size against the body's
    ug, u_alpha = uika_gaussians(a.teacher / GAUSSIANS_FILE, s, R, t)
    with torch.no_grad():
        rgb_u, a_u, _ = raster(T(ug.xyz), T(ug.rotation), T(np.exp(ug.scale)), T(u_alpha),
                               T(np.clip(0.5 + SH_C0 * ug.f_dc, 0, None)), front)
    tv = rgba_u8[front] / 255.0
    m = tv[..., 3] > 0.02
    check_psnr = D.masked_psnr(rgb_u[0].cpu().numpy(), tv[..., :3] * tv[..., 3:], m) or 0.0
    check_alpha = float(np.abs(a_u[0, ..., 0].cpu().numpy() - tv[..., 3])[m].mean())
    print(f"[export] UIKA's Gaussians through gsplat vs UIKA's own front render: PSNR {check_psnr:.2f} dB, "
          f"alpha error {check_alpha:.3f} ({len(ug)} Gaussians, opacity median {np.median(u_alpha):.3f})")
    dominant = idx[np.arange(len(idx)), np.argmax(q, axis=1)].astype(np.int64)
    body_alpha = 1 / (1 + np.exp(-body.opacity))
    head_body = np.isin(dominant, H.HEAD_JOINTS)
    jaw_y = float(rest[J["jaw"], 1])
    size_uika = extent(ug.xyz, u_alpha, jaw_y)
    size_body = extent(body.xyz[head_body], body_alpha[head_body], jaw_y)
    print(f"[size] above the jaw joint: UIKA {size_uika}; the avatar's own head {size_body}")

    # ---- what of UIKA's head is head: no shirt collar, nothing standing off, the unseen back repainted from the
    # hair the photos saw (edit_uika); then cut at the jaw-line seam and faded in over the band below it
    import pickle

    flame_a = s * flame_u @ R.T + t
    dist, near = cKDTree(flame_a).query(ug.xyz)
    with open(a.flame_masks, "rb") as fh:
        regions = flame_regions(pickle.load(fh, encoding="latin1"), len(flame_u))
    keep_u, rgb_u, back_w, edits, seen_hair = edit_uika(ug, u_alpha, near, dist, flame_u, regions)
    # the seam goes just under UIKA's chin: head_distill_core.seam_height (SMPL-X's jaw joint - 3 cm) sits at lip
    # level, where the old blurry chin would cross-fade with the new sharp one
    chin_y = float(flame_a[np.isin(regions, ("face", "lips")), 1].min())
    seam_y = chin_y - CHIN_GAP_M + a.seam_offset
    seam_lo = seam_y - H.BAND_M
    body_k, keep_b, body_above = D.cut_body(body, idx, q, seam_y)
    dom_k = idx[keep_b][np.arange(int(keep_b.sum())), np.argmax(q[keep_b], axis=1)]
    cloth = ~np.isin(dom_k, SKIN_JOINTS) & (1 / (1 + np.exp(-body_k.opacity)) > 0.5)
    collar = through_collar(ug.xyz, np.isin(regions[near], NECK_REGIONS), body_k.xyz[cloth],
                            rest[J["neck"]][[0, 2]], seam_y + COLLAR_REACH_M)
    edits["throughCollar"] = int((collar & keep_u).sum())
    sel = keep_u & ~collar & (ug.xyz[:, 1] > seam_lo)
    # UIKA leaves gaps at the back of the head (its own renders smear over them): through them one sees the face from
    # behind. An opaque shell on the SMPL-X scalp, just under UIKA's hair and coloured like the seen hair, closes them
    hair_lift = 0.8 * float(np.median(dist[seen_hair])) if seen_hair.any() else 0.01
    shell = scalp_shell(verts, faces, lbs, seam_lo, flame_a, flame_u, regions, ug.xyz[seen_hair], rgb_u[seen_hair],
                        ug.xyz[keep_u & (u_alpha > 0.5)], hair_lift, seed=a.seed)
    anchor = np.concatenate([ug.xyz[sel], shell.xyz])
    fade = D.seam_fade(anchor[:, 1], seam_y)
    rgb_t = np.concatenate([rgb_u[sel], np.clip(0.5 + SH_C0 * shell.f_dc, 0, 1)])
    s_alpha = 1 / (1 + np.exp(-shell.opacity))
    edits["shell"] = len(shell)
    edits["shellLiftM"] = round(hair_lift, 4)
    # the teacher: UIKA's head as edited, at UIKA's own opacities (gsplat draws UIKA's Gaussians as UIKA's renderer
    # does: the export check above), with the shell, on the frozen body
    t_alpha = np.clip(np.concatenate([u_alpha[sel], s_alpha]) * fade, 0, 1)
    print(f"[edit] UIKA's {len(ug)} Gaussians: {edits}; {int(sel.sum())} kept above the seam band; body kept "
          f"{int(keep_b.sum())}, dropped {int((~keep_b).sum())}; seam y {seam_y:.3f}; body above the seam "
          f"{body_above}")
    log_scale = clamp_log_scales(np.concatenate([ug.scale[sel], shell.scale]), math.log(MIN_SCALE_M),
                                 math.log(MAX_SCALE_M))
    quat = np.concatenate([ug.rotation[sel], shell.rotation])
    alpha0 = np.clip(np.concatenate([u_alpha[sel], s_alpha]), OPACITY_FLOOR + 0.02, 0.98)
    raw0 = logit((alpha0 - OPACITY_FLOOR) / (1 - OPACITY_FLOOR))
    rgb0 = np.clip(rgb_t, 0.02, 0.98)
    n_u = len(anchor)

    b_means, b_quats = T(body_k.xyz), T(body_k.rotation)
    b_scales, b_opac = torch.exp(T(body_k.scale)), torch.sigmoid(T(body_k.opacity))
    b_rgb = T(np.clip(0.5 + SH_C0 * body_k.f_dc, 0, 1))
    th = (T(anchor), T(quat), T(np.exp(np.concatenate([ug.scale[sel], shell.scale]))), T(t_alpha), T(rgb_t))
    teach_l, boxes, head_px = [], [], []
    with torch.no_grad():
        for i in range(len(views)):
            c, al, _ = raster(torch.cat([b_means, th[0]]), torch.cat([b_quats, th[1]]), torch.cat([b_scales, th[2]]),
                              torch.cat([b_opac, th[3]]), torch.cat([b_rgb, th[4]]), i)
            straight = torch.where(al > 1 / 255, c / al.clamp_min(1e-6), torch.zeros_like(c))
            teach_l.append(torch.cat([straight, al], -1)[0].clamp(0, 1).mul(255).round().byte())
            _, ah, _ = raster(*th, i)
            head_px.append(ah[0, ..., 0] > 0.5)  # where the evaluation looks: the head, not the shared body
            boxes.append(D.mask_box(ah[0, ..., 0].cpu().numpy() > 0.02, pad=24) or (0, Ht, 0, W))
    teach = torch.stack(teach_l)
    del teach_l
    weight = [torch.zeros(Ht, W, device=dev) for _ in views]
    for i, (y0, y1, x0, x1) in enumerate(boxes):
        weight[i][y0:y1, x0:x1] = 1  # the fit looks at the head's box: the body there is the same in both
    print(f"[teacher] {len(views)} views of the edited UIKA head on the body; head box median "
          f"{int(np.median([(b[1] - b[0]) * (b[3] - b[2]) for b in boxes]))} px")
    sheet = [teach[i].cpu().numpy() for i in range(len(views)) if views[i]["elevDeg"] in (0.0, CROWN_PITCH)
             and views[i]["yawDeg"] % 45 == 0]
    over_grey = lambda x: (x[..., :3] * (x[..., 3:] / 255) + 128 * (1 - x[..., 3:] / 255)).astype(np.uint8)  # noqa: E731
    sheet = [np.asarray(Image.fromarray(over_grey(x)).resize((384, 384))) for x in sheet]
    Image.fromarray(np.concatenate([np.concatenate(sheet[r:r + 8], 1) for r in range(0, len(sheet) - 7, 8)], 0)
                    ).save(a.teacher / f"edited-{a.id}.jpg", quality=90)
    del rgba_u8

    # ---- the student
    names = ("offset", "log_scale", "quat", "raw", "rgb")
    lr = {"offset": a.lr_offset, "log_scale": 5e-3, "quat": 1e-3, "raw": 5e-2, "rgb": 1e-2}
    params = {"offset": torch.zeros(len(anchor), 3, device=dev), "log_scale": T(log_scale), "quat": T(quat),
              "raw": T(raw0), "rgb": torch.logit(T(rgb0))}
    params = {k: torch.nn.Parameter(v) for k, v in params.items()}
    fixed = {"anchor": T(anchor), "fade": T(fade), "from_uika": torch.as_tensor(np.arange(len(anchor)) < n_u,
                                                                              device=dev)}
    opt = torch.optim.Adam([{"params": [params[k]], "lr": lr[k], "name": k} for k in names], eps=1e-15)
    lo_s, hi_s = math.log(MIN_SCALE_M), math.log(MAX_SCALE_M)

    def head_tensors():
        alpha = (OPACITY_FLOOR + (1 - OPACITY_FLOOR) * torch.sigmoid(params["raw"])) * fixed["fade"]
        return (fixed["anchor"] + params["offset"], params["quat"], torch.exp(params["log_scale"]), alpha,
                torch.sigmoid(params["rgb"]))

    def render_all(i, packed=True):
        hm, hq, hs, ha, hc = head_tensors()
        rgb, alpha, meta = raster(torch.cat([b_means, hm]), torch.cat([b_quats, hq]), torch.cat([b_scales, hs]),
                                  torch.cat([b_opac, ha]), torch.cat([b_rgb, hc]), i, packed=packed)
        return rgb[0], alpha[0, ..., 0], meta

    def evaluate(view_ids):
        ps, ss = [], []
        with torch.no_grad():
            for i in view_ids:
                rgb, alpha, _ = render_all(int(i))
                tv = teach[i].float() / 255
                gt = tv[..., :3] * tv[..., 3:]
                mk = head_px[i]
                box = D.mask_box(mk.cpu().numpy(), pad=4)
                if box is None:
                    continue
                y0, y1, x0, x1 = box
                mm = mk[y0:y1, x0:x1, None].float()
                pc, gc = rgb[y0:y1, x0:x1] * mm, gt[y0:y1, x0:x1] * mm
                ps.append(D.masked_psnr(pc.cpu().numpy(), gc.cpu().numpy(), mm[..., 0].cpu().numpy() > 0))
                ss.append(float(ssim_torch(pc.clamp(0, 1), gc)))
        return (round(float(np.mean(ps)), 3) if ps else None, round(float(np.mean(ss)), 4) if ss else None)

    def edit(keep: torch.Tensor | None = None, add: dict | None = None) -> None:
        """Drop the Gaussians where keep is False and/or append new ones (their Adam moments start at zero)."""
        for group in opt.param_groups:
            k = group["name"]
            old = group["params"][0]
            val, state = old.detach(), opt.state.pop(old, None)
            moments = [state["exp_avg"], state["exp_avg_sq"]] if state else None
            if keep is not None:
                val = val[keep]
                moments = [m_[keep] for m_ in moments] if moments else None
            if add is not None:
                val = torch.cat([val, add[k]])
                moments = [torch.cat([m_, torch.zeros_like(add[k])]) for m_ in moments] if moments else None
            new = torch.nn.Parameter(val.clone())
            if state:
                state["exp_avg"], state["exp_avg_sq"] = moments
                opt.state[new] = state
            group["params"][0] = new
            params[k] = new
        for k in fixed:
            if keep is not None:
                fixed[k] = fixed[k][keep]
            if add is not None:
                fixed[k] = torch.cat([fixed[k], add["_" + k]])

    before = evaluate(held)
    print(f"[fit] held-out before: PSNR {before[0]} dB, SSIM {before[1]} ({len(held)} views)")
    n_body = len(body_k)
    grad_acc = torch.zeros(len(anchor), device=dev)
    grad_n = torch.zeros(len(anchor), device=dev)
    order = rng.permutation(train)
    pruned = cloned = split = 0
    densify_until = int(a.densify_until * a.steps)
    for step in range(a.steps):
        i = int(order[step % len(order)])
        if step % len(order) == len(order) - 1:
            order = rng.permutation(train)
        for group in opt.param_groups:
            if group["name"] == "offset":
                group["lr"] = a.lr_offset * 0.1 ** (step / max(1, a.steps - 1))
        bg = torch.rand(3, device=dev)
        rgb, alpha, meta = render_all(i, packed=False)
        if step < densify_until:
            meta["means2d"].retain_grad()
        y0, y1, x0, x1 = boxes[i]
        tv = teach[i, y0:y1, x0:x1].float() / 255
        ta, w = tv[..., 3], weight[i][y0:y1, x0:x1]
        pred = rgb[y0:y1, x0:x1] + (1 - alpha[y0:y1, x0:x1, None]) * bg
        gt = tv[..., :3] * ta[..., None] + (1 - ta[..., None]) * bg
        mk = (w * ta)[..., None]
        l1 = (mk * (pred - gt).abs()).sum() / (3 * mk.sum() + 1e-6)
        d_ssim = 1 - ssim_torch(mk * pred + (1 - mk) * gt, gt)
        wf = weight[i]
        l_alpha = (wf * (alpha - teach[i, ..., 3].float() / 255).abs()).sum() / (wf.sum() + 1e-6)
        off = params["offset"].norm(dim=1)
        l_off = ((off - OFFSET_FREE_M).clamp_min(0) / OFFSET_FREE_M).pow(2).mean()
        loss = l1 + a.ssim_weight * d_ssim + a.alpha_weight * l_alpha + 0.05 * l_off
        opt.zero_grad(set_to_none=True)
        loss.backward()
        if step < densify_until:
            g2 = meta["means2d"].grad[0, n_body:].clone()
            g2[:, 0] *= W / 2
            g2[:, 1] *= Ht / 2
            seen = meta["radii"][0, n_body:] > 0
            if seen.dim() > 1:
                seen = seen.any(-1)
            grad_acc[seen] += g2.norm(dim=-1)[seen]
            grad_n[seen] += 1
        opt.step()
        with torch.no_grad():
            o = params["offset"]
            o.mul_(MAX_OFFSET_M / o.norm(dim=1, keepdim=True).clamp_min(MAX_OFFSET_M))
            clamp_log_scales(params["log_scale"].data, lo_s, hi_s)
        if step and step % 500 == 0 and step <= 0.8 * a.steps:
            with torch.no_grad():
                keep = torch.sigmoid(params["raw"]) >= PRUNE_BELOW
                n_drop = int((~keep).sum())
                if n_drop:
                    edit(keep=keep)
                    grad_acc, grad_n = grad_acc[keep], grad_n[keep]
                    pruned += n_drop
                if step <= densify_until and len(params["raw"]) < a.max_head:
                    mean_g = grad_acc / grad_n.clamp_min(1)
                    grow = (mean_g > a.grow_grad) & (grad_n > 0)
                    room = a.max_head - len(params["raw"])
                    if int(grow.sum()) > room:
                        grow &= mean_g >= torch.topk(mean_g, room).values[-1]
                    big = grow & (params["log_scale"].max(1).values > math.log(a.split_above))
                    small = grow & ~big
                    adds = []
                    if bool(small.any()):  # clone in place
                        adds.append({k: params[k].detach()[small] for k in names}
                                    | {"_" + k: fixed[k][small] for k in fixed})
                        cloned += int(small.sum())
                    if bool(big.any()):  # split: two smaller ones inside the parent, the parent goes
                        from gsplat.utils import normalized_quat_to_rotmat

                        for _ in range(2):
                            sc = torch.exp(params["log_scale"].detach()[big])
                            rot = normalized_quat_to_rotmat(torch.nn.functional.normalize(params["quat"].detach()[big],
                                                                                         dim=-1))
                            jitter = torch.einsum("nij,nj->ni", rot, torch.randn_like(sc) * sc)
                            new = {k: params[k].detach()[big].clone() for k in names}
                            new["offset"] = new["offset"] + jitter
                            new["log_scale"] = new["log_scale"] - math.log(1.6)
                            adds.append(new | {"_" + k: fixed[k][big] for k in fixed})
                        split += int(big.sum())
                    if adds:  # the copies above are taken; now the split parents go and the new ones join
                        if bool(big.any()):
                            edit(keep=~big)
                        edit(add={k: torch.cat([d[k] for d in adds]) for k in adds[0]})
                    grad_acc = torch.zeros(len(params["raw"]), device=dev)
                    grad_n = torch.zeros(len(params["raw"]), device=dev)
        if step % 500 == 0 or step == a.steps - 1:
            print(f"[fit] step {step}: loss {float(loss):.4f} (L1 {float(l1):.4f}, D-SSIM {float(d_ssim):.4f}, "
                  f"alpha {float(l_alpha):.4f}); {len(params['raw'])} head Gaussians, {pruned} pruned, "
                  f"{cloned} cloned, {split} split; {time.time() - t0:.0f} s")

    after = evaluate(held)
    train_fit = evaluate(train[:: max(1, len(train) // 8)])
    print(f"[fit] held-out after: PSNR {after[0]} dB, SSIM {after[1]}; train sample {train_fit[0]} dB")

    # ---- the head as Gaussians, skinned from the nearest SMPL-X head/neck/jaw vertices
    raw = params["raw"].detach().cpu().numpy().astype(np.float64)
    keep_end = 1 / (1 + np.exp(-raw)) >= PRUNE_BELOW
    pick = lambda x: x.detach().cpu().numpy().astype(np.float64)[keep_end]  # noqa: E731
    xyz = pick(fixed["anchor"]) + pick(params["offset"])
    quat_h = pick(params["quat"])
    quat_h /= np.linalg.norm(quat_h, axis=1, keepdims=True)
    fade_h = pick(fixed["fade"])
    alpha_h = np.clip((OPACITY_FLOOR + (1 - OPACITY_FLOOR) / (1 + np.exp(-raw[keep_end]))) * fade_h, 1e-6, 1 - 1e-6)
    rgb_h = 1 / (1 + np.exp(-pick(params["rgb"])))
    head = Gaussians(xyz=xyz, f_dc=(rgb_h - 0.5) / SH_C0, f_rest=np.zeros((len(xyz), 0)), opacity=logit(alpha_h),
                     scale=pick(params["log_scale"]), rotation=quat_h)
    cand = skin_candidates(verts, lbs, seam_lo - 0.06)
    h_idx, h_q = nearest_skin(xyz, verts, lbs, cand)
    off_mm = np.linalg.norm(pick(params["offset"]), axis=1) * 1000
    ratio = np.exp(head.scale.max(1) - head.scale.min(1))

    # ---- the bundle: the source with avatar.ply + skin.bin replaced
    out = src.parent / a.id
    part = src.parent / f".{a.id}.part"
    shutil.rmtree(part, ignore_errors=True)
    shutil.copytree(src, part, ignore=shutil.ignore_patterns(*_NOT_COPIED))
    merged = D.merge_gaussians(body_k, head)
    write_ply(part / av["file"], merged)
    write_skin_bin(part / av.get("skin", SKIN_FILE), np.concatenate([idx[keep_b], h_idx]),
                   np.concatenate([q[keep_b], h_q]))
    report = {
        "from": dream["id"], "teacher": D.TEACHER, "uikaCommit": header.get("uikaCommit"),
        "photos": header.get("photos"), "credit": header.get("credit"),
        "align": {"scale": round(s, 6), "rmsM": round(rms, 6)},
        "exportCheck": {"psnr": round(check_psnr, 2), "alphaError": round(check_alpha, 4)},
        "size": {"uika": size_uika, "avatar": size_body},
        "body": a.body, "seam": {"y": round(seam_y, 4), "chinY": round(chin_y, 4), "jawJointY": round(float(rest[J["jaw"], 1]), 4),
                 "bandM": H.BAND_M, "offsetM": a.seam_offset, "bodyAbove": body_above},
        "edits": edits, "seeds": n_u,
        "fit": {"steps": a.steps, "pruned": pruned, "cloned": cloned, "split": split,
                "views": len(views), "heldOut": int(len(held)), "size": W,
                "psnrBefore": before[0], "ssimBefore": before[1], "psnr": after[0], "ssim": after[1],
                "trainPsnr": train_fit[0], "trainSsim": train_fit[1],
                "how": "the edited UIKA head on the body (the teacher) vs the avatar with its distilled head, RGB "
                       "premultiplied over black, on the teacher's head pixels, views the fit never saw"},
        "head": {"gaussians": len(head), "bodyKept": int(keep_b.sum()), "bodyDropped": int((~keep_b).sum()),
                 "first": int(keep_b.sum()),
                 "opacity": D.opacity_stats(alpha_h, fade_h < 1),
                 "offsetMm": {"median": round(float(np.median(off_mm)), 2), "max": round(float(off_mm.max()), 2)},
                 "scaleMm": {"median": round(float(np.exp(np.median(head.scale)) * 1000), 3),
                             "max": round(float(np.exp(head.scale.max()) * 1000), 2)},
                 "axisRatioMax": round(float(ratio.max()), 2),
                 "skin": f"{SKIN_K} nearest SMPL-X head/neck/jaw vertices, inverse distance, eyes to head"},
        "loss": {"l1": 1.0, "dSsim": a.ssim_weight, "alpha": a.alpha_weight, "opacityFloor": OPACITY_FLOOR,
                 "scaleM": [MIN_SCALE_M, MAX_SCALE_M], "maxAxisRatio": MAX_AXIS_RATIO, "maxOffsetM": MAX_OFFSET_M},
        "seconds": round(time.time() - t0, 1)}
    (part / REPORT_FILE).write_text(json.dumps(report, indent=2) + "\n")
    avatar = {k: v for k, v in av.items() if k not in ("expr", "exprChannels", "reality")}
    dream.update(id=a.id, preview=None, thumb=None, avatar=avatar)
    dream["source"] = {**(dream.get("source") or {}),
                       "head": {"model": "UIKA (ant-research/UIKA, CVPR 2026, MIT)",
                                "method": "distilled: fresh opaque Gaussians fitted with gsplat to UIKA's renders of "
                                          "its head, on the body of " + report["from"],
                                "photos": header.get("photos"), "credit": header.get("credit")}}
    (part / "dream.json").write_text(json.dumps(dream, indent=2) + "\n")
    if out.exists():
        shutil.rmtree(out)
    part.rename(out)
    print(json.dumps({k: report[k] for k in ("align", "exportCheck", "size", "edits", "fit", "head")}, indent=1))
    print(f"[bundle] {out}: {len(head)} head Gaussians after {int(keep_b.sum())} body ones ({time.time() - t0:.0f} s)")
    print("UIKA_DISTILL_OK")
    return 0


# ---------------------------------------------------------------- after lhmpp_cleanup.py: check, preview, thumb

def cmd_finish(a) -> int:
    from PIL import Image

    import lhmpp_avatar as LA
    from lucid_avatars import skinning as S
    from lucid_avatars.bundle import validate_bundle
    from lucid_avatars.motion import Motion

    root = a.bundle
    if not (root / REPORT_FILE).is_file():
        print(f"{root} has no {REPORT_FILE}: not this step's bundle")
        return 1
    problems = validate_bundle(root)
    dream = json.loads((root / "dream.json").read_text())
    av = dream["avatar"]
    report = json.loads((root / REPORT_FILE).read_text())
    g = read_ply(root / av["file"])
    idx, q = S.read_skin_bin(root / av["skin"])
    rest = np.asarray(json.loads((root / av["skeleton"]).read_text())["rest"], dtype=np.float64)
    m = Motion.load(root / av["motion"])
    first = int(report["head"]["first"])
    # lhmpp_cleanup.py cleans LHM++'s body (hands, specks, logos); its hair blur is for LHM++'s blotches, so the
    # distilled head keeps its fitted colours and sizes (from the avatar.raw.ply the cleanup kept)
    raw = root / av["file"].replace("avatar.ply", "avatar.raw.ply")
    if raw.is_file():
        r = read_ply(raw)
        if len(r) == len(g) and np.allclose(r.xyz[first:], g.xyz[first:]):
            f_dc, scale = g.f_dc.copy(), g.scale.copy()
            f_dc[first:], scale[first:] = r.f_dc[first:], r.scale[first:]
            g = replace(g, f_dc=f_dc, scale=scale)
            write_ply(root / av["file"], g)
            print(f"[finish] the head's {len(g) - first} Gaussians keep their fitted colours; the body is cleaned")
    checks = {}
    for f in sorted({0, m.num_frames // 2, m.num_frames - 1}):
        M = S.skin_matrices(rest, m.root_q[f], m.root_t[f], m.pose[f])
        posed = S.pose_points(g.xyz[first:], idx[first:], q[first:], M)
        head_j = (M[J["head"]] @ np.r_[rest[J["head"]], 1.0])[:3]
        d = np.linalg.norm(posed - head_j, axis=1)
        # rigid check: the head Gaussians posed vs the head joint's own transform of them
        rigid = (g.xyz[first:] @ M[J["head"], :3, :3].T) + M[J["head"], :3, 3]
        dev = np.linalg.norm(posed - rigid, axis=1)
        checks[f] = {"finite": bool(np.isfinite(posed).all()), "maxFromHeadJointM": round(float(d.max()), 3),
                     "p99OffRigidHeadMm": round(float(np.percentile(dev, 99) * 1000), 2)}
    print(f"[posed] head Gaussians per frame: {checks}")
    if not all(c["finite"] and c["maxFromHeadJointM"] < 0.4 for c in checks.values()):
        problems.append(f"posed head Gaussians stray: {checks}")
    gs = LA.posed_gaussians(root)
    thumb = LA.turntable(gs, root / "preview.mp4")
    Image.fromarray(thumb).save(root / "thumb.jpg", quality=92)
    views = LA.standard_views(gs)
    for k, img in views.items():
        if img.astype(np.float64).std() < 5:
            problems.append(f"{k} renders blank")
    dream.update(preview="preview.mp4", thumb="thumb.jpg")
    (root / "dream.json").write_text(json.dumps(dream, indent=2) + "\n")
    cleanup = json.loads((root / "cleanup.json").read_text()) if (root / "cleanup.json").is_file() else None
    report.update(posed=checks, cleanup=cleanup)
    (root / REPORT_FILE).write_text(json.dumps(report, indent=2) + "\n")
    problems += validate_bundle(root)
    for p in problems:
        print(f"[bundle] {p}")
    print(f"{'BUNDLE_FAIL' if problems else 'BUNDLE_OK'} {root}")
    return 1 if problems else 0


# ---------------------------------------------------------------- judge: old vs new, as LHM++'s renders are made

def cmd_judge(a) -> int:
    import os

    from PIL import Image

    import lhmpp_avatar as LA
    from lucid_avatars.realism import laplacian_variance

    a.out.mkdir(parents=True, exist_ok=True)
    rows, views = [], {}
    for label, bundle in (("old", a.old), ("new", a.new)):
        gs = LA.posed_gaussians(bundle)
        views[label] = LA.standard_views(gs)
        LA.save_views(views[label], a.out, f"{label}-{bundle.name}")
        rows.append((f"{label}: {bundle.name}", views[label]))
    LA.compare_sheet(rows, a.prep.parent / "raw.jpg" if a.prep else None, a.out / "compare.jpg")

    # close-ups: the middle of each portrait at full resolution, old above new
    tiles = []
    for label in ("old", "new"):
        row = []
        for ang in LA.ANGLES:
            img = views[label][f"portrait_{ang:03d}"]
            h, w = img.shape[:2]
            row.append(img[h // 8: h // 8 + h // 2, w // 2 - h // 4: w // 2 + h // 4])
        tiles.append(np.concatenate(row, 1))
    Image.fromarray(np.concatenate(tiles, 0)).save(a.out / "closeups.jpg", quality=95)

    result = {"old": a.old.name, "new": a.new.name, "lens": "1.8 m, 14 degree vertical FOV (lhmpp_avatar.PORTRAIT), "
              "posed by motion.json frame 0, gsplat, white background"}
    # sharpness: variance of the Laplacian over the face (the portrait's middle)
    sharp = {}
    for label in ("old", "new"):
        for ang in (0, 45):
            img = views[label][f"portrait_{ang:03d}"]
            h, w = img.shape[:2]
            sharp[f"{label}_{ang:03d}"] = round(float(laplacian_variance(img[h // 4: h // 2 + h // 8,
                                                                          w // 2 - w // 5: w // 2 + w // 5])), 2)
    result["faceSharpness"] = sharp

    # identity 1: LHM++'s yardstick (its ArcFace on its prep photos), the numbers report.json already has for LHM++
    try:
        sys.path.insert(0, os.getcwd())
        ident = LA.Identity()
        embs, photo_photo = LA.photo_embeddings(ident, a.prep)
        result["identityLhmpp"] = {"photoVsPhoto": photo_photo,
                                   **{lab: LA.identity_scores(ident, embs, views[lab]) for lab in ("old", "new")},
                                   "how": "GFPGAN ResNet18 ArcFace on MediaPipe face crops vs the LHM++ prep photos"}
    except Exception as e:  # noqa: BLE001 - a yardstick, not a reason to fail
        print(f"[identity] LHM++ yardstick unavailable: {e}")
    # identity 2: InsightFace buffalo_l (ArcFace R50) against the close-up photos
    try:
        from insightface.app import FaceAnalysis

        app = FaceAnalysis(name="buffalo_l", root=str(a.insightface_root),
                           providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
        app.prepare(ctx_id=0, det_size=(640, 640))

        def emb(rgb):
            faces = app.get(np.ascontiguousarray(rgb[..., ::-1]))
            if not faces:
                return None
            return max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])).normed_embedding

        photos = D.photo_paths(a.photos)
        if a.use:
            want = a.use.replace(":", ",").split(",")
            photos = [p for p in photos if p.stem in want]
        pe = {}
        for p in photos:
            img = Image.open(p).convert("RGB")
            img.thumbnail((1600, 1600))
            e = emb(np.asarray(img))
            if e is not None:
                pe[p.stem] = e
        out = {"photos": sorted(pe), "photoVsPhoto": round(float(np.mean([pe[x] @ pe[y] for x in pe for y in pe
                                                                           if x < y])), 4) if len(pe) > 1 else None}
        for lab in ("old", "new"):
            for ang in (0, 45, 90):
                e = emb(views[lab][f"portrait_{ang:03d}"])
                out[f"{lab}_{ang:03d}"] = None if e is None or not pe else round(float(np.mean([e @ v for v in
                                                                                              pe.values()])), 4)
        if a.teacher and (a.teacher / D.VIEWS_DIR).is_dir():
            _, tviews = D.read_cameras(a.teacher / D.VIEWS_DIR / D.CAMERAS_FILE)
            for ang in (0, 45):
                v = min(tviews, key=lambda x: abs(x["yawDeg"] - ang) + abs(x["elevDeg"]))
                rgba = np.asarray(Image.open(v["path"]).convert("RGBA")).astype(np.float64) / 255
                rgb = (rgba[..., :3] * rgba[..., 3:] + (1 - rgba[..., 3:])) * 255
                e = emb(rgb.astype(np.uint8))
                out[f"teacher_{ang:03d}"] = None if e is None or not pe else round(float(np.mean([e @ w for w in
                                                                                                 pe.values()])), 4)
        out["how"] = "InsightFace buffalo_l (ArcFace R50) cosine, mean over the close-up photos"
        result["identityInsightface"] = out
    except Exception as e:  # noqa: BLE001
        print(f"[identity] InsightFace unavailable: {e}")
    (a.out / "judge.json").write_text(json.dumps(result, indent=1) + "\n")
    print(json.dumps(result, indent=1))
    print("UIKA_JUDGE_OK")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("teacher", help="UIKA's renders, cameras, FLAME mesh and Gaussians (UIKA's env)")
    t.add_argument("--person", required=True)
    t.add_argument("--photos", type=Path, required=True)
    t.add_argument("--use", help="photo stems to use, comma- or colon-separated (default: all, by name)")
    t.add_argument("--out", type=Path, required=True)
    t.add_argument("--uika", type=Path, required=True, help="UIKA's repo")
    t.add_argument("--held", type=Path)
    t.add_argument("--size", type=int, default=1024)
    t.add_argument("--distance", type=float, default=D.VIEW_DISTANCE_M)
    t.add_argument("--half-extent", type=float, default=D.VIEW_HALF_EXTENT_M)
    t.add_argument("--chunk", type=int, default=13)
    t.add_argument("--device", default="cuda")
    d = sub.add_parser("distill", help="fresh opaque head Gaussians fitted to the teacher, on the avatar (gsplat)")
    d.add_argument("--person", required=True)
    d.add_argument("--avatar", type=Path, required=True, help="the body: the person's own avatar bundle")
    d.add_argument("--teacher", type=Path, required=True)
    d.add_argument("--smplx", type=Path, required=True, help="SMPLX_NEUTRAL.npz the avatar was built with")
    d.add_argument("--flame-ids", type=Path, required=True, help="SMPL-X__FLAME_vertex_ids.npy")
    d.add_argument("--id", required=True, help="the new bundle's id (a new <person>-... id)")
    d.add_argument("--held", type=Path)
    d.add_argument("--body", choices=("raw", "current"), default="raw",
                   help="raw: avatar.raw.ply when there (lhmpp_cleanup.py then runs on the result); current: the body as "
                        "it is now (already cleaned or slimmed: fitted in its final shape)")
    d.add_argument("--steps", type=int, default=7000)
    d.add_argument("--seam-offset", type=float, default=0.0, help="move the jaw-line seam up (+) or down, metres")
    d.add_argument("--flame-masks", type=Path, required=True, help="FLAME_masks.pkl (FLAME 2023's regions)")
    d.add_argument("--lr-offset", type=float, default=5e-5)
    d.add_argument("--ssim-weight", type=float, default=0.2)
    d.add_argument("--alpha-weight", type=float, default=0.5)
    d.add_argument("--densify-until", type=float, default=0.5, help="share of the steps")
    d.add_argument("--grow-grad", type=float, default=0.0002, help="mean screen-space gradient that densifies")
    d.add_argument("--split-above", type=float, default=0.002, help="split (not clone) above this size, metres")
    d.add_argument("--max-head", type=int, default=350_000)
    d.add_argument("--seed", type=int, default=0)
    d.add_argument("--device", default="cuda")
    f = sub.add_parser("finish", help="after lhmpp_cleanup.py: posed check, preview, thumb, validate")
    f.add_argument("bundle", type=Path)
    j = sub.add_parser("judge", help="portraits old vs new, identity, sharpness")
    j.add_argument("--old", type=Path, required=True)
    j.add_argument("--new", type=Path, required=True)
    j.add_argument("--photos", type=Path, required=True)
    j.add_argument("--use")
    j.add_argument("--prep", type=Path, help="LHM++'s prep/raw photos (its identity yardstick)")
    j.add_argument("--teacher", type=Path)
    j.add_argument("--insightface-root", type=Path, default=Path.home() / ".insightface")
    j.add_argument("--out", type=Path, required=True)
    a = p.parse_args()
    return {"teacher": cmd_teacher, "distill": cmd_distill, "finish": cmd_finish, "judge": cmd_judge}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
