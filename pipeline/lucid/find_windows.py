"""Find the stretches of a long film that make good replays: one person, whole body in frame, camera still.

Samples a few frames a second with the same person detector clip prep uses, then scores every window of the wanted
length: exactly one confident person in every sample, tall in the frame, feet inside it, and a box that moves like a
person (not like a cut or a camera pan). Prints the best non-overlapping windows as JSON, best first.

    python -m lucid.find_windows film.webm --seconds 5 --top 5
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import numpy as np


def detections(path: Path, every_s: float) -> tuple[list[float], list[np.ndarray], tuple[int, int]]:
    """(sample times, per sample the person boxes [N, 5] = x0, y0, x1, y1, conf, (width, height))."""
    import av
    from ultralytics import YOLO

    model = YOLO(os.environ.get("YOLO_WEIGHTS", "yolov8x.pt"))
    times, boxes = [], []
    with av.open(str(path)) as c:
        s = c.streams.video[0]
        size = (s.codec_context.width, s.codec_context.height)
        next_t = 0.0
        for frame in c.decode(s):
            t = float(frame.time or 0.0)
            if t + 1e-6 < next_t:
                continue
            next_t = t + every_s
            r = model.predict(frame.to_ndarray(format="rgb24"), classes=[0], conf=0.35, verbose=False, imgsz=960)[0]
            b = r.boxes
            boxes.append(np.concatenate([b.xyxy.cpu().numpy(), b.conf.cpu().numpy()[:, None]], axis=1) if len(b) else np.zeros((0, 5)))
            times.append(t)
    return times, boxes, size


def score_windows(times, boxes, size, seconds: float) -> list[dict]:
    w, h = size
    out = []
    for i, t0 in enumerate(times):
        j = i
        while j < len(times) and times[j] < t0 + seconds:
            j += 1
        if j >= len(times) or times[j - 1] - t0 < seconds * 0.9:
            break
        win = boxes[i:j]
        if any(len(b) != 1 for b in win):  # exactly one person, every sample
            continue
        b = np.stack([x[0] for x in win])
        heights = (b[:, 3] - b[:, 1]) / h
        feet_in = (b[:, 3] < h * 0.985).mean()  # feet not cut off by the bottom edge
        centres = (b[:, :2] + b[:, 2:4]) / 2
        jumps = np.linalg.norm(np.diff(centres, axis=0), axis=1) / h  # a cut or a pan moves the box a lot at once
        if heights.min() < 0.45 or feet_in < 0.8 or (len(jumps) and jumps.max() > 0.25):
            continue
        score = float(heights.mean() * 0.6 + b[:, 4].mean() * 0.25 + feet_in * 0.15 - (jumps.mean() if len(jumps) else 0))
        out.append({"startS": round(t0, 2), "endS": round(t0 + seconds, 2), "score": round(score, 4),
                    "personHeight": round(float(heights.mean()), 3), "confidence": round(float(b[:, 4].mean()), 3)})
    out.sort(key=lambda r: -r["score"])
    picked: list[dict] = []
    for r in out:  # best first, never overlapping
        if all(r["endS"] <= p["startS"] or r["startS"] >= p["endS"] for p in picked):
            picked.append(r)
    return picked


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("film", type=Path)
    p.add_argument("--seconds", type=float, default=5.2, help="window length (a replay is 121 frames)")
    p.add_argument("--every", type=float, default=0.4, help="seconds between sampled frames")
    p.add_argument("--top", type=int, default=5)
    a = p.parse_args(argv)
    times, boxes, size = detections(a.film, a.every)
    best = score_windows(times, boxes, size, a.seconds)[: a.top]
    print(json.dumps({"film": str(a.film), "size": size, "sampled": len(times), "windows": best}, indent=2))


if __name__ == "__main__":
    main()
