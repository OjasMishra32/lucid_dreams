"""Gaussian splats for assemble.py: the 3DGS PLY (read and write any float layout), the export's SPZ colours (the
Reality check's tint), a similarity transform that turns orientations and the degree-1 SH with the world, and what the
bundle bakes from a placed body: bounds, torso and head capsules, floor maps (contact shadow, reflection) and the
splat-depth proxy (a depth mesh of the splats seen from camera F, glTF binary). numpy and OpenCV only.

PLY layout (the reference 3DGS writer's): x y z nx ny nz f_dc_0..2 f_rest_0.. opacity scale_0..2 rot_0..3, rot as
(w, x, y, z), scale as log, opacity as a logit, f_rest channel-major (all of red's coefficients, then green's, ...).
"""

from __future__ import annotations

import gzip
import json
import math
import struct
from pathlib import Path

import cv2
import numpy as np

cv2.setNumThreads(2)  # a shared Mac

from assemble_geom import Cam, Similarity, contact_points, matrix_to_quat  # noqa: E402

C0 = 0.28209479177387814
BLUE = np.array([0.0, 0.44, 0.89])  # the export's tint for what no camera saw (lucid/export.py `tinted`)
SPZ_MAGIC = 0x5053474E
SPZ_COLOR_SCALE = 0.15

PLY_TYPES = {"float": "<f4", "float32": "<f4", "double": "<f8", "float64": "<f8", "uchar": "u1", "uint8": "u1",
             "char": "i1", "int8": "i1", "ushort": "<u2", "uint16": "<u2", "short": "<i2", "int16": "<i2",
             "uint": "<u4", "uint32": "<u4", "int": "<i4", "int32": "<i4"}


def _rest_names(names) -> list[str]:
    return sorted((k for k in names if k.startswith("f_rest_")), key=lambda k: int(k.split("_")[-1]))


class Splats:
    """A PLY's vertex table, every property kept; the 3DGS fields by name."""

    def __init__(self, table: np.ndarray):
        self.table = table

    @classmethod
    def new(cls, pos, quats, scales, opacity, dc, rest=None) -> "Splats":
        n = len(pos)
        rest = np.zeros((n, 0), np.float32) if rest is None else np.asarray(rest, np.float32)
        names = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"]
        names += [f"f_rest_{i}" for i in range(rest.shape[1])]
        names += ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
        cols = np.concatenate([pos, np.zeros((n, 3)), dc, rest, np.reshape(opacity, (n, 1)), scales, quats], 1)
        table = np.empty(n, dtype=[(k, "<f4") for k in names])
        for i, k in enumerate(names):
            table[k] = cols[:, i]
        return cls(table)

    def __len__(self) -> int:
        return len(self.table)

    def __getitem__(self, name: str) -> np.ndarray:
        return self.table[name]

    @property
    def names(self) -> list[str]:
        return list(self.table.dtype.names)

    def _cols(self, names) -> np.ndarray:
        return np.stack([np.asarray(self.table[k], np.float64) for k in names], 1) if names else np.zeros((len(self), 0))

    @property
    def pos(self) -> np.ndarray:
        return self._cols(["x", "y", "z"]).astype(np.float32)

    @property
    def quats(self) -> np.ndarray:
        return self._cols([f"rot_{i}" for i in range(4)]).astype(np.float32)

    @property
    def scales(self) -> np.ndarray:
        return self._cols([f"scale_{i}" for i in range(3)]).astype(np.float32)

    @property
    def opacity(self) -> np.ndarray:
        return np.asarray(self.table["opacity"], np.float32)

    @property
    def alpha(self) -> np.ndarray:
        return 1 / (1 + np.exp(-self.opacity.astype(np.float64)))

    @property
    def dc(self) -> np.ndarray:
        return self._cols([f"f_dc_{i}" for i in range(3)]).astype(np.float32)

    @property
    def rest(self) -> np.ndarray:
        return self._cols(_rest_names(self.names)).astype(np.float32)

    @property
    def rgb(self) -> np.ndarray:
        """Base colour (SH degree 0), 0-1."""
        return np.clip(0.5 + C0 * self.dc, 0, 1)

    def subset(self, keep) -> "Splats":
        return Splats(self.table[keep])

    def with_colour(self, dc, rest) -> "Splats":
        return Splats.new(self.pos, self.quats, self.scales, self.opacity, dc, rest)

    def transformed(self, sim: Similarity) -> "Splats":
        """X' = s M X + t, every Gaussian's axes turned by M, scales by s, the degree-1 SH turned with the world
        (higher bands dropped: the bundle ships SH1)."""
        pos = sim.apply(self.pos.astype(np.float64))
        qm = matrix_to_quat(sim.M)  # (x, y, z, w)
        quats = quat_mul(np.array([qm[3], qm[0], qm[1], qm[2]]), normalise(self.quats.astype(np.float64)))
        scales = self.scales + math.log(sim.s)
        return Splats.new(pos, quats, scales, self.opacity, self.dc, rotate_sh1(self.rest, sim.M))


def normalise(q) -> np.ndarray:
    return q / np.maximum(np.linalg.norm(q, axis=-1, keepdims=True), 1e-12)


def quat_mul(a, b) -> np.ndarray:
    """Hamilton product of (w, x, y, z) quaternions (broadcasts)."""
    aw, ax, ay, az = np.moveaxis(np.broadcast_to(a, np.broadcast(a, b).shape), -1, 0)
    bw, bx, by, bz = np.moveaxis(np.broadcast_to(b, np.broadcast(a, b).shape), -1, 0)
    return np.stack([aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by,
                     aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw], -1)


def rotate_sh1(rest: np.ndarray, M: np.ndarray) -> np.ndarray:
    """Turn the degree-1 band (channel-major f_rest) by the world rotation M; returns 9 coefficients per Gaussian
    (or none for SH0). Band 1's three coefficients weigh (-y, z, -x), so they turn as a vector (lucid/export.py)."""
    n = len(rest)
    if rest.shape[1] == 0:
        return rest
    k = rest.shape[1] // 3
    s = rest.reshape(n, 3, k)[:, :, :3].astype(np.float64)  # [N, channel, coeff]
    v = np.stack([-s[:, :, 2], -s[:, :, 0], s[:, :, 1]], -1)  # [N, channel, xyz]
    v = v @ np.asarray(M, float).T
    out = np.stack([-v[..., 1], v[..., 2], -v[..., 0]], -1)  # [N, channel, coeff]
    return out.reshape(n, 9).astype(np.float32)


# ---------------------------------------------------------------- PLY

def read_ply(path) -> Splats:
    raw = Path(path).read_bytes()
    end = raw.index(b"end_header\n") + len(b"end_header\n")
    lines = raw[:end].decode("ascii").splitlines()
    if lines[0] != "ply" or "binary_little_endian" not in lines[1]:
        raise ValueError(f"{path}: not a binary little-endian PLY")
    n, fields, element = 0, [], None
    for ln in lines[2:]:
        w = ln.split()
        if w[0] == "element":
            element = w[1]
            if element == "vertex":
                n = int(w[2])
        elif w[0] == "property" and element == "vertex":
            if w[1] == "list":
                raise ValueError(f"{path}: list properties in the vertex element")
            fields.append((w[2], PLY_TYPES[w[1]]))
    table = np.frombuffer(raw, dtype=np.dtype(fields), count=n, offset=end).copy()
    return Splats(table)


def write_ply(path, s: Splats) -> None:
    t = s.table
    kinds = {"<f4": "float", "<f8": "double", "|u1": "uchar", "|i1": "char", "<u2": "ushort", "<i2": "short",
             "<u4": "uint", "<i4": "int"}
    header = f"ply\nformat binary_little_endian 1.0\nelement vertex {len(t)}\n"
    header += "".join(f"property {kinds[t.dtype[k].str]} {k}\n" for k in t.dtype.names) + "end_header\n"
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(t.astype(t.dtype.newbyteorder("<")).tobytes())


# ---------------------------------------------------------------- SPZ (the export's colours)

def read_spz_colours(path) -> tuple[np.ndarray, np.ndarray, int]:
    """(positions [N, 3] float, colours [N, 3] uint8, fractional bits) of an SPZ v2/v3 file. Colours sit right after
    positions and alphas in every version from 2 on, so the rotation layout doesn't matter here."""
    raw = gzip.decompress(Path(path).read_bytes())
    magic, version, n, _degree, fb, _flags, _ = struct.unpack_from("<IIIBBBB", raw, 0)
    if magic != SPZ_MAGIC or version not in (2, 3):
        raise ValueError(f"{path}: not an SPZ v2/v3 file")
    off = 16
    pos = np.frombuffer(raw, np.uint8, n * 9, off).reshape(n, 3, 3).astype(np.int64)
    fixed = pos[..., 0] | (pos[..., 1] << 8) | (pos[..., 2] << 16)
    fixed = np.where(fixed & 0x800000, fixed - (1 << 24), fixed)
    off += n * 9 + n
    col = np.frombuffer(raw, np.uint8, n * 3, off).reshape(n, 3)
    return fixed / float(1 << fb), col.copy(), fb


def spz_colour_u8(dc) -> np.ndarray:
    return np.clip(np.round(np.asarray(dc, np.float64) * (SPZ_COLOR_SCALE * 255.0) + 127.5), 0, 255).astype(np.int16)


def seen_from_spz(s: Splats, reality_spz, normal_spz=None, check_positions: bool = True) -> np.ndarray:
    """Which Gaussians the camera saw, read off the export's tint: the reality SPZ (same Gaussians, same order) pulls
    the unseen ones toward blue. Compared with the normal SPZ when there is one, else with the PLY's own colours (base
    colour doesn't change with placement). When the PLY sits in another space than the SPZ (the recon's own world,
    or placed on the court), only the count and the order can be checked."""
    pos, col, fb = read_spz_colours(reality_spz)
    if len(pos) != len(s):
        raise ValueError(f"{reality_spz}: {len(pos)} Gaussians, the PLY has {len(s)}")
    tol = 2.0 / (1 << fb) + 1e-4
    off = np.abs(pos - s.pos.astype(np.float64)).max() if check_positions else 0.0
    if off > tol:
        raise ValueError(f"{reality_spz}: not in the PLY's order (positions differ by up to {off:.4f} m)")
    ref = read_spz_colours(normal_spz)[1].astype(np.int16) if normal_spz else spz_colour_u8(s.dc)
    return np.abs(col.astype(np.int16) - ref).max(1) <= 1


def reality(s: Splats, seen: np.ndarray) -> Splats:
    """The same Gaussians with the unseen ones tinted as the export tints them (no view-dependent colour on those)."""
    dc = s.dc.copy()
    blue = (BLUE - 0.5) / C0
    dc[~seen] = 0.35 * dc[~seen] + 0.65 * blue
    rest = s.rest.copy()
    rest[~seen] = 0
    return s.with_colour(dc, rest)


# ---------------------------------------------------------------- what the bundle bakes from a placed body

def solid(s: Splats, min_alpha: float = 0.5) -> np.ndarray:
    a = s.alpha
    keep = a > min_alpha
    return s.pos[keep] if keep.sum() > 100 else s.pos


def bounds(P) -> dict:
    lo, hi = np.percentile(P, 0.5, 0), np.percentile(P, 99.5, 0)
    lo[1] = max(0.0, lo[1])
    return {"min": np.round(lo, 4).tolist(), "max": np.round(hi, 4).tolist()}


def _median_xz(P) -> np.ndarray:
    return np.median(P[:, [0, 2]], 0)


def body_capsules(P) -> list[dict]:
    """A standing body's torso and head capsules (never arms: P17's proximity fade), from its points (y up, floor at
    0): the hips' vertical axis, the column of points around it (a raised arm stays outside), its top as the head."""
    P = np.asarray(P, float)
    top_all = np.percentile(P[:, 1], 99.5)
    band = P[(P[:, 1] > 0.35 * top_all) & (P[:, 1] < 0.55 * top_all)]
    axis = _median_xz(band if len(band) > 20 else P)
    near = lambda Q, c, r: Q[np.hypot(Q[:, 0] - c[0], Q[:, 2] - c[1]) < r]  # noqa: E731
    col = near(P, axis, 0.28)
    H = float(np.percentile(col[:, 1], 99.5))
    r_head = float(np.clip(0.11 * H / 1.95, 0.09, 0.14))
    head_pts = col[col[:, 1] > H - 0.2]
    head_xz = _median_xz(head_pts) if len(head_pts) > 10 else axis
    lowb = near(P[(P[:, 1] > 0.48 * H) & (P[:, 1] < 0.56 * H)], axis, 0.35)
    highb = near(P[(P[:, 1] > 0.70 * H) & (P[:, 1] < 0.78 * H)], axis, 0.35)
    lo_xz = _median_xz(lowb) if len(lowb) > 10 else axis
    hi_xz = _median_xz(highb) if len(highb) > 10 else axis
    torso = near(P[(P[:, 1] > 0.5 * H) & (P[:, 1] < 0.78 * H)], axis, 0.35)
    spread = np.hypot(torso[:, 0] - axis[0], torso[:, 2] - axis[1]) if len(torso) else np.array([0.15])
    r_torso = float(np.clip(np.percentile(spread, 65), 0.12, 0.22))
    a = [lo_xz[0], 0.5 * H + r_torso * 0.3, lo_xz[1]]
    b = [hi_xz[0], 0.78 * H - r_torso * 0.3, hi_xz[1]]
    h = [head_xz[0], H - r_head, head_xz[1]]
    rnd = lambda v: [round(float(x), 4) for x in v]  # noqa: E731
    return [{"part": "torso", "a": rnd(a), "b": rnd(b), "r": round(r_torso, 4)},
            {"part": "head", "a": rnd(h), "b": rnd(h), "r": round(r_head, 4)}]


def contact_points_xz(P) -> np.ndarray:
    """The soles' centre on the floor, [x, z]."""
    return contact_points(P).mean(0)[[0, 2]]


def floor_rect(P, pad: float = 0.6) -> list[float]:
    lo, hi = np.percentile(P[:, [0, 2]], 1, 0), np.percentile(P[:, [0, 2]], 99, 0)
    return [round(float(lo[0] - pad), 3), round(float(lo[1] - pad), 3), round(float(hi[0] + pad), 3), round(float(hi[1] + pad), 3)]


def floor_size(rect, size: int) -> tuple[int, int]:
    """(width, height) in pixels of a floor map `size` wide on `rect`, with square pixels."""
    x0, z0, x1, z1 = rect
    return size, max(2, int(round(size * (z1 - z0) / (x1 - x0))))


def _splat_floor(P, w, rect, shape, sigma_m) -> np.ndarray:
    x0, z0, x1, z1 = rect
    W, H = shape
    c = np.clip(np.round((P[:, 0] - x0) / (x1 - x0) * (W - 1)), 0, W - 1).astype(int)
    r = np.clip(np.round((P[:, 2] - z0) / (z1 - z0) * (H - 1)), 0, H - 1).astype(int)
    img = np.zeros((H, W))
    np.add.at(img, (r, c), w)
    px = sigma_m / ((x1 - x0) / W)
    return cv2.GaussianBlur(img, (0, 0), max(0.5, px))


def floor_maps(P, alpha, rgb, rect, size: int = 128) -> tuple[np.ndarray, np.ndarray]:
    """(shadow, reflection) RGBA uint8 images laid on `rect` (columns minX -> maxX, rows minZ -> maxZ, square pixels,
    `size` wide): a soft contact shadow from the body's lowest Gaussians, and the body's colour faintly where its
    lower half would reflect."""
    P = np.asarray(P, float)
    shape = floor_size(rect, size)
    y = np.maximum(P[:, 1], 0)
    d = _splat_floor(P, alpha * np.exp(-y / 0.25), rect, shape, 0.05)
    shade = 0.7 * (1 - np.exp(-3 * d / max(d.max(), 1e-9))) / (1 - math.exp(-3))
    shadow = np.zeros((shape[1], shape[0], 4), np.uint8)
    shadow[..., 3] = np.round(255 * shade).astype(np.uint8)
    w = alpha * np.exp(-y / 0.8)
    dens = _splat_floor(P, w, rect, shape, 0.08)
    col = np.stack([_splat_floor(P, w * rgb[:, k], rect, shape, 0.08) for k in range(3)], -1) / np.maximum(dens, 1e-9)[..., None]
    refl = np.zeros((shape[1], shape[0], 4), np.uint8)
    refl[..., :3] = np.round(255 * np.clip(col, 0, 1)).astype(np.uint8)
    refl[..., 3] = np.round(255 * 0.25 * dens / max(dens.max(), 1e-9)).astype(np.uint8)
    return shadow, refl


def write_png(path, img: np.ndarray) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if img.ndim == 3 and img.shape[2] == 4:
        img = cv2.cvtColor(img, cv2.COLOR_RGBA2BGRA)
    elif img.ndim == 3:
        img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    if not cv2.imwrite(str(path), img):
        raise OSError(f"could not write {path}")


# ---------------------------------------------------------------- the splat-depth proxy

def depth_image(P, cam: Cam, nu: int, nv: int, oversample: int = 4, pct: float = 10.0):
    """The body's front depth (z along camera F's axis) over its box in F's image: per cell the `pct` percentile of
    the depths of the splats landing there (a floater in front moves it little), holes filled from neighbours, then
    the body's median depth (the matte hides those cells)."""
    u, v, z = cam.project(np.asarray(P, float))
    ok = z > 0
    u, v, z = u[ok], v[ok], z[ok]
    u0, u1 = np.percentile(u, 0.2), np.percentile(u, 99.8)
    v0, v1 = np.percentile(v, 0.2), np.percentile(v, 99.8)
    mu, mv = 0.03 * (u1 - u0), 0.03 * (v1 - v0)
    box = (u0 - mu, v0 - mv, u1 + mu, v1 + mv)
    W, H = nu * oversample, nv * oversample
    ci = np.clip(((u - box[0]) / (box[2] - box[0]) * W).astype(int), 0, W - 1)
    cj = np.clip(((v - box[1]) / (box[3] - box[1]) * H).astype(int), 0, H - 1)
    cell = cj * W + ci
    order = np.lexsort((z, cell))
    cs, zs = cell[order], z[order]
    starts = np.flatnonzero(np.r_[True, cs[1:] != cs[:-1]])
    counts = np.diff(np.r_[starts, len(cs)])
    pick = starts + np.floor((counts - 1) * pct / 100).astype(int)
    EMPTY = np.float32(1e30)  # OpenCV turns inf into FLT_MAX, so empty cells carry a plain sentinel
    depth = np.full(W * H, EMPTY, np.float32)
    depth[cs[pick]] = zs[pick]
    depth = depth.reshape(H, W)
    for _ in range(oversample):
        grown = cv2.erode(depth, np.ones((3, 3), np.uint8), borderType=cv2.BORDER_REPLICATE)  # min of the neighbours
        depth = np.where(depth < EMPTY, depth, grown)
    depth = np.where(depth < EMPTY, depth, np.float32(np.median(z)))
    return cv2.medianBlur(depth, 5), box


def quat_matrices(q) -> np.ndarray:
    """Rotation matrices of (w, x, y, z) quaternions, (n, 3, 3)."""
    w, x, y, z = np.moveaxis(normalise(np.asarray(q, float)), -1, 0)
    return np.stack([np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], -1),
                     np.stack([2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], -1),
                     np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], -1)], -2)


def texel_of(u, v, box, W: int, H: int):
    """Source pixel (u, v) -> continuous texel coordinates over `box` (pixel edges; texel i's centre is the pixel
    box[0] + (i + 0.5) sx - 0.5, as proxies.ts samples it)."""
    sx, sy = (box[2] - box[0]) / W, (box[3] - box[1]) / H
    return (np.asarray(u) - box[0] + 0.5) / sx - 0.5, (np.asarray(v) - box[1] + 0.5) / sy - 0.5


def bilinear(img: np.ndarray, x, y) -> np.ndarray:
    """img sampled at continuous pixel-centre coordinates (x, y), clamped at the borders."""
    H, W = img.shape
    x, y = np.clip(np.asarray(x, float), 0, W - 1), np.clip(np.asarray(y, float), 0, H - 1)
    x0, y0 = np.minimum(np.floor(x).astype(int), W - 2 if W > 1 else 0), np.minimum(np.floor(y).astype(int), H - 2 if H > 1 else 0)
    x1, y1 = np.minimum(x0 + 1, W - 1), np.minimum(y0 + 1, H - 1)
    fx, fy = x - x0, y - y0
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x1] * fx * (1 - fy) + img[y1, x0] * (1 - fx) * fy + img[y1, x1] * fx * fy)


def ewa(s: Splats, cam: Cam, min_alpha: float = 1 / 255) -> dict:
    """Each Gaussian's footprint through `cam` as a splat renderer projects it (EWA, plus 3DGS's 0.3 px^2 low-pass), in
    source pixels: for the ones in front of the camera with alpha >= min_alpha, their index `i`, centre (u, v), depth
    z, alpha `a` and 2D covariance (A, B, C) = [[A, B], [B, C]]."""
    a = s.alpha
    i = np.flatnonzero(a >= min_alpha)
    t = (s.pos[i].astype(float) - cam.C) @ cam.R  # camera coordinates (R is world-from-camera)
    front = t[:, 2] > 1e-3
    i, t = i[front], t[front]
    M = quat_matrices(s.quats[i]) * np.exp(s.scales[i].astype(float))[:, None, :]
    Sc = np.einsum("ij,njk,kl->nil", cam.R.T, M @ np.swapaxes(M, 1, 2), cam.R)
    tz = t[:, 2]
    J = np.zeros((len(t), 2, 3))
    J[:, 0, 0] = J[:, 1, 1] = cam.f / tz
    J[:, 0, 2] = -cam.f * t[:, 0] / tz ** 2
    J[:, 1, 2] = -cam.f * t[:, 1] / tz ** 2
    S2 = J @ Sc @ np.swapaxes(J, 1, 2) + 0.3 * np.eye(2)
    return {"i": i, "u": cam.cx + cam.f * t[:, 0] / tz, "v": cam.cy + cam.f * t[:, 1] / tz, "z": tz, "a": a[i],
            "A": S2[:, 0, 0], "B": S2[:, 0, 1], "C": S2[:, 1, 1]}


def _footprints(e: dict, box, W: int, H: int, max_r: int, budget: int, sel=None):
    """Per group of Gaussians (index arrays into e), the texels of their footprints over `box` out to 3 sigma: yields
    (g, flat texel index, alpha there) with every sample inside the grid and >= 1/255."""
    sx, sy = (box[2] - box[0]) / W, (box[3] - box[1]) / H
    A, B, C = e["A"] / sx ** 2, e["B"] / (sx * sy), e["C"] / sy ** 2  # texel units
    det = A * C - B * B
    iA, iB, iC = C / det, -B / det, A / det
    tu, tv = texel_of(e["u"], e["v"], box, W, H)
    # out to 3 sigma, or only as far as alpha G stays >= 1/255 for a faint one (nothing past that is ever drawn)
    reach = np.minimum(3.0, np.sqrt(2 * np.log(np.maximum(255 * e["a"], 1.0))))
    r = np.clip(np.ceil(reach * np.sqrt(0.5 * (A + C) + np.sqrt(0.25 * (A - C) ** 2 + B * B))), 1, max_r).astype(int)
    inside = (tu + r >= 0) & (tu - r < W) & (tv + r >= 0) & (tv - r < H)
    if sel is not None:
        inside &= sel
    for rad in np.unique(r[inside]):
        grp = np.flatnonzero(inside & (r == rad))
        dy, dx = np.mgrid[-rad:rad + 1, -rad:rad + 1]
        dx, dy = dx.ravel(), dy.ravel()
        step = max(1, budget // len(dx))
        for k in range(0, len(grp), step):
            g = grp[k:k + step]
            ix = np.rint(tu[g])[:, None].astype(int) + dx
            iy = np.rint(tv[g])[:, None].astype(int) + dy
            ex, ey = ix - tu[g][:, None], iy - tv[g][:, None]
            alpha = np.minimum(0.99, e["a"][g][:, None] * np.exp(-0.5 * (iA[g][:, None] * ex * ex + 2 * iB[g][:, None] * ex * ey + iC[g][:, None] * ey * ey)))
            ok = (ix >= 0) & (ix < W) & (iy >= 0) & (iy < H) & (alpha >= 1 / 255)
            yield np.broadcast_to(g[:, None], ix.shape)[ok], (iy * W + ix)[ok], alpha[ok]


def coverage_image(s: Splats, cam: Cam, box, W: int, H: int, max_r: int = 64, budget: int = 4_000_000) -> np.ndarray:
    """How much of each texel of `box` (W x H over source pixels) the splats cover as a splat renderer composites
    them: 1 - prod(1 - alpha_i G_i) (the order doesn't matter for coverage), each Gaussian's footprint its EWA
    projection through `cam` (ewa), out to 3 sigma (at most max_r texels)."""
    logT = np.zeros(W * H)
    for _, pix, alpha in _footprints(ewa(s, cam), box, W, H, max_r, budget):
        logT += np.bincount(pix, np.log1p(-alpha), minlength=W * H)
    return 1 - np.exp(logT).reshape(H, W)


def render(s: Splats, cam: Cam, max_r: int = 64, budget: int = 4_000_000) -> tuple[np.ndarray, np.ndarray]:
    """A plain CPU splat render through `cam` (its own size): each Gaussian's EWA footprint, base colour (SH degree
    0), composited front to back by depth as 3DGS does (alpha capped at 0.99, under 1/255 skipped). Returns (rgb over
    black, alpha), H x W. For measuring (a cut's cost), not for looks: slow, no view-dependent colour."""
    e = ewa(s, cam)
    rank = np.empty(len(e["z"]), np.int64)
    rank[np.argsort(e["z"], kind="stable")] = np.arange(len(e["z"]))
    rgb = s.rgb[e["i"]].astype(np.float64)
    W, H = cam.w, cam.h
    box = (0.0, 0.0, float(W), float(H))  # texel i is pixel i
    gs, ps, als = [], [], []
    for g, pix, alpha in _footprints(e, box, W, H, max_r, budget):
        gs.append(g.astype(np.int64)), ps.append(pix.astype(np.int64)), als.append(alpha)
    out, acc = np.zeros((W * H, 3)), np.zeros(W * H)
    if gs:
        g, pix, alpha = np.concatenate(gs), np.concatenate(ps), np.concatenate(als)
        order = np.argsort(pix * len(rank) + rank[g])  # by pixel, then front to back (one unique key)
        g, pix, alpha = g[order], pix[order], alpha[order]
        logs = np.log1p(-alpha)
        cs = np.cumsum(logs)
        start = np.r_[True, pix[1:] != pix[:-1]]
        base = np.maximum.accumulate(np.where(start, np.arange(len(pix)), 0))
        before = cs - logs - (cs[base] - logs[base])  # log transmittance in front of each sample, within its pixel
        wgt = np.exp(before) * alpha
        for c in range(3):
            out[:, c] = np.bincount(pix, wgt * rgb[g, c], minlength=W * H)
        acc = np.bincount(pix, wgt, minlength=W * H)
    return out.reshape(H, W, 3), acc.reshape(H, W)


def cap(s: Splats, cam: Cam, n: int) -> np.ndarray:
    """Which Gaussians to keep for a budget of n: the n with the largest contribution seen from `cam`, alpha times
    the area of its projected footprint (pi sqrt(det) of its EWA covariance). All of them when there are n or fewer."""
    if len(s) <= n:
        return np.ones(len(s), bool)
    e = ewa(s, cam, min_alpha=0.0)
    score = np.zeros(len(s))
    score[e["i"]] = e["a"] * np.pi * np.sqrt(np.maximum(e["A"] * e["C"] - e["B"] ** 2, 0))
    keep = np.zeros(len(s), bool)
    keep[np.argsort(-score, kind="stable")[:n]] = True
    return keep


def proxy_mesh(s: Splats, cam: Cam, cell_m: float = 0.004, cover: float = 0.5, depth_cells: int = 4, pct: float = 10.0):
    """The splat-depth proxy seen from `cam` (camera F): a grid of square texels about cell_m wide at the body's
    depth over the body's box in F's image; a texel is meshed (two triangles) only where the splats cover at least
    `cover` of it (coverage_image), so the mesh's outline is the splats' own silhouette to a texel and there is no
    mesh where there is no body. Every vertex lies on F's ray through its texel corner, at the body's front depth
    there: per block of depth_cells^2 texels the pct percentile of the solid splats' depths (a floater in front moves
    it little), empty blocks filled from their neighbours, median-filtered, sampled bilinearly. Returns (positions in
    court space, triangle indices, info)."""
    import cv2

    keep = s.alpha > 0.3
    keep = keep if keep.sum() > 100 else np.ones(len(s), bool)
    u, v, z = cam.project(s.pos[keep].astype(float))
    ok = z > 0
    u, v, z = u[ok], v[ok], z[ok]
    zm = float(np.median(z))
    cell_px = cam.f * cell_m / zm
    margin = 0.06 * cam.f / zm  # 6 cm past the solid splats' centres: room for their own width
    u0, u1 = np.percentile(u, 0.05) - margin, np.percentile(u, 99.95) + margin
    v0, v1 = np.percentile(v, 0.05) - margin, np.percentile(v, 99.95) + margin
    W, H = int(np.ceil((u1 - u0) / cell_px)), int(np.ceil((v1 - v0) / cell_px))
    box = (u0, v0, u0 + W * cell_px, v0 + H * cell_px)
    on = coverage_image(s, cam, box, W, H) >= cover
    # the front depth on coarse blocks
    Wd, Hd = -(-W // depth_cells), -(-H // depth_cells)
    tu, tv = texel_of(u, v, box, W, H)
    ci = np.clip(np.rint(tu).astype(int) // depth_cells, 0, Wd - 1)
    cj = np.clip(np.rint(tv).astype(int) // depth_cells, 0, Hd - 1)
    cell = cj * Wd + ci
    order = np.lexsort((z, cell))
    cs, zs = cell[order], z[order]
    starts = np.flatnonzero(np.r_[True, cs[1:] != cs[:-1]])
    counts = np.diff(np.r_[starts, len(cs)])
    pick = starts + np.floor((counts - 1) * pct / 100).astype(int)
    EMPTY = np.float32(1e30)  # OpenCV turns inf into FLT_MAX, so empty cells carry a plain sentinel
    depth = np.full(Wd * Hd, EMPTY, np.float32)
    depth[cs[pick]] = zs[pick]
    depth = depth.reshape(Hd, Wd)
    for _ in range(max(Wd, Hd)):
        if not (depth >= EMPTY).any():
            break
        grown = cv2.erode(depth, np.ones((3, 3), np.uint8), borderType=cv2.BORDER_REPLICATE)  # min of the neighbours
        depth = np.where(depth < EMPTY, depth, grown)
    depth = cv2.medianBlur(depth, 5) if min(Wd, Hd) >= 5 else depth
    # the mesh: corners of meshed texels, each on its ray at the bilinear block depth
    jj, ii = np.nonzero(on)
    corners = np.unique(np.concatenate([jj * (W + 1) + ii, jj * (W + 1) + ii + 1, (jj + 1) * (W + 1) + ii, (jj + 1) * (W + 1) + ii + 1]))
    cy_, cx_ = corners // (W + 1), corners % (W + 1)
    Z = bilinear(depth.astype(np.float64), cx_ / depth_cells - 0.5, cy_ / depth_cells - 0.5)  # corner -> block coordinates
    U = box[0] + cx_ * cell_px - 0.5
    V = box[1] + cy_ * cell_px - 0.5
    pos = (np.stack([(U - cam.cx) / cam.f * Z, (V - cam.cy) / cam.f * Z, Z], -1) @ cam.R.T + cam.C).astype(np.float32)
    a, b, c, d = (np.searchsorted(corners, k) for k in (jj * (W + 1) + ii, jj * (W + 1) + ii + 1, (jj + 1) * (W + 1) + ii, (jj + 1) * (W + 1) + ii + 1))
    idx = np.stack([a, c, b, b, c, d], 1).ravel()
    info = {"cellM": round(cell_px * zm / cam.f, 5), "cellPx": round(cell_px, 3), "texels": [W, H], "meshed": int(on.sum()),
            "vertices": len(pos), "triangles": len(idx) // 3, "depthM": round(zm, 3)}
    return pos, idx, info


def proxy_glb(s: Splats, cam: Cam, cell_m: float = 0.004, name: str = "proxy") -> tuple[bytes, dict]:
    """proxy_mesh as a GLB (and its info)."""
    pos, idx, info = proxy_mesh(s, cam, cell_m)
    return glb(pos, idx, name), info


def glb(pos: np.ndarray, idx: np.ndarray, name: str) -> bytes:
    pos = np.ascontiguousarray(pos, np.float32)
    big = len(pos) > 65535
    idx = np.ascontiguousarray(idx, np.uint32 if big else np.uint16)
    bin_ = pos.tobytes() + idx.tobytes()
    js = {
        "asset": {"version": "2.0", "generator": "court-side assemble.py"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": name}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1}]}],
        "buffers": [{"byteLength": len(bin_)}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": pos.nbytes, "target": 34962},
                        {"buffer": 0, "byteOffset": pos.nbytes, "byteLength": idx.nbytes, "target": 34963}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": len(pos), "type": "VEC3",
                       "min": pos.min(0).tolist(), "max": pos.max(0).tolist()},
                      {"bufferView": 1, "componentType": 5125 if big else 5123, "count": len(idx), "type": "SCALAR"}],
    }
    jb = json.dumps(js, separators=(",", ":")).encode()
    jb += b" " * ((4 - len(jb) % 4) % 4)
    bin_ += b"\0" * ((4 - len(bin_) % 4) % 4)
    total = 12 + 8 + len(jb) + 8 + len(bin_)
    return (struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(jb), 0x4E4F534A) + jb
            + struct.pack("<II", len(bin_), 0x004E4942) + bin_)


def read_glb(data: bytes) -> tuple[np.ndarray, np.ndarray]:
    """(positions, indices) of a one-mesh GLB as glb() writes it."""
    magic, _, _ = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise ValueError("not a GLB")
    jlen, _ = struct.unpack_from("<II", data, 12)
    js = json.loads(data[20:20 + jlen])
    blen, _ = struct.unpack_from("<II", data, 20 + jlen)
    b = data[28 + jlen:28 + jlen + blen]
    prim = js["meshes"][0]["primitives"][0]

    def acc(i):
        a = js["accessors"][i]
        bv = js["bufferViews"][a["bufferView"]]
        dt = {5126: np.float32, 5123: np.uint16, 5125: np.uint32}[a["componentType"]]
        k = {"VEC3": 3, "SCALAR": 1}[a["type"]]
        arr = np.frombuffer(b, dt, a["count"] * k, bv.get("byteOffset", 0))
        return arr.reshape(-1, 3) if k == 3 else arr

    return acc(prim["attributes"]["POSITION"]), acc(prim["indices"])
