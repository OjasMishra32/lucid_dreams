import numpy as np
import pytest

from lucid_avatars import face_expr as F

EYE_C = {"left": np.array([0.032, 0.03, 0.05]), "right": np.array([-0.032, 0.03, 0.05])}
EYE_R = 0.012
RING = 15  # lid vertices per row: the margin round the opening, then a second row of lid skin, staggered


def _lid_point(c, a, half_w, half_h, radius):
    x, y = half_w * np.cos(a), half_h * np.sin(a)
    z = np.sqrt(np.maximum(radius ** 2 - x ** 2 - y ** 2, 0.002 ** 2))
    return c + np.stack([x, y, z], axis=-1)


def place_eyes(v, centres, rng):
    """Puts FLAME-like eyes into v (in place) and returns their faces: per eye a 12 mm eyeball at FLAME's ids and
    two rows of lid at LAM's eyelid ids, the margin round an open almond (28 x 10 mm) and a second row staggered half
    a step round it (the case that folds a lid when the margin is guessed from spacing), joined by a strip of faces
    whose inner edge is the opening. Spare lid ids sit further out, in no face."""
    faces = []
    for c, (eyeball, lid) in zip(centres, F.EYES):
        d = rng.normal(size=(len(eyeball), 3))
        v[eyeball] = c + EYE_R * d / np.linalg.norm(d, axis=1, keepdims=True)
        a = 2 * np.pi * np.arange(RING) / RING
        inner, outer, spare = lid[:RING], lid[RING:2 * RING], lid[2 * RING:]
        v[inner] = _lid_point(c, a, 0.014, 0.005, 0.0135)
        v[outer] = _lid_point(c, a + np.pi / RING, 0.017, 0.009, 0.0145)
        v[spare] = _lid_point(c, np.linspace(0.3, 2.8, len(spare)), 0.021, 0.013, 0.0155)
        for k in range(RING):
            k1 = (k + 1) % RING
            faces += [[inner[k], inner[k1], outer[k]], [inner[k1], outer[k1], outer[k]]]
    return np.array(faces)


def _toy_flame(seed=0):
    """FLAME-like: 5023 vertices and the eye faces (place_eyes); the rest of the face keeps 3 cm clear of the eyes."""
    rng = np.random.default_rng(seed)
    v = rng.uniform([-0.09, -0.12, -0.08], [0.09, 0.12, 0.1], size=(F.FLAME_VERTS, 3))
    for c in EYE_C.values():
        near = np.linalg.norm(v - c, axis=1) < 0.03
        v[near] += (v[near] - c) / np.linalg.norm(v[near] - c, axis=1, keepdims=True) * 0.03
    faces = place_eyes(v, EYE_C.values(), rng)
    return v, faces


def _gap(p, side_ids, start):
    """Upper margin minus lower margin over the middle of the eye: the margin row (the first RING lid ids), upper and
    lower by where each vertex was at the start."""
    eyeball, lid = side_ids
    c = np.mean(start[eyeball], axis=0)
    inner = lid[:RING]
    mid = inner[np.abs(start[inner, 0] - c[0]) < 0.006]
    up, lo = mid[start[mid, 1] > c[1]], mid[start[mid, 1] <= c[1]]
    return p[up, 1].min() - p[lo, 1].max()


def test_blink_target_brings_the_lids_together_over_the_eye():
    v, faces = _toy_flame()
    t = F.blink_target(v, faces)
    for eyeball, lid in F.EYES:
        c = v[eyeball].mean(0)
        up, lo = lid[v[lid, 1] > c[1]], lid[v[lid, 1] <= c[1]]
        assert (t[up, 1] <= 1e-12).all() and t[up, 1].min() < -0.003  # the upper lid comes down
        assert (t[lo, 1] >= -1e-12).all() and t[lo, 1].max() < -t[up, 1].min()  # the lower one rises less
        moved = v + t
        assert _gap(moved, (eyeball, lid), v) < 0.05 * _gap(v, (eyeball, lid), v)
        # the lids slide over the eye, never into it
        assert (np.linalg.norm(moved[lid] - c, axis=1) >= np.linalg.norm(v[lid] - c, axis=1) - 1e-9).all()
    others = np.setdiff1d(np.arange(F.FLAME_VERTS), np.concatenate([lid for _, lid in F.EYES]))
    assert np.abs(t[others]).max() == 0


def test_blink_never_folds_the_second_row_of_lid_over_the_margin():
    v, faces = _toy_flame()
    moved = v + F.blink_target(v, faces)
    for eyeball, lid in F.EYES:
        c = v[eyeball].mean(0)
        inner, outer = lid[:RING], lid[RING:2 * RING]
        mu, mo = inner[v[inner, 1] > c[1]], outer[v[outer, 1] > c[1]]
        order = np.argsort(moved[mu, 0])
        margin_after = np.interp(moved[mo, 0], moved[mu, 0][order], moved[mu, 1][order])
        assert (moved[mo, 1] >= margin_after - 1e-4).all()  # the skin above the margin stays above it


def test_blink_refuses_lids_it_cannot_shut():
    v, faces = _toy_flame()
    eyeball, lid = F.EYES[0]
    c = v[eyeball].mean(0)
    flat = v.copy()
    flat[lid[:RING], 1] = c[1] + 0.004  # the whole margin above the eye's centre: no lower lid to meet
    with pytest.raises(ValueError, match="lower eyelid"):
        F.blink_target(flat, faces)
    with pytest.raises(ValueError, match="no eye opening"):
        F.blink_target(v, np.array([[0, 1, 2]]))


def test_blink_closes_the_eyes_even_when_flames_expressions_cant():
    v, faces = _toy_flame()
    dirs = np.random.default_rng(1).normal(scale=1e-3, size=(F.FLAME_VERTS, 3, 100))  # nothing like a blink
    field, report = F.blink_field(v, dirs, faces)
    moved = v + field
    for eyes in F.EYES:
        assert _gap(moved, eyes, v) < 0.1 * _gap(v, eyes, v)
    assert report["openFraction"] < 0.1
    eyeballs = np.concatenate([e for e, _ in F.EYES])
    assert np.abs(field[eyeballs]).max() == 0  # the eyes themselves never move
    far = np.min([np.linalg.norm(v - c, axis=1) for c in EYE_C.values()], axis=0) > F.NEAR * EYE_R
    assert np.linalg.norm(field[far], axis=1).max() <= F.LEAK_MAX_M + 1e-9
    assert report["leakMm"] <= F.LEAK_MAX_M * 1000 + 1e-6


def test_blink_needs_no_help_from_a_basis_that_never_moves():
    v, faces = _toy_flame()
    field, report = F.blink_field(v, np.zeros((F.FLAME_VERTS, 3, 100)), faces)
    assert report["openFraction"] < 0.1 and report["pcaShare"] == 0
    assert np.isfinite(field).all()
    lids = np.concatenate([lid for _, lid in F.EYES])
    np.testing.assert_allclose(field[lids], F.blink_target(v, faces)[lids])  # the lids alone shut the eyes


def test_blink_uses_flames_own_expressions_when_they_can_close_the_eyes():
    v, faces = _toy_flame()
    dirs = np.random.default_rng(2).normal(scale=1e-6, size=(F.FLAME_VERTS, 3, 100))
    dirs[:, :, 37] = 0.5 * F.blink_target(v, faces)
    field, report = F.blink_field(v, dirs, faces)
    assert report["pcaShare"] > 0.9
    assert report["openFraction"] < 0.1


def _grid(n=8):
    xs, ys = np.meshgrid(np.linspace(0, 0.07, n), np.linspace(0, 0.07, n))
    verts = np.stack([xs.ravel(), ys.ravel(), 0.01 * np.sin(xs.ravel() * 40)], axis=1)
    faces = []
    for r in range(n - 1):
        for c in range(n - 1):
            a, b, d, e = r * n + c, r * n + c + 1, (r + 1) * n + c, (r + 1) * n + c + 1
            faces += [[a, b, e], [a, e, d]]
    return verts, np.array(faces)


def test_subdivision_parents_finds_each_midpoints_edge():
    verts, faces = _grid()
    edges = np.unique(np.sort(np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), axis=1), axis=0)
    order = np.random.default_rng(3).permutation(len(edges))  # LAM's order isn't ours
    base = np.concatenate([verts, (verts[edges[order, 0]] + verts[edges[order, 1]]) / 2, [[0.5, 0.5, 0.5]]])
    pairs, unmatched = F.subdivision_parents(base, faces)
    np.testing.assert_array_equal(pairs[: len(verts)], np.stack([np.arange(len(verts))] * 2, axis=1))
    np.testing.assert_array_equal(np.sort(pairs[len(verts):-1], axis=1), edges[order])
    assert unmatched == 1 and pairs[-1, 0] == pairs[-1, 1]  # not a midpoint: it follows its nearest vertex


def test_expr_bin_round_trips_and_is_checked(tmp_path):
    d = np.random.default_rng(4).normal(scale=0.002, size=(7, 10, 3))
    F.write_expr_bin(tmp_path / "expr.bin", 5, d)
    first, back = F.read_expr_bin(tmp_path / "expr.bin")
    assert first == 5 and back.dtype == np.float32
    np.testing.assert_allclose(back, d, atol=2e-6)
    assert (tmp_path / "expr.bin").stat().st_size == 8 + 7 * 10 * 3 * 2
    avatar = {"expr": "expr.bin", "exprChannels": list(F.EXPR_CHANNELS)}
    assert F.expr_errors(tmp_path, avatar, 12) == []
    assert any("13" in e for e in F.expr_errors(tmp_path, avatar, 13))  # must end at the last Gaussian
    assert any("exprChannels" in e for e in F.expr_errors(tmp_path, {**avatar, "exprChannels": ["a"]}, 12))
    (tmp_path / "expr.bin").write_bytes((tmp_path / "expr.bin").read_bytes()[:-2])
    assert any("bytes" in e for e in F.expr_errors(tmp_path, avatar, 12))


def test_apply_expr_moves_only_the_head_range():
    xyz = np.zeros((6, 3))
    d = np.zeros((2, 10, 3))
    d[:, F.BLINK, 1] = -0.004
    out = F.apply_expr(xyz, 4, d, np.eye(10)[F.BLINK] * 0.5)
    np.testing.assert_allclose(out[:4], 0)
    np.testing.assert_allclose(out[4:, 1], -0.002)


def test_head_channels_maps_flame_directions_onto_lams_head():
    v, eye_faces = _toy_flame()
    faces = np.concatenate([eye_faces, [[0, 1, 2]]])
    # LAM's head: FLAME in another frame (turned, scaled, moved), plus one Gaussian per edge midpoint of two faces
    R0, k, t0 = np.array([[0, 0, 1], [0, 1, 0], [-1, 0, 0]], float), 1.3, np.array([0.1, 0.2, 0.3])
    lam = k * v @ R0.T + t0
    mids = (lam[[0, 1]] + lam[[1, 2]]) / 2
    base = np.concatenate([lam, mids])
    dirs = np.zeros((F.FLAME_VERTS, 3, 100))
    dirs[:, 0, 0] = 1e-3  # flame0: everything 1 mm along FLAME's +x
    flame = F.Flame(v_template=v, faces=faces, expr_dirs=dirs)
    d, pairs, report = F.head_channels(base, flame)
    assert d.shape == (len(base), 10, 3)
    np.testing.assert_allclose(d[:, 0], np.tile(k * R0 @ [1e-3, 0, 0], (len(base), 1)), atol=1e-12)
    np.testing.assert_array_equal(np.sort(pairs[-2:], axis=1), [[0, 1], [1, 2]])
    assert report["templateRmsMm"] < 1e-6 and report["subdivision"]["unmatched"] == 0
    assert report["blink"]["openFraction"] < 0.1
    eyeballs = np.concatenate([e for e, _ in F.EYES])
    assert np.abs(d[eyeballs, F.BLINK]).max() == 0
