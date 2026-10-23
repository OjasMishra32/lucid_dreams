"""Gaussian people on disk: the standard 3DGS PLY layout, and SPZ (gzip-packed) for the web and the headset.

Parameters are kept in their optimisation form everywhere in the pipeline:
  means [N,3]  scales [N,3] (log)  quats [N,4] (w,x,y,z, unnormalised)  opacities [N] (logit)
  sh0 [N,1,3]  shN [N,K-1,3]  (K = (degree+1)^2)
"""

from __future__ import annotations

import gzip
import math
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

SH_C0 = 0.28209479177387814


@dataclass
class Gaussians:
    means: np.ndarray
    scales: np.ndarray
    quats: np.ndarray
    opacities: np.ndarray
    sh0: np.ndarray
    shN: np.ndarray

    @property
    def count(self) -> int:
        return int(self.means.shape[0])

    @property
    def sh_degree(self) -> int:
        return int(round(math.sqrt(self.shN.shape[1] + 1))) - 1

    @classmethod
    def from_params(cls, params: dict) -> "Gaussians":
        """From the trainer's torch ParameterDict (any device)."""
        get = lambda k: params[k].detach().float().cpu().numpy()  # noqa: E731
        return cls(get("means"), get("scales"), get("quats"), get("opacities"), get("sh0"), get("shN"))

    def subset(self, keep: np.ndarray) -> "Gaussians":
        return Gaussians(*(a[keep] for a in (self.means, self.scales, self.quats, self.opacities, self.sh0, self.shN)))

    def transformed(self, rotation: np.ndarray, translation: np.ndarray, scale: float = 1.0) -> "Gaussians":
        """World transform x' = scale * R x + t. Rotates orientations; SH beyond degree 0 are dropped by callers that rotate."""
        r = np.asarray(rotation, dtype=np.float64)
        means = (scale * (self.means.astype(np.float64) @ r.T) + translation).astype(np.float32)
        q_r = _matrix_to_quat(r)
        quats = _quat_mul(np.broadcast_to(q_r, self.quats.shape), _normalise(self.quats))
        scales = (self.scales + math.log(scale)).astype(np.float32)
        return Gaussians(means, scales, quats.astype(np.float32), self.opacities, self.sh0, self.shN)


# ---------------------------------------------------------------------------------------------------------------
# PLY (the format every Gaussian viewer reads)


def write_ply(path: Path, g: Gaussians) -> None:
    n = g.count
    rest = g.shN.transpose(0, 2, 1).reshape(n, -1)  # channel-major, as the reference 3DGS writer stores it
    names = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"]
    names += [f"f_rest_{i}" for i in range(rest.shape[1])]
    names += ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    data = np.concatenate(
        [
            g.means,
            np.zeros_like(g.means),
            g.sh0.reshape(n, 3),
            rest,
            g.opacities.reshape(n, 1),
            g.scales,
            g.quats,
        ],
        axis=1,
    ).astype("<f4")
    header = "ply\nformat binary_little_endian 1.0\n" f"element vertex {n}\n"
    header += "".join(f"property float {name}\n" for name in names) + "end_header\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(data.tobytes())


def read_ply(path: Path) -> Gaussians:
    from plyfile import PlyData

    v = PlyData.read(str(path))["vertex"]
    names = [p.name for p in v.properties]
    col = lambda k: np.asarray(v[k], dtype=np.float32)  # noqa: E731
    means = np.stack([col("x"), col("y"), col("z")], 1)
    n = means.shape[0]
    sh0 = np.stack([col(f"f_dc_{i}") for i in range(3)], 1).reshape(n, 1, 3)
    rest_names = sorted((k for k in names if k.startswith("f_rest_")), key=lambda k: int(k.split("_")[-1]))
    if rest_names:
        rest = np.stack([col(k) for k in rest_names], 1).reshape(n, 3, -1).transpose(0, 2, 1)
    else:
        rest = np.zeros((n, 0, 3), np.float32)
    return Gaussians(
        means,
        np.stack([col(f"scale_{i}") for i in range(3)], 1),
        np.stack([col(f"rot_{i}") for i in range(4)], 1),
        col("opacity"),
        sh0,
        rest,
    )


def read_points_ply(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """A plain coloured point cloud (x, y, z, red, green, blue), e.g. 4DAnyone's visual-hull init."""
    from plyfile import PlyData

    v = PlyData.read(str(path))["vertex"]
    pts = np.stack([np.asarray(v[k], np.float32) for k in ("x", "y", "z")], 1)
    names = {p.name for p in v.properties}
    if {"red", "green", "blue"} <= names:
        rgb = np.stack([np.asarray(v[k], np.float32) for k in ("red", "green", "blue")], 1) / 255.0
    else:
        rgb = np.full_like(pts, 0.5)
    return pts, rgb


# ---------------------------------------------------------------------------------------------------------------
# SPZ: Niantic's packed Gaussian format (version 2), about 10x smaller than PLY. Spark loads it in the browser.

SPZ_MAGIC = 0x5053474E  # "NGSP"
SPZ_COLOR_SCALE = 0.15


def write_spz(path: Path, g: Gaussians, fractional_bits: int = 12, sh_degree: int | None = None) -> int:
    """Writes SPZ v2 and returns the compressed size in bytes. sh_degree caps the stored SH (0 keeps colour only)."""
    n = g.count
    degree = g.sh_degree if sh_degree is None else min(sh_degree, g.sh_degree)
    k = (degree + 1) ** 2 - 1

    fixed = np.round(g.means.astype(np.float64) * (1 << fractional_bits)).astype(np.int64)
    fixed = np.clip(fixed, -(1 << 23), (1 << 23) - 1) & 0xFFFFFF
    pos = np.stack([(fixed >> s) & 0xFF for s in (0, 8, 16)], axis=-1).astype(np.uint8).reshape(n, 9)

    alpha = _u8(_sigmoid(g.opacities) * 255.0)
    color = _u8(g.sh0.reshape(n, 3) * (SPZ_COLOR_SCALE * 255.0) + 0.5 * 255.0)
    scale = _u8((g.scales + 10.0) * 16.0)
    q = _normalise(g.quats)  # (w, x, y, z)
    q = np.where(q[:, :1] < 0, -q, q)
    rot = _u8(q[:, 1:] * 127.5 + 127.5)
    sh = _u8(np.round(g.shN[:, :k, :].reshape(n, -1) * 128.0) + 128.0) if k > 0 else np.zeros((n, 0), np.uint8)

    header = struct.pack("<IIIBBBB", SPZ_MAGIC, 2, n, degree, fractional_bits, 0, 0)
    body = b"".join(a.tobytes() for a in (pos, alpha, color, scale, rot, sh))
    payload = gzip.compress(header + body, compresslevel=6)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return len(payload)


# ---------------------------------------------------------------------------------------------------------------


def _u8(x: np.ndarray) -> np.ndarray:
    return np.clip(np.round(x), 0, 255).astype(np.uint8)


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def _normalise(q: np.ndarray) -> np.ndarray:
    return q / np.maximum(np.linalg.norm(q, axis=-1, keepdims=True), 1e-12)


def _quat_mul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    aw, ax, ay, az = np.moveaxis(a, -1, 0)
    bw, bx, by, bz = np.moveaxis(b, -1, 0)
    return np.stack(
        [
            aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
        ],
        axis=-1,
    )


def _matrix_to_quat(r: np.ndarray) -> np.ndarray:
    """Rotation matrix -> (w, x, y, z)."""
    m = r
    t = np.trace(m)
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        q = [0.25 * s, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [(m[2, 1] - m[1, 2]) / s, 0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s]
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s]
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s]
    return np.asarray(q, dtype=np.float64)
