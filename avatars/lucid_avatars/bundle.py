"""Write an avatar dream bundle and check any bundle against the contract in AGENTS.md."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .face_expr import expr_errors
from .gaussian_ply import Gaussians, header_errors, read_header, write_ply
from .motion import Motion, is_vec, validate_motion_dict
from .skinning import SKELETON_FILE, SKIN_FILE, skin_errors, write_skin_bin

AVATAR_FILE = "avatar/avatar.ply"
MOTION_FILE = "avatar/motion.json"
REQUIRED_KEYS = [
    "id", "name", "kind", "fps", "frameCount", "durationS", "units", "upAxis", "bounds",
    "frames", "avatar", "audio", "preview", "thumb", "source", "metrics", "createdAt",
]


def write_avatar_bundle(
    dreams_dir: str | Path,
    dream_id: str,
    name: str,
    gaussians: Gaussians,
    motion: Motion,
    source: dict | None = None,
    metrics: dict | None = None,
    skin: tuple[np.ndarray, np.ndarray] | None = None,
    skeleton: dict | None = None,
) -> Path:
    """Write dreams/<id>/ with dream.json, avatar/avatar.ply and avatar/motion.json. Returns the bundle dir.

    skin (uint8 joint indices, uint8 weights, each (N, 4)) and skeleton (skinning.skeleton_dict) add
    avatar/skin.bin and avatar/skeleton.json so players can pose the Gaussians.

    preview.mp4 and thumb.jpg come from a render pass; set them in dream.json once they exist.
    Bounds are the rest-pose extent stood on the floor: a guide for placement, not a tight box for every frame.
    """
    root = Path(dreams_dir) / dream_id
    (root / "avatar").mkdir(parents=True, exist_ok=True)
    write_ply(root / AVATAR_FILE, gaussians)
    motion.save(root / MOTION_FILE)
    avatar = {"file": AVATAR_FILE, "rig": "smplx", "motion": MOTION_FILE}
    if skin is not None and skeleton is not None:
        write_skin_bin(root / SKIN_FILE, *skin)
        (root / SKELETON_FILE).write_text(json.dumps(skeleton) + "\n")
        avatar.update(skin=SKIN_FILE, skeleton=SKELETON_FILE)
    elif skin is not None or skeleton is not None:
        raise ValueError("skin and skeleton come together")

    lo, hi = gaussians.xyz.min(axis=0), gaussians.xyz.max(axis=0)
    centre = (lo + hi) / 2
    half_xz = np.maximum(np.abs(lo - centre), np.abs(hi - centre))
    dream = {
        "id": dream_id,
        "name": name,
        "kind": "avatar",
        "fps": motion.fps,
        "frameCount": motion.num_frames,
        "durationS": round(motion.num_frames / motion.fps, 3),
        "units": "meters",
        "upAxis": "+Y",
        "bounds": {
            "min": [round(-half_xz[0], 3), 0.0, round(-half_xz[2], 3)],
            "max": [round(half_xz[0], 3), round(hi[1] - lo[1], 3), round(half_xz[2], 3)],
        },
        "frames": None,
        "avatar": avatar,
        "audio": None,
        "preview": None,
        "thumb": None,
        "source": source,
        "metrics": metrics or {"psnr": None, "ssim": None, "lpips": None, "views": None},
        "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    (root / "dream.json").write_text(json.dumps(dream, indent=2) + "\n")
    return root


def validate_bundle(root: str | Path) -> list[str]:
    """Problems with a dream bundle directory, as readable strings. Empty means it matches the contract."""
    root = Path(root).resolve()
    try:
        dream = json.loads((root / "dream.json").read_text())
    except (OSError, ValueError) as e:
        return [f"dream.json: {e}"]
    if not isinstance(dream, dict):
        return ["dream.json: must be a JSON object"]
    errors = [f"dream.json: missing key {k!r}" for k in REQUIRED_KEYS if k not in dream]

    def inside(key: str, rel) -> Path | None:
        """The bundle file a dream.json path names, or None (with an error) if it isn't a path inside the bundle."""
        if not isinstance(rel, str) or not rel:
            errors.append(f"dream.json: {key} must be a relative path")
            return None
        path = (root / rel).resolve()
        if not path.is_relative_to(root):
            errors.append(f"dream.json: {key} points outside the bundle ({rel})")
            return None
        return path

    if dream.get("units") != "meters":
        errors.append("dream.json: units must be 'meters'")
    if dream.get("upAxis") != "+Y":
        errors.append("dream.json: upAxis must be '+Y'")
    bounds = dream.get("bounds")
    if not (
        isinstance(bounds, dict) and is_vec(bounds.get("min"), 3) and is_vec(bounds.get("max"), 3)
        and all(a <= b for a, b in zip(bounds["min"], bounds["max"]))
    ):
        errors.append("dream.json: bounds must be {min: [x,y,z], max: [x,y,z]} with min <= max")
    for key in ("audio", "preview", "thumb"):
        rel = dream.get(key)
        if rel is not None and (path := inside(key, rel)) and not path.is_file():
            errors.append(f"dream.json: {key} points to {rel}, which doesn't exist")

    kind = dream.get("kind")
    if kind not in ("replay", "avatar"):
        errors.append(f"dream.json: kind must be 'replay' or 'avatar', got {kind!r}")
    avatar = dream.get("avatar")
    if avatar is not None and not isinstance(avatar, dict):
        errors.append("dream.json: avatar must be an object or null")
    elif kind == "avatar" or avatar is not None:
        errors += _avatar_errors(dream, avatar or {}, inside)
    elif kind == "replay":
        errors += _replay_errors(dream, inside)
    return errors


def _avatar_errors(dream: dict, avatar: dict, inside) -> list[str]:
    errors = []
    if dream.get("frames") is not None:
        errors.append("dream.json: frames must be null for an avatar")
    if avatar.get("rig") != "smplx":
        errors.append("dream.json: avatar.rig must be 'smplx'")
    ply = inside("avatar.file", avatar.get("file", AVATAR_FILE))
    if ply:
        ply_errors = [f"{ply.name}: {e}" for e in header_errors(ply)]
        errors += ply_errors
        paths_ok = all(inside(f"avatar.{k}", avatar[k]) for k in ("skin", "skeleton", "expr") if k in avatar)
        if not ply_errors and paths_ok:
            errors += skin_errors(inside("bundle", "."), avatar, read_header(ply)[1])
            errors += expr_errors(inside("bundle", "."), avatar, read_header(ply)[1])
    motion_path = inside("avatar.motion", avatar.get("motion", MOTION_FILE))
    if not motion_path:
        return errors
    try:
        motion = json.loads(motion_path.read_text())
    except (OSError, ValueError) as e:
        return errors + [f"motion.json: {e}"]
    errors += [f"motion.json: {e}" for e in validate_motion_dict(motion)]
    if isinstance(motion, dict) and isinstance(motion.get("frames"), list):
        if dream.get("frameCount") != len(motion["frames"]):
            errors.append("dream.json: frameCount doesn't match motion.json")
        if dream.get("fps") != motion.get("fps"):
            errors.append("dream.json: fps doesn't match motion.json")
    return errors


def _replay_errors(dream: dict, inside) -> list[str]:
    frames, count = dream.get("frames"), dream.get("frameCount")
    if not isinstance(frames, dict):
        return ["dream.json: frames must be an object for a replay"]
    if not isinstance(count, int) or isinstance(count, bool) or count <= 0:
        return ["dream.json: frameCount must be a positive integer"]
    frame_dir = inside("frames.dir", frames.get("dir", "frames"))
    if not frame_dir:
        return []
    pattern = frames.get("pattern", "%06d.ply")
    try:
        paths = [frame_dir / (pattern % i) for i in range(count)]
    except (TypeError, ValueError):
        return [f"dream.json: frames.pattern {pattern!r} is not a %d pattern"]
    missing = [p.name for p in paths if not p.is_file()]
    if missing:
        return [f"replay is missing {len(missing)} of {count} frames, first {missing[0]}"]
    errors = []
    for p in {paths[0], paths[-1]}:
        errors += [f"frames/{p.name}: {e}" for e in header_errors(p)]
    return errors
