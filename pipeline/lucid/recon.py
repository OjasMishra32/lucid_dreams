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
    p.add_argument("--spz-sh", type=int, default=0, help="SH degree kept in the .spz copies")
    p.add_argument("--device", default="cuda:0")
    p.add_argument("--seed", type=int, default=0)
    return p.parse_args(argv)


# ---------------------------------------------------------------------------------------------------------------


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

    def fit(self, params, rgba: torch.Tensor, iters: int, warm: bool):
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
            loss.backward()
            for opt in optimizers.values():
                opt.step()
                opt.zero_grad(set_to_none=True)
            lr = lr0 * gamma**step
            optimizers["means"].param_groups[0]["lr"] = lr
            strategy.step_post_backward(params, optimizers, state, step, info, lr=lr)
        return params

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
        params = trainer.fit(params, rgba, args.iters_warm if warm else args.iters_first, warm)
        metrics = trainer.evaluate(params, rgba)
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
