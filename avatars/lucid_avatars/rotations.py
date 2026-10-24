"""Axis-angle and quaternion helpers. Quaternions are [x, y, z, w], as in motion.json."""

import numpy as np

_EPS = 1e-12


def aa_to_quat(aa: np.ndarray) -> np.ndarray:
    """Axis-angle (..., 3) to unit quaternion (..., 4)."""
    aa = np.asarray(aa, dtype=np.float64)
    angle = np.linalg.norm(aa, axis=-1, keepdims=True)
    half = 0.5 * angle
    # sin(a/2)/a, with its limit 1/2 at a = 0
    k = np.where(angle > _EPS, np.sin(half) / np.maximum(angle, _EPS), 0.5)
    return np.concatenate([aa * k, np.cos(half)], axis=-1)


def quat_to_aa(q: np.ndarray) -> np.ndarray:
    """Unit quaternion (..., 4) to axis-angle (..., 3)."""
    q = np.asarray(q, dtype=np.float64)
    v, w = q[..., :3], q[..., 3:]
    s = np.linalg.norm(v, axis=-1, keepdims=True)
    angle = 2.0 * np.arctan2(s, w)
    k = np.where(s > _EPS, angle / np.maximum(s, _EPS), 2.0)
    return v * k


def quat_mul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Hamilton product a * b (apply b, then a)."""
    ax, ay, az, aw = np.moveaxis(np.asarray(a, dtype=np.float64), -1, 0)
    bx, by, bz, bw = np.moveaxis(np.asarray(b, dtype=np.float64), -1, 0)
    return np.stack([
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ], axis=-1)


def yaw_quat(angle: float) -> np.ndarray:
    """Rotation about +Y."""
    return aa_to_quat(np.array([0.0, angle, 0.0]))


def rotate_by_quat(q: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Rotate vectors v (..., 3) by unit quaternion q (4,)."""
    q = np.asarray(q, dtype=np.float64)
    u, w = q[:3], q[3]
    v = np.asarray(v, dtype=np.float64)
    t = 2.0 * np.cross(u, v)
    return v + w * t + np.cross(u, t)


def quat_to_matrix(q: np.ndarray) -> np.ndarray:
    """Unit quaternion (..., 4) to rotation matrix (..., 3, 3)."""
    x, y, z, w = np.moveaxis(np.asarray(q, dtype=np.float64), -1, 0)
    return np.stack([
        np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], axis=-1),
        np.stack([2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], axis=-1),
        np.stack([2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], axis=-1),
    ], axis=-2)


def matrix_to_quat(R: np.ndarray) -> np.ndarray:
    """Rotation matrix (3, 3) to unit quaternion [x, y, z, w] (Shepperd: branch on the largest component)."""
    R = np.asarray(R, dtype=np.float64)
    tr = np.trace(R)
    if tr > 0:
        s = 2 * np.sqrt(1 + tr)
        q = [(R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s, s / 4]
    else:
        i = int(np.argmax(np.diag(R)))
        j, k = (i + 1) % 3, (i + 2) % 3
        s = 2 * np.sqrt(1 + R[i, i] - R[j, j] - R[k, k])
        q = [0.0, 0.0, 0.0, (R[k, j] - R[j, k]) / s]
        q[i], q[j], q[k] = s / 4, (R[j, i] + R[i, j]) / s, (R[k, i] + R[i, k]) / s
    q = np.asarray(q)
    return q / np.linalg.norm(q)
