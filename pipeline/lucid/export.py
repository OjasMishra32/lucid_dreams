"""Turn reconstructed frames into a dream bundle (see AGENTS.md "Dream bundle").

Places the person in bundle coordinates (meters, +Y up, feet on y = 0, centred on x = z = 0, front facing the viewer
who stands on -Z looking toward +Z), writes every frame as PLY and as compact SPZ, renders a 360-degree orbit
preview.mp4 and thumb.jpg, copies the clip's audio, and writes dream.json with real metrics.

    python -m lucid.export --recon <recon dir> --out <bundle dir> --id curry-01 --name "Steph's jumper" \
        [--result <4DAnyone result dir>] [--clip <source clip>] [--fps 25]
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .gaussians import Gaussians, read_ply, write_ply, write_spz

SH_C0 = 0.28209479177387814


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--recon", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--id", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--result", type=Path, help="4DAnyone result dir (cameras.json: which way the source camera looked)")
    p.add_argument("--clip", type=Path, help="source clip, for audio and source metadata")
    p.add_argument("--fps", type=float, default=25.0)
    p.add_argument("--intent", default="", help="what the user wants to do with this person (for experience.json)")
    p.add_argument("--preview-size", default="720x1280")
    p.add_argument("--preview-bg", default="0,0,0", help="r,g,b in 0-255")
    p.add_argument("--device", default="cuda:0")
    return p.parse_args(argv)


def rotate_sh1(shN: np.ndarray, r: np.ndarray) -> np.ndarray:
    """Rotate the degree-1 SH band by R; higher bands are dropped. shN [N,K-1,3] -> [N,3,3] (or [N,0,3])."""
    if shN.shape[1] == 0:
        return shN
    s = shN[:, :3, :]  # coefficients for (-y, z, -x) * C1
    v = np.stack([-s[:, 2, :], -s[:, 0, :], s[:, 1, :]], axis=1)  # linear form in (x, y, z)
    v = np.einsum("ij,njc->nic", r, v)
    return np.stack([-v[:, 1, :], v[:, 2, :], -v[:, 0, :]], axis=1).astype(np.float32)


SHOT = re.compile(r"\b(shot|shoot|shooting|jumper|basketball|free throw|layup|three)\b", re.I)
RIM_HEIGHT = 3.05  # m, top of the ring
RIM_DISTANCE = 4.2  # m from the shooter's feet: about the free-throw line


def shot_direction(frames: list[Gaussians]) -> np.ndarray | None:
    """Which way a shooter faces, from the reconstruction itself: around the frame where the body reaches highest (the
    release), the ball and hands at the top sit ahead of the chest. Unit (x, z), or None when it can't tell."""
    tops = []
    for g in frames:
        solid = g.means[1 / (1 + np.exp(-g.opacities)) > 0.5]
        if len(solid) > 500:
            tops.append(np.percentile(solid[:, 1], 99.5))
    if not tops:
        return None
    peak = int(np.argmax(tops))
    offsets = []
    for g in frames[max(0, peak - 5): peak + 6]:
        solid = g.means[1 / (1 + np.exp(-g.opacities)) > 0.5]
        if len(solid) < 500:
            continue
        top_y = np.percentile(solid[:, 1], 99.5)
        top = solid[solid[:, 1] > top_y - 0.25]
        chest = solid[(solid[:, 1] > top_y * 0.45) & (solid[:, 1] < top_y * 0.65)]
        if len(top) > 20 and len(chest) > 20:
            offsets.append(top[:, [0, 2]].mean(0) - chest[:, [0, 2]].mean(0))
    if not offsets:
        return None
    d = np.median(np.array(offsets), axis=0)
    n = float(np.linalg.norm(d))
    return d / n if n > 0.03 else None


def shot_props(frames: list[Gaussians], words: str, fps: float) -> dict | None:
    """props.json for a shooting clip: a regulation hoop where the shooter is aiming (AGENTS.md, Props). Added, not
    seen: the hoop isn't reconstructed, it's placed."""
    if not SHOT.search(words or ""):
        return None
    d = shot_direction(frames)
    if d is None:
        d = np.array([0.0, 1.0])  # unknown: away from the source camera, which looks along +Z in bundle space
    feet = frames[0].means[:, [0, 2]].mean(0)
    rim = feet + d * RIM_DISTANCE
    return {"fps": fps, "objects": [{"kind": "hoop", "rim": [round(float(rim[0]), 3), RIM_HEIGHT, round(float(rim[1]), 3)],
                                     "facing": [round(float(-d[0]), 4), 0.0, round(float(-d[1]), 4)], "added": True}]}


def placement(first: Gaussians, result: Path | None) -> tuple[np.ndarray, np.ndarray]:
    """Rotation about +Y (source camera onto -Z) and translation (feet to y = 0, centre to x = z = 0)."""
    alpha = 1 / (1 + np.exp(-first.opacities))
    solid = first.means[alpha > 0.5] if (alpha > 0.5).sum() > 100 else first.means
    centre = np.median(solid, axis=0)
    yaw = 0.0
    if result is not None and (result / "cameras.json").exists():
        cams = sorted(json.loads((result / "cameras.json").read_text())["cameras"], key=lambda c: int(c["camera_id"]))
        cam0 = np.asarray(cams[0]["camera_to_world"], float)[:3, 3]
        d = cam0 - centre
        yaw = math.atan2(d[0], d[2])  # angle of the source camera around +Y, measured from +Z
        yaw = yaw - math.pi  # bring it to -Z
    c, s = math.cos(-yaw), math.sin(-yaw)
    rot = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    rotated = (solid - centre) @ rot.T
    floor = np.percentile(rotated[:, 1], 0.5)
    t = -(rot @ centre) - np.array([0.0, floor, 0.0])
    return rot, t


def front_cameras(result: Path) -> list[dict]:
    """The ring cameras on the source-facing side (+Z in 4DAnyone's world): what the real camera could have seen."""
    cams = json.loads((result / "cameras.json").read_text())["cameras"]
    out = []
    for c in cams:
        pos = np.asarray(c["camera_to_world"], float)[:3, 3]
        yaw = math.degrees(math.atan2(pos[0], pos[2]))
        if abs(yaw) < 1e-3 or abs(yaw) < 360.0 / max(len(cams), 1):  # yaw 0 ring cameras, every pitch layer
            out.append(c)
    return out or cams[:1]


def seen_mask(g: Gaussians, cams: list[dict], device: str, tol: float = 0.04) -> np.ndarray:
    """True for Gaussians on a surface one of the front cameras saw: in frame, inside the person, not behind the
    nearest visible surface (expected depth + tol). Everything else was imagined by the generator."""
    import torch
    from gsplat import rasterization

    t = lambda x: torch.as_tensor(np.ascontiguousarray(x), dtype=torch.float32, device=device)  # noqa: E731
    means = t(g.means)
    seen = torch.zeros(len(g.means), dtype=torch.bool, device=device)
    for c in cams:
        K = t(np.asarray(c["K"], float))
        w2c = t(np.linalg.inv(np.asarray(c["camera_to_world"], float)))
        W, H = int(c["image_width"]), int(c["image_height"])
        depth, alpha, _ = rasterization(
            means=means, quats=t(g.quats), scales=torch.exp(t(g.scales)), opacities=torch.sigmoid(t(g.opacities)),
            colors=t(g.sh0[:, 0] * SH_C0 + 0.5), viewmats=w2c[None], Ks=K[None], width=W, height=H, render_mode="ED",
        )
        cam = means @ w2c[:3, :3].T + w2c[:3, 3]
        z = cam[:, 2]
        uv = cam[:, :2] / z.clamp_min(1e-6)[:, None] @ K[:2, :2].T + K[:2, 2]
        u, v = uv[:, 0].round().long(), uv[:, 1].round().long()
        inside = (z > 0) & (u >= 0) & (u < W) & (v >= 0) & (v < H)
        ui, vi = u.clamp(0, W - 1), v.clamp(0, H - 1)
        d = depth[0, vi, ui, 0]
        a = alpha[0, vi, ui, 0]
        seen |= inside & (a > 0.5) & (z <= d + tol)
    return seen.cpu().numpy()


def tinted(g: Gaussians, seen: np.ndarray) -> Gaussians:
    """Imagined Gaussians pulled toward blue, so "seen vs imagined" reads at a glance."""
    blue = (np.array([0.0, 0.44, 0.89]) - 0.5) / SH_C0
    sh0 = g.sh0.copy()
    sh0[~seen, 0, :] = 0.35 * sh0[~seen, 0, :] + 0.65 * blue
    return Gaussians(g.means, g.scales, g.quats, g.opacities, sh0.astype(np.float32), np.zeros((len(sh0), 0, 3), np.float32))


def place(g: Gaussians, rot: np.ndarray, t: np.ndarray) -> Gaussians:
    moved = g.transformed(rot, t)
    moved.shN = rotate_sh1(g.shN, rot)
    return moved


def orbit_camera(angle: float, radius: float, height: float, target_y: float) -> np.ndarray:
    pos = np.array([radius * math.sin(angle), height, -radius * math.cos(angle)])
    f = np.array([0.0, target_y, 0.0]) - pos
    f /= np.linalg.norm(f)
    r = np.cross(f, [0.0, 1.0, 0.0])
    r /= np.linalg.norm(r)
    d = np.cross(f, r)
    c2w = np.eye(4)
    c2w[:3, 0], c2w[:3, 1], c2w[:3, 2], c2w[:3, 3] = r, d, f, pos
    return np.linalg.inv(c2w)


def render(g: Gaussians, viewmat: np.ndarray, width: int, height: int, bg: np.ndarray, device: str) -> np.ndarray:
    import torch
    from gsplat import rasterization

    t = lambda x: torch.as_tensor(np.ascontiguousarray(x), dtype=torch.float32, device=device)  # noqa: E731
    fy = 0.5 * height / math.tan(math.radians(40.0) / 2)
    K = np.array([[fy, 0, width / 2], [0, fy, height / 2], [0, 0, 1.0]])
    degree = g.sh_degree
    colors = np.concatenate([g.sh0, g.shN], 1)
    rgb, alpha, _ = rasterization(
        means=t(g.means),
        quats=t(g.quats),
        scales=torch.exp(t(g.scales)),
        opacities=torch.sigmoid(t(g.opacities)),
        colors=t(colors),
        viewmats=t(viewmat)[None],
        Ks=t(K)[None],
        width=width,
        height=height,
        sh_degree=degree,
        rasterize_mode="antialiased",
    )
    out = rgb[0].clamp(0, 1) + (1 - alpha[0]) * t(bg)  # composite over the background ourselves
    return (out.clamp(0, 1) * 255).round().byte().cpu().numpy()


def isolate_voice(audio: Path, out: Path) -> bool:
    """The speaking voice alone (Demucs two-stem separation: vocals vs everything else), so an old home video sounds
    like the person rather than the room. Returns False if Demucs isn't installed or finds nothing."""
    import shutil
    import tempfile

    if shutil.which("demucs") is None:
        try:
            import demucs  # noqa: F401
        except ImportError:
            return False
    with tempfile.TemporaryDirectory() as tmp:
        r = subprocess.run(["python", "-m", "demucs", "--two-stems", "vocals", "-n", "htdemucs", "-o", tmp, str(audio)],
                           capture_output=True, text=True)
        stems = list(Path(tmp).rglob("vocals.wav"))
        if r.returncode != 0 or not stems:
            print("[export] voice isolation skipped:", r.stderr[-300:])
            return False
        # gentle clean-up: high-pass the rumble, even out the level, then AAC
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(stems[0]), "-af",
                        "highpass=f=70,loudnorm=I=-18:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "160k", str(out)], check=False)
    return out.exists()


def main(argv=None):
    a = parse_args(argv)
    frame_paths = sorted((a.recon / "frames").glob("*.ply"))
    if not frame_paths:
        raise SystemExit(f"no frames in {a.recon / 'frames'}")
    out_frames = a.out / "frames"
    out_frames.mkdir(parents=True, exist_ok=True)

    first = read_ply(frame_paths[0])
    rot, t = placement(first, a.result)
    cams = front_cameras(a.result) if a.result and (a.result / "cameras.json").exists() else []
    seen_fractions: list[float] = []
    counts, spz_total, bounds = [], 0, None
    placed_frames: list[Gaussians] = []
    for i, path in enumerate(frame_paths):
        raw = read_ply(path)
        g = place(raw, rot, t)
        write_ply(out_frames / f"{i:06d}.ply", g)
        spz_total += write_spz(out_frames / f"{i:06d}.spz", g, sh_degree=0)
        if cams:
            seen = seen_mask(raw, cams, a.device)
            seen_fractions.append(float(seen.mean()))
            write_spz(out_frames / f"{i:06d}.reality.spz", tinted(g, seen), sh_degree=0)
        counts.append(g.count)
        if i == 0:
            alpha = 1 / (1 + np.exp(-g.opacities))
            solid = g.means[alpha > 0.5] if (alpha > 0.5).sum() > 100 else g.means
            bounds = {"min": np.percentile(solid, 0.5, 0).round(3).tolist(), "max": np.percentile(solid, 99.5, 0).round(3).tolist()}
        placed_frames.append(g)

    # preview: one orbit over the clip, looping the motion; thumbnail from the front a third of the way in
    w, h = (int(v) for v in a.preview_size.split("x"))
    bg = np.array([float(v) for v in a.preview_bg.split(",")]) / 255.0
    top = bounds["max"][1] if bounds else 1.8
    seconds = max(len(placed_frames) / a.fps, 4.0)
    n_out = int(seconds * 30)
    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", "30", "-i", "-",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart", str(a.out / "preview.mp4")],
        stdin=subprocess.PIPE,
    )
    for k in range(n_out):
        g = placed_frames[int(k / 30 * a.fps) % len(placed_frames)]
        vm = orbit_camera(2 * math.pi * k / n_out, radius=max(2.4, top * 1.4), height=top * 0.6, target_y=top * 0.5)
        ff.stdin.write(render(g, vm, w, h, bg, a.device).tobytes())
    ff.stdin.close()
    ff.wait()
    from PIL import Image

    front = placed_frames[len(placed_frames) // 3]
    thumb = render(front, orbit_camera(0.0, max(2.4, top * 1.4), top * 0.6, top * 0.5), w, h, bg, a.device)
    Image.fromarray(thumb).save(a.out / "thumb.jpg", quality=92)

    audio = None
    voice = None
    source = None
    if a.clip and a.clip.exists():
        probe = json.loads(subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", str(a.clip)], capture_output=True, text=True
        ).stdout or "{}")
        streams = probe.get("streams", [])
        video = next((s for s in streams if s.get("codec_type") == "video"), {})
        source = {"clip": a.clip.name, "width": video.get("width"), "height": video.get("height")}
        if any(s.get("codec_type") == "audio" for s in streams):
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(a.clip), "-vn", "-c:a", "aac", "-b:a", "160k",
                            "-t", f"{len(placed_frames) / a.fps:.3f}", str(a.out / "audio.m4a")], check=False)
            audio = "audio.m4a" if (a.out / "audio.m4a").exists() else None
            if audio and isolate_voice(a.out / "audio.m4a", a.out / "voice.m4a"):
                voice = "voice.m4a"

    reports = [json.loads(p.read_text()) for p in sorted(a.recon.glob("recon-*.json"))]
    per_frame = [f for r in reports for f in r.get("frames", [])]
    mean = lambda k: round(float(np.mean([f[k] for f in per_frame if k in f])), 2) if per_frame else None  # noqa: E731
    views = None
    if a.result and (a.result / "cameras.json").exists():
        views = len(json.loads((a.result / "cameras.json").read_text())["cameras"])
    dream = {
        "id": a.id,
        "name": a.name,
        "kind": "replay",
        "fps": a.fps,
        "frameCount": len(placed_frames),
        "durationS": round(len(placed_frames) / a.fps, 3),
        "units": "meters",
        "upAxis": "+Y",
        "bounds": bounds,
        "frames": {
            "dir": "frames",
            "pattern": "%06d.ply",
            "spz": "%06d.spz",
            "gaussiansPerFrame": int(np.median(counts)),
            "spzBytesTotal": spz_total,
            "reality": "%06d.reality.spz" if seen_fractions else None,
        },
        "avatar": None,
        "intent": a.intent or None,
        "audio": audio,
        "voice": voice,
        "preview": "preview.mp4",
        "thumb": "thumb.jpg",
        "source": source,
        "metrics": {"psnr": mean("psnr"), "ssim": mean("ssim"), "lpips": None, "views": views,
                    "seenFraction": round(float(np.mean(seen_fractions)), 3) if seen_fractions else None},
        "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    props = shot_props(placed_frames, f"{a.intent} {a.name}", a.fps)
    if props:
        (a.out / "props.json").write_text(json.dumps(props, indent=2))
        dream["props"] = "props.json"
    (a.out / "dream.json").write_text(json.dumps(dream, indent=2))
    print("[export]", json.dumps({k: dream[k] for k in ("id", "frameCount", "metrics")}), f"spz {spz_total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
