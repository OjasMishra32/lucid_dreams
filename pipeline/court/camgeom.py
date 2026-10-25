"""Shared camera maths for the court-calibration spike (tripod camera, pinhole + one radial term).

Conventions used by every file in this folder:
  world  : metres. Origin = centre court on the floor. x along the length (+x = the play's basket),
           y up, z across the court (the camera's own sideline is z < 0, called "near"). Right-handed.
  camera : OpenCV axes (x right, y down, z forward).  x_cam = R (X - C).
  lens   : xn = x_cam / z;  xd = xn (1 + k1 |xn|^2);  u = f xd + cx;  v = f yd + cy.
           Square pixels, principal point at the image centre: cx = (W-1)/2, cy = (H-1)/2
           (pixel centres at integer coordinates).
"""
import numpy as np
from scipy.spatial.transform import Rotation

UP = np.array([0.0, 1.0, 0.0])


def principal(w, h):
    return (w - 1) / 2.0, (h - 1) / 2.0


def K_matrix(f, w, h):
    cx, cy = principal(w, h)
    return np.array([[f, 0, cx], [0, f, cy], [0, 0, 1.0]])


def project(X, R, C, f, k1, cx, cy):
    """World points X (...,3) -> (u, v, z_cam). R may be (3,3) or per-point (...,3,3); f, k1 broadcast.

    z_cam is returned negative for points the lens cannot see: behind the camera, or beyond the radius where
    xn (1 + k1 r^2) stops being monotonic (with k1 < 0 the polynomial folds far-off-axis points back into the
    frame). Callers treat z <= 0 as "not visible"."""
    Xc = np.einsum("...ij,...j->...i", R, X - C)
    z = Xc[..., 2]
    zs = np.where(np.abs(z) < 1e-9, 1e-9, z)
    xn, yn = Xc[..., 0] / zs, Xc[..., 1] / zs
    r2 = xn * xn + yn * yn
    s = 1.0 + k1 * r2
    r2max = np.where(np.asarray(k1) < 0, -0.8 / (3 * np.minimum(k1, -1e-12)), 4.0)
    z = np.where(r2 < np.minimum(r2max, 4.0), z, -np.abs(z) - 1.0)
    return f * xn * s + cx, f * yn * s + cy, z


def undistort_norm(xd, yd, k1, iters=8):
    """Invert xd = xn (1 + k1 r^2) by Newton steps on the radius. NaN where no inverse exists (past the fold of a
    barrel lens: r_d > 2/3 sqrt(-1/(3 k1)))."""
    rd = np.hypot(xd, yd)
    r = rd.copy()
    for _ in range(iters):
        dg = 1.0 + 3.0 * k1 * r * r
        r = r - (r + k1 * r ** 3 - rd) / np.where(np.abs(dg) > 1e-6, dg, 1e-6)
    bad = ~np.isfinite(r) | (1.0 + 3.0 * k1 * r * r <= 0) | (np.abs(r + k1 * r ** 3 - rd) > 1e-6 * (1 + rd))
    s = np.where(rd > 1e-12, r / np.maximum(rd, 1e-12), 1.0)
    s = np.where(bad, np.nan, s)
    return xd * s, yd * s


def pixel_rays(u, v, R, f, k1, cx, cy):
    """Pixels -> unit world ray directions from the camera centre."""
    xn, yn = undistort_norm((u - cx) / f, (v - cy) / f, k1)
    d = np.stack([xn, yn, np.ones_like(xn)], -1)
    d = np.einsum("...ji,...j->...i", R, d)  # R^T d
    return d / np.linalg.norm(d, axis=-1, keepdims=True)


def ray_floor(C, d, y0=0.0):
    """Intersect rays C + s d with the plane y = y0. Returns points (...,3) and a validity mask."""
    C = np.asarray(C, float)
    dy = d[..., 1]
    ok = np.where(C[..., 1] > y0, dy < -1e-9, dy > 1e-9)
    s = np.where(ok, (y0 - C[..., 1]) / np.where(ok, dy, -1.0), np.nan)
    return C + s[..., None] * d, ok


def ray_plane(C, d, p0, n):
    """Intersect rays with the plane through p0 with normal n."""
    den = d @ n
    ok = np.abs(den) > 1e-9
    s = np.where(ok, ((p0 - C) @ n) / np.where(ok, den, 1.0), np.nan)
    ok &= s > 0
    return C + s[..., None] * d, ok


def rot_from_dir(forward, roll=0.0):
    """World->camera rotation looking along `forward` with the horizon level, then rolled (rad)."""
    fwd = np.asarray(forward, float)
    fwd = fwd / np.linalg.norm(fwd)
    right = np.cross(fwd, UP)
    right /= np.linalg.norm(right)
    down = np.cross(fwd, right)
    R = np.stack([right, down, fwd])
    if roll:
        c, s = np.cos(roll), np.sin(roll)
        R = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1.0]]) @ R
    return R


def dir_from_yaw_pitch(yaw, pitch):
    """yaw about +y measured from +z toward +x, pitch up from the horizon (rad)."""
    return np.array([np.sin(yaw) * np.cos(pitch), np.sin(pitch), np.cos(yaw) * np.cos(pitch)])


def yaw_pitch_of(d):
    d = np.asarray(d, float) / np.linalg.norm(d)
    return np.arctan2(d[0], d[2]), np.arcsin(np.clip(d[1], -1, 1))


def rot_angle_deg(Ra, Rb):
    """Angle of Ra Rb^T in degrees (works on stacks)."""
    M = np.einsum("...ij,...kj->...ik", Ra, Rb)
    c = (np.trace(M, axis1=-2, axis2=-1) - 1) / 2
    return np.degrees(np.arccos(np.clip(c, -1, 1)))


def mean_rotation(Rs):
    return Rotation.from_matrix(np.asarray(Rs)).mean().as_matrix()
