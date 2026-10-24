"""H.264 encode of the stacked frames: ffmpeg + libx264 fed raw RGB over stdin (never thousands of PNGs on disk).

What the format needs from the stream (format.ts ShowVideoInfo): raw Annex B, High profile, level 5.1 for the stacked
1536 x 2160 frame at 72 Hz (avc1.640033), -bf 0 (decode order = display order), one access unit delimiter per frame (the
player splits on them), an IDR at every segment start and ease start and nowhere else, undistorted, no audio.

Frame F (where the show freezes and the 3D takes over) must be visually lossless: the stream's CRF is the stream's
quality, and the frames that show F are protected with an x264 zone at a low constant QP (`protect`), chosen by
`calibrate_protect_qp` so the decoded F's luma MAD against freeze.png stays under the plan's bound (P44: <= 1 grey level).
`scan_h264` and `decode_frames` are the checks (IDR positions, codec string, decoded pixels).
"""

from __future__ import annotations

import math
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Iterator, Sequence

import cv2
import numpy as np

from pipeline.court.bake.stack import Layout

THREADS = os.environ.get("COURT_BAKE_THREADS", "2")  # the Mac is shared: ffmpeg stays on two threads unless told otherwise
MAD_BOUND = 1.0  # grey levels (luma), P44: the video layer vs the 3D through the hand-off
# H.264 table A-1: level -> (level_idc, MaxMBPS, MaxFS)
LEVELS = {"5.1": (51, 983_040, 36_864), "5.2": (51 + 1, 2_073_600, 36_864)}


def level_for(width: int, height: int, hz: float) -> str:
    """The lowest level (5.1 or 5.2) whose macroblock rate and frame size hold width x height at hz."""
    mbs = math.ceil(width / 16) * math.ceil(height / 16)
    for name, (_, max_mbps, max_fs) in LEVELS.items():
        if mbs <= max_fs and mbs * hz <= max_mbps:
            return name
    raise ValueError(f"{width}x{height} at {hz} Hz is beyond level 5.2")


def codec_for(width: int, height: int, hz: float) -> str:
    """The WebCodecs codec string for a High-profile stream of this size and rate ("avc1.640033" = level 5.1)."""
    return f"avc1.6400{LEVELS[level_for(width, height, hz)][0]:02x}"


@dataclass(frozen=True)
class Output:
    """One stream to write: the first output must be the frames' own size; others are scaled copies (lanczos)."""

    path: Path
    width: int
    height: int
    fmt: str = "h264"  # "h264" raw Annex B, or "mp4" (the <video> element fallback: no AUDs, faststart)
    limit: int | None = None  # only the first `limit` frames (pass 1 for the mp4)


@dataclass
class Result:
    path: Path
    frames: int
    idr: list[int]
    bytes: int
    codec: str


def partial(path: Path) -> Path:
    """The name a stream is written under until it is complete (renamed over `path` after ffmpeg exits and it is fsynced)."""
    return path.with_name(path.name + ".tmp")


def publish(path: Path) -> None:
    """fsync the finished partial file and rename it to its real name (never visible half-written)."""
    tmp = partial(path)
    fd = os.open(tmp, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)


def zones_arg(protect: Sequence[int], qp: int) -> str:
    """x264 zones: a constant QP on each protected frame (consecutive frames merge into one zone)."""
    idx = sorted(set(protect))
    runs: list[list[int]] = []
    for i in idx:
        if runs and i == runs[-1][1] + 1:
            runs[-1][1] = i
        else:
            runs.append([i, i])
    return "/".join(f"{a},{b},q={qp}" for a, b in runs)


def ffmpeg_command(outputs: Sequence[Output], size: tuple[int, int], hz: float, idr: Sequence[int], crf: float, preset: str, protect: Sequence[int], protect_qp: int) -> list[str]:
    w, h = size
    keys = "expr:" + "+".join(f"eq(n,{i})" for i in sorted(set(idr)))
    color = "colorprim=bt709:transfer=bt709:colormatrix=bt709"
    zones = (":zones=" + zones_arg([i for i in protect], protect_qp)) if protect else ""
    chains = []
    for k, o in enumerate(outputs):
        resize = "" if (o.width, o.height) == (w, h) else f"scale={o.width}:{o.height}:flags=lanczos:"
        cut = f"trim=end_frame={o.limit},setpts=PTS-STARTPTS," if o.limit else ""
        # RGB -> BT.709 limited-range YUV 4:2:0, tagged bt709 in the SPS below
        chains.append(f"[s{k}]{cut}{resize if resize else 'scale='}out_color_matrix=bt709:out_range=tv,format=yuv420p[o{k}]")
    graph = f"[0:v]split={len(outputs)}" + "".join(f"[s{k}]" for k in range(len(outputs))) + ";" + ";".join(chains)
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-threads", THREADS, "-filter_threads", THREADS, "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", f"{hz:g}", "-i", "pipe:0", "-filter_complex", graph]
    for k, o in enumerate(outputs):
        level = level_for(o.width, o.height, hz)
        mp4 = o.fmt == "mp4"
        # raw streams carry an AUD per frame (the player splits on them) and the headers at every IDR
        params = color + zones if mp4 else "aud=1:repeat-headers=1:" + color + zones
        cmd += [
            "-map", f"[o{k}]", "-fps_mode", "passthrough", "-force_key_frames", keys,
            "-c:v", "libx264", "-threads", THREADS, "-profile:v", "high", "-level:v", level, "-preset", preset, "-crf", f"{crf:g}",
            "-bf", "0", "-refs", "3", "-g", "100000", "-keyint_min", "100000", "-sc_threshold", "0", "-forced-idr", "1",
            "-x264-params", params, *(["-movflags", "+faststart", "-f", "mp4"] if mp4 else ["-f", "h264"]), str(partial(o.path)),
        ]
    return cmd


def encode(
    frames: Iterable[np.ndarray],
    outputs: Sequence[Output],
    n_frames: int,
    hz: float = 72,
    idr: Sequence[int] = (0,),
    crf: float = 18,
    preset: str = "veryfast",
    protect: Sequence[int] = (),
    protect_qp: int = 6,
) -> list[Result]:
    """Encode `n_frames` RGB frames (outputs[0]'s size) into every output, piping raw frames to one ffmpeg process.

    An IDR lands on frame 0 and on every index in `idr`, and nowhere else (no scene-cut or interval keyframes). The
    frames listed in `protect` get constant QP `protect_qp` (visually lossless F). Raises ValueError for a wrong frame
    shape or count, RuntimeError if ffmpeg fails.
    """
    first = outputs[0]
    shape = (first.height, first.width, 3)
    idr_all = sorted(set(idr) | {0})
    if any(i < 0 or i >= n_frames for i in idr_all):
        raise ValueError(f"IDR positions {idr_all} outside the {n_frames} frames")
    cmd = ffmpeg_command(outputs, (first.width, first.height), hz, idr_all, crf, preset, protect, protect_qp)
    with tempfile.TemporaryFile() as log:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=log)
        sent = 0
        try:
            for frame in frames:
                if sent >= n_frames:
                    raise ValueError(f"more than the {n_frames} frames promised")
                if frame.shape != shape or frame.dtype != np.uint8:
                    raise ValueError(f"frame {sent}: expected {shape} uint8, got {frame.shape} {frame.dtype}")
                proc.stdin.write(np.ascontiguousarray(frame).data)
                sent += 1
        except BrokenPipeError:
            pass
        except BaseException:
            proc.kill()
            proc.wait()
            for o in outputs:
                partial(o.path).unlink(missing_ok=True)
            raise
        try:
            proc.stdin.close()
        except BrokenPipeError:
            pass
        code = proc.wait()
        if code != 0 or sent != n_frames:
            for o in outputs:
                partial(o.path).unlink(missing_ok=True)
            log.seek(0)
            tail = log.read().decode("utf8", "replace")[-800:]
            if code != 0:
                raise RuntimeError(f"ffmpeg exited {code} after {sent} frames: {tail}")
            raise ValueError(f"{sent} frames given, {n_frames} promised")
    results = []
    for o in outputs:
        scan_target = partial(o.path)
        if o.fmt == "mp4":
            publish(o.path)
            results.append(Result(o.path, min(n_frames, o.limit or n_frames), [0], o.path.stat().st_size, codec_for(o.width, o.height, hz)))
            continue
        info = scan_h264(scan_target)
        want = codec_for(o.width, o.height, hz)
        if info.codec != want:  # ultrafast/superfast drop the High-profile tools and x264 then writes Baseline/Main
            partial(o.path).unlink(missing_ok=True)
            raise RuntimeError(f"{o.path.name}: the SPS says {info.codec}, the format needs {want} (preset {preset!r} too fast for High profile?)")
        publish(o.path)
        results.append(Result(o.path, info.frames, info.idr, o.path.stat().st_size, info.codec))
    return results


# ---------------------------------------------------------------- reading a stream back


@dataclass
class H264Info:
    frames: int = 0
    idr: list[int] = field(default_factory=list)
    width: int = 0
    height: int = 0
    profile: int = 0
    constraints: int = 0
    level: int = 0
    codec: str = ""


class _Bits:
    def __init__(self, data: bytes):
        self.data, self.pos = data, 0

    def u(self, n: int) -> int:
        v = 0
        for _ in range(n):
            v = (v << 1) | ((self.data[self.pos >> 3] >> (7 - (self.pos & 7))) & 1)
            self.pos += 1
        return v

    def ue(self) -> int:
        zeros = 0
        while self.u(1) == 0:
            zeros += 1
        return (1 << zeros) - 1 + self.u(zeros)

    def se(self) -> int:
        k = self.ue()
        return (k + 1) // 2 if k % 2 else -(k // 2)


def parse_sps(nal: bytes) -> dict:
    """Profile, constraint flags, level and the cropped picture size from an SPS NAL (header byte included)."""
    rbsp = re.sub(rb"\x00\x00\x03", b"\x00\x00", nal[1:])
    profile, constraints, level = rbsp[0], rbsp[1], rbsp[2]
    b = _Bits(rbsp[3:])
    b.ue()  # seq_parameter_set_id
    chroma = 1
    if profile in (100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135):
        chroma = b.ue()
        if chroma == 3:
            b.u(1)
        b.ue(), b.ue(), b.u(1)
        if b.u(1):  # scaling matrices
            for i in range(8 if chroma != 3 else 12):
                if b.u(1):
                    last = nxt = 8
                    for _ in range(16 if i < 6 else 64):
                        if nxt != 0:
                            nxt = (last + b.se() + 256) % 256
                        last = last if nxt == 0 else nxt
    b.ue()  # log2_max_frame_num
    poc = b.ue()
    if poc == 0:
        b.ue()
    elif poc == 1:
        b.u(1), b.se(), b.se()
        for _ in range(b.ue()):
            b.se()
    b.ue(), b.u(1)
    mbs_w, mbs_h = b.ue() + 1, b.ue() + 1
    frame_mbs_only = b.u(1)
    if not frame_mbs_only:
        b.u(1)
    b.u(1)
    crop = (0, 0, 0, 0)
    if b.u(1):
        crop = (b.ue(), b.ue(), b.ue(), b.ue())  # left, right, top, bottom
    sub_x, sub_y = (2, 2) if chroma == 1 else (2, 1) if chroma == 2 else (1, 1)
    unit_x = sub_x if chroma else 1
    unit_y = (sub_y if chroma else 1) * (2 - frame_mbs_only)
    return {
        "profile": profile, "constraints": constraints, "level": level,
        "width": mbs_w * 16 - unit_x * (crop[0] + crop[1]), "height": (2 - frame_mbs_only) * mbs_h * 16 - unit_y * (crop[2] + crop[3]),
    }


def scan_h264(path: Path | str) -> H264Info:
    """Access units (one per access unit delimiter, as the player splits), the IDR positions, the SPS codec and size."""
    data = Path(path).read_bytes()
    info = H264Info()
    au = -1
    for m in re.finditer(rb"\x00\x00\x01", data):
        t = data[m.end()] & 0x1F
        if t == 9:
            au += 1
        elif t == 5 and au >= 0 and (not info.idr or info.idr[-1] != au):
            info.idr.append(au)
        elif t == 7 and not info.codec:
            end = data.find(b"\x00\x00\x01", m.end())
            sps = parse_sps(data[m.end() : end if end >= 0 else None])
            info.width, info.height, info.profile, info.constraints, info.level = sps["width"], sps["height"], sps["profile"], sps["constraints"], sps["level"]
            info.codec = f"avc1.{sps['profile']:02x}{sps['constraints']:02x}{sps['level']:02x}"
    info.frames = au + 1
    return info


def decode_frames(path: Path | str, indices: Sequence[int], width: int, height: int) -> dict[int, np.ndarray]:
    """Decoded RGB frames (full range, BT.709 -> RGB) at the given show-frame indices of an Annex B stream."""
    want = sorted(set(indices))
    sel = "+".join(f"eq(n,{i})" for i in want)
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-threads", THREADS, "-f", "h264", "-i", str(path),
        "-vf", f"select='{sel}',scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24",
        "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1",
    ]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg decode failed: {r.stderr.decode('utf8', 'replace')[-500:]}")
    size = width * height * 3
    if len(r.stdout) != size * len(want):
        raise RuntimeError(f"decoded {len(r.stdout) / size:g} frames of the {len(want)} asked ({want}) from {path}")
    buf = np.frombuffer(r.stdout, np.uint8)
    return {i: buf[k * size : (k + 1) * size].reshape(height, width, 3).copy() for k, i in enumerate(want)}


def decode_all(path: Path | str, width: int, height: int, region: tuple[int, int, int, int] | None = None) -> Iterator[np.ndarray]:
    """Every decoded RGB frame of a stream in order, streamed (optionally cropped to a region x, y, w, h)."""
    vf = "scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24"
    w, h = width, height
    if region:
        x, y, w, h = region
        vf = f"crop={w}:{h}:{x}:{y}," + vf
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-threads", THREADS, "-f", "h264", "-i", str(path), "-vf", vf, "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"]
    size = w * h * 3
    with tempfile.TemporaryFile() as err:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err)
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3).copy()
        proc.stdout.close()
        if proc.wait() != 0:
            err.seek(0)
            raise RuntimeError(f"ffmpeg decode failed: {err.read().decode('utf8', 'replace')[-500:]}")


# ---------------------------------------------------------------- quality checks

_LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)


def luma_mad(a: np.ndarray, b: np.ndarray) -> float:
    """Mean absolute difference of BT.709 luma between two RGB images, in grey levels."""
    d = (a.astype(np.float32) - b.astype(np.float32)) @ _LUMA
    return float(np.abs(d).mean())


def frame_error(stacked: np.ndarray, layout: Layout, reference: np.ndarray) -> dict:
    """Error of a decoded stacked frame's live region against a reference image (freeze.png at any size, resized to the region)."""
    x, y, w, h = layout.live
    got = stacked[y : y + h, x : x + w]
    ref = reference
    if ref.shape[:2] != (h, w):
        ref = cv2.resize(ref, (w, h), interpolation=cv2.INTER_AREA)
    diff = got.astype(np.float32) - ref.astype(np.float32)
    mse = float((diff**2).mean())
    return {
        "mad_luma": luma_mad(got, ref),
        "mad_rgb": float(np.abs(diff).mean()),
        "max": float(np.abs(diff).max()),
        "psnr": float("inf") if mse == 0 else float(10 * math.log10(255.0**2 / mse)),
    }


def calibrate_protect_qp(
    frames: Sequence[np.ndarray],
    layout: Layout,
    hz: float = 72,
    crf: float = 18,
    bound: float = MAD_BOUND,
    margin: float = 0.7,
    candidates: Sequence[int] = (20, 16, 14, 12, 10, 8, 6, 4, 2),
    reference: np.ndarray | None = None,
    preset: str = "veryfast",
) -> tuple[int, float]:
    """The highest QP at which the last of `frames` (F, with its lead-in) decodes within margin x bound luma MAD.

    Trial-encodes only these frames (an IDR on the first, as a segment start is), so it is cheap. Returns the QP and the
    MAD measured; if no candidate passes, the lowest QP and its (failing) MAD, for the caller to report.
    """
    n = len(frames)
    ref = frames[-1][layout.live[1] : layout.live[1] + layout.live[3]] if reference is None else reference
    best = (candidates[-1], float("inf"))
    for qp in candidates:
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "trial.h264"
            encode(iter(frames), [Output(out, layout.width, layout.height)], n, hz, [0], crf, preset, protect=[n - 1], protect_qp=qp)
            got = decode_frames(out, [n - 1], layout.width, layout.height)[n - 1]
        mad = frame_error(got, layout, ref)["mad_luma"]
        best = (qp, mad)
        if mad <= bound * margin:
            return qp, mad
    return best


def write_png(path: Path | str, rgb: np.ndarray) -> None:
    """A lossless PNG of an RGB image (freeze.png)."""
    path = Path(path)
    tmp = path.with_name(path.stem + ".tmp.png")  # cv2 needs the .png extension; renamed once complete
    ok = cv2.imwrite(str(tmp), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR) if rgb.ndim == 3 else rgb, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    if not ok:
        raise OSError(f"could not write {path}")
    fd = os.open(tmp, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)
