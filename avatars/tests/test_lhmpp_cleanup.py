import sys
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("scipy")
from scipy.spatial import cKDTree  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lhmpp_cleanup as C  # noqa: E402


def _cloth(rng, n=1500):
    """A 20 x 20 cm patch: a dark jacket with noise on the left, a white shirt on the right."""
    xyz = np.c_[rng.uniform(-0.1, 0.1, n), rng.uniform(0, 0.2, n), np.zeros(n)]
    jacket = xyz[:, 0] < 0
    rgb = np.where(jacket[:, None], [0.12, 0.12, 0.14], [0.92, 0.92, 0.9]) + rng.normal(0, 0.03, (n, 3))
    return xyz, np.clip(rgb, 0, 1), jacket


def test_bilateral_evens_a_fabric_and_keeps_its_edge():
    rng = np.random.default_rng(0)
    xyz, rgb, jacket = _cloth(rng)
    out = C.bilateral_colours(xyz, rgb, passes=4)
    assert out[jacket].std(0).max() < 0.5 * rgb[jacket].std(0).max()  # less mottled
    assert out[~jacket].mean() > 0.85 and out[jacket].mean() < 0.2  # the shirt didn't bleed into the jacket
    assert np.allclose(C.bilateral_colours(xyz, rgb, passes=0), rgb)


def test_even_brightness_touches_only_the_main_fabric():
    rng = np.random.default_rng(1)
    xyz, rgb, jacket = _cloth(rng)
    rgb[jacket & (xyz[:, 1] > 0.1)] *= 1.6  # a light patch on the upper jacket
    part = jacket | (xyz[:, 0] < 0.02)  # the jacket and a strip of shirt by its edge
    out, n = C.even_brightness(xyz, rgb, part, f=1.0)
    lum = out @ C.LUM
    top, bottom = jacket & (xyz[:, 1] > 0.12), jacket & (xyz[:, 1] < 0.08)
    assert abs(lum[top].mean() - lum[bottom].mean()) < 0.5 * abs((rgb @ C.LUM)[top].mean() - (rgb @ C.LUM)[bottom].mean())
    assert np.allclose(out[~jacket], rgb[~jacket])  # the shirt isn't the main fabric
    assert 0 < n <= jacket.sum()


def _flat_hand():
    """A left hand in the rest pose (palm down, fingers along +X): four fingers side by side as cylinders 8 mm in
    radius, their axes 17 mm apart (1 mm gaps), and a short thumb; returns the surface points with outward normals
    (the hand's own vertices too) and a skeleton with the hand's joints."""
    joints = np.zeros((55, 3))
    joints[C.J["left_wrist"]] = [0.0, 0.0, 0.0]
    pts, nrm = [], []
    for k, (f, z) in enumerate((("index", 0.0255), ("middle", 0.0085), ("ring", -0.0085), ("pinky", -0.0255), ("thumb", 0.06))):
        x0 = 0.04 if f != "thumb" else 0.01
        for i in (1, 2, 3):
            joints[C.J[f"left_{f}{i}"]] = [x0 + 0.025 * (i - 1), 0.0, z]
        for x in np.arange(x0 - 0.01, x0 + 0.075, 0.0015):
            for th in np.linspace(0, 2 * np.pi, 48, endpoint=False):
                n = np.array([0.0, np.sin(th), np.cos(th)])
                pts.append([x, 0.0, z] + 0.008 * n)
                nrm.append(n)
    return np.array(pts), np.array(nrm), joints


def test_hand_shading_parts_the_fingers_and_finds_the_nails():
    p, n, joints = _flat_hand()
    shade, nail, palm = C.hand_shading(p, n, p, joints, "left", mottle_amp=0.035)
    middle = np.abs(p[:, 2] - 0.0085) < 0.009
    facing_ring = middle & (n[:, 2] < -0.9)  # the middle finger's side next to the ring finger
    top = middle & (n[:, 1] > 0.9)
    assert np.median(shade[facing_ring]) < 0.8 * np.median(shade[top])  # a dark line between the fingers
    fingers = p[:, 2] < 0.04  # the thumb's nail faces partly sideways
    assert (nail & fingers).any() and (n[nail & fingers, 1] > 0.5).all()  # nails on the backs of the fingertips only
    assert p[nail & middle, 0].min() > joints[C.J["left_middle3"], 0]
    assert palm.any() and (n[palm, 1] < -0.3).all()
    assert 0.4 < shade.min() and shade.max() < 1.2


def _shirt_front(rng, n=12000, tie=True):
    """A torso's front from 5 cm under the collar to the belt: a dark jacket outside |x| > 7 cm; between the lapels
    a white shirt LHM++ garbled with grey blotches and, with a tie, a dark tie down the middle marbled with light."""
    x, y = rng.uniform(-0.14, 0.14, n), rng.uniform(-0.40, 0.0, n)
    xyz = np.c_[x, y, np.full(n, 0.12)]
    rgb = np.tile([0.08, 0.07, 0.07], (n, 1))
    shirt = np.abs(x) < 0.07
    rgb[shirt] = [0.86, 0.85, 0.83]
    grey = shirt & (rng.random(n) < 0.15)
    rgb[grey] = [0.1, 0.1, 0.11]
    tie_m = shirt & (np.abs(x) < 0.02) if tie else np.zeros(n, dtype=bool)
    rgb[tie_m] = [0.19, 0.19, 0.2]
    rgb[tie_m & (rng.random(n) < 0.3)] = [0.7, 0.7, 0.7]
    return xyz, np.clip(rgb + rng.normal(0, 0.01, (n, 3)), 0, 1), shirt, tie_m


def test_shirt_paint_tie_makes_one_white_shirt_and_one_dark_tie():
    rng = np.random.default_rng(3)
    xyz, rgb, shirt, tie_m = _shirt_front(rng)
    out, painted, tied = C.shirt_paint(xyz, rgb, np.ones(len(xyz), dtype=bool), 0.0, -0.40, "tie", jacket_lum=0.07)
    lum, x = out @ C.LUM, xyz[:, 0]
    sides = (np.abs(x) > 0.03) & (np.abs(x) < 0.05)  # the shirt either side of the tie, clear of the lapels
    assert lum[sides].min() > 0.6 and lum[sides].std() < 0.05  # one white: no grey blotches left
    middle = (np.abs(x) < 0.012) & (xyz[:, 1] < -0.01) & (xyz[:, 1] > -0.39)  # the zone's end rows see half a neighbourhood
    assert lum[middle].max() < 0.3  # one tie cloth: no light flecks
    jacket = np.abs(x) > 0.09
    assert np.allclose(out[jacket], rgb[jacket])  # the jacket is untouched
    assert len(painted) > 0 and len(tied) > 0


def test_shirt_paint_open_paints_a_streak_down_an_open_collar():
    rng = np.random.default_rng(4)
    xyz, rgb, shirt, _ = _shirt_front(rng, tie=False)
    rgb[shirt] = [0.86, 0.85, 0.83]  # a clean shirt ...
    streak = (xyz[:, 0] > 0.01) & (xyz[:, 0] < 0.025)
    rgb[streak] = [0.3, 0.22, 0.18]  # ... with a muddy streak down it
    out, painted, tied = C.shirt_paint(xyz, rgb, np.ones(len(xyz), dtype=bool), 0.0, -0.40, "open", jacket_lum=0.07)
    lum = out @ C.LUM
    assert lum[streak].min() > 0.6 and len(tied) == 0
    jacket = np.abs(xyz[:, 0]) > 0.09
    assert np.allclose(out[jacket], rgb[jacket])


def test_collar_mirror_restores_the_missing_side_of_a_collar():
    rng = np.random.default_rng(5)
    n = 4000
    xyz = np.c_[rng.uniform(-0.07, 0.07, n), rng.uniform(-0.05, 0.05, n), np.full(n, 0.1)]
    rgb = np.tile([0.85, 0.84, 0.82], (n, 1))  # a white collar both sides ...
    hole = (xyz[:, 0] > 0.02) & (xyz[:, 0] < 0.05) & (xyz[:, 1] > 0.0)
    rgb[hole] = [0.1, 0.09, 0.09]  # ... but dark on one
    scale = np.log(np.tile([0.002, 0.002, 0.0005], (n, 1)))
    scale[0] = np.log([0.02, 0.002, 0.0005])  # and a needle
    out, sc, ids = C.collar_mirror(xyz, rgb, scale, np.ones(n, dtype=bool), 0.0)
    assert (out[hole] @ C.LUM).min() > 0.7 and set(np.flatnonzero(hole)) <= set(ids)
    assert np.exp(sc[0].max()) <= 3 * 0.002 + 1e-9


def test_collar_mirror_paints_a_spot_on_the_jacket_with_the_jacket():
    rng = np.random.default_rng(6)
    n = 3000
    xyz = np.c_[rng.uniform(-0.07, 0.07, n), rng.uniform(-0.05, 0.05, n), np.full(n, 0.1)]
    rgb = np.tile([0.1, 0.09, 0.09], (n, 1))  # all jacket ...
    spot = np.linalg.norm(xyz[:, :2] - [0.04, 0.02], axis=1) < 0.004
    rgb[spot] = [0.6, 0.45, 0.35]  # ... with a brown spot on it
    shirt = xyz[:, 0] < -0.055
    rgb[shirt] = [0.85, 0.84, 0.82]  # and a white shirt well away from it (and from its mirror image)
    out, _, ids = C.collar_mirror(xyz, rgb, np.log(np.full((n, 3), 0.002)), np.ones(n, dtype=bool), 0.0)
    assert (out[spot] @ C.LUM).max() < 0.2 and set(np.flatnonzero(spot)) <= set(ids)


def test_shirt_surface_fills_the_shirt_without_gaps_and_draws_a_tie():
    # a flat torso front facing +Z (a grid, 5 mm), skinned to spine2, the shirt 14 cm wide, the tie down its middle
    xs, ys = np.arange(-0.12, 0.1201, 0.005), np.arange(-0.45, 0.0501, 0.005)
    gx, gy = np.meshgrid(xs, ys)
    verts = np.c_[gx.ravel(), gy.ravel(), np.full(gx.size, 0.1)]
    nx = len(xs)
    faces = []
    for j in range(len(ys) - 1):
        for i in range(nx - 1):
            a, b, c, d = j * nx + i, j * nx + i + 1, (j + 1) * nx + i, (j + 1) * nx + i + 1
            faces += [[a, b, d], [a, d, c]]  # counter-clockwise seen from +Z: normals point out (+Z)
    faces = np.array(faces)
    lbs = np.zeros((len(verts), 55))
    lbs[:, C.J["spine2"]] = 1.0
    nb = 40
    layout = dict(top=0.0, bottom=-0.40, nb=nb, lo=np.full(nb, -0.07), hi=np.full(nb, 0.07),
                  gap_lo=np.full(nb, -0.02), gap_hi=np.full(nb, 0.02), white=np.array([0.85, 0.84, 0.82]),
                  tie_c=np.array([0.12, 0.12, 0.14]))
    s = C.shirt_surface(verts, faces, lbs, layout, offset=0.02, top_y=-0.02)
    front = s["xyz"][: len(s["xyz"]) // 2]  # the outer layer
    assert np.allclose(front[:, 2], 0.1 + 0.02 + 0.0003, atol=1e-4)  # on the surface, pushed out by the offset
    assert front[:, 0].min() > -0.07 and front[:, 0].max() < 0.07 and front[:, 1].max() <= -0.02
    lum = s["rgb"][: len(front)] @ C.LUM
    tie = lum < 0.3
    assert tie.any() and np.abs(front[tie, 0]).max() < 0.0376  # the tie is a strip down the middle
    low = front[:, 1] < -0.395
    assert not (tie & low).any() or np.abs(front[tie & low, 0]).max() < 0.01  # coming to a point at the bottom
    d = cKDTree(front).query(front, k=2)[0][:, 1]
    assert np.percentile(d, 99) < 2.5 * 0.0025  # no gaps between the discs
    assert (s["q"].sum(1) == 255).all() and (s["idx"][:, 0] == C.J["spine2"]).all()


def test_neck_fill_lies_under_the_skin_in_its_colour_and_bends_as_smplx():
    # a neck: a vertical cylinder (5.5 cm round the neck joint), skinned neck below 8 cm and head above it
    neck_y, R = 0.10, 0.055
    th, ys = np.linspace(-np.pi, np.pi, 73)[:-1], np.arange(0.05, 0.2501, 0.005)
    verts = np.array([[R * np.sin(t), y, R * np.cos(t)] for y in ys for t in th])
    n = len(th)
    faces = []
    for j in range(len(ys) - 1):
        for i in range(n):
            a, b, c, d = j * n + i, j * n + (i + 1) % n, (j + 1) * n + i, (j + 1) * n + (i + 1) % n
            faces += [[a, b, d], [a, d, c]]  # outward normals
    faces = np.array(faces)
    lbs = np.zeros((len(verts), 55))
    lbs[verts[:, 1] < neck_y + 0.08, C.J["neck"]] = 1.0
    lbs[verts[:, 1] >= neck_y + 0.08, C.J["head"]] = 1.0
    joints = np.zeros((55, 3))
    joints[C.J["neck"]] = [0, neck_y, 0]
    joints[C.J["head"]] = [0, neck_y + 0.16, 0]
    rng = np.random.default_rng(3)
    # what's there: skin 2 mm outside SMPL-X, and a dark jacket collar 1.5 cm out at the bottom
    m = 4000
    t, y = rng.uniform(-np.pi, np.pi, m), rng.uniform(0.07, 0.24, m)
    skin = np.c_[(R + 0.002) * np.sin(t), y, (R + 0.002) * np.cos(t)]
    tj, yj = rng.uniform(-np.pi, np.pi, 800), rng.uniform(0.06, 0.1, 800)
    jacket = np.c_[(R + 0.015) * np.sin(tj), yj, (R + 0.015) * np.cos(tj)]
    xyz = np.r_[skin, jacket]
    rgb = np.r_[np.tile([0.78, 0.6, 0.5], (m, 1)), np.tile([0.08, 0.08, 0.09], (800, 1))]
    alpha = np.full(len(xyz), 0.95)
    ref = np.r_[np.ones(m, bool), np.zeros(800, bool)]
    f = C.neck_fill(verts, faces, lbs, joints, xyz, alpha, ref, rgb, bottom_y=neck_y - 0.02, top_front_y=0.19,
                    top_back_y=0.22)
    r = np.hypot(f["xyz"][:, 0], f["xyz"][:, 2])
    assert r.max() <= R + 1e-4 and np.percentile(r, 50) > R - 0.004  # under the skin, never outside SMPL-X
    assert f["xyz"][:, 1].min() >= neck_y - 0.02 - 1e-3 and f["xyz"][:, 1].max() <= 0.22 + 1e-3
    front = f["xyz"][:, 2] > 0.04
    assert f["xyz"][front, 1].max() <= 0.19 + 0.006  # lower at the throat than at the nape
    assert np.allclose(f["rgb"], [0.78, 0.6, 0.5], atol=0.02)  # his skin's colour, never the jacket's
    assert set(np.unique(f["idx"][f["q"] > 0])) <= {C.J["neck"], C.J["head"]} and (f["q"].sum(1) == 255).all()
    half = len(f["xyz"]) // 2
    d = cKDTree(f["xyz"][:half]).query(f["xyz"][:half], k=2)[0][:, 1]
    assert np.percentile(d, 99) < 2.5 * 0.0025  # no gaps


def test_swings_off_finds_what_a_turned_head_leaves_behind():
    # a head on a neck: SMPL-X's surface there follows the head; one Gaussian on it follows the head too (stays),
    # one beside it is skinned to the chest (left behind when the head turns: a wisp)
    from lucid_avatars.skinning import NUM_JOINTS

    joints = np.zeros((NUM_JOINTS, 3))
    joints[C.J["spine3"]] = [0, 0.0, 0]
    joints[C.J["neck"]] = [0, 0.1, 0]
    joints[C.J["head"]] = [0, 0.25, 0]
    th = np.linspace(-np.pi, np.pi, 60, endpoint=False)
    # an oval neck and head, deeper than wide and set forward of the joints (a real neck isn't a cylinder round them)
    verts = np.array([[0.045 * np.sin(t), y, 0.02 + 0.075 * np.cos(t)] for y in np.arange(0.12, 0.3, 0.005) for t in th])
    lbs = np.zeros((len(verts), 55))
    lbs[:, C.J["head"]] = 1.0
    xyz = np.array([[0.0, 0.2, -0.056], [0.0, 0.2, -0.0565]])  # at the nape, on the surface
    idx = np.zeros((2, 4), np.uint8)
    idx[0, 0], idx[1, 0] = C.J["head"], C.J["spine3"]
    q = np.zeros((2, 4), np.uint8)
    q[:, 0] = 255
    out = C.swings_off(xyz, idx, q, verts, lbs, joints, off_m=0.005)
    assert not out[0] and out[1]
