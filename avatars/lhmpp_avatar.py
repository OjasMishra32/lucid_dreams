#!/usr/bin/env python3
"""Many photos of one person -> one animatable Gaussian person with LHM++ -> an avatar dream bundle.

LHM++ (aigc3d/LHM-plusplus, Tongyi Lab, March 2026; code Apache-2.0, weights CC BY-NC 4.0) reads any
number of pose-free photos of one person and predicts Gaussians on a dense SMPL-X body in one forward pass, so every
photo shapes the same person instead of one photo guessing the rest. We ship only its plain Gaussians: the neural
refiner that LHM++ renders through in its paper and demo can't run on a Quest, so every render here is our own gsplat
render of the bundle's avatar.ply, posed by the bundle's own skin.bin and motion.json.

Subcommands, in three environments (avatars/hpg/lhmpp-avatar.sbatch runs the first three):
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
  whites  any numpy env      all-white clothes after lhmpp_cleanup.py: the body's colours back from avatar.raw.ply,
                             then the kit evened to one clean white (see whites())
  polish  any numpy env      close-range finish: marks off light clothes, a clean headband, even limb skin, a clean
                             collar-to-jaw band, a tidy hair outline (see polish())
  audit   envs/lhmpp, GPU    0-315 degrees full body and head, plus tennis-like poses, one sheet per bundle
  headband any numpy env     a clean terry headband as fresh Gaussians on a smooth ring round the head (last step)
  likeness envs/uika, GPU    identity against held-out photos at every yaw, with the photos' own ceiling
  project  envs/uika, GPU    his own face from his photos onto the head model's face (see project())

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
def posed_gaussians(bundle: Path, frame: int = 0, pose=None):
    """The bundle's avatar posed by its own skin.bin + motion.json frame (or `pose`, 55 x 3 axis-angle, with that
    frame's root), as torch tensors on the GPU."""
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
    M = S.skin_matrices(rest, m.root_q[frame], m.root_t[frame], m.pose[frame] if pose is None else pose)
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


def whites(args) -> None:
    """All-white clothes (a tennis kit) after lhmpp_cleanup.py. Its colour passes assume a dark suit (the sleeve-logo
    pass takes the darker half of an arm, the skin, for the cloth, and paints white sleeves brown), so the body's colours
    come back from avatar.raw.ply (the cleanup's geometry, flatten and deflate, stays), then every low-saturation
    Gaussian on the clothes (torso, hips, upper arms, upper legs, ankles and feet: shirt, shorts, socks, shoes,
    wristbands) moves toward the kit's median bright white, keeping a little of its own shading. Greys, specks and dark
    logos on the white go; skin, hair and coloured trim (saturated) stay. A head from a head model (uika_head.json) is
    left as it is."""
    from lucid_avatars import skinning as S
    from lucid_avatars.gaussian_ply import SH_C0, read_ply, write_ply
    from lucid_avatars.smplx_layout import J

    b = Path(args.bundle)
    av = json.loads((b / "dream.json").read_text())["avatar"]
    g = read_ply(b / av["file"])
    idx, q = S.read_skin_bin(b / av["skin"])
    dom = idx[np.arange(len(idx)), np.argmax(q, 1)].astype(int)
    body = ~np.isin(dom, [J["head"], J["jaw"], J["left_eye"], J["right_eye"]])  # a cleaned head keeps its colours
    uika = b / "uika_head.json"
    if uika.is_file():
        body[int(json.loads(uika.read_text())["head"]["first"]):] = False
    raw = b / "avatar" / "avatar.raw.ply"
    restored = 0
    if raw.is_file():
        r = read_ply(raw)
        if len(r) == len(g):
            g.f_dc[body] = r.f_dc[body]
            if g.f_rest.shape == r.f_rest.shape:
                g.f_rest[body] = r.f_rest[body]
            restored = int(body.sum())
        else:
            print(f"[whites] {raw.name} has {len(r)} Gaussians, the bundle {len(g)}: colours not restored")
    cloth_j = [J[n] for n in ("pelvis", "spine1", "spine2", "spine3", "left_collar", "right_collar", "left_shoulder",
                              "right_shoulder", "left_hip", "right_hip", "left_ankle", "right_ankle", "left_foot",
                              "right_foot", "left_wrist", "right_wrist")]
    rgb = np.clip(0.5 + SH_C0 * g.f_dc, 0, 1)
    lum = rgb @ np.array([0.299, 0.587, 0.114])
    sat = rgb.max(1) - rgb.min(1)
    region = body & np.isin(dom, cloth_j)
    # kit: grey or cool (white cloth in shade takes the sky's blue); skin and gold trim are warm and stay
    kit = region & ((sat < args.max_sat) | (rgb[:, 2] >= rgb[:, 0] - 0.02))
    bright = kit & (lum >= np.percentile(lum[kit], 70))
    target = np.median(rgb[bright], axis=0)
    # the photos' whites sit in shade and sky light (a cool grey): half way to neutral, lifted to a clean white
    target = (1 - args.neutral) * target + args.neutral * target.mean()
    target = np.clip(target * args.white_lum / max(float(target @ np.array([0.299, 0.587, 0.114])), 1e-3), 0, 1)
    shade = np.clip(lum[kit] / max(float(np.median(lum[bright])), 1e-3), 0.6, 1.08)[:, None]
    k = args.strength
    rgb[kit] = (1 - k) * rgb[kit] + k * target * (1 - args.keep_shading + args.keep_shading * shade)
    g.f_dc[:] = (np.clip(rgb, 0, 1) - 0.5) / SH_C0
    if g.f_rest.shape[1]:
        g.f_rest[kit] *= 1 - k
    write_ply(b / av["file"], g)
    report = {"restoredFromRaw": restored, "kit": int(kit.sum()), "region": int(region.sum()),
              "white": np.round(target, 4).tolist(), "strength": k, "keepShading": args.keep_shading, "maxSat": args.max_sat,
              "whiteLum": args.white_lum, "neutral": args.neutral}
    (b / "whites.json").write_text(json.dumps(report, indent=1) + "\n")
    print(f"[whites] {report}")


def polish(args) -> None:
    """Close-range finish for a photo opponent's bundle, after lhmpp_cleanup.py (+ whites for a white kit) and a head
    model's finish. Colours and opacities change, and the hips' middle is re-skinned to the pelvis; no Gaussian is
    added, removed or moved, so avatar.raw.ply and uika_head.json stay valid. Each step reports how many Gaussians it touched (polish.json):

      marks   brand marks, side stripes and specks on light clothes (shirt, shorts, socks, shoes, wristbands): a cloth
              Gaussian much darker than the cloth around it (its --mark-k nearest cloth neighbours) takes their colour;
              deep inside the shirt and shorts anything dark is the body's inside and takes the cloth's colour
      midline the hips' front and back middle skinned to the pelvis, so a wide stance doesn't split the cloth
      band    the headband: a grey or dark Gaussian on it (above the eyes, mostly white around it) takes the white
      skin    arms and legs: an edge-preserving filter evens blotches and streaks, a Gaussian far darker than the skin
              around it is lifted to it; hue and tone stay the person's
      neck    the band from collar to jaw (front and sides), the limbs and the feet: what is neither skin nor clean
              cloth (hair-coloured patches, grey smears, dark specks on a hem) takes the colour of whichever its
              neighbours mostly are
      hair    hair strands that stand off the head's outline fade out (the outline is the head's own, direction by
              direction), so the silhouette is a tidy hairline instead of loose wisps
      ring    (--ring) the headband painted all the way round the head
      hem     the shorts' hem as a clean edge
      solid   the body's faint Gaussians made more opaque, so a bright room doesn't show through the clothes
    """
    from scipy.spatial import cKDTree

    from lucid_avatars import skinning as S
    from lucid_avatars.gaussian_ply import SH_C0, read_ply, write_ply
    from lucid_avatars.smplx_layout import J

    b = Path(args.bundle)
    av = json.loads((b / "dream.json").read_text())["avatar"]
    g = read_ply(b / av["file"])
    idx, q = S.read_skin_bin(b / av["skin"])
    dom = idx[np.arange(len(idx)), np.argmax(q, 1)].astype(int)
    rest = np.asarray(json.loads((b / av["skeleton"]).read_text())["rest"], dtype=np.float64)
    xyz = np.asarray(g.xyz, dtype=np.float64)
    rgb = np.clip(0.5 + SH_C0 * np.asarray(g.f_dc, dtype=np.float64), 0, 1)
    alpha = 1 / (1 + np.exp(-np.asarray(g.opacity, dtype=np.float64)))
    W = np.array([0.299, 0.587, 0.114])
    lum = lambda c: c @ W  # noqa: E731
    sat = lambda c: c.max(-1) - c.min(-1)  # noqa: E731
    head_j = [J["head"], J["jaw"], J["left_eye"], J["right_eye"]]
    head = np.isin(dom, head_j)
    uika = b / "uika_head.json"
    if uika.is_file():
        head[int(json.loads(uika.read_text())["head"]["first"]):] = True
    seen = alpha > 0.02
    rep = {}

    # marks: light cloth only (the kit's median is light), never skin (warm, saturated) or the head
    cloth_j = [J[n] for n in ("pelvis", "spine1", "spine2", "spine3", "left_collar", "right_collar", "left_shoulder",
                              "right_shoulder", "left_hip", "right_hip", "left_ankle", "right_ankle", "left_foot",
                              "right_foot", "left_wrist", "right_wrist")]
    warm = (rgb[:, 0] > rgb[:, 2] + 0.05) & (sat(rgb) > 0.08)
    # where the clothes cover the body completely, everything is cloth (a gold side stripe, a skin-coloured smear):
    # the torso below the collar, and the hips and thighs above the shorts' hem (found from how white each height is)
    ny = rest[J["neck"], 1]
    torso = seen & ~head & np.isin(dom, [J["spine1"], J["spine2"], J["spine3"]]) & (xyz[:, 1] < ny - 0.03)
    thigh_j = [J["pelvis"], J["left_hip"], J["right_hip"], J["left_knee"], J["right_knee"]]
    legs = seen & ~head & np.isin(dom, thigh_j)
    whiteish = (lum(rgb) > 0.65) & (sat(rgb) < 0.18)
    hem_y = rest[J["pelvis"], 1]
    for y in np.arange(rest[J["pelvis"], 1], rest[J["left_knee"], 1], -0.01):
        sl = legs & (xyz[:, 1] < y) & (xyz[:, 1] >= y - 0.01)
        if sl.sum() > 30 and whiteish[sl].mean() < 0.5:
            break
        hem_y = y - 0.01
    shorts = legs & (xyz[:, 1] > hem_y + 0.01)
    forced = torso | shorts
    cloth = seen & ~head & (np.isin(dom, cloth_j) | forced) & (~(warm & (lum(rgb) < 0.75)) | forced)
    marks = np.zeros(len(g), bool)
    if cloth.sum() > args.mark_k * 2 and np.median(lum(rgb[cloth])) > 0.6:
        ci = np.flatnonzero(cloth)
        _, nb = cKDTree(xyz[ci]).query(xyz[ci], k=args.mark_k)
        fc = forced[ci]
        for _ in range(2):
            c = rgb[ci]
            med = np.median(c[nb], axis=1)
            off = (lum(c) < lum(med) - args.mark_drop) | (fc & (sat(c) > 0.12) & (sat(med) < 0.12))
            rgb[ci[off]] = med[off]
            marks[ci[off]] = True
    # deep in the clothes (the shirt below its V, the shorts above the hem) nothing is skin: anything dark there is
    # the inside of the body, which shows when a stretch opens the cloth (a wide stance, a lunge), so it is cloth too
    deep = (torso & (xyz[:, 1] < ny - 0.12)) | shorts
    if deep.sum() and cloth.sum():
        di = np.flatnonzero(deep & (lum(rgb) < 0.55))
        if len(di):
            ci = np.flatnonzero(cloth & (lum(rgb) >= 0.55))
            if len(ci):
                _, nn = cKDTree(xyz[ci]).query(xyz[di], k=8)
                rgb[di] = np.median(rgb[ci][nn], axis=1)
                marks[di] = True
    rep["marks"] = int(marks.sum())
    rep["hemY"] = round(float(hem_y), 3)

    # the front and back middle of the hips follow the pelvis, not one thigh: skinned to a thigh they split open
    # down the middle when the legs spread (a split step, a lunge)
    hips = [J["left_hip"], J["right_hip"]]
    hip_y = float(rest[hips, 1].mean())
    mid = seen & ~head & np.isin(dom, hips) & (xyz[:, 1] > hip_y + 0.0) & (np.abs(xyz[:, 0] - rest[J["pelvis"], 0]) < 0.09)
    if mid.sum():
        full = np.abs(xyz[mid, 0] - rest[J["pelvis"], 0]) < 0.05
        mi = np.flatnonzero(mid)
        w = np.zeros((len(mi), 4), np.int64)
        j = np.zeros((len(mi), 4), np.int64)
        j[:, 0] = J["pelvis"]
        j[:, 1] = dom[mi]
        w[:, 0] = np.where(full, 255, 153)
        w[:, 1] = 255 - w[:, 0]
        idx[mi] = j.astype(idx.dtype)
        q[mi] = w.astype(q.dtype)
        S.write_skin_bin(b / av["skin"], idx, q)
    rep["midline"] = int(mid.sum())

    # headband: grey or dark on white, above the eyes
    eye_y = 0.5 * (rest[J["left_eye"], 1] + rest[J["right_eye"], 1])
    hb = seen & head & (xyz[:, 1] > eye_y + 0.015)
    band = np.zeros(len(g), bool)
    if hb.sum() > 64:
        hi = np.flatnonzero(hb)
        _, nb = cKDTree(xyz[hi]).query(xyz[hi], k=32)
        c = rgb[hi]
        # the band is the light, colourless part of the head above the brows (hair is darker and brown, skin warm);
        # a head model fed photos with bands of several colours often makes it grey
        white = (lum(c) > 0.45) & (sat(c) < 0.12)
        frac = white[nb].mean(1)
        bad = ~white & (sat(c) < 0.12) & (frac > 0.6)
        wm = np.array([np.median(c[n[white[n]]], axis=0) if white[n].any() else c[i] for i, n in enumerate(nb)])
        rgb[hi[bad]] = wm[bad]
        band[hi[bad]] = True
        # the band itself one clean white (the photos' bands were white, yellow, red: the look is a white band)
        on = white | bad
        on &= frac > 0.5
        target = np.median(c[white], axis=0)
        target = 0.5 * target + 0.5 * target.mean()  # half the cast out
        target = np.clip(target / max(lum(target), 1e-3) * 0.86, 0, 1)
        shade = np.clip(lum(rgb[hi[on]]) / max(float(np.median(lum(c[white]))), 1e-3), 0.85, 1.05)[:, None]
        rgb[hi[on]] = target * shade
        band[hi[on]] = True
    rep["band"] = int(band.sum())

    # ...and a whole band: a ring round the head at that height (lower at the back, as a band sits), painted on the
    # outermost hair and skin, so it reads from the side and the back too, not only where the photos showed it
    ring = np.zeros(len(g), bool)
    if args.ring and hb.sum() > 64:
        centre = rest[J["head"]] + np.array([0.0, 0.07, -0.01])
        fb = band & (xyz[:, 2] > centre[2] + 0.04)
        y_lo = float(np.percentile(xyz[fb, 1], 20)) if fb.sum() > 30 else eye_y + 0.035
        hd = seen & head & (alpha > 0.1)
        hi = np.flatnonzero(hd)
        d = xyz[hi] - centre
        theta = np.arctan2(d[:, 0], d[:, 2])
        y0 = y_lo - args.ring_drop * (1 - np.cos(theta)) / 2
        inb = (xyz[hi, 1] >= y0) & (xyz[hi, 1] <= y0 + args.ring_height)
        rho = np.hypot(d[:, 0], d[:, 2])
        bins = np.floor((theta + np.pi) / (2 * np.pi) * 36).astype(int)
        outer = np.zeros(len(hi), bool)
        for k in range(36):
            m = inb & (bins == k)
            if m.sum() > 5:
                outer[m] = rho[m] >= np.percentile(rho[m], 30)
        sel = hi[inb & outer & (xyz[hi, 1] > eye_y + 0.02)]
        white_c = np.array([0.84, 0.85, 0.87])
        shade = np.clip(lum(rgb[sel]) / max(float(np.median(lum(rgb[sel]))), 1e-3), 0.9, 1.04)[:, None]
        rgb[sel] = white_c * shade
        g.opacity[sel] = np.maximum(g.opacity[sel], 3.0)
        ring[sel] = True
        rep["ringYFront"] = round(y_lo, 3)
    rep["ring"] = int(ring.sum())

    # skin on the limbs
    limb_j = [J[n] for n in ("left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist",
                             "left_hip", "right_hip", "left_knee", "right_knee")]
    skin = seen & ~head & np.isin(dom, limb_j) & warm & (lum(rgb) < 0.8)
    if skin.sum() > 64:
        si = np.flatnonzero(skin)
        d, nb = cKDTree(xyz[si]).query(xyz[si], k=17)
        ws = np.exp(-(d ** 2) / (2 * args.skin_sigma_m ** 2))
        c = rgb[si].copy()
        for _ in range(args.skin_passes):
            w = ws * np.exp(-((c[nb] - c[:, None]) ** 2).sum(-1) / (2 * 0.2 ** 2))
            c = (w[..., None] * c[nb]).sum(1) / w.sum(1, keepdims=True)
        _, nb2 = cKDTree(xyz[si]).query(xyz[si], k=64)
        ml = np.median(lum(c)[nb2], axis=1)
        low = lum(c) < ml - 0.05
        c[low] *= ((ml[low] - 0.05) / np.maximum(lum(c[low]), 1e-3))[:, None]
        rgb[si] = np.clip(c, 0, 1)
    rep["skin"] = int(skin.sum())

    # collar to jaw (front and sides), and the limbs and feet: what is neither skin nor clean cloth (dark specks on a
    # hem, hair-coloured patches, grey smears) takes the colour of whichever its neighbours mostly are
    hy = rest[J["head"], 1]
    nz = rest[J["neck"], 2]
    limbs_feet = limb_j + [J[n] for n in ("left_ankle", "right_ankle", "left_foot", "right_foot")]
    in_neck = (xyz[:, 1] > ny - 0.12) & (xyz[:, 1] < hy + 0.005) & (xyz[:, 2] > nz - 0.02)
    zone = seen & (in_neck | (~head & np.isin(dom, limbs_feet)))
    neck = np.zeros(len(g), bool)
    if zone.sum() > 64:
        zi = np.flatnonzero(zone)
        _, nb = cKDTree(xyz[zi]).query(xyz[zi], k=48)
        for _ in range(12):  # a patch fills in from its edges, one layer a pass
            c = rgb[zi]
            cool = c[:, 2] > c[:, 0] + 0.02
            # on the neck a dark brown is hair or dirt, not skin; on the limbs it is tanned skin in shade
            is_skin = (c[:, 0] > c[:, 2] + 0.06) & (sat(c) > 0.08) & (lum(c) > np.where(in_neck[zi], 0.32, 0.2))
            is_white = (lum(c) > 0.65) & (sat(c) < 0.16) & ~(cool & (lum(c) < 0.8))
            good = is_skin | is_white
            todo = np.flatnonzero(~good)
            if not len(todo):
                break
            changed = 0
            for i in todo:
                n = nb[i]
                ks, kw = n[is_skin[n]], n[is_white[n]]
                if len(ks) + len(kw) < 4:
                    continue
                src = ks if len(ks) >= len(kw) else kw
                rgb[zi[i]] = np.median(c[src], axis=0)
                neck[zi[i]] = True
                changed += 1
            if not changed:
                break
    rep["neck"] = int(neck.sum())

    # the shorts' hem: a clean edge, each Gaussian in the band takes what most of its neighbours are (cloth or skin)
    hem = np.zeros(len(g), bool)
    hband = seen & ~head & np.isin(dom, thigh_j) & (np.abs(xyz[:, 1] - hem_y) < 0.03)
    if hband.sum() > 64:
        bi = np.flatnonzero(hband)
        _, nb = cKDTree(xyz[bi]).query(xyz[bi], k=24)
        c = rgb[bi]
        w = (lum(c) > 0.6) & (sat(c) < 0.2)
        share = w[nb].mean(1)
        flip_w = ~w & (share > 0.65)
        flip_s = w & (share < 0.35)
        for i in np.flatnonzero(flip_w | flip_s):
            n = nb[i]
            src = n[w[n]] if flip_w[i] else n[~w[n]]
            rgb[bi[i]] = np.median(c[src], axis=0)
        hem[bi[flip_w | flip_s]] = True
    rep["hem"] = int(hem.sum())

    # solid: LHM++ builds cloth from many faint Gaussians that only add up to opaque where enough overlap; through the
    # thinner spots a bright room shows through the shirt. Each body Gaussian's opacity a becomes 1 - (1 - a)^k.
    solid = seen & ~head & (alpha < 0.98)
    if args.solid > 1:
        a2 = 1 - (1 - alpha[solid]) ** args.solid
        g.opacity[solid] = np.log(np.clip(a2, 1e-4, 1 - 1e-4) / (1 - np.clip(a2, 1e-4, 1 - 1e-4)))
    rep["solid"] = int(solid.sum()) if args.solid > 1 else 0

    # hair: strands standing off the outline fade
    centre = rest[J["head"]] + np.array([0.0, 0.07, -0.01])
    hair_zone = seen & head & (xyz[:, 1] > rest[J["head"], 1] - 0.02)
    stray = np.zeros(len(g), bool)
    if hair_zone.sum() > 200:
        hi = np.flatnonzero(hair_zone)
        v = xyz[hi] - centre
        r = np.linalg.norm(v, axis=1)
        dirs = v / np.maximum(r, 1e-6)[:, None]
        _, nb = cKDTree(dirs).query(dirs, k=args.hair_k)
        ref = np.percentile(r[nb], args.hair_pct, axis=1)
        out = r > ref + args.hair_margin
        stray[hi[out]] = True
        g.opacity[hi[out]] = np.minimum(g.opacity[hi[out]], -7.0)
    rep["hair"] = int(stray.sum())

    g.f_dc[:] = ((rgb - 0.5) / SH_C0).astype(g.f_dc.dtype)
    if g.f_rest.shape[1]:
        g.f_rest[marks | band | neck] = 0
    write_ply(b / av["file"], g)
    rep.update(of=int(len(g)), markK=args.mark_k, markDrop=args.mark_drop, skinPasses=args.skin_passes,
               hairMarginM=args.hair_margin)
    (b / "polish.json").write_text(json.dumps(rep, indent=1) + "\n")
    print(f"[polish] {rep}")


def tennis_poses(m) -> dict:
    """A few hand-made poses that stretch the rig the way tennis does (ready crouch, serve, wide forehand reach, lunge,
    both arms up), from the bundle's own first idle frame: body joints only, hands as the idle holds them."""
    from lucid_avatars.rotations import aa_to_quat, quat_mul, quat_to_aa
    from lucid_avatars.smplx_layout import J

    def make(**rots):
        pose = np.asarray(m.pose[0], dtype=np.float64).copy()
        for name, aa in rots.items():
            pose[J[name]] = quat_to_aa(quat_mul(aa_to_quat(np.asarray(aa, float)), aa_to_quat(pose[J[name]])))
        return pose

    return {
        "ready": make(left_hip=[-0.6, 0, 0.12], right_hip=[-0.6, 0, -0.12], left_knee=[0.9, 0, 0], right_knee=[0.9, 0, 0],
                      left_ankle=[-0.3, 0, 0], right_ankle=[-0.3, 0, 0], spine1=[0.35, 0, 0],
                      left_shoulder=[0, 0.5, 0.5], right_shoulder=[0, -0.5, -0.5], left_elbow=[0, 1.2, 0],
                      right_elbow=[0, -1.2, 0]),
        "serve": make(right_shoulder=[0, 0, 2.4], right_elbow=[0, -0.6, 0], left_shoulder=[0, 0, -1.9],
                      spine2=[-0.2, 0, 0.15], right_hip=[-0.2, 0, 0], left_knee=[0.3, 0, 0]),
        "forehand": make(spine1=[0, -0.5, 0], spine2=[0, -0.3, 0], right_shoulder=[0, -0.9, -0.3],
                         right_elbow=[0, -0.4, 0], left_shoulder=[0, 0.6, 0.6], left_hip=[-0.3, 0, 0.35],
                         right_hip=[0.1, 0, -0.45], left_knee=[0.6, 0, 0]),
        "lunge": make(left_hip=[-0.9, 0, 0.5], right_hip=[0.2, 0, -0.55], left_knee=[1.3, 0, 0], right_knee=[0.2, 0, 0],
                      spine1=[0.3, 0, 0], left_shoulder=[0, 0, -0.6], right_shoulder=[0, -0.8, -0.4]),
        "armsup": make(left_shoulder=[0, 0, -2.4], right_shoulder=[0, 0, 2.4]),
    }


def audit(args) -> None:
    """A bundle from all round (0-315 degrees every 45, full body and head) and in tennis-like poses (front, side,
    back), on white: one sheet per bundle, for a look at seams, marks, hair and stretching under the arms and in the
    crotch."""
    from PIL import Image, ImageDraw

    from lucid_avatars.motion import Motion

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for spec in args.bundles:
        label, path = spec.split("=", 1)
        b = Path(path)
        gs = posed_gaussians(b)
        head = gs["head"] + np.array([0.0, 0.07, 0.0])
        alpha_y = gs["means"][gs["opacities"] > 0.5][:, 1]
        mid = np.array([0.0, float((alpha_y.max() + alpha_y.min()) / 2), 0.0])
        angles = list(range(0, 360, 45))
        rows = [("full", [render(gs, orbit_eye(mid, FULL["distance"], a), mid, (360, 720), FULL["fov"]) for a in angles]),
                ("head", [render(gs, orbit_eye(head, PORTRAIT["distance"], a), head, (360, 480), PORTRAIT["fov"])
                          for a in angles])]
        m = Motion.load(b / json.loads((b / "dream.json").read_text())["avatar"]["motion"])
        for name, pose in tennis_poses(m).items():
            gp = posed_gaussians(b, pose=pose)
            ay = gp["means"][gp["opacities"] > 0.5][:, 1]
            md = np.array([0.0, float((ay.max() + ay.min()) / 2), 0.0])
            rows.append((name, [render(gp, orbit_eye(md, FULL["distance"], a), md, (360, 720), FULL["fov"])
                                for a in (0, 90, 180, 270)]))
        th = 420
        strips = []
        for name, ims in rows:
            ims = [Image.fromarray(i) for i in ims]
            h = th if name != "head" else 300
            ims = [i.resize((round(i.width * h / i.height), h), Image.LANCZOS) for i in ims]
            s = Image.new("RGB", (sum(i.width for i in ims), h + 18), "white")
            x = 0
            for i in ims:
                s.paste(i, (x, 18))
                x += i.width
            ImageDraw.Draw(s).text((4, 3), f"{label}: {name}", fill=(0, 0, 0))
            strips.append(s)
        sheet = Image.new("RGB", (max(s.width for s in strips), sum(s.height for s in strips)), "white")
        y = 0
        for s in strips:
            sheet.paste(s, (0, y))
            y += s.height
        sheet.save(out / f"audit-{label}.jpg", quality=88)
        print(f"AUDIT {out / f'audit-{label}.jpg'}")


def likeness(args) -> None:
    """How much a bundle's face looks like the person, measured on photos it never saw (held out): InsightFace
    buffalo_l (ArcFace R50) on portraits rendered at every yaw from -90 to 90 degrees. For each held-out photo, the
    render at the yaw that matches it best stands for that view (`matched`); `front`, `45` and `90` are the 0, +-45 and
    +-90 degree renders against the held-out photos of that view (--front/--three-quarter/--profile name them).
    photoVsPhoto (held-out photos against each other, same groups) is the ceiling. Writes likeness.json and
    likeness.jpg: each held-out photo beside its matched render, per bundle."""
    import os

    import onnxruntime as ort
    from insightface.app import FaceAnalysis
    from insightface.model_zoo import model_zoo as mz
    from PIL import Image, ImageDraw, ImageOps

    # onnxruntime sizes its thread pool to the whole node (96 threads on a 3-core Slurm job: a crawl); keep it to ours
    threads = int(os.environ.get("SLURM_CPUS_PER_TASK", "3"))

    def _init(self, model_path, **kw):
        so = ort.SessionOptions()
        so.intra_op_num_threads, so.inter_op_num_threads = threads, 1
        ort.InferenceSession.__init__(self, model_path, sess_options=so, **kw)
        self.model_path = model_path

    mz.PickableInferenceSession.__init__ = _init
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    app = FaceAnalysis(name="buffalo_l", root=args.insightface_root,
                       providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    app.prepare(ctx_id=0, det_size=(640, 640))

    def face(rgb):
        faces = app.get(np.ascontiguousarray(np.asarray(rgb)[..., ::-1]))
        return max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])) if faces else None

    def emb(rgb):
        f = face(rgb)
        return None if f is None else f.normed_embedding

    def shape(rgb):
        """Face proportions in units of the eye distance (5-point eyes, 106-point jaw contour): length (eyes to chin),
        jaw width, nose (eyes to nose tip), mouth width. Meaningful on frontal faces only."""
        f = face(rgb)
        if f is None or getattr(f, "landmark_2d_106", None) is None:
            return None
        k, c = f.kps, f.landmark_2d_106[:33]
        eye = 0.5 * (k[0] + k[1])
        de = float(np.linalg.norm(k[1] - k[0]))
        return {"length": round(float((c[:, 1].max() - eye[1]) / de), 3),
                "jaw": round(float((c[:, 0].max() - c[:, 0].min()) / de), 3),
                "nose": round(float((k[2][1] - eye[1]) / de), 3),
                "mouth": round(float(np.linalg.norm(k[4] - k[3]) / de), 3)}

    photos = {}
    for f in sorted(Path(args.heldout).glob("*.jpg")):
        im = ImageOps.exif_transpose(Image.open(f)).convert("RGB")
        im.thumbnail((1600, 1600))
        e = emb(im)
        if e is not None:
            photos[f.stem] = (e, im)
    groups = {"front": args.front.split(","), "45": args.three_quarter.split(","), "90": args.profile.split(",")}
    allp = list(photos)
    ceiling = {"all": round(float(np.mean([photos[a][0] @ photos[b][0] for a in allp for b in allp if a < b])), 4)}
    for gname, names in groups.items():
        names = [n for n in names if n in photos]
        others = [o for o in allp if o not in names]
        if names and others:  # a photo of this view against the other held-out photos: what a real face scores
            ceiling[gname] = round(float(np.mean([photos[n][0] @ photos[o][0] for n in names for o in others])), 4)
    yaws = list(range(-90, 91, 15))
    frontal = [Path(x) for x in args.shape_photos.replace(":", ",").split(",") if x]
    shapes = {f.stem: shape(np.asarray(ImageOps.exif_transpose(Image.open(f)).convert("RGB"))) for f in frontal}
    for n, sh in shapes.items():
        print(f"[likeness] photo {n}: shape {sh}", flush=True)
    report = {"heldout": allp, "ceilingPhotoVsPhoto": ceiling, "bundles": {}, "photoShapes": shapes}
    train_embs = None
    print(f"[likeness] {len(photos)} held-out faces; providers {app.models['detection'].session.get_providers()}",
          flush=True)
    rows = []
    for spec in args.bundles:
        label, path = spec.split("=", 1)
        gs = posed_gaussians(Path(path))
        head = gs["head"] + np.array([0.0, 0.07, 0.0])
        renders = {y: render(gs, orbit_eye(head, PORTRAIT["distance"], y), head, PORTRAIT["size"], PORTRAIT["fov"])
                   for y in yaws}
        re_ = {y: emb(r) for y, r in renders.items()}
        print(f"[likeness] {label}: {sum(e is not None for e in re_.values())} of {len(yaws)} renders have a face",
              flush=True)
        r = {}
        for gname, names in groups.items():
            names = [n for n in names if n in photos]
            want = {"front": [0], "45": [-45, 45], "90": [-90, 90]}[gname]
            sc = [max(e @ photos[n][0] for e in [re_[y] for y in want] if e is not None) for n in names
                  if any(re_[y] is not None for y in want)]
            r[gname] = round(float(np.mean(sc)), 4) if sc else None
        matched, pairs = {}, []
        for n, (e, im) in photos.items():
            best = max(((re_[y] @ e, y) for y in yaws if re_[y] is not None), default=(None, None))
            matched[n] = {"cos": None if best[0] is None else round(float(best[0]), 4), "yaw": best[1]}
            pairs.append((n, im, renders[best[1]] if best[1] is not None else renders[0], matched[n]))
        r["matched"] = round(float(np.mean([m["cos"] for m in matched.values() if m["cos"] is not None])), 4)
        r["perPhoto"] = matched
        r["trainFront"] = None
        if args.train and train_embs is None:
            train_embs = []
            for f in sorted(Path(args.train).glob("*.jpg")):
                im = ImageOps.exif_transpose(Image.open(f)).convert("RGB")
                im.thumbnail((1200, 1200))
                train_embs.append(emb(im))
            train_embs = [e for e in train_embs if e is not None]
        if train_embs:
            te = train_embs
            if re_[0] is not None:
                r["trainFront"] = round(float(np.mean([re_[0] @ e for e in te])), 4)
        r["shapeFront"] = shape(renders[0])
        report["bundles"][label] = r
        print(f"[likeness] {label}: shape {r['shapeFront']}", flush=True)
        print(f"[likeness] {label}: front {r['front']} 45 {r['45']} 90 {r['90']} matched {r['matched']} "
              f"trainFront {r['trainFront']}")
        rows.append((label, pairs))
    (out / "likeness.json").write_text(json.dumps(report, indent=1) + "\n")
    print(f"[likeness] ceiling (held-out photo vs photo): {ceiling}")
    th = 300
    tiles = []
    for label, pairs in rows:
        strip = []
        for n, im, rend, m in pairs:
            a = im.copy()
            a.thumbnail((th, th))
            bimg = Image.fromarray(rend)
            bimg = bimg.resize((round(bimg.width * th / bimg.height), th), Image.LANCZOS)
            t = Image.new("RGB", (a.width + bimg.width, th + 18), "white")
            t.paste(a, (0, 18))
            t.paste(bimg, (a.width, 18))
            ImageDraw.Draw(t).text((3, 3), f"{label} | {n} | yaw {m['yaw']} cos {m['cos']}", fill=(0, 0, 0))
            strip.append(t)
        tiles.append(strip)
    W = max(sum(t.width for t in s) for s in tiles)
    sheet = Image.new("RGB", (W, (th + 18) * len(tiles)), "white")
    for k, s in enumerate(tiles):
        x = 0
        for t in s:
            sheet.paste(t, (x, k * (th + 18)))
            x += t.width
    sheet.save(out / "likeness.jpg", quality=90)
    print("LIKENESS_OK", out / "likeness.jpg")


def headband(args) -> None:
    """A clean terry headband: fresh Gaussians laid on a smooth ring round the head (its radius the hair's own,
    smoothed all the way round), a few millimetres thick, lower at the back as a band sits, skinned to the head. Hair
    that stands out through the band fades; hair above it stays, so strands can fall over its top edge. Appends to
    avatar.ply and skin.bin (avatar.raw.ply no longer matches it, so run whites and polish before this)."""
    from scipy.spatial.transform import Rotation

    from lucid_avatars import skinning as S
    from lucid_avatars.gaussian_ply import SH_C0, Gaussians, read_ply, write_ply
    from lucid_avatars.smplx_layout import J

    b = Path(args.bundle)
    av = json.loads((b / "dream.json").read_text())["avatar"]
    g = read_ply(b / av["file"])
    idx, q = S.read_skin_bin(b / av["skin"])
    dom = idx[np.arange(len(idx)), np.argmax(q, 1)].astype(int)
    rest = np.asarray(json.loads((b / av["skeleton"]).read_text())["rest"], dtype=np.float64)
    xyz = np.asarray(g.xyz, dtype=np.float64)
    alpha = 1 / (1 + np.exp(-np.asarray(g.opacity, dtype=np.float64)))
    head = np.isin(dom, [J["head"], J["jaw"], J["left_eye"], J["right_eye"]])
    uika = b / "uika_head.json"
    if uika.is_file():
        head[int(json.loads(uika.read_text())["head"]["first"]):] = True
    eye_y = 0.5 * (rest[J["left_eye"], 1] + rest[J["right_eye"], 1])
    centre = rest[J["head"]] + np.array([0.0, 0.07, -0.01])
    y_front = eye_y + args.above_eyes  # the band's lower edge at the forehead

    def lower(theta):
        return y_front - args.drop * (1 - np.cos(theta)) / 2

    hd = head & (alpha > 0.3)
    d = xyz[hd] - centre
    th = np.arctan2(d[:, 0], d[:, 2])
    rho = np.hypot(d[:, 0], d[:, 2])
    inb = (xyz[hd, 1] >= lower(th)) & (xyz[hd, 1] <= lower(th) + args.width)
    bins = 72
    k = np.floor((th + np.pi) / (2 * np.pi) * bins).astype(int) % bins
    radius = np.full(bins, np.nan)
    for i in range(bins):
        m = inb & (k == i)
        if m.sum() >= 5:
            radius[i] = np.percentile(rho[m], args.radius_pct)
    ok = ~np.isnan(radius)
    if ok.sum() < bins // 2:
        raise SystemExit("headband: too little head at band height to fit a ring")
    idxs = np.arange(bins)
    radius = np.interp(idxs, idxs[ok], radius[ok], period=bins)
    kern = np.ones(9) / 9  # +-20 degrees
    radius = np.convolve(np.r_[radius[-4:], radius, radius[:4]], kern, mode="valid")
    centres = (idxs + 0.5) / bins * 2 * np.pi - np.pi

    def r_at(theta):
        return np.interp(theta, centres, radius, period=2 * np.pi) + args.thickness

    # hair poking out through the band fades (hair above the band stays)
    ext = np.exp(np.asarray(g.scale, dtype=np.float64)[hd]).max(1)
    poke = np.flatnonzero(hd)[inb & (rho + 1.5 * ext > r_at(th) - args.thickness)]
    g.opacity[poke] = np.minimum(g.opacity[poke], -7.0)

    # the band: rows across its width, Gaussians every few millimetres round it
    pts, rots, cols, scs = [], [], [], []
    rng = np.random.default_rng(0)
    rows = int(round(args.width / 0.004)) + 1
    for row in range(rows):
        v = row / (rows - 1)  # 0 lower edge, 1 upper edge
        edge = min(v, 1 - v)
        inset = 0.0015 * (1 - min(edge / 0.15, 1.0))  # rounded edges
        n_round = int(2 * np.pi * float(radius.mean()) / 0.0025)
        for t in np.linspace(-np.pi, np.pi, n_round, endpoint=False):
            r = r_at(t) - inset
            y = lower(t) + v * args.width
            p = centre + np.array([r * np.sin(t), 0.0, r * np.cos(t)])
            p[1] = y
            tang = np.array([np.cos(t), 0.0, -np.sin(t)])
            up = np.array([0.0, 1.0, 0.0])
            nrm = np.cross(tang, up)
            pts.append(p)
            rots.append(np.stack([tang, up, nrm], axis=1))
            shade = 0.94 + 0.06 * min(edge / 0.25, 1.0)
            cols.append(np.clip(np.array(args.colour) * shade + rng.normal(0, 0.01), 0, 1))
            scs.append([0.0022, 0.0024, 0.0009])  # small across its width: a crisp edge, no blur
    pts, cols = np.array(pts), np.array(cols)
    quat = Rotation.from_matrix(np.array(rots)).as_quat()[:, [3, 0, 1, 2]]
    n_new = len(pts)
    band = Gaussians(xyz=pts.astype(g.xyz.dtype), f_dc=((cols - 0.5) / SH_C0).astype(g.f_dc.dtype),
                     f_rest=np.zeros((n_new, g.f_rest.shape[1]), g.f_rest.dtype),
                     opacity=np.full(n_new, 3.5, g.opacity.dtype), scale=np.log(np.array(scs)).astype(g.scale.dtype),
                     rotation=quat.astype(g.rotation.dtype))
    out = Gaussians(xyz=np.concatenate([g.xyz, band.xyz]), f_dc=np.concatenate([g.f_dc, band.f_dc]),
                    f_rest=np.concatenate([g.f_rest, band.f_rest]), opacity=np.concatenate([g.opacity, band.opacity]),
                    scale=np.concatenate([g.scale, band.scale]), rotation=np.concatenate([g.rotation, band.rotation]))
    write_ply(b / av["file"], out)
    bi = np.zeros((n_new, 4), idx.dtype)
    bi[:, 0] = J["head"]
    bq = np.zeros((n_new, 4), q.dtype)
    bq[:, 0] = 255
    S.write_skin_bin(b / av["skin"], np.concatenate([idx, bi]), np.concatenate([q, bq]))
    rep = {"added": int(n_new), "hairFaded": int(len(poke)), "lowerEdgeFrontY": round(float(y_front), 3),
           "widthM": args.width, "thicknessM": args.thickness, "radiusM": [round(float(radius.min()), 3), round(float(radius.max()), 3)]}
    (b / "headband.json").write_text(json.dumps(rep, indent=1) + "\n")
    print(f"[headband] {rep}")


def face(args) -> None:
    """Small, measured shape corrections to a head model's face, in the rest pose (judge them with likeness against
    held-out photos, never by eye alone): --nose-m moves the nose's protruding part down by up to that much (longer
    nose; the bridge and the lip stay), --mouth widens the mouth by that factor. Positions only; colours stay."""
    from lucid_avatars import skinning as S
    from lucid_avatars.gaussian_ply import read_ply, write_ply
    from lucid_avatars.smplx_layout import J

    b = Path(args.bundle)
    av = json.loads((b / "dream.json").read_text())["avatar"]
    g = read_ply(b / av["file"])
    idx, q = S.read_skin_bin(b / av["skin"])
    dom = idx[np.arange(len(idx)), np.argmax(q, 1)].astype(int)
    rest = np.asarray(json.loads((b / av["skeleton"]).read_text())["rest"], dtype=np.float64)
    head = np.isin(dom, [J["head"], J["jaw"], J["left_eye"], J["right_eye"]])
    uika = b / "uika_head.json"
    if uika.is_file():
        head[int(json.loads(uika.read_text())["head"]["first"]):] = True
    xyz = np.asarray(g.xyz, dtype=np.float64).copy()
    eye = 0.5 * (rest[J["left_eye"]] + rest[J["right_eye"]])
    x, y, z = xyz[:, 0] - eye[0], xyz[:, 1] - eye[1], xyz[:, 2] - eye[2]

    def bump(v, lo, peak, hi):
        return np.clip(np.where(v > peak, (hi - v) / (hi - peak), (v - lo) / (peak - lo)), 0, 1)

    moved = {}
    if args.nose_m:
        wx = np.exp(-(x / 0.016) ** 2)
        wy = bump(y, -0.07, -0.045, -0.004)
        wz = np.clip((z - 0.012) / 0.015, 0, 1)
        w = head * wx * wy * wz
        xyz[:, 1] -= args.nose_m * w
        moved["nose"] = int((w > 0.05).sum())
    if args.mouth != 1.0:
        wy = bump(y, -0.095, -0.075, -0.058)
        w = head * wy * (np.abs(x) < 0.04) * np.clip((z - 0.0) / 0.01, 0, 1)
        xyz[:, 0] = eye[0] + x * (1 + (args.mouth - 1) * w)
        moved["mouth"] = int((w > 0.05).sum())
    g.xyz[:] = xyz.astype(g.xyz.dtype)
    write_ply(b / av["file"], g)
    (b / "face.json").write_text(json.dumps({"noseM": args.nose_m, "mouth": args.mouth, "moved": moved}) + "\n")
    print(f"[face] {moved}")


def hair(args) -> None:
    """More of his hair: the head model's hair above the brows stands a little further off the scalp (--volume of its
    distance from the head's centre, more on top), with a slow wave in it (--wave metres), and sun-lightened strands
    (--highlights: a share of the hair lifted toward a warm light brown along a striped field). Positions, sizes and
    colours of the hair only; run before headband."""
    from lucid_avatars import skinning as S
    from lucid_avatars.gaussian_ply import SH_C0, read_ply, write_ply
    from lucid_avatars.smplx_layout import J

    b = Path(args.bundle)
    av = json.loads((b / "dream.json").read_text())["avatar"]
    g = read_ply(b / av["file"])
    idx, q = S.read_skin_bin(b / av["skin"])
    dom = idx[np.arange(len(idx)), np.argmax(q, 1)].astype(int)
    rest = np.asarray(json.loads((b / av["skeleton"]).read_text())["rest"], dtype=np.float64)
    head = np.isin(dom, [J["head"], J["jaw"], J["left_eye"], J["right_eye"]])
    uika = b / "uika_head.json"
    if uika.is_file():
        head[int(json.loads(uika.read_text())["head"]["first"]):] = True
    xyz = np.asarray(g.xyz, dtype=np.float64)
    rgb = np.clip(0.5 + SH_C0 * np.asarray(g.f_dc, dtype=np.float64), 0, 1)
    lum = rgb @ np.array([0.299, 0.587, 0.114])
    eye_y = 0.5 * (rest[J["left_eye"], 1] + rest[J["right_eye"], 1])
    centre = rest[J["head"]] + np.array([0.0, 0.07, -0.01])
    # hair: dark, on the head, above the brows (skin is lighter and warmer; the band is white)
    sat = rgb.max(1) - rgb.min(1)
    is_hair = head & (xyz[:, 1] > eye_y + 0.02) & (lum < 0.42) & ~((rgb[:, 0] > rgb[:, 2] + 0.12) & (lum > 0.3))
    is_hair &= ~((xyz[:, 2] - centre[2] > 0.06) & (xyz[:, 1] < eye_y + 0.045))  # not the brows / forehead
    hi = np.flatnonzero(is_hair)
    v = xyz[hi] - centre
    r = np.linalg.norm(v, axis=1)
    u = v / np.maximum(r, 1e-6)[:, None]
    top = np.clip(u[:, 1], 0, 1)  # 1 on the crown
    rng = np.random.default_rng(1)
    phase = rng.uniform(0, 2 * np.pi, 3)
    wave = np.sin(14 * u[:, 0] + phase[0]) * np.sin(11 * u[:, 2] + phase[1]) + 0.5 * np.sin(23 * u[:, 1] + phase[2])
    grow = args.volume * (0.4 + 0.6 * top) * r + args.wave * wave
    xyz[hi] = centre + u * (r + grow)[:, None]
    g.scale[hi] = (np.asarray(g.scale[hi], dtype=np.float64) + np.log1p(np.clip(grow / np.maximum(r, 1e-3), 0, 0.3))[:, None]).astype(g.scale.dtype)
    stripe = 0.5 + 0.5 * np.sin(40 * (u[:, 0] * 0.6 + u[:, 2] * 0.8) + 9 * u[:, 1] + phase[0])
    light = np.array(args.highlight_colour)
    k = args.highlights * stripe[:, None] * (0.5 + 0.5 * top)[:, None]
    rgb[hi] = (1 - k) * rgb[hi] + k * light
    g.xyz[:] = xyz.astype(g.xyz.dtype)
    g.f_dc[hi] = ((rgb[hi] - 0.5) / SH_C0).astype(g.f_dc.dtype)
    write_ply(b / av["file"], g)
    rep = {"hairGaussians": int(len(hi)), "volume": args.volume, "waveM": args.wave, "highlights": args.highlights}
    (b / "hair.json").write_text(json.dumps(rep) + "\n")
    print(f"[hair] {rep}")


def project(args) -> None:
    """His own face from his photos onto the head model's face (a head model averages many photos into a face that
    can read as someone else). For each photo (only ones the head was built from; held-out photos stay held out for
    likeness): the render whose 68 landmarks match the photo's best (yaw from -60 to 60 degrees) gives the landmarks
    in 3D (its depth), the photo's camera is fitted to them (affine: sports photos are long lenses), and each face
    Gaussian the render sees, inside the photo's landmark outline (fading out at it) and facing the camera, takes the
    photo's colour there, shifted to the head's own mean tone (no sunlight or white balance baked in). Each Gaussian
    takes mostly its best photo (weights to the power --power: an even average of slightly misregistered photos is a
    blur), best meaning sharpest (the most pixels between the eyes), the closest camera fit and the squarest view;
    then its broad shading (over --shade-k neighbours, a few centimetres: a sunlit cheek, a cap's shadow) is set to
    the head's own, so no photo's light is baked in while its features (eyes, brows, the nose's own shadow) stay; then
    the result is blended in by --strength. Colours of the face only; hair, ears and everything else stay. Writes
    project.json (per photo: the yaw, the fit's error in eye distances, how many Gaussians it coloured)."""
    import cv2
    import torch
    from gsplat import rasterization
    from insightface.app import FaceAnalysis
    from PIL import Image, ImageOps

    from lucid_avatars.gaussian_ply import SH_C0, read_ply, write_ply

    b = Path(args.bundle)
    av = json.loads((b / "dream.json").read_text())["avatar"]
    g = read_ply(b / av["file"])
    first = int(json.loads((b / "uika_head.json").read_text())["head"]["first"])
    gs = posed_gaussians(b)
    means = gs["means"].cpu().numpy().astype(np.float64)
    head = gs["head"] + np.array([0.0, 0.07, 0.0])
    old = np.clip(0.5 + SH_C0 * np.asarray(g.f_dc, dtype=np.float64), 0, 1)
    face_ids = np.arange(first, len(g))
    import os

    import onnxruntime as ort
    from insightface.model_zoo import model_zoo as mz

    threads = int(os.environ.get("SLURM_CPUS_PER_TASK", "3"))  # (as likeness: not the whole node's 96 threads)

    def _init(self, model_path, **kw):
        so = ort.SessionOptions()
        so.intra_op_num_threads, so.inter_op_num_threads = threads, 1
        ort.InferenceSession.__init__(self, model_path, sess_options=so, **kw)
        self.model_path = model_path

    mz.PickableInferenceSession.__init__ = _init
    app = FaceAnalysis(name="buffalo_l", root=args.insightface_root, providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    app.prepare(ctx_id=0, det_size=(640, 640))

    def detect(rgb):
        fs = app.get(np.ascontiguousarray(np.asarray(rgb)[..., ::-1]))
        return max(fs, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])) if fs else None

    W, H = PORTRAIT["size"]
    fpx = (H / 2) / math.tan(math.radians(PORTRAIT["fov"]) / 2)
    K = np.array([[fpx, 0, W / 2], [0, fpx, H / 2], [0, 0, 1.0]])

    def render_rgbd(yaw):
        eye = orbit_eye(head, PORTRAIT["distance"], yaw)
        V = look_at(eye, head)
        with torch.no_grad():
            img, _, _ = rasterization(gs["means"], gs["quats"], gs["scales"], gs["opacities"], gs["colors"],
                                      torch.as_tensor(V, dtype=torch.float32, device="cuda")[None],
                                      torch.as_tensor(K, dtype=torch.float32, device="cuda")[None], W, H,
                                      near_plane=0.05, sh_degree=gs["sh_degree"], render_mode="RGB+ED",
                                      backgrounds=torch.ones(1, 3, device="cuda"))  # (gsplat adds the depth's)
        a = img[0].cpu().numpy()
        return (a[..., :3].clip(0, 1) * 255).astype(np.uint8), a[..., 3], V, eye

    def procrustes_err(a, c):  # landmarks a vs c after the best similarity, in eye distances
        a0, c0 = a - a.mean(0), c - c.mean(0)
        s = np.linalg.norm(c0) / max(np.linalg.norm(a0), 1e-9)
        u, _, vt = np.linalg.svd(a0.T @ c0)
        return float(np.linalg.norm(a0 @ (u @ vt) * s - c0) / len(a) / max(np.linalg.norm(c[45] - c[36]), 1e-6))

    inner = np.arange(17, 68)  # brows, nose, eyes, mouth (the jaw contour follows the silhouette: not for fitting)
    acc = np.zeros((len(face_ids), 3))
    wsum = np.zeros(len(face_ids))
    wmax = np.zeros(len(face_ids))
    report = {"photos": {}}
    renders = {y: render_rgbd(y) for y in np.arange(-60, 61, 7.5)}
    rl = {y: detect(r[0]) for y, r in renders.items()}
    for path in [Path(p) for p in args.photos.replace(":", ",").split(",") if p]:
        im = np.asarray(ImageOps.exif_transpose(Image.open(path)).convert("RGB"))
        f = detect(im)
        if f is None or getattr(f, "landmark_3d_68", None) is None:
            print(f"[project] {path.name}: no face", flush=True)
            continue
        lp = f.landmark_3d_68[:, :2].astype(np.float64)
        de = float(np.linalg.norm(lp[45] - lp[36]))
        if de < args.min_eye_px:
            print(f"[project] {path.name}: face too small ({de:.0f} px between the eyes)", flush=True)
            continue
        # mid-point faces (a shout, a squint into the sun) would bake teeth or half-shut lids into his: not those
        mouth = float(np.linalg.norm(lp[62] - lp[66])) / de
        eyes = float(np.mean([np.linalg.norm(lp[i] - lp[j]) for i, j in ((37, 41), (38, 40), (43, 47), (44, 46))])) / de
        if mouth > args.max_mouth or eyes < args.min_eyes:
            print(f"[project] {path.name}: mouth {mouth:.3f}, eyes {eyes:.3f}: skipped", flush=True)
            continue
        errs = {y: procrustes_err(r.landmark_3d_68[inner, :2], lp[inner]) for y, r in rl.items() if r is not None}
        yaw = min(errs, key=errs.get)
        rgb_r, depth, V, eye = renders[yaw]
        lr = rl[yaw].landmark_3d_68[:, :2].astype(np.float64)
        # the render's landmarks in 3D, from its depth
        ui = np.clip(np.round(lr).astype(int), 0, [W - 1, H - 1])
        d = depth[ui[:, 1], ui[:, 0]]
        cam = np.c_[(lr[:, 0] - K[0, 2]) / fpx * d, (lr[:, 1] - K[1, 2]) / fpx * d, d]
        Vi = np.linalg.inv(V)
        X = (Vi[:3, :3] @ cam.T).T + Vi[:3, 3]
        # the photo's camera: 3D -> 2D affine, least squares on the inner landmarks
        A = np.c_[X[inner], np.ones(len(inner))]
        P, *_ = np.linalg.lstsq(A, lp[inner], rcond=None)
        fit = float(np.sqrt(((A @ P - lp[inner]) ** 2).sum(1).mean()) / de)
        if fit > args.max_fit:
            print(f"[project] {path.name}: yaw {yaw}, fit off by {fit:.3f} eye distances: skipped", flush=True)
            continue
        # which face Gaussians the render sees (its depth), and how squarely
        x = means[face_ids]
        xc = (V[:3, :3] @ x.T).T + V[:3, 3]
        u = np.round(xc[:, 0] / xc[:, 2] * fpx + K[0, 2]).astype(int)
        v = np.round(xc[:, 1] / xc[:, 2] * fpx + K[1, 2]).astype(int)
        inside = (u >= 0) & (u < W) & (v >= 0) & (v < H)
        seen = np.zeros(len(x), dtype=bool)
        seen[inside] = xc[inside, 2] <= depth[v[inside], u[inside]] + args.depth_tol
        radial = x - (head - np.array([0.0, 0.05, 0.0]))
        radial /= np.linalg.norm(radial, axis=1, keepdims=True)
        view = (eye - x) / np.linalg.norm(eye - x, axis=1, keepdims=True)
        facing = np.clip((radial * view).sum(1), 0, 1) ** 1.5
        # inside the photo's landmark outline, fading out over its edge
        uv = np.c_[x, np.ones(len(x))] @ P
        hull = cv2.convexHull(lp.astype(np.float32))
        edge = np.array([cv2.pointPolygonTest(hull, (float(a), float(c)), True) for a, c in uv]) / de
        rim = np.clip(edge / args.fade, 0, 1)
        quality = min(1.0, de / 120.0) * math.exp(-((fit / 0.03) ** 2))
        if quality < args.min_quality:
            print(f"[project] {path.name}: quality {quality:.2f} (eyes {de:.0f} px, fit {fit:.3f}): skipped", flush=True)
            continue
        w = seen * facing * rim * quality
        ok = w > 0.01
        if ok.sum() < 200:
            print(f"[project] {path.name}: only {ok.sum()} Gaussians seen: skipped", flush=True)
            continue
        col = np.stack([cv2.remap(im[..., c].astype(np.float32), uv[ok, 0].astype(np.float32)[None],
                                  uv[ok, 1].astype(np.float32)[None], cv2.INTER_LINEAR)[0] for c in range(3)], 1) / 255
        core = w[ok] > 0.5
        shift = old[face_ids[ok]][core].mean(0) - col[core].mean(0) if core.any() else 0
        wp = w[ok] ** args.power
        acc[ok] += wp[:, None] * np.clip(col + args.tone * shift, 0, 1)
        wsum[ok] += wp
        wmax[ok] = np.maximum(wmax[ok], w[ok] / max(quality, 1e-6))
        report["photos"][path.name] = {"yaw": float(yaw), "fitEyeDist": round(fit, 4), "coloured": int(ok.sum()), "quality": round(quality, 3),
                                       "eyePx": round(de, 1), "mouth": round(mouth, 3), "eyes": round(eyes, 3)}
        print(f"[project] {path.name}: yaw {yaw}, fit {fit:.3f}, {ok.sum()} Gaussians", flush=True)
    if not report["photos"]:
        raise SystemExit("project: no photo could be used")
    a = np.clip(wmax / 0.5, 0, 1) * args.strength  # fully where some photo saw it squarely, fading toward the edges
    new = old.copy()
    m = wsum > 0
    proj = acc[m] / wsum[m, None]
    if args.shade_k > 0:  # the head's broad shading, the photos' detail
        from scipy.spatial import cKDTree

        lum_w = np.array([0.299, 0.587, 0.114])
        pos = np.asarray(g.xyz, dtype=np.float64)[face_ids[m]]
        _, nb = cKDTree(pos).query(pos, k=min(args.shade_k, len(pos)))
        ratio = (old[face_ids[m]] @ lum_w)[nb].mean(1) / np.maximum((proj @ lum_w)[nb].mean(1), 1e-3)
        proj = np.clip(proj * np.clip(ratio, 0.6, 1.6)[:, None], 0, 1)
    new[face_ids[m]] = (1 - a[m, None]) * old[face_ids[m]] + a[m, None] * proj
    g.f_dc[:] = ((new - 0.5) / SH_C0).astype(g.f_dc.dtype)
    write_ply(b / av["file"], g)
    report.update(strength=args.strength, tone=args.tone, power=args.power, shadeK=args.shade_k, recoloured=int(m.sum()),
                  meanBlend=round(float(a[m].mean()), 3))
    (b / "project.json").write_text(json.dumps(report, indent=1) + "\n")
    print(f"[project] {report['recoloured']} face Gaussians recoloured from {len(report['photos'])} photos")


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
    o = sub.add_parser("polish")
    o.add_argument("bundle")
    o.add_argument("--mark-k", type=int, default=160, help="cloth neighbours a mark is judged against")
    o.add_argument("--mark-drop", type=float, default=0.1, help="how much darker than its cloth a mark is")
    o.add_argument("--skin-passes", type=int, default=3)
    o.add_argument("--skin-sigma-m", type=float, default=0.012)
    o.add_argument("--hair-k", type=int, default=64)
    o.add_argument("--hair-pct", type=float, default=80.0)
    o.add_argument("--hair-margin", type=float, default=0.006, help="metres a strand may stand off the outline")
    o.add_argument("--ring", action="store_true", help="paint the headband all the way round")
    o.add_argument("--ring-height", type=float, default=0.035)
    o.add_argument("--ring-drop", type=float, default=0.025, help="how much lower the band sits at the back (m)")
    o.add_argument("--solid", type=float, default=2.5, help="opacity a -> 1 - (1 - a)^k on the body (1 = off)")
    k = sub.add_parser("likeness")
    k.add_argument("bundles", nargs="+", help="label=bundle_dir")
    k.add_argument("--heldout", required=True, help="photos the face was never built from")
    k.add_argument("--train", default=None, help="the photos it was built from (a front-render score against them too)")
    k.add_argument("--front", default="", help="held-out stems that face the camera, comma-separated")
    k.add_argument("--three-quarter", default="")
    k.add_argument("--profile", default="")
    k.add_argument("--insightface-root", required=True)
    k.add_argument("--shape-photos", default="", help="frontal photos (paths, comma-separated) to compare proportions with")
    k.add_argument("--out", required=True)
    h = sub.add_parser("headband")
    h.add_argument("bundle")
    h.add_argument("--above-eyes", type=float, default=0.04, help="the band's lower edge over the eyes at the front (m)")
    h.add_argument("--width", type=float, default=0.04)
    h.add_argument("--drop", type=float, default=0.03, help="how much lower it sits at the back (m)")
    h.add_argument("--thickness", type=float, default=0.004, help="how far it stands off the hair's smoothed outline (m)")
    h.add_argument("--radius-pct", type=float, default=70.0, help="the hair outline: this percentile of radius per direction")
    h.add_argument("--colour", type=float, nargs=3, default=[0.88, 0.88, 0.89])
    hr = sub.add_parser("hair")
    hr.add_argument("bundle")
    hr.add_argument("--volume", type=float, default=0.08)
    hr.add_argument("--wave", type=float, default=0.004)
    hr.add_argument("--highlights", type=float, default=0.3)
    hr.add_argument("--highlight-colour", type=float, nargs=3, default=[0.45, 0.31, 0.2])
    pj = sub.add_parser("project")
    pj.add_argument("bundle")
    pj.add_argument("--photos", required=True, help="photos the head was built from (comma-separated paths)")
    pj.add_argument("--insightface-root", required=True)
    pj.add_argument("--strength", type=float, default=0.85)
    pj.add_argument("--power", type=float, default=6.0, help="photo weights to this power: the best photo per Gaussian wins")
    pj.add_argument("--min-quality", type=float, default=0.0, help="skip photos below this (small faces, loose fits)")
    pj.add_argument("--shade-k", type=int, default=0, help="neighbours the broad shading is measured over (0: keep the photos')")
    pj.add_argument("--tone", type=float, default=1.0, help="share of the photos' tone shifted to the head's own")
    pj.add_argument("--fade", type=float, default=0.15, help="fade-out over the landmark outline (eye distances)")
    pj.add_argument("--depth-tol", type=float, default=0.006, help="seen: within this of the render's depth (m)")
    pj.add_argument("--max-fit", type=float, default=0.08, help="skip a photo whose camera fit is off by more (eye distances)")
    pj.add_argument("--min-eye-px", type=float, default=40.0)
    pj.add_argument("--max-mouth", type=float, default=0.05, help="inner lips apart, in eye distances: more is a shout")
    pj.add_argument("--min-eyes", type=float, default=0.055, help="lids apart, in eye distances: less is a squint")
    fc = sub.add_parser("face")
    fc.add_argument("bundle")
    fc.add_argument("--nose-m", type=float, default=0.0)
    fc.add_argument("--mouth", type=float, default=1.0)
    u = sub.add_parser("audit")
    u.add_argument("bundles", nargs="+", help="label=bundle_dir")
    u.add_argument("--out", required=True)
    w = sub.add_parser("whites")
    w.add_argument("bundle")
    w.add_argument("--strength", type=float, default=0.8, help="how far the kit moves to its median white")
    w.add_argument("--keep-shading", type=float, default=0.4, help="share of its own light and shade it keeps")
    w.add_argument("--white-lum", type=float, default=0.86, help="the kit's white, as luminance (0-1)")
    w.add_argument("--neutral", type=float, default=0.5, help="share of the photos' colour cast taken out of the white")
    w.add_argument("--max-sat", type=float, default=0.12, help="saturation (max-min RGB) below which a Gaussian is kit")
    args = p.parse_args()
    {"colour": colour, "prep": prep, "build": build, "compare": compare, "whites": whites, "polish": polish,
     "audit": audit, "likeness": likeness, "headband": headband,
     "face": face, "hair": hair, "project": project}[args.cmd](args)


if __name__ == "__main__":
    main()
