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
"""

from __future__ import annotations

import argparse
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
from lucid_avatars import finetune_io as F  # noqa: E402
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
    p.add_argument("--seed", type=int, default=0)
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
        self.rgb = {}
        for f in self.frames:
            rgb, _ = F.on_white(pf.rgba(f))
            self.rgb[f] = torch.as_tensor(rgb, dtype=torch.float16, device=dev)  # fp16 keeps 48 views x 8 frames small
        self.views = self.cameras.shape[0]


def render_views(model, code, smpl_row, cameras):
    """DiGS render of one SMPL-X frame from several cameras: (V, H, W, 3)."""
    out = model.idol_decoder(code, smpl_row[None].to(code.dtype), cameras[None], cameras.shape[0], return_loss=False)
    return out["image"][0].float().clamp(0, 1)


def evaluate(model, code, smpl, views: Views, held: list[int], lpips_fn) -> tuple[dict, dict]:
    """Mean PSNR / SSIM / LPIPS over every prepared frame x held-out view, and the renders of the first frame."""
    from lucid.losses import psnr, ssim

    scores = {"psnr": [], "ssim": [], "lpips": []}
    first = {}
    with torch.no_grad():
        for f in views.frames:
            pred = render_views(model, code, smpl[f], views.cameras[held])
            gt = views.rgb[f][held].float()
            for p, g in zip(pred, gt, strict=True):
                scores["psnr"].append(float(psnr(p[None], g[None])))
                scores["ssim"].append(float(ssim(p[None], g[None])))
                to_lpips = lambda x: x.permute(2, 0, 1)[None] * 2 - 1  # noqa: E731  (lpips wants NCHW in -1..1)
                scores["lpips"].append(float(lpips_fn(to_lpips(p), to_lpips(g))))
            if not first:
                first = {"pred": pred.cpu(), "gt": gt.cpu()}
    return {k: round(float(np.mean(v)), 4) for k, v in scores.items()}, first


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
    from omegaconf import OmegaConf

    start = torch.load(args.start, map_location="cpu", weights_only=False)
    hand_mean = np.asarray(start["hand_mean"], dtype=np.float64).reshape(90)
    motion = Motion.load(args.motion)
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
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, args.steps, eta_min=args.lr / 20)

    before, before_imgs = evaluate(model, code0, smpl, views, held, lpips_fn)
    print("before:", before)
    t0 = time.time()
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

    code = torch.tanh(raw).detach()
    model.eval()
    after, after_imgs = evaluate(model, code, smpl, views, held, lpips_fn)
    print("after:", after)
    setup = {"heldOutViews": held, "trainViews": len(train), "frames": views.frames, "steps": args.steps,
             "lr": args.lr, "tuneDecoder": args.tune_decoder, "resolution": [views.width, views.height],
             "note": "metrics on full frames composited on white, every prepared frame x held-out view"}
    F.write_results(work / "results.json", before, after, setup)
    (work / "results.md").write_text(F.results_markdown(before, after) + "\n")
    print(F.results_markdown(before, after))

    # compare.png: held-out views of the first frame, rows = 4DAnyone view, one photo, fine-tuned.
    from PIL import Image

    rows = [torch.cat(list(x), dim=1) for x in (before_imgs["gt"], before_imgs["pred"], after_imgs["pred"])]
    Image.fromarray((torch.cat(rows, dim=0).numpy() * 255).astype(np.uint8)).save(work / "compare.png")
    torch.save({"code": code.cpu(), "betas": motion.betas, "hand_mean": hand_mean}, work / "code.pt")

    # The tuned avatar as a bundle, playing the clip it was tuned on, facing the viewer with its soles on the floor.
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
