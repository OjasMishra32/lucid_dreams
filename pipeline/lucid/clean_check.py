"""The proof for lucid.clean, on a GPU (gsplat): a replay rendered from the clip's own solved camera against the real
frames, and from 4DAnyone's generated views against those views, with and without what lucid.clean drops; plus
before / after contact sheets from several sides. A cleanup that lowers fidelity on the real frame doesn't ship.

    python -m lucid.clean_check --run $L/runs/<id> --out <dir> [--keep <id>.<variant>.keep.npz ...]
        [--cameras real-cameras.json] [--sheet-variant a:b] [--sheets 10:30:76]

The run dir has bundle/ (dream.json, frames/*.spz), prepped.mp4 (the clip, bundle frame i = clip frame i),
recon/recon-*.json with the chunks' solved cameras (recon/source-camera-<chunk start>.json) and views/ (cameras.json,
videos/). A chunk whose solve failed trained without the real frame, so its frames are held out; they're measured
through lucid.clean_support's per-frame refined cameras (--cameras, from silhouette IoU 0.85), else through the
nearest solved chunk's camera (rougher: the chunks' solves differ).
Bundle space -> 4DAnyone's world through dream.json's placement (bundle = rot @ world + t).

Each --keep file is lucid.clean's output (python -m lucid.clean <bundle> --keep-out <file>): one keep mask per frame.
Without one, it renders the bundle as it is (contact sheets of the problems).

Numbers, per frame and as means (white background, as training and the peeks use):
  real.psnr / real.ssim   against the real frame, cut out with 4DAnyone's own BiRefNet, over the crop around the person
  real.iou                our silhouette (alpha > 0.5) against the real one
  real.spill              share of our alpha that lands outside the real person (dilated): ghosts and floaters seen
                          from the real camera
  real.sharp / face.sharp variance of the Laplacian over the person (and over the face, around the head joint), 0-255
  real.flicker            frame i+1 against frame i: how far our change is from the clip's own change, over the
                          person (mean absolute difference, 0-255; lower = steadier)
  views.psnr / views.ssim against the generated views (every --view-step-th camera)
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

from .export import orbit_camera
from .gaussians import SH_C0, Gaussians, read_spz
from .losses import ssim

ANGLES = (0.0, math.pi / 3, 2 * math.pi / 3, math.pi, -math.pi / 2)  # front, 60, 120 degrees, back, the other side


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--run", type=Path, required=True)
    p.add_argument("--bundle", type=Path, help="default: <run>/bundle")
    p.add_argument("--keep", type=Path, nargs="*", default=[], help="lucid.clean keep files (one variant each)")
    p.add_argument("--cameras", type=Path, help="lucid.clean_support's real-cameras.json (held-out chunks refined)")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--every", type=int, default=4, help="real-frame check on every n-th frame")
    p.add_argument("--views-every", type=int, default=12, help="generated-view check on every n-th frame")
    p.add_argument("--view-step", type=int, default=3, help="every n-th generated camera")
    p.add_argument("--max-height", type=int, default=1600, help="real-frame crop rendered at most this tall")
    p.add_argument("--sheets", default="auto", help="frames for contact sheets: comma list, or auto")
    p.add_argument("--panel", default="360x640")
    p.add_argument("--sheet-variant", default="", help="variants to draw sheets for, comma or colon separated (default: the first)")
    p.add_argument("--device", default="cuda:0")
    return p.parse_args(argv)


# ---------------------------------------------------------------------------------------------------------------


def tensors(g: Gaussians, device: str) -> dict:
    t = lambda x: torch.as_tensor(np.ascontiguousarray(x), dtype=torch.float32, device=device)  # noqa: E731
    return {"means": t(g.means), "quats": t(g.quats), "scales": torch.exp(t(g.scales)),
            "opacities": torch.sigmoid(t(g.opacities)), "colors": t(g.sh0[:, 0] * SH_C0 + 0.5)}


def subset(p: dict, keep: np.ndarray | None) -> dict:
    if keep is None:
        return p
    k = torch.as_tensor(keep, device=p["means"].device)
    return {n: v[k] for n, v in p.items()}


def raster(p: dict, viewmat: np.ndarray, K: np.ndarray, w: int, h: int, bg) -> tuple[torch.Tensor, torch.Tensor]:
    """[h,w,3] colour over bg, [h,w] alpha. Colours are SH degree 0 (the bundle's SPZ)."""
    from gsplat import rasterization

    dev = p["means"].device
    vm = torch.as_tensor(viewmat, dtype=torch.float32, device=dev)[None]
    Ks = torch.as_tensor(K, dtype=torch.float32, device=dev)[None]
    if len(p["means"]) == 0:
        return torch.ones(h, w, 3, device=dev) * torch.as_tensor(bg, device=dev, dtype=torch.float32), torch.zeros(h, w, device=dev)
    rgb, alpha, _ = rasterization(means=p["means"], quats=p["quats"], scales=p["scales"], opacities=p["opacities"],
                                  colors=p["colors"], viewmats=vm, Ks=Ks, width=w, height=h, packed=False,
                                  rasterize_mode="antialiased")
    bg_t = torch.as_tensor(bg, dtype=torch.float32, device=dev)
    return (rgb[0] + (1 - alpha[0]) * bg_t).clamp(0, 1), alpha[0, ..., 0]


def lap_var(img: torch.Tensor, region: torch.Tensor) -> float:
    """Variance of the Laplacian of the luminance over a region ([h,w] bool)."""
    lum = (img[..., 0] * 0.299 + img[..., 1] * 0.587 + img[..., 2] * 0.114)[None, None]
    k = torch.tensor([[0, 1, 0], [1, -4, 1], [0, 1, 0]], dtype=lum.dtype, device=lum.device)[None, None]
    lap = F.conv2d(lum, k, padding=1)[0, 0]
    r = region.clone()
    r[0, :] = r[-1, :] = False
    r[:, 0] = r[:, -1] = False
    v = lap[r]
    return float(v.var()) * 255.0**2 if v.numel() > 100 else float("nan")


def psnr_of(a: torch.Tensor, b: torch.Tensor, region: torch.Tensor | None = None) -> float:
    d = (a - b) ** 2
    mse = float(d.mean()) if region is None else float(d[region].mean())
    return 10 * math.log10(1.0 / max(mse, 1e-10))


def dilate(mask: torch.Tensor, r: int) -> torch.Tensor:
    if r <= 0:
        return mask
    return F.max_pool2d(mask.float()[None, None], 2 * r + 1, stride=1, padding=r)[0, 0] > 0.5


def erode(mask: torch.Tensor, r: int) -> torch.Tensor:
    return ~dilate(~mask, r)


# ---------------------------------------------------------------------------------------------------------------


def chunk_cameras(run: Path) -> list[dict]:
    """[{start, end, camera or None}] from the recon reports."""
    out = []
    for path in sorted((run / "recon").glob("recon-*.json")):
        r = json.loads(path.read_text())
        cam_path = run / "recon" / f"source-camera-{r['start']:06d}.json"
        cam = json.loads(cam_path.read_text()) if cam_path.exists() else None
        out.append({"start": r["start"], "end": r["end"], "camera": cam})
    return out


def camera_for(frame: int, chunks: list[dict]) -> tuple[dict | None, bool]:
    """The chunk's own solved camera (trained against), else the nearest solved chunk's (held out)."""
    solved = [c for c in chunks if c["camera"] is not None]
    if not solved:
        return None, True
    for c in chunks:
        if c["start"] <= frame < c["end"]:
            if c["camera"] is not None:
                return c["camera"], False
            break
    near = min(solved, key=lambda c: min(abs(frame - c["start"]), abs(frame - (c["end"] - 1))))
    return near["camera"], True


def real_camera(i: int, chunks: list[dict], refined: dict | None, W: int, H: int, b2w: np.ndarray,
                min_iou: float = 0.85):
    """(bundle-to-camera 4x4, K at the frame's W x H, held out) or None. A refined camera counts from min_iou."""
    if refined is not None:
        c = refined.get(str(i))
        if c is None or c.get("iou", 1.0) < min_iou:
            return None
        K = np.asarray(c["K"], float).copy()
        K[0] *= W / c["width"]
        K[1] *= H / c["height"]
        return np.asarray(c["w2cBundle"], float), K, bool(c["held"])
    cam, held = camera_for(i, chunks)
    if cam is None:
        return None
    K = np.asarray(cam["K"], float).copy()
    K[0] *= W / cam["image_width"]
    K[1] *= H / cam["image_height"]
    return np.linalg.inv(np.asarray(cam["camera_to_world"], float)) @ b2w, K, held


def read_video_frames(path: Path, ids: list[int]) -> dict[int, np.ndarray]:
    import av

    want, out = set(ids), {}
    with av.open(str(path)) as c:
        for i, fr in enumerate(c.decode(c.streams.video[0])):
            if i > max(want):
                break
            if i in want:
                out[i] = fr.to_ndarray(format="rgb24")
    return out


def foreground(images: list[np.ndarray], device: str) -> list[np.ndarray]:
    """4DAnyone's BiRefNet cut-out (the masks reconstruction trained on), 0-1 float."""
    import fdanyone
    from fdanyone.assets import resolve_foreground_model
    from fdanyone.download import ensure_foreground_model
    from fdanyone.foreground import predict_foreground_masks

    model_dir = str(Path(fdanyone.__file__).resolve().parents[1] / "models")
    ensure_foreground_model(model_dir)
    out = []
    by_shape: dict[tuple, list[int]] = {}
    for i, im in enumerate(images):
        by_shape.setdefault(im.shape, []).append(i)
    res: dict[int, np.ndarray] = {}
    for idx in by_shape.values():
        m = predict_foreground_masks(tuple(images[i] for i in idx), resolve_foreground_model(model_dir), device)
        for i, mm in zip(idx, m):
            res[i] = np.asarray(mm, np.float32) / 255.0
    for i in range(len(images)):
        out.append(res[i])
    return out


def bundle_to_world(placement: dict) -> np.ndarray:
    M = np.eye(4)
    M[:3, :3], M[:3, 3] = np.asarray(placement["rot"], float), np.asarray(placement["t"], float)
    return np.linalg.inv(M)


def bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.nonzero(mask > 0.5)
    if len(ys) < 50:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1)


# ---------------------------------------------------------------------------------------------------------------


def label(img: np.ndarray, text: str) -> np.ndarray:
    from PIL import Image, ImageDraw

    im = Image.fromarray(img)
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, 8 + 7 * len(text), 16], fill=(0, 0, 0))
    d.text((4, 2), text, fill=(255, 255, 255))
    return np.asarray(im)


def to_u8(x: torch.Tensor) -> np.ndarray:
    return (x.clamp(0, 1) * 255).round().byte().cpu().numpy()


def fit(img: np.ndarray, w: int, h: int) -> np.ndarray:
    from PIL import Image

    im = Image.fromarray(img)
    im.thumbnail((w, h), Image.LANCZOS)
    out = np.full((h, w, 3), 40, np.uint8)
    y0, x0 = (h - im.height) // 2, (w - im.width) // 2
    out[y0:y0 + im.height, x0:x0 + im.width] = np.asarray(im)
    return out


def main(argv=None):
    a = parse_args(argv)
    t0 = time.time()
    dev = a.device
    bundle = a.bundle or a.run / "bundle"
    dream = json.loads((bundle / "dream.json").read_text())
    fr = dream["frames"]
    pattern = fr.get("spz") or fr["pattern"].replace(".ply", ".spz")
    n_frames = len([p for p in (bundle / fr["dir"]).glob("*.spz") if ".reality" not in p.name])
    b2w = bundle_to_world(dream["placement"])
    from .clean import load_keep

    variants = [(p.name.removesuffix(".npz").removesuffix(".keep").split(".")[-1], load_keep(p)) for p in a.keep]
    names = ["before"] + [v[0] for v in variants]
    a.out.mkdir(parents=True, exist_ok=True)
    joints = None
    if (bundle / "joints.json").exists():
        joints = np.asarray(json.loads((bundle / "joints.json").read_text())["frames"], float)

    def keep_of(variant: int, frame: int, n: int) -> np.ndarray | None:
        if variant == 0:
            return None
        k = variants[variant - 1][1].get(frame)
        if k is not None and len(k) != n:
            raise SystemExit(f"keep mask for frame {frame} has {len(k)} entries, the frame has {n}")
        return k

    report: dict = {"id": dream["id"], "variants": names, "frames": {}}

    # --- real frames -----------------------------------------------------------------------------------------
    chunks = chunk_cameras(a.run)
    refined = json.loads(a.cameras.read_text()) if a.cameras and a.cameras.exists() else None
    # every n-th frame and the one after it: the pair measures flicker (our change between them against the clip's)
    real_ids = sorted({j for i in range(0, n_frames, a.every) for j in (i, i + 1) if j < n_frames})
    clip = a.run / "prepped.mp4"
    if (refined or any(c["camera"] for c in chunks)) and clip.exists():
        rgb = read_video_frames(clip, real_ids)
        real_ids = [i for i in real_ids if i in rgb]
        masks = foreground([rgb[i] for i in real_ids], dev)
        print(f"[check] {len(real_ids)} real frames cut out ({time.time() - t0:.0f}s)", flush=True)
        boxes = {i: bbox(m) for i, m in zip(real_ids, masks)}
        prev = None  # (frame, camera, crop, {variant: render}, truth)
        for k, i in enumerate(real_ids):
            m = masks[k]
            box = boxes[i]
            H, W = m.shape
            rc = real_camera(i, chunks, refined, W, H, b2w)
            if box is None or rc is None:
                continue
            w2c, K, held = rc
            pair = i + 1 if boxes.get(i + 1) is not None else i - 1  # one crop for both frames of a pair
            if boxes.get(pair) is not None:
                b2 = boxes[pair]
                box = (min(box[0], b2[0]), min(box[1], b2[1]), max(box[2], b2[2]), max(box[3], b2[3]))
            x0, y0, x1, y1 = box
            mx, my = int(0.06 * (x1 - x0)), int(0.04 * (y1 - y0))
            x0, y0, x1, y1 = max(0, x0 - mx), max(0, y0 - my), min(W, x1 + mx), min(H, y1 + my)
            r = min(1.0, a.max_height / (y1 - y0))
            w, h = int(round((x1 - x0) * r)), int(round((y1 - y0) * r))
            K[0, 2] -= x0
            K[1, 2] -= y0
            K[:2] *= r
            gt_rgb = torch.as_tensor(rgb[i][y0:y1, x0:x1], device=dev).float().permute(2, 0, 1)[None] / 255.0
            gt_m = torch.as_tensor(m[y0:y1, x0:x1], device=dev)[None, None]
            gt_rgb = F.interpolate(gt_rgb, size=(h, w), mode="area")[0].permute(1, 2, 0)
            gt_m = F.interpolate(gt_m, size=(h, w), mode="area")[0, 0]
            gt = gt_rgb * gt_m[..., None] + (1 - gt_m[..., None])
            person = gt_m > 0.5
            near = dilate(person, max(2, int(0.012 * h)))
            g = read_spz(bundle / fr["dir"] / (pattern % i))
            base = tensors(g, dev)
            # the face: a square around the head joint (head + 8 cm up), 30 cm across
            face_box = None
            if joints is not None and i < len(joints):
                hj = np.r_[joints[i][15] + [0, 0.08, 0], 1.0]
                c = w2c @ hj
                if c[2] > 0:
                    u, v = K[0, 0] * c[0] / c[2] + K[0, 2], K[1, 1] * c[1] / c[2] + K[1, 2]
                    half = 0.15 * K[0, 0] / c[2]
                    fb = [int(u - half), int(v - half), int(u + half), int(v + half)]
                    if fb[0] >= 0 and fb[1] >= 0 and fb[2] <= w and fb[3] <= h and half > 12:
                        face_box = fb
            entry = {"held": held, "real": {}}
            renders = {}
            if face_box is not None:
                fx0, fy0, fx1, fy1 = face_box
                entry["real"]["faceSharpTruth"] = lap_var(gt_rgb[fy0:fy1, fx0:fx1], person[fy0:fy1, fx0:fx1])
            entry["real"]["sharpTruth"] = lap_var(gt_rgb, erode(person, 2))
            for vi, name in enumerate(names):
                keep = keep_of(vi, i, g.count)
                with torch.no_grad():
                    pred, alpha = raster(subset(base, keep), w2c, K, w, h, [1.0, 1.0, 1.0])
                ours = alpha > 0.5
                inter = float((ours & person).sum())
                union = float((ours | person).sum())
                region = erode(person, 2) & ours
                e = {"psnr": psnr_of(pred, gt), "psnrPerson": psnr_of(pred, gt, near | ours),
                     "ssim": float(ssim(pred[None], gt[None])), "iou": inter / max(union, 1.0),
                     "spill": float((alpha * (~near)).sum() / alpha.sum().clamp_min(1e-6)),
                     "sharp": lap_var(pred, region)}
                if face_box is not None:
                    fx0, fy0, fx1, fy1 = face_box
                    fr_ = region[fy0:fy1, fx0:fx1]
                    e["faceSharp"] = lap_var(pred[fy0:fy1, fx0:fx1], fr_)
                    e["facePsnr"] = psnr_of(pred[fy0:fy1, fx0:fx1], gt[fy0:fy1, fx0:fx1])
                renders[name] = (pred, near | ours)
                entry["real"][name] = e
            cam_key = (tuple(np.round(w2c, 6).ravel()), (x0, y0, x1, y1))
            if prev is not None and prev[0] == i - 1 and prev[1] == cam_key:
                # flicker: how far our frame-to-frame change is from the clip's, over the person (0-255)
                d_true = gt - prev[3]
                for name in names:
                    pred, reg = renders[name]
                    p_pred, p_reg = prev[2][name]
                    both = reg | p_reg
                    entry["real"][name]["flicker"] = float(((pred - p_pred) - d_true).abs().mean(-1)[both].mean()) * 255
            prev = (i, cam_key, renders, gt)
            report["frames"].setdefault(str(i), {}).update(entry)
        del rgb, masks
        print(f"[check] real frames measured ({time.time() - t0:.0f}s)", flush=True)
    else:
        print("[check] no solved camera for this run: real-frame check skipped", flush=True)

    # --- generated views -----------------------------------------------------------------------------------------
    cams = sorted(json.loads((a.run / "views" / "cameras.json").read_text())["cameras"], key=lambda c: int(c["camera_id"]))
    view_ids = list(range(0, len(cams), a.view_step))
    vframes = list(range(0, n_frames, a.views_every))
    images, where = [], []
    for v in view_ids:
        got = read_video_frames(a.run / "views" / "videos" / f"{v:02d}.mp4", vframes)
        for i in vframes:
            if i in got:
                images.append(got[i])
                where.append((i, v))
    vmasks = foreground(images, dev)
    print(f"[check] {len(images)} generated views cut out ({time.time() - t0:.0f}s)", flush=True)
    by_frame: dict[int, list[int]] = {}
    for k, (i, v) in enumerate(where):
        by_frame.setdefault(i, []).append(k)
    for i, ks in by_frame.items():
        g = read_spz(bundle / fr["dir"] / (pattern % i))
        base = tensors(g, dev)
        sums = {n: {"psnr": [], "ssim": [], "spill": []} for n in names}
        for k in ks:
            _, v = where[k]
            c = cams[v]
            w2c = np.linalg.inv(np.asarray(c["camera_to_world"], float)) @ b2w
            K = np.asarray(c["K"], float)
            W, H = int(c["image_width"]), int(c["image_height"])
            m = torch.as_tensor(vmasks[k], device=dev)
            gt = torch.as_tensor(images[k], device=dev).float() / 255.0 * m[..., None] + (1 - m[..., None])
            near = dilate(m > 0.5, 6)
            for vi, name in enumerate(names):
                with torch.no_grad():
                    pred, alpha = raster(subset(base, keep_of(vi, i, g.count)), w2c, K, W, H, [1.0, 1.0, 1.0])
                sums[name]["psnr"].append(psnr_of(pred, gt))
                sums[name]["ssim"].append(float(ssim(pred[None], gt[None])))
                sums[name]["spill"].append(float((alpha * (~near)).sum() / alpha.sum().clamp_min(1e-6)))
        report["frames"].setdefault(str(i), {})["views"] = {n: {k: float(np.mean(v)) for k, v in s.items()} for n, s in sums.items()}
    del images, vmasks
    print(f"[check] generated views measured ({time.time() - t0:.0f}s)", flush=True)

    # --- summary -----------------------------------------------------------------------------------------------
    def mean_of(kind: str, name: str, key: str, held: bool | None = None) -> float | None:
        vals = []
        for f in report["frames"].values():
            if kind not in f or name not in f[kind]:
                continue
            if held is not None and f.get("held") != held:
                continue
            x = f[kind][name].get(key)
            if x is not None and not (isinstance(x, float) and math.isnan(x)):
                vals.append(x)
        return round(float(np.mean(vals)), 4) if vals else None

    summary = {}
    for name in names:
        s = {}
        for key in ("psnr", "psnrPerson", "ssim", "iou", "spill", "sharp", "faceSharp", "facePsnr", "flicker"):
            s[f"real.{key}"] = mean_of("real", name, key)
            s[f"realHeld.{key}"] = mean_of("real", name, key, held=True)
        for key in ("psnr", "ssim", "spill"):
            s[f"views.{key}"] = mean_of("views", name, key)
        summary[name] = s
    vals = [f["real"]["sharpTruth"] for f in report["frames"].values() if "real" in f and "sharpTruth" in f["real"]]
    fvals = [f["real"]["faceSharpTruth"] for f in report["frames"].values() if "real" in f and "faceSharpTruth" in f["real"]]
    summary["truth"] = {"real.sharp": round(float(np.nanmean(vals)), 4) if vals else None,
                        "real.faceSharp": round(float(np.nanmean(fvals)), 4) if fvals else None}
    report["summary"] = summary
    report["seconds"] = round(time.time() - t0, 1)

    (a.out / "check.json").write_text(json.dumps(report, indent=1))

    # --- contact sheets: before | variant | what it dropped, from five sides; and from the real camera ---------
    pw, ph = (int(x) for x in a.panel.split("x"))
    shown = [names.index(x) for x in a.sheet_variant.replace(":", ",").split(",") if x in names] or ([1] if len(names) > 1 else [0])
    if a.sheets == "auto":
        picks = {0, n_frames // 4, n_frames // 2, (3 * n_frames) // 4, n_frames - 1}
        for sv in shown:  # and the frames where each shown variant drops the most
            if sv:
                drops = sorted(((~k).sum(), i) for i, k in variants[sv - 1][1].items())
                picks |= {i for _, i in drops[-2:]}
        picks = sorted(picks)
    else:
        picks = [int(x) for x in a.sheets.replace(":", ",").split(",") if x]
    height_box = dream.get("bounds") or {"min": [0, 0, 0], "max": [0, 1.8, 0]}
    from PIL import Image

    for i in picks:
        g = read_spz(bundle / fr["dir"] / (pattern % i))
        base = tensors(g, dev)
        solid = g.means[g.opacities > 0]
        solid = solid if len(solid) > 100 else g.means
        lo, hi = min(0.0, float(np.percentile(solid[:, 1], 0.5))), float(np.percentile(solid[:, 1], 99.5))
        top = max(hi, float(height_box["max"][1]))
        mid = (lo + top) / 2
        centre = tuple(np.median(solid[:, [0, 2]], 0))
        fy = 0.5 * ph / math.tan(math.radians(40.0) / 2)
        K = np.array([[fy, 0, pw / 2], [0, fy, ph / 2], [0, 0, 1.0]])
        radius = 1.15 * (top - lo) / 2 / math.tan(math.radians(40.0) / 2) + 0.3
        bg = [0.16, 0.16, 0.16]
        views = [orbit_camera(ang, radius, mid + 0.05 * (top - lo), mid, centre) for ang in ANGLES]
        with torch.no_grad():
            before = [label(to_u8(raster(base, vm, K, pw, ph, bg)[0]), f"before f{i} {round(math.degrees(ang))}deg")
                      for vm, ang in zip(views, ANGLES)]
        for sv in shown:
            if not sv:
                Image.fromarray(np.concatenate(before, 1)).save(a.out / f"sheet-{i:06d}.jpg", quality=88)
                continue
            keep = keep_of(sv, i, g.count)
            keep = np.ones(g.count, bool) if keep is None else keep
            after, gone = [], []
            for vm, ang in zip(views, ANGLES):
                with torch.no_grad():
                    after.append(label(to_u8(raster(subset(base, keep), vm, K, pw, ph, bg)[0]),
                                       f"{names[sv]} f{i} {round(math.degrees(ang))}deg"))
                    gone.append(label(to_u8(raster(subset(base, ~keep), vm, K, pw, ph, [0.5, 0.5, 0.5])[0]),
                                      f"dropped {int((~keep).sum())}"))
            rows = [np.concatenate(r, 1) for r in (before, after, gone)]
            Image.fromarray(np.concatenate(rows, 0)).save(a.out / f"sheet-{names[sv]}-{i:06d}.jpg", quality=88)
    # the real camera: truth | before | variant | dropped, for the same frames
    if (refined or any(c["camera"] for c in chunks)) and clip.exists():
        rgb = read_video_frames(clip, picks)
        real_picks = [i for i in picks if i in rgb]
        masks = foreground([rgb[i] for i in real_picks], dev)
        tiles: dict[int, list] = {sv: [] for sv in shown if sv}
        for k, i in enumerate(real_picks):
            m = masks[k]
            box = bbox(m)
            H, W = m.shape
            rc = real_camera(i, chunks, refined, W, H, b2w)
            if box is None or rc is None:
                continue
            w2c, K, held = rc
            x0, y0, x1, y1 = box
            mx, my = int(0.06 * (x1 - x0)), int(0.04 * (y1 - y0))
            x0, y0, x1, y1 = max(0, x0 - mx), max(0, y0 - my), min(W, x1 + mx), min(H, y1 + my)
            r = min(1.0, 1280 / (y1 - y0))
            w, h = int(round((x1 - x0) * r)), int(round((y1 - y0) * r))
            K[0, 2] -= x0
            K[1, 2] -= y0
            K[:2] *= r
            g = read_spz(bundle / fr["dir"] / (pattern % i))
            base = tensors(g, dev)
            gt = torch.as_tensor(rgb[i][y0:y1, x0:x1], device=dev).float() / 255.0
            gm = torch.as_tensor(m[y0:y1, x0:x1], device=dev)[..., None]
            gt = (gt * gm + (1 - gm)).permute(2, 0, 1)[None]
            gt = F.interpolate(gt, size=(h, w), mode="area")[0].permute(1, 2, 0)
            with torch.no_grad():
                b_img = raster(base, w2c, K, w, h, [1.0, 1.0, 1.0])[0]
            for sv in tiles:
                keep = keep_of(sv, i, g.count)
                keep = np.ones(g.count, bool) if keep is None else keep
                with torch.no_grad():
                    v_img = raster(subset(base, keep), w2c, K, w, h, [1.0, 1.0, 1.0])[0]
                    d_img = raster(subset(base, ~keep), w2c, K, w, h, [0.5, 0.5, 0.5])[0]
                row = [label(to_u8(gt), f"real f{i}" + (" held out" if held else "")), label(to_u8(b_img), "before"),
                       label(to_u8(v_img), names[sv]), label(to_u8(d_img), "dropped")]
                tiles[sv].append(np.concatenate([fit(x, 400, 760) for x in row], 1))
        for sv, t in tiles.items():
            if t:
                Image.fromarray(np.concatenate(t, 0)).save(a.out / f"real-camera-{names[sv]}.jpg", quality=88)
    print("[check] summary", json.dumps(summary), flush=True)
    print(f"CHECK_OK {dream['id']} {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
