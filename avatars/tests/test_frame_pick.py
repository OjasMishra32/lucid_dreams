import struct
import zlib

import numpy as np
import pytest

from lucid_avatars import frame_pick as P

RNG = np.random.default_rng(3)
FULL = (0.0, 0.0, 1.0, 1.0)


def checker(h=96, w=128, cell=4):
    y, x = np.mgrid[:h, :w]
    g = (((y // cell) + (x // cell)) % 2).astype(np.float64)
    return np.stack([g, g, g], axis=-1) * 255


def box_blur(img, k=7):
    out = img.astype(np.float64)
    for ax in (0, 1):
        pad = [(0, 0)] * img.ndim
        pad[ax] = (k // 2, k // 2)
        p = np.pad(out, pad, mode="edge")
        out = sum(np.take(p, range(i, i + out.shape[ax]), axis=ax) for i in range(k)) / k
    return out


def pose(kind, h=96, w=128):
    """Three different 'poses': a bar at the left, in the middle, on the right (on a mid-grey background)."""
    img = np.full((h, w, 3), 90.0)
    x0 = {"a": 8, "b": 52, "c": 96}.get(kind, kind)  # a name, or the bar's own x
    img[10:86, x0:x0 + 24] = 230.0
    img[30:40, x0 + 4:x0 + 20] = 20.0
    return img


# ---------------------------------------------------------------------------------------------------- sharpness
def test_laplacian_variance_flat_is_zero_and_edges_score():
    assert P.laplacian_variance(np.full((20, 20), 0.5)) == 0.0
    g = P.to_grey(checker())
    assert P.laplacian_variance(g) > P.laplacian_variance(P.to_grey(box_blur(checker())))


def test_sharpness_ranks_sharp_over_blurred_and_follows_the_box():
    sharp, soft = checker(), box_blur(checker(), 9)
    assert P.sharpness(sharp) > 3 * P.sharpness(soft)
    # sharp texture only on the left; the right is a flat grey
    half = np.full((96, 128, 3), 128.0)
    half[:, :48] = sharp[:, :48]
    assert P.sharpness(half, box=(0.0, 0.0, 0.35, 1.0)) > 10 * P.sharpness(half, box=(0.6, 0.0, 1.0, 1.0))
    assert P.sharpness(half, box=None) < P.sharpness(half, box=(0.0, 0.0, 0.35, 1.0))  # the centre misses the texture


def test_sharpness_is_the_same_for_uint8_and_float_input():
    img = checker()
    assert P.sharpness(img.astype(np.uint8)) == pytest.approx(P.sharpness(img / 255.0 * 255.0))


def test_block_downscale_caps_the_long_side_and_keeps_the_mean():
    img = RNG.uniform(0, 255, size=(300, 500, 3))
    out = P.block_downscale(img, 128)
    assert max(out.shape[:2]) <= 128 and out.ndim == 3
    assert out.mean() == pytest.approx(img.mean(), rel=0.02)
    small = np.ones((10, 12))
    assert P.block_downscale(small, 128).shape == (10, 12)


def test_resize_area_shape_and_mean():
    g = RNG.uniform(size=(97, 211))
    out = P.resize_area(g, 24, 24)
    assert out.shape == (24, 24)
    assert out.mean() == pytest.approx(g.mean(), abs=0.02)
    assert np.allclose(P.resize_area(np.full((50, 70), 0.3), 8, 8), 0.3)


# ---------------------------------------------------------------------------------------------------- signatures
def test_signature_distance_ignores_brightness_and_sees_a_new_pose():
    a = P.signature(pose("a"))
    assert P.signature_distance(a, a) == 0.0
    assert P.signature_distance(a, P.signature(np.clip(pose("a") * 0.8 + 10, 0, 255))) < 0.05
    assert P.signature_distance(a, P.signature(pose("b"))) > 0.3
    assert P.signature_distance(a, P.signature(pose("a") + RNG.normal(0, 3, size=(96, 128, 3)))) < 0.1


def test_junk_reason_black_white_flat_and_normal():
    h, w = 96, 128
    assert P.junk_reason(P.signature(np.zeros((h, w, 3)))) == "black"
    dim = np.zeros((h, w, 3))
    dim[:5, :5] = 255.0  # a few bright pixels don't make it a picture
    assert P.junk_reason(P.signature(dim)) == "black"
    assert P.junk_reason(P.signature(np.full((h, w, 3), 252.0))) == "white"
    assert P.junk_reason(P.signature(np.full((h, w, 3), 120.0) + RNG.normal(0, 0.5, size=(h, w, 3)))) == "flat"
    assert P.junk_reason(P.signature(pose("a"))) is None


def test_transition_flags_mark_both_sides_of_a_cut():
    a, b = P.signature(pose("a")), P.signature(np.kron(RNG.uniform(0, 255, size=(8, 8)), np.ones((12, 16)))[..., None] * np.ones(3))
    flags = P.transition_flags([a, a, a, b, b, b])
    assert list(flags) == [False, False, True, True, False, False]
    assert not P.transition_flags([a, a, a]).any()
    assert not P.transition_flags([a]).any() and len(P.transition_flags([])) == 0


# ---------------------------------------------------------------------------------------------------- picking
def _clip(kinds, scores, step=0.4):
    sigs = [P.signature(pose(k) + RNG.normal(0, 1.0, size=(96, 128, 3)), box=FULL) for k in kinds]
    return np.arange(len(kinds)) * step, np.asarray(scores, dtype=float), sigs


def test_pick_covers_every_pose_takes_the_sharpest_and_keeps_the_time_gap():
    kinds = list("a" * 10 + "b" * 10 + "c" * 10)
    scores = np.linspace(0.5, 1.0, 30)
    scores[3], scores[14], scores[25] = 2.0, 2.0, 2.0  # one clearly sharpest frame per pose
    times, scores, sigs = _clip(kinds, scores)
    r = P.pick_frames(times, scores, sigs, count=6, min_gap=0.8)
    assert {3, 14, 25} <= set(r.indices)
    assert {kinds[i] for i in r.indices} == {"a", "b", "c"}
    assert r.indices == sorted(r.indices)
    assert np.diff(times[r.indices]).min() >= 0.8 - 1e-9 or r.relaxed > 0


def test_pick_never_returns_more_than_asked_or_sixteen_and_prefers_variety():
    kinds = [("abc"[(i // 3) % 3]) for i in range(60)]
    times, scores, sigs = _clip(kinds, RNG.uniform(1, 2, size=60), step=0.5)
    assert len(P.pick_frames(times, scores, sigs, count=40, min_gap=0.0, dup=0.0001).indices) <= P.MAX_FRAMES == 16
    assert len(P.pick_frames(times, scores, sigs, count=5, min_gap=0.5).indices) <= 5
    first = P.pick_frames(times, scores, sigs, count=3, min_gap=0.5).indices
    assert {kinds[i] for i in first} == {"a", "b", "c"}  # three picks, three different poses


def test_pick_rejects_black_blurred_and_transition_frames_and_says_why():
    kinds = list("a" * 8 + "b" * 8)
    times, scores, sigs = _clip(kinds, np.full(16, 1.0))
    sigs[2] = P.signature(np.zeros((96, 128, 3)))  # black
    scores[5] = 0.05  # blurred (a fifth of the sharp frames' score)
    r = P.pick_frames(times, scores, sigs, count=16, min_gap=0.0, dup=0.0)
    assert 2 not in r.indices and 5 not in r.indices
    assert r.rejected["black"] == 1 and r.rejected["blurred"] == 1
    assert 7 not in r.indices and 8 not in r.indices and r.rejected["transition"] == 2  # either side of the cut a -> b


def test_busy_clip_is_not_all_transitions():
    # every frame jumps to an unrelated one (a hand-held run through a crowd): the cut rule must not eat the clip
    sigs = [P.signature(RNG.uniform(0, 255, size=(96, 128, 3))) for _ in range(12)]
    r = P.pick_frames(np.arange(12) * 0.4, np.ones(12), sigs, count=5, min_gap=0.0, dup=0.0)
    assert len(r.indices) == 5 and "transition" not in r.rejected


def test_static_clip_gives_fewer_frames_and_a_note_instead_of_clones():
    times, scores, sigs = _clip(list("a" * 20), RNG.uniform(1, 1.1, size=20))
    r = P.pick_frames(times, scores, sigs, count=10, min_gap=0.4)
    assert 1 <= len(r.indices) < 8 and r.note and "distinct" in r.note


def test_relaxes_gap_and_duplicate_limit_to_reach_the_minimum_when_it_can():
    kinds = [6 + 4 * i for i in range(24)]  # a bar sliding right, 4 px a frame
    times, scores, sigs = _clip(kinds, np.ones(24), step=0.1)  # 2.4 s only: a 1 s gap allows 3 frames
    r = P.pick_frames(times, scores, sigs, count=10, min_gap=1.0, dup=0.3)
    assert len(r.indices) >= 8 and r.relaxed > 0 and r.note is None


def test_empty_or_all_junk_gives_an_empty_pick_with_a_note():
    r = P.pick_frames(np.zeros(0), np.zeros(0), [], count=10, min_gap=0.5)
    assert r.indices == [] and r.note
    black = [P.signature(np.zeros((96, 128, 3)))] * 4
    r = P.pick_frames(np.arange(4) * 0.5, np.ones(4), black, count=10, min_gap=0.5)
    assert r.indices == [] and r.rejected == {"black": 4} and r.note


def test_default_min_gap_scales_with_the_clip_and_is_bounded():
    assert P.default_min_gap(2.0, 10) == 0.25
    assert P.default_min_gap(600.0, 10) == 1.0
    assert 0.25 < P.default_min_gap(8.0, 10) < 1.0


# ---------------------------------------------------------------------------------------------------- the person's box
def test_find_person_box_follows_the_mover_on_a_still_camera():
    bg = RNG.uniform(0.2, 0.8, size=(36, 64))
    frames = []
    for t in range(14):
        g = bg.copy()
        x = 20 + t  # a 10 x 16 blob moving right, in the middle band
        g[10:26, x:x + 10] = 1.0 - bg[10:26, x:x + 10]
        frames.append(g)
    box = P.find_person_box(np.stack(frames))
    x0, y0, x1, y1 = box
    assert x0 < 22 / 64 and x1 > 33 / 64 and y0 < 12 / 36 and y1 > 24 / 36
    assert (x1 - x0) * (y1 - y0) < 0.85


def test_find_person_box_gives_none_when_everything_moves_or_nothing_does():
    still = np.stack([RNG.uniform(size=(36, 64))] * 8)
    assert P.find_person_box(still) is None
    shaky = np.stack([RNG.uniform(size=(36, 64)) for _ in range(8)])
    assert P.find_person_box(shaky) is None
    assert P.find_person_box(still[:1]) is None


def test_parse_box_fractions_and_errors():
    assert P.parse_box("0.2, 0.1,0.8,0.95") == (0.2, 0.1, 0.8, 0.95)
    for bad in ("0.2,0.1,0.8", "a,b,c,d", "0.5,0.1,0.4,0.9", "-0.1,0,1,1", "0,0,1.2,1", "0.1,0.1,0.11,0.9"):
        with pytest.raises(ValueError):
            P.parse_box(bad)


def test_crop_box_cuts_the_region_and_the_default_is_the_centre():
    img = np.arange(100 * 200).reshape(100, 200)
    assert P.crop_box(img, (0.5, 0.0, 1.0, 0.5)).shape == (50, 100)
    assert P.crop_box(img, (0.5, 0.0, 1.0, 0.5))[0, 0] == img[0, 100]
    c = P.crop_box(img, None)
    assert c.shape == (60, 120) and c[0, 0] == img[20, 40]


# ---------------------------------------------------------------------------------------------------- contact sheet
def test_png_bytes_is_a_valid_png():
    rgb = RNG.integers(0, 256, size=(7, 9, 3), dtype=np.uint8)
    data = P.png_bytes(rgb)
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, chunks = 8, {}
    while pos < len(data):
        n, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        assert zlib.crc32(kind + body) == struct.unpack(">I", data[pos + 8 + n:pos + 12 + n])[0]
        chunks[kind] = body
        pos += 12 + n
    assert struct.unpack(">IIBBBBB", chunks[b"IHDR"]) == (9, 7, 8, 2, 0, 0, 0)
    raw = np.frombuffer(zlib.decompress(chunks[b"IDAT"]), dtype=np.uint8).reshape(7, 1 + 27)
    assert (raw[:, 0] == 0).all()
    np.testing.assert_array_equal(raw[:, 1:].reshape(7, 9, 3), rgb)
    assert list(chunks)[-1] == b"IEND"


def test_contact_sheet_grid_holds_every_tile():
    tiles = [np.full((30, 40, 3), 50 * i + 10, dtype=np.uint8) for i in range(5)]
    sheet = P.contact_sheet(tiles, cols=3, pad=2)
    assert sheet.shape == (2 * 30 + 3 * 2, 3 * 40 + 4 * 2, 3) and sheet.dtype == np.uint8
    assert sheet[2 + 5, 2 + 5, 0] == 10 and sheet[2 + 30 + 2 + 5, 2 + 40 + 2 + 5, 0] == 10 + 50 * 4
    assert P.contact_sheet([], cols=3).size == 0
