"""A real face on a DiGS avatar: LAM's one-photo FLAME Gaussian head in place of the body model's guessed one.

Consenting people only (AGENTS.md rule 5): never a public figure. `hpg/head-swap.sbatch` runs it; this module is the
plain-numpy part (align, replace, skin, tone, bundle) so it is testable anywhere.

LAM (aigc3d/LAM, SIGGRAPH 2025, Apache-2.0) writes per photo, in its canonical FLAME space:
  <photo>_gs_offset.ply     one Gaussian per vertex of FLAME subdivided once (FLAME's 5023 vertices first, then the
                            edge midpoints, as pytorch3d's SubdivideMeshes orders them). x, y, z hold each Gaussian's
                            OFFSET from its vertex, not its position; f_dc holds RGB in 0..1 (gs_use_rgb), not SH.
  <photo>_textured_mesh.obj every Gaussian's position, in the same order (mesh_utils.save_obj writes them all).
(<photo>_shaped_mesh.obj goes through trimesh, which drops unreferenced vertices, so it isn't used.)
So position - offset over the first 5023 is LAM's shaped FLAME mesh, which pairs with the avatar's SMPL-X head
through SMPL-X's FLAME vertex ids (`SMPL-X__FLAME_vertex_ids.npy`, from the SMPL-X site).

Steps: align (Umeyama similarity, FLAME mesh -> the avatar's rest-pose SMPL-X head), replace (drop the body's
head, jaw and eye Gaussians above the jaw line, cross-fade the seam), skin (each head Gaussian takes the weights of
its own FLAME vertex's SMPL-X twin, or the mean over its edge; nearest SMPL-X vertex only where that isn't known),
tone (the head's skin matched to the body's on the neck ring, in Lab), and, given FLAME (flame_expr_npz.py), life:
avatar/expr.bin (face_expr.py: FLAME's expressions and a blink fitted to these eyelids) and the 20 s living idle in
place of the source's idle, blinking through it.
"""

from __future__ import annotations

import json
import re
import shutil
from dataclasses import replace
from pathlib import Path

import numpy as np

from . import face_expr as FE
from .gaussian_ply import SH_C0, Gaussians, read_ply, write_ply
from .idle import IDLE_S, idle_loop
from .motion import Motion
from .skinning import SKELETON_FILE, SKIN_FILE, quantize_top4, read_skin_bin, rest_joints, write_skin_bin
from .smplx_layout import LEFT_HAND, RIGHT_HAND, J

FLAME_VERTS = FE.FLAME_VERTS
HEAD_JOINTS = (J["head"], J["jaw"], J["left_eye"], J["right_eye"])  # what the new head replaces
SEAM_JOINTS = HEAD_JOINTS + (J["neck"],)  # body Gaussians that fade out at the seam
SEAM_BELOW_JAW_M = 0.03  # the jaw line: this far below the SMPL-X jaw joint (approximate; --seam-offset moves it)
BAND_M = 0.03  # cross-fade height at the seam
RING_M = 0.05  # neck ring below the seam whose skin the head is toned to
MAX_SKELETON_ERR_M = 0.002  # skeleton.json vs this SMPL-X model with the bundle's betas
MAX_ALIGN_RMS_M = 0.03  # FLAME-to-SMPL-X head fit worse than this means the wrong ids or the wrong mesh
REALITY_FILE = "avatar/reality.ply"
REALITY_TINT = np.array([0.25, 0.45, 1.0])  # as digs_avatar.py tints what the photo didn't see
# People who said yes to a photoreal face (AGENTS.md rule 5). Add a name only on that person's own word; never a
# public figure, whatever photos exist of them.
CONSENTED = frozenset({"vishal", "ian-grandma"})  # ian-grandma: written family consent (Ian, Sat 2 AM)
BUNDLE_ID = re.compile(r"[a-z0-9][a-z0-9-]*")
PHOTO_STEM = re.compile(r"[\w. -]+")


# ---------------------------------------------------------------- who and which head

def held_ids(path: str | Path) -> set[str]:
    """dreams/.held: ids held back from the library, one per line (Ojasva's; the web app reads the same file)."""
    path = Path(path)
    return set(path.read_text().split()) if path.is_file() else set()


def consent_errors(person: str, bundle: str | Path, held: str | Path | None = None,
                   new_id: str | None = None) -> list[str]:
    """Why this head swap mustn't run (empty if it may): the person has to be in CONSENTED, the bundle has to be
    their own avatar (id `<person>` or `<person>-...`, in a folder of that name), the new bundle has to be a new
    `<person>-...` id that isn't another bundle, and none of them may be in dreams/.held (the one next to the bundle,
    plus `held` if given: it adds to that list, never replaces it)."""
    bundle = Path(bundle)
    dream_id = dream_id_of(bundle)
    errors = []
    if person not in CONSENTED:
        errors.append(f"{person!r} hasn't given consent for a photoreal face (CONSENTED in head_swap.py; AGENTS.md rule 5)")
    if dream_id != person and not dream_id.startswith(f"{person}-"):
        errors.append(f"{bundle.name} (id {dream_id!r}) isn't {person}'s own avatar: no one's face goes on someone "
                      "else's body")
    if bundle.resolve().name != dream_id:
        errors.append(f"folder {bundle.resolve().name!r} holds dream id {dream_id!r}: they must match")
    if new_id is not None:
        out = bundle.parent / new_id
        if not BUNDLE_ID.fullmatch(new_id) or not new_id.startswith(f"{person}-") or new_id == dream_id:
            errors.append(f"new id {new_id!r} must be a new {person}-... id (lowercase letters, digits and dashes)")
        elif out.exists() and not (out / "head_swap.json").is_file():
            errors.append(f"{out} exists and is not a head swap: it is never replaced")
    on_hold = (held_ids(bundle.parent / ".held") | (held_ids(held) if held else set())) & {person, dream_id, new_id}
    if on_hold:
        errors.append(f"{', '.join(sorted(on_hold))} in dreams/.held")
    return errors


def pick_head(heads: str | Path, person: str, photo: str | None = None) -> tuple[Path, Path]:
    """(<photo>_gs_offset.ply, <photo>_textured_mesh.obj) from lam-head.sbatch's heads/ folder, which names every
    head <person>-<photo>: the named one, or the person's first by name. Never another person's head."""
    heads = Path(heads)
    for what, value in (("person", person), ("photo", photo)):
        if value is not None and (not PHOTO_STEM.fullmatch(value) or ".." in value):
            raise ValueError(f"{what} {value!r} isn't a plain name (letters, digits, '.', '_', '-', spaces)")
    if photo is not None and not photo.startswith(f"{person}-"):
        raise ValueError(f"LAM head {photo!r} isn't {person}'s (lam-head.sbatch names them {person}-<photo>)")
    found = [heads / f"{photo}_gs_offset.ply"] if photo else sorted(heads.glob(f"{person}-*_gs_offset.ply"))
    plys = [p for p in found if p.is_file()]
    if not plys:
        raise ValueError(f"no LAM head of {person}{f' named {photo}' if photo else ''} in {heads} (lam-head.sbatch "
                         f"NAME={person} writes {person}-<photo>_gs_offset.ply there)")
    obj = plys[0].with_name(plys[0].name.removesuffix("_gs_offset.ply") + "_textured_mesh.obj")
    if not obj.is_file():
        raise ValueError(f"{obj.name} is missing next to {plys[0].name}: rerun lam-head.sbatch, which now copies it")
    return plys[0], obj


# ---------------------------------------------------------------- geometry

def umeyama(src: np.ndarray, dst: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """(s, R, t) minimising |dst - (s R src + t)|^2 over paired points (N, 3) (Umeyama 1991, with scale)."""
    src, dst = np.asarray(src, dtype=np.float64), np.asarray(dst, dtype=np.float64)
    mu_s, mu_d = src.mean(0), dst.mean(0)
    a, b = src - mu_s, dst - mu_d
    U, D, Vt = np.linalg.svd(b.T @ a / len(src))
    S = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[2, 2] = -1
    R = U @ S @ Vt
    s = float(np.trace(np.diag(D) @ S) / (a ** 2).sum(1).mean())
    return s, R, mu_d - s * R @ mu_s


def wxyz_to_matrix(q: np.ndarray) -> np.ndarray:
    """3DGS rotations ([w, x, y, z], any length) to (N, 3, 3) matrices."""
    q = np.asarray(q, dtype=np.float64)
    w, x, y, z = (q / np.linalg.norm(q, axis=-1, keepdims=True)).T
    return np.stack([
        np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], -1),
        np.stack([2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], -1),
        np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], -1),
    ], -2)


def _matrix_to_wxyz(R: np.ndarray) -> np.ndarray:
    w = np.sqrt(max(0.0, 1 + np.trace(R))) / 2
    if w > 1e-6:
        return np.array([w, (R[2, 1] - R[1, 2]) / (4 * w), (R[0, 2] - R[2, 0]) / (4 * w), (R[1, 0] - R[0, 1]) / (4 * w)])
    i = int(np.argmax(np.diag(R)))
    j, k = (i + 1) % 3, (i + 2) % 3
    v = np.zeros(3)
    v[i] = np.sqrt(max(0.0, 1 + R[i, i] - R[j, j] - R[k, k])) / 2
    v[j], v[k] = (R[j, i] + R[i, j]) / (4 * v[i]), (R[k, i] + R[i, k]) / (4 * v[i])
    return np.array([(R[k, j] - R[j, k]) / (4 * v[i]), *v])


def transform_gaussians(g: Gaussians, s: float, R: np.ndarray, t: np.ndarray) -> Gaussians:
    """Gaussians under x -> s R x + t: means moved, each rotation turned by R, sizes scaled by s."""
    qr = _matrix_to_wxyz(np.asarray(R, dtype=np.float64))
    q = g.rotation / np.linalg.norm(g.rotation, axis=1, keepdims=True)
    w0, x0, y0, z0 = qr
    w, x, y, z = q.T
    rot = np.stack([w0 * w - x0 * x - y0 * y - z0 * z, w0 * x + x0 * w + y0 * z - z0 * y,
                    w0 * y - x0 * z + y0 * w + z0 * x, w0 * z + x0 * y - y0 * x + z0 * w], axis=1)
    return replace(g, xyz=s * g.xyz @ np.asarray(R).T + t, scale=g.scale + np.log(s), rotation=rot)


def read_obj_vertices(path: str | Path) -> np.ndarray:
    """(V, 3) vertex positions of an OBJ, in file order (extra columns such as vertex colours ignored)."""
    rows = [line.split()[1:4] for line in Path(path).read_text().splitlines() if line.startswith("v ")]
    return np.asarray(rows, dtype=np.float64).reshape(-1, 3)


def lam_head(offset_ply: str | Path, textured_obj: str | Path) -> tuple[Gaussians, np.ndarray]:
    """(LAM's head Gaussians at their positions with SH colour, every Gaussian's vertex (M, 3)), in LAM's space. The
    first 5023 vertices are its shaped FLAME mesh; the rest are the subdivision's edge midpoints."""
    g = read_ply(offset_ply)
    pos = read_obj_vertices(textured_obj)
    if len(pos) != len(g) or len(g) < FLAME_VERTS:
        raise ValueError(f"{textured_obj} has {len(pos)} vertices for {len(g)} Gaussians in {offset_ply} (need the same "
                         f"count, at least {FLAME_VERTS}): not the same LAM head?")
    rgb = np.clip(g.f_dc, 0, 1)
    return replace(g, xyz=pos, f_dc=(rgb - 0.5) / SH_C0, f_rest=np.zeros((len(g), 0))), pos - g.xyz


# ---------------------------------------------------------------- replace, skin, tone

def _alpha(logit: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-logit))


def _faded(logit: np.ndarray, factor: np.ndarray) -> np.ndarray:
    a = np.clip(_alpha(logit) * factor, 1e-6, 1 - 1e-6)
    return np.log(a / (1 - a))


def _subset(g: Gaussians, keep: np.ndarray) -> Gaussians:
    return replace(g, xyz=g.xyz[keep], f_dc=g.f_dc[keep], f_rest=g.f_rest[keep], opacity=g.opacity[keep],
                   scale=g.scale[keep], rotation=g.rotation[keep])


def cross_fade(body: Gaussians, dominant: np.ndarray, head: Gaussians, seam_y: float, band: float = BAND_M):
    """(body kept, its mask, head kept, its mask): the body's head, jaw and eye Gaussians above the seam go, its
    neck and head ones fade out over the band below it; the new head's Gaussians below the band go and fade in
    over it. The cut is horizontal in the rest pose, so it is a collar-free jaw line, not a ring round the neck."""
    by = body.xyz[:, 1]
    keep_b = ~(np.isin(dominant, HEAD_JOINTS) & (by > seam_y))
    fade_b = np.where(np.isin(dominant, SEAM_JOINTS), np.clip((seam_y - by) / band, 0, 1), 1.0)
    b = replace(body, opacity=_faded(body.opacity, fade_b))
    hy = head.xyz[:, 1]
    keep_h = hy >= seam_y - band
    h = replace(head, opacity=_faded(head.opacity, np.clip((hy - (seam_y - band)) / band, 0, 1)))
    return _subset(b, keep_b), keep_b, _subset(h, keep_h), keep_h


def nearest_vertex_skin(points: np.ndarray, verts: np.ndarray, lbs_weights: np.ndarray,
                        chunk: int = 4096) -> tuple[np.ndarray, np.ndarray]:
    """skin.bin records: each point takes the skinning weights of its nearest rest vertex (top 4, sum 255)."""
    points, verts = np.asarray(points, dtype=np.float64), np.asarray(verts, dtype=np.float64)
    vv = (verts ** 2).sum(1)
    nearest = np.concatenate([np.argmin(vv[None] - 2 * c @ verts.T, axis=1)
                              for c in np.array_split(points, max(1, -(-len(points) // chunk)))])
    return quantize_top4(np.asarray(lbs_weights, dtype=np.float64)[nearest])


def head_skin(points: np.ndarray, rows: np.ndarray, pairs: np.ndarray | None, flame_ids: np.ndarray,
              verts: np.ndarray, lbs_weights: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """skin.bin records for LAM's head Gaussians `rows` (at `points`, avatar space). A Gaussian on FLAME vertex i
    takes SMPL-X vertex flame_ids[i]'s weights, one on an edge's midpoint the mean of its two ends' (pairs, from
    face_expr.subdivision_parents): the exact twin, so an upper-lip Gaussian never takes the jaw's weights from a lower
    lip touching it. Without pairs, the midpoints fall back to their nearest SMPL-X vertex."""
    rows = np.asarray(rows)
    lbs = np.asarray(lbs_weights, dtype=np.float64)
    if pairs is None:
        pairs = np.full((rows.max(initial=0) + 1, 2), -1)
        pairs[:FLAME_VERTS] = np.arange(FLAME_VERTS)[:, None]
    p = pairs[rows]
    known = p[:, 0] >= 0
    idx = np.zeros((len(rows), 4), dtype=np.uint8)
    q = np.zeros((len(rows), 4), dtype=np.uint8)
    if known.any():
        idx[known], q[known] = quantize_top4(0.5 * (lbs[flame_ids[p[known, 0]]] + lbs[flame_ids[p[known, 1]]]))
    if (~known).any():
        idx[~known], q[~known] = nearest_vertex_skin(np.asarray(points)[~known], verts, lbs)
    return idx, q


def living_idle(src: Motion, source: dict | None) -> Motion | None:
    """The 20 s living idle (blinking through face_expr's blink channel) for an avatar whose motion is an idle: it
    stands in place (root within 5 cm, height within 3 cm) and isn't a digs-perform performance (source names an
    avatar and a motion). Betas, standing height and finger pose (DiGS's hand mean) come from the source. None when
    the motion is something to keep."""
    source = source or {}
    if "avatar" in source and "motion" in source:
        return None
    if np.ptp(src.root_t[:, [0, 2]], axis=0).max() > 0.05 or np.ptp(src.root_t[:, 1]) > 0.03:
        return None
    m = idle_loop(src.betas, IDLE_S, int(round(src.fps)), float(np.median(src.root_t[:, 1])),
                  blink_expr=np.eye(FE.N_CHANNELS)[FE.BLINK])
    m.pose[:, LEFT_HAND] = src.pose[0, LEFT_HAND]
    m.pose[:, RIGHT_HAND] = src.pose[0, RIGHT_HAND]
    return m


_M = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]])
_WHITE = _M.sum(1)


def rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """sRGB (..., 3) in 0..1 to CIELAB (D65)."""
    c = np.clip(np.asarray(rgb, dtype=np.float64), 0, 1)
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    xyz = lin @ _M.T / _WHITE
    f = np.where(xyz > (6 / 29) ** 3, np.cbrt(xyz), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def lab_to_rgb(lab: np.ndarray) -> np.ndarray:
    lab = np.asarray(lab, dtype=np.float64)
    fy = (lab[..., 0] + 16) / 116
    f = np.stack([fy + lab[..., 1] / 500, fy, fy - lab[..., 2] / 200], -1)
    xyz = np.where(f > 6 / 29, f ** 3, 3 * (6 / 29) ** 2 * (f - 4 / 29)) * _WHITE
    lin = xyz @ np.linalg.inv(_M).T
    c = np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * np.clip(lin, 0, None) ** (1 / 2.4) - 0.055)
    return np.clip(c, 0, 1)


def match_tone(head_rgb: np.ndarray, head_ring: np.ndarray, body_ring_rgb: np.ndarray) -> np.ndarray:
    """head_rgb with its Lab mean and spread on the ring (mask) moved to the body ring's, so face and hands agree.
    The spread ratio is clamped to 0.5..2 so a flat or noisy ring can't blow out the face."""
    lab = rgb_to_lab(head_rgb)
    src, ref = lab[head_ring], rgb_to_lab(body_ring_rgb)
    if len(src) < 10 or len(ref) < 10:
        return np.asarray(head_rgb, dtype=np.float64)
    sd_s, sd_r = src.std(0), ref.std(0)
    ratio = np.clip(np.where(sd_s > 1e-6, sd_r / np.maximum(sd_s, 1e-6), 1.0), 0.5, 2.0)
    return lab_to_rgb((lab - src.mean(0)) * ratio + ref.mean(0))


# ---------------------------------------------------------------- the bundle

def _rgb(g: Gaussians) -> np.ndarray:
    return 0.5 + SH_C0 * g.f_dc


def _smplx_rest(smplx_npz: str | Path, betas: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    m = np.load(smplx_npz, allow_pickle=True)
    joints, verts = rest_joints(m["v_template"], m["shapedirs"], m["J_regressor"], betas)
    return joints, verts, np.asarray(m["weights"], dtype=np.float64)


def swap_bundle(bundle: str | Path, offset_ply: str | Path, textured_obj: str | Path, smplx_npz: str | Path,
                flame_ids_npy: str | Path, dreams_dir: str | Path, new_id: str, name: str | None = None,
                seam_offset: float = 0.0, flame_npz: str | Path | None = None, keep_motion: bool = False) -> Path:
    """dreams_dir/new_id: the avatar bundle with LAM's head. Writes head_swap.json (the numbers) next to dream.json.
    The source's preview and thumb show the old face, so they are left out until the GPU step renders new ones.
    With flame_npz (flame_expr_npz.py's FLAME extract) the head gets avatar/expr.bin and, unless keep_motion or the
    source's motion is a performance, the 20 s living idle that blinks."""
    src = Path(bundle)
    dream = json.loads((src / "dream.json").read_text())
    av = dream["avatar"]
    body = read_ply(src / av["file"])
    idx, q = read_skin_bin(src / av.get("skin", SKIN_FILE))
    rest = np.asarray(json.loads((src / av.get("skeleton", SKELETON_FILE)).read_text())["rest"], dtype=np.float64)
    betas = Motion.load(src / av["motion"]).betas

    joints, verts, lbs = _smplx_rest(smplx_npz, betas)
    err = float(np.abs(joints - rest).max())
    if err > MAX_SKELETON_ERR_M:
        raise ValueError(f"skeleton.json is {err * 1000:.1f} mm from this SMPL-X model with the bundle's betas: not the "
                         "model DiGS used, or not this avatar's betas")

    head, base = lam_head(offset_ply, textured_obj)
    flame = base[:FLAME_VERTS]
    ids = np.load(flame_ids_npy).astype(np.int64).reshape(-1)
    if len(ids) != FLAME_VERTS:
        raise ValueError(f"{flame_ids_npy} has {len(ids)} ids, expected FLAME's {FLAME_VERTS}")
    s, R, t = umeyama(flame, verts[ids])
    rms = float(np.sqrt((((s * flame @ R.T + t) - verts[ids]) ** 2).sum(1).mean()))
    if rms > MAX_ALIGN_RMS_M:
        raise ValueError(f"LAM's FLAME mesh fits the SMPL-X head only to {rms * 100:.1f} cm RMS: wrong vertex ids?")
    head = transform_gaussians(head, s, R, t)
    pairs = expr_d = expr_report = None
    if flame_npz is not None:
        expr_d, pairs, expr_report = FE.head_channels(base, FE.load_flame(flame_npz))
        expr_d = s * expr_d @ R.T  # LAM's frame -> the avatar's (directions: rotation and scale, no shift)

    seam_y = float(rest[J["jaw"], 1] - SEAM_BELOW_JAW_M + seam_offset)
    dominant = idx[np.arange(len(idx)), np.argmax(q, axis=1)].astype(np.int64)
    ring_b = np.isin(dominant, SEAM_JOINTS) & (body.xyz[:, 1] <= seam_y) & (body.xyz[:, 1] > seam_y - RING_M)
    ring_h = (head.xyz[:, 1] <= seam_y) & (head.xyz[:, 1] > seam_y - RING_M)
    head = replace(head, f_dc=(match_tone(_rgb(head), ring_h, _rgb(body)[ring_b]) - 0.5) / SH_C0)

    body_k, keep_b, head_k, keep_h = cross_fade(body, dominant, head, seam_y)
    h_idx, h_q = head_skin(head_k.xyz, np.flatnonzero(keep_h), pairs, ids, verts, lbs)

    # what the photos really saw: the body as its reality.ply says (tinted = imagined); LAM's head from one frontal
    # photo, so its front half (SMPL-X's rest pose faces +Z)
    seen_b = np.ones(len(body), dtype=bool)
    if av.get("reality"):
        seen_b = np.isclose(read_ply(src / av["reality"]).f_dc, body.f_dc, atol=1e-5).all(axis=1)
    seen_h = (head_k.xyz[:, 2] - verts[ids][:, 2].mean()) > 0
    seen = np.concatenate([seen_b[keep_b], seen_h])

    n_rest = max(body_k.f_rest.shape[1], head_k.f_rest.shape[1])
    pad = lambda g: np.pad(g.f_rest, ((0, 0), (0, n_rest - g.f_rest.shape[1])))  # noqa: E731
    merged = Gaussians(xyz=np.concatenate([body_k.xyz, head_k.xyz]), f_dc=np.concatenate([body_k.f_dc, head_k.f_dc]),
                       f_rest=np.concatenate([pad(body_k), pad(head_k)]),
                       opacity=np.concatenate([body_k.opacity, head_k.opacity]),
                       scale=np.concatenate([body_k.scale, head_k.scale]),
                       rotation=np.concatenate([body_k.rotation, head_k.rotation]))

    out = Path(dreams_dir) / new_id
    if out.resolve() == src.resolve():
        raise ValueError("the head swap writes a new bundle; give it a new id")
    if out.exists() and not (out / "head_swap.json").is_file():
        raise ValueError(f"{out} exists and isn't a head swap; it is never replaced")
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(src, out, ignore=shutil.ignore_patterns("*.work", "preview.mp4", "thumb.jpg"))
    write_ply(out / av["file"], merged)
    write_skin_bin(out / av.get("skin", SKIN_FILE), np.concatenate([idx[keep_b], h_idx]), np.concatenate([q[keep_b], h_q]))
    tint = merged.f_dc.copy()
    tint[~seen] = 0.5 * tint[~seen] + 0.5 * (REALITY_TINT - 0.5) / SH_C0
    write_ply(out / REALITY_FILE, replace(merged, f_dc=tint))

    report = {"scale": round(s, 6), "alignRmsM": round(rms, 6), "seamY": round(seam_y, 4), "bandM": BAND_M,
              "bodyKept": int(keep_b.sum()), "bodyDropped": int((~keep_b).sum()), "headKept": int(keep_h.sum()),
              "headPhoto": Path(offset_ply).name.removesuffix("_gs_offset.ply"), "from": dream["id"], "motion": "kept"}
    avatar = {**av, "reality": REALITY_FILE}
    if expr_d is not None:
        FE.write_expr_bin(out / FE.EXPR_FILE, int(keep_b.sum()), expr_d[keep_h])
        avatar.update(expr=FE.EXPR_FILE, exprChannels=list(FE.EXPR_CHANNELS))
        report["expr"] = expr_report
        living = None if keep_motion else living_idle(Motion.load(src / av["motion"]), dream.get("source"))
        if living is not None:
            living.save(out / av["motion"])
            dream.update(fps=living.fps, frameCount=living.num_frames,
                         durationS=round(living.num_frames / living.fps, 3))
            report["motion"] = "living idle"
    (out / "head_swap.json").write_text(json.dumps(report, indent=2) + "\n")
    dream.update(id=new_id, name=name or f"{dream['name']} (LAM head)", preview=None, thumb=None)
    dream["avatar"] = avatar
    dream["metrics"] = {**(dream.get("metrics") or {}), "seenFraction": round(float(seen.mean()), 4)}
    dream["source"] = {**(dream.get("source") or {}),
                       "head": {"model": "LAM (aigc3d, SIGGRAPH 2025), one photo -> FLAME Gaussian head",
                                "photo": report["headPhoto"], "from": dream_id_of(src)}}
    (out / "dream.json").write_text(json.dumps(dream, indent=2) + "\n")
    return out


def dream_id_of(bundle: Path) -> str:
    return json.loads((Path(bundle) / "dream.json").read_text())["id"]
