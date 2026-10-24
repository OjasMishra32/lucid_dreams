"""Virtual STILL camera: warp every frame into one fixed camera (same centre C, no lens distortion) and map image
points to court metres.

  python3 -I stabilize.py --calib calib.json --out stab/ [--ref-frame N | --f0 max|<px>] [--ext jpg|png]

The still camera is either one real frame's own camera (--ref-frame N, a source frame number: that frame's R and f,
pinhole, principal point on that frame's pixel grid, so frame N lands on the canvas as its own pixels with only the
lens distortion taken out) or the mean rotation at the tightest zoom (the default). With --ref-frame the focal is
never lowered to fit a canvas cap: the clip tools quote it as the clip's focal.

Writes stab/frames/NNNNNN.<ext>, stab/valid/NNNNNN.png (where the frame has data) and stab/still_camera.json (K, R,
C, canvas size). The calibration file is read, never rewritten. Because C is shared, the warp is exact for the whole
scene (no parallax).

Library use:
  from stabilize import frame_camera, ref_still_camera, crop_maps, canvas_points, image_to_floor
  cam = frame_camera(calib, t)                 # or still_camera_from_calib(calib) for the calib's own still camera
  still = ref_still_camera(calib, n)           # frame n's camera, pinhole, on frame n's pixel grid
  mu, mv, ok = crop_maps(still, fr, w, h, x0, y0, cw, ch)   # where to sample frame `fr` for a canvas window
  x, z = image_to_floor(u, v, cam)             # court metres on the floor (feet, ball bounces)
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cv2  # noqa: E402
import numpy as np  # noqa: E402

import camgeom as cg  # noqa: E402


def frame_camera(calib, t):
    fr = calib["frames"][t]
    w, h = calib["image_size"]
    cx, cy = cg.principal(w, h)
    return dict(R=np.array(fr["R"]), C=np.array(fr["C"]), f=fr["f"], k1=fr["k1"], cx=cx, cy=cy)


def frame_index(calib, n):
    """Index into calib["frames"] of source frame n (frames carry "source_frame"; older files: t = position)."""
    for t, fr in enumerate(calib["frames"]):
        if fr.get("source_frame", t) == n:
            return t
    raise KeyError(f"source frame {n} is not in the calibration")


def still_camera_from_calib(calib):
    s = calib["still_camera"]
    K = np.array(s["K"])
    return dict(R=np.array(s["R"]), C=np.array(s["C"]), f=K[0, 0], k1=0.0, cx=K[0, 2], cy=K[1, 2])


def ref_still_camera(calib, n, offset=(0, 0)):
    """Source frame n's own camera as the still camera: its R and f, no distortion, principal point at that frame's
    image centre shifted by a whole-pixel `offset` (canvas pixel (u, v) = frame-n pixel (u - ox, v - oy))."""
    fr = calib["frames"][frame_index(calib, n)]
    w, h = calib["image_size"]
    cx, cy = cg.principal(w, h)
    f = float(fr["f"])
    K = np.array([[f, 0, cx + offset[0]], [0, f, cy + offset[1]], [0, 0, 1.0]])
    return dict(K=K.tolist(), R=np.array(fr["R"]).tolist(), C=list(fr["C"]), size=[w, h], f0=f, ref_frame=n,
                note="pinhole, no distortion; x_cam = R (X - C); the reference frame's own camera")


def image_to_floor(u, v, cam):
    """Pixels -> (x, z) court metres where the viewing ray meets the floor (NaN above the horizon)."""
    d = cg.pixel_rays(np.asarray(u, float), np.asarray(v, float), cam["R"], cam["f"], cam["k1"], cam["cx"], cam["cy"])
    P, ok = cg.ray_floor(cam["C"], d)
    P = np.where(ok[..., None], P, np.nan)
    return P[..., 0], P[..., 2]


def image_to_vertical_plane(u, v, cam, through_xz, normal_xz=None):
    """Pixels -> 3D points on the upright plane through court point `through_xz`. By default the plane faces the
    camera (normal = horizontal direction from C to that point), which is the right choice for an airborne
    player whose floor position (x, z) is known from a nearby grounded frame."""
    p0 = np.array([through_xz[0], 0.0, through_xz[1]])
    if normal_xz is None:
        n = p0 - cam["C"]
        n[1] = 0
    else:
        n = np.array([normal_xz[0], 0.0, normal_xz[1]])
    n = n / np.linalg.norm(n)
    d = cg.pixel_rays(np.asarray(u, float), np.asarray(v, float), cam["R"], cam["f"], cam["k1"], cam["cx"], cam["cy"])
    X, ok = cg.ray_plane(cam["C"], d, p0, n)
    return np.where(ok[..., None], X, np.nan)


def _frame_bounds(frames, R0, w, h):
    """Normalised still-camera coordinates of every frame's border (to size a canvas)."""
    cx, cy = cg.principal(w, h)
    s = np.arange(0, max(w, h) + 1, 8, dtype=float)
    bu = np.concatenate([s[s < w], np.full(len(s[s < h]), w - 1.0), s[s < w], np.zeros(len(s[s < h]))])
    bv = np.concatenate([np.zeros(len(s[s < w])), s[s < h], np.full(len(s[s < w]), h - 1.0), s[s < h]])
    xs, ys = [], []
    for fr in frames:
        d = cg.pixel_rays(bu, bv, np.array(fr["R"]), fr["f"], fr["k1"], cx, cy)
        Xc = d @ R0.T
        ok = Xc[:, 2] > 1e-3
        xs.append(Xc[ok, 0] / Xc[ok, 2])
        ys.append(Xc[ok, 1] / Xc[ok, 2])
    return np.concatenate(xs), np.concatenate(ys)


def design_still_camera(calib, f0="max", margin=16, max_side=8192, ref=None):
    w, h = calib["image_size"]
    frames = calib["frames"]
    if ref is not None:
        # the reference frame's own camera; the canvas grows to hold every frame, on that frame's pixel grid
        still = ref_still_camera(calib, ref)
        R0, f = np.array(still["R"]), still["f0"]
        xs, ys = _frame_bounds(frames, R0, w, h)
        cx, cy = cg.principal(w, h)
        ox = int(np.ceil(max(0.0, -(xs.min() * f + cx)))) + margin
        oy = int(np.ceil(max(0.0, -(ys.min() * f + cy)))) + margin
        W0 = int(np.ceil(xs.max() * f + cx)) + ox + margin + 1
        H0 = int(np.ceil(ys.max() * f + cy)) + oy + margin + 1
        if max(W0, H0) > max_side:
            print(f"warning: canvas {W0}x{H0} is past {max_side}px; the reference focal is kept")
        still = ref_still_camera(calib, ref, (ox, oy))
        still["size"] = [W0, H0]
        return still
    cx, cy = cg.principal(w, h)
    R0 = cg.mean_rotation([np.array(fr["R"]) for fr in frames])
    fs = np.array([fr["f"] for fr in frames])
    f0 = float(fs.max()) if f0 == "max" else float(f0)
    xs, ys = _frame_bounds(frames, R0, w, h)
    span = max((xs.max() - xs.min()) * f0, (ys.max() - ys.min()) * f0)
    if span + 2 * margin > max_side:
        f0 = (max_side - 2 * margin) / max(xs.max() - xs.min(), ys.max() - ys.min())
        print(f"warning: canvas capped at {max_side}px, f0 lowered to {f0:.0f}px")
    W0 = int(np.ceil((xs.max() - xs.min()) * f0)) + 2 * margin
    H0 = int(np.ceil((ys.max() - ys.min()) * f0)) + 2 * margin
    c0 = (-xs.min() * f0 + margin, -ys.min() * f0 + margin)
    K0 = np.array([[f0, 0, c0[0]], [0, f0, c0[1]], [0, 0, 1.0]])
    return dict(K=K0.tolist(), R=R0.tolist(), C=calib["C"], size=[W0, H0], f0=f0,
                note="pinhole, no distortion; x_cam = R (X - C); same world frame as the per-frame cameras")


def crop_maps(still, fr, w, h, x0, y0, cw, ch):
    """For every pixel of the canvas window [x0, x0 + cw) x [y0, y0 + ch): where to sample frame `fr` (float maps)
    and whether it lands inside the frame. One centre for every frame, so this is a pure rotation + zoom + lens."""
    K0, R0 = np.array(still["K"], float), np.array(still["R"], float)
    cx, cy = cg.principal(w, h)
    # canvas ray in the still camera -> the same ray in frame fr's camera: x_fr = R_fr R0^T x_still
    M = np.array(fr["R"], float) @ R0.T
    mu, mv = np.empty((ch, cw), np.float32), np.empty((ch, cw), np.float32)
    ok = np.empty((ch, cw), bool)
    xs = (np.arange(x0, x0 + cw, dtype=float) - K0[0, 2]) / K0[0, 0]
    for r in range(0, ch, 256):  # row bands keep big windows' float64 temporaries small
        ys = ((np.arange(y0 + r, y0 + min(ch, r + 256), dtype=float) - K0[1, 2]) / K0[1, 1])[:, None]
        X = M[0, 0] * xs + M[0, 1] * ys + M[0, 2]
        Y = M[1, 0] * xs + M[1, 1] * ys + M[1, 2]
        Z = M[2, 0] * xs + M[2, 1] * ys + M[2, 2]
        Zs = np.where(np.abs(Z) < 1e-12, 1e-12, Z)
        xn, yn = X / Zs, Y / Zs
        s = 1.0 + fr["k1"] * (xn * xn + yn * yn)
        u, v = fr["f"] * xn * s + cx, fr["f"] * yn * s + cy
        mu[r:r + 256], mv[r:r + 256] = u, v
        ok[r:r + 256] = (Z > 0) & (u >= -0.5) & (u <= w - 0.5) & (v >= -0.5) & (v <= h - 0.5)
    return mu, mv, ok


def canvas_points(still, fr, w, h, u, v):
    """Frame `fr` pixels (u, v) -> still-camera canvas pixels (the inverse of crop_maps' mapping)."""
    K0, R0 = np.array(still["K"], float), np.array(still["R"], float)
    cx, cy = cg.principal(w, h)
    d = cg.pixel_rays(np.asarray(u, float), np.asarray(v, float), np.array(fr["R"]), fr["f"], fr["k1"], cx, cy)
    Xc = d @ R0.T
    return K0[0, 0] * Xc[..., 0] / Xc[..., 2] + K0[0, 2], K0[1, 1] * Xc[..., 1] / Xc[..., 2] + K0[1, 2]


def warp_maps(still, fr, w, h):
    """crop_maps over the whole canvas."""
    W0, H0 = still["size"]
    return crop_maps(still, fr, w, h, 0, 0, W0, H0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--calib", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--frames", help="frames folder (default: the one recorded in calib.json)")
    ap.add_argument("--ref-frame", type=int, default=None,
                    help="source frame whose own camera is the still camera (its R and f, pinhole)")
    ap.add_argument("--f0", default="max", help="still focal without --ref-frame: max or pixels")
    ap.add_argument("--ext", default="jpg", choices=["jpg", "png"])
    a = ap.parse_args()
    with open(a.calib) as fh:
        calib = json.load(fh)
    w, h = calib["image_size"]
    src = a.frames or calib["frames_dir"]
    if calib.get("segments"):
        print(f"warning: the camera centre jumps at frames {calib['segments']}: the still camera uses the mean C, so "
              "stabilised frames and floor mapping on them are off by the jump size; map points on the original "
              "frames with frame_camera() instead")
    still = design_still_camera(calib, a.f0, ref=a.ref_frame)
    os.makedirs(os.path.join(a.out, "frames"), exist_ok=True)
    os.makedirs(os.path.join(a.out, "valid"), exist_ok=True)
    for fr in calib["frames"]:
        img = cv2.imread(os.path.join(src, fr["file"]))
        mu, mv, ok = warp_maps(still, fr, w, h)
        out = cv2.remap(img, mu, mv, cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_CONSTANT)
        out[~ok] = 0
        stem = os.path.splitext(fr["file"])[0]
        cv2.imwrite(os.path.join(a.out, "frames", f"{stem}.{a.ext}"), out,
                    [cv2.IMWRITE_JPEG_QUALITY, 95] if a.ext == "jpg" else [])
        cv2.imwrite(os.path.join(a.out, "valid", f"{stem}.png"), ok.astype(np.uint8) * 255)
    still["frames_dir"] = os.path.abspath(os.path.join(a.out, "frames"))
    with open(os.path.join(a.out, "still_camera.json"), "w") as fh:
        json.dump(still, fh, indent=1)
    print(f"still camera: f0={still['f0']:.0f}px canvas {still['size'][0]}x{still['size'][1]} -> {a.out}")


if __name__ == "__main__":
    main()
