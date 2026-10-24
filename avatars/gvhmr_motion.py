"""4DAnyone's GVHMR motion for a run as our motion.json, in 4DAnyone's world (the one its cameras.json and views use).
Run in the 4DAnyone env from the 4DAnyone repo directory (it uses 4DAnyone's own code and GVHMR's SMPL-X):

    source $L/code/pipeline/hpg/env.sh && cd $L/repos/4DAnyone
    python $L/repos/lucid_dreams/avatars/gvhmr_motion.py --gvhmr $L/runs/<id>/views/gvhmr --out motion_world.json

The world transform is recomputed exactly as 4DAnyone computes it (fdanyone/skeleton/pipeline.py _body_geometry),
because 4DAnyone doesn't save it. Hands come out flat; DiGS-side tools put them in the hand mean.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lucid_avatars.gvhmr import gvhmr_to_motion  # noqa: E402
from lucid_avatars.motion import validate_motion_dict  # noqa: E402
from lucid_avatars.rotations import aa_to_quat, quat_to_matrix  # noqa: E402


def rest_pelvis(smplx, betas, device) -> np.ndarray:
    """J0, the point SMPL-X turns the body about, from vertices alone: v1 = R (v0 - J0) + J0 for two half turns."""
    import torch

    def verts(aa):
        go = torch.tensor([aa], dtype=torch.float32, device=device)
        with torch.inference_mode():
            return smplx(betas=betas, global_orient=go, body_pose=torch.zeros(1, 63, device=device),
                         transl=torch.zeros(1, 3, device=device)).vertices[0].double().cpu().numpy()

    v0 = verts([0.0, 0.0, 0.0])
    rows, rhs = [], []
    for aa in ([0.0, np.pi, 0.0], [np.pi, 0.0, 0.0]):
        R = quat_to_matrix(aa_to_quat(np.array(aa)))
        rows.append(np.eye(3) - R)
        rhs.append((verts(aa) - v0 @ R.T).mean(axis=0))
    return np.linalg.lstsq(np.concatenate(rows), np.concatenate(rhs), rcond=None)[0]


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--gvhmr", required=True, help="the run's gvhmr dir: motion.json + motion.safetensors")
    p.add_argument("--out", required=True)
    p.add_argument("--raw", action="store_true", help="keep GVHMR's own frame instead of 4DAnyone's world")
    p.add_argument("--gvhmr-root", default="third_party/GVHMR")
    p.add_argument("--model-dir", default="models")
    p.add_argument("--device", default="cuda:0")
    args = p.parse_args()

    import torch
    from fdanyone.assets import resolve_regressor
    from fdanyone.motion.gvhmr import validate_gvhmr
    from fdanyone.motion.result import MotionResult
    from fdanyone.skeleton.pipeline import _body_geometry, _gvhmr_geometry_context

    motion = MotionResult.load(args.gvhmr)
    g = {k: v.double().cpu().numpy() for k, v in motion.smpl_params_global.items()}
    drift = float(np.abs(g["betas"] - g["betas"].mean(axis=0)).max())
    warn = "  (large: the mean body may not match every frame)" if drift > 0.3 else ""
    print(f"betas drift over the clip: {drift:.3f}{warn}")
    gvhmr_root, _ = validate_gvhmr(args.gvhmr_root)
    world = None
    if not args.raw:
        geometry = _body_geometry(motion, resolve_regressor(None, args.model_dir), gvhmr_root, args.device)
        world = np.asarray(geometry.motion_world_to_canonical_world, dtype=np.float64)
    with _gvhmr_geometry_context(gvhmr_root):
        from hmr4d.utils.smplx_utils import make_smplx

        smplx = make_smplx("supermotion").to(args.device).eval()
        betas = torch.tensor(g["betas"].mean(axis=0, keepdims=True), dtype=torch.float32, device=args.device)
        J0 = rest_pelvis(smplx, betas, args.device)

    m = gvhmr_to_motion(g["global_orient"], g["body_pose"], g["transl"], g["betas"], float(motion.fps), J0, world)
    errors = validate_motion_dict(m.to_dict())
    if errors:
        raise SystemExit("converted motion is invalid: " + "; ".join(errors[:5]))
    part = Path(args.out + ".part")  # a killed job must not leave a truncated motion that later runs reuse
    m.save(part)
    part.replace(args.out)
    print(f"{m.num_frames} frames at {m.fps:g} fps, J0 {np.round(J0, 3)}")
    print("world (GVHMR -> 4DAnyone):", "raw GVHMR frame" if world is None else np.round(world, 4).tolist())
    print(f"MOTION_OK {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
