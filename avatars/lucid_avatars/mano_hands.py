"""A hand regressor's MANO pose (WiLoR, HaMeR) as SMPL-X's absolute finger joint rotations, and into a Motion.

The facts this rests on (the tests pin them):

- Joint order. MANO's 15 finger joints (the pkl's kinematic tree without the wrist) run index1-3, middle1-3, pinky1-3,
  ring1-3, thumb1-3. SMPL-X's hand joints are the same 15 in the same order (smplx_layout.JOINT_NAMES), so the map is
  the identity; `convert` takes an explicit `order` only so a differently ordered source could be named.
- Mean. WiLoR and HaMeR regress ABSOLUTE rotations (rotation matrices, initialised from MANO's mean pose and fed to
  MANOLayer with no mean added). A pose in the MANO pkl / smplx convention (`hand_pose` with flat_hand_mean=False,
  or PCA coefficients expanded) is RELATIVE to MANO's hand mean: pass `relative_to_mean=True` and the mean. SMPL-X's
  own hand mean is a different (left and right) vector and never enters here: motion.json holds absolute rotations.
- Handedness. The regressors only know right hands: a left hand is fed as the mirrored image and its pose mirrored
  back. SMPL-X's left hand is the right hand's x-mirror, so a right-hand-frame pose becomes a left-hand pose by
  negating the y and z axis-angle components (hand_fk.mirror_hand). `already_mirrored` is for a library that has
  done that itself.
- The wrist is not here: MANO's global_orient is the wrist in the camera, the body fit already carries the wrist.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

import numpy as np

from .hand_fk import HAND_JOINTS, mirror_hand
from .hand_poses import blend, clamp_to_limits
from .motion import Motion
from .rotations import aa_to_quat, matrix_to_quat, quat_to_aa
from .smplx_layout import LEFT_HAND, RIGHT_HAND

MANO_JOINTS = ["index1", "index2", "index3", "middle1", "middle2", "middle3", "pinky1", "pinky2", "pinky3",
               "ring1", "ring2", "ring3", "thumb1", "thumb2", "thumb3"]
assert MANO_JOINTS == HAND_JOINTS  # the order mapping is the identity
IDENTITY_ORDER = tuple(range(15))

# detector confidence mapped to how much of the fitted hand is used: none below LOW, all above HIGH, blended between
CONF_LOW = 0.5
CONF_HIGH = 0.8


def rotmat_to_aa(R: np.ndarray) -> np.ndarray:
    """Rotation matrices (..., 3, 3) to axis-angle (..., 3); a slightly non-orthogonal matrix is snapped to the
    nearest rotation first."""
    R = np.asarray(R, dtype=np.float64)
    flat = R.reshape(-1, 3, 3)
    out = np.empty((len(flat), 3))
    for i, m in enumerate(flat):
        u, _, vt = np.linalg.svd(m)
        r = u @ vt
        if np.linalg.det(r) < 0:
            u[:, -1] *= -1
            r = u @ vt
        out[i] = quat_to_aa(matrix_to_quat(r))
    return out.reshape(R.shape[:-2] + (3,))


def to_axis_angle(hand_pose: np.ndarray) -> np.ndarray:
    """(..., 15, 3) axis-angle, (..., 45) axis-angle or (..., 15, 3, 3) rotation matrices as (..., 15, 3) axis-angle."""
    a = np.asarray(hand_pose, dtype=np.float64)
    if a.shape[-2:] == (3, 3) and a.shape[-3] == 15:
        return rotmat_to_aa(a)
    if a.shape[-1] == 45:
        return a.reshape(a.shape[:-1] + (15, 3))
    if a.shape[-2:] == (15, 3):
        return a
    raise ValueError(f"a MANO hand pose is (15, 3), (45,) or (15, 3, 3); got {a.shape}")


def convert(hand_pose: np.ndarray, is_right: bool = True, *, relative_to_mean: bool = False,
            mean: np.ndarray | None = None, already_mirrored: bool = False,
            order: tuple[int, ...] = IDENTITY_ORDER) -> np.ndarray:
    """One MANO hand pose (..., 15, 3) in absolute axis-angle for SMPL-X's `right` hand (is_right) or `left` hand.

    hand_pose: the regressor's output for that hand, in the frame of a right hand (see the module docstring), as
    axis-angle or rotation matrices. relative_to_mean: it is a pkl-convention pose and `mean` (MANO's 15 x 3 hand mean,
    right hand frame) is added. already_mirrored: the pose of a left hand is already in the left-hand frame.
    order: SMPL-X joint k is the source's joint order[k].
    """
    aa = to_axis_angle(hand_pose)
    if relative_to_mean:
        if mean is None:
            raise ValueError("a pose relative to MANO's hand mean needs that mean")
        aa = aa + to_axis_angle(mean)
    aa = aa[..., list(order), :]
    return mirror_hand(aa) if not is_right and not already_mirrored else aa.copy()


def confidence_weight(conf, low: float = CONF_LOW, high: float = CONF_HIGH) -> np.ndarray:
    """How much of a fitted hand to trust: 0 at or below `low`, 1 at or above `high`, linear between."""
    return np.clip((np.asarray(conf, dtype=np.float64) - low) / (high - low), 0.0, 1.0)


def _moving_average(x: np.ndarray, window: int) -> np.ndarray:
    if window <= 1:
        return x
    k = np.ones(window) / window
    pad = window // 2
    padded = np.concatenate([np.full(pad, x[0]), x, np.full(window - 1 - pad, x[-1])])
    return np.convolve(padded, k, mode="valid")


def smooth_series(poses: np.ndarray, weights: np.ndarray, window: int = 5) -> np.ndarray:
    """Each frame's hand pose as the weighted quaternion mean of the frames around it (window frames, weights = how much
    each frame is trusted): jitter goes, and a frame nobody trusted takes its confident neighbours' pose. A frame with
    no trusted neighbour returns zeros (the caller gives it zero weight)."""
    poses = np.asarray(poses, dtype=np.float64)
    w = np.asarray(weights, dtype=np.float64)
    n = len(poses)
    q = aa_to_quat(poses)  # (N, 15, 4)
    out = np.zeros_like(poses)
    half = window // 2
    for i in range(n):
        lo, hi = max(0, i - half), min(n, i + half + 1)
        ww = w[lo:hi]
        if ww.sum() <= 1e-9:
            continue
        ref = q[lo:hi][np.argmax(ww)]
        qs = q[lo:hi] * np.where(np.sum(q[lo:hi] * ref, axis=-1, keepdims=True) < 0, -1.0, 1.0)
        mean = np.sum(qs * ww[:, None, None], axis=0)
        out[i] = quat_to_aa(mean / np.linalg.norm(mean, axis=-1, keepdims=True))
    return out


def fuse(fallback: np.ndarray, fitted: np.ndarray, conf, *, low: float = CONF_LOW, high: float = CONF_HIGH,
         window: int = 5, strength: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    """The hands to play: the fitted pose where the fit is confident, the original (fallback) where it isn't, eased
    between. fallback (N, 15, 3), fitted (N, 15, 3) or (15, 3) (a photo: the same hand every frame), conf (N,) or a
    number (frames with no detection: 0). strength < 1 keeps some of the original everywhere. Returns the poses (N, 15, 3)
    and the weight each frame gave the fit."""
    fallback = np.asarray(fallback, dtype=np.float64)
    n = len(fallback)
    fitted = np.broadcast_to(np.asarray(fitted, dtype=np.float64), fallback.shape)
    w = confidence_weight(np.broadcast_to(np.asarray(conf, dtype=np.float64), (n,)), low, high)
    fitted_s = smooth_series(fitted, w, window)
    w_s = _moving_average(w, window)
    w_s = np.where(np.abs(fitted_s).sum(axis=(1, 2)) > 0, w_s, 0.0) * float(np.clip(strength, 0.0, 1.0))
    return blend(fallback, np.where(w_s[:, None, None] > 0, fitted_s, fallback), w_s), w_s


def clip_series_to_motion(poses: np.ndarray, conf: np.ndarray, times: np.ndarray, motion_fps: float,
                          n_frames: int, max_gap_s: float = 0.2) -> tuple[np.ndarray, np.ndarray]:
    """A fit made on sampled video frames (at `times`, seconds into the clip) as one pose and confidence per motion
    frame: each takes the nearest sample, and a frame with none within max_gap_s gets confidence 0."""
    times = np.asarray(times, dtype=np.float64)
    t = np.arange(n_frames) / motion_fps
    nearest = np.abs(t[:, None] - times[None, :]).argmin(axis=1)
    gap = np.abs(t - times[nearest])
    c = np.where(gap <= max_gap_s, np.asarray(conf, dtype=np.float64)[nearest], 0.0)
    return np.asarray(poses, dtype=np.float64)[nearest], c


def plausible(hand: np.ndarray, side: str, conf):
    """The fit pulled inside plausible joint ranges, with the confidence cut by the share of joints that had to move
    (a hand that needed half its fingers fixed is half a hand)."""
    clamped, share = clamp_to_limits(hand, side)
    return clamped, np.asarray(conf, dtype=np.float64) * (1.0 - share)


def with_hands(m: Motion, left: np.ndarray, right: np.ndarray) -> Motion:
    """The motion with both hands set: each (15, 3) for every frame, or (N, 15, 3) one per frame."""
    pose = m.pose.copy()
    for sl, hand in ((LEFT_HAND, left), (RIGHT_HAND, right)):
        h = np.asarray(hand, dtype=np.float64)
        if h.shape not in ((15, 3), (m.num_frames, 15, 3)):
            raise ValueError(f"a hand is (15, 3) or ({m.num_frames}, 15, 3), got {h.shape}")
        pose[:, sl] = h
    return replace(m, pose=pose)


# --- choosing hands among detections, and fitting them into a motion --------------------------------------------

MIN_HAND_PX = 48  # a hand box with a shorter side than this is a guess: its confidence is cut in proportion


def size_factor(box, min_px: int = MIN_HAND_PX) -> float:
    """1 for a hand box at least min_px on its short side, less for a smaller (blurrier, guessed) one."""
    x0, y0, x1, y1 = box
    return float(np.clip(min(x1 - x0, y1 - y0) / min_px, 0.0, 1.0))


def _iou(a, b) -> float:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    inter = max(w, 0.0) * max(h, 0.0)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def best_per_side(detections: list[dict], person_box=None) -> dict[str, dict | None]:
    """The most confident detection of each hand. A detection is {"box": [x0, y0, x1, y1], "is_right": bool,
    "conf": float}. With person_box (x0, y0, x1, y1) only hands whose centre is inside it count (other people's hands
    stay out). A left and a right that overlap by more than half are one hand the detector called twice: the less
    confident goes."""
    out: dict[str, dict | None] = {"left": None, "right": None}
    for d in detections:
        if person_box is not None:
            cx, cy = (d["box"][0] + d["box"][2]) / 2, (d["box"][1] + d["box"][3]) / 2
            if not (person_box[0] <= cx <= person_box[2] and person_box[1] <= cy <= person_box[3]):
                continue
        side = "right" if d["is_right"] else "left"
        if out[side] is None or d["conf"] > out[side]["conf"]:
            out[side] = d
    if out["left"] and out["right"] and _iou(out["left"]["box"], out["right"]["box"]) > 0.5:
        out["left" if out["left"]["conf"] < out["right"]["conf"] else "right"] = None
    return out


@dataclass
class SideFit:
    """One hand's fit in SMPL-X's frame: a single pose with a confidence (a photo), or one per sampled video frame
    (poses (M, 15, 3), conf (M,), times (M,) seconds into the clip)."""
    poses: np.ndarray
    conf: np.ndarray | float
    times: np.ndarray | None = None


def apply_fits(m: Motion, left: SideFit | None, right: SideFit | None, *, clip_offset_s: float = 0.0,
               strength: float = 1.0, window: int = 5, low: float = CONF_LOW,
               high: float = CONF_HIGH) -> tuple[Motion, dict]:
    """The motion with its hands replaced by the fits where they are confident; the motion's own hands stay as the
    fallback everywhere else (a side with no fit keeps them throughout). clip_offset_s is the clip time of motion
    frame 0. Returns the motion and {side: {"meanWeight", "framesFitted"}} for the report."""
    hands, report = {}, {}
    for side, sl, fit in (("left", LEFT_HAND, left), ("right", RIGHT_HAND, right)):
        fallback = m.pose[:, sl]
        if fit is None:
            hands[side], w = fallback, np.zeros(m.num_frames)
        else:
            poses, conf = np.asarray(fit.poses, dtype=np.float64), fit.conf
            if fit.times is not None:
                poses, conf = clip_series_to_motion(poses, conf, np.asarray(fit.times) - clip_offset_s, m.fps,
                                                    m.num_frames)
            hands[side], w = fuse(fallback, poses, conf, low=low, high=high, window=window, strength=strength)
        report[side] = {"meanWeight": round(float(w.mean()), 4), "framesFitted": int((w > 0.5).sum())}
    return with_hands(m, hands["left"], hands["right"]), report
