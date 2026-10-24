import json

import numpy as np
import pytest

from lucid_avatars import finetune_io as F


def _rig(views=6, w=704, h=1280):
    K = np.tile(np.array([[900.0, 0, w / 2], [0, 900.0, h / 2], [0, 0, 1]]), (views, 1, 1))
    c2w = np.tile(np.eye(4), (views, 1, 1))
    for v in range(views):
        a = 2 * np.pi * v / views
        c2w[v, :3, 3] = [3 * np.sin(a), 1.0, 3 * np.cos(a)]
    return K, c2w


def test_digs_cameras_pack_intrinsics_then_row_major_world_to_camera():
    K, c2w = _rig()
    cams = F.digs_cameras(K, c2w, 704, 1280)
    assert cams.shape == (6, 20) and cams.dtype == np.float32
    np.testing.assert_allclose(cams[:, :4], [[900, 900, 352, 640]] * 6)
    np.testing.assert_allclose(cams[2, 4:].reshape(4, 4), np.linalg.inv(c2w[2]), atol=1e-5)


def test_digs_cameras_refuse_an_off_centre_principal_point():
    K, c2w = _rig()
    K[3, 0, 2] += 7
    with pytest.raises(ValueError, match="principal point"):
        F.digs_cameras(K, c2w, 704, 1280)


def test_holdout_views_are_spread_round_the_ring_and_disjoint():
    train, held = F.split_views(48, 4)
    assert held == [0, 12, 24, 36]
    assert sorted(train + held) == list(range(48)) and not set(train) & set(held)
    with pytest.raises(ValueError):
        F.split_views(4, 4)


def test_spread_frames_covers_the_clip_evenly():
    assert F.spread_frames(121, 5) == [0, 30, 60, 90, 120]
    assert F.spread_frames(3, 8) == [0, 1, 2]


def test_on_white_composites_rgba():
    rgba = np.zeros((2, 2, 4), dtype=np.uint8)
    rgba[0, 0] = [200, 100, 0, 255]
    rgba[0, 1] = [200, 100, 0, 0]
    rgb, alpha = F.on_white(rgba)
    np.testing.assert_allclose(rgb[0, 0], np.array([200, 100, 0]) / 255)
    np.testing.assert_allclose(rgb[0, 1], [1, 1, 1])
    assert alpha.shape == (2, 2) and alpha[0, 0] == 1 and alpha[0, 1] == 0


def test_results_table_and_json(tmp_path):
    before = {"psnr": 21.0, "ssim": 0.81, "lpips": 0.21}
    after = {"psnr": 24.5, "ssim": 0.88, "lpips": 0.14}
    path = tmp_path / "results.json"
    F.write_results(path, before, after, {"heldOutViews": [0, 12], "frames": [0, 60]})
    data = json.loads(path.read_text())
    assert data["before"] == before and data["after"] == after
    assert data["delta"] == pytest.approx({"psnr": 3.5, "ssim": 0.07, "lpips": -0.07})
    table = F.results_markdown(before, after)
    assert "| PSNR (dB) | 21.00 | 24.50 | +3.50 |" in table
    assert "| LPIPS (lower is better) | 0.210 | 0.140 | -0.070 |" in table


def test_results_table_has_person_crop_rows_when_present():
    before = {"psnr": 30.0, "ssim": 0.95, "lpips": 0.05, "psnrPerson": 19.0, "ssimPerson": 0.7, "lpipsPerson": 0.3}
    after = {"psnr": 31.0, "ssim": 0.96, "lpips": 0.04, "psnrPerson": 22.0, "ssimPerson": 0.8, "lpipsPerson": 0.2}
    table = F.results_markdown(before, after)
    assert "| PSNR, person crop (dB) | 19.00 | 22.00 | +3.00 |" in table
    assert table.index("person crop") > table.index("| PSNR (dB)")


def test_cosine_factor_decays_to_the_floor():
    assert F.cosine_factor(0, 100) == pytest.approx(1.0)
    assert F.cosine_factor(100, 100) == pytest.approx(0.05)
    assert 0.05 < F.cosine_factor(50, 100) < 1.0
