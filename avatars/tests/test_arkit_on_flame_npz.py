"""arkit_on_flame_npz.extract on a stand-in FBX (the FBX SDK read itself can't run here: it needs LAM's wheel and the
template, on HiPerGator)."""

import importlib.util
from pathlib import Path

import numpy as np
import pytest
from test_arkit import _rot, head, jaw_shapes

from lucid_avatars import arkit as A

_spec = importlib.util.spec_from_file_location("arkit_on_flame_npz", Path(__file__).parents[1] / "arkit_on_flame_npz.py")
X = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(X)


def fbx_mesh(t, name="Face", prefix="Face.", shuffle=None, k=100.0, R=None):
    """What read_fbx would give for a template-shaped FBX: absolute shape points per channel, centimetres, turned."""
    R = _rot([1, 0, 0], np.pi / 2) if R is None else R
    d = jaw_shapes(t)
    base = k * t @ R.T
    pts = base[None] + k * d @ R.T
    if shuffle is not None:
        base, pts = base[shuffle], pts[:, shuffle]
    return {"name": name, "base": base, "channels": {prefix + n: pts[i] for i, n in enumerate(A.ARKIT_NAMES)}}, d


def test_extract_gives_52_shapes_in_flames_frame_whatever_the_fbx_frame_order_and_names():
    t = head()
    perm = np.random.default_rng(7).permutation(len(t))
    for kw in ({}, {"shuffle": perm}, {"prefix": "BlendShape1:"}, {"prefix": ""}):
        mesh, want = fbx_mesh(t, **kw)
        if kw.get("prefix") == "":
            mesh["channels"] = {n.upper(): p for n, p in mesh["channels"].items()}
        arrays, report = X.extract([{"name": "Teeth", "base": t[:5], "channels": {}}, mesh], t, 0.04)
        assert list(arrays["names"]) == list(A.ARKIT_NAMES) and arrays["deltas"].shape == (52, len(t), 3)
        np.testing.assert_allclose(arrays["deltas"], want, atol=1e-4)
        assert report["mesh"] == "Face" and report["rmsOverExtent"] < 0.01
        assert report["route"] == ("nearest" if "shuffle" in kw else "index")


def test_extract_refuses_missing_channels_two_faces_a_foreign_mesh_and_a_jaw_that_goes_up():
    t = head()
    mesh, _ = fbx_mesh(t)
    short = dict(mesh, channels=dict(list(mesh["channels"].items())[:40]))
    with pytest.raises(ValueError, match="no mesh with all 52"):
        X.extract([short], t, 0.04)
    with pytest.raises(ValueError, match="2 meshes"):
        X.extract([mesh, dict(mesh, name="Face2")], t, 0.04)
    foreign = dict(mesh, base=np.random.default_rng(1).normal(size=mesh["base"].shape) * 5)
    with pytest.raises(ValueError, match="Refusing"):
        X.extract([foreign], t, 0.04)
    flipped, _ = fbx_mesh(t)
    flipped["channels"]["Face.jawOpen"] = 2 * flipped["base"] - flipped["channels"]["Face.jawOpen"]
    with pytest.raises(ValueError, match="don't look like ARKit"):
        X.extract([flipped], t, 0.04)
