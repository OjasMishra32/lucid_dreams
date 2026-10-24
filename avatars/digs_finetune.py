"""Fine-tune a one-photo DiGS avatar on 4DAnyone's generated views, and measure it on held-out views. Run from the
DiGS-Avatar repo directory, in the DiGS env, on a GPU.

    python /path/to/avatars/digs_finetune.py --views <prepared views> --motion <motion_world.json> \
        --start <out>/<id>.work/code.pt --out <dreams dir> --id <id>-tuned --name "<name>"

--views: cameras.json + frames/NNNNNN/VV.png (RGBA, the person cut out), the layout prep_views.py writes from a
4DAnyone result. --motion: our motion.json for the same clip, in 4DAnyone's world (gvhmr_motion.py --world), one
motion frame per video frame. --start: code.pt from digs_avatar.py (DiGS's decoder code for the photo).

What is tuned: DiGS's decoder code, the UV feature map every Gaussian (colour, offset, scale, opacity) is decoded
from, in its pre-tanh space; the decoder and the body model stay frozen (--tune-decoder also nudges the decoder).
Loss: L1 + 0.2 (1 - SSIM) on the training views composited on white, as DiGS renders. Four views spread round the
ring are never trained on; PSNR / SSIM / LPIPS on them, before and after, is the result (results.json, results.md,
compare.png). The tuned avatar is exported as a normal bundle with the clip's own motion.

Hands and face pass (--detail-steps N, off by default until it has run once on HiPerGator): then a short extra optimisation on 2x close-ups of the face and both
hands (lucid_avatars/detail.py: a camera turned onto each, the view resampled into it), so close-ups hold up. The
results table gains a column for it and face / hand crop rows, measured on the held-out views (compare_detail.png).
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(1, str(HERE.parent / "pipeline"))  # lucid.frames (PreparedFrames), lucid.losses (ssim, psnr)
import digs_avatar as A  # noqa: E402  (also puts the DiGS repo on sys.path)
from lucid_avatars import detail as Dt  # noqa: E402
from lucid_avatars import finetune_io as F  # noqa: E402
from lucid_avatars import skinning as S  # noqa: E402
from lucid_avatars.ik import world_joints  # noqa: E402
from lucid_avatars.motion import Motion, to_digs_params  # noqa: E402


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--views", required=True)
    p.add_argument("--motion", required=True, help="motion.json in 4DAnyone's world, one frame per video frame")
    p.add_argument("--start", required=True, help="code.pt from digs_avatar.py")
    p.add_argument("--out", required=True)
    p.add_argument("--id", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--ckpt", default="checkpoints/student.ckpt")
    p.add_argument("--config", default="configs/student_inpaint.yaml")
    p.add_argument("--held-out", type=int, default=4)
    p.add_argument("--steps", type=int, default=800)
    p.add_argument("--views-per-step", type=int, default=4)
    p.add_argument("--lr", type=float, default=0.02)
    p.add_argument("--tune-decoder", action="store_true", help="also train the decoder, at lr / 1000")
    p.add_argument("--detail-steps", type=int, default=0, help="hands and face pass after the fine-tune (try 300)")
    p.add_argument("--detail-lr", type=float, default=0.01)
    p.add_argument("--detail-scale", type=float, default=2.0, help="crop focal length / the view's")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--export-only", action="store_true",
                   help="no training: re-export the bundle from <id>.work/code.pt and results.json of an earlier run")
    return p.parse_args()


class Views:
    """The prepared views on the GPU: per frame, RGB on white (V, H, W, 3) and the matching DiGS cameras."""

    def __init__(self, root: str, dev: torch.device):
        from lucid.frames import PreparedFrames

        pf = PreparedFrames(Path(root))
        self.frames = pf.frame_ids
        self.width, self.height = pf.rig.width, pf.rig.height
        self.cameras = torch.as_tensor(F.digs_cameras(pf.rig.K, pf.rig.camera_to_world, self.width, self.height),
                                       device=dev)
        self.K, self.c2w = np.asarray(pf.rig.K, dtype=np.float64), np.asarray(pf.rig.camera_to_world, dtype=np.float64)
        self.rgb, self.boxes = {}, {}
        for f in self.frames:
            rgba = pf.rgba(f)
            rgb, _ = F.on_white(rgba)
            self.rgb[f] = torch.as_tensor(rgb, dtype=torch.float16, device=dev)  # fp16 keeps 48 views x 8 frames small
            self.boxes[f] = [A.D.alpha_bbox(a) if (a > 32).any() else None for a in rgba[..., 3]]
        self.views = self.cameras.shape[0]


def render_views(model, code, smpl_row, cameras):
    """DiGS render of one SMPL-X frame from several cameras: (V, H, W, 3)."""
    out = model.idol_decoder(code, smpl_row[None].to(code.dtype), cameras[None], cameras.shape[0], return_loss=False)
    return out["image"][0].float().clamp(0, 1)


def evaluate(model, code, smpl, views: Views, held: list[int], lpips_fn) -> tuple[dict, dict]:
    """Mean PSNR / SSIM / LPIPS over every prepared frame x held-out view, on the full frame and on the person's box
    in the 4DAnyone view (the full frame is mostly white on both sides), and the renders of the first frame."""
    from lucid.losses import psnr, ssim

    scores = {k: [] for k in ("psnr", "ssim", "lpips", "psnrPerson", "ssimPerson", "lpipsPerson")}
    to_lpips = lambda x: x.permute(2, 0, 1)[None] * 2 - 1  # noqa: E731  (lpips wants NCHW in -1..1)
    first = {}
    with torch.no_grad():
        for f in views.frames:
            pred = render_views(model, code, smpl[f], views.cameras[held])
            gt = views.rgb[f][held].float()
            for p, g, box in zip(pred, gt, [views.boxes[f][v] for v in held], strict=True):
                for suffix, (pp, gg) in (("", (p, g)), ("Person", _crop(p, g, box))):
                    if pp is None:
                        continue
                    scores["psnr" + suffix].append(float(psnr(pp[None], gg[None])))
                    scores["ssim" + suffix].append(float(ssim(pp[None], gg[None])))
                    scores["lpips" + suffix].append(float(lpips_fn(to_lpips(pp), to_lpips(gg))))
            if not first:
                first = {"pred": pred.cpu(), "gt": gt.cpu()}
    return {k: round(float(np.mean(v)), 4) for k, v in scores.items() if v}, first


def _crop(p, g, box, pad: int = 16):
    """Both images cut to the person's box (padded); (None, None) when the view has no person in it."""
    if box is None:
        return None, None
    x0, y0, x1, y1 = box
    h, w = g.shape[:2]
    x0, y0, x1, y1 = max(0, x0 - pad), max(0, y0 - pad), min(w, x1 + pad), min(h, y1 + pad)
    return p[y0:y1, x0:x1], g[y0:y1, x0:x1]


def frame_joints(model, motion, frames) -> dict:
    """Posed SMPL-X joints (55, 3) per frame in 4DAnyone's world, on DiGS's own body for the clip's betas."""
    bm = model.idol_decoder.deformer.body_model
    as_np = lambda t: t.detach().float().cpu().numpy()  # noqa: E731
    rest, _ = S.rest_joints(as_np(bm.v_template), as_np(bm.shapedirs), as_np(bm.J_regressor), motion.betas)
    return {f: world_joints(rest, motion.root_q[f], motion.root_t[f], motion.pose[f])[0] for f in frames}


def crops(views: Views, joints, f: int, v: int, scale: float) -> list:
    """[(region, DiGS camera (1, 20), size, grid (1, S, S, 2))] for the face and hands seen in view v of frame f."""
    out = []
    for region, (centre, radius) in Dt.detail_regions(joints[f]).items():
        cam = Dt.crop_camera(views.K[v], views.c2w[v], centre, radius, views.width, views.height, scale)
        if cam is None:
            continue
        Kc, c2w, size = cam
        grid = Dt.sample_grid(Dt.crop_homography(views.K[v], views.c2w[v], Kc, c2w), size, views.width, views.height)
        out.append((region, torch.as_tensor(F.digs_cameras(Kc[None], c2w[None], size, size), device=views.rgb[f].device),
                    size, torch.as_tensor(grid, device=views.rgb[f].device)[None]))
    return out


def render_crop(model, code, smpl_row, camera, size: int, full_size):
    """DiGS render (1, S, S, 3) from one crop camera; the renderer's size is put back after."""
    model.idol_decoder.renderer.image_size = [size, size]
    try:
        return render_views(model, code, smpl_row, camera)
    finally:
        model.idol_decoder.renderer.image_size = full_size


def view_in_crop(rgb_hw3, grid, pred):
    """The view (H, W, 3, on white) resampled into a crop: (1, S, S, 3). Crop pixels past the view's edge (corners;
    crop_camera keeps the face or hand itself inside) take the render's own value, so they add no loss."""
    x = rgb_hw3.float().permute(2, 0, 1)[None]
    gt = torch.nn.functional.grid_sample(x, grid, mode="bilinear", align_corners=False).permute(0, 2, 3, 1)
    inside = (grid.abs() <= 1).all(dim=-1, keepdim=True)
    return torch.where(inside, gt, pred.detach())


def evaluate_detail(model, code, smpl, views: Views, held, joints, scale: float, lpips_fn) -> tuple[dict, list]:
    """PSNR / LPIPS on the 2x face and hand crops of every prepared frame x held-out view, and the first frame's face
    crops [(pred, gt)] for compare_detail.png."""
    from lucid.losses import psnr

    full = list(model.idol_decoder.renderer.image_size)
    scores = {k: [] for k in ("psnrFace", "lpipsFace", "psnrHands", "lpipsHands")}
    to_lpips = lambda x: x.permute(0, 3, 1, 2) * 2 - 1  # noqa: E731
    faces = []
    with torch.no_grad():
        for f in views.frames:
            for v in held:
                for region, cam, size, grid in crops(views, joints, f, v, scale):
                    pred = render_crop(model, code, smpl[f], cam, size, full)
                    gt = view_in_crop(views.rgb[f][v], grid, pred)
                    key = "Face" if region == "face" else "Hands"
                    scores["psnr" + key].append(float(psnr(pred, gt)))
                    scores["lpips" + key].append(float(lpips_fn(to_lpips(pred), to_lpips(gt))))
                    if f == views.frames[0] and region == "face":
                        faces.append((pred[0].cpu(), gt[0].cpu()))
    return {k: round(float(np.mean(v)), 4) for k, v in scores.items() if v}, faces


def detail_pass(model, raw, smpl, views: Views, train, joints, args) -> None:
    """The hands and face pass: --detail-steps of L1 + 0.2 (1 - SSIM) on the face and hand crops of a random
    training view, tuning the decoder code only (everything else frozen)."""
    from lucid.losses import ssim

    for p in model.parameters():
        p.requires_grad_(False)
    full = list(model.idol_decoder.renderer.image_size)
    opt = torch.optim.Adam([raw], lr=args.detail_lr)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: F.cosine_factor(s, args.detail_steps))
    t0 = time.time()
    for step in range(1, args.detail_steps + 1):
        f, v = random.choice(views.frames), random.choice(train)
        todo = crops(views, joints, f, v, args.detail_scale)
        if not todo:
            continue
        loss = 0.0
        for _, cam, size, grid in todo:
            pred = render_crop(model, torch.tanh(raw), smpl[f], cam, size, full)
            gt = view_in_crop(views.rgb[f][v], grid, pred)
            loss = loss + (pred - gt).abs().mean() + 0.2 * (1 - ssim(pred, gt))
        loss = loss / len(todo)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        sched.step()
        if step % 50 == 0 or step == 1:
            print(f"detail {step:>4}  loss {loss.item():.4f}  {len(todo)} crops  {time.time() - t0:.0f}s", flush=True)


def main() -> int:
    args = parse_args()
    torch.manual_seed(args.seed)
    random.seed(args.seed)
    if not torch.cuda.is_available():
        raise SystemExit("DiGS needs a CUDA GPU")
    dev = torch.device("cuda")
    out = Path(args.out).resolve()
    work = out / f"{args.id}.work"
    work.mkdir(parents=True, exist_ok=True)

    import lpips
    from lucid.losses import ssim

    start = torch.load(args.start, map_location="cpu", weights_only=False)
    hand_mean = np.asarray(start["hand_mean"], dtype=np.float64).reshape(90)
    motion = A.D.with_hand_mean(Motion.load(args.motion), hand_mean)  # GVHMR's SMPL-X shows the hand mean
    views = Views(args.views, dev)
    if max(views.frames) >= motion.num_frames:
        raise SystemExit(f"views go to frame {max(views.frames)} but the motion has {motion.num_frames} frames")
    train, held = F.split_views(views.views, args.held_out)
    print(f"{len(views.frames)} frames x {views.views} views ({views.width}x{views.height}); held out {held}")

    model, config, demo = A.load_digs(args.config, args.ckpt)
    model = model.to(dev).eval()
    for p in model.parameters():
        p.requires_grad_(False)
    model.idol_decoder.renderer.image_size = [views.width, views.height]
    if args.export_only:
        saved = torch.load(work / "code.pt", map_location="cpu", weights_only=False)
        if "idol_decoder" in saved:
            model.idol_decoder.load_state_dict(saved["idol_decoder"])
        after = json.loads((work / "results.json").read_text())["after"]
        print(f"export only: {work / 'code.pt'}, held-out scores from results.json")
        return export(args, model, config, demo, saved["code"].to(dev), motion, hand_mean, views, after, out, work, dev)
    # The clip's motion with the clip's body: GVHMR's betas pose the body where 4DAnyone's views see it.
    smpl = torch.as_tensor(to_digs_params(motion, hand_mean), dtype=torch.float32, device=dev)
    lpips_fn = lpips.LPIPS(net="vgg").to(dev).eval()

    code0 = start["code"].to(dev)
    raw = torch.atanh(code0.clamp(-0.999, 0.999)).clone().requires_grad_(True)
    groups = [{"params": [raw], "lr": args.lr}]
    if args.tune_decoder:
        decoder_params = [p for p in model.idol_decoder.parameters() if p.is_floating_point()]
        for p in decoder_params:
            p.requires_grad_(True)
        groups.append({"params": decoder_params, "lr": args.lr / 1000})
    opt = torch.optim.Adam(groups)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: F.cosine_factor(s, args.steps))  # per-group base lr

    before, before_imgs = evaluate(model, code0, smpl, views, held, lpips_fn)
    joints, before_faces = None, []
    if args.detail_steps > 0:
        try:  # new and not yet run on HiPerGator: a failure here must not cost the fine-tune
            joints = frame_joints(model, motion, views.frames)
            before_detail, before_faces = evaluate_detail(model, code0, smpl, views, held, joints, args.detail_scale,
                                                          lpips_fn)
            before.update(before_detail)
        except Exception as e:  # noqa: BLE001
            print(f"hands and face pass skipped: {type(e).__name__}: {e}")
            args.detail_steps = 0
    print("before:", before)
    t0 = time.time()
    # DiGS's decoder renders a visibility pass and a big KNN whenever it isn't training. Flip only its own flag (not
    # .train(), which would put BatchNorm layers into training mode) for the optimisation loop.
    model.idol_decoder.training = True
    for step in range(1, args.steps + 1):
        f = random.choice(views.frames)
        vs = random.sample(train, min(args.views_per_step, len(train)))
        pred = render_views(model, torch.tanh(raw), smpl[f], views.cameras[vs])
        gt = views.rgb[f][vs].float()
        loss = (pred - gt).abs().mean() + 0.2 * (1 - ssim(pred, gt))
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        sched.step()
        if step % 50 == 0 or step == 1:
            print(f"step {step:>5}  loss {loss.item():.4f}  {time.time() - t0:.0f}s", flush=True)

    model.idol_decoder.training = False
    code = torch.tanh(raw).detach()
    after, after_imgs = evaluate(model, code, smpl, views, held, lpips_fn)
    after_faces, tuned_scores, tuned_faces = [], None, None
    if args.detail_steps > 0:
        saved = raw.detach().clone()
        try:
            after_detail, after_faces = evaluate_detail(model, code, smpl, views, held, joints, args.detail_scale,
                                                        lpips_fn)
            after.update(after_detail)
            print("after the fine-tune:", after)
            tuned_scores, tuned_faces, tuned_imgs = dict(after), after_faces, after_imgs
            model.idol_decoder.training = True
            detail_pass(model, raw, smpl, views, train, joints, args)
            model.idol_decoder.training = False
            detailed = torch.tanh(raw).detach()
            after, after_imgs = evaluate(model, detailed, smpl, views, held, lpips_fn)
            after_detail, after_faces = evaluate_detail(model, detailed, smpl, views, held, joints,
                                                        args.detail_scale, lpips_fn)
            after.update(after_detail)
            code = detailed
        except Exception as e:  # noqa: BLE001  (keep the fine-tune's code and numbers)
            print(f"hands and face pass failed, keeping the fine-tune alone: {type(e).__name__}: {e}")
            model.idol_decoder.training = False
            with torch.no_grad():
                raw.copy_(saved)
            if tuned_scores is not None:
                after, after_faces, after_imgs = tuned_scores, tuned_faces, tuned_imgs
            tuned_scores, tuned_faces = None, None
            args.detail_steps = 0
    print("after:", after)
    setup = {"heldOutViews": held, "trainViews": len(train), "frames": views.frames, "steps": args.steps,
             "lr": args.lr, "tuneDecoder": args.tune_decoder, "resolution": [views.width, views.height],
             "detailSteps": args.detail_steps, "detailLr": args.detail_lr, "detailScale": args.detail_scale,
             "note": "metrics on full frames composited on white, every prepared frame x held-out view; face and "
                     "hand rows on crops at detailScale x the view's focal length (the view resampled, so no new "
                     "pixels: they measure the close-up, not extra detail in the source)"}
    F.write_results(work / "results.json", before, after, setup, tuned=tuned_scores)
    (work / "results.md").write_text(F.results_markdown(before, after, tuned=tuned_scores) + "\n")
    print(F.results_markdown(before, after, tuned=tuned_scores))

    # compare.png: held-out views of the first frame, rows = 4DAnyone view, one photo, fine-tuned.
    from PIL import Image

    rows = [torch.cat(list(x), dim=1) for x in (before_imgs["gt"], before_imgs["pred"], after_imgs["pred"])]
    Image.fromarray((torch.cat(rows, dim=0).numpy() * 255).astype(np.uint8)).save(work / "compare.png")
    # compare_detail.png: the held-out views' face crops of the first frame at 256 px, rows = 4DAnyone view, one
    # photo, fine-tuned (, + hands and face pass).
    if after_faces:
        sq = lambda x: torch.nn.functional.interpolate(x.permute(2, 0, 1)[None], size=(256, 256), mode="bilinear",  # noqa: E731
                                                       align_corners=False)[0].permute(1, 2, 0)
        sets = [[g for _, g in after_faces], [p for p, _ in before_faces]]
        sets += [[p for p, _ in tuned_faces]] if tuned_faces else []
        sets += [[p for p, _ in after_faces]]
        n = min(len(x) for x in sets)
        if n:
            grid_img = torch.cat([torch.cat([sq(x) for x in row[:n]], dim=1) for row in sets], dim=0).clamp(0, 1)
            Image.fromarray((grid_img.numpy() * 255).astype(np.uint8)).save(work / "compare_detail.png")
    tuned = {"code": code.cpu(), "betas": motion.betas, "hand_mean": hand_mean}
    if args.tune_decoder:  # digs_perform.py loads it back, so a performance matches what was measured
        tuned["idol_decoder"] = {k: v.cpu() for k, v in model.idol_decoder.state_dict().items()}
    torch.save(tuned, work / "code.pt")
    return export(args, model, config, demo, code, motion, hand_mean, views, after, out, work, dev)


def export(args, model, config, demo, code, motion, hand_mean, views, after, out, work, dev) -> int:
    """The tuned avatar as a bundle, playing the clip it was tuned on, facing the viewer with its soles on the floor."""
    from omegaconf import OmegaConf

    from lucid_avatars.retarget import place_on_floor

    for p in model.parameters():
        p.requires_grad_(False)
    model.idol_decoder.renderer.image_size = [A.D.DIGS_W, A.D.DIGS_H]
    focal = float(OmegaConf.select(config, "model.params.projector_config.focal_length", default=1120.0))
    any_camera = demo._prepare_orbit_cameras(A.D.DIGS_H, A.D.DIGS_W, 1, dev, focal, 3.0)[0]
    source = {"views": str(args.views), "motion": str(args.motion), "start": str(args.start),
              "model": "DiGS-Avatar student, decoder code fine-tuned on 4DAnyone views", "note": A.HANDS_NOTE}
    metrics = {"psnr": after["psnr"], "ssim": after["ssim"], "lpips": after["lpips"], "views": views.views}
    with torch.no_grad():
        return A.export_bundle(model, demo, code, np.asarray(motion.betas), hand_mean, focal, any_camera, out,
                               args.id, args.name, source, work, metrics=metrics,
                               motion=lambda g, skin, sk, stand: place_on_floor(motion, g.xyz, g.opacity, *skin,
                                                                                np.asarray(sk["rest"])))


if __name__ == "__main__":
    sys.exit(main())
