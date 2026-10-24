"""Up vs raw: a SeedVR2 winner's freezes beside the same seed's raw ones, for the eye to judge before anything is
swapped in. Per real-view count (r0, r2, ...) two rows, raw then up: the bundle's orbit every 45 degrees (180 = the
back), then two close-ups at the real camera's full resolution, the face (the recon's peek-face render, else the orbit's
front view around the head: the real camera may not see the face) and the hands
(the peek-source render around the ball with --ball, for the player holding it, else around the highest hand); each
tile carries its sharpness (variance of the Laplacian inside the person).

    python3 -I court_upraw_sheet.py --raw <seed dir> --up <winner dir> --out upraw.jpg [--ball] [--height 360] [--cap 300k]

The run dirs are what a job copied back (recon-<views>-<mode>-r<N>-<cap>/, bundle-<...>/preview.mp4). The raw
freezes are recon-raw-*, the up ones recon-up-*, paired by mode and real-view count. Missing pieces are grey tiles.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from court_gate2_sheet import BALL_HUE, BALL_SAT, frame_at, frame_count, stack, tile  # noqa: E402
from court_p42 import silhouette  # noqa: E402

CLOSE = 0.16  # a close-up's side, as a share of the peek's height


def sharpness(img: np.ndarray | None, bg: np.ndarray | None = None) -> float | None:
    """Variance of the Laplacian inside the person (everything not background-coloured from the border in)."""
    if img is None:
        return None
    g = cv2.Laplacian(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32), cv2.CV_32F, ksize=3)
    body = silhouette(img, img[0, 0] if bg is None else bg)
    inner = cv2.erode(body.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    return float(g[inner].var()) if inner.sum() > 100 else None


def halves(path: Path) -> tuple[np.ndarray | None, np.ndarray | None]:
    """A peek's two halves: the real frame | the render."""
    img = cv2.imread(str(path)) if path.exists() else None
    if img is None:
        return None, None
    w = img.shape[1] // 2
    return img[:, :w], img[:, w:2 * w]


def held_ball(real: np.ndarray) -> tuple[int, int, int, int] | None:
    """The held ball in the real frame: its largest orange blob (x, y, w, h), or None."""
    hsv = cv2.cvtColor(real, cv2.COLOR_BGR2HSV)
    m = ((hsv[..., 0] >= BALL_HUE[0]) & (hsv[..., 0] <= BALL_HUE[1]) & (hsv[..., 1] >= BALL_SAT) & (hsv[..., 2] >= 50))
    m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, _, st, _ = cv2.connectedComponentsWithStats(m)
    if n < 2:
        return None
    i = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    return tuple(int(v) for v in st[i, :4])


def hands_box(real: np.ndarray, ball: bool = False) -> tuple[int, int, int, int]:
    """Where the hands are in the real half: around the held ball (ball=True), else around the person's highest point."""
    s = int(CLOSE * real.shape[0])
    b = held_ball(real) if ball else None
    if b is not None:
        x, y, w, h = b
        cx, cy = x + w // 2, y + h // 2
        s = max(s, int(1.8 * max(w, h)))
    else:
        body = silhouette(real, real[0, 0])
        ys, xs = np.nonzero(body)
        if not len(ys):
            return 0, 0, s, s
        top = ys.min()
        cx, cy = int(np.median(xs[ys <= top + 5])), top + s // 2 - s // 8
    return max(0, cx - s // 2), max(0, cy - s // 2), s, s


def head(img: np.ndarray | None) -> np.ndarray | None:
    """The head of a person on a plain background: a square from their top, a seventh of their height."""
    if img is None:
        return None
    ys, xs = np.nonzero(silhouette(img, img[0, 0]))
    if not len(ys):
        return None
    top, s = ys.min(), max(16, int((ys.max() - ys.min()) / 7))
    cx = int(np.median(xs[ys <= top + s // 3]))
    return cut(img, (max(0, cx - s // 2), max(0, top - s // 8), s, s))


def cut(img: np.ndarray | None, box) -> np.ndarray | None:
    if img is None:
        return None
    x, y, w, h = box
    c = img[y:y + h, x:x + w]
    return c if c.size else None


def orbit(preview: Path) -> list[np.ndarray | None]:
    n = frame_count(preview) if preview.exists() else 0
    return [frame_at(preview, n * i // 8) if n else None for i in range(8)]


def label_of(v: float | None) -> str:
    return "" if v is None else f"sharp {v:.0f}"


def pairs(raw: Path, up: Path, cap: str) -> list[tuple[str, Path, Path]]:
    """(mode-rN, raw recon, up recon) for every up freeze whose raw twin exists."""
    out = []
    for rec in sorted(up.glob(f"recon-up-*-{cap}")):
        m = re.fullmatch(rf"recon-up-(.+)-{cap}", rec.name)
        if m and (raw / f"recon-raw-{m.group(1)}-{cap}").is_dir():
            out.append((m.group(1), raw / f"recon-raw-{m.group(1)}-{cap}", rec))
    return out


def rows_for(raw: Path, up: Path, h: int, cap: str = "300k", ball: bool = False) -> list[np.ndarray]:
    rows = []
    for key, rr, ur in pairs(raw, up, cap):
        k = next((m.group(1) for p in rr.glob("peek-source-*.jpg")
                  if (m := re.fullmatch(r"peek-source-(\d+)\.jpg", p.name))), None)
        real, _ = halves(rr / f"peek-source-{k}.jpg") if k else (None, None)
        box = hands_box(real, ball) if real is not None else None
        for name, rec in ((f"raw {key}", rr), (f"UP {key}", ur)):
            bundle = rec.parent / ("bundle-" + rec.name[len("recon-"):]) / "preview.mp4"
            turn = orbit(bundle)
            tiles = [tile(f, h, f"{name} {45 * i}" if i else f"{name} front", label_of(sharpness(f)))
                     for i, f in enumerate(turn)]
            _, face = halves(rec / f"peek-face-{k}.jpg") if k else (None, None)
            face = face if face is not None else head(turn[0])
            _, render = halves(rec / f"peek-source-{k}.jpg") if k else (None, None)
            hands = cut(render, box) if box is not None else None
            tiles += [tile(face, h, "face", label_of(sharpness(face))),
                      tile(hands, h, "hands", label_of(sharpness(hands)))]
            rows.append(np.hstack(tiles))
    return rows or [tile(None, h, f"no up freeze with a raw twin ({cap})")]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", type=Path, required=True)
    ap.add_argument("--up", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--height", type=int, default=360)
    ap.add_argument("--cap", default="300k")
    ap.add_argument("--ball", action="store_true", help="the player holds the ball: the hands close-up centres on it")
    a = ap.parse_args(argv)
    rows = rows_for(a.raw, a.up, a.height, a.cap, a.ball)
    cv2.imwrite(str(a.out), stack(rows), [cv2.IMWRITE_JPEG_QUALITY, 90])
    print(f"{a.out}: {len(rows)} rows")


if __name__ == "__main__":
    main()
