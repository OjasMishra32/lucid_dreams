"""Make any clip fit 4DAnyone: portrait 9:16, the person centred, at least 121 frames.

Landscape footage (game film, broadcast, most phone videos) gets a *fixed* 9:16 crop around the person: the person
detector runs over the clip and the window covers where they go, so the crop never moves (a moving crop would read
as camera motion). Portrait clips pass through untouched.

    python -m lucid.prep_clip input.mp4 --out prepped.mp4 [--start-s 3.0] [--person 0]
Prints a JSON report: what was done, and anything that will hurt quality (too short, small person, low resolution).
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import numpy as np

MIN_FRAMES = 121
OUT_FPS = 25  # every replay runs at the 25 fps the job and export assume, so 121 frames are 4.84 s of real time
TARGET_ASPECT = 9 / 16


def probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries",
         "stream=width,height,r_frame_rate,nb_read_packets", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    s = json.loads(out.stdout)["streams"][0]
    num, den = (int(x) for x in s["r_frame_rate"].split("/"))
    return {"width": int(s["width"]), "height": int(s["height"]), "fps": num / den, "frames": int(s["nb_read_packets"])}


def person_boxes(path: Path, start_s: float, seconds: float, stride: int = 3) -> np.ndarray:
    """Largest person box per sampled frame, [K, 4] as x0, y0, x1, y1 in pixels (YOLO, bundled with 4DAnyone)."""
    import av
    from ultralytics import YOLO

    model = YOLO("yolov8x.pt")
    boxes = []
    with av.open(str(path)) as c:
        stream = c.streams.video[0]
        fps = float(stream.average_rate or 25)
        first, last = int(start_s * fps), int((start_s + seconds) * fps)
        for i, frame in enumerate(c.decode(stream)):
            if i < first or (i - first) % stride:
                continue
            if i > last:
                break
            r = model.predict(frame.to_ndarray(format="rgb24"), classes=[0], verbose=False)[0]
            if len(r.boxes):
                b = r.boxes.xyxy.cpu().numpy()
                area = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
                boxes.append(b[area.argmax()])
    return np.asarray(boxes)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("clip", type=Path)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--start-s", type=float, default=0.0, help="where the 121-frame window starts")
    a = p.parse_args(argv)

    info = probe(a.clip)
    report: dict = {"input": info, "actions": [], "warnings": []}
    seconds = MIN_FRAMES / OUT_FPS + 0.5
    if info["frames"] < MIN_FRAMES:
        report["warnings"].append(f"only {info['frames']} frames; 4DAnyone needs {MIN_FRAMES} (about 5 s)")

    w, h = info["width"], info["height"]
    vf = [f"fps={OUT_FPS}"]  # 60 fps footage would otherwise give 4DAnyone only 2 s of motion
    if abs(info["fps"] - OUT_FPS) > 0.5:
        report["actions"].append(f"resampled {info['fps']:.0f} fps to {OUT_FPS} fps")
    if w / h > TARGET_ASPECT + 0.01:
        boxes = person_boxes(a.clip, a.start_s, seconds)
        if len(boxes) == 0:
            raise SystemExit(json.dumps({"error": "no person found in the clip"}))
        x0, y0 = np.percentile(boxes[:, 0], 5), np.percentile(boxes[:, 1], 5)
        x1, y1 = np.percentile(boxes[:, 2], 95), np.percentile(boxes[:, 3], 95)
        ch = min(h, int((y1 - y0) * 1.25))  # the person fills ~80% of the crop's height
        cw = int(round(ch * TARGET_ASPECT))
        if cw < (x1 - x0):  # they move further sideways than the crop is wide: use the full height instead
            ch, cw = h, int(round(h * TARGET_ASPECT))
        cx = (x0 + x1) / 2
        cy = (y0 + y1) / 2
        left = int(np.clip(cx - cw / 2, 0, w - cw)) // 2 * 2
        top = int(np.clip(cy - ch / 2, 0, h - ch)) // 2 * 2
        cw, ch = cw // 2 * 2, ch // 2 * 2
        vf.append(f"crop={cw}:{ch}:{left}:{top}")
        report["actions"].append(f"fixed 9:16 crop {cw}x{ch} at ({left},{top}) around the person")
        if ch < 1920:
            vf.append("scale=1080:1920:flags=lanczos")
            report["warnings"].append(f"person crop is {cw}x{ch}; upscaled to 1080x1920 (a closer or 4K source looks sharper)")
    elif h < 1920:
        report["warnings"].append(f"{w}x{h} is below 1080x1920; 4K portrait looks sharpest")

    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{a.start_s:.3f}", "-i", str(a.clip), "-t", f"{seconds:.3f}"]
    if vf:
        cmd += ["-vf", ",".join(vf)]
    cmd += ["-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", str(a.out)]
    subprocess.run(cmd, check=True)
    report["output"] = probe(a.out)
    print(json.dumps(report))


if __name__ == "__main__":
    main()
