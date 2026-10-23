"""Read and write the standard 3D Gaussian Splatting PLY (the layout the INRIA code and Unity importers use).

Values are stored the way 3DGS stores them: opacity as a logit, scale as log, rotation as a
quaternion [w, x, y, z] in rot_0..3, f_rest grouped by colour channel.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

SH_C0 = 0.28209479177387814  # degree-0 spherical harmonic: colour = 0.5 + SH_C0 * f_dc

REQUIRED_PROPS = [
    "x", "y", "z",
    "f_dc_0", "f_dc_1", "f_dc_2",
    "opacity",
    "scale_0", "scale_1", "scale_2",
    "rot_0", "rot_1", "rot_2", "rot_3",
]


@dataclass
class Gaussians:
    xyz: np.ndarray       # (N, 3)
    f_dc: np.ndarray      # (N, 3)
    f_rest: np.ndarray    # (N, 0 | 9 | 24 | 45)
    opacity: np.ndarray   # (N,)
    scale: np.ndarray     # (N, 3)
    rotation: np.ndarray  # (N, 4)

    def __len__(self) -> int:
        return len(self.xyz)

    @property
    def sh_degree(self) -> int:
        coeffs = self.f_rest.shape[1] // 3 + 1
        degree = round(coeffs ** 0.5) - 1
        if (degree + 1) ** 2 != coeffs or self.f_rest.shape[1] % 3:
            raise ValueError(f"f_rest has {self.f_rest.shape[1]} columns, not a whole SH degree")
        return degree


def _dtype(n_rest: int) -> np.dtype:
    names = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"]
    names += [f"f_rest_{i}" for i in range(n_rest)]
    names += ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    return np.dtype([(name, "<f4") for name in names])


def write_ply(path: str | Path, g: Gaussians) -> None:
    _ = g.sh_degree  # validates f_rest width
    n, n_rest = len(g), g.f_rest.shape[1]
    data = np.zeros(n, dtype=_dtype(n_rest))
    for i, axis in enumerate("xyz"):
        data[axis] = g.xyz[:, i]
    for i in range(3):
        data[f"f_dc_{i}"] = g.f_dc[:, i]
        data[f"scale_{i}"] = g.scale[:, i]
    for i in range(n_rest):
        data[f"f_rest_{i}"] = g.f_rest[:, i]
    for i in range(4):
        data[f"rot_{i}"] = g.rotation[:, i]
    data["opacity"] = g.opacity.reshape(n)
    header = "ply\nformat binary_little_endian 1.0\n" f"element vertex {n}\n"
    header += "".join(f"property float {name}\n" for name in data.dtype.names)
    header += "end_header\n"
    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(data.tobytes())


def read_header(path: str | Path) -> tuple[str, int, list[tuple[str, str]], int]:
    """(format, vertex count, [(type, name)], header byte length) of a PLY file."""
    with open(path, "rb") as f:
        raw = f.read(64 * 1024)
    end = raw.find(b"end_header\n")
    if not raw.startswith(b"ply\n") or end < 0:
        raise ValueError(f"{path}: not a PLY file")
    fmt, count, props = "", -1, []
    in_vertex = False
    for line in raw[:end].decode("ascii", "replace").splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "format":
            fmt = parts[1]
        elif parts[0] == "element":
            in_vertex = parts[1] == "vertex"
            if in_vertex:
                count = int(parts[2])
        elif parts[0] == "property" and in_vertex:
            props.append((parts[1], parts[-1]))
    return fmt, count, props, end + len(b"end_header\n")


def header_errors(path: str | Path) -> list[str]:
    """Why a file isn't a Gaussian PLY we can load; empty means fine."""
    try:
        fmt, count, props, offset = read_header(path)
    except (OSError, ValueError) as e:
        return [str(e)]
    errors = []
    if fmt != "binary_little_endian":
        errors.append(f"format is {fmt!r}, expected binary_little_endian")
    if count <= 0:
        errors.append("no vertices")
    names = {name for _, name in props}
    missing = [p for p in REQUIRED_PROPS if p not in names]
    if missing:
        errors.append("missing properties: " + ", ".join(missing))
    if any(t != "float" for t, _ in props):
        errors.append("all properties must be float")
    elif not errors:
        expected = offset + count * 4 * len(props)
        actual = Path(path).stat().st_size
        if actual != expected:
            errors.append(f"file size is {actual} bytes, header implies {expected} (truncated or padded)")
    return errors


def read_ply(path: str | Path) -> Gaussians:
    errors = header_errors(path)
    if errors:
        raise ValueError(f"{path}: " + "; ".join(errors))
    _, count, props, offset = read_header(path)
    data = np.fromfile(path, dtype=np.dtype([(name, "<f4") for _, name in props]), count=count, offset=offset)
    n_rest = sum(name.startswith("f_rest_") for _, name in props)
    col = lambda names: np.stack([data[n] for n in names], axis=-1).astype(np.float64)
    return Gaussians(
        xyz=col(["x", "y", "z"]),
        f_dc=col([f"f_dc_{i}" for i in range(3)]),
        f_rest=col([f"f_rest_{i}" for i in range(n_rest)]) if n_rest else np.zeros((count, 0)),
        opacity=data["opacity"].astype(np.float64),
        scale=col([f"scale_{i}" for i in range(3)]),
        rotation=col([f"rot_{i}" for i in range(4)]),
    )
