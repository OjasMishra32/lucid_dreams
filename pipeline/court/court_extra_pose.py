"""The other real cameras' poses from the court calibration, instead of a silhouette solve against a body that hasn't
seen the real frame yet (wide angles fail it: 4DAnyone's person is a few cm off the real one, so a 6-DoF solve turns
the camera to fit the wrong body, or gives up under its 0.8 floor).

    python3 -I court_extra_pose.py <run folder>...     writes real/<name>/pose.json for each of the run's other views

pose.json holds two court cameras, both from the run folder itself: the other view's (real/<name>/camera.json: R
camera-from-world, C, K of its video) and the source camera's still (court-run.json: the same for source-4k.mkv).
Nothing in it depends on the run's own reconstruction, so one file serves every seed.

At recon time (lucid.source_view's solve hook calls fixed_solve) the source camera has been solved in the recon's own
world. Court and recon world are then tied: a court point and its recon point sit on the same pixel of the two source
cameras (their principal points differ, which the pixel grid's best rotation absorbs), at depths in a ratio set so the
recon's soles stand on the court floor. The other camera goes through the same map, its focal the calibrated one.
That ratio is the one thing calibration can't fix, and a grazing source camera sees it poorly (1% of it moves the
body ~1% of the camera's distance along its rays), so the first other view that trains fits it alone, in 1-D, around
the soles' value, and the others take the same (one recon world, one scale). A held-out view (weight 0) never fits it:
it takes a trained view's, else the soles'. A trained view that still can't line up (IoU under MIN_IOU) is left out
rather than pulling the body apart.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

LOW_PCT = 0.5  # the soles: this percentile of the solid Gaussians' height, so a stray one under the floor can't set it
SCALE_FIT = (0.85, 1.10)  # the 1-D scale fit's range, as factors on the soles' scale (before any real-frame training
# a 24-step body's soles sat ~7% off)
MIN_IOU = 0.7  # a trained view under this at its fixed pose would pull the body apart (a ghost): train without it


def pixel_grid_rotation(Ks, Kc, w: int, h: int, n: int = 9) -> np.ndarray:
    """The rotation Q taking rays through K_s's pixel grid onto the same pixels' rays through K_c (Q a ~ b)."""
    u, v = np.meshgrid(np.linspace(0, w - 1, n), np.linspace(0, h - 1, n))
    px = np.stack([u.ravel(), v.ravel(), np.ones(u.size)], 1)
    a = px @ np.linalg.inv(np.asarray(Ks, float)).T
    b = px @ np.linalg.inv(np.asarray(Kc, float)).T
    a /= np.linalg.norm(a, axis=1, keepdims=True)
    b /= np.linalg.norm(b, axis=1, keepdims=True)
    U, _, Vt = np.linalg.svd(a.T @ b)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    return Vt.T @ np.diag([1.0, 1.0, d]) @ U.T


def court_from_recon(viewmat, K_src, size, still: dict, P, alpha) -> tuple[float, np.ndarray, np.ndarray]:
    """(s, M, C_s): court X = C_still + s M (X_recon - C_s), from the source camera solved in the recon world
    (viewmat: world -> camera, OpenCV; K_src for its video's pixels, size (w, h)) and its still camera in court."""
    V = np.asarray(viewmat, float)
    R_s, C_s = V[:3, :3], -V[:3, :3].T @ V[:3, 3]
    R_c, C_c = np.asarray(still["R"], float), np.asarray(still["C"], float)
    Q = pixel_grid_rotation(K_src, still["K"], *size)
    M = R_c.T @ Q @ R_s
    a = (np.asarray(P, float) - C_s) @ M.T
    solid = np.asarray(alpha).reshape(-1) >= 0.5
    lo = float(np.percentile(a[solid if solid.sum() > 100 else slice(None), 1], LOW_PCT))
    if lo >= 0:
        raise ValueError("the source camera is not above the reconstruction's lowest points")
    return -C_c[1] / lo, M, C_s


def extra_viewmat(extra: dict, s: float, M: np.ndarray, C_s, still_C) -> np.ndarray:
    """The other camera (court R camera-from-world, C) as a world -> camera matrix in the recon's world."""
    R_e, C_e = np.asarray(extra["R"], float), np.asarray(extra["C"], float)
    C_r = np.asarray(C_s, float) + (M.T @ (C_e - np.asarray(still_C, float))) / s
    R_r = R_e @ M
    V = np.eye(4)
    V[:3, :3], V[:3, 3] = R_r, -R_r @ C_r
    return V


def scale_fit(score, lo: float = SCALE_FIT[0], hi: float = SCALE_FIT[1], n: int = 41, fine: int = 11) -> tuple[float, float]:
    """(factor, score) maximising score(factor) over [lo, hi]: a grid, then a finer one around its best."""
    best = max((score(f), f) for f in np.linspace(lo, hi, n))
    step = (hi - lo) / (n - 1)
    best = max([best] + [(score(f), f) for f in np.linspace(max(lo, best[1] - step), min(hi, best[1] + step), fine)])
    return float(best[1]), float(best[0])


def pose_file(video) -> Path:
    return Path(video).parent / "pose.json"


def fixed_solve(sv, trainer, params, debug=None):
    """lucid.source_view.SourceView.solve's hook for another real view: None (no pose.json, or no solved source camera:
    solve as before), else its camera placed from pose.json (focal held, scale fitted in 1-D), its crop set up as
    solve() does, refine() held at the fixed pose, and whether it's used."""
    video = getattr(sv, "video", None)
    if video is None or not pose_file(video).exists():
        return None
    name = getattr(sv, "name", Path(video).stem)
    src = getattr(trainer, "source", None)
    if src is None or src is sv or not getattr(src, "ready", False):
        print(f"[source] extra {name}: pose.json, but the source camera isn't solved: solving as before", flush=True)
        return None
    import torch
    import torch.nn.functional as F

    pose = json.loads(pose_file(video).read_text())
    dev = sv.device
    frozen = {k: t.detach() for k, t in params.items()}
    P = frozen["means"].cpu().numpy()
    alpha = torch.sigmoid(frozen["opacities"]).reshape(-1).cpu().numpy()
    s0, M, C_s = court_from_recon(src.viewmat.detach().cpu().numpy(), src.K_full.detach().cpu().numpy(),
                                  (int(src.W), int(src.H)), pose["source"], P, alpha)
    K_full = torch.as_tensor(np.asarray(pose["extra"]["K"], float), dtype=torch.float32, device=dev)
    # the silhouette match at 960 px tall, as solve() measures it
    sc = 960.0 / sv.H
    ws, hs = int(round(sv.W * sc)), 960
    K = K_full.clone()
    K[:2] *= sc
    m = F.interpolate(torch.as_tensor(sv.masks[0], device=dev)[None, None], size=(hs, ws), mode="area")[0, 0] > 0.5
    v = torch.ones_like(m)
    if sv.valid is not None:
        v = F.interpolate(torch.as_tensor(sv.valid[0], device=dev)[None, None], size=(hs, ws), mode="area")[0, 0] > 0.5
    white = torch.ones(1, 3, device=dev)

    def viewmat(f):
        V = extra_viewmat(pose["extra"], s0 * f, M, C_s, pose["source"]["C"])
        return torch.as_tensor(V, dtype=torch.float32, device=dev)

    def iou(f):
        with torch.no_grad():
            _, a, _ = sv._render(trainer, frozen, viewmat(f), K, ws, hs, bg=white)
            a = a[0, ..., 0] > 0.5
            return float((a & m & v).sum() / ((a | m) & v).sum().clamp_min(1))

    # one recon world, one scale: the first trained view fits it, the rest take it; a held-out view never fits it
    fitted = getattr(trainer, "court_extra_scale", None)
    if fitted is None:
        fitted = trainer.court_extra_scale = {}
    chunk = sv.frame_ids[0] - getattr(sv, "offset", 0)
    iou0 = iou(1.0)
    rng = pose.get("scaleFit", list(SCALE_FIT))  # an older file's narrower range or lower floor never narrows these
    rng = rng and [min(rng[0], SCALE_FIT[0]), max(rng[1], SCALE_FIT[1])]
    floor = max(pose.get("minIou", MIN_IOU), MIN_IOU)
    trained = getattr(sv, "weight", 1.0) > 0
    if chunk in fitted:
        f, how = fitted[chunk][0], f"as {fitted[chunk][1]}"
        best = iou(f)
    elif trained and rng:
        f, best = scale_fit(iou, *rng)
        if best < iou0:
            f, best = 1.0, iou0
        fitted[chunk], how = (f, name), "fit"
    else:
        f, best, how = 1.0, iou0, "soles"
    vm = viewmat(f)
    sv.report = {"fromCamera": None, "pose": "fixed", "iouSoles": round(iou0, 4), "iou": round(best, 4),
                 "scaleSoles": round(float(s0), 5), "scale": round(float(s0 * f), 5), "scaleFrom": how,
                 "focal": round(float(K_full[0, 0]), 1), "focalHeld": True,
                 "masks": "given" if sv.masks_given else "model", "ignoring": sv.valid is not None}
    print(f"[source] extra {name}: fixed pose, iou {best:.3f} (court scale {s0 * f:.4f}, {how}: x{f:.4f} on the "
          f"soles' {s0:.4f}, iou there {iou0:.3f})", flush=True)
    if trained and best < floor:
        print(f"[source] extra {name}: IoU under {floor} at the fixed pose: trained without it",
              flush=True)
        return False

    # the crop around the person over the chunk, at most max_height tall (as solve() makes it)
    ys, xs = np.nonzero((sv.masks > 0.5).any(0))
    x0, y0, x1, y1 = float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)
    mx, my = 0.06 * (x1 - x0), 0.06 * (y1 - y0)
    x0, y0 = max(0, int(x0 - mx)), max(0, int(y0 - my))
    x1, y1 = min(sv.W, int(x1 + mx)), min(sv.H, int(y1 + my))
    r = min(1.0, sv.max_height / (y1 - y0))
    w, h = int(round((x1 - x0) * r)), int(round((y1 - y0) * r))
    K_crop = K_full.clone()
    K_crop[0, 2] -= x0
    K_crop[1, 2] -= y0
    K_crop[:2] *= r
    sv.viewmat, sv.K, sv.size, sv.crop, sv.r = vm, K_crop, (w, h), (x0, y0, x1, y1), r
    sv.K_full = K_full
    sv.report |= {"crop": [x0, y0, x1, y1], "size": [w, h]}
    sv.camera = {"camera_to_world": torch.linalg.inv(vm).cpu().numpy().tolist(), "K": K_full.cpu().numpy().tolist(),
                 "image_width": int(sv.W), "image_height": int(sv.H), "iou": round(best, 4)}
    sv.refine = lambda *a, **k: best  # the pose is calibration's: agree mode's per-frame nudge leaves it alone
    sv.ready = True
    return True


def write_poses(run: Path) -> list[Path]:
    """real/<name>/pose.json for each other view in the run folder's real/extras.json."""
    still = json.loads((run / "court-run.json").read_text())["still"]
    extras = run / "real" / "extras.json"
    out = []
    for e in json.loads(extras.read_text()) if extras.exists() else []:
        d = run / "real" / e["name"]
        cam = json.loads((d / "camera.json").read_text())
        pose = {"extra": {k: cam[k] for k in ("R", "C", "K")}, "source": {k: still[k] for k in ("R", "C", "K")},
                "scaleFit": list(SCALE_FIT), "minIou": MIN_IOU,
                "note": "court cameras (R camera-from-world, C in court metres, K for each one's own video); "
                        "court_extra_pose.fixed_solve places the extra from them at recon time"}
        p = d / "pose.json"
        p.unlink(missing_ok=True)  # a new file: a hard-linked copy elsewhere keeps its own
        p.write_text(json.dumps(pose, indent=1) + "\n")
        out.append(p)
    return out


def main(argv=None):
    for run in map(Path, sys.argv[1:] if argv is None else argv):
        for p in write_poses(run):
            print(p)


if __name__ == "__main__":
    main()
