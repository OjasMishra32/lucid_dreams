"""Real fingers for an avatar bundle: WiLoR finds both hands in the source photo (or in a clip's frames), regresses their
MANO poses, and the SMPL-X finger joints of the bundle's motion.json become those (replacing DiGS's hand mean in the
idle; a time series for a clip). Wherever the detector is unsure the bundle's original hands stay, eased in and out.

  python fit_hands.py dreams/<id> --photo photo.jpg [--box x0,y0,x1,y1]
  python fit_hands.py dreams/<id> --video clip.mp4 [--clip-start S] [--every 2]

Runs in the WiLoR env (avatars/hpg/hands.sbatch builds it). The plain parts are lucid_avatars/mano_hands.py (MANO ->
SMPL-X maths, confidence blending, tests); this file only runs the model and writes the bundle.

Model: WiLoR (Potamias et al., CVPR 2025) through the WiLoR-mini package: a YOLO hand detector and the WiLoR regressor.
Licences: WiLoR's models are CC BY-NC-ND 4.0 (we use only the poses it outputs, for this non-commercial project, and
never share its weights); MANO has its own non-commercial licence, so MANO_RIGHT.pkl comes from our own registration
(--weights DIR/pretrained_models/), never from a mirror. WiLoR only knows right hands: a left hand is run on the
mirrored image as a right hand and its pose mirrored back by lucid_avatars (the image is never given to the library as
a left hand, so there is no second mirroring to guess about).

Out: the bundle's avatar/motion.json updated, the untouched original kept as avatar/motion.hands-original.json (a rerun
always starts from it, so running twice changes nothing), hands.json beside dream.json (what was found, confidence,
how much of each hand is the fit), and --work/hands_raw.npz when asked. The photo or clip is read here and goes nowhere.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lucid_avatars import mano_hands as M  # noqa: E402
from lucid_avatars.bundle import validate_bundle  # noqa: E402
from lucid_avatars.hand_poses import clamp_to_limits  # noqa: E402
from lucid_avatars.motion import Motion  # noqa: E402

ORIGINAL = "motion.hands-original.json"
REPORT = "hands.json"
DETECT_CONF = 0.3  # the detector's own floor; below CONF_LOW the fit is not used anyway


def default_device() -> str:
    import torch
    return "cuda" if torch.cuda.is_available() else "cpu"


def load_pipeline(weights: Path, device: str):
    """WiLoR-mini's pipeline from files already in `weights`/pretrained_models (nothing is fetched: the sbatch put the
    weights there, and MANO_RIGHT.pkl must be our own copy)."""
    import torch
    from wilor_mini.pipelines.wilor_hand_pose3d_estimation_pipeline import WiLorHandPose3dEstimationPipeline

    need = ("wilor_final.ckpt", "detector.pt", "mano_mean_params.npz", "MANO_RIGHT.pkl")
    missing = [n for n in need if not (weights / "pretrained_models" / n).is_file()]
    if missing:
        raise SystemExit(f"missing in {weights / 'pretrained_models'}: {', '.join(missing)} (see hpg/hands.sbatch)")
    dtype = torch.float16 if device.startswith("cuda") else torch.float32
    return WiLorHandPose3dEstimationPipeline(device=device, dtype=dtype, wilor_pretrained_dir=str(weights), verbose=False)


def detect(pipe, rgb: np.ndarray) -> list[dict]:
    """Every hand the detector finds: {"box": [x0, y0, x1, y1], "is_right": bool, "conf": float} (class 1 = right,
    as WiLoR's own demo reads it)."""
    res = pipe.hand_detector(rgb, conf=DETECT_CONF, verbose=False)[0]
    boxes = res.boxes
    xyxy, cls, conf = boxes.xyxy.cpu().numpy(), boxes.cls.cpu().numpy(), boxes.conf.cpu().numpy()
    return [{"box": [float(v) for v in b], "is_right": bool(round(float(c))), "conf": float(p)}
            for b, c, p in zip(xyxy, cls, conf)]


def regress_right_frame(pipe, rgb: np.ndarray, det: dict) -> np.ndarray:
    """The hand's MANO pose in a right hand's frame, (15, 3) axis-angle. A left hand is run as a right hand on the
    mirrored image."""
    h, w = rgb.shape[:2]
    x0, y0, x1, y1 = det["box"]
    if det["is_right"]:
        image, box = rgb, [x0, y0, x1, y1]
    else:
        image, box = np.ascontiguousarray(rgb[:, ::-1]), [w - x1, y0, w - x0, y1]
    out = pipe.predict_with_bboxes(image, np.asarray([box], dtype=np.float32), [True])
    if not out:
        raise RuntimeError("WiLoR returned nothing for a box it was given")
    pose = np.asarray(out[0]["wilor_preds"]["hand_pose"])
    if pose.ndim in (3, 4) and pose.shape[0] == 1:
        pose = pose[0]
    return M.to_axis_angle(pose)


def fit_image(pipe, rgb: np.ndarray, person_box=None) -> dict[str, dict | None]:
    """{"left"/"right": {"pose": (15, 3) SMPL-X, "conf", "box", "clamped"} or None} for one image."""
    chosen = M.best_per_side(detect(pipe, rgb), person_box)
    out: dict[str, dict | None] = {}
    for side, det in chosen.items():
        if det is None:
            out[side] = None
            continue
        pose = M.convert(regress_right_frame(pipe, rgb, det), is_right=(side == "right"))
        clamped = float(clamp_to_limits(pose, side)[1])  # the share of joints the fit had to pull inside the limits
        pose, conf = M.plausible(pose, side, det["conf"] * M.size_factor(det["box"]))
        out[side] = {"pose": pose, "conf": float(conf), "box": det["box"], "detConf": det["conf"], "clamped": clamped}
    return out


def read_rgb(path: str) -> np.ndarray:
    import cv2
    bgr = cv2.imread(path)
    if bgr is None:
        raise SystemExit(f"can't read the photo {path}")
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def video_frames(path: str, start: float, seconds: float | None, every: int, limit: int):
    """(time in the clip, RGB frame) for every `every`th frame from `start`, at most `limit`."""
    import cv2
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise SystemExit(f"can't open the clip {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(start * fps))
    i, got = int(start * fps), 0
    while got < limit:
        ok, bgr = cap.read()
        t = i / fps
        if not ok or (seconds is not None and t > start + seconds):
            break
        if (i - int(start * fps)) % every == 0:
            yield t, cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            got += 1
        i += 1
    cap.release()


def side_fit(per_frame: list[dict | None], times: list[float], side: str) -> M.SideFit | None:
    """A clip's per-frame results for one side as a time series; frames with no detection get zero confidence."""
    if not any(r and r[side] for r in per_frame):
        return None
    poses = np.stack([r[side]["pose"] if r and r[side] else np.zeros((15, 3)) for r in per_frame])
    conf = np.array([r[side]["conf"] if r and r[side] else 0.0 for r in per_frame])
    return M.SideFit(poses, conf, np.asarray(times))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("bundle", help="an avatar bundle folder (dreams/<id>)")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--photo", help="the source photo")
    src.add_argument("--video", help="the source clip: a time series of hands")
    p.add_argument("--box", help="x0,y0,x1,y1 of the person in the photo/clip: only hands inside it count")
    p.add_argument("--weights", default=str(Path.home() / "wilor"), help="folder holding pretrained_models/")
    p.add_argument("--device", default=None, help="cuda or cpu (default: cuda if there is one)")
    p.add_argument("--clip-start", type=float, default=0.0, help="clip time (s) where the fit starts")
    p.add_argument("--clip-seconds", type=float, default=None, help="how long to read (default: to the end)")
    p.add_argument("--clip-offset", type=float, default=None,
                   help="clip time (s) of the bundle's motion frame 0 (default: --clip-start)")
    p.add_argument("--every", type=int, default=2, help="fit every Nth clip frame")
    p.add_argument("--max-frames", type=int, default=900)
    p.add_argument("--strength", type=float, default=1.0, help="0-1: how much of the fit to use where it is sure")
    p.add_argument("--work", help="folder for hands_raw.npz (every detection's raw numbers)")
    args = p.parse_args(argv)

    root = Path(args.bundle)
    dream = json.loads((root / "dream.json").read_text())
    av = dream.get("avatar")
    if dream.get("kind") != "avatar" or not av:
        raise SystemExit(f"{root} is not an avatar bundle")
    motion_path = root / av["motion"]
    original = motion_path.parent / ORIGINAL
    if not original.exists():  # the first run keeps the untouched motion; every run starts from it
        shutil.copy2(motion_path, original)
    motion = Motion.load(original)

    pipe = load_pipeline(Path(args.weights), args.device or default_device())
    box = [float(v) for v in args.box.split(",")] if args.box else None

    if args.photo:
        found = fit_image(pipe, read_rgb(args.photo), box)
        fits = {s: (M.SideFit(r["pose"], r["conf"]) if r else None) for s, r in found.items()}
        offset, mode, detail = 0.0, "photo", {s: ({k: v for k, v in r.items() if k != "pose"} if r else None)
                                              for s, r in found.items()}
        raw = {f"{s}_pose": r["pose"] for s, r in found.items() if r}
    else:
        per_frame, times = [], []
        for t, rgb in video_frames(args.video, args.clip_start, args.clip_seconds, max(1, args.every), args.max_frames):
            per_frame.append(fit_image(pipe, rgb, box))
            times.append(t)
        if not per_frame:
            raise SystemExit("no frames read from the clip")
        fits = {s: side_fit(per_frame, times, s) for s in ("left", "right")}
        offset = args.clip_start if args.clip_offset is None else args.clip_offset
        mode = "clip"
        detail = {s: {"framesSampled": len(times),
                      "framesWithHand": int(sum(1 for r in per_frame if r[s])),
                      "meanConf": round(float(np.mean([r[s]["conf"] for r in per_frame if r[s]] or [0.0])), 4)}
                  for s in ("left", "right")}
        raw = {"times": np.asarray(times)}
        for s in ("left", "right"):
            if fits[s] is not None:
                raw[f"{s}_poses"], raw[f"{s}_conf"] = fits[s].poses, fits[s].conf

    new, used = M.apply_fits(motion, fits["left"], fits["right"], clip_offset_s=offset, strength=args.strength)
    new.save(motion_path)
    (root / REPORT).write_text(json.dumps({
        "mode": mode, "model": "WiLoR (CVPR 2025) via WiLoR-mini; MANO pose -> SMPL-X finger joints",
        "weightsLicence": "CC BY-NC-ND 4.0 (WiLoR); MANO non-commercial", "strength": args.strength,
        "found": detail, "used": used, "original": f"avatar/{ORIGINAL}",
    }, indent=1) + "\n")
    if args.work:
        Path(args.work).mkdir(parents=True, exist_ok=True)
        np.savez(Path(args.work) / "hands_raw.npz", **raw)

    for side in ("left", "right"):
        print(f"[hands] {side}: found {detail[side]}  fit weight {used[side]}")
    problems = validate_bundle(root)
    for line in problems:
        print("PROBLEM:", line)
    if problems:
        return 1
    print("HANDS_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
