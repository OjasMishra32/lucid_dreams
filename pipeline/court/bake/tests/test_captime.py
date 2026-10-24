"""captime: source container frame -> true capture time, repeats dropped, strobes flagged (synthetic numbers only)."""
import numpy as np
import pytest

from pipeline.court.bake.captime import CapTime, detect_repeats, check_repeat_phase
from pipeline.court.bake.config import BakeConfig

CFG = BakeConfig()  # synthetic: clip 11-400, F 300, repeats at s % 4 == 3, strobes 330, 331, 342


def ct(cfg=CFG):
    return CapTime.from_config(cfg)


def test_repeats_are_every_fourth_frame_but_the_shots_first_frame_is_real():
    c = ct()
    assert c.is_real(11)  # 11 % 4 == 3, but the shot's first frame has no predecessor in the shot
    assert not c.is_real(15) and not c.is_real(19)
    assert c.is_real(12) and c.is_real(13) and c.is_real(14) and c.is_real(16)
    assert not c.is_real(10) and not c.is_real(401)  # outside the shot


def test_capture_times_are_evenly_spaced_over_real_frames():
    c = ct()
    reals = c.real_frames
    t = np.array([c.time_of(s) for s in reals])
    assert t[0] == 0.0
    assert np.allclose(np.diff(t), 1 / CFG.capture_fps)
    # three real frames per four container frames
    assert c.time_of(16) - c.time_of(12) == pytest.approx(3 / 120)


def test_a_repeat_takes_the_time_of_the_frame_it_repeats():
    c = ct()
    assert c.time_of(299) == c.time_of(298)


def test_strobes_are_real_captures_but_not_usable():
    c = ct()
    assert c.is_real(330) and not c.is_usable(330)
    assert not c.is_real(331)  # the repeat of a strobe
    assert c.is_real(342) and not c.is_usable(342)
    assert c.is_usable(329) and c.is_usable(332)


def test_src_time_map_is_piecewise_linear_through_real_frames_and_inverts():
    c = ct()
    # between 298 and 300 (299 is the repeat): halfway in time is source 299.0
    t = (c.time_of(298) + c.time_of(300)) / 2
    assert c.src_at(t) == pytest.approx(299.0)
    for s in (12.0, 13.5, 298.25, 299.0, 300.0, 333.7):
        assert c.src_at(c.time_of_src(s)) == pytest.approx(s)


def test_sample_snaps_to_real_frames_and_brackets_in_betweens_around_strobes():
    c = ct()
    # exactly on a usable real frame -> real
    s = c.sample(c.time_of(300), tol_frames=0.1)
    assert (s.src, s.interp, s.a, s.b, s.w) == (300, False, 300, 300, 0.0)
    # within tol -> real; outside -> in-between
    dt = 1 / CFG.capture_fps
    assert not c.sample(c.time_of(300) + 0.05 * dt, 0.1).interp
    mid = c.sample(c.time_of(300) + 0.5 * dt, 0.1)
    assert mid.interp and (mid.a, mid.b) == (300, 301) and mid.w == pytest.approx(0.5)
    assert mid.src == pytest.approx(300.5)
    # on the strobe 330: replaced from 329 and 332 (331 is its repeat), src stays 330 (whole), interp True
    st = c.sample(c.time_of(330), 0.1)
    assert st.interp and st.src == pytest.approx(330.0) and (st.a, st.b) == (329, 332)
    assert st.w == pytest.approx(0.5)


def test_sample_refuses_times_outside_the_shot():
    c = ct()
    with pytest.raises(ValueError):
        c.sample(-0.01, 0.1)
    with pytest.raises(ValueError):
        c.sample(c.time_of(400) + 0.01, 0.1)


def _fake_diffs(n, first, mod, phase, noisy=()):
    """diffs[i] = mean |frame i+1 - frame i| for a synthetic clip: ~10 between distinct frames, ~0.05 on repeats."""
    rng = np.random.default_rng(1)
    d = 8 + 4 * rng.random(n - 1)
    for s in range(first + 1, n):
        if s % mod == phase:
            d[s - 1] = 1.0 if s in noisy else 0.05
    d[first - 1] = 70.0  # the cut into the shot
    return d.astype(np.float32)


def test_detect_repeats_finds_the_phase_including_noisy_repeats():
    d = _fake_diffs(420, 11, 4, 3, noisy={63, 187})
    rep = detect_repeats(d, 11, 400)
    assert rep == [s for s in range(12, 401) if s % 4 == 3]
    assert check_repeat_phase(d, CFG) == []


def test_check_repeat_phase_reports_a_wrong_phase():
    d = _fake_diffs(420, 11, 4, 1)
    errors = check_repeat_phase(d, CFG)
    assert errors and "phase" in errors[0]


def test_config_round_trips_and_validates(tmp_path):
    import json

    from pipeline.court.bake import config

    p = tmp_path / "c.json"
    d = config.to_dict(CFG)
    d["_comment"] = "notes are allowed"
    d["play_start"] = 150  # pass 1 may start after pass 2's start (a later start of play)
    p.write_text(json.dumps(d))
    cfg = config.load(p)
    assert cfg.play_start == 150 and cfg.strobes == CFG.strobes and cfg.f_end == CFG.freeze
    d["freeze"] = 299  # a repeat frame
    p.write_text(json.dumps(d))
    with pytest.raises(ValueError, match="repeat"):
        config.load(p)
    d["freeze"], d["bogus"] = 300, 1
    p.write_text(json.dumps(d))
    with pytest.raises(ValueError, match="unknown"):
        config.load(p)
