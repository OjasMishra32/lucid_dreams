"""Colour for Court Side's hand-off: sRGB <-> linear <-> CIELAB (D65), CIEDE2000, a robust affine fit in linear RGB
(3x3 + offset), and that fit applied to splats' base colours. Plain numpy."""

from __future__ import annotations

import numpy as np

from assemble_splats import C0, Splats

WHITE = np.array([0.95047, 1.0, 1.08883])  # D65
SRGB_TO_XYZ = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])


def srgb_to_linear(x) -> np.ndarray:
    x = np.asarray(x, float)
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(x) -> np.ndarray:
    x = np.asarray(x, float)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.maximum(x, 0) ** (1 / 2.4) - 0.055)


def srgb_to_lab(x) -> np.ndarray:
    """sRGB 0-1, (..., 3) -> CIELAB (D65)."""
    xyz = srgb_to_linear(x) @ SRGB_TO_XYZ.T / WHITE
    f = np.where(xyz > (6 / 29) ** 3, np.cbrt(xyz), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def delta_e2000(lab1, lab2) -> np.ndarray:
    """CIEDE2000 between two (..., 3) CIELAB arrays (kL = kC = kH = 1)."""
    L1, a1, b1 = np.moveaxis(np.asarray(lab1, float), -1, 0)
    L2, a2, b2 = np.moveaxis(np.asarray(lab2, float), -1, 0)
    cbar = (np.hypot(a1, b1) + np.hypot(a2, b2)) / 2
    g = 0.5 * (1 - np.sqrt(cbar ** 7 / (cbar ** 7 + 25.0 ** 7)))
    a1p, a2p = (1 + g) * a1, (1 + g) * a2
    c1p, c2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360
    zero = (c1p * c2p) == 0
    dh = h2p - h1p
    dh = np.where(dh > 180, dh - 360, np.where(dh < -180, dh + 360, dh))
    dh = np.where(zero, 0.0, dh)
    dL, dC = L2 - L1, c2p - c1p
    dH = 2 * np.sqrt(c1p * c2p) * np.sin(np.radians(dh / 2))
    Lb, Cb = (L1 + L2) / 2, (c1p + c2p) / 2
    hs = h1p + h2p
    hb = np.where(zero, hs, np.where(np.abs(h1p - h2p) <= 180, hs / 2, np.where(hs < 360, (hs + 360) / 2, (hs - 360) / 2)))
    T = (1 - 0.17 * np.cos(np.radians(hb - 30)) + 0.24 * np.cos(np.radians(2 * hb)) + 0.32 * np.cos(np.radians(3 * hb + 6))
         - 0.20 * np.cos(np.radians(4 * hb - 63)))
    dtheta = 30 * np.exp(-(((hb - 275) / 25) ** 2))
    rc = 2 * np.sqrt(Cb ** 7 / (Cb ** 7 + 25.0 ** 7))
    sl = 1 + 0.015 * (Lb - 50) ** 2 / np.sqrt(20 + (Lb - 50) ** 2)
    sc, sh = 1 + 0.045 * Cb, 1 + 0.015 * Cb * T
    rt = -np.sin(np.radians(2 * dtheta)) * rc
    return np.sqrt((dL / sl) ** 2 + (dC / sc) ** 2 + (dH / sh) ** 2 + rt * (dC / sc) * (dH / sh))


def fit_affine(src, dst, keep: float = 0.9, rounds: int = 3) -> tuple[np.ndarray, np.ndarray]:
    """dst ~ M src + b by least squares over (N, 3) pairs, refitted `rounds` times on the `keep` share with the
    smallest residuals (what isn't the body's own colour, a ball or a hand over it, drops out). Returns (M, b)."""
    src, dst = np.asarray(src, float), np.asarray(dst, float)
    use = np.ones(len(src), bool)
    for _ in range(rounds):
        X = np.c_[src[use], np.ones(use.sum())]
        sol, *_ = np.linalg.lstsq(X, dst[use], rcond=None)
        res = np.linalg.norm(np.c_[src, np.ones(len(src))] @ sol - dst, axis=1)
        use = res <= np.quantile(res, keep)
    return sol[:3].T, sol[3]


def recolour(s: Splats, M, b) -> Splats:
    """The splats with each base colour (SH degree 0) taken through x -> M x + b in linear RGB; the view-dependent
    bands are left as they were."""
    c = linear_to_srgb(np.clip(srgb_to_linear(s.rgb) @ np.asarray(M, float).T + np.asarray(b, float), 0, 1))
    return s.with_colour(((c - 0.5) / C0).astype(np.float32), s.rest)
