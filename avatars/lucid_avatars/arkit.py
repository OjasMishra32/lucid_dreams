"""ARKit's 52 blendshapes, the two ways they reach us: weights per frame from LAM_Audio2Expression, and the shapes
themselves fitted to FLAME's topology (LAM's team did that by hand; the shapes ship in their chat-avatar template).

Audio -> weights: LAM_Audio2Expression (aigc3d, Apache-2.0) `inference.py` writes, with `save_json_path`,
    {"names": [52], "metadata": {"fps": 30.0, "frame_count": N, "blendshape_names": [52]},
     "frames": [{"weights": [52], "time": i / fps, "rotation": []}, ...]}
named per its `ARKitBlendShape` list (ARKIT_NAMES below, the standard ARKit order). read_a2e_json checks all of it.

Shapes on FLAME: `arkit_on_flame_npz.py` (cluster, FBX SDK) pulls the 52 morph-target deltas out of LAM's
`assets/sample_oac/template_file.fbx`. The FBX's mesh may be in another frame (axes, units), may be FLAME subdivided
once (20018 vertices, FLAME's 5023 first, as LAM orders its Gaussians) or reordered, so fit_to_flame finds which FBX
vertex is which FLAME vertex (by index when that fits FLAME's template, else by nearest neighbour) and refuses when
neither fits closely: a wrong correspondence would put the jaw's motion on the wrong vertices. The npz it makes
(`names`, `deltas` (52, 5023, 3) in FLAME's frame, metres) never leaves HiPerGator (licences).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .face_expr import FLAME_VERTS

ARKIT_NAMES = (
    "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight", "cheekPuff",
    "cheekSquintLeft", "cheekSquintRight", "eyeBlinkLeft", "eyeBlinkRight", "eyeLookDownLeft", "eyeLookDownRight",
    "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight", "eyeLookUpLeft", "eyeLookUpRight",
    "eyeSquintLeft", "eyeSquintRight", "eyeWideLeft", "eyeWideRight", "jawForward", "jawLeft", "jawOpen", "jawRight",
    "mouthClose", "mouthDimpleLeft", "mouthDimpleRight", "mouthFrownLeft", "mouthFrownRight", "mouthFunnel",
    "mouthLeft", "mouthLowerDownLeft", "mouthLowerDownRight", "mouthPressLeft", "mouthPressRight", "mouthPucker",
    "mouthRight", "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper", "mouthSmileLeft",
    "mouthSmileRight", "mouthStretchLeft", "mouthStretchRight", "mouthUpperUpLeft", "mouthUpperUpRight",
    "noseSneerLeft", "noseSneerRight", "tongueOut",
)
N_ARKIT = len(ARKIT_NAMES)
# What speech moves: the jaw, the lips and cheeks, the nose's wings. Not the brows or the eyes (the blink channel has
# the eyes; A2E also adds random blinks of its own) and not the tongue, which FLAME's mesh has no model of.
LOWER_FACE = tuple(i for i, n in enumerate(ARKIT_NAMES) if n.startswith(("jaw", "mouth", "cheek", "nose")))
MIN_FPS, MAX_FPS = 5.0, 120.0
MAX_WEIGHT = 5.0          # A2E's weights are about 0..1; far beyond that is not a blendshape weight
MAX_DELTA_M = 0.1         # a morph target moving a vertex over 10 cm is not metres on a head
MIN_JAW_OPEN_M = 0.005    # FLAME-frame jawOpen must move something at least 5 mm
FRAME_TIME_TOL_S = 2e-3   # frames[i].time against i / fps
MAX_RMS_REL = 0.04        # FBX mesh vs FLAME's template after fitting, as a share of the template's biggest extent
MAX_P99_REL = 0.10        # ... and no more than 1% of its vertices may sit farther than this from their FLAME twin
MIN_UNIQUE = 0.98         # share of FLAME's vertices that must land on distinct FBX vertices in a nearest match


# ---------------------------------------------------------------- A2E's JSON

@dataclass
class Utterance:
    fps: float
    weights: np.ndarray  # (T, 52), ARKIT_NAMES order

    @property
    def duration_s(self) -> float:
        return len(self.weights) / self.fps


def _order(names, what: str) -> list[int] | None:
    """Indices that put `names` into ARKIT_NAMES order; None if they are not the 52 ARKit names."""
    if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        raise ValueError(f"{what}: names must be a list of 52 strings")
    if len(names) != N_ARKIT or set(names) != set(ARKIT_NAMES):
        missing = sorted(set(ARKIT_NAMES) - set(names))
        raise ValueError(f"{what}: {len(names)} names, not ARKit's 52 (missing {missing[:4]}{'...' if len(missing) > 4 else ''})")
    return [names.index(n) for n in ARKIT_NAMES]


def read_a2e_json(path: str | Path) -> Utterance:
    """LAM_Audio2Expression's `save_json_path` file as per-frame weights in ARKIT_NAMES order. Raises ValueError for
    anything that isn't 52 finite weights per frame at a believable fps with frame times that agree with it."""
    try:
        return _read_a2e(path)
    except (TypeError, AttributeError, KeyError) as e:  # a field of the wrong type is a bad file, not a crash
        raise ValueError(f"{path}: not A2E's json ({type(e).__name__}: {e})") from e


def _read_a2e(path: str | Path) -> Utterance:
    try:
        d = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise ValueError(f"{path}: {e}") from e
    if not isinstance(d, dict) or not isinstance(d.get("frames"), list) or not isinstance(d.get("metadata"), dict):
        raise ValueError(f"{path}: not A2E's json (needs metadata and frames)")
    meta, frames = d["metadata"], d["frames"]
    order = _order(d.get("names", meta.get("blendshape_names")), f"{path} names")
    if "blendshape_names" in meta and list(meta["blendshape_names"]) != list(d.get("names", meta["blendshape_names"])):
        raise ValueError(f"{path}: names and metadata.blendshape_names disagree")
    fps = meta.get("fps")
    if isinstance(fps, bool) or not isinstance(fps, (int, float)) or not (MIN_FPS <= fps <= MAX_FPS):
        raise ValueError(f"{path}: metadata.fps {fps!r} isn't a frame rate between {MIN_FPS:g} and {MAX_FPS:g}")
    if len(frames) < 2:
        raise ValueError(f"{path}: {len(frames)} frames: no speech to move lips with")
    if "frame_count" in meta and meta["frame_count"] != len(frames):
        raise ValueError(f"{path}: metadata.frame_count {meta['frame_count']} but {len(frames)} frames")
    rows = []
    for i, f in enumerate(frames):
        w = f.get("weights") if isinstance(f, dict) else None
        if not isinstance(w, list) or len(w) != N_ARKIT:
            raise ValueError(f"{path}: frame {i} has {len(w) if isinstance(w, list) else 'no'} weights, expected {N_ARKIT}")
        rows.append(w)
        t = f.get("time")
        if t is not None and abs(t - i / fps) > FRAME_TIME_TOL_S:
            raise ValueError(f"{path}: frame {i} is at {t} s but {fps:g} fps puts it at {i / fps:.4f} s")
    try:
        weights = np.asarray(rows, dtype=np.float64)
    except (TypeError, ValueError) as e:
        raise ValueError(f"{path}: weights aren't all numbers ({e})") from e
    if not np.isfinite(weights).all():
        raise ValueError(f"{path}: weights must be finite")
    if np.abs(weights).max() > MAX_WEIGHT:
        raise ValueError(f"{path}: a weight of {np.abs(weights).max():.1f}: not an ARKit blendshape weight")
    return Utterance(float(fps), weights[:, order])


# ---------------------------------------------------------------- ARKit's shapes on FLAME

@dataclass
class ArkitOnFlame:
    deltas: np.ndarray  # (52, 5023, 3) metres, FLAME's frame, ARKIT_NAMES order

    @property
    def lower_face(self) -> np.ndarray:
        """(5023, 3, C): the speech shapes (LOWER_FACE) as direction fields, ready for face_expr.carry_fields."""
        return np.moveaxis(self.deltas[list(LOWER_FACE)], 0, 2)


def load_arkit_on_flame(path: str | Path) -> ArkitOnFlame:
    z = np.load(path)
    if "names" not in z or "deltas" not in z:
        raise ValueError(f"{path}: needs `names` and `deltas` (arkit_on_flame_npz.py writes them)")
    names = [str(n) for n in z["names"]]
    order = _order(names, f"{path} names")
    d = np.asarray(z["deltas"], dtype=np.float64)
    if d.shape != (N_ARKIT, FLAME_VERTS, 3):
        raise ValueError(f"{path}: deltas {d.shape}, expected ({N_ARKIT}, {FLAME_VERTS}, 3)")
    d = d[order]
    if not np.isfinite(d).all() or np.abs(d).max() > MAX_DELTA_M:
        raise ValueError(f"{path}: deltas must be finite and under {MAX_DELTA_M} m (metres in FLAME's frame)")
    if np.linalg.norm(d[ARKIT_NAMES.index("jawOpen")], axis=1).max() < MIN_JAW_OPEN_M:
        raise ValueError(f"{path}: jawOpen moves nothing over {MIN_JAW_OPEN_M * 1000:g} mm: wrong units or an empty shape")
    return ArkitOnFlame(d)


@dataclass
class FbxFit:
    """How an FBX mesh meets FLAME: FLAME = k R fbx + t on the vertices perm picks (perm[j] = the FBX vertex that is
    FLAME's vertex j)."""
    k: float
    R: np.ndarray
    t: np.ndarray
    perm: np.ndarray
    rms_m: float        # in FLAME's units, over FLAME's vertices
    rms_rel: float      # rms_m over the template's biggest extent
    route: str          # "index" (FLAME's vertices are the FBX's first ones, in order) or "nearest"
    unique: float       # share of FLAME's vertices on distinct FBX vertices
    p99_rel: float = 0.0  # the 99th percentile of the per-vertex distance, over the same extent


def _fit(base: np.ndarray, perm: np.ndarray, template: np.ndarray) -> tuple[float, np.ndarray, np.ndarray, float, float]:
    """(k, R, t, rms, p99): the similarity of base[perm] onto the template, the RMS and the 99th-percentile distance."""
    from .head_swap import umeyama  # head_swap imports face_expr, never this module

    k, R, t = umeyama(base[perm], template)
    dist = np.linalg.norm((k * base[perm] @ R.T + t) - template, axis=1)
    return k, R, t, float(np.sqrt((dist ** 2).mean())), float(np.percentile(dist, 99))


def _nearest(queries: np.ndarray, points: np.ndarray, chunk: int = 512) -> np.ndarray:
    pp = (points ** 2).sum(1)
    return np.concatenate([np.argmin(pp[None] - 2 * queries[s:s + chunk] @ points.T, axis=1)
                           for s in range(0, len(queries), chunk)])


def _cube_rotations() -> list[np.ndarray]:
    """The 24 proper rotations that map axes onto axes: every way an FBX export can turn a head up or sideways."""
    out = []
    for perm in ((0, 1, 2), (0, 2, 1), (1, 0, 2), (1, 2, 0), (2, 0, 1), (2, 1, 0)):
        for signs in np.ndindex(2, 2, 2):
            R = np.zeros((3, 3))
            for row, (col, s) in enumerate(zip(perm, signs)):
                R[row, col] = 1 - 2 * s
            if np.linalg.det(R) > 0:
                out.append(R)
    return out


def _icp(base: np.ndarray, template: np.ndarray, seeds: int = 24, rounds: int = 25):
    """(k, R, t, perm, rms, p99) of the best nearest-neighbour fit of `base` onto `template` from each axis-turn seed.
    perm[j] is the base vertex nearest FLAME's vertex j once aligned."""
    best = None
    extent = float(np.ptp(template, axis=0).max())
    for R0 in _cube_rotations()[:seeds]:
        turned = base @ R0.T
        k = extent / max(float(np.ptp(turned, axis=0).max()), 1e-12)
        t = template.mean(0) - k * turned.mean(0)
        R = R0
        for _ in range(rounds):
            perm = _nearest(template, k * base @ R.T + t)
            k, R, t, rms, p99 = _fit(base, perm, template)
        if best is None or rms < best[4]:
            best = (k, R, t, perm, rms, p99)
    return best  # type: ignore[return-value]


def fit_to_flame(base: np.ndarray, template: np.ndarray, max_rms_rel: float = MAX_RMS_REL) -> FbxFit:
    """Which FBX vertex is which FLAME vertex, and the similarity that carries the FBX's frame into FLAME's.

    base (n, 3): the FBX mesh's vertices (the morph targets' base); template (N, 3): FLAME's v_template. First the
    index route: if n >= N and the FBX's first N vertices fit the template (LAM's own order: FLAME's vertices, then the
    subdivision's edge midpoints). Otherwise the nearest-neighbour route (an export that reordered): iterate a
    similarity fit over nearest-vertex pairs from each of 24 axis turns, best fit wins. Either must come within
    max_rms_rel of the template's extent (and its worst 1% of vertices within MAX_P99_REL: a shuffle confined to the mouth
    must not pass on a global RMS), and the nearest route must also put FLAME's vertices on distinct FBX
    vertices (MIN_UNIQUE); otherwise ValueError: the correspondence isn't trustworthy."""
    base = np.asarray(base, dtype=np.float64)
    template = np.asarray(template, dtype=np.float64)
    extent = float(np.ptp(template, axis=0).max())
    n = len(template)
    tried = []
    if len(base) >= n:
        perm = np.arange(n)
        k, R, t, rms, p99 = _fit(base, perm, template)
        if rms / extent <= max_rms_rel and p99 / extent <= MAX_P99_REL:
            return FbxFit(k, R, t, perm, rms, rms / extent, "index", 1.0, p99 / extent)
        tried.append(f"in index order {rms / extent:.3f} (worst 1% {p99 / extent:.3f})")
    k, R, t, perm, rms, p99 = _icp(base, template)
    unique = len(np.unique(perm)) / n
    if rms / extent <= max_rms_rel and p99 / extent <= MAX_P99_REL and unique >= MIN_UNIQUE:
        return FbxFit(k, R, t, perm, rms, rms / extent, "nearest", unique, p99 / extent)
    tried.append(f"by nearest vertex {rms / extent:.3f} (worst 1% {p99 / extent:.3f}, {unique:.0%} distinct)")
    raise ValueError(f"the FBX mesh ({len(base)} vertices) doesn't match FLAME's template ({n}): rms over extent "
                     f"{'; '.join(tried)}, limit {max_rms_rel}. Refusing: a wrong vertex correspondence puts the jaw's "
                     "motion on the wrong vertices")


def shape_deltas(base: np.ndarray, shape_points: np.ndarray) -> np.ndarray:
    """Morph-target deltas (S, n, 3) from the FBX's shape control points (S, n, 3). The FBX SDK hands out a shape's
    absolute positions (the file stores deltas); should it ever hand out the deltas themselves, they sit near zero
    while the mesh doesn't: whichever reading leaves the smaller median length is the delta."""
    base = np.asarray(base, dtype=np.float64)
    pts = np.asarray(shape_points, dtype=np.float64)
    absolute = np.median(np.linalg.norm(pts - base, axis=2))
    as_delta = np.median(np.linalg.norm(pts, axis=2))
    return pts - base if absolute <= as_delta else pts


def deltas_on_flame(deltas: np.ndarray, fit: FbxFit) -> np.ndarray:
    """(S, n, 3) FBX-frame deltas -> (S, N, 3) in FLAME's frame and metres, in FLAME's vertex order."""
    return fit.k * np.asarray(deltas, dtype=np.float64)[:, fit.perm] @ fit.R.T


def plausibility_problems(deltas: np.ndarray, template: np.ndarray) -> list[str]:
    """Things a wrong frame or unit would show: jawOpen has to move the chin down (FLAME's +y is up), by centimetres,
    and the speech shapes (the ones that matter here) must all be present and finite."""
    problems = []
    j = np.asarray(deltas)[ARKIT_NAMES.index("jawOpen")]
    mag = np.linalg.norm(j, axis=1)
    if mag.max() < MIN_JAW_OPEN_M:
        problems.append(f"jawOpen moves at most {mag.max() * 1000:.2f} mm")
    else:
        mean = j[mag >= 0.5 * mag.max()].mean(0)
        if not (mean[1] < 0 and abs(mean[1]) >= max(abs(mean[0]), abs(mean[2]))):
            problems.append(f"jawOpen's biggest moves go {np.round(mean * 1000, 1).tolist()} mm, not down (-y)")
        if not 0.005 <= mag.max() <= 0.06:
            problems.append(f"jawOpen's biggest move is {mag.max() * 1000:.1f} mm: not a jaw opening in metres")
    return problems
