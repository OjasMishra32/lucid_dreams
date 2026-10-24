""""You, perfected": a teammate's avatar performs someone else's move. Run from the DiGS-Avatar repo directory, in the
DiGS env, on a GPU.

    python /path/to/avatars/digs_perform.py --start <out>/<teammate>.work/code.pt --motion motion_world.json \
        --out <dreams dir> --id vishal-jumper --name "Vishal, Steph's jumper"

--start: code.pt from digs_avatar.py or digs_finetune.py (the avatar). --motion: a motion.json from gvhmr_motion.py
(the move, performed by someone else's body). The joint rotations carry over as they are; the root path is scaled
by leg length; hands rest in the hand mean; the clip is turned to face the viewer with the avatar's soles on y = 0.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import digs_avatar as A  # noqa: E402
from lucid_avatars import skinning as S  # noqa: E402
from lucid_avatars.motion import Motion  # noqa: E402
from lucid_avatars.retarget import leg_length, place_on_floor, retarget  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--start", required=True)
    p.add_argument("--motion", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--id", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--ckpt", default="checkpoints/student.ckpt")
    p.add_argument("--config", default="configs/student_inpaint.yaml")
    args = p.parse_args()
    if not torch.cuda.is_available():
        raise SystemExit("DiGS needs a CUDA GPU")
    dev = torch.device("cuda")
    out = Path(args.out).resolve()
    work = out / f"{args.id}.work"
    work.mkdir(parents=True, exist_ok=True)

    from omegaconf import OmegaConf

    start = torch.load(args.start, map_location="cpu", weights_only=False)
    hand_mean = np.asarray(start["hand_mean"], dtype=np.float64).reshape(90)
    betas = np.asarray(start["betas"], dtype=np.float64).reshape(10)
    move = Motion.load(args.motion)

    model, config, demo = A.load_digs(args.config, args.ckpt)
    if "idol_decoder" in start:  # a digs_finetune.py --tune-decoder avatar carries its own decoder
        model.idol_decoder.load_state_dict(start["idol_decoder"])
    model = model.to(dev).eval()
    model.idol_decoder.renderer.image_size = [A.D.DIGS_W, A.D.DIGS_H]
    bm = model.idol_decoder.deformer.body_model
    as_np = lambda t: t.detach().float().cpu().numpy()  # noqa: E731
    rest_src, _ = S.rest_joints(as_np(bm.v_template), as_np(bm.shapedirs), as_np(bm.J_regressor), move.betas)

    def fit(g, skin, sk, stand):
        rest_dst = np.asarray(sk["rest"])
        m = A.D.with_hand_mean(retarget(move, rest_src, rest_dst, betas), hand_mean)
        print(f"leg length: mover {leg_length(rest_src):.3f} m, avatar {leg_length(rest_dst):.3f} m")
        return place_on_floor(m, g.xyz, g.opacity, *skin, rest_dst)

    focal = float(OmegaConf.select(config, "model.params.projector_config.focal_length", default=1120.0))
    any_camera = demo._prepare_orbit_cameras(A.D.DIGS_H, A.D.DIGS_W, 1, dev, focal, 3.0)[0]
    source = {"avatar": str(args.start), "motion": str(args.motion),
              "model": "DiGS-Avatar + GVHMR motion retargeted by leg length", "note": A.HANDS_NOTE}
    with torch.no_grad():
        return A.export_bundle(model, demo, start["code"].to(dev), betas, hand_mean, focal, any_camera, out, args.id,
                               args.name, source, work, fps=int(round(move.fps)), motion=fit)


if __name__ == "__main__":
    sys.exit(main())
