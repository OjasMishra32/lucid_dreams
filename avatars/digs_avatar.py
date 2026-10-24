"""One photo -> an avatar dream bundle, with DiGS-Avatar on a GPU. Run from the DiGS-Avatar repo directory.

photo -> rembg matte -> 640x896 crop around the person -> NLF SMPL-X fit -> DiGS reference JSON -> DiGS sample
-> turntable preview.mp4 + thumb.jpg, rest-pose avatar.ply, idle motion.json -> dreams/<id>/ (validated).

    cd $L/repos/DiGS-Avatar
    python /path/to/avatars/digs_avatar.py --image photo.jpg --id grandma-01 --name "Grandma" \
        --nlf $L/models/nlf/nlf_l_multi_0.3.2.patch6.torchscript --out $L/data/avatars/dreams

Every intermediate (matte, crop, fit JSON, reference render) goes to <out>/<id>.work/ for debugging, and code.pt
(DiGS's decoder code + betas) is where digs_finetune.py starts from.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import torch
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(1, os.getcwd())  # the DiGS-Avatar repo: run_demo_DiGS, lib.*
from lucid_avatars import digs_io as D  # noqa: E402
from lucid_avatars import skinning as S  # noqa: E402
from lucid_avatars.smplx_layout import SMPLX_PARENTS  # noqa: E402
from lucid_avatars.bundle import validate_bundle, write_avatar_bundle  # noqa: E402
from lucid_avatars.idle import idle_loop  # noqa: E402

HANDS_NOTE = "avatar.ply is the SMPL-X zero pose (flat hands); motion.json holds the hands in DiGS's relaxed hand mean"
TURNTABLE_FILL = 1.15  # frame height / body height
MAX_BODY_GAP_M = 0.1  # median Gaussian-to-SMPL-X-surface distance above this means the rig won't fit the avatar
# Losing more than this share of a module's weights means it would run random: fail instead.
MAX_MISSING_SHARE = 0.5
CHECKED_MODULES = ("dino_encoder.dino_model.", "diffusion_model.", "enhance.", "idol_decoder.")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--image", required=True, help="photo of one person, head to toe if possible")
    p.add_argument("--id", required=True, help="bundle id: dreams/<id>/")
    p.add_argument("--name", required=True, help="display name for the web app")
    p.add_argument("--out", required=True, help="dreams directory the bundle goes in")
    p.add_argument("--nlf", required=True, help="NLF TorchScript model (nlf_l_multi_0.3.2.patch6.torchscript)")
    p.add_argument("--ckpt", default="checkpoints/student.ckpt")
    p.add_argument("--config", default="configs/student_inpaint.yaml")
    p.add_argument("--fov", type=float, default=55.0, help="assumed camera field of view across the long side")
    p.add_argument("--rembg-model", default="u2net_human_seg")
    p.add_argument("--frames", type=int, default=60, help="turntable frames (one full turn)")
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--idle-seconds", type=float, default=8.0)
    p.add_argument("--steps", type=int, default=None, help="diffusion steps (default: the config's)")
    p.add_argument("--seed", type=int, default=42)
    return p.parse_args()


# ---------------------------------------------------------------- photo -> crop + SMPL-X fit

def matte_and_crop(photo: Image.Image, model_name: str, work: Path):
    """The person on white and the same crop unmatted (for NLF), both 640x896, and the crop box in photo pixels."""
    import rembg

    alpha = rembg.remove(photo, session=rembg.new_session(model_name), only_mask=True)
    alpha = np.asarray(alpha.convert("L"))
    Image.fromarray(alpha).save(work / "matte.png")
    x0, y0, x1, y1 = (round(v) for v in D.aspect_crop_box(D.alpha_bbox(alpha), D.DIGS_W / D.DIGS_H))

    a = alpha[..., None].astype(np.float32) / 255
    on_white = Image.fromarray((np.asarray(photo, dtype=np.float32) * a + 255 * (1 - a)).astype(np.uint8))

    def cut(img: Image.Image) -> Image.Image:
        canvas = Image.new("RGB", (x1 - x0, y1 - y0), (255, 255, 255))  # the box may run past the photo
        canvas.paste(img, (-x0, -y0))
        return canvas.resize((D.DIGS_W, D.DIGS_H), Image.LANCZOS)

    crop = cut(on_white)
    crop.save(work / "crop.png")
    return crop, cut(photo), (x0, y0, x1, y1)


def nlf_fit(image: Image.Image, nlf_path: str, K: np.ndarray, dev: torch.device):
    """SMPL-X (pose 165 absolute, betas 10, trans metres) of the biggest person NLF finds, seen through K."""
    import torchvision  # noqa: F401  (NLF's TorchScript needs torchvision ops registered)

    model = torch.jit.load(nlf_path).to(dev).eval()
    img = torch.from_numpy(np.asarray(image)).permute(2, 0, 1)[None].to(dev)
    Kt = torch.as_tensor(K, dtype=torch.float32, device=dev)[None]
    with torch.inference_mode():
        pred = model.detect_smpl_batched(img, intrinsic_matrix=Kt, model_name="smplx")
    if len(pred["pose"][0]) == 0:
        raise SystemExit("NLF found no person in the crop")
    boxes = pred["boxes"][0].cpu().numpy() if "boxes" in pred else None
    i = D.largest_person(boxes)
    pose, betas, trans = (pred[k][0][i].float().cpu().numpy() for k in ("pose", "betas", "trans"))
    if trans[2] > 100:  # a person 100+ units away is millimetres, not metres
        print(f"[warn] NLF trans {trans} looks like millimetres; converting to metres")
        trans = trans / 1000
    del model
    torch.cuda.empty_cache()
    print(f"NLF: {len(pred['pose'][0])} person(s), using #{i}, trans {np.round(trans, 2)} m")
    return pose.reshape(165), betas.reshape(-1)[:10], trans.reshape(3)


# ---------------------------------------------------------------- DiGS

def load_digs(config_path: str, ckpt_path: str):
    """DiGS's own model loader, plus a loud check that the weights that matter actually loaded.

    The DINOv3 .pth is gated; when it isn't on disk, DINOv3 is built without weights and must come
    from the student checkpoint instead.
    """
    from omegaconf import OmegaConf
    import run_demo_DiGS as demo

    config = OmegaConf.load(config_path)
    dino_weights = OmegaConf.select(config, "model.params.dino_encoder_config.dinov3_weights")
    hub_load = torch.hub.load
    if dino_weights and not os.path.exists(dino_weights):
        print(f"[info] {dino_weights} missing: building DINOv3 without weights, expecting them in {ckpt_path}")

        def load_without_weights(*a, **kw):
            kw.pop("weights", None)
            kw["pretrained"] = False
            return hub_load(*a, **kw)

        torch.hub.load = load_without_weights
    try:
        model = demo._load_model_from_config(config, ckpt_path)
    finally:
        torch.hub.load = hub_load

    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    have = set(ckpt.get("state_dict", ckpt))
    problems = []
    for prefix in CHECKED_MODULES:
        wanted = [k for k in model.state_dict() if k.startswith(prefix)]
        missing = [k for k in wanted if k not in have]
        print(f"weights {prefix:<26} {len(wanted) - len(missing):>5}/{len(wanted)} from {Path(ckpt_path).name}")
        if wanted and len(missing) / len(wanted) > MAX_MISSING_SHARE:
            problems.append(f"{prefix} {len(missing)}/{len(wanted)} missing")
    del ckpt
    if problems:
        raise SystemExit("DiGS would run with random weights: " + "; ".join(problems))
    return model, config, demo


def render(model, code, smpl_params, camera_1x1x20):
    """One DiGS render per SMPL-X frame from a single camera: (T, H, W, 3) in 0..1 on the CPU."""
    frames = []
    with torch.no_grad():
        for i in range(len(smpl_params)):
            out = model.idol_decoder(code, smpl_params[i:i + 1].to(code.dtype), camera_1x1x20, 1, return_loss=False)
            frames.append(out["image"][:, 0].float().clamp(0, 1).cpu())
    return torch.cat(frames)


def capture_rest_gaussians(model, code, betas, hand_mean, camera_1x1x20):
    """The Gaussians DiGS rasterizes for the SMPL-X zero pose (scale 1, these betas, flat hands): avatar.ply's content.

    DiGS adds the hand mean to its hand parameters, so flat hands are minus the mean.
    """
    renderer = model.idol_decoder.renderer
    original = renderer.render_gaussian
    got = {}

    def capture(means3D, colors_precomp, rotations, opacities, scales, cov3D_precomp=None):
        if not got:  # the first call is the colour pass; DiGS follows it with a visibility pass
            if scales is None:
                raise SystemExit("DiGS rendered with a precomputed covariance; can't export scales and rotations")
            got.update(xyz=means3D, rgb=colors_precomp, rotation=rotations, opacity=opacities, scale=scales)
            got.update({k: v.detach().float().cpu().numpy() for k, v in got.items()})
        return original(means3D, colors_precomp, rotations, opacities, scales, cov3D_precomp)

    rest = torch.zeros(1, 189, device=code.device)
    rest[:, 0] = 1.0
    rest[:, 70:80] = betas.reshape(1, 10)
    rest[:, 80:170] = -torch.as_tensor(hand_mean, dtype=rest.dtype, device=rest.device).reshape(1, 90)
    renderer.render_gaussian = capture
    try:
        render(model, code, rest, camera_1x1x20)
    finally:
        renderer.render_gaussian = original
    return D.rendered_to_gaussians(**got)


def skin_avatar(model, gaussians, betas_np, dev):
    """skin.bin records and skeleton.json for the rest-pose Gaussians, from DiGS's own SMPL-X model: each Gaussian
    takes the inverse-distance blend of its 4 nearest rest vertices' skinning weights, then the top 4 joints."""
    bm = model.idol_decoder.deformer.body_model
    parents = bm.parents[: len(SMPLX_PARENTS)].tolist()
    parents[0] = -1
    if parents != SMPLX_PARENTS:
        raise SystemExit(f"DiGS's SMPL-X tree differs from ours: {parents}")
    as_np = lambda t: t.detach().float().cpu().numpy()  # noqa: E731
    joints, verts = S.rest_joints(as_np(bm.v_template), as_np(bm.shapedirs), as_np(bm.J_regressor), betas_np)
    pts = torch.as_tensor(gaussians.xyz, dtype=torch.float32, device=dev)
    vt = torch.as_tensor(verts, dtype=torch.float32, device=dev)
    nearest = [torch.cdist(c, vt).topk(4, largest=False) for c in pts.split(65536)]
    dist = torch.cat([n.values for n in nearest]).cpu().numpy()
    idx = torch.cat([n.indices for n in nearest]).cpu().numpy()
    gap = float(np.median(dist[:, 0]))
    print(f"skinning: median Gaussian-to-SMPL-X-vertex distance {gap * 100:.1f} cm")
    if gap > MAX_BODY_GAP_M:
        raise SystemExit(f"the avatar sits {gap:.2f} m from its SMPL-X body: rest-pose coordinates don't match the rig")
    weights = S.blend_vertex_weights(bm.lbs_weights.detach().float().cpu().numpy(), idx, dist)
    return S.quantize_top4(weights), S.skeleton_dict(joints)


def save_mp4(frames_thwc: torch.Tensor, path: Path, fps: int) -> None:
    """DiGS's own writer (imageio, then OpenCV), which only prints when both fail: check the file."""
    from lib.utils.infer_util import save_video

    save_video(frames_thwc.permute(0, 3, 1, 2), str(path), fps=fps)
    if not path.is_file() or path.stat().st_size == 0:
        raise SystemExit(f"couldn't write {path}")


# ---------------------------------------------------------------- bundle

def export_bundle(model, demo, code, betas_np, hand_mean, focal, any_camera, out: Path, dream_id: str, name: str,
                  source: dict, work: Path, frames: int = 60, fps: int = 30, idle_seconds: float = 8.0,
                  motion=None, metrics: dict | None = None) -> int:
    """From a DiGS decoder code to a validated bundle: rest-pose avatar.ply, skin.bin + skeleton.json, turntable
    preview.mp4 + thumb.jpg, and motion.json: an idle loop unless motion is given, as a Motion or as a function
    (gaussians, (skin_idx, skin_w), skeleton, stand_y) -> Motion, e.g. retarget.place_on_floor. Returns 0 when the
    bundle validates."""
    from lib.utils.infer_util import add_root_rotate_to_smplx

    dev = code.device
    betas = torch.as_tensor(betas_np, dtype=torch.float32, device=dev)
    gaussians = capture_rest_gaussians(model, code, betas, hand_mean, any_camera.reshape(1, 1, 20))
    errors = D.rest_pose_errors(gaussians.xyz, gaussians.opacity)
    if errors:
        raise SystemExit("rest-pose capture looks wrong: " + "; ".join(errors))
    stand = D.stand_y(gaussians.xyz, gaussians.opacity)
    skin, skeleton = skin_avatar(model, gaussians, betas_np, dev)
    visible_y = gaussians.xyz[1 / (1 + np.exp(-gaussians.opacity)) >= 0.5, 1]
    height, middle_y = np.ptp(visible_y), (visible_y.min() + visible_y.max()) / 2

    # Turntable: DiGS's A-pose spinning, centred, the whole body in frame. Orbit view 1 of 2 sits on +Z, in front
    # of a body facing +Z like SMPL-X's rest pose, so the first frame (the thumbnail) is the front.
    distance = focal * TURNTABLE_FILL * height / D.DIGS_H
    camera = demo._prepare_orbit_cameras(D.DIGS_H, D.DIGS_W, 2, dev, focal, distance)[1].reshape(1, 1, 20)
    spin = add_root_rotate_to_smplx(demo.get_default_smplx_params().squeeze().to(dev), frames, device=dev)
    spin[:, 70:80] = betas.reshape(1, 10)
    spin[:, 2] -= float(middle_y)
    turntable = render(model, code, spin, camera)
    save_mp4(turntable, work / "preview.mp4", fps)
    Image.fromarray((turntable[0].numpy() * 255).astype(np.uint8)).save(work / "thumb.jpg", quality=92)
    if motion is None:
        motion = D.with_hand_mean(idle_loop(betas_np, idle_seconds, fps, stand), hand_mean)
    elif callable(motion):  # a motion fitted to this avatar, e.g. a clip put on the floor
        motion = motion(gaussians, skin, skeleton, stand)

    root = write_avatar_bundle(out, dream_id, name, gaussians, motion, source=source, metrics=metrics,
                               skin=skin, skeleton=skeleton)
    for f in ("preview.mp4", "thumb.jpg"):
        shutil.copy2(work / f, root / f)
    dream = json.loads((root / "dream.json").read_text())
    dream.update(preview="preview.mp4", thumb="thumb.jpg")
    (root / "dream.json").write_text(json.dumps(dream, indent=2) + "\n")

    problems = validate_bundle(root)
    for p in problems:
        print(f"[bundle] {p}")
    print(f"{len(gaussians)} Gaussians, height {np.ptp(gaussians.xyz[:, 1]):.2f} m, stand_y {stand:.3f}")
    print(f"{'BUNDLE_FAIL' if problems else 'BUNDLE_OK'} {root}")
    return 1 if problems else 0


# ---------------------------------------------------------------- main

def main() -> int:
    args = parse_args()
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    if not torch.cuda.is_available():
        raise SystemExit("DiGS needs a CUDA GPU")
    dev = torch.device("cuda")
    out = Path(args.out).resolve()
    work = out / f"{args.id}.work"
    work.mkdir(parents=True, exist_ok=True)

    photo = ImageOps.exif_transpose(Image.open(args.image)).convert("RGB")
    crop, raw_crop, box = matte_and_crop(photo, args.rembg_model, work)
    K_photo = D.intrinsics_from_fov(photo.width, photo.height, args.fov)
    K_crop = D.centred_crop_intrinsics(K_photo, box, D.DIGS_W, D.DIGS_H)
    pose, betas_np, trans = nlf_fit(raw_crop, args.nlf, K_crop, dev)

    model, config, demo = load_digs(args.config, args.ckpt)
    from lib.utils.infer_util import get_hand_pose_mean
    from omegaconf import OmegaConf

    hand_mean = np.asarray(get_hand_pose_mean(), dtype=np.float64).reshape(90)
    fit_path = work / "ref_smplx.json"
    fit_path.write_text(json.dumps(D.digs_fit_json(pose, betas_np, trans, K_crop, hand_mean), indent=1))

    model = model.to(dev).eval()
    model.idol_decoder.renderer.image_size = [D.DIGS_W, D.DIGS_H]
    focal = float(OmegaConf.select(config, "model.params.projector_config.focal_length", default=1120.0))
    same_size = {"scale_x": 1.0, "scale_y": 1.0, "pad_x": 0.0, "pad_y": 0.0}
    demo_args = SimpleNamespace(feature_path=None, with_condition=True, without_enhance=False,
                                diffusion_steps=args.steps, default_focal=focal, camera_dist=1.5)

    # The same calls DiGS's demo makes, fed our crop and fit.
    betas = demo._get_smpl_betas(str(fit_path)).to(dev)
    ref_chw = torch.from_numpy(np.asarray(crop, dtype=np.float32) / 255).permute(2, 0, 1)[None].to(dev)
    ref_camera = demo._build_ref_camera(str(fit_path), same_size, D.DIGS_H, D.DIGS_W, demo_args, dev)
    ref_smpl = demo._load_ref_smpl_params(str(fit_path), betas, dev)
    code = demo._sample_decoder_code(demo_args, model, ref_chw.permute(0, 2, 3, 1), ref_camera, ref_smpl, ref_chw, dev)
    torch.save({"code": code.detach().cpu(), "betas": betas_np, "hand_mean": hand_mean}, work / "code.pt")

    # Reference check: the avatar re-rendered from the photo's camera, beside the crop it came from.
    ref_render = render(model, code, ref_smpl, ref_camera.reshape(1, 1, 20))[0].numpy()
    side = np.concatenate([np.asarray(crop), (ref_render * 255).astype(np.uint8)], axis=1)
    Image.fromarray(side).save(work / "ref_check.png")

    source = {"photo": Path(args.image).name, "width": photo.width, "height": photo.height,
              "model": "DiGS-Avatar student + NLF SMPL-X fit", "note": HANDS_NOTE}
    return export_bundle(model, demo, code, betas_np, hand_mean, focal, ref_camera, out, args.id, args.name, source,
                         work, frames=args.frames, fps=args.fps, idle_seconds=args.idle_seconds)


if __name__ == "__main__":
    sys.exit(main())
