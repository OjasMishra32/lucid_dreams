import json

import numpy as np
import pytest

from lucid_avatars import arkit as A
from lucid_avatars.face_expr import FLAME_VERTS


def _rot(axis, angle):
    a = np.asarray(axis, dtype=float)
    a /= np.linalg.norm(a)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + np.sin(angle) * K + (1 - np.cos(angle)) * K @ K


def a2e_json(tmp_path, frames=12, fps=30.0, **over):
    d = {"names": list(A.ARKIT_NAMES),
         "metadata": {"fps": fps, "frame_count": frames, "blendshape_names": list(A.ARKIT_NAMES)},
         "frames": [{"weights": [round(0.01 * (i + k % 7), 4) for k in range(52)], "time": i / fps, "rotation": []}
                    for i in range(frames)]}
    d.update(over)
    p = tmp_path / "bs.json"
    p.write_text(json.dumps(d))
    return p


def test_arkit_names_are_the_52_and_the_lower_face_is_speech_only():
    assert len(A.ARKIT_NAMES) == 52 == len(set(A.ARKIT_NAMES))
    names = [A.ARKIT_NAMES[i] for i in A.LOWER_FACE]
    assert "jawOpen" in names and "mouthPucker" in names and "cheekPuff" in names
    assert not any(n.startswith(("eye", "brow", "tongue")) for n in names) and len(names) == 32


def test_read_a2e_json_gives_weights_in_arkit_order_at_its_fps(tmp_path):
    u = A.read_a2e_json(a2e_json(tmp_path, frames=12))
    assert u.weights.shape == (12, 52) and u.fps == 30.0 and u.duration_s == pytest.approx(0.4)
    assert u.weights[3, 5] == pytest.approx(0.01 * (3 + 5))


def test_read_a2e_json_reorders_by_name(tmp_path):
    names = list(reversed(A.ARKIT_NAMES))
    frames = [{"weights": [A.ARKIT_NAMES.index(n) / 100 for n in names], "time": i / 30} for i in range(3)]
    p = tmp_path / "rev.json"
    p.write_text(json.dumps({"names": names, "metadata": {"fps": 30, "frame_count": 3}, "frames": frames}))
    u = A.read_a2e_json(p)
    np.testing.assert_allclose(u.weights[0], np.arange(52.0) / 100)


@pytest.mark.parametrize("over, why", [
    ({"names": list(A.ARKIT_NAMES[:51])}, "52"),
    ({"names": ["x"] * 52}, "52"),
    ({"metadata": {"fps": 0, "frame_count": 12}}, "fps"),
    ({"metadata": {"fps": "30", "frame_count": 12}}, "fps"),
    ({"metadata": {"fps": 1000.0, "frame_count": 12}}, "fps"),
    ({"metadata": {"fps": 30.0, "frame_count": 99}}, "frame_count"),
    ({"frames": 0}, "frames"),
])
def test_read_a2e_json_refuses_what_isnt_a2e(tmp_path, over, why):
    with pytest.raises(ValueError, match=why):
        A.read_a2e_json(a2e_json(tmp_path, **over))


def test_read_a2e_json_refuses_short_weights_nan_huge_and_times_that_disagree(tmp_path):
    good = json.loads(a2e_json(tmp_path).read_text())
    for edit, why in [(lambda d: d["frames"][2]["weights"].pop(), "frame 2"),
                      (lambda d: d["frames"][1]["weights"].__setitem__(0, None), "numbers|finite"),
                      (lambda d: d["frames"][1]["weights"].__setitem__(0, 9.0), "weight of"),
                      (lambda d: d["frames"][4].__setitem__("time", 0.5), "puts it at")]:
        d = json.loads(json.dumps(good))
        edit(d)
        (tmp_path / "bad.json").write_text(json.dumps(d))
        with pytest.raises(ValueError, match=why):
            A.read_a2e_json(tmp_path / "bad.json")
    (tmp_path / "bad.json").write_text("{not json")
    with pytest.raises(ValueError):
        A.read_a2e_json(tmp_path / "bad.json")
    (tmp_path / "bad.json").write_text(json.dumps({"frames": 3}))
    with pytest.raises(ValueError, match="not A2E"):
        A.read_a2e_json(tmp_path / "bad.json")


def test_read_a2e_json_nan_in_the_file_is_refused(tmp_path):
    p = a2e_json(tmp_path)
    p.write_text(p.read_text().replace("0.01,", "NaN,", 1))
    with pytest.raises(ValueError, match="finite"):
        A.read_a2e_json(p)


# ---------------------------------------------------------------- shapes on FLAME

def head(n=400, seed=0):
    """A bumpy ellipsoid shell standing in for FLAME's template (metres, y up): asymmetric, so no axis turn or mirror
    fits it by accident."""
    rng = np.random.default_rng(seed)
    p = rng.normal(size=(n, 3))
    p /= np.linalg.norm(p, axis=1, keepdims=True)
    p = p * [0.075, 0.11, 0.09] * (1 + 0.15 * np.sin(5 * p[:, [0]]) * np.cos(3 * p[:, [1]]) + 0.1 * p[:, [2]])
    return p + [0, 0.05, 0.01]


def jaw_shapes(v):
    """52 synthetic shapes on mesh v: jawOpen drops the lower face 2 cm, the others are small different fields."""
    rng = np.random.default_rng(3)
    d = rng.normal(scale=0.0005, size=(52, len(v), 3))
    low = np.clip((0.05 - v[:, 1]) / 0.05, 0, 1)
    d[A.ARKIT_NAMES.index("jawOpen")] = np.outer(low, [0, -0.02, -0.002])
    return d


def test_index_route_fits_a_mesh_in_another_frame_and_units_and_carries_deltas_into_flames_frame():
    t = head()
    R, k, off = _rot([1, 0, 1], 1.2), 100.0, np.array([3.0, -1.0, 2.0])  # an FBX in centimetres, turned, moved
    base = k * t @ R.T + off + np.random.default_rng(1).normal(scale=0.05, size=t.shape)  # + 0.5 mm of shape difference
    extra = base[:50] * 0.99  # FLAME subdivided: more vertices after FLAME's
    fit = A.fit_to_flame(np.concatenate([base, extra]), t)
    assert fit.route == "index" and fit.rms_rel < 0.01 and fit.unique == 1.0
    d_flame = jaw_shapes(t)
    d_fbx = np.zeros((52, len(base) + 50, 3))
    d_fbx[:, :len(base)] = k * d_flame @ R.T
    out = A.deltas_on_flame(d_fbx, fit)
    assert out.shape == (52, len(t), 3)
    np.testing.assert_allclose(out, d_flame, atol=2e-5)


def test_nearest_route_reorders_a_shuffled_export_by_nearest_vertex_and_deltas_follow():
    t = head()
    R, k = _rot([0, 1, 0], 0.4) @ _rot([1, 0, 0], np.pi / 2), 10.0  # z-up export: the head lies on its back
    perm = np.random.default_rng(5).permutation(len(t))  # FBX vertex i is FLAME's vertex perm[i]
    base = (k * t @ R.T + 0.002)[perm]
    fit = A.fit_to_flame(base, t)
    assert fit.route == "nearest" and fit.unique >= 0.99 and fit.rms_rel < 0.01
    d_flame = jaw_shapes(t)
    d_fbx = (k * d_flame @ R.T)[:, perm]
    np.testing.assert_allclose(A.deltas_on_flame(d_fbx, fit), d_flame, atol=2e-5)


def test_fit_refuses_a_mesh_that_is_not_flames_even_when_the_count_matches():
    t = head()
    other = np.random.default_rng(9).normal(size=t.shape) * [0.08, 0.12, 0.09]  # a cloud, not the template
    with pytest.raises(ValueError, match="doesn't match FLAME"):
        A.fit_to_flame(other, t)


def test_fit_refuses_a_shuffled_export_that_is_also_a_different_shape():
    t = head()
    squashed = t * [1.0, 0.55, 1.0]  # a different head (45% shorter): no similarity fits, wherever the vertices are
    with pytest.raises(ValueError, match="Refusing"):
        A.fit_to_flame(squashed[np.random.default_rng(2).permutation(len(t))], t)


def test_fit_refuses_a_mirrored_mesh():
    t = head()
    with pytest.raises(ValueError, match="Refusing"):
        A.fit_to_flame(t * [-1, 1, 1], t, max_rms_rel=0.01)  # a proper rotation can't undo a mirror


def test_shape_deltas_reads_absolute_shapes_and_deltas_alike():
    base = head()
    d = jaw_shapes(base)
    np.testing.assert_allclose(A.shape_deltas(base, base[None] + d), d, atol=1e-12)  # the SDK's absolute positions
    np.testing.assert_allclose(A.shape_deltas(base, d), d, atol=1e-12)               # already deltas


def test_plausibility_wants_the_jaw_to_open_downward_in_metres():
    t = head()
    assert A.plausibility_problems(jaw_shapes(t), t) == []
    up = jaw_shapes(t)
    up[A.ARKIT_NAMES.index("jawOpen")] *= -1
    assert any("not down" in p for p in A.plausibility_problems(up, t))
    cm = jaw_shapes(t) * 100  # centimetres read as metres
    assert any("not a jaw opening" in p for p in A.plausibility_problems(cm, t))
    flat = np.zeros((52, len(t), 3))
    assert any("at most" in p for p in A.plausibility_problems(flat, t))


def save_npz(tmp_path, deltas, names=None, name="arkit.npz"):
    np.savez(tmp_path / name, names=np.array(names or A.ARKIT_NAMES), deltas=deltas)
    return tmp_path / name


def test_load_arkit_on_flame_orders_by_name_and_checks_shape_and_units(tmp_path):
    d = np.zeros((52, FLAME_VERTS, 3))
    d[A.ARKIT_NAMES.index("jawOpen"), :10, 1] = -0.02
    z = A.load_arkit_on_flame(save_npz(tmp_path, d))
    assert z.deltas.shape == (52, FLAME_VERTS, 3) and z.lower_face.shape == (FLAME_VERTS, 3, 32)
    j = list(A.LOWER_FACE).index(A.ARKIT_NAMES.index("jawOpen"))
    assert z.lower_face[0, 1, j] == pytest.approx(-0.02)
    rev = list(reversed(A.ARKIT_NAMES))
    z2 = A.load_arkit_on_flame(save_npz(tmp_path, d[::-1], rev, "rev.npz"))
    np.testing.assert_allclose(z2.deltas, d)
    for bad, why in [(d[:, :100], "expected"), (d * 100, "metres"), (np.zeros_like(d), "jawOpen")]:
        with pytest.raises(ValueError, match=why):
            A.load_arkit_on_flame(save_npz(tmp_path, bad, name="bad.npz"))
    with pytest.raises(ValueError, match="52"):
        A.load_arkit_on_flame(save_npz(tmp_path, d[:51], list(A.ARKIT_NAMES[:51]), "bad2.npz"))


def test_a_shuffle_confined_to_one_region_cant_pass_on_a_global_rms_and_is_found_by_nearest_vertex():
    t = head(n=1500)
    perm = np.arange(len(t))
    cap = np.flatnonzero(t[:, 1] > 0.12)  # a few percent of the vertices, one region (the mouth's stand-in)
    assert 20 < len(cap) < 0.2 * len(t)
    perm[cap] = np.random.default_rng(4).permutation(cap)
    k, R = 10.0, _rot([0, 1, 0], 0.3)
    base = (k * t @ R.T)[perm]  # FBX vertex i is FLAME's perm[i]; globally the mesh is the template to within a few mm
    assert A.fit_to_flame(t[perm], t, max_rms_rel=0.04).route == "nearest"  # not accepted in index order
    fit = A.fit_to_flame(base, t)
    assert fit.route == "nearest"
    d_flame = jaw_shapes(t)
    np.testing.assert_allclose(A.deltas_on_flame((k * d_flame @ R.T)[:, perm], fit), d_flame, atol=2e-5)


@pytest.mark.parametrize("edit", [lambda d: d["frames"][1].__setitem__("time", "x"),
                                  lambda d: d["metadata"].__setitem__("blendshape_names", 5),
                                  lambda d: d.__setitem__("frames", [1, 2, 3]),
                                  lambda d: d["frames"][0].__setitem__("weights", "abc")])
def test_a2e_json_of_the_wrong_types_is_a_value_error_not_a_crash(tmp_path, edit):
    d = json.loads(a2e_json(tmp_path).read_text())
    edit(d)
    (tmp_path / "bad.json").write_text(json.dumps(d))
    with pytest.raises(ValueError):
        A.read_a2e_json(tmp_path / "bad.json")
