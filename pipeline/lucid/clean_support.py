"""What the cameras say about each Gaussian of a replay, for lucid.clean (GPU, HiPerGator): how many of 4DAnyone's 48
generated views see its centre inside the person's silhouette, the same for the two ends of its longest axis, and
whether the clip's real camera sees it inside the real person.

A person is inside their silhouette from every side. A ghost (a limb where it was a moment ago, left behind by the
frame-to-frame warm start) or a floater is outside it in most views, though the reconstruction kept it: faint,
it cost the training little. The silhouettes are the ones the reconstruction trained on (4DAnyone's BiRefNet).

The real camera: a chunk whose camera solve worked (recon/source-camera-<start>.json) uses it; a chunk whose solve
failed starts from the nearest solved camera and is refined against its own real frame (pose and focal length, on
the silhouette and colour, as lucid.source_view does), kept only if the silhouettes then overlap (IoU >= --min-iou).
Those frames never trained on the real frame: lucid.clean_check's held-out numbers use these cameras.

    python -m lucid.clean_support --run $L/runs/<id> --out <dir>      # <dir>/support.npz, <dir>/real-cameras.json

support.npz, per bundle frame i (arrays over its Gaussians, in file order):
  v<i>  uint8  views (of those whose picture holds the centre) with the centre inside the silhouette (dilated)
  e<i>  uint8  the same for the worse of the two ends of the longest axis (centre +- 2 sigma)
  n<i>  uint8  views whose picture holds the centre
  r<i>  int8   real camera: 1 inside the real person (dilated), 0 outside, -1 out of its picture or no trusted camera
  s<i>  int8   real camera: 1 on the surface it saw (in front, within 4 cm of the rendered depth), 0 not, -1 no camera
real-cameras.json: per frame, the camera (bundle-to-camera 4x4 and K at the clip's size), how it was found, and our
render's silhouette IoU against the real one (renderIou).
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from .clean_check import bbox, bundle_to_world, chunk_cameras, foreground, tensors
from .gaussians import read_spz


def se3_exp(xi: torch.Tensor) -> torch.Tensor:
    """6-vector (axis-angle, translation) -> 4x4 (Rodrigues; as lucid.source_view's)."""
    w, t = xi[:3], xi[3:]
    theta2 = (w * w).sum() + 1e-12
    theta = torch.sqrt(theta2)
    W = torch.zeros(3, 3, dtype=xi.dtype, device=xi.device)
    W[0, 1], W[0, 2], W[1, 0], W[1, 2], W[2, 0], W[2, 1] = -w[2], w[1], w[2], -w[0], -w[1], w[0]
    I = torch.eye(3, dtype=xi.dtype, device=xi.device)
    R = I + (torch.sin(theta) / theta) * W + ((1 - torch.cos(theta)) / theta2) * (W @ W)
    top = torch.cat([R, t[:, None]], 1)
    return torch.cat([top, torch.tensor([[0.0, 0.0, 0.0, 1.0]], dtype=xi.dtype, device=xi.device)], 0)


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--run", type=Path, required=True)
    p.add_argument("--bundle", type=Path, help="default: <run>/bundle")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--dilate-view", type=int, default=6, help="px at the views' 1280 px height (about 1 cm)")
    p.add_argument("--dilate-real", type=float, default=0.012, help="share of the person's height in the real frame")
    p.add_argument("--min-iou", type=float, default=0.9, help="a refined real camera is trusted from this silhouette IoU")
    p.add_argument("--batch", type=int, default=6, help="frames per BiRefNet call (x 48 views)")
    p.add_argument("--device", default="cuda:0")
    return p.parse_args(argv)


def project(means_b: torch.Tensor, w2c: torch.Tensor, K: torch.Tensor, w: int, h: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """Pixel (u, v) as longs and whether it lands in the picture, for bundle-space points."""
    cam = means_b @ w2c[:3, :3].T + w2c[:3, 3]
    z = cam[:, 2]
    uv = cam[:, :2] / z.clamp_min(1e-6)[:, None] @ K[:2, :2].T + K[:2, 2]
    u, v = uv[:, 0].floor().long(), uv[:, 1].floor().long()
    ok = (z > 0.05) & (u >= 0) & (u < w) & (v >= 0) & (v < h)
    return u.clamp(0, w - 1), v.clamp(0, h - 1), ok


def axis_ends(g, device) -> tuple[torch.Tensor, torch.Tensor]:
    """Both ends of each Gaussian's longest axis, 2 sigma out."""
    q = torch.as_tensor(g.quats, dtype=torch.float32, device=device)
    q = q / q.norm(dim=1, keepdim=True).clamp_min(1e-12)
    w, x, y, z = q.unbind(1)
    R = torch.stack([1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
                     2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
                     2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], 1).reshape(-1, 3, 3)
    s = torch.exp(torch.as_tensor(g.scales, dtype=torch.float32, device=device))
    k = s.argmax(1)
    axis = R[torch.arange(len(k), device=device), :, k] * s.gather(1, k[:, None]) * 2.0
    m = torch.as_tensor(g.means, dtype=torch.float32, device=device)
    return m + axis, m - axis


def refine_camera(p: dict, rgb: np.ndarray, mask: np.ndarray, w2c_b: np.ndarray, K: np.ndarray, device: str,
                  steps: int = 300) -> tuple[np.ndarray, np.ndarray, float, float]:
    """Pose and focal length that line our render up with the real frame (silhouette + colour), from a nearby start.
    Returns (bundle-to-camera 4x4, K at the frame's full size, IoU before, IoU after)."""
    from gsplat import rasterization

    H, W = mask.shape
    s = 960.0 / H
    hs, ws = 960, int(round(W * s))
    m = F.interpolate(torch.as_tensor(mask, device=device)[None, None], size=(hs, ws), mode="area")[0, 0]
    img = torch.as_tensor(rgb, device=device).float().permute(2, 0, 1)[None] / 255.0
    img = F.interpolate(img, size=(hs, ws), mode="area")[0].permute(1, 2, 0)
    gt = img * m[..., None] + (1 - m[..., None])
    K0 = torch.as_tensor(K, dtype=torch.float32, device=device).clone()
    K0[:2] *= s
    vm0 = torch.as_tensor(w2c_b, dtype=torch.float32, device=device)
    white = torch.ones(1, 3, device=device)
    xi = torch.zeros(6, device=device, requires_grad=True)
    lf = torch.zeros(1, device=device, requires_grad=True)  # log focal scale
    opt = torch.optim.Adam([{"params": [xi], "lr": 2e-3}, {"params": [lf], "lr": 2e-3}])

    def render(vm, Kc):
        rgb_, a_, _ = rasterization(means=p["means"], quats=p["quats"], scales=p["scales"], opacities=p["opacities"],
                                    colors=p["colors"], viewmats=vm[None], Ks=Kc[None], width=ws, height=hs,
                                    backgrounds=white, packed=False, rasterize_mode="antialiased")
        return rgb_[0], a_[0, ..., 0]

    def scaled(lf_):
        Kc = K0.clone()
        Kc[0, 0] = K0[0, 0] * torch.exp(lf_[0])
        Kc[1, 1] = K0[1, 1] * torch.exp(lf_[0])
        return Kc

    def iou(a_):
        return float(((a_ > 0.5) & (m > 0.5)).sum() / ((a_ > 0.5) | (m > 0.5)).sum().clamp_min(1))

    with torch.no_grad():
        iou0 = iou(render(vm0, K0)[1])
    for it in range(steps):
        r_, a_ = render(se3_exp(xi) @ vm0, scaled(lf))
        loss = (a_ - m).abs().mean() + 0.5 * (r_ - gt).abs().mean()
        opt.zero_grad()
        loss.backward()
        opt.step()
        if it == steps // 2:
            for g_ in opt.param_groups:
                g_["lr"] *= 0.25
    with torch.no_grad():
        vm = se3_exp(xi) @ vm0
        Kc = scaled(lf)
        iou1 = iou(render(vm, Kc)[1])
        K_full = Kc.clone()
        K_full[:2] /= s
    return vm.detach().cpu().numpy(), K_full.cpu().numpy(), iou0, iou1


def main(argv=None):
    a = parse_args(argv)
    t0 = time.time()
    dev = a.device
    bundle = a.bundle or a.run / "bundle"
    dream = json.loads((bundle / "dream.json").read_text())
    fr = dream["frames"]
    pattern = fr.get("spz") or fr["pattern"].replace(".ply", ".spz")
    n_frames = 0
    while (bundle / fr["dir"] / (pattern % n_frames)).exists():
        n_frames += 1
    b2w = bundle_to_world(dream["placement"])
    a.out.mkdir(parents=True, exist_ok=True)

    cams = sorted(json.loads((a.run / "views" / "cameras.json").read_text())["cameras"], key=lambda c: int(c["camera_id"]))
    V = len(cams)
    w2cs = torch.as_tensor(np.stack([np.linalg.inv(np.asarray(c["camera_to_world"], float)) @ b2w for c in cams]),
                           dtype=torch.float32, device=dev)
    Ks = torch.as_tensor(np.stack([np.asarray(c["K"], float) for c in cams]), dtype=torch.float32, device=dev)
    vw, vh = int(cams[0]["image_width"]), int(cams[0]["image_height"])
    rv = max(1, int(round(a.dilate_view * vh / 1280)))

    import av

    containers = [av.open(str(a.run / "views" / "videos" / f"{v:02d}.mp4")) for v in range(V)]
    decoders = [c.decode(c.streams.video[0]) for c in containers]
    clip = a.run / "prepped.mp4"
    chunks = chunk_cameras(a.run)
    have_real = clip.exists() and any(c["camera"] for c in chunks)
    real_dec = None
    if have_real:
        rc = av.open(str(clip))
        real_dec = rc.decode(rc.streams.video[0])
    out: dict[str, np.ndarray] = {}
    real_cams: dict[str, dict] = {}
    stats = {"views": [], "real": []}
    for start in range(0, n_frames, a.batch):
        ids = list(range(start, min(n_frames, start + a.batch)))
        imgs = []
        for _ in ids:
            for d in decoders:
                imgs.append(next(d).to_ndarray(format="rgb24"))
        masks = foreground(imgs, dev)
        del imgs
        reals, real_masks = [], []
        if have_real:
            reals = [next(real_dec).to_ndarray(format="rgb24") for _ in ids]
            real_masks = foreground(reals, dev)
        for k, i in enumerate(ids):
            g = read_spz(bundle / fr["dir"] / (pattern % i))
            means = torch.as_tensor(g.means, dtype=torch.float32, device=dev)
            end_a, end_b = axis_ends(g, dev)
            inside = torch.zeros(g.count, dtype=torch.int32, device=dev)
            inside_end = torch.zeros(g.count, dtype=torch.int32, device=dev)
            seen = torch.zeros(g.count, dtype=torch.int32, device=dev)
            for v in range(V):
                m = torch.as_tensor(masks[k * V + v], device=dev) > 0.5
                md = F.max_pool2d(m.float()[None, None], 2 * rv + 1, stride=1, padding=rv)[0, 0] > 0.5
                u, vv, ok = project(means, w2cs[v], Ks[v], vw, vh)
                inside += (ok & md[vv, u]).int()
                seen += ok.int()
                ua, va, oka = project(end_a, w2cs[v], Ks[v], vw, vh)
                ub, vb, okb = project(end_b, w2cs[v], Ks[v], vw, vh)
                inside_end += (ok & (~oka | md[va, ua]) & (~okb | md[vb, ub])).int()
            out[f"v{i}"] = inside.clamp(0, 255).byte().cpu().numpy()
            out[f"e{i}"] = inside_end.clamp(0, 255).byte().cpu().numpy()
            out[f"n{i}"] = seen.clamp(0, 255).byte().cpu().numpy()
            frac = (inside.float() / seen.float().clamp_min(1)).cpu().numpy()
            stats["views"].append([i, float((frac < 0.5).mean()), float((frac < 0.8).mean())])
            real = np.full(g.count, -1, np.int8)
            seen_real = np.full(g.count, -1, np.int8)
            if have_real:
                rm = real_masks[k]
                H, W = rm.shape
                own = next((c for c in chunks if c["start"] <= i < c["end"]), None)
                cam_info = None
                if own is not None and own["camera"] is not None:
                    c = own["camera"]
                    K = np.asarray(c["K"], float).copy()
                    K[0] *= W / c["image_width"]
                    K[1] *= H / c["image_height"]
                    w2c_b = np.linalg.inv(np.asarray(c["camera_to_world"], float)) @ b2w
                    cam_info = {"w2cBundle": w2c_b.tolist(), "K": K.tolist(), "width": W, "height": H, "held": False,
                                "how": f"solved for chunk {own['start']}"}
                else:
                    solved = [c for c in chunks if c["camera"] is not None]
                    if solved and bbox(rm) is not None:
                        near = min(solved, key=lambda c: min(abs(i - c["start"]), abs(i - (c["end"] - 1))))
                        c = near["camera"]
                        K = np.asarray(c["K"], float).copy()
                        K[0] *= W / c["image_width"]
                        K[1] *= H / c["image_height"]
                        w2c_b = np.linalg.inv(np.asarray(c["camera_to_world"], float)) @ b2w
                        p = tensors(g, dev)
                        vm, Kr, iou0, iou1 = refine_camera(p, reals[k], rm, w2c_b, K, dev)
                        cam_info = {"w2cBundle": vm.tolist(), "K": Kr.tolist(), "width": W, "height": H, "held": True,
                                    "how": f"refined from chunk {near['start']}", "iouStart": round(iou0, 4),
                                    "iou": round(iou1, 4)}
                        if iou1 < a.min_iou:
                            cam_info["trusted"] = False
                        print(f"[support] frame {i}: real camera refined from chunk {near['start']}: IoU {iou0:.3f} -> {iou1:.3f}",
                              flush=True)
                if cam_info is not None:
                    real_cams[str(i)] = cam_info
                if cam_info is not None and cam_info.get("trusted", True):
                    box = bbox(rm)
                    if box is not None:
                        rr = max(2, int(a.dilate_real * (box[3] - box[1])))
                        # at a quarter of the size: "any of these pixels is the person", then dilated
                        q = 4
                        m4 = F.max_pool2d((torch.as_tensor(rm, device=dev) > 0.5).float()[None, None], q, stride=q,
                                          ceil_mode=True)
                        r4 = max(1, rr // q)
                        m4 = F.max_pool2d(m4, 2 * r4 + 1, stride=1, padding=r4)[0, 0] > 0.5
                        Kq = torch.as_tensor(np.asarray(cam_info["K"], float), dtype=torch.float32, device=dev).clone()
                        Kq[:2] /= q
                        u, vv, ok = project(means, torch.as_tensor(np.asarray(cam_info["w2cBundle"], float), dtype=torch.float32,
                                                                   device=dev), Kq, m4.shape[1], m4.shape[0])
                        # out of the picture is unknown, not outside: a foot below the frame's edge is still a foot
                        real = torch.where(ok, m4[vv, u].to(torch.int8), torch.full_like(ok, -1, dtype=torch.int8)).cpu().numpy()
                        stats["real"].append([i, float((real == 0).mean())])
                        # seen: on the surface the real camera saw (in front, within 4 cm of the rendered depth), as
                        # lucid.export's seen-vs-imagined test, at a quarter of the frame's size
                        from gsplat import rasterization

                        p = tensors(g, dev)
                        vmq = torch.as_tensor(np.asarray(cam_info["w2cBundle"], float), dtype=torch.float32, device=dev)
                        hq, wq = m4.shape
                        depth, alpha, _ = rasterization(means=p["means"], quats=p["quats"], scales=p["scales"],
                                                        opacities=p["opacities"], colors=p["colors"], viewmats=vmq[None],
                                                        Ks=Kq[None], width=wq, height=hq, render_mode="ED", packed=False)
                        z = (means @ vmq[:3, :3].T + vmq[:3, 3])[:, 2]
                        d, al = depth[0, vv, u, 0], alpha[0, vv, u, 0]
                        seen_real = torch.where(ok & (al > 0.5) & (z <= d + 0.04), 1, 0).to(torch.int8).cpu().numpy()
                        mq = F.avg_pool2d((torch.as_tensor(rm, device=dev) > 0.5).float()[None, None], q, stride=q,
                                          ceil_mode=True)[0, 0] > 0.5
                        ours = alpha[0, ..., 0] > 0.5
                        cam_info["renderIou"] = round(float((ours & mq).sum() / (ours | mq).sum().clamp_min(1)), 4)
            out[f"r{i}"] = real
            out[f"s{i}"] = seen_real
        print(f"[support] frames {ids[0]}-{ids[-1]} ({time.time() - t0:.0f}s)", flush=True)
    for c in containers:
        c.close()
    np.savez_compressed(a.out / "support.npz", **out)
    (a.out / "real-cameras.json").write_text(json.dumps(real_cams, indent=1))
    v = np.array([s[1:] for s in stats["views"]])
    print(f"[support] {dream['id']}: {n_frames} frames; share under half the views {v[:, 0].mean():.4f}, under 80% "
          f"{v[:, 1].mean():.4f}; outside the real person {np.mean([s[1] for s in stats['real']]) if stats['real'] else float('nan'):.4f}"
          f" over {len(stats['real'])} frames", flush=True)
    print(f"SUPPORT_OK {dream['id']} {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
