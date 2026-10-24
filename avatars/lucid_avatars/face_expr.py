"""Life in a head-swapped face: avatar/expr.bin, ten expression channels per head Gaussian, and the blink.

expr.bin (little-endian): uint32 first, uint32 count, then count x 10 x 3 float16. For Gaussian `first + i` of
avatar.ply and channel k, d[i][k] is an xyz offset in metres in the rest pose. A motion.json frame's `expr` (10
floats) weights the channels, added before skinning:

    x_rest' = x_rest + sum_k expr[k] * d[i][k]        (apply_expr; the head is one contiguous range at the end)

dream.json names them: "avatar": {..., "expr": "avatar/expr.bin", "exprChannels": EXPR_CHANNELS}.
Channels 0-8 are FLAME's first nine expression components (LAM animates its heads with FLAME's first ten), 9 is a
blink fitted to this person's own eyelids (1 = shut).

Where the offsets come from. LAM's head has one Gaussian per vertex of FLAME subdivided once: FLAME's 5023 vertices
first, then one per edge midpoint, and pytorch3d's subdivision gives a midpoint the average of its edge's attributes.
So each Gaussian's expression directions are FLAME's (shapedirs[:, :, 300:]) at its vertex, or the mean over its
edge (subdivision_parents finds the edge), moved into LAM's frame and then the avatar's.

The blink. FLAME's expression space was not built to shut eyes, so blink_field asks two things: FLAME's components
(ridge least squares) give the natural co-motion around the eye, capped so nothing beyond the eye region moves more
than LEAK_MAX_M, and the eyelids themselves go exactly where blink_target puts them: the upper margin comes down,
the lower comes up a little, and they meet. The lids slide over the eyeball (distance to its centre kept); the
eyeballs never move. The skin just around the lids follows the lids' correction with a smooth falloff.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

FLAME_VERTS = 5023
EXPR_FILE = "avatar/expr.bin"
EXPR_CHANNELS = (*(f"flame{i}" for i in range(9)), "blink")
BLINK = EXPR_CHANNELS.index("blink")
N_CHANNELS = len(EXPR_CHANNELS)
HEADER = struct.Struct("<II")

# FLAME's eyeballs are its last 2 x 546 vertices (LAM's FlameMask starts right_iris at 4477); the eyelids are LAM's
# own lists (lam/models/rendering/flame_model/flame.py, FlameMask.create_custom_mask, "left_eyelid"/"right_eyelid").
LEFT_EYEBALL = np.arange(3931, 4477)
RIGHT_EYEBALL = np.arange(4477, 5023)
LEFT_EYELID = np.array([807, 808, 809, 814, 815, 816, 821, 822, 823, 824, 825, 826, 827, 828, 829, 841, 842, 848, 864,
                        865, 877, 878, 879, 880, 881, 882, 883, 884, 885, 896, 897, 903, 904, 905, 922, 923, 924])
RIGHT_EYELID = np.array([2264, 2265, 2266, 2267, 2268, 2269, 2270, 2271, 2272, 2273, 2274, 2275, 2276, 2277, 2278,
                         2282, 2283, 2286, 2287, 2288, 2289, 2290, 2291, 2292, 2293, 2294, 2295, 2296, 2297, 2298, 2299])
EYES = ((LEFT_EYEBALL, LEFT_EYELID), (RIGHT_EYEBALL, RIGHT_EYELID))

UPPER_SHARE = 0.8      # the upper lid travels 80% of the way, the lower 20% (a real blink is mostly the upper lid)
ENVELOPE_W = 0.04      # x window, as a share of the eye's width, for the lid margins
NEAR = 2.5             # eyeball radii from an eye centre: the eye region
LEAK_MAX_M = 3e-4      # FLAME's co-motion may move nothing outside the eye region more than 0.3 mm
SPREAD_SIGMA = 0.3     # eyeball radii: how far the lids' correction spreads into the skin around them
RIDGE = 1e-4           # ridge weight, relative to the mean diagonal of the normal equations


@dataclass
class Flame:
    """What the expression channels need from FLAME 2023 (flame_expr_npz.py extracts it on HiPerGator)."""
    v_template: np.ndarray  # (5023, 3)
    faces: np.ndarray       # (F, 3)
    expr_dirs: np.ndarray   # (5023, 3, C >= 9): FLAME's expression basis, metres per unit coefficient


def load_flame(path: str | Path) -> Flame:
    z = np.load(path)
    v, f, e = (np.asarray(z[k]) for k in ("v_template", "faces", "expr_dirs"))
    if v.shape != (FLAME_VERTS, 3) or e.shape[:2] != (FLAME_VERTS, 3) or e.shape[2] < N_CHANNELS - 1:
        raise ValueError(f"{path}: v_template {v.shape}, expr_dirs {e.shape}: not FLAME's 5023 vertices x 3 x >= 9")
    if f.ndim != 2 or f.shape[1] != 3 or f.max() >= FLAME_VERTS:
        raise ValueError(f"{path}: faces {f.shape} don't index FLAME's vertices")
    return Flame(v.astype(np.float64), f.astype(np.int64), e.astype(np.float64))


# ---------------------------------------------------------------- the blink

def _envelope(x: np.ndarray, y: np.ndarray, w: float, lowest: bool) -> tuple[np.ndarray, np.ndarray]:
    """A lid's margin as (xs, ys), sorted by x: the vertices with no lower (upper lid) or higher (lower lid) one
    within w in x. Rows of lid skin above the upper margin are not on it."""
    keep = [i for i in range(len(x))
            if not ((np.abs(x - x[i]) <= w) & ((y < y[i]) if lowest else (y > y[i]))).any()]
    order = np.argsort(x[keep])
    return x[keep][order], y[keep][order]


def _eye(v: np.ndarray, eyeball: np.ndarray, lid: np.ndarray):
    """(centre, radius, upper lid ids, lower lid ids, margin(x) -> (upper y, lower y)) of one eye."""
    c = v[eyeball].mean(0)
    r = float(np.linalg.norm(v[eyeball] - c, axis=1).mean())
    up, lo = lid[v[lid, 1] > c[1]], lid[v[lid, 1] <= c[1]]
    w = ENVELOPE_W * float(np.ptp(v[lid, 0]))
    eu, el = _envelope(v[up, 0], v[up, 1], w, True), _envelope(v[lo, 0], v[lo, 1], w, False)

    def margins(x):
        return np.interp(x, *eu), np.interp(x, *el)

    return c, r, up, lo, margins


def _slide(p: np.ndarray, dy: np.ndarray, c: np.ndarray) -> np.ndarray:
    """Points moved by dy in y, then along z so they keep their distance from the eye centre c (front side)."""
    d2 = ((p - c) ** 2).sum(1)
    y = p[:, 1] + dy
    rad = d2 - (p[:, 0] - c[0]) ** 2 - (y - c[1]) ** 2
    z = np.where(rad > 0, c[2] + np.sign(p[:, 2] - c[2] + 1e-12) * np.sqrt(np.maximum(rad, 0)), p[:, 2])
    return np.stack([p[:, 0], y, z], 1)


def blink_target(v: np.ndarray, eyes=EYES) -> np.ndarray:
    """(V, 3) where the eyelids go to shut the eyes; zero everywhere else. At each x across the eye the upper margin
    comes down UPPER_SHARE of the opening and the lower margin up the rest, so they meet; lid skin above (below) the
    margin follows with a taper; the lids slide over the eyeball."""
    v = np.asarray(v, dtype=np.float64)
    t = np.zeros_like(v)
    for eyeball, lid in eyes:
        c, r, up, lo, margins = _eye(v, eyeball, lid)
        for ids, upper in ((up, True), (lo, False)):
            y_u, y_l = margins(v[ids, 0])
            gap = np.maximum(y_u - y_l, 0)
            meet = y_l + (1 - UPPER_SHARE) * gap
            margin = y_u if upper else y_l
            beyond = np.abs(v[ids, 1] - margin)  # how far into the lid skin past the margin
            taper = np.clip(1 - 0.5 * beyond / r, 0.5, 1)
            t[ids] = _slide(v[ids], (meet - margin) * taper, c) - v[ids]
    return t


def open_fraction(v: np.ndarray, moved: np.ndarray, eyes=EYES) -> float:
    """How open the eyes are after `moved`, as a share of before: the margins' gap over the middle 60% of each eye."""
    moved = np.asarray(moved, dtype=np.float64)
    before, after = [], []
    for eyeball, lid in eyes:
        c, _, up, lo, margins = _eye(v, eyeball, lid)  # upper / lower by where the lids started
        half = 0.3 * float(np.ptp(v[lid, 0]))
        xs = np.linspace(c[0] - half, c[0] + half, 15)
        u0, l0 = margins(xs)
        w = ENVELOPE_W * float(np.ptp(v[lid, 0]))
        eu = _envelope(moved[up, 0], moved[up, 1], w, True)
        el = _envelope(moved[lo, 0], moved[lo, 1], w, False)
        before.append(np.maximum(u0 - l0, 0).sum())
        after.append((np.interp(xs, *eu) - np.interp(xs, *el)).sum())
    return float(sum(after) / max(sum(before), 1e-12))


def blink_field(v: np.ndarray, expr_dirs: np.ndarray, eyes=EYES) -> tuple[np.ndarray, dict]:
    """(V, 3) displacement that shuts the eyes (see the module docstring) and a report: openFraction (0 = shut),
    pcaShare (how much of the lids' motion FLAME's own expressions explain), leakMm (largest move outside the eye
    region, in mm if v is in metres)."""
    v = np.asarray(v, dtype=np.float64)
    D = np.asarray(expr_dirs, dtype=np.float64)
    V, C = len(v), D.shape[2]
    target = blink_target(v, eyes)
    geo = [_eye(v, eyeball, lid) for eyeball, lid in eyes]
    lids = np.concatenate([lid for _, lid in eyes])
    balls = np.concatenate([ball for ball, _ in eyes])
    dist = np.min([np.linalg.norm(v - c, axis=1) / r for c, r, *_ in geo], axis=0)  # in eyeball radii
    far = dist > NEAR

    w = np.where(far, 0.3, 0.05)
    w[lids], w[balls] = 1.0, 3.0
    A = (D * w[:, None, None]).reshape(V * 3, C)
    b = (target * w[:, None]).reshape(V * 3)
    AtA = A.T @ A
    ridge = RIDGE * np.trace(AtA) / C or 1.0  # a basis that never moves the face fits nothing, not a crash
    coef = np.linalg.solve(AtA + ridge * np.eye(C), A.T @ b)
    pca = D @ coef
    leak = float(np.linalg.norm(pca[far], axis=1).max()) if far.any() else 0.0
    if leak > LEAK_MAX_M:
        pca *= LEAK_MAX_M / leak

    field = pca.copy()
    field[lids] = target[lids]
    res = target[lids] - pca[lids]
    near = np.flatnonzero(~far)
    near = near[~np.isin(near, np.concatenate([lids, balls]))]
    if len(near):
        sigma = SPREAD_SIGMA * float(np.mean([r for _, r, *_ in geo]))
        d2 = ((v[near, None] - v[None, lids]) ** 2).sum(-1)
        dmin2 = d2.min(1, keepdims=True)
        g = np.exp(-(d2 - dmin2) / sigma ** 2)
        field[near] += (g @ res) / g.sum(1, keepdims=True) * np.exp(-dmin2 / sigma ** 2)
    field[balls] = 0.0

    t_l = target[lids]
    share = 1 - ((t_l - pca[lids]) ** 2).sum() / max((t_l ** 2).sum(), 1e-30)
    report = {"openFraction": round(open_fraction(v, v + field, eyes), 4),
              "pcaShare": round(float(np.clip(share, 0, 1)), 4),
              "leakMm": round(float(np.linalg.norm(field[far], axis=1).max() * 1000) if far.any() else 0.0, 4)}
    return field, report


# ---------------------------------------------------------------- from FLAME to LAM's Gaussians

def subdivision_parents(base: np.ndarray, faces: np.ndarray, n: int | None = None,
                        chunk: int = 512) -> tuple[np.ndarray, int]:
    """(M, 2) vertex pair per point of a once-subdivided mesh: (i, i) for the n original vertices (default
    faces.max() + 1), the edge whose midpoint it is for the rest, in any order. A point that is no edge's midpoint
    (within 2% of the median edge) follows its nearest vertex; the count of those is returned too."""
    base = np.asarray(base, dtype=np.float64)
    n = int(faces.max()) + 1 if n is None else n
    edges = np.unique(np.sort(np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), axis=1), axis=0)
    v = base[:n]
    mids = (v[edges[:, 0]] + v[edges[:, 1]]) / 2
    tol = 0.02 * float(np.median(np.linalg.norm(v[edges[:, 0]] - v[edges[:, 1]], axis=1)))
    pairs = np.stack([np.arange(len(base))] * 2, axis=1)
    rest = base[n:]
    mm, vv = (mids ** 2).sum(1), (v ** 2).sum(1)
    unmatched = 0
    for s in range(0, len(rest), chunk):
        p = rest[s:s + chunk]
        pp = (p ** 2).sum(1, keepdims=True)
        d2 = pp - 2 * p @ mids.T + mm
        best = d2.argmin(1)
        ok = np.sqrt(np.maximum(d2[np.arange(len(p)), best], 0)) <= tol
        nearest = (pp - 2 * p @ v.T + vv).argmin(1)
        pairs[n + s:n + s + len(p)] = np.where(ok[:, None], edges[best], np.stack([nearest] * 2, axis=1))
        unmatched += int((~ok).sum())
    return pairs, unmatched


def head_channels(base: np.ndarray, flame: Flame) -> tuple[np.ndarray, np.ndarray, dict]:
    """((M, 10, 3) expression offsets per LAM Gaussian in LAM's frame, (M, 2) its FLAME vertex pair, report).

    base is every Gaussian's vertex in LAM's canonical space (position - offset), FLAME's 5023 first. FLAME's
    template is fitted to LAM's mesh with a similarity, so the blink is worked out on this person's own eyelids in
    FLAME's frame and every direction is carried into LAM's by the fit's rotation and scale."""
    from .head_swap import umeyama  # head_swap imports this module

    base = np.asarray(base, dtype=np.float64)
    lam = base[:FLAME_VERTS]
    k, R0, t0 = umeyama(flame.v_template, lam)
    rms = float(np.sqrt((((k * flame.v_template @ R0.T + t0) - lam) ** 2).sum(1).mean()))
    person = (lam - t0) @ R0 / k  # this head's own shape, in FLAME's frame
    blink, blink_report = blink_field(person, flame.expr_dirs)
    channels = np.concatenate([flame.expr_dirs[:, :, :N_CHANNELS - 1], blink[:, :, None]], axis=2)  # (V, 3, 10)
    pairs, unmatched = subdivision_parents(base, flame.faces, FLAME_VERTS)
    per = 0.5 * (channels[pairs[:, 0]] + channels[pairs[:, 1]])  # (M, 3, 10)
    d = k * np.einsum("ij,mjc->mci", R0, per)
    report = {"channels": list(EXPR_CHANNELS), "templateRmsMm": round(rms / k * 1000, 4),
              "subdivision": {"matched": int(len(base) - FLAME_VERTS - unmatched), "unmatched": unmatched},
              "blink": blink_report}
    return d, pairs, report


# ---------------------------------------------------------------- expr.bin

def write_expr_bin(path: str | Path, first: int, d: np.ndarray) -> None:
    d = np.asarray(d, dtype=np.float64)
    if d.ndim != 3 or d.shape[1:] != (N_CHANNELS, 3):
        raise ValueError(f"expr offsets must be (count, {N_CHANNELS}, 3), got {d.shape}")
    if np.abs(d).max(initial=0) > 1.0:
        raise ValueError("an expression offset over 1 m: not metres in the rest pose")
    Path(path).write_bytes(HEADER.pack(first, len(d)) + d.astype("<f2").tobytes())


def read_expr_bin(path: str | Path) -> tuple[int, np.ndarray]:
    raw = Path(path).read_bytes()
    if len(raw) < HEADER.size:
        raise ValueError(f"{len(raw)} bytes, shorter than the header")
    first, count = HEADER.unpack_from(raw)
    want = HEADER.size + count * N_CHANNELS * 3 * 2
    if len(raw) != want:
        raise ValueError(f"{len(raw)} bytes for {count} Gaussians: expected {want}")
    d = np.frombuffer(raw, dtype="<f2", offset=HEADER.size).reshape(count, N_CHANNELS, 3)
    return first, d.astype(np.float32)


def expr_errors(root: Path, avatar: dict, n_gaussians: int) -> list[str]:
    """Problems with the expr.bin a dream.json names; nothing to check when it names none."""
    if "expr" not in avatar:
        return ["dream.json: avatar.exprChannels without avatar.expr"] if "exprChannels" in avatar else []
    errors = []
    names = avatar.get("exprChannels")
    if not (isinstance(names, list) and len(names) == N_CHANNELS and all(isinstance(s, str) for s in names)):
        errors.append(f"dream.json: avatar.exprChannels must name the {N_CHANNELS} channels")
    try:
        first, d = read_expr_bin(Path(root) / avatar["expr"])
    except (OSError, ValueError, TypeError) as e:
        return errors + [f"expr.bin: {e}"]
    if first + len(d) != n_gaussians:
        errors.append(f"expr.bin: covers Gaussians {first}..{first + len(d) - 1}, but the head range must end at the "
                      f"last of avatar.ply's {n_gaussians}")
    if not np.isfinite(d).all():
        errors.append("expr.bin: offsets must be finite")
    return errors


def apply_expr(xyz_rest: np.ndarray, first: int, d: np.ndarray, expr: np.ndarray) -> np.ndarray:
    """The reference for players: rest positions with one frame's expression added, before skinning."""
    out = np.array(xyz_rest, dtype=np.float64)
    out[first:first + len(d)] += np.einsum("k,ikc->ic", np.asarray(expr, dtype=np.float64), d)
    return out
