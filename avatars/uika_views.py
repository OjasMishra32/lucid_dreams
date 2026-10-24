"""The head distill's teacher: UIKA's neutral head of a consenting person, rendered from ~90 views in UIKA's own
renderer, with the cameras and UIKA's FLAME mesh, for head_distill.py to fit opaque SMPL-X-head Gaussians to.

UIKA (ant-research/UIKA, CVPR 2026, MIT) is feed-forward: a folder of pose-free photos -> ~130K Gaussians on FLAME's
UV map, animated by FLAME parameters and drawn by its own rasterizer (diff-gaussian-rasterization). Its public runner
only renders a driving sequence's cameras or an orbit and thresholds the alpha at 0.7, so this script calls the same
model the same way (UIKA's own config, checkpoint, reference loader and forward) with our cameras and FLAME at rest:
expression, jaw, eyes, neck and head pose all zero (mouth closed, eyes open), shape zero as UIKA always uses
(cano_shape: the person's shape lives in the Gaussians' offsets). Background black, so the soft alpha is UIKA's own.

Out, in the person's teacher folder (data/avatars/heads/<person>/uika):
  views/NNN.png       RGBA, straight (not premultiplied) colour, UIKA's soft alpha
  views/cameras.json  per view: K (pixels) and w2c (OpenCV, x right / y down / z forward) in UIKA's FLAME frame
  flame.npy           UIKA's FLAME mesh for this head, 5023 x 3, the same frame (FLAME at rest, as rendered)
  contact.png         the eye-level views side by side, for a quick look

UIKA's env, run from UIKA's repo (its config paths are relative), this folder on PYTHONPATH (hpg/uika-head.sbatch):
  python uika_views.py --person vishal --photos .../faces/vishal --out .../heads/vishal/uika --held .../dreams/.held
The consent gate (head_distill_core.teacher_consent_errors) runs before any photo is read or anything is written.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

from lucid_avatars import head_distill_core as D

MAX_PHOTOS = 16  # UIKA trains on 1-16 reference images per head (configs/uika_base.yaml image_num)


def chunks(n: int, size: int):
    for s in range(0, n, size if size > 0 else n):
        yield s, min(n, s + (size if size > 0 else n))


def to_rgba(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """(H, W, 4) uint8 from UIKA's premultiplied-over-black colour (3, H, W) and alpha (1, H, W)."""
    a = np.clip(alpha[0], 0, 1)
    straight = np.where(a[None] > 1 / 255, rgb / np.maximum(a[None], 1e-4), 0)
    out = np.concatenate([np.clip(straight, 0, 1), a[None]], 0).transpose(1, 2, 0)
    return (out * 255 + 0.5).astype(np.uint8)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--person", required=True, help="whose face; must be in head_swap.CONSENTED")
    p.add_argument("--photos", type=Path, required=True, help="their own photos, data/avatars/faces/<person>")
    p.add_argument("--out", type=Path, required=True, help="their own teacher folder, data/avatars/heads/<person>/uika")
    p.add_argument("--held", type=Path, required=True, help="dreams/.held")
    p.add_argument("--uika", type=Path, default=Path.cwd(), help="UIKA's repo (default: here)")
    p.add_argument("--size", type=int, default=D.VIEW_SIZE)
    p.add_argument("--distance", type=float, default=D.VIEW_DISTANCE_M)
    p.add_argument("--half-extent", type=float, default=D.VIEW_HALF_EXTENT_M)
    p.add_argument("--max-photos", type=int, default=MAX_PHOTOS)
    p.add_argument("--chunk", type=int, default=16, help="views per UIKA forward (each forward re-encodes the photos)")
    p.add_argument("--device", default="cuda")
    a = p.parse_args()

    refused = D.teacher_consent_errors(a.person, a.photos, a.out, a.held)
    if refused:
        print("REFUSED", *refused, sep="\n     ")
        return 2
    photos = [ph.resolve() for ph in D.photo_paths(a.photos)]  # before the chdir into UIKA's repo below
    if not photos:
        print(f"no .jpg/.jpeg/.png photos in {a.photos}")
        return 1
    if len(photos) > a.max_photos:
        print(f"[uika] {len(photos)} photos; using the first {a.max_photos} by name (UIKA trains on up to 16)")
        photos = photos[:a.max_photos]
    out = a.out.resolve()
    uika = a.uika.resolve()

    import os

    import torch
    from omegaconf import OmegaConf
    from PIL import Image

    os.chdir(uika)  # UIKA's config names its weights and FLAME files relative to its repo
    torch._dynamo.config.disable = True  # as UIKA's own inferrer: forward_uv_token is @torch.compile'd
    from uika.models.rendering.flame_model.base_flame import FlameHead
    from uika.runners.infer.checkpoint import build_model_from_config, load_checkpoint_into_model
    from uika.runners.infer.reference import infer_encoder_patch_size, load_references

    cfg = OmegaConf.load("configs/infer_uika.yaml")
    base = OmegaConf.load(cfg.base_config)
    del cfg["base_config"]
    cfg = OmegaConf.merge(base, cfg)
    inf = cfg.inference
    device = torch.device(a.device)
    model = build_model_from_config(cfg, skip_pretrained_weights=True).to(device)
    report = load_checkpoint_into_model(model, inf.checkpoint, strict=False, fail_on_shape_mismatch=True)
    load_counts = {k: len(getattr(report, k)) for k in ("loaded", "missing", "unexpected", "mismatched")}
    print(f"[uika] checkpoint {inf.checkpoint}: {load_counts}")
    if load_counts["loaded"] == 0:
        print("[uika] nothing loaded from the checkpoint: not UIKA's weights?")
        return 1
    model.to(torch.float32).eval()

    refs = Path(tempfile.mkdtemp(prefix="uika-refs-"))  # only this person's chosen photos, linked
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
    print(f"[uika] {len(references.paths)} photos, masks from {sorted(set(references.mask_sources))}")

    fm = model.renderer.flame_model
    zeros = lambda *s: torch.zeros(*s, device=device)  # noqa: E731
    with torch.no_grad():  # FLAME at rest, through UIKA's own FLAME (the base class's mesh forward)
        flame = FlameHead.forward(fm, zeros(1, fm.n_shape_params), zeros(1, fm.n_expr_params), zeros(1, 3),
                                  zeros(1, 3), zeros(1, 3), zeros(1, 6), zeros(1, 3))["animated"][0]
    flame = flame.detach().cpu().numpy().astype(np.float64)
    if flame.shape != (5023, 3):
        print(f"[uika] FLAME mesh is {flame.shape}, expected (5023, 3)")
        return 1
    target = 0.5 * (flame.min(0) + flame.max(0))
    print(f"[uika] FLAME mesh: extent {np.ptp(flame, axis=0).round(3).tolist()} m, centre {target.round(4).tolist()}")

    views = D.view_cameras(target, a.distance, a.size, a.half_extent)
    part = out / (D.VIEWS_DIR + ".part")
    shutil.rmtree(part, ignore_errors=True)
    part.mkdir(parents=True)
    images = references.images.unsqueeze(0).to(device, torch.float32)
    masks = references.masks.unsqueeze(0).to(device, torch.float32)
    rgba_all = []
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
        rgb, alpha = res["comp_rgb"][0].float().cpu().numpy(), res["comp_mask"][0].float().cpu().numpy()
        for k, v in enumerate(views[s:e]):
            rgba = to_rgba(rgb[k], alpha[k])
            Image.fromarray(rgba, "RGBA").save(part / v["file"])
            rgba_all.append(rgba)
        print(f"[uika] views {s}-{e - 1} rendered; alpha coverage {float((alpha > 0.5).mean()):.3f}")

    commit = subprocess.run(["git", "-C", str(uika), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    D.write_cameras(part / D.CAMERAS_FILE, views, a.size, a.person, {
        "teacher": D.TEACHER, "uikaCommit": commit or None, "photos": [ph.name for ph in photos],
        "expression": "FLAME at rest: expression, jaw, eyes, neck and head pose zero (mouth closed, eyes open); "
                      "shape zero (UIKA's cano_shape)",
        "background": "black; PNG colour is straight, alpha is UIKA's soft alpha",
        "targetM": target.round(6).tolist(), "distanceM": a.distance, "halfExtentM": a.half_extent,
        "checkpointLoad": load_counts})
    D.read_cameras(part / D.CAMERAS_FILE)  # what the student will read: refuse here, not an hour later
    np.save(out / D.FLAME_FILE, flame.astype(np.float32))
    level = [i for i, v in enumerate(views) if v["elevDeg"] == 0]
    sheet = np.concatenate([np.asarray(Image.fromarray(rgba_all[i]).convert("RGB").resize((128, 128))) for i in level],
                           axis=1)
    Image.fromarray(sheet).save(out / "contact.png")
    final = out / D.VIEWS_DIR
    shutil.rmtree(final, ignore_errors=True)
    part.rename(final)  # whole or not at all
    print(f"[uika] {len(views)} views + {D.CAMERAS_FILE} in {final}, {D.FLAME_FILE} and contact.png in {out}")
    print("UIKA_VIEWS_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
