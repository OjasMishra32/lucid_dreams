"""Blinks and the living idle for ANY SMPL-X avatar bundle (a DiGS photo avatar, an LHM++ one), in place.

head_swap.swap_bundle writes avatar/expr.bin only for LAM's heads. SMPL-X's own head has FLAME's topology (SMPL-X
vertex `ids[j]` is FLAME vertex j, `SMPL-X__FLAME_vertex_ids.npy`), so any SMPL-X avatar has a FLAME head to blink:

1. The avatar's rest SMPL-X vertices (the bundle's betas) are checked against skeleton.json (refused over 2 mm).
2. FLAME's template is fitted to `verts[ids]` (Umeyama). The avatar's head in FLAME's frame is the inverse, and
   face_expr.blink_field shuts its eyelids there; channels = FLAME expressions 0-8 + blink, carried into the avatar's
   frame by the fit's k R0 (directions only), as face_expr.head_channels does for LAM.
3. The head is every Gaussian whose dominant skin.bin joint is head, jaw, left_eye or right_eye. Each takes the
   inverse-distance blend of its 3 nearest FLAME-part vertices (the eyeballs excluded), except a Gaussian within
   EYE_RADII eyeball radii of an eye centre: that is the eye, it gets zero offsets and turns with the eye joint.
4. expr.bin needs the head as one contiguous range at the end of avatar.ply: the Gaussians are reordered (body first,
   then head, each in original order) and the same permutation goes to skin.bin and reality.ply.
5. avatar/expr.bin, `exprChannels`, and (unless keep_motion, or the motion is a performance) the 20 s living idle
   with blinks, as in head_swap.living_idle. face.json next to dream.json reports the numbers.

Idempotent: the order is a stable partition, so a second run is the identity permutation and rebuilds the same
files from whatever expr.bin was there. Adds no likeness, so nothing is consent-gated; dreams/.held is honoured.
"""

from __future__ import annotations

import json
import os
from dataclasses import replace
from pathlib import Path

import numpy as np

from . import face_expr as FE
from . import head_swap as H
from .gaussian_ply import Gaussians, read_ply, write_ply
from .motion import Motion
from .skinning import read_skin_bin, write_skin_bin
from .smplx_layout import J

HEAD_JOINTS = (J["head"], J["jaw"], J["left_eye"], J["right_eye"])
EYE_RADII = 1.05  # a Gaussian this close to an eye centre (in eyeball radii) is the eye
NEIGHBOURS = 3
FACE_FILE = "face.json"


class FitError(ValueError):
    """FLAME doesn't fit this SMPL-X head: wrong ids or template. Never skipped, unlike eyes that won't shut."""


def held_errors(bundle: str | Path) -> list[str]:
    """Why this bundle is off limits: its id or folder is in the dreams/.held next to it."""
    bundle = Path(bundle)
    ids = {bundle.resolve().name}
    try:
        ids.add(H.dream_id_of(bundle))
    except (OSError, ValueError, KeyError):
        pass
    on_hold = H.held_ids(bundle.resolve().parent / ".held") & ids
    return [f"{', '.join(sorted(on_hold))} in dreams/.held"] if on_hold else []


def head_mask(idx: np.ndarray, q: np.ndarray) -> np.ndarray:
    """Which Gaussians are head: the dominant skin joint is head, jaw or an eye."""
    dominant = idx[np.arange(len(idx)), np.argmax(q, axis=1)]
    return np.isin(dominant, HEAD_JOINTS)


def vertex_channels(face: np.ndarray, flame: FE.Flame) -> tuple[np.ndarray, dict]:
    """((5023, 10, 3) expression directions per FLAME vertex in the avatar's frame, report), `face` being the
    avatar's head at FLAME's vertices (verts[ids])."""
    k, R0, t0 = H.umeyama(flame.v_template, face)
    rms = float(np.sqrt((((k * flame.v_template @ R0.T + t0) - face) ** 2).sum(1).mean()))
    if rms > H.MAX_ALIGN_RMS_M:
        raise FitError(f"FLAME's template fits the SMPL-X head only to {rms * 100:.1f} cm RMS: wrong vertex ids, or "
                         "not FLAME 2023's template?")
    person = (face - t0) @ R0 / k  # this avatar's own head, in FLAME's frame
    blink, blink_report = FE.blink_field(person, flame.expr_dirs)  # ValueError: no blinks
    ch = np.concatenate([flame.expr_dirs[:, :, :FE.N_CHANNELS - 1], blink[:, :, None]], axis=2)  # (V, 3, 10)
    d = k * np.einsum("ij,vjc->vci", R0, ch)
    return d, {"channels": list(FE.EXPR_CHANNELS), "templateRmsMm": round(rms / k * 1000, 4),
               "flameScale": round(float(k), 6), "blink": blink_report}


def eyes_of(face: np.ndarray) -> list[tuple[np.ndarray, float]]:
    """(centre, radius) of each eyeball, from the avatar's FLAME-part vertices."""
    out = []
    for ball, _ in FE.EYES:
        c = face[ball].mean(0)
        out.append((c, float(np.linalg.norm(face[ball] - c, axis=1).mean())))
    return out


def gaussian_channels(xyz: np.ndarray, face: np.ndarray, channels: np.ndarray, chunk: int = 2048
                      ) -> tuple[np.ndarray, np.ndarray]:
    """((n, 10, 3) offsets, (n,) eye mask): each Gaussian blends its NEIGHBOURS nearest non-eyeball FLAME vertices'
    channels by inverse distance; the eye's own Gaussians get zeros."""
    xyz = np.asarray(xyz, dtype=np.float64)
    part = np.setdiff1d(np.arange(len(face)), np.concatenate([b for b, _ in FE.EYES]))
    v = face[part]
    vv = (v ** 2).sum(1)
    out = np.zeros((len(xyz), FE.N_CHANNELS, 3))
    for s in range(0, len(xyz), chunk):
        p = xyz[s:s + chunk]
        d2 = (p ** 2).sum(1, keepdims=True) - 2 * p @ v.T + vv
        near = np.argpartition(d2, NEIGHBOURS - 1, axis=1)[:, :NEIGHBOURS]
        dist = np.sqrt(np.maximum(np.take_along_axis(d2, near, axis=1), 0))
        w = 1.0 / (dist + 1e-6)
        w /= w.sum(1, keepdims=True)
        out[s:s + len(p)] = np.einsum("nk,nkcx->ncx", w, channels[part[near]])
    eye = np.zeros(len(xyz), dtype=bool)
    for c, r in eyes_of(face):
        eye |= np.linalg.norm(xyz - c, axis=1) < EYE_RADII * r
    out[eye] = 0.0
    return out, eye


def _permuted(g: Gaussians, order: np.ndarray) -> Gaussians:
    return replace(g, xyz=g.xyz[order], f_dc=g.f_dc[order], f_rest=g.f_rest[order], opacity=g.opacity[order],
                   scale=g.scale[order], rotation=g.rotation[order])


def add_face(bundle: str | Path, smplx_npz: str | Path, flame_ids_npy: str | Path, flame_npz: str | Path,
             keep_motion: bool = False) -> Path:
    """Blinks and the living idle for the SMPL-X avatar bundle at `bundle`, in place (see the module docstring).
    Raises ValueError, writing nothing, for a held id, a bundle without skinning, a skeleton that isn't this SMPL-X,
    a FLAME that doesn't fit its head, or a head swap's own LAM-fitted expr.bin. Eyes FLAME can't shut (blink_field's
    ValueError) skip expr and the reorder, say why in face.json and still give the idle (no blinks)."""
    root = Path(bundle)
    if (errors := held_errors(root)):
        raise ValueError(f"{root.name}: {errors[0]} (held ids are never touched)")
    dream = json.loads((root / "dream.json").read_text())
    av = dream["avatar"]
    if "skin" not in av or "skeleton" not in av:
        raise ValueError("the bundle has no skin.bin / skeleton.json: the head is found by its skinning (digs-sample "
                         "writes both)")
    if (root / "head_swap.json").is_file() and "expr" in av and not (root / FACE_FILE).is_file():
        raise ValueError("this is a head swap with its own expr.bin, fitted to LAM's eyelids: rerun head-swap.sbatch "
                         "to change it (a blink fitted to SMPL-X's head would replace the better one)")

    g = read_ply(root / av["file"])
    idx, q = read_skin_bin(root / av["skin"])
    if len(idx) != len(g):
        raise ValueError(f"skin.bin has {len(idx)} records for {len(g)} Gaussians")
    reality = read_ply(root / av["reality"]) if av.get("reality") else None
    if reality is not None and len(reality) != len(g):
        raise ValueError(f"reality.ply has {len(reality)} Gaussians, avatar.ply {len(g)}")
    rest = np.asarray(json.loads((root / av["skeleton"]).read_text())["rest"], dtype=np.float64)
    motion = Motion.load(root / av["motion"])

    joints, verts, _ = H._smplx_rest(smplx_npz, motion.betas)
    err = float(np.abs(joints - rest).max())
    if err > H.MAX_SKELETON_ERR_M:
        raise ValueError(f"skeleton.json is {err * 1000:.1f} mm from this SMPL-X model with the bundle's betas: not the "
                         "model this avatar was built with, or not its betas")
    ids = np.load(flame_ids_npy).astype(np.int64).reshape(-1)
    if len(ids) != FE.FLAME_VERTS:
        raise ValueError(f"{flame_ids_npy} has {len(ids)} ids, expected FLAME's {FE.FLAME_VERTS}")
    face = verts[ids]
    flame = FE.load_flame(flame_npz)

    is_head = head_mask(idx, q)
    expr_d, expr_report = None, {}
    try:
        channels, expr_report = vertex_channels(face, flame)
    except ValueError as e:
        if isinstance(e, FitError):
            raise
        expr_report = {"skipped": str(e)}  # no blink is better than no idle: carry on without expr.bin
        channels = None

    order = np.arange(len(g))
    n_eye = 0
    if channels is not None:
        order = np.concatenate([np.flatnonzero(~is_head), np.flatnonzero(is_head)])  # stable: original order kept
        if not is_head.any():
            raise ValueError("no Gaussian is skinned to the head, jaw or eyes: not a SMPL-X avatar with a face")
        expr_d, eye = gaussian_channels(g.xyz[order[-int(is_head.sum()):]], face, channels)
        n_eye = int(eye.sum())

    living = None if keep_motion else H.living_idle(motion, dream.get("source"), blink=expr_d is not None)
    report = {"from": dream["id"], "bodyGaussians": int((~is_head).sum()) if expr_d is not None else None,
              "headGaussians": int(is_head.sum()), "eyeGaussians": n_eye, "expr": expr_report,
              "skeletonErrMm": round(err * 1000, 4), "motion": "living idle" if living is not None else "kept"}
    if expr_d is None:
        del report["bodyGaussians"]

    # everything is computed: write each file next to itself, then move them into place together
    pending: list[tuple[Path, Path]] = []

    def stage(path: Path, write) -> None:
        tmp = path.with_name(path.name + ".tmp")
        write(tmp)
        pending.append((tmp, path))

    new_av = {**av}
    if expr_d is not None:
        if not np.array_equal(order, np.arange(len(g))):
            stage(root / av["file"], lambda p: write_ply(p, _permuted(g, order)))
            stage(root / av["skin"], lambda p: write_skin_bin(p, idx[order], q[order]))
            if reality is not None:
                stage(root / av["reality"], lambda p: write_ply(p, _permuted(reality, order)))
        stage(root / FE.EXPR_FILE, lambda p: FE.write_expr_bin(p, int((~is_head).sum()), expr_d))
        new_av.update(expr=FE.EXPR_FILE, exprChannels=list(FE.EXPR_CHANNELS))
    else:
        new_av.pop("expr", None)
        new_av.pop("exprChannels", None)
    if living is not None:
        stage(root / av["motion"], living.save)
        dream.update(fps=living.fps, frameCount=living.num_frames, durationS=round(living.num_frames / living.fps, 3))
    dream["avatar"] = new_av
    stage(root / FACE_FILE, lambda p: p.write_text(json.dumps(report, indent=2) + "\n"))
    stage(root / "dream.json", lambda p: p.write_text(json.dumps(dream, indent=2) + "\n"))
    for tmp, path in pending:
        os.replace(tmp, path)
    if expr_d is None and (root / FE.EXPR_FILE).is_file():
        (root / FE.EXPR_FILE).unlink()  # an expr.bin left from an earlier run that this run couldn't rebuild
    return root
