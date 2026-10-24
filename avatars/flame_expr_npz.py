"""What blinks need from FLAME 2023, in one small npz: the template, the faces and the 100 expression directions.
FLAME's pickle holds chumpy arrays; any env with numpy reads it (chumpy is used if present, else a stand-in keeps
each array's values), so LAM's retired env isn't needed:

  PYTHONPATH=avatars python avatars/flame_expr_npz.py flame2023.pkl FLAME_masks.pkl flame2023_expr.npz

hpg/head-swap.sbatch runs it once. It also checks face_expr's eye constants against FLAME itself (the eyeball ids
against FLAME_masks.pkl, each eyelid list beside its eyeball, an opening round each eye with an upper and a lower
lid), and fits the blink on FLAME's own template and prints how far it shuts, so a wrong id or a blink that doesn't
shut stops here, not on someone's face. The npz stays
on HiPerGator: FLAME's licence doesn't let us publish it.
"""

from __future__ import annotations

import pickle
import sys

import numpy as np

from lucid_avatars.face_expr import EYES, FLAME_VERTS, _eye, blink_field

N_SHAPE = 300  # FLAME's shapedirs: 300 shape components, then the expressions (LAM slices them the same way)
LID_NEAR_EYE = 2.0  # eyeball radii: every eyelid vertex sits this close to its own eye's centre
MAX_OPEN = 0.2  # a blink that leaves the template's eyes more open than this isn't shipped


class _Stub:
    """Stands in for a class this env doesn't have (chumpy's arrays, scipy's sparse matrices): keeps its state."""

    def __init__(self, *args, **kwargs):
        pass

    def __setstate__(self, state):
        if isinstance(state, dict):
            self.__dict__.update(state)
        else:
            self._state = state


class _Unpickler(pickle.Unpickler):
    """FLAME's pickle without chumpy or scipy installed (LAM's env, which had chumpy, is gone)."""

    def find_class(self, module, name):
        if module.split(".")[0] in ("chumpy", "scipy"):
            return _Stub
        return super().find_class(module, name)


def load_pickle(path: str) -> dict:
    with open(path, "rb") as f:
        try:
            import chumpy  # noqa: F401  # the real thing when this env has it
            return pickle.load(f, encoding="latin1")
        except ImportError:
            return _Unpickler(f, encoding="latin1").load()


def arr(x) -> np.ndarray:
    """A plain array from a chumpy array (its values in .r, or in x when unpickled without chumpy) or an array."""
    if isinstance(x, _Stub):
        if "x" not in x.__dict__:
            raise ValueError(f"a chumpy object without its values (state keys {sorted(x.__dict__)})")
        return np.asarray(x.__dict__["x"])
    return np.asarray(getattr(x, "r", x))


def extract(model: dict, masks: dict) -> dict[str, np.ndarray]:
    v = arr(model["v_template"]).astype(np.float64)
    faces = arr(model["f"]).astype(np.int64)
    sd = arr(model["shapedirs"])
    if v.shape != (FLAME_VERTS, 3) or sd.shape[:2] != (FLAME_VERTS, 3) or sd.shape[2] < N_SHAPE + 10:
        raise ValueError(f"not FLAME: v_template {v.shape}, shapedirs {sd.shape}")
    for (eyeball, lid), side in zip(EYES, ("left", "right")):
        mask = np.sort(arr(masks[f"{side}_eyeball"]).astype(np.int64))
        if not np.array_equal(mask, eyeball):
            raise ValueError(f"FLAME_masks {side}_eyeball isn't vertices {eyeball[0]}..{eyeball[-1]}: face_expr's "
                             "eyeball ids are wrong")
        c = v[eyeball].mean(0)
        r = np.linalg.norm(v[eyeball] - c, axis=1).mean()
        far = np.linalg.norm(v[lid] - c, axis=1).max() / r
        if far > LID_NEAR_EYE:
            raise ValueError(f"face_expr's {side} eyelid reaches {far:.1f} eyeball radii from the {side} eye: wrong ids")
        _, _, up, lo, _ = _eye(v, eyeball, lid)  # an upper and a lower lid to shut, or ValueError
        print(f"[expr] {side} eye: eyeball radius {r * 1000:.1f} mm, lid list {len(lid)}, upper lid {len(up)}, "
              f"lower lid {len(lo)} vertices")
    expr = sd[:, :, N_SHAPE:N_SHAPE + 100].astype(np.float32)
    _, report = blink_field(v, expr)  # the blink on FLAME's own template: it must shut before any head gets it
    print(f"[expr] blink on FLAME's template: {report}")
    if report["openFraction"] > MAX_OPEN:
        raise ValueError(f"the blink leaves FLAME's eyes {report['openFraction']:.0%} open (> {MAX_OPEN:.0%})")
    return {"v_template": v, "faces": faces, "expr_dirs": expr}


def main() -> int:
    pkl, masks_pkl, out = sys.argv[1:4]
    model, masks = load_pickle(pkl), load_pickle(masks_pkl)
    z = extract(model, masks)
    np.savez(out, **z)
    print(f"[expr] FLAME extract: {len(z['faces'])} faces, {z['expr_dirs'].shape[2]} expressions -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
