"""Front face renders of a speaking avatar, before and after its voice drives its lips, for SyncNet (lips_sync_score.py).

The GPU half of the lip-sync number (4DAnyone env: gsplat and lucid.export's renderer; this folder on PYTHONPATH):
  python lips_render.py dreams/vishal-head-voice --person vishal --out lips/vishal-head-voice.sync

Both renders play the bundle's own motion frame by frame at 25 fps from one fixed camera in front of the face (placed
from the first frame's posed head, framed as head_swap_render.face_target frames a face), each frame as a player does it:
expr.bin's offsets for that frame's `expr` added to the rest Gaussians (face_expr.apply_expr), then skinned
(skinning.skin_matrices + pose_points), the Gaussians' orientations turned by their main joint. Only the Gaussians
within 0.5 m of the head are drawn (the camera sees nothing else).
  after   the bundle as it is: mouth0..mouth8 (the voice) + blink
  before  the same, the `mouth*` channels zeroed (by name from dream.json's exprChannels): the idle, blinking
Out (in --out, never in the bundle):
  after.mp4 / before.mp4              full resolution (default 672 px square), voice.m4a muxed in, for people to watch
  after_crops.avi / before_crops.avi  224 x 224 (the full render box-averaged), 25 fps, 16 kHz mono audio: SyncNet's input
  compare.png                         the frame with the widest mouth, before | after
  render.json                         frames, fps, clip length, camera
The consent gate (lips.py's: VOICE_CONSENTED, their own voice-driven bundle, nothing in dreams/.held) runs first, before
the audio or any file of the bundle is read. Never a public figure.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np

from lucid_avatars import lip_sync as S
from lucid_avatars.face_expr import apply_expr, read_expr_bin
from lucid_avatars.ik import world_joints
from lucid_avatars.motion import Motion
from lucid_avatars.rotations import matrix_to_quat, quat_mul
from lucid_avatars.skinning import SKELETON_FILE, pose_points, read_skin_bin, skin_matrices
from lucid_avatars.smplx_layout import J

NEAR_HEAD_M = 0.5  # Gaussians farther than this from the rest head joint are never in the face view
BG = 0.5           # mid grey: a dark head of hair stays visible against it


def audio_seconds(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


class Sink:
    """ffmpeg reading raw RGB frames on stdin, muxing `audio`, writing `out` (renamed from a .part once whole)."""

    def __init__(self, out: Path, size: int, audio: Path, seconds: float, codec: list[str]):
        self.out, self.part = out, out.with_name(out.stem + ".part" + out.suffix)
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{size}x{size}",
               "-r", str(S.FPS), "-i", "-", "-i", str(audio), "-map", "0:v", "-map", "1:a", *codec,
               "-t", f"{seconds:.4f}", str(self.part)]
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)

    def write(self, frame: np.ndarray) -> None:
        self.proc.stdin.write(frame.tobytes())

    def close(self, ok: bool = True) -> None:
        try:
            self.proc.stdin.close()
        except BrokenPipeError:
            pass
        if not ok:
            self.proc.kill()
            self.part.unlink(missing_ok=True)
            return
        if self.proc.wait() != 0:
            self.part.unlink(missing_ok=True)
            raise SystemExit(f"ffmpeg failed writing {self.out.name}")
        self.part.replace(self.out)


WATCH = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "14", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]
SYNCNET = ["-c:v", "mjpeg", "-q:v", "1", "-pix_fmt", "yuvj420p", "-c:a", "pcm_s16le", "-ar", "16000", "-ac", "1"]


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("bundle", type=Path, help="the voice-driven bundle (lips.sbatch's dreams/<person>-head-voice)")
    p.add_argument("--person", required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--held", type=Path, default=None, help="another .held file, added to the one next to the bundle")
    p.add_argument("--factor", type=int, default=3, help="render side = 224 x this (default 3: 672 px)")
    p.add_argument("--device", default="cuda")
    a = p.parse_args()

    refused = S.sync_consent_errors(a.person, a.bundle, a.held)  # first: nothing else of the bundle is read before
    if refused:
        print("REFUSED", *refused, sep="\n     ")
        return 2

    from head_swap_render import face_target, grid, load
    from lucid.export import orbit_camera, render

    dream, g, _ = load(a.bundle)
    av = dream["avatar"]
    channels = av["exprChannels"]
    motion = Motion.load(a.bundle / av["motion"])
    if motion.expr is None or motion.expr.shape[1] != len(channels):
        raise SystemExit(f"{a.bundle}'s motion has no expr for its {len(channels)} channels")
    lips = json.loads((a.bundle / "lips.json").read_text())
    voice = a.bundle / "voice.m4a"
    clip_s = min(audio_seconds(voice), float(lips["clipS"]) + 0.05)
    n, src_idx = S.frame_plan(motion.num_frames, motion.fps, clip_s)
    seconds = n / S.FPS
    after = S.resample_expr(motion.expr, motion.fps, n)
    before = S.before_expr(after, channels)
    print(f"[lips-render] {a.bundle.name}: {clip_s:.2f} s of audio -> {n} frames at {S.FPS} fps "
          f"(motion {motion.num_frames} frames at {motion.fps:g} fps), channels {channels}")

    rest = np.asarray(json.loads((a.bundle / av.get("skeleton", SKELETON_FILE)).read_text())["rest"])
    idx, q = read_skin_bin(a.bundle / av["skin"])
    first, d = read_expr_bin(a.bundle / av["expr"])
    rest_xyz = g.means.astype(np.float64)
    sel = np.flatnonzero(np.linalg.norm(rest_xyz - rest[J["head"]], axis=1) <= NEAR_HEAD_M)
    sub, sub_idx, sub_q = g.subset(sel), idx[sel].astype(np.int64), q[sel]
    main_joint = sub_idx[:, 0]  # skin.bin lists each Gaussian's joints biggest weight first (quantize_top4)
    q_xyzw = np.concatenate([sub.quats[:, 1:], sub.quats[:, :1]], axis=1).astype(np.float64)
    q_xyzw /= np.linalg.norm(q_xyzw, axis=1, keepdims=True)

    # the fixed camera: in front of the first frame's posed face
    joints, R = world_joints(rest, motion.root_q[src_idx[0]], motion.root_t[src_idx[0]], motion.pose[src_idx[0]])
    angle = S.front_angle(R[0] @ np.array([0.0, 0.0, 1.0]))  # SMPL-X faces +Z in its own frame
    target_y, centre, radius = face_target(joints[J["head"]])
    cam = orbit_camera(angle, radius, target_y, target_y, centre)
    size = S.render_size(a.factor)
    print(f"[lips-render] camera angle {math.degrees(angle):.1f} deg, face at y {target_y:.3f} m, {len(sel)} Gaussians near the head")

    def frame(f: int, expr: np.ndarray) -> np.ndarray:
        k = int(src_idx[f])
        M = skin_matrices(rest, motion.root_q[k], motion.root_t[k], motion.pose[k])
        posed = pose_points(apply_expr(rest_xyz, first, d, expr[f])[sel], sub_idx, sub_q, M)
        jq = np.stack([matrix_to_quat(M[j, :3, :3]) for j in range(len(M))])
        turned = quat_mul(jq[main_joint], q_xyzw)
        quats = np.concatenate([turned[:, 3:], turned[:, :3]], axis=1).astype(np.float32)
        from dataclasses import replace
        return render(replace(sub, means=posed.astype(np.float32), quats=quats), cam, size, size, np.full(3, BG), a.device)

    a.out.mkdir(parents=True, exist_ok=True)
    for name, expr in (("before", before), ("after", after)):
        watch = Sink(a.out / f"{name}.mp4", size, voice, seconds, WATCH)
        crops = Sink(a.out / f"{name}_crops.avi", S.CROP_PX, voice, seconds, SYNCNET)
        try:
            for f in range(n):
                full = frame(f, expr)
                watch.write(full)
                crops.write(S.box_down(full, a.factor))
        except BaseException:
            watch.close(False)
            crops.close(False)
            raise
        watch.close()
        crops.close()
        print(f"[lips-render] {name}: {n} frames")

    mouth = [i for i, c in enumerate(channels) if c.startswith("mouth")]
    widest = int(np.linalg.norm(after[:, mouth], axis=1).argmax())
    try:
        grid([[S.box_down(frame(widest, before), a.factor), S.box_down(frame(widest, after), a.factor)]],
             [f"before (idle), frame {widest}", "after (voice)"]).save(a.out / "compare.png")
    except ImportError:
        print("[lips-render] no Pillow: compare.png skipped")
    (a.out / "render.json").write_text(json.dumps({
        "bundle": a.bundle.name, "person": a.person, "frames": n, "fps": S.FPS, "clipS": round(clip_s, 3),
        "motionFps": motion.fps, "channels": channels, "render": f"{size}x{size}", "crop": f"{S.CROP_PX}x{S.CROP_PX}",
        "cameraAngleDeg": round(math.degrees(angle), 2), "gaussians": int(len(sel)), "widestMouthFrame": widest}, indent=2) + "\n")
    print(f"LIPS_RENDER_OK {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
