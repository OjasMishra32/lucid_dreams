#!/usr/bin/env python3
"""A phone video of one person -> the best 8-12 frames, as the photo folder avatars/hpg/lhmpp-avatar.sbatch reads.

    python video_frames.py clip.mov --out /path/to/photos/<name>            # 10 frames
    python video_frames.py clip.mov --out DIR --count 12 --box 0.2,0.05,0.8,1.0 --contact sheet.png

Needs ffmpeg and numpy only (no Pillow, no OpenCV, no ffprobe): the bridge Mac, or the cluster's 4DAnyone env (it
ships ffmpeg). Frames are sampled at --fps (default 3), decoded by ffmpeg into a pipe as raw RGB (no image files while
scoring), scored and picked by lucid_avatars/frame_pick.py (sharpness on the person region, no near-duplicates, spread
over the clip so turns and poses are covered, never more than 16), then ffmpeg writes just the chosen frames at full
resolution as frame-01.jpg ... in time order. It never uploads anything and writes only inside --out (plus --contact's
path if you give one). Beside the photos it writes pick.json: the source's name, every chosen frame's time and score,
what was rejected and why, and the settings, so the choice can be inspected.

Region: --box x0,y0,x1,y1 (fractions of the frame) for the person; --box auto finds what moves in a clip filmed on a
still camera (it falls back to the centre when the camera moves too); default the centre 60%. --crops also writes
crops.json from the box, which lhmpp_avatar.py uses to cut a neighbour out of every photo.

Consent: only people who agreed to a photoreal likeness (AGENTS.md rule 5; family clips: the family's yes, and for
Ian's grandma team/ian.md). The output folder must hold no other photo (LHM++ would read it too).
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from lucid_avatars import frame_pick as P  # noqa: E402

ANALYSIS_SIDE = 960  # frames are scaled to this long side for scoring; the JPEGs are written at full resolution
FIND_SIDE = 96  # and to this for finding the box
PHOTO_EXT = {".jpg", ".jpeg", ".png"}
OURS = re.compile(r"frame-\d\d\.jpg")
SCALE = "scale=w='trunc(iw*min(1\\,{s}/max(iw\\,ih))/2)*2':h='trunc(ih*min(1\\,{s}/max(iw\\,ih))/2)*2'"


def ffmpeg_input(video: Path, start: float, seconds: float | None) -> list[str]:
    args = ["ffmpeg", "-v", "error", "-nostdin"]
    if start:
        args += ["-ss", str(start)]
    if seconds:
        args += ["-t", str(seconds)]
    return args + ["-i", str(video)]


def read_ppm(stream) -> np.ndarray | None:
    """The next frame of an ffmpeg `-f image2pipe -c:v ppm` stream: (H, W, 3) uint8, or None at the end."""
    magic = stream.readline()
    if not magic:
        return None
    if magic.strip() != b"P6":
        raise RuntimeError("ffmpeg's output is not a PPM stream")
    w, h = (int(v) for v in stream.readline().split())
    stream.readline()  # maxval
    buf = stream.read(w * h * 3)
    if len(buf) != w * h * 3:
        return None
    return np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3)


def decode(video: Path, fps: float, side: int, start: float = 0.0, seconds: float | None = None):
    """Yield (index, rgb) for the video sampled at `fps`, scaled so the long side is at most `side` (ffmpeg's own
    rotation applied, so a portrait phone clip comes out upright)."""
    cmd = ffmpeg_input(video, start, seconds) + ["-an", "-vf", f"fps={fps},{SCALE.format(s=side)}",
                                                  "-f", "image2pipe", "-c:v", "ppm", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        i = 0
        while (frame := read_ppm(proc.stdout)) is not None:
            yield i, frame
            i += 1
    finally:
        proc.stdout.close()
        err = proc.stderr.read().decode(errors="replace").strip()
        proc.stderr.close()
        if proc.wait() != 0:
            raise RuntimeError(f"ffmpeg failed on {video}: {err[-400:]}")


def write_jpegs(video: Path, fps: float, indices: list[int], out: Path, start: float, seconds: float | None) -> None:
    """The sampled frames `indices` at full resolution as out/frame-01.jpg ... (time order). The same fps filter as
    decode(), then `select` on the sample's number, so these are the very frames that were scored."""
    pick = "+".join(f"eq(n\\,{i})" for i in indices)
    base = ffmpeg_input(video, start, seconds) + ["-an", "-vf", f"fps={fps},select='{pick}'"]
    tail = ["-q:v", "2", "-start_number", "1", str(out / "frame-%02d.jpg")]
    for sync in (["-fps_mode", "passthrough"], ["-vsync", "0"]):  # the flag's name changed between ffmpeg versions
        done = subprocess.run(base + sync + tail, capture_output=True, text=True)
        if done.returncode == 0:
            return
        if "Unrecognized option" not in done.stderr and "Option not found" not in done.stderr:
            break
    raise RuntimeError(f"ffmpeg could not write the frames: {done.stderr.strip()[-400:]}")


def check_folder(out: Path, overwrite: bool) -> None:
    """The folder must hold no photo that isn't ours (lhmpp-avatar.sbatch reads every jpg/png in it), and none of ours
    unless --overwrite."""
    if not out.exists():
        return
    others = [p.name for p in out.iterdir() if p.suffix.lower() in PHOTO_EXT and not OURS.fullmatch(p.name)]
    if others:
        raise SystemExit(f"{out} already holds other photos ({', '.join(sorted(others)[:3])}...): LHM++ would read "
                         "them with the video's frames. Use an empty folder.")
    mine = [p for p in out.iterdir() if OURS.fullmatch(p.name)]
    if mine and not overwrite:
        raise SystemExit(f"{out} already holds frames from an earlier run: add --overwrite to replace them")
    for p in mine + [out / "pick.json", out / "crops.json"]:
        p.unlink(missing_ok=True)


def tile(rgb: np.ndarray) -> np.ndarray:
    return np.clip(P.block_downscale(rgb, 240) + 0.5, 0, 255).astype(np.uint8)


def pad_tiles(tiles: list[np.ndarray]) -> list[np.ndarray]:
    h, w = max(t.shape[0] for t in tiles), max(t.shape[1] for t in tiles)
    out = []
    for t in tiles:
        canvas = np.zeros((h, w, 3), np.uint8)
        canvas[:t.shape[0], :t.shape[1]] = t
        out.append(canvas)
    return out


def run(args) -> int:
    video, out = Path(args.video), Path(args.out)
    if not video.is_file():
        raise SystemExit(f"no video at {video}")
    if shutil.which("ffmpeg") is None:
        raise SystemExit("ffmpeg is not on PATH (on HiPerGator: source pipeline/hpg/env.sh first, the 4DAnyone env has it)")
    count = args.count
    if not 1 <= count <= P.MAX_FRAMES:
        raise SystemExit(f"--count must be 1..{P.MAX_FRAMES} (LHM++ reads at most {P.MAX_FRAMES} photos)")
    contact = Path(args.contact) if args.contact else None
    if contact is not None and (out.resolve() in contact.resolve().parents or contact.suffix.lower() in PHOTO_EXT and
                                contact.resolve().parent == out.resolve()):
        raise SystemExit("--contact must be outside the photos folder (LHM++ would read the sheet as a photo)")
    check_folder(out, args.overwrite)

    box, box_source = None, "centre"
    if args.box == "auto":
        small = [P.to_grey(f) for _, f in decode(video, args.fps, FIND_SIDE, args.start, args.seconds)]
        box = P.find_person_box(np.stack([P.resize_area(g, 36, 64) for g in small])) if len(small) > 2 else None
        box_source = "auto" if box else "centre (auto found no single mover)"
    elif args.box:
        box, box_source = P.parse_box(args.box), "given"

    times, scores, sigs, thumbs = [], [], [], []
    for i, frame in decode(video, args.fps, ANALYSIS_SIDE, args.start, args.seconds):
        times.append(i / args.fps)
        scores.append(P.sharpness(frame, box))
        sigs.append(P.signature(frame, box))
        if contact is not None:
            thumbs.append(tile(frame))
    if not times:
        raise SystemExit(f"ffmpeg decoded no frames from {video}")
    duration = times[-1] + 1 / args.fps
    gap = args.min_gap if args.min_gap is not None else P.default_min_gap(duration, count)
    result = P.pick_frames(times, scores, sigs, count=count, min_gap=gap)
    print(f"[frames] {len(times)} sampled over {duration:.1f} s, rejected {result.rejected or 'none'}, "
          f"picked {len(result.indices)} (gap {gap:.2f} s{f', relaxed x{result.relaxed}' if result.relaxed else ''})")
    if result.note:
        print(f"[frames] WARNING: {result.note}")
    if not result.indices:
        return 1

    out.mkdir(parents=True, exist_ok=True)
    write_jpegs(video, args.fps, result.indices, out, args.start, args.seconds)
    written = sorted(out.glob("frame-*.jpg"))
    if len(written) != len(result.indices):
        raise SystemExit(f"ffmpeg wrote {len(written)} frames for {len(result.indices)} picks: video changed while "
                         f"reading? Remove {out}'s frame-*.jpg and rerun")
    frames = [{"file": f.name, "t": round(times[i], 3), "sharpness": round(scores[i], 6), "sample": i}
              for f, i in zip(written, result.indices)]
    report = {"source": video.name, "tool": "avatars/video_frames.py", "sampleFps": args.fps,
              "sampled": len(times), "durationS": round(duration, 3), "startS": args.start,
              "box": [round(v, 4) for v in box] if box else None, "boxSource": box_source,
              "minGapS": round(gap, 3), "count": count, "relaxed": result.relaxed, "rejected": result.rejected,
              "note": result.note, "frames": frames,
              "sharpnessNote": "variance of the Laplacian of the grey region downscaled to <= 256 px: comparable only "
                               "inside this clip with this box"}
    (out / "pick.json").write_text(json.dumps(report, indent=2) + "\n")
    if args.crops and box:
        (out / "crops.json").write_text(json.dumps({f.name: [round(v, 4) for v in box] for f in written}, indent=2) + "\n")
    if contact is not None:
        contact.write_bytes(P.png_bytes(P.contact_sheet(pad_tiles([thumbs[i] for i in result.indices]))))
        print(f"[frames] contact sheet {contact}")
    print(f"[frames] wrote {len(written)} frames and pick.json to {out}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("video", help="the clip (anything ffmpeg reads: .mov, .mp4, ...)")
    ap.add_argument("--out", required=True, help="the photos folder to write (the one lhmpp-avatar.sbatch will read)")
    ap.add_argument("--count", type=int, default=10, help="frames to keep, 1..16 (default 10; 8-12 is the sweet spot)")
    ap.add_argument("--fps", type=float, default=3.0, help="samples per second to score (default 3)")
    ap.add_argument("--min-gap", type=float, default=None, help="seconds between picks (default from the clip's length)")
    ap.add_argument("--box", help="the person: x0,y0,x1,y1 as fractions of the frame, or 'auto' (default: the centre)")
    ap.add_argument("--crops", action="store_true", help="also write crops.json from --box (LHM++ prep cuts to it)")
    ap.add_argument("--start", type=float, default=0.0, help="skip this many seconds at the start")
    ap.add_argument("--seconds", type=float, default=None, help="only use this many seconds from --start")
    ap.add_argument("--contact", help="also write a contact sheet PNG here (outside the photos folder)")
    ap.add_argument("--overwrite", action="store_true", help="replace frames from an earlier run in --out")
    args = ap.parse_args(argv)
    if args.fps <= 0:
        ap.error("--fps must be positive")
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
