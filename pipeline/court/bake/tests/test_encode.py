"""encode.py: ffmpeg libx264 over a stdin pipe -> Annex B .h264 with IDRs exactly where asked, F visually lossless.
Tiny synthetic frames (256 x 360 stacked). Run: /usr/local/bin/python3 -m pytest pipeline/court/bake/tests/test_encode.py"""

import json
import subprocess
from pathlib import Path

import cv2
import numpy as np
import pytest

from pipeline.court.bake import encode as enc
from pipeline.court.bake.stack import MAIN, synthetic_layout

LAY = synthetic_layout(256)  # 256 x 360


def textured_frame(i, lay=LAY, seed=7):
    """A moving, noisy stacked frame: smooth gradient + a moving block + fixed-seed film grain (hard for x264 at high CRF)."""
    rng = np.random.default_rng(seed)
    h, w = lay.height, lay.width
    yy, xx = np.mgrid[0:h, 0:w]
    img = np.stack([(xx * 255 / w), (yy * 255 / h), ((xx + yy + 3 * i) % 256)], -1).astype(np.float32)
    x0 = (7 * i) % (w - 40)
    img[20:60, x0 : x0 + 40] = [250, 40, 40]
    img += rng.normal(0, 6, img.shape).astype(np.float32)
    return np.clip(img, 0, 255).astype(np.uint8)


def moving_clip(n, lay=LAY):
    return (textured_frame(i, lay, seed=100 + i) for i in range(n))


def test_level_and_codec_follow_the_stream_size_and_rate():
    assert enc.level_for(1536, 2160, 72) == "5.1" and enc.codec_for(1536, 2160, 72) == "avc1.640033"
    assert enc.level_for(1536, 2160, 90) == "5.2" and enc.codec_for(1536, 2160, 90) == "avc1.640034"
    assert enc.level_for(1280, 1800, 90) == "5.1"
    assert enc.level_for(1280, 1800, 72) == "5.1"


def test_idr_exactly_at_the_requested_frames(tmp_path):
    out = tmp_path / "show.h264"
    idr = [0, 17, 30, 41]
    res = enc.encode(moving_clip(55), [enc.Output(out, LAY.width, LAY.height)], n_frames=55, hz=72, idr=idr, crf=23)
    info = enc.scan_h264(out)
    assert info.frames == 55
    assert info.idr == idr
    assert info.codec == "avc1.640033"
    assert res[0].frames == 55 and res[0].idr == idr
    # cross-check with ffprobe: keyframes at the same positions, no B-frames
    probe = subprocess.run(["ffprobe", "-v", "error", "-f", "h264", "-i", str(out), "-select_streams", "v:0", "-show_entries", "frame=key_frame,pict_type", "-of", "json"], capture_output=True, text=True, check=True)
    frames = json.loads(probe.stdout)["frames"]
    assert len(frames) == 55
    assert [i for i, f in enumerate(frames) if f["key_frame"] == 1] == idr
    assert not any(f["pict_type"] == "B" for f in frames)


def test_frame_zero_is_always_an_idr(tmp_path):
    out = tmp_path / "a.h264"
    enc.encode(moving_clip(10), [enc.Output(out, LAY.width, LAY.height)], n_frames=10, hz=72, idr=[5], crf=23)
    assert enc.scan_h264(out).idr == [0, 5]


def test_no_idr_is_forced_anywhere_else(tmp_path):
    out = tmp_path / "b.h264"
    # a hard scene change at frame 20 must not make an IDR
    def clip():
        for i in range(40):
            yield textured_frame(i) if i < 20 else 255 - textured_frame(i)
    enc.encode(clip(), [enc.Output(out, LAY.width, LAY.height)], n_frames=40, hz=72, idr=[0], crf=23)
    assert enc.scan_h264(out).idr == [0]


def test_main_and_small_come_out_of_one_pass(tmp_path):
    small = LAY.scaled(128)
    outs = [enc.Output(tmp_path / "show.h264", LAY.width, LAY.height), enc.Output(tmp_path / "small.h264", small.width, small.height)]
    enc.encode(moving_clip(20), outs, n_frames=20, hz=72, idr=[0, 10], crf=23)
    for o, lay in zip(outs, (LAY, small)):
        info = enc.scan_h264(o.path)
        assert (info.width, info.height, info.frames, info.idr) == (lay.width, lay.height, 20, [0, 10])


def test_frame_count_mismatch_and_bad_shape_are_errors(tmp_path):
    out = [enc.Output(tmp_path / "c.h264", LAY.width, LAY.height)]
    with pytest.raises(ValueError):
        enc.encode(moving_clip(5), out, n_frames=6, hz=72, idr=[0])
    with pytest.raises(ValueError):
        enc.encode(iter([np.zeros((10, 10, 3), np.uint8)]), out, n_frames=1, hz=72, idr=[0])


def test_decode_roundtrip_has_no_systematic_colour_shift(tmp_path):
    flat = np.zeros((LAY.height, LAY.width, 3), np.uint8)
    flat[:] = (30, 120, 220)
    flat[:, : LAY.width // 2] = (200, 180, 20)
    out = tmp_path / "flat.h264"
    enc.encode(iter([flat] * 3), [enc.Output(out, LAY.width, LAY.height)], n_frames=3, hz=72, idr=[0], crf=10)
    got = enc.decode_frames(out, [1], LAY.width, LAY.height)[1]
    assert enc.luma_mad(got, flat) < 1.0
    assert np.abs(got.astype(int) - flat.astype(int)).mean() < 1.5


def test_protected_frame_is_visually_lossless_where_the_rest_is_not(tmp_path):
    F = 33
    frames = [textured_frame(i, seed=100 + i) for i in range(40)]
    plain, prot = tmp_path / "plain.h264", tmp_path / "prot.h264"
    enc.encode(iter(frames), [enc.Output(plain, LAY.width, LAY.height)], n_frames=40, hz=72, idr=[0], crf=32)
    enc.encode(iter(frames), [enc.Output(prot, LAY.width, LAY.height)], n_frames=40, hz=72, idr=[0], crf=32, protect=[F], protect_qp=4)
    ref = frames[F]
    mad_plain = enc.luma_mad(enc.decode_frames(plain, [F], LAY.width, LAY.height)[F], ref)
    got = enc.decode_frames(prot, [F, F - 1], LAY.width, LAY.height)
    assert mad_plain > 2.0  # the test is only meaningful if plain CRF 32 is visibly lossy here
    assert enc.luma_mad(got[F], ref) < 1.0
    assert enc.luma_mad(got[F - 1], frames[F - 1]) > 2.0  # neighbours stay at the stream's quality
    assert enc.scan_h264(prot).idr == [0]  # a zone never forces a keyframe


def test_calibrate_protect_qp_picks_a_qp_that_meets_the_bound():
    frames = [textured_frame(i, seed=100 + i) for i in range(14)]
    qp, mad = enc.calibrate_protect_qp(frames, LAY, hz=72, crf=32, bound=1.0)
    assert 0 <= qp <= 20 and mad <= 0.8  # a safety margin under the bound
    qp_loose, _ = enc.calibrate_protect_qp(frames, LAY, hz=72, crf=32, bound=3.0)
    assert qp_loose >= qp


def test_encode_leaves_nothing_but_the_streams_on_disk(tmp_path):
    out = tmp_path / "d.h264"
    enc.encode(moving_clip(8), [enc.Output(out, LAY.width, LAY.height)], n_frames=8, hz=72, idr=[0], crf=23)
    assert sorted(p.name for p in tmp_path.iterdir()) == ["d.h264"]


def test_ffmpeg_failure_is_reported(tmp_path):
    bad = tmp_path / "no" / "such" / "dir" / "x.h264"
    with pytest.raises((RuntimeError, OSError)):
        enc.encode(moving_clip(3), [enc.Output(bad, LAY.width, LAY.height)], n_frames=3, hz=72, idr=[0])


def test_write_freeze_is_lossless(tmp_path):
    img = textured_frame(3)
    p = tmp_path / "freeze.png"
    enc.write_png(p, img)
    back = cv2.cvtColor(cv2.imread(str(p)), cv2.COLOR_BGR2RGB)
    assert np.array_equal(back, img)


def test_frame_error_compares_the_live_region_with_the_freeze(tmp_path):
    lay = LAY
    live = textured_frame(1)[: lay.live[3]]
    stacked = np.zeros((lay.height, lay.width, 3), np.uint8)
    stacked[: lay.live[3]] = live
    err = enc.frame_error(stacked, lay, live)
    assert err["mad_luma"] == 0 and err["psnr"] == float("inf")
    # a freeze at another size is resized to the live region first
    big = cv2.resize(live, (lay.width * 2, lay.live[3] * 2), interpolation=cv2.INTER_NEAREST)
    assert enc.frame_error(stacked, lay, big)["mad_luma"] < 0.5


def test_mp4_fallback_holds_only_the_first_frames_and_is_playable(tmp_path):
    outs = [enc.Output(tmp_path / "show.h264", LAY.width, LAY.height), enc.Output(tmp_path / "pass1.mp4", LAY.width, LAY.height, fmt="mp4", limit=12)]
    res = enc.encode(moving_clip(30), outs, n_frames=30, hz=72, idr=[0, 12], crf=23)
    assert res[1].frames == 12
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames,codec_name,profile,width,height,r_frame_rate", "-of", "json", str(outs[1].path)], capture_output=True, text=True, check=True)
    st = json.loads(probe.stdout)["streams"][0]
    assert (st["nb_read_frames"], st["codec_name"], st["profile"], st["width"], st["height"]) == ("12", "h264", "High", LAY.width, LAY.height)
    assert st["r_frame_rate"] == "72/1"
    assert enc.scan_h264(outs[0].path).frames == 30


def test_a_preset_that_loses_high_profile_is_refused(tmp_path):
    with pytest.raises(RuntimeError, match="High"):
        enc.encode(moving_clip(4), [enc.Output(tmp_path / "u.h264", LAY.width, LAY.height)], n_frames=4, hz=72, idr=[0], preset="ultrafast")


def test_decode_all_streams_every_frame_and_crops(tmp_path):
    out = tmp_path / "e.h264"
    frames = [textured_frame(i, seed=100 + i) for i in range(6)]
    enc.encode(iter(frames), [enc.Output(out, LAY.width, LAY.height)], n_frames=6, hz=72, idr=[0], crf=10)
    got = list(enc.decode_all(out, LAY.width, LAY.height))
    assert len(got) == 6 and all(g.shape == frames[0].shape for g in got)
    live = list(enc.decode_all(out, LAY.width, LAY.height, region=LAY.live))
    assert len(live) == 6 and live[0].shape == (LAY.live[3], LAY.live[2], 3)
    assert np.array_equal(live[2], got[2][: LAY.live[3]])


def test_the_real_stacked_size_gets_level_5_1_and_the_format_codec(tmp_path):
    from pipeline.court.bake.stack import MAIN

    rng = np.random.default_rng(1)
    base = rng.integers(0, 255, (MAIN.height, MAIN.width, 3), dtype=np.uint8)
    out = tmp_path / "big.h264"
    enc.encode(iter([base, base]), [enc.Output(out, MAIN.width, MAIN.height)], n_frames=2, hz=72, idr=[0], crf=30)
    info = enc.scan_h264(out)
    assert (info.width, info.height, info.codec, info.profile, info.level) == (1536, 2160, "avc1.640033", 100, 51)
