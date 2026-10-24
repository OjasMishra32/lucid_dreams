import sys
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("scipy")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lhmpp_cleanup as C  # noqa: E402


def _cloth(rng, n=1500):
    """A 20 x 20 cm patch: a dark jacket with noise on the left, a white shirt on the right."""
    xyz = np.c_[rng.uniform(-0.1, 0.1, n), rng.uniform(0, 0.2, n), np.zeros(n)]
    jacket = xyz[:, 0] < 0
    rgb = np.where(jacket[:, None], [0.12, 0.12, 0.14], [0.92, 0.92, 0.9]) + rng.normal(0, 0.03, (n, 3))
    return xyz, np.clip(rgb, 0, 1), jacket


def test_bilateral_evens_a_fabric_and_keeps_its_edge():
    rng = np.random.default_rng(0)
    xyz, rgb, jacket = _cloth(rng)
    out = C.bilateral_colours(xyz, rgb, passes=4)
    assert out[jacket].std(0).max() < 0.5 * rgb[jacket].std(0).max()  # less mottled
    assert out[~jacket].mean() > 0.85 and out[jacket].mean() < 0.2  # the shirt didn't bleed into the jacket
    assert np.allclose(C.bilateral_colours(xyz, rgb, passes=0), rgb)


def test_even_brightness_touches_only_the_main_fabric():
    rng = np.random.default_rng(1)
    xyz, rgb, jacket = _cloth(rng)
    rgb[jacket & (xyz[:, 1] > 0.1)] *= 1.6  # a light patch on the upper jacket
    part = jacket | (xyz[:, 0] < 0.02)  # the jacket and a strip of shirt by its edge
    out, n = C.even_brightness(xyz, rgb, part, f=1.0)
    lum = out @ C.LUM
    top, bottom = jacket & (xyz[:, 1] > 0.12), jacket & (xyz[:, 1] < 0.08)
    assert abs(lum[top].mean() - lum[bottom].mean()) < 0.5 * abs((rgb @ C.LUM)[top].mean() - (rgb @ C.LUM)[bottom].mean())
    assert np.allclose(out[~jacket], rgb[~jacket])  # the shirt isn't the main fabric
    assert 0 < n <= jacket.sum()


def _flat_hand():
    """A left hand in the rest pose (palm down, fingers along +X): four fingers side by side as cylinders 8 mm in
    radius, their axes 17 mm apart (1 mm gaps), and a short thumb; returns the surface points with outward normals
    (the hand's own vertices too) and a skeleton with the hand's joints."""
    joints = np.zeros((55, 3))
    joints[C.J["left_wrist"]] = [0.0, 0.0, 0.0]
    pts, nrm = [], []
    for k, (f, z) in enumerate((("index", 0.0255), ("middle", 0.0085), ("ring", -0.0085), ("pinky", -0.0255), ("thumb", 0.06))):
        x0 = 0.04 if f != "thumb" else 0.01
        for i in (1, 2, 3):
            joints[C.J[f"left_{f}{i}"]] = [x0 + 0.025 * (i - 1), 0.0, z]
        for x in np.arange(x0 - 0.01, x0 + 0.075, 0.0015):
            for th in np.linspace(0, 2 * np.pi, 48, endpoint=False):
                n = np.array([0.0, np.sin(th), np.cos(th)])
                pts.append([x, 0.0, z] + 0.008 * n)
                nrm.append(n)
    return np.array(pts), np.array(nrm), joints


def test_hand_shading_parts_the_fingers_and_finds_the_nails():
    p, n, joints = _flat_hand()
    shade, nail, palm = C.hand_shading(p, n, p, joints, "left", mottle_amp=0.035)
    middle = np.abs(p[:, 2] - 0.0085) < 0.009
    facing_ring = middle & (n[:, 2] < -0.9)  # the middle finger's side next to the ring finger
    top = middle & (n[:, 1] > 0.9)
    assert np.median(shade[facing_ring]) < 0.8 * np.median(shade[top])  # a dark line between the fingers
    fingers = p[:, 2] < 0.04  # the thumb's nail faces partly sideways
    assert (nail & fingers).any() and (n[nail & fingers, 1] > 0.5).all()  # nails on the backs of the fingertips only
    assert p[nail & middle, 0].min() > joints[C.J["left_middle3"], 0]
    assert palm.any() and (n[palm, 1] < -0.3).all()
    assert 0.4 < shade.min() and shade.max() < 1.2
