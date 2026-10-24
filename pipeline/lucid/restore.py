"""Standalone SDR/CFR restoration. Never changes the source or the shared pipeline.

PYTHONPATH=pipeline python3 -m lucid.restore in.mp4 out.mp4 --models /private/path/models
Requires ffmpeg, ffprobe and realesrgan-ncnn-vulkan; downloads nothing automatically.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from fractions import Fraction
import json
import math
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import time


class RestoreError(Exception):
    """A failed or unsupported restoration; the original is never overwritten."""


def run(command, timeout=600):
    try:
        result = subprocess.run([str(x) for x in command], capture_output=True, text=True,
                                errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise RestoreError(f"{Path(command[0]).name} timed out; increase --timeout or use a shorter clip.") from exc
    except OSError as exc:
        raise RestoreError(f"Cannot launch {Path(command[0]).name}: {exc}") from exc
    if result.returncode:
        raise RestoreError(f"{Path(command[0]).name} failed (exit {result.returncode}): "
                           + (result.stderr or result.stdout)[-1800:].strip())
    return result.stdout


def tool(name):
    found = shutil.which(str(name))
    if not found:
        raise RestoreError(f"Missing executable {name!r}. Install ffmpeg/ffprobe or pass --esrgan to the official "
                           "Real-ESRGAN ncnn Vulkan binary; no image-resize substitute is used.")
    return found


def fraction(value, label):
    try:
        result = Fraction(str(value).replace(":", "/"))
    except (ValueError, ZeroDivisionError) as exc:
        raise RestoreError(f"Invalid or missing {label}: {value!r}.") from exc
    return result


@dataclass
class Media:
    video: dict
    audio: list[dict]
    pts: list[Fraction]
    fps: Fraction
    sar: Fraction
    duration: Fraction

    def summary(self):
        return {"width": self.video["width"], "height": self.video["height"], "fps": str(self.fps),
                "frameCount": len(self.pts), "videoDurationS": float(self.duration),
                "videoStartS": float(self.pts[0]), "sampleAspectRatio": str(self.sar),
                "audio": [{k: s.get(k) for k in ("codec_name", "sample_rate", "channels", "start_time")} for s in self.audio]}


def inspect(data):
    streams = data.get("streams", [])
    videos = [s for s in streams if s.get("codec_type") == "video"]
    if len(videos) != 1:
        raise RestoreError("Exactly one video stream is supported; remove extra video/cover-art streams explicitly.")
    video = videos[0]
    if any(int(s.get("rotation", 0)) % 360 for s in video.get("side_data_list", [])) or int(video.get("tags", {}).get("rotate", 0)) % 360:
        raise RestoreError("Rotated video is not supported yet; supply an explicitly orientation-normalized copy.")
    formats = {"yuv420p", "yuv422p", "yuv444p", "yuvj420p", "yuvj422p", "yuvj444p", "rgb24", "bgr24", "gray"}
    if video.get("pix_fmt") not in formats or video.get("color_transfer") in {"smpte2084", "arib-std-b67"}:
        raise RestoreError("Only 8-bit SDR video is supported; HDR/high-bit-depth inputs require an explicit conversion.")
    if video.get("color_space", "unknown") not in {"unknown", "bt709", "smpte170m", "bt470bg", "gbr"}:
        raise RestoreError("Unsupported source color matrix; convert an explicit SDR copy before restoration.")
    if not all(type(video.get(k)) is int and video[k] > 0 for k in ("width", "height")):
        raise RestoreError("Invalid video dimensions.")
    fps = fraction(video.get("r_frame_rate"), "frame rate")
    base = fraction(video.get("time_base"), "video time base")
    if fps <= 0 or base <= 0:
        raise RestoreError("Frame rate and video time base must be positive.")
    frames = [f for f in data.get("frames", []) if f.get("media_type") == "video"]
    if len(frames) < 2:
        raise RestoreError("At least two decoded video frames are required.")
    try:
        pts = [int(f["best_effort_timestamp"]) * base for f in frames]
    except (KeyError, TypeError, ValueError) as exc:
        raise RestoreError("Decoded video frame timestamps are missing or invalid.") from exc
    tolerance = max(base, Fraction(1, 1000000))
    if any(b <= a for a, b in zip(pts, pts[1:])) or any(abs(t - pts[0] - i / fps) > tolerance for i, t in enumerate(pts)):
        raise RestoreError("Variable-frame-rate or discontinuous video is unsupported; no frames will be dropped or retimed.")
    if frames[-1].get("duration") is not None and abs(int(frames[-1]["duration"]) * base - 1 / fps) > max(base / 2, Fraction(1, 1000000)):
        raise RestoreError("A partial final frame is unsupported; its duration cannot be silently changed.")
    sar = fraction(video.get("sample_aspect_ratio", "1:1"), "sample aspect ratio")
    if sar <= 0:
        raise RestoreError("Sample aspect ratio must be specified and positive.")
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    for stream in audio:
        start = fraction(stream.get("start_time"), "audio start time")
        if start < pts[0]:
            raise RestoreError("Audio preceding the first video frame is unsupported; refusing to trim or shift it silently.")
    return Media(video, audio, pts, fps, sar, len(pts) / fps)


def probe(path, ffprobe="ffprobe", timeout=600):
    output = run([ffprobe, "-v", "error", "-show_streams", "-show_frames", "-show_entries",
                  "stream=index,codec_type,codec_name,width,height,pix_fmt,r_frame_rate,time_base,sample_aspect_ratio,"
                  "color_space,color_transfer,color_primaries,color_range,sample_rate,channels,channel_layout,start_time:"
                  "stream_tags=rotate:stream_side_data=rotation:frame=media_type,best_effort_timestamp,duration",
                  "-of", "json", path], timeout)
    try:
        return inspect(json.loads(output))
    except (ValueError, TypeError, KeyError) as exc:
        raise RestoreError(f"Invalid ffprobe metadata for {Path(path).name}: {exc}") from exc


def png_size(path):
    with path.open("rb") as image:
        header = image.read(24)
    if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise RestoreError(f"Missing or malformed PNG: {path.name}.")
    return struct.unpack(">II", header[16:24])


def check_frames(directory, count, size):
    expected = {f"{i:08d}.png" for i in range(count)}
    if {p.name for p in directory.iterdir()} != expected:
        raise RestoreError("Frame sequence is incomplete or contains unexpected files; refusing to assemble it.")
    for name in sorted(expected):
        if png_size(directory / name) != size:
            raise RestoreError(f"Unexpected frame dimensions in {name}; expected {size}.")


def audio_packets(path, media, ffprobe, timeout):
    if not media.audio:
        return []
    data = json.loads(run([ffprobe, "-v", "error", "-select_streams", "a", "-show_packets", "-show_data_hash", "sha256",
                           "-show_entries", "packet=stream_index,pts,duration,data_hash", "-of", "json", path], timeout))
    groups = []
    for stream in media.audio:
        base = fraction(stream["time_base"], "audio time base")
        packets = [p for p in data.get("packets", []) if p["stream_index"] == stream["index"]]
        if not packets:
            raise RestoreError("Audio stream contains no packets.")
        groups.append([(p["data_hash"], int(p["pts"]) * base - media.pts[0], int(p["duration"]) * base) for p in packets])
    return groups


def validate(source, result, source_packets, result_packets):
    if (result.video["width"], result.video["height"]) != (source.video["width"] * 4, source.video["height"] * 4):
        raise RestoreError("Output is not exactly 4x the source dimensions.")
    if result.fps != source.fps or len(result.pts) != len(source.pts) or result.duration != source.duration or result.sar != source.sar:
        raise RestoreError("Output frame rate, count, duration or aspect ratio changed.")
    tolerance = max(fraction(result.video["time_base"], "output time base"), Fraction(1, 1000000))
    if any(abs(a - source.pts[0] - b) > tolerance for a, b in zip(source.pts, result.pts)):
        raise RestoreError("Output video timestamps no longer match the original timeline.")
    fields = ("codec_name", "sample_rate", "channels", "channel_layout")
    if [[s.get(k) for k in fields] for s in source.audio] != [[s.get(k) for k in fields] for s in result.audio]:
        raise RestoreError("Output audio codec, sample rate, channels or layout changed.")
    if len(source_packets) != len(result_packets):
        raise RestoreError("Output audio streams changed.")
    for stream, original, copied in zip(source.audio, source_packets, result_packets):
        tolerance = max(fraction(stream["time_base"], "audio time base"), Fraction(1, 1000000))
        if len(original) != len(copied) or any(a[0] != b[0] or abs(a[1] - b[1]) > tolerance or abs(a[2] - b[2]) > tolerance
                                                for a, b in zip(original, copied)):
            raise RestoreError("Audio packet content or audio/video synchronization changed; output rejected.")


def destination(path, source):
    path = path.expanduser().absolute()
    if path.resolve() == source or path.exists() or path.is_symlink():
        raise RestoreError(f"Refusing to overwrite an existing file or the original: {path}.")
    if not path.parent.is_dir():
        raise RestoreError(f"Output directory does not exist: {path.parent}.")
    return path


def publish(files):
    # Exclusive hard links: even a destination created during processing cannot be overwritten.
    created = []
    try:
        for staged, target in files:
            os.link(staged, target)
            created.append(target)
    except OSError:
        for target in created:
            target.unlink()
        raise


def restore(source, output, *, models, esrgan="realesrgan-ncnn-vulkan", ffmpeg="ffmpeg", ffprobe="ffprobe",
            tile=128, field_order="auto", timeout=600, report=None):
    if not math.isfinite(timeout) or timeout <= 0 or type(tile) is not int or (tile != 0 and tile < 32):
        raise RestoreError("Timeout must be positive/finite; tile size must be 0 (auto) or at least 32.")
    if field_order not in {"auto", "tff", "bff"}:
        raise RestoreError("Field order must be auto, tff or bff.")
    source = source.expanduser().resolve()
    if not source.is_file():
        raise RestoreError("Input video does not exist.")
    output = destination(output, source)
    if output.suffix.lower() not in {".mp4", ".mov", ".mkv"}:
        raise RestoreError("Output container must be .mp4, .mov or .mkv; audio is always stream-copied.")
    if report:
        report = destination(report, source)
        if report == output or report.suffix.lower() != ".json" or report.parent.stat().st_dev != output.parent.stat().st_dev:
            raise RestoreError("Report must be a distinct .json on the same filesystem as the video.")
    decoder, examiner, upscaler = tool(ffmpeg), tool(ffprobe), tool(esrgan)
    if not models or any(not (models.expanduser() / f"realesrgan-x4plus.{ext}").is_file() for ext in ("param", "bin")):
        raise RestoreError("Missing realesrgan-x4plus.param/.bin. Pass --models to the official model directory outside the repo.")
    started, initial = time.monotonic(), source.stat()
    media = probe(source, examiner, timeout)
    original_packets = audio_packets(source, media, examiner, timeout)
    width, height = media.video["width"], media.video["height"]
    # Conservative uncompressed staging budget; failure occurs before exporting frames.
    budget = width * height * 3 * 17 * len(media.pts) + 16 * 1024 * 1024
    if shutil.disk_usage(output.parent).free < budget:
        raise RestoreError(f"Insufficient temporary disk space; allow about {budget / 1024**2:.0f} MiB for this clip.")
    with tempfile.TemporaryDirectory(prefix=".lucid-restore-", dir=output.parent) as directory:
        work = Path(directory)
        before, after = work / "decoded", work / "upscaled"
        before.mkdir()
        after.mkdir()
        print("restore: deinterlacing and light denoising", file=sys.stderr)
        deint = f"bwdif=mode=send_frame:parity={field_order}:deint={'interlaced' if field_order == 'auto' else 'all'}"
        run([decoder, "-nostdin", "-v", "error", "-noautorotate", "-i", source, "-map", "0:v:0", "-an",
             "-vf", deint + ",hqdn3d=2:1:3:3", "-fps_mode", "passthrough", "-start_number", "0", before / "%08d.png"], timeout)
        check_frames(before, len(media.pts), (width, height))
        print("restore: Real-ESRGAN x4plus, 4x", file=sys.stderr)
        run([upscaler, "-i", before, "-o", after, "-m", models.expanduser().resolve(), "-n", "realesrgan-x4plus",
             "-s", "4", "-f", "png", "-t", str(tile), "-j", "1:1:1"], timeout)
        check_frames(after, len(media.pts), (width * 4, height * 4))
        print("restore: assembling and validating original audio/timing", file=sys.stderr)
        staged = work / ("restored" + output.suffix.lower())
        # Preserve the source matrix during the RGB PNG -> YUV round trip, including old SD/601 footage.
        matrix = media.video.get("color_space", "unknown")
        matrix = "bt709" if matrix == "bt709" else "bt601"
        color_range = "full" if media.video.get("color_range") == "pc" else "limited"
        vf = f"scale=iw:ih:in_range=full:out_range={color_range}:out_color_matrix={matrix},setsar={media.sar}:max=1000000"
        command = [decoder, "-nostdin", "-v", "error", "-copyts", "-framerate", str(media.fps), "-start_number", "0",
                   "-i", after / "%08d.png", "-itsoffset", f"{-float(media.pts[0]):.12f}", "-i", source,
                   "-map", "0:v:0", "-map", "1:a?", "-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", "14",
                   "-pix_fmt", "yuv420p", "-fps_mode", "passthrough", "-enc_time_base", str(1 / media.fps), "-c:a", "copy",
                   "-avoid_negative_ts", "disabled", "-color_range", "pc" if color_range == "full" else "tv"]
        for key, flag in (("color_space", "-colorspace"), ("color_transfer", "-color_trc"), ("color_primaries", "-color_primaries")):
            value = media.video.get(key)
            if value and value not in {"unknown", "gbr"}:
                command += [flag, value]
        if output.suffix.lower() in {".mp4", ".mov"}:
            command += ["-video_track_timescale", str(media.fps.numerator), "-movflags", "+faststart"]
        run(command + [staged], timeout)
        restored = probe(staged, examiner, timeout)
        validate(media, restored, original_packets, audio_packets(staged, restored, examiner, timeout))
        current = source.stat()
        if (initial.st_dev, initial.st_ino, initial.st_size, initial.st_mtime_ns) != (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns):
            raise RestoreError("Source changed during restoration; output will not be published.")
        result = {"input": media.summary(), "output": restored.summary(), "model": "realesrgan-x4plus", "scale": 4,
                  "filters": deint + ",hqdn3d=2:1:3:3", "audio": "packet hashes and relative timestamps verified; stream copy",
                  "seconds": round(time.monotonic() - started, 3)}
        files = [(staged, output)]
        if report:
            staged_report = work / "report.json"
            staged_report.write_text(json.dumps(result, indent=2) + "\n")
            files.append((staged_report, report))
        publish(files)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--models", type=Path, default=os.environ.get("REALESRGAN_MODELS"))
    parser.add_argument("--esrgan", default=os.environ.get("REALESRGAN_BIN", "realesrgan-ncnn-vulkan"))
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--tile", type=int, default=128)
    parser.add_argument("--field-order", choices=("auto", "tff", "bff"), default="auto")
    parser.add_argument("--timeout", type=float, default=600)
    parser.add_argument("--report", type=Path, help="optional verification JSON, never overwrites an existing file")
    args = parser.parse_args(argv)
    try:
        result = restore(args.source, args.output, models=args.models, esrgan=args.esrgan, ffmpeg=args.ffmpeg,
                         ffprobe=args.ffprobe, tile=args.tile, field_order=args.field_order, timeout=args.timeout, report=args.report)
    except (RestoreError, OSError, ValueError, KeyError) as exc:
        print(f"restore: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
