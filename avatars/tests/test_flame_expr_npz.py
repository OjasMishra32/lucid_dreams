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
    with pytest.raises(ValueError, match="eye opening"):  # faces without the eyes' openings: no blink possible
        X.extract({**model, "f": np.array([[0, 1, 2]])}, masks)


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
