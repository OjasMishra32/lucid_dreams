"""Did 4DAnyone get our frames? Compares lucid.prep_clip's prepped.mp4 with the clip we made, frame by frame.

    python3 -I check_prepped.py --prepped prepped.mp4 --input clip-lossless.mkv [--min-db 40] [--near 3]

Pass: the same number of frames (121), each prepped frame's best match among its own and its --near neighbours is its
own source frame (no frame dropped, doubled or shifted by the fps filter), and every frame is >= --min-db PSNR.
Prints one JSON line; exits 1 on a fail.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

FRAMES = 121


def frames(path: Path):
    import av

    with av.open(str(path)) as c:
        for f in c.decode(c.streams.video[0]):
            yield f.to_ndarray(format="rgb24")


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a.astype(np.float32) - b.astype(np.float32)) ** 2))
    return 99.0 if mse == 0 else 10 * np.log10(255.0 ** 2 / mse)


def check(prepped: Path, source: Path, min_db: float, near: int, frames_needed: int = FRAMES) -> dict:
    src = list(frames(source))
    own, wrong = [], []
    n = 0
    for i, f in enumerate(frames(prepped)):
        n += 1
        if i >= len(src) or f.shape != src[i].shape:
            wrong.append(i)
            continue
        scores = {j: psnr(f, src[j]) for j in range(max(0, i - near), min(len(src), i + near + 1))}
        own.append(scores[i])
        if max(scores, key=scores.get) != i:
            wrong.append(i)
    rep = {"prepped": n, "source": len(src), "minDb": round(min(own), 2) if own else None,
           "meanDb": round(float(np.mean(own)), 2) if own else None, "notOwnBest": wrong,
           "belowMin": [i for i, d in enumerate(own) if d < min_db]}
    rep["pass"] = n == len(src) == frames_needed and not wrong and not rep["belowMin"]
    return rep


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--prepped", type=Path, required=True)
    ap.add_argument("--input", type=Path, required=True, help="our clip: clip-lossless.mkv (or input.mp4)")
    ap.add_argument("--min-db", type=float, default=40.0)
    ap.add_argument("--near", type=int, default=3)
    a = ap.parse_args(argv)
    rep = check(a.prepped, a.input, a.min_db, a.near)
    print(json.dumps(rep))
    sys.exit(0 if rep["pass"] else 1)


if __name__ == "__main__":
    main()
