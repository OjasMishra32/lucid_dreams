"""GVHMR (the copy bundled in 4DAnyone) on one plain video, no 4DAnyone run needed. HiPerGator, 4DAnyone env:

    source $L/code/pipeline/hpg/env.sh && cd $L/repos/4DAnyone
    python gvhmr_clip.py --video clip.mp4 --out clip.gvhmr.npz

Writes an npz with GVHMR's world-grounded SMPL-X fit (gravity-aligned, +Y up, arbitrary heading and floor height):
global_orient (T,3), body_pose (T,63), transl (T,3), betas (T,10), fps, plus the clip body's rest joints (55,3) and
rest pelvis J0 for the mean betas (SMPL-X turns the body about J0), the lowest mesh vertex per frame (floor), the
in-camera fit, the person box and ViTPose's 2D keypoints (to check the fit against the video).
Static camera only (GVHMR's static_cam path); a panning camera leaks into the root path, never into the joint angles.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import numpy as np


def rest_and_lbs(model_npz: Path, betas: np.ndarray):
    d = np.load(model_npz, allow_pickle=True)
    v = d["v_template"] + np.einsum("vck,k->vc", d["shapedirs"][..., :10], betas)
    joints = d["J_regressor"][:55] @ v
    parents = d["kintree_table"][0].astype(np.int64)
    parents[0] = -1
    return joints, v, d["weights"], parents


def fk_vertices(rest, verts, weights, parents, go, bp, transl, J0):
    """Posed vertices (T,V,3) and joints (T,55,3) by plain LBS (no pose correctives: enough for the floor)."""
    from scipy.spatial.transform import Rotation as Rot

    T = len(go)
    pose = np.zeros((T, 55, 3))
    pose[:, 0] = go
    pose[:, 1:22] = bp.reshape(T, 21, 3)
    R = Rot.from_rotvec(pose.reshape(-1, 3)).as_matrix().reshape(T, 55, 3, 3)
    G = np.zeros((T, 55, 4, 4))
    for j, p in enumerate(parents):
        L = np.zeros((T, 4, 4))
        L[:, :3, :3] = R[:, j]
        L[:, :3, 3] = rest[j] - (rest[p] if p >= 0 else 0)
        L[:, 3, 3] = 1
        G[:, j] = L if p < 0 else G[:, p] @ L
    joints = G[:, :, :3, 3] + transl[:, None]
    M = G.copy()
    M[:, :, :3, 3] -= np.einsum("tjab,jb->tja", G[:, :, :3, :3], rest)
    posed = np.zeros((T, len(verts), 3), dtype=np.float32)
    for s in range(0, T, 32):  # chunks keep the (t, V, 4, 4) blend small
        Mv = np.einsum("vj,tjab->tvab", weights, M[s:s + 32])
        posed[s:s + 32] = np.einsum("tvab,vb->tva", Mv[..., :3, :3], verts) + Mv[..., :3, 3] + transl[s:s + 32, None]
    return posed, joints


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--video", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--work", default=None, help="GVHMR's working dir (preprocess caches); default next to --out")
    p.add_argument("--gvhmr-root", default="third_party/GVHMR")
    p.add_argument("--device", default="cuda:0")
    args = p.parse_args()

    import torch
    from fdanyone.motion import gvhmr as G
    from fdanyone.vendor.pytorch3d_compat import install_if_needed

    root, revision = G.validate_gvhmr(args.gvhmr_root)
    video = Path(args.video).resolve()
    out = Path(args.out).resolve()
    work = Path(args.work).resolve() if args.work else out.with_suffix(".work")
    work.mkdir(parents=True, exist_ok=True)
    probe = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,width,height",
        "-of", "json", str(video)]))["streams"][0]
    num, den = probe["r_frame_rate"].split("/")
    fps = float(num) / float(den)

    with G.gvhmr_imports(root), G._legacy_checkpoint_loading():
        install_if_needed()
        import hydra
        from hmr4d.model.gvhmr.gvhmr_pl_demo import DemoPL  # noqa: F401
        from hmr4d.utils.net_utils import detach_to_cpu
        from hydra import compose, initialize_config_module
        from omegaconf import open_dict

        G._register_inference_store()
        with initialize_config_module(version_base="1.3", config_module="hmr4d.configs"):
            cfg = compose(config_name="demo", overrides=[
                G.hydra_override("video_name", video.stem), "static_cam=true", "verbose=false", "use_dpvo=false",
                G.hydra_override("output_root", work)])
        Path(cfg.output_dir).mkdir(parents=True, exist_ok=True)
        Path(cfg.preprocess_dir).mkdir(parents=True, exist_ok=True)
        with open_dict(cfg):
            cfg.video_path = str(video)
        G._run_preprocess(cfg)
        data = G._load_data(cfg)
        bbx = torch.load(cfg.paths.bbx, weights_only=True)
        kp2d = data["kp2d"].detach().cpu().numpy()
        model = hydra.utils.instantiate(cfg.model, _recursive_=False)
        model.load_pretrained_model(cfg.ckpt_path)
        model = model.eval().to(args.device)
        with torch.inference_mode():
            pred = detach_to_cpu(model.predict(data, static_cam=True))

    g = {k: v.double().numpy() for k, v in pred["smpl_params_global"].items()}
    c = {k: v.double().numpy() for k, v in pred["smpl_params_incam"].items()}
    betas = g["betas"].mean(axis=0)
    model_npz = root / "inputs/checkpoints/body_models/smplx/SMPLX_NEUTRAL.npz"
    rest, verts, weights, parents = rest_and_lbs(model_npz, betas)
    posed, joints = fk_vertices(rest, verts, weights, parents, g["global_orient"], g["body_pose"], g["transl"], rest[0])
    np.savez_compressed(
        out, fps=fps, gvhmr_revision=revision, width=probe["width"], height=probe["height"],
        global_orient=g["global_orient"], body_pose=g["body_pose"], transl=g["transl"], betas_per_frame=g["betas"],
        betas=betas, rest_joints=rest, J0=rest[0], joints=joints.astype(np.float32),
        vmin_y=posed[..., 1].min(axis=1), vmin_xz=posed[np.arange(len(posed)), posed[..., 1].argmin(axis=1)][:, [0, 2]],
        incam_global_orient=c["global_orient"], incam_transl=c["transl"], K=pred["K_fullimg"].numpy(),
        bbx_xyxy=bbx["bbx_xyxy"].numpy(), kp2d=kp2d,
    )
    print(f"{len(g['transl'])} frames at {fps:g} fps, betas drift {np.abs(g['betas'] - betas).max():.3f}")
    print(f"GVHMR_OK {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
