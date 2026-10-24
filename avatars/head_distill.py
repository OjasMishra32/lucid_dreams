"""The head distill, the GPU step: fresh, opaque SMPL-X-head Gaussians on a consenting person's own avatar, fitted to
their UIKA head's renders (uika_views.py), with the frozen body rendered too so the neck seam is fitted in context.

Steps (plain parts in lucid_avatars/head_distill_core.py, tested):
  1. Gate: head_swap's consent rules (CONSENTED, their own avatar, their own photos and teacher, a new `<person>-...`
     id that never replaces another bundle, nobody in dreams/.held), before anything is read.
  2. Align: UIKA's FLAME mesh (flame.npy) to the avatar's rest-pose SMPL-X head through SMPL-X's FLAME vertex ids
     (head_swap.umeyama; refused over 3 cm RMS); every teacher camera carried into the avatar's frame.
  3. Cut: the body's head above the jaw-line seam, exactly as the head swap's cross-fade.
  4. Seed: ~100K points on the SMPL-X faces whose vertices are head, jaw or eye dominant above the seam's band,
     small isotropic Gaussians, coloured from the teacher's views.
  5. Fit (gsplat): L1 + 0.2 D-SSIM on RGB inside the teacher's alpha, an alpha loss so silhouettes match, a small
     pull keeping each Gaussian within a few mm-cm of its surface point (hard cap MAX_OFFSET_M), opacity
     floor + (1 - floor) sigmoid(raw) so every kept one stays at least half opaque, pruning the ones that want to
     vanish, no densification. The loss looks only where the teacher sees the head (not its neck under the seam, not
     the body's shoulders), every 8th teacher view held out.
  6. Bundle `dreams/<avatar>-head...`: head last in avatar.ply, skinned from its SMPL-X face (barycentric, top 4),
     reality.ply, head_distill.json (held-out PSNR/SSIM before and after, alignment, counts, opacity), compare.png
     (photo | old face | teacher | distilled, front and 3/4), preview.mp4 + thumb.jpg, identity (ArcFace) in
     metrics.identity. hpg/head-distill.sbatch then runs any_face (blinks, living idle) and validates.

4DAnyone env (gsplat, lucid.*), this folder on PYTHONPATH:
  python head_distill.py --person vishal --avatar dreams/vishal --teacher heads/vishal/uika --photos faces/vishal \
    --smplx SMPLX_NEUTRAL.npz --flame-ids SMPL-X__FLAME_vertex_ids.npy [--id vishal-head]
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

from lucid_avatars import head_distill_core as D
from lucid_avatars import head_swap as H
from lucid_avatars.bundle import validate_bundle
from lucid_avatars.gaussian_ply import SH_C0, Gaussians, read_ply
from lucid_avatars.motion import Motion
from lucid_avatars.realism import cosine, embed_faces, identity_report
from lucid_avatars.skinning import SKELETON_FILE, SKIN_FILE, read_skin_bin

STEPS = 5000
SSIM_WEIGHT = 0.2
ALPHA_WEIGHT = 0.5
OFFSET_FREE_M = 0.01  # a Gaussian moves this far from its surface point for free (UIKA's head isn't SMPL-X's)
OFFSET_WEIGHT = 0.1
MAX_OFFSET_M = 0.04  # hard cap: hair can stand off the scalp, but nothing drifts off the head (it stays skinnable)
LOG_SCALE_RANGE = (math.log(2e-4), math.log(0.02))
PRUNE_EVERY = 500
INIT_ALPHA = 0.9
LR = {"offset": 5e-5, "log_scale": 5e-3, "quat": 1e-3, "raw": 5e-2, "rgb": 1e-2}
OFFSET_LR_END = 0.1  # the offsets' learning rate decays to this share by the end
FLAME_SPLAT_M = 0.005  # UIKA's FLAME vertices as splats, to find where the teacher's surface is below the seam
FACE_PX = 512


def render_k(g, K: np.ndarray, w2c: np.ndarray, size: tuple[int, int], device: str) -> np.ndarray:
    """lucid.gaussians.Gaussians drawn by gsplat through a given pinhole camera, over black, (H, W, 3) uint8: the
    same call as lucid.export.render, with the teacher's intrinsics instead of its fixed field of view."""
    import torch
    from gsplat import rasterization

    t = lambda x: torch.as_tensor(np.ascontiguousarray(x), dtype=torch.float32, device=device)  # noqa: E731
    w, h = size
    rgb, alpha, _ = rasterization(
        means=t(g.means), quats=t(g.quats), scales=torch.exp(t(g.scales)), opacities=torch.sigmoid(t(g.opacities)),
        colors=t(np.concatenate([g.sh0, g.shN], 1)), viewmats=t(w2c)[None], Ks=t(K)[None], width=w, height=h,
        sh_degree=g.sh_degree, rasterize_mode="antialiased")
    return (rgb[0].clamp(0, 1) * 255).round().byte().cpu().numpy()


def gate(a) -> list[str]:
    errors = D.distill_consent_errors(a.person, a.avatar, a.teacher, a.held, a.id)
    errors += D.teacher_consent_errors(a.person, a.photos, a.teacher, None)  # their own photos, for compare.png
    return list(dict.fromkeys(errors))


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--person", required=True, help="whose face; must be in head_swap.CONSENTED")
    p.add_argument("--avatar", type=Path, required=True, help="their own avatar bundle, dreams/<person>[-...]")
    p.add_argument("--teacher", type=Path, required=True, help="their UIKA teacher, data/avatars/heads/<person>/uika")
    p.add_argument("--photos", type=Path, required=True, help="their photos, data/avatars/faces/<person> (compare.png)")
    p.add_argument("--smplx", type=Path, required=True, help="SMPLX_NEUTRAL.npz (the model the avatar was built with)")
    p.add_argument("--flame-ids", type=Path, required=True, help="SMPL-X__FLAME_vertex_ids.npy")
    p.add_argument("--id", help="new bundle id (default <avatar>-head; never another bundle)")
    p.add_argument("--held", type=Path, help="another dreams/.held to honour too (the one next to the bundle counts)")
    p.add_argument("--steps", type=int, default=STEPS)
    p.add_argument("--n", type=int, default=D.N_HEAD, help="new Gaussians seeded on the head before pruning")
    p.add_argument("--seam-offset", type=float, default=0.0, help="move the jaw-line seam up (+) or down, metres")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--insightface-root", type=Path, default=Path.home() / ".insightface")
    p.add_argument("--preview-size", default="1080x1920")
    p.add_argument("--seconds", type=float, default=4.0)
    p.add_argument("--device", default="cuda")
    a = p.parse_args()
    a.id = a.id or f"{a.avatar.name}-head"

    refused = gate(a)
    if refused:
        print("REFUSED", *refused, sep="\n     ")
        return 2

    import torch
    from gsplat import rasterization
    from lucid.losses import ssim
    from PIL import Image

    import head_swap_render as HSR

    t0 = time.time()
    dev = a.device
    rng = np.random.default_rng(a.seed)
    torch.manual_seed(a.seed)

    # ---- the avatar, its SMPL-X head, the teacher, the alignment
    src = a.avatar
    dream = json.loads((src / "dream.json").read_text())
    av = dream["avatar"]
    body = read_ply(src / av["file"])
    idx, q = read_skin_bin(src / av.get("skin", SKIN_FILE))
    rest = np.asarray(json.loads((src / av.get("skeleton", SKELETON_FILE)).read_text())["rest"], dtype=np.float64)
    joints, verts, lbs = H._smplx_rest(a.smplx, Motion.load(src / av["motion"]).betas)
    err = float(np.abs(joints - rest).max())
    if err > H.MAX_SKELETON_ERR_M:
        print(f"FAILED skeleton.json is {err * 1000:.1f} mm from this SMPL-X with the bundle's betas")
        return 1
    faces = np.asarray(np.load(a.smplx, allow_pickle=True)["f"], dtype=np.int64)
    ids = np.load(a.flame_ids).astype(np.int64).reshape(-1)
    header, views = D.read_cameras(a.teacher / D.VIEWS_DIR / D.CAMERAS_FILE)
    flame_u = np.load(a.teacher / D.FLAME_FILE).astype(np.float64)
    if len(ids) != len(flame_u):
        print(f"FAILED {len(ids)} FLAME ids for UIKA's {len(flame_u)}-vertex mesh")
        return 1
    s, R, t = H.umeyama(flame_u, verts[ids])
    rms = float(np.sqrt((((s * flame_u @ R.T + t) - verts[ids]) ** 2).sum(1).mean()))
    print(f"[align] UIKA's FLAME -> SMPL-X head: scale {s:.4f}, RMS {rms * 1000:.1f} mm")
    if rms > H.MAX_ALIGN_RMS_M:
        print(f"FAILED the fit is {rms * 100:.1f} cm RMS (over {H.MAX_ALIGN_RMS_M * 100:.0f} cm): wrong ids or mesh?")
        return 1
    W, Ht = int(header["width"]), int(header["height"])
    Ks = [v["K"] for v in views]
    w2cs = [D.camera_to_avatar(v["w2c"], s, R, t) for v in views]
    train, held = D.split_views(len(views))

    # ---- cut the body, seed the head
    seam_y = D.seam_height(rest, a.seam_offset)
    seam_lo = seam_y - H.BAND_M
    body_k, keep_b, body_above = D.cut_body(body, idx, q, seam_y)
    fids = D.head_faces(faces, verts, lbs, seam_lo)
    fid, bary, anchor, normal = D.sample_surface(verts, faces, fids, a.n, seed=a.seed)
    inside = anchor[:, 1] > seam_lo + 1e-4
    fid, bary, anchor, normal = fid[inside], bary[inside], anchor[inside], normal[inside]
    fade = D.seam_fade(anchor[:, 1], seam_y)
    log_s0 = D.initial_log_scale(verts, faces, fids, a.n)
    print(f"[seed] {len(anchor)} Gaussians on {len(fids)} SMPL-X head faces, size {math.exp(log_s0) * 1000:.2f} mm; "
          f"body kept {int(keep_b.sum())}, dropped {int((~keep_b).sum())}; seam y {seam_y:.3f}")

    def load_rgba(v) -> np.ndarray:
        img = np.asarray(Image.open(v["path"]).convert("RGBA"))
        if img.shape[:2] != (Ht, W):
            raise SystemExit(f"{v['path']} is {img.shape[1]}x{img.shape[0]}, cameras.json says {W}x{Ht}")
        return img

    rgba_u8 = [load_rgba(v) for v in views]
    rgb0, n_seen = D.project_colours(anchor, normal, ((Ks[i], w2cs[i], rgba_u8[i] / 255.0) for i in train))
    print(f"[seed] colour from the teacher: {float((n_seen > 0).mean()):.3f} of the Gaussians seen by a view")

    T = lambda x: torch.as_tensor(np.ascontiguousarray(x), dtype=torch.float32, device=dev)  # noqa: E731
    teach = torch.as_tensor(np.stack(rgba_u8), device=dev)  # (V, H, W, 4) uint8
    Kt, Vt = T(np.stack(Ks)), T(np.stack(w2cs))

    # ---- the frozen body (its own colours, view-independent for the fit) and the masks
    b_means, b_quats = T(body_k.xyz), T(body_k.rotation)
    b_scales, b_opac = torch.exp(T(body_k.scale)), torch.sigmoid(T(body_k.opacity))
    b_rgb = T(np.clip(0.5 + SH_C0 * body_k.f_dc, 0, 1))

    def raster(means, quats, scales, opac, colors, i, mode="RGB"):
        rgb, alpha, _ = rasterization(means=means, quats=quats, scales=scales, opacities=opac, colors=colors,
                                      viewmats=Vt[i:i + 1], Ks=Kt[i:i + 1], width=W, height=Ht, render_mode=mode)
        return rgb[0], alpha[0, ..., 0]

    flame_a = s * flame_u @ R.T + t
    f_means, f_quats = T(flame_a), T(np.tile([1.0, 0, 0, 0], (len(flame_a), 1)))
    f_scales, f_opac = torch.full((len(flame_a), 3), FLAME_SPLAT_M, device=dev), torch.full((len(flame_a),), 0.95,
                                                                                            device=dev)
    weight, boxes = [], []
    with torch.no_grad():
        for i in range(len(views)):
            # height (premultiplied, so / alpha) and expected depth of the teacher's FLAME surface and the body
            c, a_ref = raster(f_means, f_quats, f_scales, f_opac, f_means[:, 1:2], i, "RGB+ED")
            y_ref, d_ref = (c[..., 0] / a_ref.clamp_min(1e-6)).cpu().numpy(), c[..., 1].cpu().numpy()
            c, a_body = raster(b_means, b_quats, b_scales, b_opac, b_means[:, 1:2], i, "RGB+ED")
            y_body, d_body = (c[..., 0] / a_body.clamp_min(1e-6)).cpu().numpy(), c[..., 1].cpu().numpy()
            w = D.loss_weight(y_ref, a_ref.cpu().numpy(), y_body, a_body.cpu().numpy(), seam_lo, d_ref=d_ref,
                              d_body=d_body)
            box = D.mask_box((w > 0) & (rgba_u8[i][..., 3] > 5), pad=16) or (0, Ht, 0, W)
            weight.append(torch.as_tensor(w, device=dev))
            boxes.append(box)
    del rgba_u8
    print(f"[mask] head pixels per view: median {int(np.median([float(w.sum()) for w in weight]))}")

    # ---- the student's parameters
    raw0 = D.raw_for_alpha(INIT_ALPHA)
    params = {"offset": torch.zeros(len(anchor), 3, device=dev),
              "log_scale": torch.full((len(anchor), 3), log_s0, device=dev),
              "quat": T(np.tile([1.0, 0, 0, 0], (len(anchor), 1))),
              "raw": torch.full((len(anchor),), raw0, device=dev),
              "rgb": torch.logit(T(np.clip(rgb0, 0.02, 0.98)))}
    params = {k: torch.nn.Parameter(v) for k, v in params.items()}
    fixed = {"anchor": T(anchor), "fade": T(fade)}
    opt = torch.optim.Adam([{"params": [params[k]], "lr": LR[k], "name": k} for k in LR], eps=1e-15)
    keep_np = np.ones(len(anchor), dtype=bool)  # which seeds are still alive (for fid/bary/normal at the end)

    def head_tensors():
        alpha = (D.OPACITY_FLOOR + (1 - D.OPACITY_FLOOR) * torch.sigmoid(params["raw"])) * fixed["fade"]
        return (fixed["anchor"] + params["offset"], params["quat"], torch.exp(params["log_scale"]), alpha,
                torch.sigmoid(params["rgb"]))

    def render_all(i, head=None):
        hm, hq, hs, ha, hc = head or head_tensors()
        return raster(torch.cat([b_means, hm]), torch.cat([b_quats, hq]), torch.cat([b_scales, hs]),
                      torch.cat([b_opac, ha]), torch.cat([b_rgb, hc]), i)

    def evaluate(ids_):
        out_p, out_s = [], []
        with torch.no_grad():
            for i in ids_:
                rgb, alpha = render_all(int(i))
                tv = teach[i].float() / 255
                gt = tv[..., :3] * tv[..., 3:]
                m = (weight[i] > 0) & ((tv[..., 3] > 0.5) | (alpha > 0.5))
                box = D.mask_box(m.cpu().numpy(), pad=4)
                if box is None:
                    continue
                y0, y1, x0, x1 = box
                mm = m[y0:y1, x0:x1, None].float()
                pc, gc = rgb[y0:y1, x0:x1] * mm, gt[y0:y1, x0:x1] * mm
                out_p.append(D.masked_psnr(pc.cpu().numpy(), gc.cpu().numpy(), mm[..., 0].cpu().numpy() > 0))
                out_s.append(float(ssim(pc[None].clamp(0, 1), gc[None])))
        return (round(float(np.mean(out_p)), 3) if out_p else None, round(float(np.mean(out_s)), 4) if out_s else None)

    before = evaluate(held)
    print(f"[fit] held-out before: PSNR {before[0]} dB, SSIM {before[1]} ({len(held)} views)")

    def prune(keep: torch.Tensor) -> None:
        for group in opt.param_groups:
            old = group["params"][0]
            new = torch.nn.Parameter(old.detach()[keep].clone())
            state = opt.state.pop(old, None)
            if state:
                state["exp_avg"], state["exp_avg_sq"] = state["exp_avg"][keep], state["exp_avg_sq"][keep]
                opt.state[new] = state
            group["params"][0] = new
            params[group["name"]] = new
        for k in fixed:
            fixed[k] = fixed[k][keep]

    order = rng.permutation(train)
    pruned = 0
    for step in range(a.steps):
        i = int(order[step % len(order)])
        if step % len(order) == len(order) - 1:
            order = rng.permutation(train)
        for group in opt.param_groups:
            if group["name"] == "offset":
                group["lr"] = LR["offset"] * OFFSET_LR_END ** (step / max(1, a.steps - 1))
        bg = torch.rand(3, device=dev)
        rgb, alpha = render_all(i)
        y0, y1, x0, x1 = boxes[i]
        tv = teach[i, y0:y1, x0:x1].float() / 255
        ta, w = tv[..., 3], weight[i][y0:y1, x0:x1]  # RGB losses: cropped to the head (speed)
        pred = rgb[y0:y1, x0:x1] + (1 - alpha[y0:y1, x0:x1, None]) * bg
        gt = tv[..., :3] * ta[..., None] + (1 - ta[..., None]) * bg
        m = (w * ta)[..., None]
        l1 = (m * (pred - gt).abs()).sum() / (3 * m.sum() + 1e-6)
        d_ssim = 1 - ssim((m * pred + (1 - m) * gt)[None], gt[None])  # outside the head: perfect agreement
        wf = weight[i]  # the whole frame: a Gaussian spilling past the teacher's silhouette is seen there
        l_alpha = (wf * (alpha - teach[i, ..., 3].float() / 255).abs()).sum() / (wf.sum() + 1e-6)
        off = params["offset"].norm(dim=1)
        l_off = ((off - OFFSET_FREE_M).clamp_min(0) / OFFSET_FREE_M).pow(2).mean()
        loss = l1 + SSIM_WEIGHT * d_ssim + ALPHA_WEIGHT * l_alpha + OFFSET_WEIGHT * l_off
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        with torch.no_grad():
            o = params["offset"]
            o.mul_((MAX_OFFSET_M / o.norm(dim=1, keepdim=True).clamp_min(MAX_OFFSET_M)))
            params["log_scale"].clamp_(*LOG_SCALE_RANGE)
        if step and step % PRUNE_EVERY == 0 and step <= 0.75 * a.steps:
            keep = torch.sigmoid(params["raw"].detach()) >= D.PRUNE_BELOW
            if not bool(keep.all()):
                alive = np.flatnonzero(keep_np)
                keep_np[alive[~keep.cpu().numpy()]] = False
                pruned += int((~keep).sum())
                prune(keep)
        if step % 500 == 0 or step == a.steps - 1:
            print(f"[fit] step {step}: loss {float(loss):.4f} (L1 {float(l1):.4f}, D-SSIM {float(d_ssim):.4f}, "
                  f"alpha {float(l_alpha):.4f}, offset {float(l_off):.4f}); {len(params['raw'])} Gaussians, "
                  f"{pruned} pruned")

    after = evaluate(held)
    train_fit = evaluate(train[:: max(1, len(train) // 8)])
    print(f"[fit] held-out after: PSNR {after[0]} dB, SSIM {after[1]}; train sample {train_fit[0]} dB")

    # ---- the head as Gaussians, skinned from its own SMPL-X face
    raw = params["raw"].detach().cpu().numpy().astype(np.float64)
    keep_end = D.keep_mask(raw)  # the last ones that want to vanish go too
    alive = np.flatnonzero(keep_np)[keep_end]
    pruned += int((~keep_end).sum())
    pick = lambda x: x.detach().cpu().numpy().astype(np.float64)[keep_end]  # noqa: E731
    offset, xyz = pick(params["offset"]), pick(params["offset"]) + anchor[alive]
    quat = pick(params["quat"])
    quat /= np.linalg.norm(quat, axis=1, keepdims=True)
    rgb_h = 1 / (1 + np.exp(-pick(params["rgb"])))
    raw, fade_h = raw[keep_end], fade[alive]
    head = Gaussians(xyz=xyz, f_dc=(rgb_h - 0.5) / SH_C0, f_rest=np.zeros((len(xyz), 0)),
                     opacity=D.ply_opacity(raw, fade_h), scale=pick(params["log_scale"]), rotation=quat)
    h_idx, h_q = D.face_skin(fid[alive], bary[alive], faces, lbs)
    seen_head = anchor[alive, 2] > verts[ids][:, 2].mean()  # a folder of mostly frontal photos: the front half
    off_mm = np.linalg.norm(offset, axis=1) * 1000
    report = {
        "alignScale": round(s, 6), "alignRmsM": round(rms, 6), "seamY": round(seam_y, 4), "bandM": H.BAND_M,
        "seamOffsetM": a.seam_offset, "bodyVisibleAboveSeam": body_above,
        "seeded": len(anchor), "pruned": pruned, "steps": a.steps,
        "heldOut": {"views": int(len(held)), "psnrBefore": before[0], "ssimBefore": before[1], "psnr": after[0],
                    "ssim": after[1], "how": "teacher RGB premultiplied over black vs the distilled avatar, on the "
                                            "head pixels the loss sees, cropped to them"},
        "trainSample": {"psnr": train_fit[0], "ssim": train_fit[1]},
        "opacity": D.opacity_stats(D.floor_alpha(raw) * fade_h, fade_h < 1),
        "offsetMm": {"median": round(float(np.median(off_mm)), 2), "p95": round(float(np.percentile(off_mm, 95)), 2),
                     "max": round(float(off_mm.max()), 2)},
        "teacherViews": {"count": len(views), "size": W, "uikaCommit": header.get("uikaCommit"),
                         "photos": len(header.get("photos") or [])},
        "loss": {"l1": 1.0, "dSsim": SSIM_WEIGHT, "alpha": ALPHA_WEIGHT, "offset": OFFSET_WEIGHT,
                 "offsetFreeM": OFFSET_FREE_M, "maxOffsetM": MAX_OFFSET_M, "opacityFloor": D.OPACITY_FLOOR},
        "identity": None, "seconds": None}
    out = D.write_distilled_bundle(src, src.parent, a.id, body_k, keep_b, idx, q, head, h_idx, h_q, seen_head, report)
    print(f"[bundle] {out}: {len(head)} head Gaussians after {int(keep_b.sum())} body ones")

    # ---- what a person looks at: compare.png, the turntable, identity
    old_g = HSR.load(src)[1]
    new_g = HSR.load(out)[1]
    pick_view = lambda yaw: min(range(len(views)), key=lambda i: (abs(views[i]["yawDeg"] - yaw)  # noqa: E731
                                                                   + abs(views[i]["elevDeg"])))
    photo_paths = D.photo_paths(a.photos)
    photo = HSR.square(Image.open(photo_paths[0]), FACE_PX) if photo_paths else np.zeros((FACE_PX, FACE_PX, 3),
                                                                                        np.uint8)
    rows, fronts = [], {}
    for label, yaw in (("front", 0), ("3/4", 45)):
        i = pick_view(yaw)
        tv = teach[i].float() / 255
        tiles = [render_k(old_g, Ks[i], w2cs[i], (W, Ht), dev), ((tv[..., :3] * tv[..., 3:]).clamp(0, 1) * 255)
                 .round().byte().cpu().numpy(), render_k(new_g, Ks[i], w2cs[i], (W, Ht), dev)]
        tiles = [np.asarray(Image.fromarray(x).resize((FACE_PX, FACE_PX), Image.LANCZOS)) for x in tiles]
        rows.append([photo, *tiles])
        if label == "front":
            fronts = {"old": tiles[0], "teacher": tiles[1], "new": tiles[2]}
    HSR.grid(rows, ["photo", f"old face ({dream['id']})", "teacher (UIKA)", "distilled"]).save(out / "compare.png")
    HSR.write_turntable(new_g, out, a.preview_size, a.seconds, dev)

    emb = embed_faces({"photo": photo, **fronts}, a.insightface_root) if photo_paths else None
    identity = identity_report(emb) if emb is not None else None
    if identity is not None and "teacher" in emb:
        identity["teacher"] = round(cosine(emb["photo"], emb["teacher"]), 4)
    print(f"[identity] {identity if identity else 'skipped (no InsightFace, or no face in the photo)'}")

    report = json.loads((out / D.DISTILL_FILE).read_text())
    report.update(identity=identity, seconds=round(time.time() - t0, 1))
    (out / D.DISTILL_FILE).write_text(json.dumps(report, indent=2) + "\n")
    dream = json.loads((out / "dream.json").read_text())
    dream.update(preview="preview.mp4", thumb="thumb.jpg")
    dream["metrics"] = {**dream.get("metrics", {}), "identity": identity["new"] if identity else None,
                        "lpipsFace": None, "sharpness": None}
    (out / "dream.json").write_text(json.dumps(dream, indent=2) + "\n")
    print(json.dumps({k: report[k] for k in ("alignRmsM", "heldOut", "opacity", "offsetMm", "identity")}, indent=1))

    problems = validate_bundle(out)
    for problem in problems:
        print(f"[bundle] {problem}")
    print(f"{'BUNDLE_FAIL' if problems else 'BUNDLE_OK'} {out}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
