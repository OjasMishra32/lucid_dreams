"""synth.py: the synthetic clip every bake test runs against (no broadcast numbers).

    /usr/local/bin/python3 -m pytest pipeline/court/bake/tests/test_synth.py -q
"""
import json

import cv2
import numpy as np
import pytest

from bake import synth

SPEC = synth.Spec(n_frames=48)


@pytest.fixture(scope="module")
def clip():
    return synth.SynthClip(SPEC)


@pytest.fixture(scope="module")
def written(tmp_path_factory, clip):
    out = tmp_path_factory.mktemp("synth")
    synth.write_clip(out, clip)
    return out


def luma(img):
    return cv2.cvtColor(img, cv2.COLOR_RGB2GRAY).astype(np.float64)


def test_frames_are_small_rgb_and_deterministic(clip):
    a = clip.frame(clip.first + 5)
    assert a.shape == (SPEC.height, SPEC.width, 3) and a.dtype == np.uint8
    assert np.array_equal(a, synth.SynthClip(SPEC).frame(clip.first + 5))


def test_every_fifth_frame_is_an_exact_repeat(clip):
    srcs = clip.srcs
    assert srcs[0] == SPEC.first and len(srcs) == SPEC.n_frames
    for s in srcs[1:]:
        same = np.array_equal(clip.frame(s), clip.frame(s - 1))
        assert same == clip.is_repeat(s), s
        assert clip.is_repeat(s) == (s % SPEC.repeat_period == SPEC.repeat_phase)


def test_capture_times_are_even_at_the_capture_rate(clip):
    uniq = [s for s in clip.srcs if not clip.is_repeat(s)]
    t = np.array([clip.time_of(s) for s in uniq])
    assert np.allclose(np.diff(t), 1.0 / SPEC.capture_fps)
    rep = [s for s in clip.srcs if clip.is_repeat(s)]
    assert all(clip.time_of(s) == clip.time_of(s - 1) for s in rep)
    # fractional src between two unique neighbours: linear in capture time
    a = uniq[3]
    b = uniq[4]
    assert clip.time_of(a + 0.25 * (b - a)) == pytest.approx(clip.time_of(a) + 0.25 / SPEC.capture_fps)
    # 4 unique frames per 5 container frames at the synthetic container rate -> slow = capture / (0.8 * source)
    assert clip.slow == pytest.approx(SPEC.capture_fps / (0.8 * SPEC.source_fps))


def test_strobe_frames_flash_and_their_repeats_too(clip):
    flashed = clip.flash_srcs
    assert set(SPEC.strobes) <= set(flashed)
    for s in SPEC.strobes:
        if clip.is_repeat(s + 1):
            assert s + 1 in flashed
    for s in flashed:
        prev = max(p for p in clip.srcs if p < s and p not in flashed)
        nxt = min(p for p in clip.srcs if p > s and p not in flashed)
        y = luma(clip.frame(s)).mean()
        assert y - luma(clip.frame(prev)).mean() > 40 and y - luma(clip.frame(nxt)).mean() > 40


def test_watermark_only_inside_its_box(clip):
    s = clip.first + 4
    raw = clip.frame(s).astype(np.int16)
    clean = clip.render(clip.time_of(s), distorted=True, watermark=False).astype(np.int16)
    x0, y0, x1, y1 = clip.watermark_box
    d = np.abs(raw - clean).max(axis=2)
    inside = np.zeros_like(d, bool)
    inside[y0:y1, x0:x1] = True
    assert d[~inside].max() == 0
    assert d[inside].mean() > 10
    assert clip.watermark_mask.shape == d.shape and clip.watermark_mask[~inside].max() == 0


def ssim(a, b):
    a, b = a.astype(np.float64), b.astype(np.float64)
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    blur = lambda x: cv2.GaussianBlur(x, (11, 11), 1.5)  # noqa: E731
    ma, mb = blur(a), blur(b)
    va, vb, cov = blur(a * a) - ma * ma, blur(b * b) - mb * mb, blur(a * b) - ma * mb
    return float((((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2))).mean())


def test_lens_distortion_matches_opencv_k1_model(clip):
    """OpenCV's radial model with D = (k1, 0, 0, 0) in f-normalised coords is the calibration's; undistorting the
    raw render with it must give the pinhole render (an independent check of the distortion direction)."""
    t = clip.time_of(clip.first + 8)
    raw = clip.render(t, distorted=True)
    pin = clip.render(t, distorted=False)
    R, f = clip.camera(t)
    K = synth.K_matrix(f, SPEC.width, SPEC.height)
    und = cv2.undistort(raw, K, np.array([SPEC.k1, 0, 0, 0], float))
    m = 24  # the borders sample outside the raw frame
    g = lambda im: luma(im)[m:-m, m:-m]  # noqa: E731
    assert ssim(g(und), g(pin)) > 0.9
    assert ssim(g(raw), g(pin)) < ssim(g(und), g(pin)) - 0.05


def test_ground_truth_at_fractional_times(clip):
    uniq = [s for s in clip.srcs if not clip.is_repeat(s) and s not in clip.flash_srcs]
    a, b = uniq[5], uniq[6]
    ga = clip.gt(a)
    assert np.array_equal(ga, clip.render(clip.time_of(a)))
    assert np.array_equal(clip.gt_at(a, b, 0.0), ga) and np.array_equal(clip.gt_at(a, b, 1.0), clip.gt(b))
    mid = clip.gt_at(a, b, 0.5)
    assert not np.array_equal(mid, ga) and not np.array_equal(mid, clip.gt(b))
    # across a repeat (b = a + 2) the fractional src a + 0.5 (b - a) is the repeat's own whole number: gt_at is
    # unambiguous, gt(src) is not
    pairs = [(x, y) for x, y in zip(uniq, uniq[1:]) if y - x == 2]
    x, y = pairs[0]
    assert np.array_equal(clip.gt_at(x, y, 0.25), clip.gt(x + 0.25 * (y - x)))
    # a person's foot projects between its two neighbours' positions
    pid = clip.person_ids[0]
    ua = clip.foot_pixel(pid, clip.time_of(a))[0]
    ub = clip.foot_pixel(pid, clip.time_of(b))[0]
    um = clip.foot_pixel(pid, 0.5 * (clip.time_of(a) + clip.time_of(b)))[0]
    assert min(ua, ub) < um < max(ua, ub)


def test_people_move_visibly_between_captures(clip):
    uniq = [s for s in clip.srcs if not clip.is_repeat(s)]
    t0, t1 = clip.time_of(uniq[0]), clip.time_of(uniq[1])
    moves = [abs(clip.foot_pixel(p, t1)[0] - clip.foot_pixel(p, t0)[0]) for p in clip.person_ids]
    assert max(moves) > 2.0  # px per capture at 384 wide: enough that a dissolve ghosts


def test_calib_json_has_calib_A_schema(written, clip):
    cal = json.loads((written / "calib_A.json").read_text())
    for k in ("version", "image_size", "n_frames", "camera_model", "k1_mode", "C", "frames", "fields", "source"):
        assert k in cal
    assert cal["image_size"] == [SPEC.width, SPEC.height]
    assert cal["n_frames"] == len(cal["frames"]) == SPEC.n_frames
    fr = cal["frames"][10]
    for k in ("t", "file", "C", "f", "k1", "K", "R", "tvec", "source_frame", "time_in_clip_s", "hfov_deg", "vfov_deg"):
        assert k in fr
    R = np.array(fr["R"])
    assert np.allclose(R @ R.T, np.eye(3), atol=1e-6) and np.linalg.det(R) == pytest.approx(1.0)
    assert fr["K"][0][2] == pytest.approx((SPEC.width - 1) / 2) and fr["K"][1][2] == pytest.approx((SPEC.height - 1) / 2)
    assert fr["k1"] == pytest.approx(SPEC.k1)
    assert fr["t"] == fr["source_frame"] - SPEC.first
    # camera of a frame = the truth camera at its capture time; foot points project onto the mask's bottom
    s = fr["source_frame"]
    Rt, ft = clip.camera(clip.time_of(s))
    assert np.allclose(R, Rt, atol=1e-7) and fr["f"] == pytest.approx(ft)
    # the camera pans and zooms
    Rs = np.array([f_["R"] for f_ in cal["frames"]])
    fs = np.array([f_["f"] for f_ in cal["frames"]])
    assert synth.camgeom.rot_angle_deg(Rs[0], Rs[-1]) > 0.05 and fs[-1] / fs[0] > 1.01


def test_layers_contract(written, clip):
    out = written / "layers2" / "out"
    people = json.loads((out / "people.json").read_text())
    assert set(people) >= {"scale", "frames", "ids"}
    sc = people["scale"]
    s = clip.first + 9
    entries = people["frames"][str(s)]
    assert {e["id"] for e in entries} <= set(people["ids"])
    orders = sorted(e["order"] for e in entries)
    assert orders == list(range(len(entries)))
    plate = cv2.imread(str(out / "plates" / f"{s:06d}.jpg"))
    ph, pw = plate.shape[:2]
    assert (pw, ph) == (round(SPEC.width * sc), round(SPEC.height * sc))
    for e in entries:
        x0, y0, x1, y1 = e["box"]
        assert e["foot"][1] == 0.0 and len(e["foot"]) == 3
        m = cv2.imread(str(out / "mattes" / f"{s:06d}" / f"{e['id']}.png"), cv2.IMREAD_UNCHANGED)
        assert m.dtype == np.uint8 and m.shape == (ph, pw)
        ys, xs = np.nonzero(m > 127)
        assert len(xs) > 50
        # the box (raw source px) holds the matte (plate px / scale)
        assert xs.min() / sc >= x0 - 2 and xs.max() / sc <= x1 + 2 and ys.min() / sc >= y0 - 2 and ys.max() / sc <= y1 + 2
        # the foot point projects near the matte's bottom centre (raw, distorted)
        u, v = clip.foot_pixel(e["id"], clip.time_of(s), distorted=True)
        assert abs(v - ys.max() / sc) < 4
    # order 0 is nearest the camera
    C = np.array(clip.C)
    d = {e["id"]: np.linalg.norm(np.array(e["foot"]) - C) for e in entries}
    near = min(entries, key=lambda e: e["order"])["id"]
    assert d[near] == min(d.values())
    # the plate has no people: where people stand it matches the people-free render, not the live frame
    t = clip.time_of(s)
    bg = clip.render(t, distorted=True, people=False, watermark=True, scale=sc).astype(int)
    live = clip.render(t, distorted=True, watermark=True, scale=sc).astype(int)
    pl = cv2.cvtColor(plate, cv2.COLOR_BGR2RGB).astype(int)
    who = np.abs(live - bg).max(axis=2) > 30
    assert who.sum() > 100
    assert np.abs(pl - bg)[who].mean() < 8 < np.abs(pl - live)[who].mean()
    assert (out / "mosaic.png").exists() and "R" in json.loads((out / "mosaic.json").read_text())


def test_written_clip_files(written, clip):
    for s in clip.srcs:
        assert (written / "frames" / f"{s:06d}.png").exists()
    im = cv2.cvtColor(cv2.imread(str(written / "frames" / f"{clip.first + 3:06d}.png")), cv2.COLOR_BGR2RGB)
    assert np.array_equal(im, clip.frame(clip.first + 3))
    truth = json.loads((written / "truth.json").read_text())
    assert truth["repeat"] == {"period": SPEC.repeat_period, "phase": SPEC.repeat_phase}
    assert sorted(truth["flash_srcs"]) == sorted(clip.flash_srcs)
    assert truth["watermark"]["box"] == list(clip.watermark_box)
    cfg = json.loads((written / "bake_config.json").read_text())
    assert cfg["synthetic"] is True
    assert cfg["clip_first"] == SPEC.first and cfg["clip_end"] == clip.srcs[-1]
    assert cfg["repeat_mod"] == SPEC.repeat_period and cfg["repeat_phase"] == SPEC.repeat_phase
    assert cfg["calib"].endswith("calib_A.json") and cfg["strobes"] == sorted(clip.flash_srcs)
    assert cfg["watermark"] == list(clip.watermark_box)
    assert (cfg["src_width"], cfg["src_height"]) == (SPEC.width, SPEC.height)
    assert cfg["freeze"] in clip.srcs and not clip.is_repeat(cfg["freeze"])
