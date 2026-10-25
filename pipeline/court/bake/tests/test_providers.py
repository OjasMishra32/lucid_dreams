"""providers.py pieces that need no footage: in-between mattes composed from two neighbours."""

import numpy as np

from pipeline.court.bake import providers as pv


def blob(h, w, box):
    m = np.zeros((h, w), np.uint8)
    m[box[1] : box[3], box[0] : box[2]] = 255
    return m


def test_compose_follows_the_moving_body():
    a, b = blob(100, 200, (20, 20, 40, 80)), blob(100, 200, (60, 24, 80, 84))
    out = pv.compose_matte((200, 100), (40, 22, 60, 82), [(a, (20, 20, 40, 80), 0.5), (b, (60, 24, 80, 84), 0.5)])
    assert out[30:70, 42:58].min() == 255  # the interpolated body is solid
    assert out[:, :36].max() == 0 and out[:, 64:].max() == 0  # and nothing is left where the neighbours were


def test_compose_weights_blend_a_shape_change():
    a, b = blob(100, 200, (20, 20, 60, 80)), np.zeros((100, 200), np.uint8)
    b[20:80, 20:40] = 255  # half the width
    out = pv.compose_matte((200, 100), (20, 20, 60, 80), [(a, (20, 20, 60, 80), 0.75), (b, (20, 20, 60, 80), 0.25)])
    assert out[50, 25] == 255 and abs(int(out[50, 50]) - 191) <= 1


def test_compose_single_part_equals_that_matte_and_resolution_is_free():
    a = blob(50, 100, (10, 10, 30, 40))  # half-resolution matte of a 200x100 live frame
    out = pv.compose_matte((200, 100), (20, 20, 60, 80), [(a, (20, 20, 60, 80), 1.0)])
    assert out.shape == (100, 200) and out[30:70, 25:55].min() == 255 and out[:18].max() == 0


def test_compose_clips_to_the_frame_and_empty_box_is_blank():
    a = blob(100, 200, (150, 20, 200, 80))
    out = pv.compose_matte((200, 100), (170, 20, 230, 80), [(a, (150, 20, 200, 80), 1.0)])
    assert out.shape == (100, 200) and out[40, 190] > 0
    assert not pv.compose_matte((200, 100), (300, 300, 310, 310), [(a, (150, 20, 200, 80), 1.0)]).any()
