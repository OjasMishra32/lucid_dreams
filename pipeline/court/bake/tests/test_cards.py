"""cards.py: cards.json entries from people data, tile slots, in-between interpolation. Tiny synthetic numbers only."""

import numpy as np
import pytest

from pipeline.court.bake import cards as cd
from pipeline.court.bake.cards import Person, TileSlots
from pipeline.court.bake.stack import MAIN

LAY = MAIN  # the real format numbers are not private: 1536x2160


def P(id_, box, foot=(0.0, 0.0, 0.0), order=0):
    return Person(id_, tuple(box), (foot[0], 0.0, foot[2]), order)


def tiles_overlap(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def test_box_from_matte_is_the_padded_bounding_box():
    m = np.zeros((100, 200), np.uint8)
    m[20:50, 30:60] = 255
    assert cd.box_from_matte(m, pad=0) == (30, 20, 60, 50)
    assert cd.box_from_matte(m, pad=3) == (27, 17, 63, 53)
    assert cd.box_from_matte(np.zeros((10, 10), np.uint8)) is None
    m2 = np.zeros((100, 200), np.uint8)
    m2[0:5, 0:5] = 255
    assert cd.box_from_matte(m2, pad=3) == (0, 0, 8, 8)  # clipped to the image


def test_slot_is_stable_per_person_across_frames():
    slots = TileSlots(LAY, n_slots=6)
    s1 = slots.assign(["a", "b"])
    s2 = slots.assign(["b", "c", "a"])
    s3 = slots.assign(["c"])
    s4 = slots.assign(["a", "c", "b"])
    assert s2["a"] == s1["a"] and s2["b"] == s1["b"]
    assert s3["c"] == s2["c"] and s4["c"] == s2["c"]
    assert s4["a"] == s1["a"] and s4["b"] == s1["b"]  # held while absent for a frame
    assert len(set(s4.values())) == 3


def test_slot_is_released_after_absence_and_reused():
    slots = TileSlots(LAY, n_slots=2, hold=3)
    slots.assign(["a", "b"])
    for _ in range(4):
        slots.assign(["b"])
    got = slots.assign(["b", "c"])
    assert got["c"] != got["b"]


def test_tiles_are_inside_the_atlas_disjoint_and_keep_the_aspect():
    cards = cd.build_cards(LAY, [P("a", (100, 100, 350, 700)), P("b", (500, 200, 700, 800), order=1)], TileSlots(LAY, 6))
    mx, my, mw, mh = LAY.mattes
    assert [c["id"] for c in cards] == ["a", "b"]
    for c in cards:
        t = c["tile"]
        assert 0 <= t[0] < t[2] <= mw and 0 <= t[1] < t[3] <= mh
        bw, bh = c["box"][2] - c["box"][0], c["box"][3] - c["box"][1]
        assert abs((t[2] - t[0]) / (t[3] - t[1]) - bw / bh) < 0.05
    assert not tiles_overlap(cards[0]["tile"], cards[1]["tile"])


def test_tile_is_never_larger_than_the_box():
    cards = cd.build_cards(LAY, [P("a", (100, 100, 130, 160))], TileSlots(LAY, 6))
    t, b = cards[0]["tile"], cards[0]["box"]
    assert (t[2] - t[0]) <= (b[2] - b[0]) and (t[3] - t[1]) <= (b[3] - b[1])


def test_boxes_are_integers_clipped_to_the_live_region_and_degenerates_dropped():
    cards = cd.build_cards(LAY, [P("a", (-20.4, 10.2, 100.6, 900)), P("gone", (5, 5, 5.2, 400))], TileSlots(LAY, 6))
    assert [c["id"] for c in cards] == ["a"]
    assert cards[0]["box"] == [0, 10, 101, 864]


def test_orders_are_unique_and_front_to_back():
    people = [P("a", (0, 0, 50, 90), order=5), P("b", (60, 0, 110, 90), order=2), P("c", (120, 0, 170, 90), order=9)]
    cards = cd.build_cards(LAY, people, TileSlots(LAY, 6))
    by = {c["id"]: c["order"] for c in cards}
    assert sorted(by.values()) == [0, 1, 2]
    assert by["b"] < by["a"] < by["c"]


def test_foot_is_on_the_floor():
    cards = cd.build_cards(LAY, [P("a", (0, 0, 50, 90), foot=(3.0, 0, -2.0))], TileSlots(LAY, 6))
    assert cards[0]["foot"] == [3.0, 0.0, -2.0]


def test_overflow_drops_the_smallest_and_reports_it():
    slots = TileSlots(LAY, n_slots=2)
    people = [P("big", (0, 0, 100, 300), order=0), P("mid", (200, 0, 280, 200), order=1), P("tiny", (400, 0, 420, 40), order=2)]
    cards = cd.build_cards(LAY, people, slots)
    assert {c["id"] for c in cards} == {"big", "mid"}
    assert slots.dropped == [("tiny", 0)]


def test_track_returns_real_frames_as_they_are():
    a = [P("a", (0, 0, 100, 200), foot=(1, 0, 1), order=0)]
    track = cd.PeopleTrack({10: a, 11: a})
    assert track.at(10.0) == a


def test_in_between_interpolates_box_and_foot_between_neighbours():
    a = [P("a", (0, 0, 100, 200), foot=(0, 0, 0), order=0)]
    b = [P("a", (40, 20, 140, 220), foot=(2, 0, 4), order=0)]
    track = cd.PeopleTrack({10: a, 11: b})
    got = track.at(10.25)
    assert len(got) == 1
    assert got[0].box == pytest.approx((10, 5, 110, 205))
    assert got[0].foot == pytest.approx((0.5, 0.0, 1.0))


def test_in_between_keeps_a_person_only_in_the_nearer_neighbour():
    a = [P("a", (0, 0, 100, 200)), P("leaves", (300, 0, 360, 200), order=1)]
    b = [P("a", (4, 0, 104, 200)), P("enters", (500, 0, 560, 200), order=1)]
    track = cd.PeopleTrack({10: a, 11: b})
    assert {p.id for p in track.at(10.25)} == {"a", "leaves"}
    assert {p.id for p in track.at(10.75)} == {"a", "enters"}


def test_in_between_orders_stay_unique():
    a = [P("a", (0, 0, 50, 90), order=0), P("b", (60, 0, 110, 90), order=1)]
    b = [P("a", (0, 0, 50, 90), order=1), P("b", (60, 0, 110, 90), order=0)]
    got = cd.PeopleTrack({0: a, 1: b}).at(0.4)
    assert sorted(p.order for p in got) == [0, 1]


def test_track_falls_back_to_the_nearest_frame_when_a_source_frame_has_no_entry():
    a = [P("a", (0, 0, 100, 200))]
    track = cd.PeopleTrack({10: a, 14: a}, max_gap=4)
    assert [p.id for p in track.at(12.0)] == ["a"]
    assert cd.PeopleTrack({10: a}, max_gap=1).at(20.0) == []


def test_cards_for_frames_is_one_entry_per_frame_with_stable_tiles():
    people = {s: [P("a", (100 + s, 100, 300 + s, 600), order=0), P("b", (500, 100, 700, 600), order=1)] for s in range(10, 14)}
    out, dropped = cd.cards_for_frames(LAY, [10, 10.5, 11, 12, 13], cd.PeopleTrack(people))
    assert len(out) == 5 and dropped == []
    tiles_a = {tuple(e["cards"][0]["tile"][:2]) for e in out}
    assert len(tiles_a) == 1  # a's tile never moves
    assert all(set(e) == {"cards"} for e in out)
