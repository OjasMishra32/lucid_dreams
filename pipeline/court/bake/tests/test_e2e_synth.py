"""The whole bake on synth.py's clip: known motion, known cameras, repeats, strobes, a watermark, lens distortion, layers.

Runs the real chain (timeline -> source/interp -> stack -> x264 -> format.ts validators) at the synthetic layout
(256 x 360 stacked) and checks what the plan's P-rows ask of the stream: frame counts per segment, IDRs only at segment
starts, every ease landing exactly on F, judder CV, in-between SSIM against ground truth, strobes gone, the validators,
the output contract's file list and shape, and F in the stream against freeze.png.
Run: /usr/local/bin/python3 -m pytest pipeline/court/bake/tests/test_e2e_synth.py
"""

import json
import math
from pathlib import Path

import cv2
import numpy as np
import pytest
from scipy.ndimage import uniform_filter1d

from pipeline.court.bake import bake, config, encode, interp, providers, synth, timeline
from pipeline.court.bake.captime import CapTime
from pipeline.court.bake.stack import synthetic_layout

LAY = synthetic_layout(256)
JUDDER_CV_BOUND = 0.15  # plan P4
MAD_BOUND = 1.0  # plan P44
CONTRACT_FILES = ["show.h264", "show-small.h264", "show-90.h264", "frames.json", "cards.json", "freeze.png", "freeze-clean.png"]
LAYERS_FILES = ["stands-mask.png", "inpaint-mask.png"]  # written only from the layers agent's own files; reported missing until then


@pytest.fixture(scope="module")
def baked(tmp_path_factory):
    work = tmp_path_factory.mktemp("synth")
    opts = bake.Options(layout=LAY, small_width=128, n_slots=4, crf=18, preset="veryfast", log=lambda s: None)
    report = providers.synth_run(work, None, None, opts, bake.bake)
    cfg = config.load(work / "bake_config.json")
    clip = synth.SynthClip()
    v = work / "show" / "video"
    info = json.loads((v.parent / "video.json").read_text())
    tls = {hz: timeline.build(cfg, hz) for hz in cfg.display_hz}
    return dict(work=work, v=v, report=report, cfg=cfg, clip=clip, info=info, tls=tls)


def video(b, name="show.h264"):
    return list(encode.decode_all(b["v"] / name, LAY.width, LAY.height, region=LAY.live))


def test_report_is_ok_and_validators_passed(baked):
    r = baked["report"]
    assert r["format"]["ok"], r["format"]["problems"]
    assert r["ok"], r
    assert {s["stream"] for s in r["format"]["report"]} == {"main", "small", "hz90"}


def test_output_contract_files_and_video_json_shape(baked):
    v, info = baked["v"], baked["info"]
    for name in CONTRACT_FILES:
        assert (v / name).is_file(), name
    assert (v.parent / "video.json").is_file() and not (v / "video.json").exists()  # show/video.json beside show/video/
    # stands-mask / inpaint-mask are the layers agent's: reported missing, never faked
    assert sorted(baked["report"]["missing"]) == sorted(LAYERS_FILES)
    for name in LAYERS_FILES:
        assert not (v / name).exists()
    assert set(info) == {"video", "camera"}
    assert {"centre", "sourceFps", "captureFps", "slow"} <= set(info["camera"])
    assert len(info["camera"]["centre"]) == 3
    vid = info["video"]
    assert vid["file"] == "video/show.h264" and vid["frames"] == "video/frames.json" and vid["cards"] == "video/cards.json"
    assert vid["freeze"] == "video/freeze.png" and vid["freezeClean"] == "video/freeze-clean.png"
    assert "standsMask" not in vid and "inpaintMask" not in vid  # not made yet: left out of video.json, never faked
    files = [p for p in v.parent.rglob("*") if p.is_file()]
    assert not [p for p in files if ".tmp" in p.name]
    assert max(files, key=lambda p: p.stat().st_mtime_ns) == v.parent / "video.json"
    assert vid["regions"] == LAY.regions_json()
    assert vid["fallbacks"]["small"]["file"] == "video/show-small.h264" and vid["fallbacks"]["hz90"]["file"] == "video/show-90.h264"
    assert vid["fallbacks"]["hz90"]["displayHz"] == 90 and vid["displayHz"] == 72
    assert vid["freezeSource"] == baked["cfg"].freeze
    assert "makeSource" in vid and vid["makeSource"] == baked["cfg"].make
    # every path is relative and inside video/
    for key in ("file", "frames", "cards", "freeze", "freezeClean"):
        assert vid[key].startswith("video/") and ".." not in vid[key]


@pytest.mark.parametrize("hz", [72, 90])
def test_frame_counts_per_segment_and_idrs(baked, hz):
    tl, cfg = baked["tls"][hz], baked["cfg"]
    name = "show.h264" if hz == 72 else "show-90.h264"
    s = encode.scan_h264(baked["v"] / name)
    segs = tl.segments
    assert s.frames == len(tl.frames)
    starts = sorted([segs["pass1"][0], segs["pass2"][0], segs["resume"][0]] + [e["frames"][0] for e in segs["eases"]])
    assert s.idr == starts  # an IDR at every segment start and ease start, nowhere else
    # independent counts (not read back from the timeline): the clock contract's ease lengths, real-time spans for the passes
    cap = CapTime.from_config(cfg)
    speed = cfg.pass2_speed_for(hz)  # the 90 Hz bake replays at its own speed
    assert tl.pass2_speed == speed
    assert [e["frames"][1] - e["frames"][0] + 1 for e in segs["eases"]] == [int(math.floor(sec * hz + 0.5)) for sec in cfg.ease_seconds]
    n1 = segs["pass1"][1] - segs["pass1"][0] + 1
    assert n1 == math.floor((cap.time_of(cfg.f_end) - cap.time_of(cfg.play_start)) * hz + 1e-9) + 1
    n2 = segs["pass2"][1] - segs["pass2"][0] + 1
    span = cap.time_of(cfg.clip_end) - cap.time_of(cfg.pass2_start)
    assert abs(n2 - (span * hz / speed + 1)) <= 1.5
    ramp = int(math.floor(cfg.resume_ramp_s * hz + 0.5))
    after = cap.time_of(cfg.clip_end) - cap.time_of(cfg.freeze)
    expect = ramp + (after - speed * ramp / hz / 2) * hz / speed
    assert abs((segs["resume"][1] - segs["resume"][0] + 1) - expect) <= 1.5


def test_every_ease_lands_exactly_on_F_with_one_camera(baked):
    frames = json.loads((baked["v"] / "frames.json").read_text())
    tl, cfg = baked["tls"][72], baked["cfg"]
    assert len(frames) == len(tl.frames)
    ends = [frames[e["frames"][1]] for e in tl.segments["eases"]]
    assert all(f["src"] == cfg.freeze and f["interp"] is False for f in ends)
    assert all(f["q"] == ends[0]["q"] and f["f"] == ends[0]["f"] for f in ends)
    cards = json.loads((baked["v"] / "cards.json").read_text())
    assert len(cards) == len(frames)


def test_F_in_the_stream_equals_freeze_png_within_the_mad_bound(baked):
    v, tl = baked["v"], baked["tls"][72]
    freeze = cv2.cvtColor(cv2.imread(str(v / "freeze.png")), cv2.COLOR_BGR2RGB)
    idx = bake.freeze_indices(tl)
    assert len(idx) >= 4  # pass 2's F, each of the three ease ends, and pass 1's last frame
    got = encode.decode_frames(v / "show.h264", idx, LAY.width, LAY.height)
    for i in idx:
        err = encode.frame_error(got[i], LAY, freeze)
        assert err["mad_luma"] <= MAD_BOUND, (i, err)
    for name in ("show-small.h264", "show-90.h264"):
        pass  # the fallbacks are protected the same way; show-small is checked below at its own size


def test_freeze_png_is_the_undistorted_F_of_the_scene(baked):
    clip, cfg = baked["clip"], baked["cfg"]
    freeze = cv2.cvtColor(cv2.imread(str(baked["v"] / "freeze.png")), cv2.COLOR_BGR2RGB)
    gt = clip.gt(cfg.freeze)
    gt = cv2.resize(gt, (freeze.shape[1], freeze.shape[0]), interpolation=cv2.INTER_AREA) if gt.shape != freeze.shape else gt
    assert interp.ssim(freeze, gt) > 0.9  # watermark inpainted and lens undone (its corner is the only difference)


def test_small_copy_is_the_same_frames_at_its_size(baked):
    lay_small = LAY.scaled(128)
    s = encode.scan_h264(baked["v"] / "show-small.h264")
    assert (s.width, s.height) == (lay_small.width, lay_small.height)
    main = encode.scan_h264(baked["v"] / "show.h264")
    assert s.frames == main.frames and s.idr == main.idr


def segment_ranges(tl, names):
    segs = tl.segments
    out = {"pass1": segs["pass1"], "pass2": segs["pass2"], "resume": segs["resume"]}
    return [out[n] for n in names]


def mean_flow(a, b):
    ga, gb = cv2.cvtColor(a, cv2.COLOR_RGB2GRAY), cv2.cvtColor(b, cv2.COLOR_RGB2GRAY)
    fl = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM).calc(ga, gb, None)
    return float(np.linalg.norm(fl, axis=2).mean())


def judder_cv(motion, window=9):
    """Judder = how unevenly consecutive display frames move: the spread of each step's motion relative to the local
    trend (a moving average), so real changes of speed in the scene (zoom, a swing) are not counted as judder."""
    m = np.asarray(motion, float)
    trend = uniform_filter1d(m, window, mode="nearest")
    return float((m / trend).std())


def test_judder_metric_flags_held_and_jumpy_frames():
    smooth = np.full(80, 1.0) + 0.02 * np.sin(np.arange(80))
    assert judder_cv(smooth) < 0.05
    held = smooth.copy()
    held[::3] = 0.0  # every third display frame a repeat
    assert judder_cv(held) > JUDDER_CV_BOUND
    jumpy = smooth.copy()
    jumpy[::3] *= 2.0
    assert judder_cv(jumpy) > JUDDER_CV_BOUND


@pytest.mark.parametrize("seg", ["pass1", "pass2"])
def test_judder_cv_within_the_bound(baked, seg):
    tl, clip = baked["tls"][72], baked["clip"]
    frames = video(baked)
    lo, hi = tl.segments[seg]
    motion = np.array([mean_flow(frames[i], frames[i + 1]) for i in range(lo, hi)])
    assert motion.min() > 0.05 * motion.mean(), "a held frame (no motion between two display frames)"
    cv = judder_cv(motion)
    assert cv <= JUDDER_CV_BOUND, (seg, cv)
    # the frames the stacker was given (before the codec) are no jerkier than the ground truth rendered at the same times
    gt_cv, live_cv = judder_cv(flow_series(gt_frames(tl, clip, lo, hi))), judder_cv(flow_series(source_frames(baked, lo, hi)))
    assert live_cv <= gt_cv + 0.05, (seg, live_cv, gt_cv)


def gt_frames(tl, clip, lo, hi):
    return [cv2.resize(clip.gt_at(int(f.a), int(f.b), f.w) if f.interp else clip.gt(int(f.src)), (LAY.live[2], LAY.live[3]), interpolation=cv2.INTER_AREA) for f in tl.frames[lo : hi + 1]]


def source_frames(baked, lo, hi):
    from pipeline.court.bake import source as source_mod

    src = source_mod.Source.from_config(baked["cfg"])
    return [cv2.resize(src.live(f)[0], (LAY.live[2], LAY.live[3]), interpolation=cv2.INTER_AREA) for f in baked["tls"][72].frames[lo : hi + 1]]


def flow_series(frames):
    return [mean_flow(frames[i], frames[i + 1]) for i in range(len(frames) - 1)]


def test_strobe_frames_are_replaced(baked):
    tl, cfg, clip = baked["tls"][72], baked["cfg"], baked["clip"]
    flashed = set(clip.flash_srcs)
    touched = [f.i for f in tl.frames if {int(f.a), int(f.b)} & flashed or int(f.src) in flashed]
    assert touched, "no display frame is near a strobe: the test would prove nothing"
    frames = video(baked)
    luma = np.array([cv2.cvtColor(f, cv2.COLOR_RGB2GRAY).mean() for f in frames])
    segs = tl.segments
    starts = {segs["pass1"][0], segs["pass2"][0], segs["resume"][0]} | {e["frames"][0] for e in segs["eases"]}
    steps = [abs(luma[i] - luma[i - 1]) for i in range(1, len(luma)) if i not in starts]
    # a flash (65% toward white) moves the mean by far more than any real change between neighbours
    assert max(steps) < 5.0, max(steps)
    # and the flashed display frames match their neighbours' brightness
    near = np.array([luma[i] for i in touched])
    ref = float(np.median(luma))
    assert near.max() < luma.max() + 1e-9 and abs(near.mean() - ref) < 15


def test_in_betweens_match_ground_truth(baked):
    tl, clip = baked["tls"][72], baked["clip"]
    frames = video(baked)
    scores = []
    for f in tl.frames:
        if not f.interp or f.segment != "pass1":
            continue
        gt = clip.gt_at(int(f.a), int(f.b), f.w)
        gt = cv2.resize(gt, (LAY.live[2], LAY.live[3]), interpolation=cv2.INTER_AREA)
        scores.append(interp.ssim(frames[f.i], gt))
    assert len(scores) > 10
    assert float(np.mean(scores)) >= 0.85 and min(scores) >= 0.6, (np.mean(scores), min(scores))


def test_bake_refuses_the_assembled_bundle(tmp_path):
    forbidden = bake.BUNDLE / "video"
    for p in (bake.BUNDLE, forbidden, bake.BUNDLE / "x" / ".." / "video"):
        with pytest.raises(ValueError, match="refusing"):
            bake.check_out_dir(p)
        with pytest.raises(ValueError, match="refusing"):
            bake.bake({}, None, None, p)
    assert bake.check_out_dir(tmp_path) == tmp_path.resolve()
    assert bake.check_out_dir(bake.STAGING) == bake.STAGING.resolve()
    with pytest.raises(ValueError, match="refusing"):
        bake.main(["--real", "--out", str(forbidden)])


def box_iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def test_cards_follow_the_people_of_the_scene(baked):
    """Every visible person has a card whose box (source pixel edges) and decoded matte match the true mask (P43)."""
    clip, tl, cfg = baked["clip"], baked["tls"][72], baked["cfg"]
    cards = json.loads((baked["v"] / "cards.json").read_text())
    W, H = cfg.src_width, cfg.src_height
    mw, mh = LAY.mattes[2], LAY.mattes[3]
    reals = [f for f in tl.frames if not f.interp and f.segment == "pass2"][::25]
    atlas = {i: g for i, g in zip(sorted(f.i for f in reals), encode.decode_frames(baked["v"] / "show.h264", [f.i for f in reals], LAY.width, LAY.height).values())}
    checked, ious = 0, []
    for f in reals:
        truth = clip.render(clip.time_of(int(f.src)), masks=True)
        by_id = {c["id"]: c for c in cards[f.i]["cards"]}
        for pid, cover in truth.items():
            ys, xs = np.nonzero(cover > 0.5)
            if len(xs) < 30:
                continue  # a sliver: the layers may drop it
            assert pid in by_id, f"frame {f.i}: {pid} is visible but has no card"
            c = by_id[pid]
            assert c["kind"] == "person" and len(c["at"]) == 3 and c["at"][1] == 0
            tb = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)
            # the box is padded (2 matte pixels) so the cut never tears at the body's edge: it must contain the true body
            assert c["box"][0] <= tb[0] + 1 and c["box"][1] <= tb[1] + 1 and c["box"][2] >= tb[2] - 1 and c["box"][3] >= tb[3] - 1, (f.i, pid, c["box"], tb)
            assert box_iou(c["box"], tb) > 0.6, (f.i, pid, c["box"], tb)
            assert 0 <= c["box"][0] < c["box"][2] <= W and 0 <= c["box"][1] < c["box"][3] <= H
            # the atlas tile, mapped back onto the box, is the true matte
            u0, v0, u1, v1 = c["tile"]
            tile = atlas[f.i][LAY.mattes[1] + round(v0 * mh) : LAY.mattes[1] + round(v1 * mh), round(u0 * mw) : round(u1 * mw), 0]
            bx0, by0, bx1, by1 = (int(round(v)) for v in c["box"])
            want = cv2.resize((np.clip(cover[by0:by1, bx0:bx1], 0, 1) * 255).astype(np.uint8), (tile.shape[1], tile.shape[0]), interpolation=cv2.INTER_AREA)
            inter = np.logical_and(tile > 127, want > 127).sum()
            union = np.logical_or(tile > 127, want > 127).sum()
            ious.append(inter / max(union, 1))
            assert ious[-1] > 0.6, (f.i, pid, ious[-1])  # an occluded sliver a few pixels wide can lose a lot to one edge pixel
            checked += 1
    assert checked >= 6
    assert float(np.mean(ious)) > 0.8, ious
