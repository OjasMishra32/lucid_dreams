"""flame_expr_npz.py on a stand-in FLAME (the real one is licensed and lives only on HiPerGator)."""

import importlib.util
import pickle
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from test_face_expr import _toy_flame

from lucid_avatars import face_expr as F

_spec = importlib.util.spec_from_file_location("flame_expr_npz", Path(__file__).parents[1] / "flame_expr_npz.py")
X = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(X)


class _Ch:  # what a chumpy array looks like to us: values in .r
    def __init__(self, a):
        self.r = np.asarray(a)


def _flame():
    v, faces = _toy_flame()
    sd = np.random.default_rng(0).normal(size=(F.FLAME_VERTS, 3, 400))
    model = {"v_template": _Ch(v), "f": faces.astype(np.uint32), "shapedirs": _Ch(sd)}
    masks = {"left_eyeball": F.LEFT_EYEBALL[::-1].copy(), "right_eyeball": F.RIGHT_EYEBALL}
    return model, masks, sd


def test_extract_keeps_the_template_faces_and_the_100_expressions():
    model, masks, sd = _flame()
    z = X.extract(model, masks)
    np.testing.assert_allclose(z["expr_dirs"], sd[:, :, 300:400].astype(np.float32))
    assert z["faces"].dtype == np.int64 and z["v_template"].shape == (F.FLAME_VERTS, 3)


def test_extract_stops_on_wrong_eye_ids():
    model, masks, _ = _flame()
    with pytest.raises(ValueError, match="eyeball"):
        X.extract(model, {**masks, "right_eyeball": F.RIGHT_EYEBALL[1:]})
    v = model["v_template"].r.copy()
    v[F.LEFT_EYELID[0]] = [0.5, 0.5, 0.5]  # an "eyelid" vertex nowhere near the eye
    with pytest.raises(ValueError, match="eyelid"):
        X.extract({**model, "v_template": _Ch(v)}, masks)
    flat = model["v_template"].r.copy()
    eyeball, lid = F.EYES[1]
    near = np.linalg.norm(flat - flat[eyeball].mean(0), axis=1) < 0.02
    near[eyeball] = False
    flat[near, 1] = flat[eyeball, 1].mean() + 0.004  # everything round the right eye above its centre: no lower lid
    with pytest.raises(ValueError, match="lower eyelid"):
        X.extract({**model, "v_template": _Ch(flat)}, masks)


def test_the_npz_loads_as_face_exprs_flame(tmp_path):
    model, masks, _ = _flame()
    model = {k: getattr(a, "r", a) for k, a in model.items()}  # plain arrays pickle without chumpy
    for name, obj in (("flame.pkl", model), ("masks.pkl", masks)):
        (tmp_path / name).write_bytes(pickle.dumps(obj))
    out = subprocess.run([sys.executable, str(Path(X.__file__)), str(tmp_path / "flame.pkl"), str(tmp_path / "masks.pkl"),
                          str(tmp_path / "flame.npz")], capture_output=True, text=True,
                         env={"PYTHONPATH": str(Path(X.__file__).parent)})
    assert out.returncode == 0, out.stderr
    flame = F.load_flame(tmp_path / "flame.npz")
    assert flame.expr_dirs.shape == (F.FLAME_VERTS, 3, 100)


def test_reads_flames_chumpy_pickle_without_chumpy(tmp_path):
    """LAM's env (the only one with chumpy) is gone: FLAME's pickle must load in any numpy env. Its chumpy arrays keep
    their values in `x`; its scipy sparse J_regressor isn't needed."""
    import types

    ch, sp = types.ModuleType("chumpy.ch"), types.ModuleType("scipy.sparse.csc")

    class Ch:  # what chumpy pickles: an object whose state holds the array in x
        pass

    class csc_matrix:  # noqa: N801
        pass

    Ch.__module__, csc_matrix.__module__ = "chumpy.ch", "scipy.sparse.csc"
    Ch.__qualname__, csc_matrix.__qualname__ = "Ch", "csc_matrix"
    ch.Ch, sp.csc_matrix = Ch, csc_matrix
    model, masks, sd = _flame()
    fakes = {"chumpy": types.ModuleType("chumpy"), "chumpy.ch": ch, "scipy": types.ModuleType("scipy"),
             "scipy.sparse": types.ModuleType("scipy.sparse"), "scipy.sparse.csc": sp}
    saved = {k: sys.modules.get(k) for k in fakes}
    sys.modules.update(fakes)
    try:
        pkl = {}
        for k, a in model.items():
            o = Ch()
            o.x = getattr(a, "r", a)
            pkl[k] = o if k != "f" else o.x
        pkl["J_regressor"] = csc_matrix()
        (tmp_path / "flame.pkl").write_bytes(pickle.dumps(pkl))
    finally:
        for k, m in saved.items():
            sys.modules.pop(k, None) if m is None else sys.modules.__setitem__(k, m)
    (tmp_path / "masks.pkl").write_bytes(pickle.dumps(masks))
    out = subprocess.run([sys.executable, str(Path(X.__file__)), str(tmp_path / "flame.pkl"), str(tmp_path / "masks.pkl"),
                          str(tmp_path / "flame.npz")], capture_output=True, text=True,
                         env={"PYTHONPATH": str(Path(X.__file__).parent)})  # this env has neither chumpy nor scipy
    assert out.returncode == 0, out.stderr
    np.testing.assert_allclose(F.load_flame(tmp_path / "flame.npz").expr_dirs, sd[:, :, 300:400], rtol=1e-6)
