"""The real camera as one more view: the sharpest data we have.

4DAnyone's 48 views are 704x1280 re-renders; the clip itself is 4K, and the face in it is three times the size. The
clip's camera isn't stored, so it's solved on the chunk's first frame: the Gaussians trained from the views are
rendered from each front ring camera, the best silhouette match is moved into place in 2D (scale and shift folded
into the intrinsics), then its pose is refined by gradient until the render lines up with the real frame. Training
then sees a crop of the real frame around the person, up to 2560 px tall, as a high-weight extra view.

The tripod rule matters here: one camera for the whole clip.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F


def se3_exp(xi: torch.Tensor) -> torch.Tensor:
    """6-vector (axis-angle, translation) -> 4x4, differentiable and stable at zero (Rodrigues)."""
    w, t = xi[:3], xi[3:]
    theta2 = (w * w).sum() + 1e-12
    theta = torch.sqrt(theta2)
    W = torch.zeros(3, 3, dtype=xi.dtype, device=xi.device)
    W[0, 1], W[0, 2], W[1, 0], W[1, 2], W[2, 0], W[2, 1] = -w[2], w[1], w[2], -w[0], -w[1], w[0]
    I = torch.eye(3, dtype=xi.dtype, device=xi.device)
    R = I + (torch.sin(theta) / theta) * W + ((1 - torch.cos(theta)) / theta2) * (W @ W)
    top = torch.cat([R, t[:, None]], 1)
    return torch.cat([top, torch.tensor([[0.0, 0.0, 0.0, 1.0]], dtype=xi.dtype, device=xi.device)], 0)


def bbox(mask: np.ndarray, thresh: float = 0.5) -> tuple[float, float, float, float] | None:
    ys, xs = np.nonzero(mask > thresh)
    if len(ys) < 50:
        return None
    return float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)


class SourceView:
    def __init__(self, video: Path, frame_ids: list[int], device: str, max_height: int = 2560, model_dir: str | None = None,
                 masks_dir: Path | None = None, ignore_dir: Path | None = None, focal: float | None = None):
        """masks_dir: the person's own masks, one image per clip frame named by its index (000123.png, white = them),
        used instead of the foreground model (e.g. one player's SAM 2.1 mask when others share the frame). ignore_dir:
        the same naming, white = pixels that never count in any loss (another player, a referee). focal: the camera's
        known focal length in full-resolution pixels (a long broadcast lens); held fixed instead of solved."""
        import av

        self.device = device
        self.focal = focal
        self.max_height = max_height
        lo, hi = frame_ids[0], frame_ids[-1] + 1
        rgb = []
        with av.open(str(video)) as container:
            for i, frame in enumerate(container.decode(container.streams.video[0])):
                if i >= hi:
                    break
                if i >= lo:
                    rgb.append(frame.to_ndarray(format="rgb24"))
        if len(rgb) != hi - lo:
            raise ValueError(f"{video} has {lo + len(rgb)} frames, need {hi}")
        self.frame_ids = list(range(lo, hi))
        self.rgb = np.stack(rgb)  # [N,H,W,3] uint8, full resolution
        self.H, self.W = self.rgb.shape[1:3]
        self.masks_given = masks_dir is not None
        if masks_dir is not None:
            self.masks = load_masks(masks_dir, self.frame_ids, self.H, self.W)
            print(f"[source] masks from {masks_dir} ({len(self.frame_ids)} frames)", flush=True)
        else:
            from fdanyone.assets import resolve_foreground_model
            from fdanyone.download import ensure_foreground_model
            from fdanyone.foreground import predict_foreground_masks

            if model_dir is None:
                import fdanyone

                model_dir = str(Path(fdanyone.__file__).resolve().parents[1] / "models")
            ensure_foreground_model(model_dir)
            masks = predict_foreground_masks(tuple(rgb), resolve_foreground_model(model_dir), device)
            self.masks = np.asarray(masks).astype(np.float32) / (255.0 if np.asarray(masks).max() > 1 else 1.0)
        # 1 where a pixel counts, 0 where it's ignored (another person); None when everything counts
        self.valid = None if ignore_dir is None else 1 - load_masks(ignore_dir, self.frame_ids, self.H, self.W)
        self.ready = False
        self.viewmat = self.K = None
        self.size = (0, 0)
        self.report: dict = {}

    # ---------------------------------------------------------------------------------------------------------------

    def _render(self, trainer, params, viewmat, K, w, h, bg=None, degree=0):
        colors = torch.cat([params["sh0"], params["shN"]], 1)
        rgb, alpha, info = trainer.rasterize(
            means=params["means"], quats=params["quats"], scales=torch.exp(params["scales"]),
            opacities=torch.sigmoid(params["opacities"]), colors=colors, viewmats=viewmat[None], Ks=K[None],
            width=w, height=h, sh_degree=degree, backgrounds=bg, packed=False, rasterize_mode="antialiased",
        )
        return rgb.clamp(0, 1), alpha, info

    def solve(self, trainer, params, front_ids: list[int], steps: int = 400, min_iou: float = 0.8,
              debug: Path | None = None) -> bool:
        """Finds the clip's camera against the first frame of the chunk. False (and no source view) if it can't.
        Candidates are scored on silhouette and colour together: a silhouette alone can't tell front from back."""
        dev = self.device
        frozen = {k: v.detach() for k, v in params.items()}
        s = 960.0 / self.H
        ws, hs = int(round(self.W * s)), 960
        m = torch.as_tensor(self.masks[0], device=dev)[None, None]
        m = F.interpolate(m, size=(hs, ws), mode="area")[0, 0]
        img = torch.as_tensor(self.rgb[0], device=dev).float().permute(2, 0, 1)[None] / 255.0
        img = F.interpolate(img, size=(hs, ws), mode="area")[0].permute(1, 2, 0)
        box_s = bbox(m.cpu().numpy())
        if box_s is None:
            print("[source] no person in the clip's first frame; skipped")
            return False
        v = torch.ones_like(m)
        if self.valid is not None:
            v = F.interpolate(torch.as_tensor(self.valid[0], device=dev)[None, None], size=(hs, ws), mode="area")[0, 0]
            v = (v > 0.5).float()
        white = torch.ones(1, 3, device=dev)
        gt = img * m[..., None] + (1 - m[..., None])
        centre = frozen["means"][torch.sigmoid(frozen["opacities"]).squeeze(-1) > 0.5].mean(0) if (
            torch.sigmoid(frozen["opacities"]) > 0.5).sum() > 100 else frozen["means"].mean(0)
        tried = []
        with torch.no_grad():
            for cid in front_ids:
                vm = trainer.viewmats[cid]
                Kr = trainer.Ks[cid]
                _, a_r, _ = self._render(trainer, frozen, vm, Kr, trainer.width, trainer.height)
                box_r = bbox(a_r[0, ..., 0].cpu().numpy())
                if box_r is None:
                    continue
                scale = (box_s[3] - box_s[1]) / (box_r[3] - box_r[1])
                K = Kr.clone()
                K[0, 0] *= scale
                K[1, 1] *= scale
                K[0, 2] = 0.5 * (box_s[0] + box_s[2]) - (0.5 * (box_r[0] + box_r[2]) - Kr[0, 2]) * scale
                K[1, 2] = 0.5 * (box_s[1] + box_s[3]) - (0.5 * (box_r[1] + box_r[3]) - Kr[1, 2]) * scale
                if self.focal is not None:
                    vm, K = hold_focal(vm, K, self.focal * s, centre)
                rgb, a, _ = self._render(trainer, frozen, vm, K, ws, hs, bg=white)
                a = a[0, ..., 0]
                inside = ((a > 0.5) | (m > 0.5)) & (v > 0.5)
                iou = float(((a > 0.5) & (m > 0.5) & (v > 0.5)).sum() / inside.sum().clamp_min(1))
                colour = float((rgb[0] - gt).abs().mean(-1)[inside].mean())
                tried.append((iou - colour, iou, colour, cid, vm.clone(), K, rgb[0].clone()))
        if not tried:
            return False
        tried.sort(key=lambda t: -t[0])
        if debug is not None:
            debug.mkdir(parents=True, exist_ok=True)
            from PIL import Image

            rows = [torch.cat([gt, c[6]], 1) for c in tried[:4]]
            Image.fromarray((torch.cat(rows, 1).clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)).save(
                debug / "candidates.jpg", quality=88)
            print("[source] top candidates (score, IoU, colour, camera):",
                  [(round(t[0], 3), round(t[1], 3), round(t[2], 3), t[3]) for t in tried[:6]], flush=True)
        _, iou0, _, cid, vm0, K, _ = tried[0]
        xi = torch.zeros(6, device=dev, requires_grad=True)
        opt = torch.optim.Adam([xi], lr=2e-3)
        for it in range(steps):
            vm = se3_exp(xi) @ vm0
            rgb, a, _ = self._render(trainer, frozen, vm, K, ws, hs, bg=white)
            loss = ((a[0, ..., 0] - m).abs() * v).mean() + 0.5 * ((rgb[0] - gt).abs() * v[..., None]).mean()
            opt.zero_grad()
            loss.backward()
            opt.step()
            if it == steps // 2:
                for g in opt.param_groups:
                    g["lr"] = 5e-4
        with torch.no_grad():
            vm = se3_exp(xi) @ vm0
            rgb, a, _ = self._render(trainer, frozen, vm, K, ws, hs, bg=white)
            a = a[0, ..., 0]
            iou = float(((a > 0.5) & (m > 0.5) & (v > 0.5)).sum() / (((a > 0.5) | (m > 0.5)) & (v > 0.5)).sum().clamp_min(1))
            if debug is not None:
                from PIL import Image

                over = gt.clone()
                over[..., 0] = torch.maximum(over[..., 0], (m > 0.5).float() * 0.6)
                over[..., 1] = torch.maximum(over[..., 1], (a > 0.5).float() * 0.6)
                strip = torch.cat([gt, rgb[0], over], 1)
                Image.fromarray((strip.clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)).save(debug / "solved.jpg", quality=88)
        self.report = {"fromCamera": int(cid), "iouStart": round(iou0, 4), "iou": round(iou, 4),
                       "focal": round(float(K[0, 0]) / s, 1), "focalHeld": self.focal is not None,
                       "masks": "given" if self.masks_given else "model", "ignoring": self.valid is not None}
        print(f"[source] camera solved from ring camera {cid}: silhouette IoU {iou0:.3f} -> {iou:.3f}", flush=True)
        if iou < min_iou:
            print(f"[source] IoU under {min_iou}: training without the real frame", flush=True)
            return False

        # full resolution intrinsics, then a crop around the person over the whole chunk, at most max_height tall
        K_full = K.clone()
        K_full[:2] /= s
        union = (self.masks > 0.5).any(0).astype(np.float32)
        x0, y0, x1, y1 = bbox(union)
        mx, my = 0.06 * (x1 - x0), 0.06 * (y1 - y0)
        x0, y0 = max(0, int(x0 - mx)), max(0, int(y0 - my))
        x1, y1 = min(self.W, int(x1 + mx)), min(self.H, int(y1 + my))
        r = min(1.0, self.max_height / (y1 - y0))
        w, h = int(round((x1 - x0) * r)), int(round((y1 - y0) * r))
        K_crop = K_full.clone()
        K_crop[0, 2] -= x0
        K_crop[1, 2] -= y0
        K_crop[:2] *= r
        self.viewmat, self.K, self.size, self.crop, self.r = vm.detach(), K_crop, (w, h), (x0, y0, x1, y1), r
        self.K_full = K_full.detach()
        self.report |= {"crop": [x0, y0, x1, y1], "size": [w, h]}
        # the camera itself, in the rig's world, at full resolution: the export's "seen" test uses it
        self.camera = {"camera_to_world": torch.linalg.inv(vm).detach().cpu().numpy().tolist(),
                       "K": K_full.detach().cpu().numpy().tolist(), "image_width": int(self.W),
                       "image_height": int(self.H), "iou": round(iou, 4)}
        self.ready = True
        return True

    def target(self, frame: int) -> torch.Tensor:
        """[1,h,w,4] float 0-1: the real frame's crop and its mask, at training size."""
        i = frame - self.frame_ids[0]
        x0, y0, x1, y1 = self.crop
        w, h = self.size
        return self._crop(i, x0, y0, x1, y1, w, h)

    def _crop(self, i: int, x0: int, y0: int, x1: int, y1: int, w: int, h: int) -> torch.Tensor:
        """[1,h,w,4] rgb + mask, or [1,h,w,5] with a last channel 1 where the pixel counts (ignored pixels 0)."""
        rgb = torch.as_tensor(self.rgb[i, y0:y1, x0:x1], device=self.device).float().permute(2, 0, 1) / 255.0
        chans = [rgb, torch.as_tensor(self.masks[i, y0:y1, x0:x1], device=self.device)[None]]
        if self.valid is not None:
            chans.append(torch.as_tensor(self.valid[i, y0:y1, x0:x1], device=self.device)[None])
        out = torch.cat(chans, 0)[None]
        if (w, h) != (x1 - x0, y1 - y0):
            out = F.interpolate(out, size=(h, w), mode="area")
        return out[0].permute(1, 2, 0)[None].contiguous()

    def render(self, trainer, params, degree: int, bg: torch.Tensor):
        w, h = self.size
        return self._render(trainer, params, self.viewmat, self.K, w, h, bg=bg, degree=degree)

    # ---------------------------------------------------------------------------------------------------------------
    # the face at the clip's native resolution: a person reads as real or not by the face, so it gets its own crop of
    # the real frame, at full 4K detail and extra weight. Frames where the camera can't see the face (the back of the
    # head, a hand over it) get none.

    def find_faces(self, weights: str = "/blue/iruchkin/vishalnaveen/lucid/models/yolov8m-pose.pt", max_side: int = 768) -> int:
        from ultralytics import YOLO

        model = YOLO(weights)
        self.faces = {}
        s = 1280.0 / self.H
        for i, frame in enumerate(self.frame_ids):
            small = np.ascontiguousarray(self.rgb[i][::int(round(1 / s)) or 1, ::int(round(1 / s)) or 1, ::-1])
            r = model.predict(small, verbose=False, conf=0.3)[0]
            if r.keypoints is None or len(r.keypoints) == 0:
                continue
            k = r.keypoints.data.cpu().numpy()  # [people, 17, 3] in the small image
            best = int(np.argmax(r.boxes.conf.cpu().numpy())) if r.boxes is not None and len(r.boxes) else 0
            pts = k[best]
            scale = self.H / small.shape[0]
            nose, eyes, ears = pts[0], pts[1:3], pts[3:5]
            if nose[2] < 0.5 or (eyes[:, 2] > 0.5).sum() == 0:  # no face toward the camera
                continue
            face = np.concatenate([nose[None], eyes[eyes[:, 2] > 0.5], ears[ears[:, 2] > 0.5]])[:, :2] * scale
            cx, cy = face.mean(0)
            span = max(np.ptp(face[:, 0]), np.ptp(face[:, 1]), 1.0)
            side = int(np.clip(span * 3.2, 160, 1400))  # the whole head and a little hair and neck
            x0, y0 = int(max(0, cx - side / 2)), int(max(0, cy - side * 0.55))
            x1, y1 = int(min(self.W, x0 + side)), int(min(self.H, y0 + side))
            if x1 - x0 < 96 or y1 - y0 < 96:
                continue
            r_ = min(1.0, max_side / max(x1 - x0, y1 - y0))
            self.faces[frame] = (x0, y0, x1, y1, r_)
        return len(self.faces)

    def face(self, frame: int):
        """(target [1,h,w,4], K, (w, h)) for this frame's face crop, or None."""
        box = getattr(self, "faces", {}).get(frame)
        if box is None or self.K is None:
            return None
        x0, y0, x1, y1, r_ = box
        i = frame - self.frame_ids[0]
        w, h = int(round((x1 - x0) * r_)), int(round((y1 - y0) * r_))
        target = self._crop(i, x0, y0, x1, y1, w, h)
        K = self.K_full.clone()
        K[0, 2] -= x0
        K[1, 2] -= y0
        K[:2] *= r_
        return target, K, (w, h)


def load_masks(folder: Path, frame_ids: list[int], H: int, W: int) -> np.ndarray:
    """[N,H,W] float 0-1 from one image per clip frame, named by its index (000123.png); resized to the frame if a
    mask was made at another size."""
    from PIL import Image

    out = np.zeros((len(frame_ids), H, W), np.float32)
    for k, i in enumerate(frame_ids):
        path = Path(folder) / f"{i:06d}.png"
        if not path.exists():
            raise FileNotFoundError(f"{path}: every frame needs a mask")
        im = Image.open(path).convert("L")
        if im.size != (W, H):
            im = im.resize((W, H), Image.BILINEAR)
        out[k] = np.asarray(im, np.float32) / 255.0
    return out


def hold_focal(viewmat: torch.Tensor, K: torch.Tensor, focal: float, centre: torch.Tensor):
    """The same framing with a known focal length: the focal goes to `focal` and the camera moves along its own axis so
    the person (at world point `centre`) keeps their size and place in the image (x = f X / Z, so f and Z scale
    together). Returns (viewmat, K)."""
    k = focal / float(K[0, 0])
    z = float((viewmat[:3, :3] @ centre + viewmat[:3, 3])[2])  # the person's depth in front of the camera
    back = torch.eye(4, dtype=viewmat.dtype, device=viewmat.device)
    back[2, 3] = (k - 1) * z  # camera-space depths all grow by this: the camera steps back (or in) along its axis
    K = K.clone()
    K[0, 0] = K[1, 1] = focal
    return back @ viewmat, K


def psnr_masked(pred: torch.Tensor, gt: torch.Tensor) -> float:
    mse = float(((pred - gt) ** 2).mean())
    return 10 * math.log10(1.0 / max(mse, 1e-10))


def main(argv=None):
    """Debug the camera solve on an already-trained frame: `python -m lucid.source_view --result <views> --ply
    <frame.ply> --video <prepped.mp4> --out <dir>` writes candidates.jpg (truth | render, best four) and solved.jpg."""
    import argparse
    from types import SimpleNamespace

    from gsplat import rasterization

    from .frames import Rig
    from .gaussians import read_ply

    p = argparse.ArgumentParser(description=main.__doc__)
    p.add_argument("--result", type=Path, required=True)
    p.add_argument("--ply", type=Path, required=True)
    p.add_argument("--video", type=Path, required=True)
    p.add_argument("--frame", type=int, default=0)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--device", default="cuda:0")
    p.add_argument("--masks", type=Path, default=None)
    p.add_argument("--ignore", type=Path, default=None)
    p.add_argument("--focal", type=float, default=None)
    a = p.parse_args(argv)
    rig = Rig.from_json(a.result / "cameras.json")
    t = lambda x: torch.as_tensor(np.asarray(x), dtype=torch.float32, device=a.device)  # noqa: E731
    g = read_ply(a.ply)
    params = {"means": t(g.means), "scales": t(g.scales), "quats": t(g.quats), "opacities": t(g.opacities),
              "sh0": t(g.sh0), "shN": t(g.shN)}
    trainer = SimpleNamespace(rasterize=rasterization, viewmats=t(rig.world_to_camera), Ks=t(rig.K),
                              width=rig.width, height=rig.height)
    sv = SourceView(a.video, [a.frame], a.device, masks_dir=a.masks, ignore_dir=a.ignore, focal=a.focal)
    ok = sv.solve(trainer, params, list(range(rig.views)), debug=a.out)
    print("[source] solved" if ok else "[source] not solved", sv.report)


if __name__ == "__main__":
    main()
