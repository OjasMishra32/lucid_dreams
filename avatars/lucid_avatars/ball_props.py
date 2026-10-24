"""The basketball for a replay's props.json, from a 4DAnyone result dir (the run's views/). HiPerGator side: runs in
the 4DAnyone env (fdanyone, GVHMR's SMPL-X file, ultralytics YOLO, PyAV); the maths is ball.py.

    views/source.mkv     the canonical clip, RGB-identical to the video GVHMR ran on (121 frames)
    views/gvhmr/         GVHMR's MotionResult: smpl_params_incam, smpl_params_global, K_fullimg, image size
    views/cameras.json   motion_world_to_canonical_world (GVHMR's world -> 4DAnyone's, where the reconstruction lives)

YOLO's COCO "sports ball" box per frame -> ball.ball_world (distance from size, smoothed over 5 frames) -> bundle
coordinates via the export's placement. Frames with no box, or a box on the image edge, are null.

Check a run's ball without re-exporting (prints the track in 4DAnyone's world, where the reconstruction lives):

    source $L/code/pipeline/hpg/env.sh && cd $RUN
    PYTHONPATH=$L/code/avatars:$PYTHONPATH python -m lucid_avatars.ball_props views --out ball_check.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from .ball import BALL_DIAMETER, ball_world, pelvis_from_model, track_for_frames

SPORTS_BALL = 32  # COCO class


def detect_ball_boxes(video: Path, model: str = "yolov8x.pt", conf: float = 0.25) -> np.ndarray:
    """(N, 4) the most confident ball box per decoded frame, x1, y1, x2, y2 in pixels; NaN where there's none."""
    import av
    from ultralytics import YOLO

    yolo = YOLO(model)
    boxes = []
    with av.open(str(video)) as container:
        for frame in container.decode(video=0):
            bgr = np.ascontiguousarray(frame.to_ndarray(format="rgb24")[..., ::-1])
            r = yolo.predict(bgr, classes=[SPORTS_BALL], conf=conf, verbose=False)[0]
            if len(r.boxes):
                boxes.append(r.boxes.xyxy.cpu().numpy()[r.boxes.conf.cpu().numpy().argmax()])
            else:
                boxes.append(np.full(4, np.nan))
    return np.asarray(boxes, dtype=np.float64).reshape(-1, 4)


def gvhmr_root() -> Path:
    import fdanyone

    return Path(fdanyone.__file__).resolve().parent.parent / "third_party" / "GVHMR"


def basketball_object(result: Path, bundle_from_canonical, n_frames: int, smooth: int = 5,
                      min_seen: int = 3) -> dict | None:
    """props.json's basketball ({"kind", "radius", "track"}) in bundle coordinates, one track entry per bundle frame;
    None when the result has no GVHMR camera or the ball is seen in fewer than min_seen frames.

    bundle_from_canonical is the export's placement as a 4x4 [rot | t] (4DAnyone's world -> bundle).
    """
    result = Path(result)
    video, motion_dir, cameras = result / "source.mkv", result / "gvhmr", result / "cameras.json"
    if not (video.exists() and (motion_dir / "motion.json").exists() and cameras.exists()):
        return None
    from fdanyone.motion.result import MotionResult

    motion = MotionResult.load(motion_dir)
    to_np = lambda params: {k: v.double().cpu().numpy() for k, v in params.items()}  # noqa: E731
    glob, incam = to_np(motion.smpl_params_global), to_np(motion.smpl_params_incam)
    model = np.load(gvhmr_root() / "inputs/checkpoints/body_models/smplx/SMPLX_NEUTRAL.npz", allow_pickle=True)
    J0 = pelvis_from_model(model["v_template"], model["shapedirs"], model["J_regressor"], glob["betas"].mean(axis=0))
    world = np.asarray(bundle_from_canonical, dtype=np.float64) @ np.asarray(
        json.loads(cameras.read_text())["motion_world_to_canonical_world"], dtype=np.float64)

    boxes = detect_ball_boxes(video)
    if len(boxes) != motion.num_frames:
        raise ValueError(f"{video.name} decoded {len(boxes)} frames, GVHMR has {motion.num_frames}")
    pts = ball_world(motion.K_fullimg.double().cpu().numpy(), boxes, incam, glob, J0, world,
                     width=motion.image_width, height=motion.image_height, smooth=smooth)
    seen = int(np.isfinite(pts).all(axis=1).sum())
    print(f"[ball] seen in {seen}/{len(pts)} GVHMR frames")
    if seen < min_seen:
        return None
    return {"kind": "basketball", "radius": BALL_DIAMETER / 2, "track": track_for_frames(pts, n_frames)}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("views", type=Path, help="the run's 4DAnyone result dir")
    p.add_argument("--out", type=Path, help="write the object as JSON here")
    a = p.parse_args(argv)
    obj = basketball_object(a.views, np.eye(4), 121)
    if obj is None:
        print("BALL_NONE (no GVHMR camera in that dir, or the ball was seen in fewer than 3 frames)")
        return 1
    if a.out:
        a.out.write_text(json.dumps(obj))
    print("BALL_OK", sum(p is not None for p in obj["track"]), "of", len(obj["track"]), "frames")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
