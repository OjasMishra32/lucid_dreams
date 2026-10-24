"""Per-frame Gaussian reconstruction of a person from synchronized multi-view frames.

The first frame of a range trains from a visual-hull point cloud; every later frame starts from the frame before it
(warm start), so it converges in a fraction of the steps and the person doesn't flicker between frames. The Gaussian
count is capped (MCMC densification), which keeps every frame inside the headset's rendering budget.

    python -m lucid.recon --result <4DAnyone result dir> --start 0 --end 16 --out <dir>
    python -m lucid.recon --prepared <folder> --out <dir>          # synthetic tests / any rig
"""

from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from .gaussians import SH_C0, Gaussians, write_ply, write_spz
from .losses import psnr, ssim


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--result", type=Path, help="finished 4DAnyone output directory")
    src.add_argument("--prepared", type=Path, help="prepared RGBA frames + cameras.json")
    p.add_argument("--start", type=int, default=0)
    p.add_argument("--end", type=int, default=None, help="exclusive; default: all frames")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--iters-first", type=int, default=7000)
    p.add_argument("--iters-warm", type=int, default=1500)
    p.add_argument("--cap", type=int, default=300_000, help="max Gaussians per frame")
    p.add_argument("--sh-degree", type=int, default=1)
    p.add_argument("--batch", type=int, default=4, help="views rendered per step")
    p.add_argument("--perceptual", type=float, default=0.3, help="VGG-19 perceptual loss weight (0 = off)")
    p.add_argument("--holdout-every", type=int, default=0, help="hold out every Nth view for metrics (0 = none)")
    p.add_argument("--aniso", type=float, default=0.0,
                   help="weight on Gaussians stretched past --aniso-ratio: needles look right from the views they were "
                        "fitted to and smear everywhere else (0 = off)")
    p.add_argument("--aniso-ratio", type=float, default=6.0, help="longest / shortest axis allowed before it costs")
    p.add_argument("--peek", default="", help="comma-separated views: save ground truth | render pairs of the first frame")
    p.add_argument("--source-video", type=Path, default=None,
                   help="the clip 4DAnyone was given (prepped.mp4): its real frames join training as a solved camera")
    p.add_argument("--source-weight", type=float, default=1.5)
    p.add_argument("--source-every", type=int, default=2, help="render the real view every Nth step")
    p.add_argument("--source-iters", type=int, default=2000, help="extra steps on the first frame once it's solved")
    p.add_argument("--source-max-height", type=int, default=2560)
    p.add_argument("--source-masks", type=Path, default=None,
                   help="the person's own masks for the real frames (000123.png per clip frame, white = them) instead of "
                        "the foreground model: one player's mask when others share the frame")
    p.add_argument("--source-ignore", type=Path, default=None,
                   help="same naming, white = pixels left out of every real-view loss (another player)")
    p.add_argument("--source-agree", action="store_true",
                   help="per frame: re-align the real camera to the views' person and let the real frame count only "
                        "where the two agree (no ghost limbs where 4DAnyone's person and the real one differ)")
    p.add_argument("--source-refine-steps", type=int, default=60, help="pose steps per frame with --source-agree")
    p.add_argument("--source-focal", type=float, default=None,
                   help="the clip camera's known focal length in full-resolution pixels, held instead of solved")
    p.add_argument("--face-weight", type=float, default=0.0,
                   help="extra weight on a native-resolution crop of the real frame around the face (0 = off; try 2.0 once a clip's camera solves)")
    p.add_argument("--spz-sh", type=int, default=0, help="SH degree kept in the .spz copies")
    p.add_argument("--device", default="cuda:0")
    p.add_argument("--seed", type=int, default=0)
    return p.parse_args(argv)


# ---------------------------------------------------------------------------------------------------------------


def real_view_loss(pred: torch.Tensor, alpha: torch.Tensor, target: torch.Tensor, bg: torch.Tensor) -> torch.Tensor:
    """L1 + SSIM + silhouette against a real frame's crop (lucid.source_view): target is [1,h,w,4] rgb + mask, or
    [1,h,w,5] with a last channel 0 where pixels are ignored (another person). Ignored pixels take the truth's own
    value in the render, so they never pull on the Gaussians."""
    m = target[..., 3:4]
    gt = target[..., :3] * m + bg[:, None, None, :] * (1 - m)
    if target.shape[-1] > 4:
        v = target[..., 4:5]
        pred = pred * v + gt * (1 - v)
        alpha = alpha * v + m * (1 - v)
    return 0.8 * (pred - gt).abs().mean() + 0.2 * (1 - ssim(pred, gt)) + 0.1 * (alpha - m).abs().mean()


def knn_scale(points: torch.Tensor, k: int = 3, chunk: int = 1024) -> torch.Tensor:
    """Mean distance to the k nearest neighbours, for the initial Gaussian size."""
    out = []
    for i in range(0, points.shape[0], chunk):
        d = torch.cdist(points[i : i + chunk], points)
        d = d.topk(k + 1, largest=False).values[:, 1:]
        out.append(d.mean(-1))
    return torch.cat(out).clamp_min(1e-4)


def init_params(points: np.ndarray, rgb: np.ndarray, sh_degree: int, device: str, cap: int) -> torch.nn.ParameterDict:
    if len(points) > cap:  # start under the budget; MCMC grows it back to the cap where detail needs it
        pick = np.random.choice(len(points), cap, replace=False)
        points, rgb = points[pick], rgb[pick]
    pts = torch.as_tensor(points, dtype=torch.float32, device=device)
    col = torch.as_tensor(rgb, dtype=torch.float32, device=device).clamp(0, 1)
    n = pts.shape[0]
    scale = knn_scale(pts)
    params = {
        "means": pts,
        "scales": torch.log(scale)[:, None].repeat(1, 3),
        "quats": F.normalize(torch.randn(n, 4, device=device), dim=-1),
        "opacities": torch.logit(torch.full((n,), 0.5, device=device)),
        "sh0": ((col - 0.5) / SH_C0)[:, None, :],
        "shN": torch.zeros(n, (sh_degree + 1) ** 2 - 1, 3, device=device),
    }
    return torch.nn.ParameterDict({k: torch.nn.Parameter(v) for k, v in params.items()})


def clone_params(params: torch.nn.ParameterDict) -> torch.nn.ParameterDict:
    return torch.nn.ParameterDict({k: torch.nn.Parameter(v.detach().clone()) for k, v in params.items()})


BASE_LR = {"means": 1.6e-4, "scales": 5e-3, "quats": 1e-3, "opacities": 5e-2, "sh0": 2.5e-3, "shN": 2.5e-3 / 20}


def make_optimizers(params, scene_scale: float, lr_mult: float = 1.0):
    opts = {}
    for k, v in params.items():
        lr = BASE_LR[k] * (scene_scale if k == "means" else 1.0) * (lr_mult if k == "means" else 1.0)
        opts[k] = torch.optim.Adam([{"params": v, "lr": lr, "name": k}], eps=1e-15)
    return opts


class Trainer:
    def __init__(self, rig, args):
        from gsplat import rasterization

        self.rasterize = rasterization
        self.args = args
        self.device = args.device
        self.width, self.height = rig.width, rig.height
        self.viewmats = torch.as_tensor(rig.world_to_camera, dtype=torch.float32, device=self.device)
        self.Ks = torch.as_tensor(rig.K, dtype=torch.float32, device=self.device)
        centres = rig.camera_to_world[:, :3, 3]
        self.scene_scale = float(np.linalg.norm(centres - centres.mean(0), axis=1).max() * 0.5)
        views = np.arange(rig.views)
        if args.holdout_every > 0:
            self.test_views = views[:: args.holdout_every]
            self.train_views = np.setdiff1d(views, self.test_views)
        else:
            self.test_views = views[:0]
            self.train_views = views
        self.source = None  # lucid.source_view.SourceView, once solved
        self.perc = None
        if args.perceptual > 0:
            try:
                from fdanyone.download import ensure_perceptual_vgg19
                from fdanyone.nerfstudio.perceptual import VGG19PerceptualLoss

                self.perc = VGG19PerceptualLoss(ensure_perceptual_vgg19(), compute_dtype="bfloat16").to(self.device)
            except Exception as exc:  # perceptual loss is a quality boost, never a blocker
                print(f"[recon] perceptual loss off: {exc}")

    def render(self, params, views, sh_degree, backgrounds):
        colors = torch.cat([params["sh0"], params["shN"]], 1)
        rgb, alpha, info = self.rasterize(
            means=params["means"],
            quats=params["quats"],
            scales=torch.exp(params["scales"]),
            opacities=torch.sigmoid(params["opacities"]),
            colors=colors,
            viewmats=self.viewmats[views],
            Ks=self.Ks[views],
            width=self.width,
            height=self.height,
            sh_degree=sh_degree,
            backgrounds=backgrounds,
            packed=False,
            rasterize_mode="antialiased",
        )
        return rgb.clamp(0, 1), alpha, info

    def fit(self, params, rgba: torch.Tensor, iters: int, warm: bool, src: torch.Tensor | None = None, face=None):
        from gsplat.strategy import MCMCStrategy

        a = self.args
        strategy = MCMCStrategy(
            cap_max=a.cap,
            refine_start_iter=100 if warm else 500,
            refine_stop_iter=max(iters - 300, 101),
            refine_every=100,
            verbose=False,
        )
        optimizers = make_optimizers(params, self.scene_scale, lr_mult=0.3 if warm else 1.0)
        strategy.check_sanity(params, optimizers)
        state = strategy.initialize_state()
        lr0 = optimizers["means"].param_groups[0]["lr"]
        gamma = 0.01 ** (1.0 / max(iters, 1))
        max_degree = params["shN"].shape[1]
        max_degree = int(round(math.sqrt(max_degree + 1))) - 1
        n_train = len(self.train_views)
        for step in range(iters):
            views = torch.as_tensor(
                self.train_views[np.random.choice(n_train, min(a.batch, n_train), replace=False)], device=self.device
            )
            target = rgba[views].float() / 255.0  # [B,H,W,4]
            bg = torch.rand(len(views), 3, device=self.device)
            mask = target[..., 3:4]
            gt = target[..., :3] * mask + bg[:, None, None, :] * (1 - mask)
            degree = max_degree if warm else min(step // 1000, max_degree)
            pred, alpha, info = self.render(params, views, degree, bg)
            pre = getattr(strategy, "step_pre_backward", None)
            if pre is not None:
                pre(params, optimizers, state, step, info)
            loss = 0.8 * (pred - gt).abs().mean() + 0.2 * (1 - ssim(pred, gt))
            loss = loss + 0.1 * (alpha - mask).abs().mean()
            if self.perc is not None and step % 2 == 0:
                loss = loss + a.perceptual * self.perc(pred.permute(0, 3, 1, 2), gt.permute(0, 3, 1, 2))
            loss = loss + 0.01 * torch.sigmoid(params["opacities"]).mean() + 0.01 * torch.exp(params["scales"]).mean()
            if src is not None and step % a.source_every == 0:  # the real frame, at up to 4x the views' detail
                sbg = torch.rand(1, 3, device=self.device)
                spred, salpha, _ = self.source.render(self, params, degree, sbg)
                loss = loss + a.source_weight * real_view_loss(spred, salpha, src, sbg)
            if face is not None:  # the face at the clip's own 4K detail, every step: a small render
                ft, fK, (fw, fh) = face
                fbg = torch.rand(1, 3, device=self.device)
                fpred, falpha, _ = self.source._render(self, params, self.source.viewmat, fK, fw, fh, bg=fbg, degree=degree)
                loss = loss + a.face_weight * real_view_loss(fpred, falpha, ft, fbg)
            if a.aniso > 0:
                s = params["scales"]  # log scales, so max - min is the log of the axis ratio
                loss = loss + a.aniso * (s.max(-1).values - s.min(-1).values - math.log(a.aniso_ratio)).clamp_min(0).mean()
            loss.backward()
            for opt in optimizers.values():
                opt.step()
                opt.zero_grad(set_to_none=True)
            lr = lr0 * gamma**step
            optimizers["means"].param_groups[0]["lr"] = lr
            strategy.step_post_backward(params, optimizers, state, step, info, lr=lr)
        return params

    @torch.no_grad()
    def peek(self, params, rgba: torch.Tensor, views: list[int], path: Path) -> None:
        """Ground truth beside our render for each view, all in one strip: the check numbers can't make."""
        from PIL import Image

        degree = int(round(math.sqrt(params["shN"].shape[1] + 1))) - 1
        white = torch.ones(1, 3, device=self.device)
        pairs = []
        for v in views:
            vt = torch.as_tensor([v], device=self.device)
            target = rgba[vt].float() / 255.0
            gt = target[..., :3] * target[..., 3:4] + (1 - target[..., 3:4])
            pred, _, _ = self.render(params, vt, degree, white)
            pairs.append(torch.cat([gt[0], pred[0]], 1))
        strip = (torch.cat(pairs, 1).clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
        Image.fromarray(strip).save(path, quality=90)

    @torch.no_grad()
    def evaluate(self, params, rgba: torch.Tensor) -> dict:
        views = self.test_views if len(self.test_views) else self.train_views[:: max(1, len(self.train_views) // 6)]
        degree = int(round(math.sqrt(params["shN"].shape[1] + 1))) - 1
        scores = {"psnr": [], "ssim": []}
        for v in views:
            vt = torch.as_tensor([int(v)], device=self.device)
            target = rgba[vt].float() / 255.0
            mask = target[..., 3:4]
            bg = torch.ones(1, 3, device=self.device)
            gt = target[..., :3] * mask + (1 - mask)
            pred, _, _ = self.render(params, vt, degree, bg)
            scores["psnr"].append(float(psnr(pred, gt)))
            scores["ssim"].append(float(ssim(pred, gt)))
        return {k: float(np.mean(v)) for k, v in scores.items()} | {"heldOut": bool(len(self.test_views))}


def main(argv=None):
    args = parse_args(argv)
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    t0 = time.time()
    if args.result:
        from .frames import FourDAnyoneFrames, Rig

        rig = Rig.from_json(args.result / "cameras.json")
        end = args.end if args.end is not None else 121
        frames = FourDAnyoneFrames(args.result, args.start, end, device=args.device)
    else:
        from .frames import PreparedFrames

        frames = PreparedFrames(args.prepared)
        rig = frames.rig
        frames.frame_ids = [f for f in frames.frame_ids if f >= args.start and (args.end is None or f < args.end)]
    prep_s = time.time() - t0
    print(f"[recon] {len(frames.frame_ids)} frames x {rig.views} views at {rig.width}x{rig.height}, prep {prep_s:.0f}s")

    trainer = Trainer(rig, args)
    source = None

    def face_of(frame):
        if source is None or not source.ready or args.face_weight <= 0:
            return None
        try:
            return source.face(frame)
        except Exception as e:
            print(f"[source] face crop skipped for frame {frame}: {e}", flush=True)
            return None

    if args.source_video and args.result:
        from .source_view import SourceView

        source = SourceView(args.source_video, frames.frame_ids, args.device, args.source_max_height,
                            masks_dir=args.source_masks, ignore_dir=args.source_ignore, focal=args.source_focal)
        # every ring camera is a candidate: the clip's camera needn't be square to the subject (a 3/4 stance is common)
        front_ids = list(range(rig.views))
    out_frames = args.out / "frames"
    out_frames.mkdir(parents=True, exist_ok=True)
    report = {"start": frames.frame_ids[0], "end": frames.frame_ids[-1] + 1, "prepSeconds": prep_s, "frames": []}
    params = None
    for frame in frames.frame_ids:
        tf = time.time()
        rgba = torch.as_tensor(frames.rgba(frame), device=args.device)
        warm = params is not None
        if not warm:
            pts, rgb = frames.init_points(frame)
            params = init_params(pts, rgb, args.sh_degree, args.device, args.cap)
        else:
            params = clone_params(params)
        src = source.target(frame) if source is not None and source.ready else None
        face = face_of(frame)
        agree = {}
        if src is not None and warm and args.source_agree:
            # the views first, so the person takes this frame's pose; then the camera follows them, and the real frame
            # counts only where the views' person and the real one agree (no second, half-transparent limb)
            params = trainer.fit(params, rgba, args.iters_warm // 2, warm, None, None)
            agree["sourceIou"] = round(source.refine(trainer, params, frame, args.source_refine_steps), 4)
            src, share = source.agreeing(trainer, params, frame)
            agree["sourceAgree"] = round(share, 4)
            params = trainer.fit(params, rgba, args.iters_warm, True, src, face)
        else:
            params = trainer.fit(params, rgba, args.iters_warm if warm else args.iters_first, warm, src, face)
        if source is not None and not warm and source.solve(trainer, params, front_ids):
            trainer.source = source
            src = source.target(frame)
            if args.source_agree:
                src, share = source.agreeing(trainer, params, frame)
                agree = {"sourceIou": source.report.get("iou"), "sourceAgree": round(share, 4)}
            if args.face_weight > 0:
                try:
                    n_faces = source.find_faces()
                    print(f"[source] face visible in {n_faces}/{len(source.frame_ids)} frames", flush=True)
                except Exception as e:  # a face crop is a quality boost, never a blocker
                    print(f"[source] face crops off: {type(e).__name__}: {e}", flush=True)
            face = face_of(frame)
            params = trainer.fit(params, rgba, args.source_iters, True, src, face)
        metrics = trainer.evaluate(params, rgba) | agree
        if src is not None:
            src = source.target(frame)  # scored over every pixel that counts, agreeing or not, as before
            with torch.no_grad():
                white = torch.ones(1, 3, device=args.device)
                pred, _, _ = source.render(trainer, params, int(round(math.sqrt(params["shN"].shape[1] + 1))) - 1, white)
                gt = src[..., :3] * src[..., 3:4] + (1 - src[..., 3:4])
                if src.shape[-1] > 4:  # over the pixels that count (another person's are left out)
                    v = src[..., 4:5]
                    mse = float(((pred - gt) ** 2 * v).sum() / (3 * v.sum()).clamp_min(1))
                    metrics["sourcePsnr"] = 10 * math.log10(1 / max(mse, 1e-10))
                else:
                    metrics["sourcePsnr"] = float(psnr(pred, gt))  # against the real 4K frame, not a generated view
                if not warm:
                    from PIL import Image

                    pair = (torch.cat([gt[0], pred[0]], 1).clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
                    Image.fromarray(pair).save(args.out / f"peek-source-{frame:06d}.jpg", quality=90)
                    report["source"] = source.report
                    if face is not None:
                        ft, fK, (fw, fh) = face
                        fp, _, _ = source._render(trainer, params, source.viewmat, fK, fw, fh, bg=white,
                                                  degree=int(round(math.sqrt(params["shN"].shape[1] + 1))) - 1)
                        fg = ft[..., :3] * ft[..., 3:4] + (1 - ft[..., 3:4])
                        metrics["facePsnr"] = float(psnr(fp, fg))
                        fpair = (torch.cat([fg[0], fp[0]], 1).clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
                        Image.fromarray(fpair).save(args.out / f"peek-face-{frame:06d}.jpg", quality=92)
                    (args.out / f"source-camera-{frame:06d}.json").write_text(json.dumps(source.camera))
        if args.peek and not warm:
            trainer.peek(params, rgba, [int(v) for v in args.peek.split(",")], args.out / f"peek-{frame:06d}.jpg")
        g = Gaussians.from_params(params)
        keep = 1 / (1 + np.exp(-g.opacities)) > 0.005
        g = g.subset(keep)
        write_ply(out_frames / f"{frame:06d}.ply", g)
        spz_bytes = write_spz(out_frames / f"{frame:06d}.spz", g, sh_degree=args.spz_sh)
        entry = {"frame": frame, "gaussians": g.count, "seconds": round(time.time() - tf, 1), "spzBytes": spz_bytes}
        entry |= metrics
        report["frames"].append(entry)
        print(f"[recon] frame {frame}: {json.dumps(entry)}", flush=True)
    report["seconds"] = round(time.time() - t0, 1)
    (args.out / f"recon-{report['start']:06d}-{report['end']:06d}.json").write_text(json.dumps(report, indent=2))
    print("[recon] done", json.dumps({k: v for k, v in report.items() if k != "frames"}))


if __name__ == "__main__":
    main()
