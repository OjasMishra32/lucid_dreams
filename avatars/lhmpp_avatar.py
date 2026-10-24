#!/usr/bin/env python3
"""Many photos of one person -> one animatable Gaussian person with LHM++ -> an avatar dream bundle.

LHM++ (aigc3d/LHM-plusplus, Tongyi Lab, March 2026; code Apache-2.0, weights CC BY-NC 4.0) reads any
number of pose-free photos of one person and predicts Gaussians on a dense SMPL-X body in one forward pass, so every
photo shapes the same person instead of one photo guessing the rest. We ship only its plain Gaussians: the neural
refiner that LHM++ renders through in its paper and demo can't run on a Quest, so every render here is our own gsplat
render of the bundle's avatar.ply, posed by the bundle's own skin.bin and motion.json.

Four subcommands, three environments (avatars/hpg/lhmpp-avatar.sbatch runs them):
  colour  envs/lam + DDColor photos/ -> <work>/colour/: black-and-white photos get natural colour (DDColor, ICCV 2023,
                             Apache-2.0, as lam-head.sbatch does), on the photo, never on the Gaussians; colour
                             photos and crops.json are linked through unchanged
  prep    envs/digs (rembg)  photos/*.jpg [+ crops.json] -> <work>/prep/{raw,matte}/*.jpg: a tight crop around the
                             person (raw keeps the background, as LHM++'s own examples do; matte puts it on white)
  build   envs/lhmpp, GPU, from the LHM++ checkout (it reads ./pretrained_models)
                             LHM++ per variant -> SMPL-X zero-pose Gaussians + LHM++'s own skinning weights
                             -> <work>/<variant>/<id>/ bundle (avatar.ply, skin.bin, skeleton.json, motion.json,
                             preview.mp4, thumb.jpg), checked against LHM++'s own posing; renders of each
  compare envs/lhmpp, GPU    the same renders for any bundles, side by side with the photos, plus an ArcFace
                             identity score of each face against the photos

crops.json (optional, next to the photos): {"<photo>": [x0, y0, x1, y1]} as fractions of the photo, the region that
holds only this person (no neighbour, no opponent); the matte finds the person inside it.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

PHOTO_EXT = {".jpg", ".jpeg", ".png"}
MODEL_NAME = "LHMPP-700M-PixelShuffle"
MODEL_CONFIG = "./configs/train/LHMPP-pixelshuffle.yaml"
PREP_MAX = (1008, 1680)  # (w, h): twice LHM++'s 504 x 840 input; its own pipeline does the last resize
IDLE_SECONDS = 8.0
MIN_OPACITY = 1 / 255
WHITE = (255, 255, 255)

# Renders: a portrait lens on the head (camera 1.8 m away, 14 degree vertical field of view) and a full-body view, each
# from the front, 45, 90, 135 and 180 degrees round the person. Angles turn round +Y from the person's front (-Z).
PORTRAIT = dict(distance=1.8, fov=14.0, size=(768, 1024))
FULL = dict(distance=4.2, fov=28.0, size=(720, 1440))
ANGLES = (0, 45, 90, 135, 180)


def photos_in(folder: Path, limit: int) -> list[Path]:
    photos = sorted(p for p in folder.iterdir() if p.suffix.lower() in PHOTO_EXT and not p.name.startswith("."))
    if not photos:
        raise SystemExit(f"no photos in {folder}")
    return photos[:limit]


# --------------------------------------------------------------------------------------------------------- colour
def is_grey(path: Path) -> bool:
    """Black and white (or sepia): the same test as lucid.monochrome and lam-head.sbatch."""
    from PIL import Image

    img = np.asarray(Image.open(path).convert("RGB").resize((256, 256)), dtype=np.float32)
    return bool(np.percentile(img.max(axis=2) - img.min(axis=2), 95) < 12)


def colour(args) -> None:
    import os

    folder, out = Path(args.photos), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for f in out.iterdir():
        f.unlink()
    pipe = None
    for p in sorted(folder.iterdir()):
        if p.name.startswith("."):
            continue
        if p.suffix.lower() not in PHOTO_EXT or not is_grey(p):
            os.symlink(p.resolve(), out / p.name)
            continue
        if pipe is None:
            import torch
            from ddcolor import ColorizationPipeline, DDColor
            from huggingface_hub import PyTorchModelHubMixin

            class DDColorHF(DDColor, PyTorchModelHubMixin):
                def __init__(self, config=None, **kwargs):
                    if isinstance(config, dict):
                        kwargs = {**config, **kwargs}
                    super().__init__(**kwargs)

            model = DDColorHF.from_pretrained("piddnad/ddcolor_modelscope").cuda().eval()
            pipe = ColorizationPipeline(model, input_size=512, device=torch.device("cuda"))
        import cv2

        cv2.imwrite(str(out / p.name), pipe.process(cv2.imread(str(p))), [cv2.IMWRITE_JPEG_QUALITY, 95])
        print(f"[colour] {p.name}: black and white, colourised")
    print("COLOUR_OK")


# ----------------------------------------------------------------------------------------------------------- prep
def prep(args) -> None:
    """Tight crops around the person, two ways: raw (background kept) and matte (on white)."""
    import rembg
    from PIL import Image, ImageOps
    from scipy import ndimage

    folder = Path(args.photos)
    crops_file = folder / "crops.json"
    crops = json.loads(crops_file.read_text()) if crops_file.is_file() else {}
    out = Path(args.work) / "prep"
    for v in ("raw", "matte"):
        (out / v).mkdir(parents=True, exist_ok=True)
    session = rembg.new_session(args.rembg_model, providers=["CPUExecutionProvider"])
    record = []
    for p in photos_in(folder, args.max_views):
        img = ImageOps.exif_transpose(Image.open(p)).convert("RGB")
        box = crops.get(p.name)
        if box:
            W, H = img.size
            img = img.crop((round(box[0] * W), round(box[1] * H), round(box[2] * W), round(box[3] * H)))
        small = img.copy()
        small.thumbnail((1600, 1600))
        alpha = rembg.remove(small, session=session, only_mask=True).resize(img.size, Image.BILINEAR)
        a = np.asarray(alpha, dtype=np.float32) / 255
        labels, n = ndimage.label(a > 0.5)
        if n == 0:
            print(f"[prep] {p.name}: no person found, skipped")
            continue
        sizes = ndimage.sum(np.ones_like(a), labels, range(1, n + 1))
        person = labels == (1 + int(np.argmax(sizes)))
        # keep the soft edge of the main person only: alpha inside a few pixels of its solid region
        near = ndimage.binary_dilation(person, iterations=max(3, round(0.004 * max(a.shape))))
        a = np.where(near, a, 0.0)
        ys, xs = np.nonzero(a > 0.1)
        x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
        crop = np.asarray(img)[y0:y1, x0:x1].astype(np.float32)
        ac = a[y0:y1, x0:x1, None]
        variants = {"raw": crop, "matte": crop * ac + 255 * (1 - ac)}
        for v, arr in variants.items():
            im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
            im.thumbnail(PREP_MAX, Image.LANCZOS)
            im.save(out / v / f"{p.stem}.jpg", quality=95)
        record.append({"photo": p.name, "crop": box, "person_px": [int(x1 - x0), int(y1 - y0)]})
        print(f"[prep] {p.name}: person {x1 - x0} x {y1 - y0} px")
    (out / "prep.json").write_text(json.dumps(record, indent=1) + "\n")
    contact_sheet(sorted((out / "raw").glob("*.jpg")), out / "raw.jpg")
    contact_sheet(sorted((out / "matte").glob("*.jpg")), out / "matte.jpg")
    print(f"PREP_OK {len(record)} photos")


def contact_sheet(paths, dest: Path, height: int = 420) -> None:
    from PIL import Image

    tiles = []
    for p in paths:
        im = Image.open(p).convert("RGB")
        tiles.append(im.resize((round(im.width * height / im.height), height), Image.LANCZOS))
    if not tiles:
        return
    sheet = Image.new("RGB", (sum(t.width for t in tiles), height), WHITE)
    x = 0
    for t in tiles:
        sheet.paste(t, (x, 0))
        x += t.width
    sheet.save(dest, quality=90)


# ------------------------------------------------------------------------------------------------ LHM++ inference
def load_lhmpp(model_path: str):
    """LHM++ the way its own scripts build it (scripts/inference/app_inference.py), without its auto-download module."""
    import os

    import torch

    sys.path.insert(0, os.getcwd())
    os.environ.update({"APP_ENABLED": "1", "APP_MODEL_NAME": MODEL_NAME, "APP_TYPE": "infer.human_lrm_a4o",
                       "NUMBA_THREADING_LAYER": "omp"})
    torch._dynamo.config.disable = True
    from accelerate import Accelerator

    from scripts.inference.app_inference import build_app_model, parse_app_configs

    Accelerator()  # LHM++ logs through accelerate, which refuses to log before its state exists

    cfg, _ = parse_app_configs({MODEL_NAME: {"model_path": model_path, "model_config": MODEL_CONFIG}})
    model = build_app_model(cfg)
    model.to("cuda")  # LHM++'s .to() returns None
    model.eval()
    patch_point_attention()
    return model, cfg


def patch_point_attention() -> None:
    """LHM++'s point transformer (Sonata / PTv3) attends within patches of 4096 points through flash-attn; without it
    the fallback writes out every 4096 x 4096 attention matrix (tens of GB, more than an L4 has). The same attention
    through torch's memory-efficient SDPA kernel never materialises them: same maths, no extra install."""
    import torch
    import torch.nn.functional as F

    import core.models.encoders.sonata.model as sonata

    flash_forward = sonata.SerializedAttention.forward

    def forward(self, point):
        if self.enable_flash:
            return flash_forward(self, point)
        self.patch_size = min(sonata.offset2bincount(point.offset).min().tolist(), self.patch_size_max)
        H, K, C = self.num_heads, self.patch_size, self.channels
        pad, unpad, _ = self.get_padding_and_inverse(point)
        order = point.serialized_order[self.order_index][pad]
        inverse = unpad[point.serialized_inverse[self.order_index]]
        qkv = self.qkv(point.feat)[order]
        q, k, v = qkv.reshape(-1, K, 3, H, C // H).permute(2, 0, 3, 1, 4).unbind(dim=0)
        with torch.backends.cuda.sdp_kernel(enable_flash=False, enable_math=False, enable_mem_efficient=True):
            feat = F.scaled_dot_product_attention(q.float().contiguous(), k.float().contiguous(),
                                                  v.float().contiguous(), scale=self.scale)
        feat = feat.to(qkv.dtype).transpose(1, 2).reshape(-1, C)[inverse]
        point.feat = self.proj_drop(self.proj(feat))
        return point

    sonata.SerializedAttention.forward = forward


def lhmpp_pipeline():
    """LHM++'s own source-image step (pad to 5:3 on white, fit 840 x 504), loaded by path: importing core.datasets
    pulls in its training data loaders."""
    import importlib.util
    import os

    spec = importlib.util.spec_from_file_location("lhmpp_data_utils", os.path.join(os.getcwd(), "core/datasets/data_utils.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.SrcImagePipeline(dict(name="PadRatioWithScale", target_ratio=5 / 3, tgt_max_size_list=[840], val=True))


def neutral_frame(cfg, device):
    """One zero-pose SMPL-X frame and a synthetic camera, shaped like LHM++'s motion batches (to_gs_ply.py)."""
    import torch

    W = int(cfg.get("render_size", 420))
    H = int(round(W * 5 / 3))
    f = float(max(W, H))
    z = lambda *s: torch.zeros(*s, device=device)  # noqa: E731
    smplx = {
        "betas": z(1, 10), "root_pose": z(1, 1, 3), "body_pose": z(1, 1, 21, 3), "jaw_pose": z(1, 1, 3),
        "leye_pose": z(1, 1, 3), "reye_pose": z(1, 1, 3), "lhand_pose": z(1, 1, 15, 3), "rhand_pose": z(1, 1, 15, 3),
        "trans": z(1, 1, 3), "expr": z(1, 1, 100),
        "focal": torch.tensor([[[f, f]]], device=device), "princpt": torch.tensor([[[W / 2, H / 2]]], device=device),
        "img_size_wh": torch.tensor([[[float(W), float(H)]]], device=device),
    }
    K = torch.eye(4, device=device)
    K[0, 0] = K[1, 1] = f
    K[0, 2], K[1, 2] = W / 2, H / 2
    cams = dict(render_c2ws=torch.eye(4, device=device)[None, None], render_intrs=K[None, None],
                render_bg_colors=torch.ones(1, 1, 3, device=device))
    return smplx, cams


def run_lhmpp(model, cfg, images: list[np.ndarray]):
    """images: (H, W, 3) floats in [0, 1], already through LHM++'s pipeline. Returns what export needs."""
    import torch

    dev = torch.device("cuda")
    smplx, cams = neutral_frame(cfg, dev)
    ref = torch.from_numpy(np.stack(images)).permute(0, 3, 1, 2).float().to(dev)
    torch.cuda.synchronize()
    t0 = time.time()
    with torch.no_grad():
        out = model.infer_single_view(ref[None], None, None, smplx_params=smplx,
                                      ref_imgs_bool=torch.ones(1, len(images), dtype=torch.bool, device=dev),
                                      return_pred_shape=True, **cams)
    torch.cuda.synchronize()
    seconds = time.time() - t0
    gs_list, query_points, tmnp = out[0], out[1], out[2]
    pred_shape = out[-1] if len(out) == 8 else None
    merged = type(model).smplx_params_with_pred_shape_betas(smplx, pred_shape)
    return dict(gs=gs_list[0], query_points=query_points, tmnp=tmnp, smplx=smplx, betas=merged["betas"],
                seconds=seconds, peak_gb=torch.cuda.max_memory_allocated() / 1e9)


def lhm_frame(model, res, root_pose=None, body=None, trans=None):
    """LHM++'s own posing of its Gaussians for one SMPL-X frame (zero pose when nothing is given)."""
    import torch

    sp = dict(res["smplx"])
    sp["betas"] = res["betas"]
    sp["transform_mat_neutral_pose"] = res["tmnp"]
    r = model.renderer
    one = r._get_single_batch_data(r.get_single_view_smpl_data(sp, 0), 0)
    if body is not None:
        t = lambda a: torch.as_tensor(np.asarray(a), dtype=torch.float32, device=res["betas"].device)  # noqa: E731
        one = dict(one, root_pose=t(root_pose)[None], body_pose=t(body[1:22])[None], jaw_pose=t(body[22])[None],
                   leye_pose=t(body[23])[None], reye_pose=t(body[24])[None], lhand_pose=t(body[25:40])[None],
                   rhand_pose=t(body[40:55])[None], trans=t(trans)[None])
    with torch.no_grad():
        anim, _ = r.animate_gs_model(res["gs"], res["query_points"]["neutral_coords"][0], one,
                                     mesh_meta=res["query_points"]["mesh_meta"])
    return anim[0]


def lhm_skinning(model, res) -> np.ndarray:
    """(N, 55) per-Gaussian joint weights exactly as LHM++ poses with them: its diffused voxel skinning field at each
    Gaussian's canonical position, the SMPL-X mesh weights for hand and face points (get_transform_mat_vertex)."""
    import torch

    sm = model.renderer.smplx_model
    with torch.no_grad():
        pts = res["query_points"]["neutral_coords"][0] + res["gs"].offset_xyz
        w = sm.query_voxel_skinning_weights(pts.reshape(1, -1, 3)).reshape(-1, sm.base_skinning.joint_num)
        fixed = (sm.is_rhand + sm.is_lhand + sm.is_face) > 0
        w[fixed] = sm.skinning_weight[fixed].to(w)
    return w.float().cpu().numpy()


def lhm_rest_joints(model, res) -> np.ndarray:
    import torch

    with torch.no_grad():
        j = model.renderer.smplx_model.get_zero_pose_human(shape_param=res["betas"], device=res["betas"].device,
                                                           face_offset=None, joint_offset=None)
    return j[0].float().cpu().numpy()


# --------------------------------------------------------------------------------------------------------- export
def to_gaussians(gm):
    """An LHM++ GaussianModel (activated values, RGB colour) as standard 3DGS PLY values."""
    import torch

    from lucid_avatars.gaussian_ply import SH_C0, Gaussians

    with torch.no_grad():
        rgb = gm.shs.reshape(len(gm.xyz), -1, 3)[:, 0].clamp(0, 1)
        op = gm.opacity.reshape(-1).clamp(1e-4, 1 - 1e-4)
        g = Gaussians(
            xyz=gm.xyz.double().cpu().numpy(),  # float64 like the other exporters (bounds go to JSON)
            f_dc=((rgb - 0.5) / SH_C0).float().cpu().numpy(),
            f_rest=np.zeros((len(gm.xyz), 0), np.float32),
            opacity=torch.log(op / (1 - op)).float().cpu().numpy(),
            scale=torch.log(gm.scaling.clamp_min(1e-8)).float().cpu().numpy(),
            rotation=torch.nn.functional.normalize(gm.rotation, dim=-1).float().cpu().numpy(),
        )
    return g


def subset(g, keep):
    from dataclasses import replace

    return replace(g, xyz=g.xyz[keep], f_dc=g.f_dc[keep], f_rest=g.f_rest[keep], opacity=g.opacity[keep],
                   scale=g.scale[keep], rotation=g.rotation[keep])


def hand_mean(smplx_npz: str) -> np.ndarray:
    d = np.load(smplx_npz, allow_pickle=True)
    return np.concatenate([np.asarray(d["hands_meanl"]).reshape(45), np.asarray(d["hands_meanr"]).reshape(45)])


def export_bundle(model, res, dest: Path, dream_id: str, name: str, photos: list[str], variant: str, args) -> dict:
    """Bundle in dest/<dream_id>/ (validated). Returns the numbers for the report."""
    from lucid_avatars import skinning as S
    from lucid_avatars.bundle import write_avatar_bundle
    from lucid_avatars.digs_io import stand_y, with_hand_mean
    from lucid_avatars.idle import idle_loop
    from lucid_avatars.smplx_layout import NUM_JOINTS

    rest_gm = lhm_frame(model, res)
    g = to_gaussians(rest_gm)
    weights = lhm_skinning(model, res)
    if weights.shape != (len(g), NUM_JOINTS):
        raise SystemExit(f"LHM++ skinning is {weights.shape}, expected ({len(g)}, {NUM_JOINTS})")
    keep = 1 / (1 + np.exp(-g.opacity)) >= MIN_OPACITY
    g, weights = subset(g, keep), weights[keep]
    rest = lhm_rest_joints(model, res)
    betas = res["betas"][0].float().cpu().numpy().astype(np.float64)

    # LHM++'s SMPL-X must be ours: the rest joints of these betas from our own SMPL-X file
    sm = np.load(args.smplx, allow_pickle=True)
    ours, _ = S.rest_joints(sm["v_template"], sm["shapedirs"][:, :, :10], sm["J_regressor"], betas)
    joint_gap = float(np.abs(ours - rest).max())
    print(f"[export] rest joints vs our SMPL-X: max {joint_gap * 1000:.2f} mm")
    if joint_gap > 0.005:
        raise SystemExit("LHM++'s SMPL-X differs from ours: skeleton.json wouldn't match the rig")

    idx, q = S.quantize_top4(weights)
    stand = stand_y(g.xyz, g.opacity)
    motion = with_hand_mean(idle_loop(betas, IDLE_SECONDS, 30, stand), hand_mean(args.smplx))
    source = {"photos": photos, "views": len(photos), "variant": variant,
              "model": f"LHM++ {MODEL_NAME} (aigc3d/LHM-plusplus), plain Gaussians (no neural refiner)",
              "note": "avatar.ply is the SMPL-X zero pose (flat hands); skin.bin is LHM++'s own skinning (its diffused "
                      "voxel field, SMPL-X mesh weights on hands and face), top 4; motion.json holds the hands in "
                      "SMPL-X's relaxed hand mean"}
    if args.credit:
        source["credit"] = args.credit
    metrics = {"psnr": None, "ssim": None, "lpips": None, "views": len(photos)}
    root = write_avatar_bundle(dest, dream_id, name, g, motion, source=source, metrics=metrics, skin=(idx, q),
                               skeleton=S.skeleton_dict(rest))

    # Check: our skinning (skin.bin + skin_matrices, what every player does) against LHM++'s own posing, on
    # motion.json's first frame
    f0 = 0
    posed_lhm = to_gaussians(lhm_frame(model, res, root_pose=quat_xyzw_to_aa(motion.root_q[f0]),
                                       body=motion.pose[f0], trans=motion.root_t[f0])).xyz[keep]
    M = S.skin_matrices(rest, motion.root_q[f0], motion.root_t[f0], motion.pose[f0])
    posed_ours = S.pose_points(g.xyz, idx, q, M)
    full = np.einsum("nj,jab->nab", weights.astype(np.float64), M)  # all 55 weights, unquantised: the rig alone
    posed_full = np.einsum("nab,nb->na", full[:, :3, :3], g.xyz) + full[:, :3, 3]
    mm = lambda e, f: round(float(f(e)) * 1000, 2)  # noqa: E731
    err = np.linalg.norm(posed_ours - posed_lhm, axis=1)
    rig = np.linalg.norm(posed_full - posed_lhm, axis=1)
    check = {"median_mm": mm(err, np.median), "p99_mm": mm(err, lambda e: np.percentile(e, 99)), "max_mm": mm(err, np.max),
             "rig_only_max_mm": mm(rig, np.max)}
    print(f"[export] skin.bin posing vs LHM++'s own, frame 0: {check}")

    dream_path = root / "dream.json"
    dream = json.loads(dream_path.read_text())
    dream["intent"] = args.intent or None
    dream["metrics"]["lbsCheckMm"] = check
    dream_path.write_text(json.dumps(dream, indent=2) + "\n")
    alpha = 1 / (1 + np.exp(-g.opacity))
    vis = g.xyz[alpha >= 0.5]
    numbers = {"gaussians": int(len(g)), "dropped_transparent": int((~keep).sum()),
               "height_m": round(float(vis[:, 1].max() - vis[:, 1].min()), 3), "stand_y": round(stand, 4),
               "betas": np.round(betas, 4).tolist(), "joint_gap_mm": round(joint_gap * 1000, 3), "lbs_check": check}
    return numbers


def quat_xyzw_to_aa(q) -> np.ndarray:
    q = np.asarray(q, dtype=np.float64)
    q = q / np.linalg.norm(q)
    if q[3] < 0:
        q = -q
    s = np.linalg.norm(q[:3])
    if s < 1e-12:
        return np.zeros(3)
    return q[:3] / s * 2 * math.atan2(s, q[3])


# --------------------------------------------------------------------------------------------------------- render
def posed_gaussians(bundle: Path, frame: int = 0):
    """The bundle's avatar posed by its own skin.bin + motion.json frame, as torch tensors on the GPU."""
    import torch
    from pytorch3d.transforms import matrix_to_quaternion, quaternion_multiply

    from lucid_avatars import skinning as S
    from lucid_avatars.gaussian_ply import SH_C0, read_ply
    from lucid_avatars.motion import Motion

    dream = json.loads((bundle / "dream.json").read_text())
    av = dream["avatar"]
    g = read_ply(bundle / av["file"])
    idx, q = S.read_skin_bin(bundle / av["skin"])
    rest = np.asarray(json.loads((bundle / av["skeleton"]).read_text())["rest"])
    m = Motion.load(bundle / av["motion"])
    M = S.skin_matrices(rest, m.root_q[frame], m.root_t[frame], m.pose[frame])
    dev = "cuda"
    w = torch.as_tensor(q, dtype=torch.float32, device=dev) / 255
    Mt = torch.as_tensor(M, dtype=torch.float32, device=dev)[torch.as_tensor(idx.astype(np.int64), device=dev)]
    B = torch.einsum("nk,nkab->nab", w, Mt)
    xyz = torch.as_tensor(g.xyz, dtype=torch.float32, device=dev)
    means = torch.einsum("nab,nb->na", B[:, :3, :3], xyz) + B[:, :3, 3]
    U, _, Vh = torch.linalg.svd(B[:, :3, :3])
    R = U @ Vh
    quats = quaternion_multiply(matrix_to_quaternion(R),
                                torch.nn.functional.normalize(torch.as_tensor(g.rotation, dtype=torch.float32, device=dev), dim=-1))
    deg = g.sh_degree
    if deg == 0:
        colors = (0.5 + SH_C0 * torch.as_tensor(g.f_dc, dtype=torch.float32, device=dev)).clamp_min(0)
    else:  # f_rest is grouped by channel: (N, 3 * (K - 1)) -> (N, K, 3); colours stay unrotated (fine for renders)
        rest_c = torch.as_tensor(g.f_rest, dtype=torch.float32, device=dev).reshape(len(g), 3, -1).transpose(1, 2)
        colors = torch.cat([torch.as_tensor(g.f_dc, dtype=torch.float32, device=dev)[:, None], rest_c], dim=1)
    return dict(means=means, quats=quats, scales=torch.exp(torch.as_tensor(g.scale, dtype=torch.float32, device=dev)),
                opacities=torch.sigmoid(torch.as_tensor(g.opacity, dtype=torch.float32, device=dev)),
                colors=colors, sh_degree=None if deg == 0 else deg,
                head=(M[15] @ np.r_[rest[15], 1.0])[:3], dream=dream)


def look_at(eye, target) -> np.ndarray:
    """World -> OpenCV camera (x right, y down, z forward), +Y up."""
    eye, target = np.asarray(eye, float), np.asarray(target, float)
    z = target - eye
    z /= np.linalg.norm(z)
    x = np.cross(z, [0.0, 1.0, 0.0])
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    V = np.eye(4)
    V[:3, :3] = np.stack([x, y, z])
    V[:3, 3] = -V[:3, :3] @ eye
    return V


def render(gs: dict, eye, target, size, fov_deg: float) -> np.ndarray:
    import torch
    from gsplat import rasterization

    W, H = size
    f = (H / 2) / math.tan(math.radians(fov_deg) / 2)
    K = torch.tensor([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1]], dtype=torch.float32, device="cuda")
    V = torch.as_tensor(look_at(eye, target), dtype=torch.float32, device="cuda")
    with torch.no_grad():
        img, _, _ = rasterization(gs["means"], gs["quats"], gs["scales"], gs["opacities"], gs["colors"], V[None],
                                  K[None], W, H, near_plane=0.05, sh_degree=gs["sh_degree"],
                                  backgrounds=torch.ones(1, 3, device="cuda"))
    return (img[0].clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)


def orbit_eye(target, distance: float, angle_deg: float) -> np.ndarray:
    """Camera position `angle_deg` round +Y from straight in front of a person who faces -Z."""
    a = math.radians(angle_deg)
    return np.asarray(target, float) + distance * np.array([-math.sin(a), 0.0, -math.cos(a)])


def standard_views(gs: dict) -> dict[str, np.ndarray]:
    head = gs["head"] + np.array([0.0, 0.07, 0.0])  # the head joint sits at the skull base; aim at the face
    views = {f"portrait_{a:03d}": render(gs, orbit_eye(head, PORTRAIT["distance"], a), head, PORTRAIT["size"],
                                         PORTRAIT["fov"]) for a in ANGLES}
    alpha_y = gs["means"][gs["opacities"] > 0.5][:, 1]
    mid = np.array([0.0, float((alpha_y.max() + alpha_y.min()) / 2), 0.0])
    views.update({f"full_{a:03d}": render(gs, orbit_eye(mid, FULL["distance"], a), mid, FULL["size"], FULL["fov"])
                  for a in ANGLES})
    return views


def turntable(gs: dict, dest: Path, frames: int = 120, size=(540, 960)) -> np.ndarray:
    import imageio.v2 as iio

    alpha_y = gs["means"][gs["opacities"] > 0.5][:, 1]
    mid = np.array([0.0, float((alpha_y.max() + alpha_y.min()) / 2), 0.0])
    imgs = [render(gs, orbit_eye(mid, FULL["distance"], 360 * k / frames), mid, size, FULL["fov"]) for k in range(frames)]
    iio.mimwrite(dest, imgs, fps=30, codec="libx264", quality=8, macro_block_size=4)
    return imgs[0]


def save_views(views: dict, folder: Path, prefix: str) -> None:
    from PIL import Image

    folder.mkdir(parents=True, exist_ok=True)
    for k, img in views.items():
        Image.fromarray(img).save(folder / f"{prefix}_{k}.jpg", quality=93)


# ------------------------------------------------------------------------------------------------------- identity
class Identity:
    """ArcFace cosine of a face against the photos' faces: the identity net LHM++ trains its face loss with
    (GFPGAN's ResNet18 ArcFace, pretrained_models/arcface_resnet18.pth) on faces found by MediaPipe's face detector
    (face-detection-tflite, already in LAM's env). A rough, consistent yardstick, not a face-verification system."""

    def __init__(self):
        import torch
        from fdlite import FaceDetection, FaceDetectionModel

        from core.models.arcface_utils import ResNetArcFace

        self.detect = FaceDetection(model_type=FaceDetectionModel.BACK_CAMERA)
        self.net = ResNetArcFace().cuda().eval()
        self.torch = torch

    def embed(self, img: np.ndarray):
        from PIL import Image

        pil = Image.fromarray(img)
        faces = self.detect(pil)
        if not faces:
            return None
        bb = max(faces, key=lambda f: f.bbox.width * f.bbox.height).bbox.scale(pil.size)
        cx, cy, s = (bb.xmin + bb.xmax) / 2, (bb.ymin + bb.ymax) / 2, 1.3 * max(bb.width, bb.height)
        face = pil.crop((round(cx - s / 2), round(cy - s / 2), round(cx + s / 2), round(cy + s / 2))).convert("L")
        x = np.asarray(face.resize((128, 128), Image.BILINEAR), np.float32) / 255
        t = self.torch.from_numpy((x - 0.5) / 0.5)[None, None].cuda()
        with self.torch.no_grad():
            e = self.net(t)[0]
        return (e / e.norm()).cpu().numpy()


def identity_scores(ident: Identity, photo_embs: list, views: dict) -> dict:
    out = {}
    for k in ("portrait_000", "portrait_045", "portrait_090"):
        e = ident.embed(views[k])
        out[k] = None if e is None or not photo_embs else round(float(np.mean([e @ p for p in photo_embs])), 3)
    return out


def photo_embeddings(ident: Identity, prep_dir: Path) -> tuple[list, float | None]:
    from PIL import Image

    embs = [e for p in sorted(prep_dir.glob("*.jpg")) if (e := ident.embed(np.asarray(Image.open(p).convert("RGB")))) is not None]
    pairs = [embs[i] @ embs[j] for i in range(len(embs)) for j in range(i + 1, len(embs))]
    return embs, (round(float(np.mean(pairs)), 3) if pairs else None)


# ------------------------------------------------------------------------------------------------- compare sheet
def compare_sheet(rows: list[tuple[str, dict]], photos_jpg: Path | None, dest: Path) -> None:
    """Per bundle: the full body, then the head, at each angle in ANGLES."""
    from PIL import Image, ImageDraw

    th = 512
    label_w = 230
    tiles = []
    for label, views in rows:
        for kind in ("full", "portrait"):
            ims = [Image.fromarray(views[f"{kind}_{a:03d}"]) for a in ANGLES]
            ims = [im.resize((round(im.width * th / im.height), th), Image.LANCZOS) for im in ims]
            tiles.append((f"{label}  ({kind}: {', '.join(str(a) for a in ANGLES)} deg)", ims))
    width = label_w + max(sum(im.width for im in ims) for _, ims in tiles)
    head = None
    if photos_jpg and photos_jpg.is_file():
        head = Image.open(photos_jpg).convert("RGB")
        head = head.resize((width, round(head.height * width / head.width)), Image.LANCZOS)
    H = (head.height if head else 0) + th * len(tiles)
    sheet = Image.new("RGB", (width, H), WHITE)
    y = 0
    if head:
        sheet.paste(head, (0, 0))
        y = head.height
    d = ImageDraw.Draw(sheet)
    for label, ims in tiles:
        d.text((10, y + 10), label, fill=(0, 0, 0))
        x = label_w
        for im in ims:
            sheet.paste(im, (x, y))
            x += im.width
        y += th
    sheet.save(dest, quality=90)


# ---------------------------------------------------------------------------------------------------------- build
def build(args) -> None:
    from PIL import Image

    from lucid_avatars.bundle import validate_bundle

    work = Path(args.work)
    model, cfg = load_lhmpp(args.model)
    pipe = lhmpp_pipeline()
    report = {"model": MODEL_NAME, "variants": {}}
    ident = None
    try:
        ident = Identity()
    except Exception as e:  # noqa: BLE001 - the score is a bonus, never a reason to fail the build
        print(f"[identity] unavailable: {e}")
    rows = []
    for variant in args.variants.split(","):
        files = sorted((work / "prep" / variant).glob("*.jpg"))[: args.max_views]
        if not files:
            raise SystemExit(f"no prepared photos in {work / 'prep' / variant}: run prep first")
        imgs = pipe([np.asarray(Image.open(f).convert("RGB"), dtype=np.float64) / 255 for f in files])
        Image.fromarray((np.concatenate(imgs, axis=1) * 255).astype(np.uint8)).save(work / f"input_{variant}.jpg", quality=90)
        res = run_lhmpp(model, cfg, imgs)
        print(f"[{variant}] LHM++ on {len(files)} photos: {res['seconds']:.2f} s, peak {res['peak_gb']:.1f} GB")
        dest = work / variant
        if dest.exists():
            shutil.rmtree(dest)
        numbers = export_bundle(model, res, dest, args.id, args.name, [f.stem for f in files], variant, args)
        bundle = dest / args.id
        gs = posed_gaussians(bundle)
        thumb = turntable(gs, bundle / "preview.mp4")
        Image.fromarray(thumb).save(bundle / "thumb.jpg", quality=92)
        dream = json.loads((bundle / "dream.json").read_text())
        dream.update(preview="preview.mp4", thumb="thumb.jpg")
        (bundle / "dream.json").write_text(json.dumps(dream, indent=2) + "\n")
        errors = validate_bundle(bundle)
        if errors:
            raise SystemExit(f"bundle invalid: {errors}")
        print(f"BUNDLE_OK {bundle}")
        views = standard_views(gs)
        save_views(views, work / "renders", f"lhmpp-{variant}")
        numbers.update(seconds=round(res["seconds"], 3), peak_gpu_gb=round(res["peak_gb"], 2), views=len(files))
        if ident:
            try:
                embs, photo_photo = photo_embeddings(ident, work / "prep" / "raw")
                numbers["identity"] = identity_scores(ident, embs, views)
                report["photo_vs_photo_identity"] = photo_photo
            except Exception as e:  # noqa: BLE001
                print(f"[identity] skipped: {e}")
        report["variants"][variant] = numbers
        rows.append((f"LHM++ ({variant}, {len(files)} photos)", views))
    for spec in args.compare_with or []:
        label, path = spec.split("=", 1)
        gs = posed_gaussians(Path(path))
        views = standard_views(gs)
        save_views(views, work / "renders", label)
        entry = {"bundle": path}
        if ident:
            try:
                embs, _ = photo_embeddings(ident, work / "prep" / "raw")
                entry["identity"] = identity_scores(ident, embs, views)
            except Exception as e:  # noqa: BLE001
                print(f"[identity] skipped: {e}")
        report.setdefault("compare", {})[label] = entry
        rows.append((label, views))
    compare_sheet(rows, work / "prep" / "raw.jpg", work / "renders" / "compare.jpg")
    (work / "report.json").write_text(json.dumps(report, indent=1) + "\n")
    print(json.dumps(report, indent=1))
    print("BUILD_OK")


def compare(args) -> None:
    """The standard renders of any bundles, side by side, with identity against a prep folder's photos. Run from the
    LHM++ checkout (the identity net reads ./pretrained_models)."""
    import os

    sys.path.insert(0, os.getcwd())
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    ident, embs, report = None, [], {"bundles": {}}
    try:
        ident = Identity()
        embs, report["photo_vs_photo_identity"] = photo_embeddings(ident, Path(args.photos_prep))
    except Exception as e:  # noqa: BLE001
        print(f"[identity] unavailable: {e}")
    rows, spins = [], []
    for spec in args.bundles:
        label, path = spec.split("=", 1)
        gs = posed_gaussians(Path(path))
        views = standard_views(gs)
        save_views(views, out, label)
        if args.turntable:
            alpha_y = gs["means"][gs["opacities"] > 0.5][:, 1]
            mid = np.array([0.0, float((alpha_y.max() + alpha_y.min()) / 2), 0.0])
            spins.append([render(gs, orbit_eye(mid, FULL["distance"], 360 * k / args.turntable), mid, (480, 960),
                                 FULL["fov"]) for k in range(args.turntable)])
        entry = {"bundle": path, "gaussians": int(len(gs["means"]))}
        if ident and embs:
            try:
                entry["identity"] = identity_scores(ident, embs, views)
            except Exception as e:  # noqa: BLE001
                print(f"[identity] skipped: {e}")
        report["bundles"][label] = entry
        rows.append((label, views))
        print(f"[compare] {label}: {entry}")
    sheet_photos = Path(args.photos_prep).parent / "raw.jpg"
    compare_sheet(rows, sheet_photos, out / "compare.jpg")
    if spins:  # the bundles turning side by side, in the order given
        import imageio.v2 as iio

        iio.mimwrite(out / "turntable.mp4", [np.concatenate(f, axis=1) for f in zip(*spins)], fps=24,
                     codec="libx264", quality=8, macro_block_size=8)
    (out / "compare.json").write_text(json.dumps(report, indent=1) + "\n")
    print(json.dumps(report, indent=1))
    print("COMPARE_OK", out / "compare.jpg")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("colour")
    c.add_argument("--photos", required=True)
    c.add_argument("--out", required=True)
    a = sub.add_parser("prep")
    a.add_argument("--photos", required=True)
    a.add_argument("--work", required=True)
    a.add_argument("--max-views", type=int, default=16)
    a.add_argument("--rembg-model", default="u2net_human_seg")
    b = sub.add_parser("build")
    b.add_argument("--work", required=True)
    b.add_argument("--model", required=True, help="folder with LHM++'s config.json + model.safetensors")
    b.add_argument("--smplx", required=True, help="our SMPLX_NEUTRAL.npz (rest-joint check, hand mean)")
    b.add_argument("--id", required=True)
    b.add_argument("--name", required=True)
    b.add_argument("--variants", default="matte", help="matte and/or raw (see prep)")
    b.add_argument("--max-views", type=int, default=16)
    b.add_argument("--intent", default=None)
    b.add_argument("--credit", default=None)
    b.add_argument("--compare-with", nargs="*", help="label=bundle_dir: render these the same way, side by side")
    d = sub.add_parser("compare")
    d.add_argument("bundles", nargs="+", help="label=bundle_dir")
    d.add_argument("--photos-prep", required=True, help="a prep/raw folder: the photos identity is measured against")
    d.add_argument("--out", required=True)
    d.add_argument("--turntable", type=int, default=0, help="also write turntable.mp4 with this many frames, side by side")
    args = p.parse_args()
    {"colour": colour, "prep": prep, "build": build, "compare": compare}[args.cmd](args)


if __name__ == "__main__":
    main()
