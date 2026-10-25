"""Carve a freeze body against its own generated views: the recon's ring views (views/cameras.json, views/videos/*.mp4)
show the person on a plain studio background, so a Gaussian whose centre lands on that background in two or more of
them is something the views never had (a spike or sliver the fit grew where no view looked hard enough). The cameras
are in the recon's own world (OpenCV camera_to_world, K in pixels), the frame the PLY under recon-*/frames/ is in."""

import json
import subprocess
from pathlib import Path

import numpy as np

BORDER_PX = 24  # each row's background colour: the median of this many pixels at both edges
DIFF = 0.10  # a pixel this far (max over RGB, 0-1) from its row's background is the person
GROW_PX = 17  # the mask grown by a disc this wide: the view's own softness and a little more


def view_mask(img: np.ndarray, border: int = BORDER_PX, diff: float = DIFF, grow: int = GROW_PX) -> dict:
    """The person in a generated view (H x W x 3, 0-1): pixels off their row's background colour, closed, specks
    dropped (pieces under 1% of the largest: a hand or ball apart from the body stays), grown by `grow` px.
    Returns {"mask": bool H x W}."""
    import cv2

    bg = np.median(np.concatenate([img[:, :border], img[:, -border:]], 1), 1)
    body = (np.abs(img - bg[:, None, :]).max(2) > diff).astype(np.uint8)
    body = cv2.morphologyEx(body, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(body)
    if n < 2:
        return {"mask": np.zeros(body.shape, bool)}
    area = st[1:, cv2.CC_STAT_AREA]
    body = np.isin(lab, 1 + np.flatnonzero(area >= 0.01 * area.max())).astype(np.uint8)
    body = cv2.dilate(body, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (grow, grow)))
    return {"mask": body.astype(bool)}


def off_body(P, views: list) -> np.ndarray:
    """For each point, in how many views it lands on the background (views: {"mask", "camera_to_world", "K"}; a
    point outside a view's image or behind its camera counts nothing there)."""
    P = np.asarray(P, float)
    out = np.zeros(len(P), int)
    for v in views:
        m = v["mask"]
        H, W = m.shape
        w2c = np.linalg.inv(np.asarray(v["camera_to_world"], float))
        K = np.asarray(v["K"], float)
        X = P @ w2c[:3, :3].T + w2c[:3, 3]
        z = X[:, 2]
        zs = np.where(z > 1e-6, z, 1.0)
        u = np.round(K[0, 0] * X[:, 0] / zs + K[0, 2]).astype(int)
        r = np.round(K[1, 1] * X[:, 1] / zs + K[1, 2]).astype(int)
        inside = (z > 1e-6) & (u >= 0) & (u < W) & (r >= 0) & (r < H)
        out += inside & ~m[np.clip(r, 0, H - 1), np.clip(u, 0, W - 1)]
    return out


def video_frame(path: Path, n: int, w: int, h: int) -> np.ndarray:
    """Frame n of a video as H x W x 3 RGB, 0-1."""
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vf", f"select=eq(n\\,{n})", "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    if len(raw) != w * h * 3:
        raise ValueError(f"{path}: no frame {n} at {w}x{h}")
    return np.frombuffer(raw, np.uint8).reshape(h, w, 3).astype(np.float32) / 255


def run_views(views_dir: Path, k: int) -> list:
    """The ring views a run fetched (views/cameras.json's cameras whose video is here), each at frame k, masked."""
    cams = json.loads((views_dir / "cameras.json").read_text())["cameras"]
    out = []
    for c in cams:
        vid = views_dir / c["video"]
        if not vid.exists():
            continue
        if vid.suffix.lower() == ".png":  # a still of that frame
            import cv2

            img = cv2.imread(str(vid))[..., ::-1].astype(np.float32) / 255
        else:
            img = video_frame(vid, k, int(c["image_width"]), int(c["image_height"]))
        out.append({**view_mask(img), "camera_to_world": c["camera_to_world"], "K": c["K"], "name": Path(c["video"]).stem})
    return out
