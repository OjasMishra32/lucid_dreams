"""source.py on the synthetic clip: undistort (k1), watermark inpaint (frames and plates), strobe replacement.

    /usr/local/bin/python3 -m pytest pipeline/court/bake/tests/test_source.py -q
"""
import json

import cv2
import numpy as np
import pytest

from bake import interp, source, synth

SPEC = synth.Spec(n_frames=48)


@pytest.fixture(scope="module")
def clip():
    return synth.SynthClip(SPEC)


@pytest.fixture(scope="module")
def written(tmp_path_factory, clip):
    out = tmp_path_factory.mktemp("synth_src")
    synth.write_clip(out, clip)
    return out


@pytest.fixture(scope="module")
def src(written):
    cfg = json.loads((written / "bake_config.json").read_text())
    return source.Source.from_config(cfg)


def luma(img):
    return cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)


def inner(img, m=20):
    return img[m:-m, m:-m]


def test_undistort_gives_the_pinhole_image(clip):
    t = clip.time_of(clip.first + 8)
    raw = clip.render(t, distorted=True)
    pin = clip.render(t)
    _, f = clip.camera(t)
    und = source.undistort(raw, f, SPEC.k1)
    assert und.shape == raw.shape and und.dtype == np.uint8
    s_und = interp.ssim(luma(inner(und)), luma(inner(pin)))
    s_raw = interp.ssim(luma(inner(raw)), luma(inner(pin)))
    # 0.93: one bicubic resample of the synthetic 1-px noise texture alone costs ~0.04 SSIM (measured)
    assert s_und > 0.93 and s_und > s_raw + 0.05, (s_und, s_raw)


def test_undistort_points_matches_projection(clip):
    t = clip.time_of(clip.first + 12)
    _, f = clip.camera(t)
    for pid in clip.person_ids:
        ud, vd = clip.foot_pixel(pid, t, distorted=True)
        up, vp = clip.foot_pixel(pid, t, distorted=False)
        u, v = source.undistort_points(np.array([ud]), np.array([vd]), f, SPEC.k1, SPEC.width, SPEC.height)
        assert abs(u[0] - up) < 1e-3 and abs(v[0] - vp) < 1e-3
        u2, v2 = source.distort_points(np.array([up]), np.array([vp]), f, SPEC.k1, SPEC.width, SPEC.height)
        assert abs(u2[0] - ud) < 1e-3 and abs(v2[0] - vd) < 1e-3


def test_undistort_at_another_resolution_uses_scaled_focal(clip):
    """A half-size image with the full-size focal halved lands on the half-size pinhole image."""
    t = clip.time_of(clip.first + 8)
    raw = clip.render(t, distorted=True, scale=0.5)
    pin = clip.render(t, scale=0.5)
    _, f = clip.camera(t)
    und = source.undistort(raw, source.focal_at(f, SPEC.width, raw.shape[1]), SPEC.k1)
    assert interp.ssim(luma(inner(und, 10)), luma(inner(pin, 10))) > 0.93


def test_valid_mask_loses_only_the_corners(clip):
    _, f = clip.camera(0.0)
    valid = source.undistort_valid(SPEC.width, SPEC.height, f, SPEC.k1)
    assert valid[SPEC.height // 2, SPEC.width // 2] and not valid[0, 0] and not valid[-1, -1]
    assert 0.9 < valid.mean() < 1.0


def test_mattes_undistort_like_the_frame(written, clip, src):
    s = clip.first + 9
    t = clip.time_of(s)
    sc = SPEC.layers_scale
    truth = clip.render(t, masks=True, scale=sc)  # pinhole visible coverage
    for pid, cover in truth.items():
        p = written / "layers2" / "out" / "mattes" / f"{s:06d}" / f"{pid}.png"
        if not p.exists():
            continue
        m = cv2.imread(str(p), cv2.IMREAD_UNCHANGED)
        und = src.undistort_layer(m, s, kind="matte")
        a, b = und > 127, cover > 0.5
        iou = (a & b).sum() / max((a | b).sum(), 1)
        assert iou > 0.9, (pid, iou)


def watermark_err(img, clean, box):
    x0, y0, x1, y1 = box
    return np.abs(img[y0:y1, x0:x1].astype(int) - clean[y0:y1, x0:x1].astype(int)).mean()


def test_watermark_inpaint_on_a_frame(clip):
    s = clip.first + 4
    raw = clip.frame(s)
    clean = clip.render(clip.time_of(s), distorted=True)
    box = clip.watermark_box
    out = source.inpaint_watermark(raw, box, SPEC.width)
    x0, y0, x1, y1 = source.scaled_box(box, SPEC.width, raw.shape[1], raw.shape[0])
    keep = np.ones(raw.shape[:2], bool)
    keep[y0:y1, x0:x1] = False
    assert np.array_equal(out[keep], raw[keep])
    before, after = watermark_err(raw, clean, box), watermark_err(out, clean, box)
    assert after < 0.5 * before, (before, after)


def test_watermark_inpaint_on_a_plate(written, clip):
    """The same function on a layers plate (half size, jpeg): the box scales with the image. Inpainting cannot
    bring back the texture under the logo, so it only has to beat leaving the logo in."""
    s = clip.first + 4
    plate = cv2.cvtColor(cv2.imread(str(written / "layers2/out/plates" / f"{s:06d}.jpg")), cv2.COLOR_BGR2RGB)
    clean = clip.render(clip.time_of(s), distorted=True, people=False, scale=SPEC.layers_scale)
    box = source.scaled_box(clip.watermark_box, SPEC.width, plate.shape[1], plate.shape[0])
    out = source.inpaint_watermark(plate, clip.watermark_box, SPEC.width)
    assert watermark_err(out, clean, box) < 0.8 * watermark_err(plate, clean, box)


@pytest.fixture(scope="module")
def long_clip():
    return synth.SynthClip(synth.Spec(n_frames=160))


@pytest.fixture(scope="module")
def wm_model(long_clip):
    frames = [long_clip.frame(s) for s in long_clip.unique if s not in long_clip.flash_srcs]
    return source.WatermarkModel.fit(frames, long_clip.watermark_box, SPEC.width)


def test_watermark_model_recovers_the_overlay(long_clip, wm_model):
    alpha, c, (x0, y0, x1, y1) = wm_model.at(SPEC.width, SPEC.height)
    true = long_clip.watermark_mask[y0:y1, x0:x1]
    err = np.abs(alpha - true)
    print(f"\nwatermark alpha: mean abs error {err.mean():.3f}, max true alpha {true.max():.2f}")
    assert err.mean() < 0.06
    logo = true > 0.2
    assert np.abs(alpha[logo] - true[logo]).mean() < 0.12


def test_watermark_unblend_beats_inpaint_on_frames_and_plates(long_clip, wm_model, tmp_path):
    rows = []
    for s in long_clip.unique[5:150:24]:
        if s in long_clip.flash_srcs:
            continue
        t = long_clip.time_of(s)
        raw = long_clip.frame(s)
        clean = long_clip.render(t, distorted=True)
        box = source.scaled_box(long_clip.watermark_box, SPEC.width, SPEC.width, SPEC.height)
        rows.append((watermark_err(raw, clean, box), watermark_err(source.inpaint_watermark(raw, long_clip.watermark_box, SPEC.width), clean, box),
                     watermark_err(wm_model.remove(raw), clean, box)))
        # a half-size plate through the same model
        plate = long_clip.render(t, distorted=True, people=False, watermark=True, scale=0.5)
        pclean = long_clip.render(t, distorted=True, people=False, scale=0.5)
        pbox = source.scaled_box(long_clip.watermark_box, SPEC.width, plate.shape[1], plate.shape[0])
        assert watermark_err(wm_model.remove(plate), pclean, pbox) < 0.6 * watermark_err(plate, pclean, pbox)
    r = np.array(rows).mean(axis=0)
    print(f"\nwatermark box MAD vs clean: left in {r[0]:.2f}, inpaint {r[1]:.2f}, model un-blend {r[2]:.2f}")
    assert r[2] < 0.6 * r[1] and r[2] < 0.4 * r[0]
    p = tmp_path / "wm.npz"
    wm_model.save(p)
    back = source.WatermarkModel.load(p)
    assert np.array_equal(back.alpha, wm_model.alpha) and back.region == wm_model.region


def test_clean_frame_is_undistorted_and_unbranded(clip, src):
    s = clip.first + 8
    img, info = src.clean(s)
    assert info["interp"] is False
    gt = clip.gt(s)
    assert interp.ssim(luma(inner(img)), luma(inner(gt))) > 0.93
    x0, y0, x1, y1 = clip.watermark_box
    wm = np.abs(img[y0:y1, x0:x1].astype(int) - gt[y0:y1, x0:x1].astype(int)).mean()
    raw_wm = np.abs(clip.frame(s)[y0:y1, x0:x1].astype(int) - gt[y0:y1, x0:x1].astype(int)).mean()
    assert wm < raw_wm


def test_strobe_frames_are_replaced_from_neighbours(clip, src):
    for s in SPEC.strobes:
        img, info = src.clean(s)
        assert info["interp"] is True and info["a"] < s < info["b"]
        assert info["a"] not in clip.flash_srcs and info["b"] not in clip.flash_srcs
        assert not clip.is_repeat(info["a"]) and not clip.is_repeat(info["b"])
        gt = clip.gt(s)
        assert interp.ssim(luma(inner(img)), luma(inner(gt))) > 0.9
        ya, yb = (luma(src.clean(n)[0]).mean() for n in (info["a"], info["b"]))
        y = luma(img).mean()
        assert abs(y - ya) < 8 and abs(y - yb) < 8  # P39: no luma spike against its neighbours
    assert src.neighbours(SPEC.strobes[0]) == (125, 128)  # 126 flashed, 127 its repeat


def test_flash_detector(clip):
    lum = [luma(clip.frame(s)).mean() for s in clip.srcs]
    found = source.detect_flashes(clip.srcs, lum, threshold=8.0)
    assert set(found) == set(clip.flash_srcs)


def test_calib_focal_interpolates_and_clamps(written):
    cal = json.loads((written / "calib_A.json").read_text())
    fo = source.CalibFocal(cal)
    fr = cal["frames"]
    assert fo(fr[3]["source_frame"]) == pytest.approx(fr[3]["f"])
    mid = 0.5 * (fr[3]["source_frame"] + fr[4]["source_frame"])
    assert fo(mid) == pytest.approx(0.5 * (fr[3]["f"] + fr[4]["f"]))
    assert fo(fr[0]["source_frame"] - 50) == pytest.approx(fr[0]["f"])
    assert fo(fr[-1]["source_frame"] + 50) == pytest.approx(fr[-1]["f"])
    assert fo.width == SPEC.width and fo.k1 == pytest.approx(SPEC.k1)


def box_err(img, truth, box):
    x0, y0, x1, y1 = box
    return np.abs(img[y0:y1, x0:x1].astype(int) - truth[y0:y1, x0:x1].astype(int)).mean()


def test_rife_inbetween_is_cleaned_like_a_real_frame(written, clip, tmp_path):
    """RIFE runs on the raw frames (watermark and lens distortion in). Its result must leave source.py exactly as a
    DIS in-between of the same raw frames does: watermark removed, then undistorted with the lerped focal."""
    cfg = json.loads((written / "bake_config.json").read_text())
    uniq = [s for s in clip.unique if s not in clip.flash_srcs]
    a, b, w = uniq[6], uniq[7], 0.4
    raw_mid = interp.interpolate(clip.frame(a), clip.frame(b), w)  # what an in-between of the raw frames looks like
    rdir = tmp_path / "rife"
    man = interp.write_needs([(a, b, w)], rdir / "needs.json", ext=".png")
    cv2.imwrite(str(rdir / man["pairs"][0]["out"]), cv2.cvtColor(raw_mid, cv2.COLOR_RGB2BGR))
    img_r, info_r = source.Source.from_config(cfg, rife_dir=rdir).clean_between(a, b, w)
    img_d, info_d = source.Source.from_config(cfg).clean_between(a, b, w)
    assert info_r["method"] == "rife" and info_d["method"] == "dis"
    assert np.array_equal(img_r, img_d)  # same raw in-between -> same treatment
    truth = clip.gt_at(a, b, w)
    box = source.scaled_box(clip.watermark_box, SPEC.width, SPEC.width, SPEC.height)
    left_in = source.undistort(raw_mid, info_r["f"], SPEC.k1)  # undistorted, watermark NOT removed
    assert box_err(img_r, truth, box) < 0.8 * box_err(left_in, truth, box)
    # and the same as a real frame gets: a "RIFE result" that is exactly raw frame a comes out as clean(a) does
    # (up to the focal lerped 1e-4 of the way to b's)
    man0 = interp.write_needs([(a, b, 1e-4)], rdir / "needs.json", ext=".png")
    cv2.imwrite(str(rdir / man0["pairs"][0]["out"]), cv2.cvtColor(clip.frame(a), cv2.COLOR_RGB2BGR))
    img0, info0 = source.Source.from_config(cfg, rife_dir=rdir).clean_between(a, b, 1e-4)
    real, _ = source.Source.from_config(cfg).clean(a)
    assert info0["method"] == "rife"
    assert np.abs(img0.astype(int) - real.astype(int)).max() <= 2


def test_dis_inbetweens_and_strobe_replacements_are_watermark_free(written, clip):
    cfg = json.loads((written / "bake_config.json").read_text())
    src = source.Source.from_config(cfg)
    box = source.scaled_box(clip.watermark_box, SPEC.width, SPEC.width, SPEC.height)
    uniq = [s for s in clip.unique if s not in clip.flash_srcs]
    a, b = uniq[9], uniq[10]
    img, info = src.clean_between(a, b, 0.5)
    truth = clip.gt_at(a, b, 0.5)
    raw_mid = interp.interpolate(clip.frame(a), clip.frame(b), 0.5)
    assert box_err(img, truth, box) < 0.8 * box_err(source.undistort(raw_mid, info["f"], SPEC.k1), truth, box)
    for s in SPEC.strobes:
        img, info = src.clean(s)
        assert info["interp"] and info["method"] == "dis"
        assert box_err(img, clip.gt(s), box) < 0.8 * box_err(source.undistort(clip.frame(info["a"]), info["f"], SPEC.k1), clip.gt(s), box)
