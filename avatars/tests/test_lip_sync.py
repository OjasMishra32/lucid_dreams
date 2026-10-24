"""lip_sync.py: the plain parts of the SyncNet before/after number (the renders and SyncNet itself need a GPU)."""

import json
import math

import numpy as np
import pytest

from lucid_avatars import face_expr as F
from lucid_avatars import lip_sync as S
from lucid_avatars.lips import MOUTH_CHANNELS

# what SyncNetInstance.evaluate logs (its logging format) and what older checkouts print
LOGGED = """2026-10-24 04:30:01,123 SyncNetInstance INFO: Framewise conf:
2026-10-24 04:30:01,124 SyncNetInstance INFO: [ 3.1  2.9  3.4]
2026-10-24 04:30:01,125 SyncNetInstance INFO: AV offset: \t2
2026-10-24 04:30:01,125 SyncNetInstance INFO: Min dist: \t7.412
2026-10-24 04:30:01,125 SyncNetInstance INFO: Confidence: \t3.907
"""
PRINTED = "AV offset: \t-3 \nMin dist: \t9.001\nConfidence: \t1.250\n"


# ---------------------------------------------------------------- SyncNet's output

def test_parse_syncnet_reads_the_logged_lines():
    assert S.parse_syncnet(LOGGED) == {"offset": 2, "dist": 7.412, "conf": 3.907}


def test_parse_syncnet_reads_the_old_printed_lines_and_negative_numbers():
    assert S.parse_syncnet(PRINTED) == {"offset": -3, "dist": 9.001, "conf": 1.25}
    assert S.parse_syncnet("Confidence: -0.5\nMin dist: 10.0\nAV offset: 0")["conf"] == -0.5


def test_parse_syncnet_takes_the_last_report_when_there_are_several():
    assert S.parse_syncnet(PRINTED + LOGGED)["conf"] == 3.907


@pytest.mark.parametrize("text", ["", "AV offset: 1\nMin dist: 7.0\n", "Min dist: 7\nConfidence: 3\n",
                                  "AV offset: 1\nMin dist: nan\nConfidence: 3.0\n"])
def test_parse_syncnet_refuses_an_incomplete_or_nonfinite_report(text):
    with pytest.raises(ValueError):
        S.parse_syncnet(text)


# ---------------------------------------------------------------- before: the idle with no mouth

def test_before_expr_zeroes_the_mouth_channels_and_keeps_the_blink():
    rng = np.random.default_rng(0)
    expr = rng.uniform(0.1, 1.0, size=(40, len(MOUTH_CHANNELS)))
    before = S.before_expr(expr, MOUTH_CHANNELS)
    assert before.shape == expr.shape
    assert np.all(before[:, :9] == 0)
    np.testing.assert_array_equal(before[:, 9], expr[:, 9])
    assert expr[:, :9].min() > 0  # the input is untouched


def test_before_expr_goes_by_channel_name_not_position():
    channels = ["blink", "mouth0", "flame3", "mouth1"]
    expr = np.ones((5, 4))
    assert S.before_expr(expr, channels).tolist() == [[1, 0, 1, 0]] * 5


def test_before_expr_refuses_a_bundle_with_no_mouth_channels_or_a_misshaped_expr():
    with pytest.raises(ValueError, match="mouth"):
        S.before_expr(np.ones((5, 10)), F.EXPR_CHANNELS)  # a head swap with FLAME: nothing to zero, nothing to compare
    with pytest.raises(ValueError, match="channels"):
        S.before_expr(np.ones((5, 3)), MOUTH_CHANNELS)


# ---------------------------------------------------------------- 25 fps

def test_frame_plan_gives_25_fps_frames_over_the_clip_and_the_nearest_motion_frame():
    n, idx = S.frame_plan(n_src=300, fps_src=30.0, clip_s=10.0)
    assert n == 250 and len(idx) == 250
    assert idx[0] == 0 and idx[-1] == round(249 / 25 * 30)
    assert np.all(np.diff(idx) >= 1)  # 30 -> 25 skips frames, never repeats or goes back
    assert S.FPS == 25


def test_frame_plan_upsamples_slower_motion_by_repeating_the_nearest():
    n, idx = S.frame_plan(n_src=100, fps_src=10.0, clip_s=4.0)
    assert n == 100 and idx.max() <= 99 and (np.diff(idx) >= 0).all()


def test_frame_plan_drops_the_partial_last_frame_so_audio_and_video_match():
    n, _ = S.frame_plan(n_src=400, fps_src=30.0, clip_s=10.03)
    assert n == 250


def test_frame_plan_refuses_a_clip_the_motion_does_not_cover_or_one_too_short_for_syncnet():
    with pytest.raises(ValueError, match="covers"):
        S.frame_plan(n_src=100, fps_src=30.0, clip_s=10.0)
    with pytest.raises(ValueError, match="short"):
        S.frame_plan(n_src=300, fps_src=30.0, clip_s=1.0)


def test_resample_expr_interpolates_linearly_to_25_fps():
    expr = np.stack([np.arange(31, dtype=float)] * 3, axis=1)  # 30 fps ramp, 1 s
    out = S.resample_expr(expr, 30.0, 25)
    assert out.shape == (25, 3)
    np.testing.assert_allclose(out[:, 0], np.arange(25) / 25 * 30)


# ---------------------------------------------------------------- the camera and the crops

def test_front_angle_puts_the_camera_in_front_of_whichever_way_the_avatar_faces():
    sys_path = __import__("sys").path
    from pathlib import Path
    sys_path.insert(0, str(Path(__file__).parents[2] / "pipeline"))
    from lucid.export import orbit_camera

    for forward in ([0.0, 0.0, 1.0], [0.0, 0.0, -1.0], [1.0, 0.0, 0.0], [0.6, 0.3, -0.8]):
        c2w = np.linalg.inv(orbit_camera(S.front_angle(forward), 1.0, 0.0, 0.0, (0.0, 0.0)))
        f = np.array(forward) * [1, 0, 1]
        f /= np.linalg.norm(f)
        np.testing.assert_allclose(c2w[:3, 3], f, atol=1e-9)           # the camera stands where the face looks
        np.testing.assert_allclose(c2w[:3, 2], -f, atol=1e-9)          # and looks back at it


def test_front_angle_refuses_a_face_looking_straight_up_or_down():
    with pytest.raises(ValueError):
        S.front_angle([0.0, 1.0, 0.0])


def test_box_down_averages_k_by_k_blocks_to_224():
    img = np.zeros((672, 672, 3), dtype=np.uint8)
    img[:3, :3] = 90
    out = S.box_down(img, 3)
    assert out.shape == (224, 224, 3) and out.dtype == np.uint8
    assert out[0, 0].tolist() == [90, 90, 90] and out[0, 1].tolist() == [0, 0, 0]
    with pytest.raises(ValueError):
        S.box_down(np.zeros((100, 100, 3), np.uint8), 3)


def test_render_size_is_a_whole_multiple_of_the_crop():
    assert S.render_size(3) == 672 and S.CROP_PX == 224


# ---------------------------------------------------------------- the report

def test_sync_report_has_before_after_and_the_delta():
    before = {"offset": -3, "dist": 9.0, "conf": 1.25}
    after = {"offset": 1, "dist": 7.0, "conf": 4.5}
    r = S.sync_report(before, after, person="vishal", bundle="vishal-head-voice", clip_s=12.3456, frames=308,
                      model="syncnet_v2.model")
    assert r["before"] == before and r["after"] == after
    assert r["deltaConf"] == 3.25 and r["deltaDist"] == -2.0
    assert r["fps"] == 25 and r["clipS"] == 12.346 and r["frames"] == 308 and r["model"] == "syncnet_v2.model"
    assert r["improved"] is True and r["person"] == "vishal" and r["bundle"] == "vishal-head-voice"
    assert "front face render" in r["note"] and "not the Quest" in r["note"]
    json.dumps(r)


def test_sync_report_says_so_when_the_voice_driven_mouth_did_not_beat_idle():
    r = S.sync_report({"offset": 0, "dist": 8.0, "conf": 3.0}, {"offset": 0, "dist": 8.5, "conf": 2.0},
                      person="vishal", bundle="b", clip_s=5.0, frames=125, model="m")
    assert r["improved"] is False and r["deltaConf"] == -1.0


def test_sync_line_is_the_one_log_line():
    r = S.sync_report({"offset": 0, "dist": 8.0, "conf": 1.234}, {"offset": 0, "dist": 7.0, "conf": 5.6789},
                      person="vishal", bundle="b", clip_s=5.0, frames=125, model="m")
    assert S.sync_line(r) == "SYNC conf before 1.23 after 5.68"


def test_sync_report_refuses_a_missing_or_nonfinite_score():
    with pytest.raises(ValueError):
        S.sync_report({"offset": 0, "dist": 8.0}, {"offset": 0, "dist": 7.0, "conf": 1.0}, person="p", bundle="b",
                      clip_s=5.0, frames=125, model="m")
    with pytest.raises(ValueError):
        S.sync_report({"offset": 0, "dist": 8.0, "conf": math.nan}, {"offset": 0, "dist": 7.0, "conf": 1.0},
                      person="p", bundle="b", clip_s=5.0, frames=125, model="m")


# ---------------------------------------------------------------- the consent gate

def _bundle(tmp_path, dream_id="vishal-head-voice", voice_person="vishal", lips=True):
    b = tmp_path / dream_id
    b.mkdir()
    (b / "dream.json").write_text(json.dumps({"id": dream_id, "source": {"voice": {"person": voice_person}}}))
    if lips:
        (b / "lips.json").write_text("{}")
    return b


def test_gate_passes_vishals_own_voice_bundle(tmp_path):
    assert S.sync_consent_errors("vishal", _bundle(tmp_path)) == []


def test_gate_refuses_anyone_without_voice_consent_and_never_a_public_figure(tmp_path):
    errors = S.sync_consent_errors("magnus-carlsen", _bundle(tmp_path, "magnus-carlsen-lhm", "magnus-carlsen"))
    assert errors and "voice" in errors[0]
    assert S.sync_consent_errors("ian-grandma", _bundle(tmp_path, "ian-grandma-head-voice", "ian-grandma"))


def test_gate_refuses_a_held_id(tmp_path):
    b = _bundle(tmp_path)
    (tmp_path / ".held").write_text("vishal-head-voice\n")
    assert any(".held" in e for e in S.sync_consent_errors("vishal", b))


def test_gate_refuses_a_bundle_that_is_not_a_lips_bundle_or_not_that_persons_voice(tmp_path):
    assert any("lips.json" in e for e in S.sync_consent_errors("vishal", _bundle(tmp_path, lips=False)))
    other = tmp_path / "other"
    other.mkdir()
    assert any("voice" in e for e in S.sync_consent_errors("vishal", _bundle(other, voice_person="someone-else")))


def test_gate_refuses_before_reading_anything_when_the_bundle_is_missing(tmp_path):
    with pytest.raises(FileNotFoundError):  # dream.json is what names the id; no folder, no id, no run
        S.sync_consent_errors("vishal", tmp_path / "nope")
