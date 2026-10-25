"""timeline: every display frame at n / displayHz -> a source time, per segment (synthetic config only)."""
import dataclasses
import math

import pytest

from pipeline.court.bake.captime import CapTime
from pipeline.court.bake.config import BakeConfig
from pipeline.court.bake import timeline as T

CFG = BakeConfig()  # synthetic: shot 12-400, pass 2 from 120, F 300, make 380, strobes 331 (+332 repeat), 341
# "Every pass-2 frame is a real captured frame" holds when capture_fps x pass2_speed == the display rate. The synthetic
# defaults keep the design speeds (0.6 / 0.75), which do not satisfy that at the synthetic capture rate (their pass 2
# is mostly in-betweens, and every other test here runs on them), so the checks of that rule use speeds that do.
ALIGNED = dataclasses.replace(CFG, pass2_speed=72 / CFG.capture_fps, pass2_speed_90=90 / CFG.capture_fps)


@pytest.fixture(scope="module", params=[72, 90])
def tl(request):
    return T.build(CFG, request.param)


def test_ease_lengths_follow_the_clock_contract():
    assert [T.ease_frame_count(s, 72) for s in CFG.ease_seconds] == [86, 72, 58]
    assert [T.ease_frame_count(s, 90) for s in CFG.ease_seconds] == [108, 90, 72]
    # the ease of n frames entered at 0.6x covers 0.6 n / hz / 2 seconds of real time (1.2 s -> ~0.36 s)
    assert T.ease_tau(0, 86, 72, 0.6) == pytest.approx(-0.6 * 86 / 72 / 2)
    assert T.ease_tau(86, 86, 72, 0.6) == 0.0
    assert T.resume_tau(58, 58, 72, 0.6) == pytest.approx(0.6 * 58 / 72 / 2)


def test_segments_are_inclusive_contiguous_and_never_overlap(tl):
    s = tl.segments
    ranges = [s["pass1"], s["pass2"]] + [e["frames"] for e in s["eases"]] + [s["resume"]]
    assert ranges[0][0] == 0
    for prev, nxt in zip(ranges, ranges[1:]):
        assert nxt[0] == prev[1] + 1
    assert ranges[-1][1] == len(tl.frames) - 1
    for i, f in enumerate(tl.frames):
        assert f.i == i


def test_pass1_is_real_speed_from_the_start_of_play_to_F(tl):
    c = CapTime.from_config(CFG)
    p = tl.frames_of("pass1")
    assert p[-1].src == CFG.freeze and not p[-1].interp
    assert c.time_of(CFG.play_start) <= p[0].t < c.time_of(CFG.play_start) + 1 / tl.hz
    steps = {round(b.t - a.t, 9) for a, b in zip(p, p[1:])}
    assert steps == {round(1 / tl.hz, 9)}


def test_pass2_runs_from_its_start_through_the_make_to_the_clip_end(tl):
    c = CapTime.from_config(CFG)
    p = tl.frames_of("pass2")
    assert c.time_of(CFG.pass2_start) <= p[0].t < c.time_of(CFG.pass2_start) + CFG.pass2_speed_for(tl.hz) / tl.hz
    assert p[-1].t <= c.time_of(CFG.clip_end) < p[-1].t + CFG.pass2_speed_for(tl.hz) / tl.hz + 1e-9
    assert any(f.src == CFG.freeze and not f.interp for f in p)  # F lies on pass 2's grid
    steps = {round(b.t - a.t, 9) for a, b in zip(p, p[1:])}
    assert steps == {round(CFG.pass2_speed_for(tl.hz) / tl.hz, 9)}


def test_every_pass2_frame_at_72hz_is_real_except_the_strobes():
    tl = T.build(ALIGNED, 72)
    p = tl.frames_of("pass2")
    interp = [f for f in p if f.interp]
    assert {round(f.src) for f in interp} == {331, 341}
    assert all(float(f.src).is_integer() for f in interp)  # strobe replacements keep their own whole index
    assert all(float(f.src).is_integer() for f in p)


def test_each_ease_starts_from_a_pass2_frame_and_lands_exactly_on_F(tl):
    eases = tl.segments["eases"]
    p2 = tl.segments["pass2"]
    assert [e["seconds"] for e in eases] == [pytest.approx(s, abs=1 / tl.hz) for s in CFG.ease_seconds]
    starts = [e["start"] for e in eases]
    assert starts == sorted(starts) and len(set(starts)) == 3
    for e in eases:
        assert p2[0] <= e["start"] <= p2[1]
        first, last = e["frames"]
        n = last - first + 1
        assert n == T.ease_frame_count(e["seconds"], tl.hz)
        entry = tl.frames[e["start"]]
        # the entry frame is exactly where the ease's speed curve starts: n/2 pass-2 steps before F
        assert entry.tau == pytest.approx(-CFG.pass2_speed_for(tl.hz) * n / tl.hz / 2, abs=1e-12)
        assert not tl.frames[last].interp and tl.frames[last].src == CFG.freeze
        assert tl.frames[last].tau == 0.0
    assert tl.cutoff == starts[-1]


def test_resume_ramps_from_F_to_pass2_speed_then_steady_to_the_clip_end(tl):
    r = tl.frames_of("resume")
    n = T.ease_frame_count(CFG.resume_ramp_s, tl.hz)
    assert r[0].tau > 0 and r[0].tau < 1e-3  # first resume frame barely leaves F
    steady = r[n:]
    steps = {round(b.tau - a.tau, 9) for a, b in zip(steady, steady[1:])}
    assert steps == {round(CFG.pass2_speed_for(tl.hz) / tl.hz, 9)}
    c = CapTime.from_config(CFG)
    assert r[-1].t <= c.time_of(CFG.clip_end)


def test_after_the_resume_ramp_every_72hz_frame_is_real_except_strobes():
    tl = T.build(ALIGNED, 72)
    r = tl.frames_of("resume")[T.ease_frame_count(ALIGNED.resume_ramp_s, 72):]
    assert {round(f.src) for f in r if f.interp} <= {331, 341}


def test_real_frames_are_whole_and_in_betweens_carry_their_bracket(tl):
    c = CapTime.from_config(CFG)
    for f in tl.frames:
        if not f.interp:
            assert float(f.src).is_integer() and c.is_usable(int(f.src)) and f.a == f.b == f.src
        else:
            assert c.is_usable(f.a) and c.is_usable(f.b) and f.a < f.b and 0 <= f.w <= 1
            assert c.time_of(f.a) <= f.t <= c.time_of(f.b)


def test_speed_and_motion_rules_hold(tl):
    m = T.check(tl, CFG)
    assert m["errors"] == []
    assert m["max_speed_change"] <= 0.02
    assert m["max_motion_ratio"] <= 2.5


def test_idr_frames_are_the_segment_starts(tl):
    s = tl.segments
    want = sorted([s["pass1"][0], s["pass2"][0], s["resume"][0]] + [e["frames"][0] for e in s["eases"]])
    assert tl.idr == want


def test_format_block_has_the_contract_fields(tl):
    v = tl.format_block()
    assert set(v) == {"displayHz", "pass2Speed", "segments", "cutoff", "freezeSource", "makeSource"}
    assert v["makeSource"] == CFG.make
    assert set(v["segments"]) == {"pass1", "pass2", "resume", "eases"}
    assert v["freezeSource"] == CFG.freeze and v["cutoff"] == tl.cutoff


def test_an_odd_ease_frame_count_is_refused():
    cfg = dataclasses.replace(CFG, ease_seconds=(1.2, 1.0, 0.8125))  # 0.8125 * 72 = 58.5 -> 58 ok; use 90 Hz: 73
    with pytest.raises(ValueError, match="even"):
        T.build(cfg, 90)


def test_pass2_too_short_for_the_longest_ease_is_refused():
    cfg = dataclasses.replace(CFG, pass2_start=290)
    with pytest.raises(ValueError, match="pass 2"):
        T.build(cfg, 72)


def test_pass1_start_is_a_single_config_value():
    later = dataclasses.replace(CFG, play_start=100)
    a, b = T.build(CFG, 72), T.build(later, 72)
    assert len(b.frames_of("pass1")) < len(a.frames_of("pass1"))
    assert b.frames_of("pass2")[0].src == a.frames_of("pass2")[0].src


def test_ease_curve_matches_clock_ts_when_node_is_available():
    from pipeline.court.bake import cameras

    got = cameras.run_clock_ts_curves([(86, 72), (58, 72), (108, 90)], 0.6)
    if got is None:
        pytest.skip("node or origin/court-side's clock.ts not available")
    for (n, hz), curve in got.items():
        ours = [T.ease_tau(k, n, hz, 0.6) for k in range(n + 1)] + [T.resume_tau(k, n, hz, 0.6) for k in range(1, n + 3)]
        assert max(abs(x - y) for x, y in zip(ours, curve)) < 1e-12


def test_hz90_has_its_own_pass2_speed_and_72hz_keeps_its_own():
    assert CFG.pass2_speed_for(72) == 0.6 and CFG.pass2_speed_for(90) == 0.75
    assert T.build(CFG, 72).pass2_speed == 0.6
    tl = T.build(CFG, 90)
    assert tl.pass2_speed == 0.75
    assert tl.format_block()["pass2Speed"] == 0.75
    assert tl.fallback_block() == {"displayHz": 90, "pass2Speed": 0.75, "segments": tl.segments, "cutoff": tl.cutoff}
    # unset falls back to the main speed
    same = dataclasses.replace(CFG, pass2_speed_90=None)
    assert same.pass2_speed_for(90) == 0.6 and T.build(same, 90).pass2_speed == 0.6


def test_every_pass2_frame_at_90hz_with_its_own_speed_is_real_except_the_strobes():
    tl = T.build(ALIGNED, 90)
    p = tl.frames_of("pass2")
    assert {round(f.src) for f in p if f.interp} == {331, 341}
    assert all(float(f.src).is_integer() for f in p)
    # every ease is entered at the 90 Hz speed from a real pass-2 frame, and the resume ramps up to it
    for e in tl.segments["eases"]:
        assert not tl.frames[e["start"]].interp
    r = tl.frames_of("resume")[T.ease_frame_count(ALIGNED.resume_ramp_s, 90):]
    assert {round(b.tau - a.tau, 9) for a, b in zip(r, r[1:])} == {round(ALIGNED.pass2_speed_90 / 90, 9)}
    assert {round(f.src) for f in r if f.interp} <= {331, 341}
    m = T.check(tl, ALIGNED)
    assert m["errors"] == [] and m["max_speed_change"] <= 0.02 and m["max_motion_ratio"] <= 2.5


def test_the_make_is_shown_in_pass2_and_the_resume_and_the_play_runs_on_after_it(tl):
    for seg in ("pass2", "resume"):
        fr = tl.frames_of(seg)
        assert fr[0].src < CFG.make < fr[-1].src  # the make one-shot fires as the show passes it
    assert T.check(tl, CFG)["errors"] == []


def test_a_make_after_the_clip_end_is_reported():
    cfg = dataclasses.replace(CFG, clip_end=CFG.make)
    m = T.check(T.build(cfg, 72), cfg)
    assert any("make" in e for e in m["errors"])


def test_a_held_frame_in_pass1_or_pass2_is_reported():
    tl = T.build(CFG, 90)
    k = tl.segments["pass2"][0] + 10
    held = dataclasses.replace(tl.frames[k + 1], t=tl.frames[k].t)
    tl.frames[k + 1] = held
    assert any("held" in e and "pass2" in e for e in T.check(tl, CFG)["errors"])


def test_a_short_resume_that_is_mostly_ramp_passes():
    cfg = dataclasses.replace(CFG, clip_end=330, make=320, strobes=())
    for hz in (72, 90):
        m = T.check(T.build(cfg, hz), cfg)
        assert m["errors"] == [], m["errors"]


def test_shown_times_follow_the_ideal_curve_within_the_snap_allowance(tl):
    m = T.check(tl, CFG)
    assert m["max_offset_frames"] <= max(CFG.snap_tol, CFG.near_real) + 1e-9


def test_in_betweens_within_near_real_of_a_capture_show_the_real_frame(tl):
    c = CapTime.from_config(CFG)
    for f in tl.frames:
        if f.interp:
            d = min(f.w, 1 - f.w) * (c.time_of(f.b) - c.time_of(f.a)) * CFG.capture_fps
            assert d >= CFG.near_real - 1e-9
    # the frames next to F in every ease and at the resume's start are F itself, a real frame
    for e in tl.segments["eases"]:
        assert not tl.frames[e["frames"][1] - 1].interp
    assert not tl.frames_of("resume")[0].interp


def test_consumers_recover_a_b_w_from_frames_json_src(tl):
    c = CapTime.from_config(CFG)
    for f in tl.frames:
        a, b, w = c.bracket(f.src)
        assert (a, b) == (f.a, f.b) and w == pytest.approx(f.w, abs=1e-9)
        if f.interp and float(f.src).is_integer():
            assert int(f.src) in c.strobes  # only a strobe replacement has a whole src and interp true
