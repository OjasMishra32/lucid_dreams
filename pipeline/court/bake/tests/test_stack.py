"""stack.py: the stacked display frame (live / plate / matte atlas) at the format's numbers, on tiny synthetic images.
Run from the repo root: /usr/local/bin/python3 -m pytest pipeline/court/bake/tests/test_stack.py"""

import numpy as np
import pytest

from pipeline.court.bake import stack
from pipeline.court.bake.stack import Layout, MAIN, SMALL


def test_main_layout_is_the_formats_stacked_frame():
    assert (MAIN.width, MAIN.height) == (1536, 2160)
    assert MAIN.live == (0, 0, 1536, 864)
    assert MAIN.plate == (0, 864, 1536, 864)
    assert MAIN.mattes == (0, 1728, 1536, 432)
    assert MAIN.regions_json() == {"live": [0, 0, 1536, 864], "plate": [0, 864, 1536, 864], "mattes": [0, 1728, 1536, 432]}


def test_small_layout_keeps_the_shape():
    assert (SMALL.width, SMALL.height) == (1280, 1800)
    assert SMALL.live == (0, 0, 1280, 720)
    assert SMALL.plate == (0, 720, 1280, 720)
    assert SMALL.mattes == (0, 1440, 1280, 360)


def test_scaled_layout_is_exact_and_even():
    lay = MAIN.scaled(256)
    assert (lay.width, lay.height) == (256, 360)
    assert lay.live == (0, 0, 256, 144) and lay.plate == (0, 144, 256, 144) and lay.mattes == (0, 288, 256, 72)
    with pytest.raises(ValueError):
        MAIN.scaled(255)  # odd widths cannot be encoded as 4:2:0


def rng_image(h, w, seed):
    return np.random.default_rng(seed).integers(0, 256, (h, w, 3), dtype=np.uint8)


def test_stack_places_live_and_plate_exactly():
    lay = MAIN.scaled(256)
    live, plate = rng_image(144, 256, 1), rng_image(144, 256, 2)
    out = stack.stack_frame(lay, live, plate)
    assert out.shape == (360, 256, 3) and out.dtype == np.uint8
    assert np.array_equal(out[0:144], live)
    assert np.array_equal(out[144:288], plate)
    assert not out[288:].any()  # no cards: an empty atlas


def test_live_only_stacking_copies_live_into_the_plate():
    lay = MAIN.scaled(256)
    live = rng_image(144, 256, 3)
    out = stack.stack_frame(lay, live)
    assert np.array_equal(out[0:144], out[144:288])


def test_images_of_other_sizes_are_resized_into_the_regions():
    lay = MAIN.scaled(256)
    live = np.full((540, 960, 3), 200, np.uint8)
    out = stack.stack_frame(lay, live)
    assert out[0:144].min() == 200 and out[0:144].max() == 200


def test_wrong_aspect_is_refused():
    lay = MAIN.scaled(256)
    with pytest.raises(ValueError):
        stack.stack_frame(lay, np.zeros((100, 256, 3), np.uint8))


def make_card(id_, box, tile, order=0):
    return {"id": id_, "foot": [0.0, 0.0, 0.0], "box": list(box), "tile": list(tile), "order": order}


def test_atlas_tile_holds_the_matte_cut_from_the_box():
    lay = MAIN.scaled(256)
    matte = np.zeros((144, 256), np.uint8)
    matte[20:100, 40:60] = 255  # a person
    card = make_card("a", (30, 10, 70, 110), (10, 4, 30, 54))  # a 40x100 box into a 20x50 tile: half size
    live = rng_image(144, 256, 4)
    out = stack.stack_frame(lay, live, cards=[card], mattes={"a": matte})
    atlas = out[lay.mattes[1]:, :, 0]
    tile = atlas[4:54, 10:30]
    # the box's own matte pixels, area-averaged by 2: 10..90 rows of the box are the person
    assert tile[5:45, 5:10].min() == 255
    assert tile[0:4].max() == 0 and tile[:, 0:2].max() == 0 and tile[:, 18:].max() == 0
    # all three channels carry the matte (the stream is grey there)
    assert np.array_equal(out[lay.mattes[1]:, :, 0], out[lay.mattes[1]:, :, 2])
    # nothing outside the tile
    atlas2 = atlas.copy()
    atlas2[4:54, 10:30] = 0
    assert not atlas2.any()


def test_matte_at_another_resolution_is_cropped_by_the_scaled_box():
    lay = MAIN.scaled(256)
    matte = np.zeros((288, 512), np.uint8)  # twice the live region
    matte[40:200, 80:120] = 255
    card = make_card("a", (30, 10, 70, 110), (10, 4, 30, 54))
    out = stack.stack_frame(lay, rng_image(144, 256, 5), cards=[card], mattes={"a": matte})
    tile = out[lay.mattes[1]:, :, 0][4:54, 10:30]
    assert tile[5:45, 5:10].min() == 255


def test_card_without_a_matte_is_an_error():
    lay = MAIN.scaled(256)
    with pytest.raises(KeyError):
        stack.stack_frame(lay, rng_image(144, 256, 6), cards=[make_card("a", (0, 0, 10, 10), (0, 0, 5, 5))], mattes={})
