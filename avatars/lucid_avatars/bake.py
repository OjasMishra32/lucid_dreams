"""Bake an avatar bundle into a replay bundle: the avatar posed by its own motion.json, one Gaussian file per frame.

For players that show replays but can't skin yet (the WebXR viewer and the Quest app both play replays). Positions
use the reference skinning (skinning.pose_points); each Gaussian's orientation turns with the blend of its joints'
rotations; scales and colours stay. Only degree-0 colour is kept, since higher SH would need rotating too.
"""

from __future__ import annotations

import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .gaussian_ply import Gaussians, read_ply, write_ply
from .motion import Motion
from .rotations import matrix_to_quat, quat_mul
from .skinning import read_skin_bin, skin_matrices


def pose_gaussians(g: Gaussians, idx: np.ndarray, w: np.ndarray, M: np.ndarray) -> Gaussians:
    """g (rest pose) posed by skinning matrices M (55, 4, 4) with skin.bin records (idx, w)."""
    weights = np.asarray(w, dtype=np.float64) / 255
    blended = np.einsum("nk,nkab->nab", weights, np.asarray(M)[np.asarray(idx, dtype=np.int64)])
    xyz = np.einsum("nab,nb->na", blended[:, :3, :3], g.xyz) + blended[:, :3, 3]
    joint_q = np.stack([matrix_to_quat(m[:3, :3]) for m in M])  # (55, 4) x, y, z, w
    q = joint_q[np.asarray(idx, dtype=np.int64)]  # (N, 4, 4)
    q = q * np.sign(np.einsum("nkc,nc->nk", q, q[:, 0]) + 1e-12)[..., None]  # one hemisphere before blending
    q = np.einsum("nk,nkc->nc", weights, q)
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    own = np.concatenate([g.rotation[:, 1:], g.rotation[:, :1]], axis=1)  # PLY stores w, x, y, z
    turned = quat_mul(q, own)
    rotation = np.concatenate([turned[:, 3:], turned[:, :3]], axis=1)
    return Gaussians(xyz=xyz, f_dc=g.f_dc, f_rest=np.zeros((len(g), 0)), opacity=g.opacity, scale=g.scale,
                     rotation=rotation / np.linalg.norm(rotation, axis=1, keepdims=True))


def _spz_writer():
    """The pipeline's SPZ writer (pipeline/lucid/gaussians.py) when this checkout has it, else None."""
    pipeline = Path(__file__).resolve().parents[2] / "pipeline"
    if str(pipeline) not in sys.path and (pipeline / "lucid" / "gaussians.py").is_file():
        sys.path.append(str(pipeline))
    try:
        from lucid import gaussians as PG
    except ImportError:
        return None

    def write(path: Path, g: Gaussians) -> None:
        f32 = lambda a: np.asarray(a, dtype=np.float32)  # noqa: E731
        pg = PG.Gaussians(f32(g.xyz), f32(g.scale), f32(g.rotation), f32(g.opacity), f32(g.f_dc).reshape(-1, 1, 3),
                          np.zeros((len(g), 0, 3), np.float32))
        PG.write_spz(path, pg, sh_degree=0)

    return write


def bake_bundle(src: str | Path, dreams_dir: str | Path, out_id: str, fps: float = 15.0, spz: bool = True) -> Path:
    """dreams/<out_id>/: the avatar bundle at src as a replay at `fps` (frames/%06d.ply, and .spz when possible)."""
    src = Path(src)
    dream = json.loads((src / "dream.json").read_text())
    avatar = dream["avatar"]
    if not avatar or "skin" not in avatar or "skeleton" not in avatar:
        raise ValueError(f"{src} has no skin.bin + skeleton.json to pose it with")
    g = read_ply(src / avatar["file"])
    idx, w = read_skin_bin(src / avatar["skin"])
    rest = np.asarray(json.loads((src / avatar["skeleton"]).read_text())["rest"], dtype=np.float64)
    motion = Motion.load(src / avatar["motion"])

    root = Path(dreams_dir) / out_id
    frames_dir = root / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    write_spz = _spz_writer() if spz else None
    count = max(1, round(motion.num_frames / motion.fps * fps))
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    for i in range(count):
        f = min(motion.num_frames - 1, round(i * motion.fps / fps))
        M = skin_matrices(rest, motion.root_q[f], motion.root_t[f], motion.pose[f])
        posed = pose_gaussians(g, idx, w, M)
        write_ply(frames_dir / f"{i:06d}.ply", posed)
        if write_spz:
            write_spz(frames_dir / f"{i:06d}.spz", posed)
        lo, hi = np.minimum(lo, posed.xyz.min(axis=0)), np.maximum(hi, posed.xyz.max(axis=0))

    frames = {"dir": "frames", "pattern": "%06d.ply", "gaussiansPerFrame": len(g)}
    if write_spz:
        frames["spz"] = "%06d.spz"
    out = {
        "id": out_id, "name": dream["name"], "kind": "replay", "fps": fps, "frameCount": count,
        "durationS": round(count / fps, 3), "units": "meters", "upAxis": "+Y",
        "bounds": {"min": np.round(lo, 3).tolist(), "max": np.round(hi, 3).tolist()},
        "frames": frames, "avatar": None, "audio": None, "preview": None, "thumb": None,
        "source": {**(dream.get("source") or {}), "bakedFrom": dream["id"], "motion": avatar["motion"]},
        "metrics": dream.get("metrics") or {"psnr": None, "ssim": None, "lpips": None, "views": None},
        "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    for key in ("preview", "thumb"):
        if dream.get(key) and (src / dream[key]).is_file():
            shutil.copy2(src / dream[key], root / dream[key])
            out[key] = dream[key]
    (root / "dream.json").write_text(json.dumps(out, indent=2) + "\n")
    return root
