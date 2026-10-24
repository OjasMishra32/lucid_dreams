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
