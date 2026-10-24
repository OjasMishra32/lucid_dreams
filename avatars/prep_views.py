"""A spread of frames from a finished 4DAnyone result, the person cut out, in the layout digs_finetune.py reads:
<out>/cameras.json and <out>/frames/NNNNNN/VV.png (RGBA). Run in the 4DAnyone env (it uses 4DAnyone's BiRefNet).

    source $L/code/pipeline/hpg/env.sh
    python avatars/prep_views.py --result $L/runs/<id>/views --out $L/data/avatars/finetune/<id>/views --frames 8
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(1, str(HERE.parent / "pipeline"))
from lucid_avatars.finetune_io import spread_frames  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--result", required=True, help="4DAnyone result dir: cameras.json + the generated videos")
    p.add_argument("--out", required=True)
    p.add_argument("--frames", type=int, default=8, help="how many frames, spread over the clip")
    p.add_argument("--total", type=int, default=121, help="frames in the generated videos")
    p.add_argument("--device", default="cuda:0")
    args = p.parse_args()

    from lucid.frames import FourDAnyoneFrames

    out = Path(args.out)
    (out / "frames").mkdir(parents=True, exist_ok=True)
    picks = spread_frames(args.total, args.frames)
    rig = None
    for f in picks:  # one frame at a time: all 121 x 48 views at once would be ~15 GB of RAM
        src = FourDAnyoneFrames(Path(args.result), f, f + 1, device=args.device)
        rig = src.rig
        rgba = src.rgba(f)
        d = out / "frames" / f"{f:06d}"
        d.mkdir(exist_ok=True)
        for v, img in enumerate(rgba):
            Image.fromarray(np.ascontiguousarray(img)).save(d / f"{v:02d}.png")
        seen = float((rgba[..., 3] > 127).mean())
        print(f"frame {f}: {len(rgba)} views, person covers {seen:.1%} of the pixels", flush=True)
    (out / "cameras.json").write_text(json.dumps(rig.to_json(), indent=1) + "\n")
    print(f"PREP_OK {out} frames {picks}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
