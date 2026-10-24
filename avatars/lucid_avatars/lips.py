"""A consenting person's own voice moves their own lips in a head-swapped bundle.

Consenting people only (head_swap.VOICE_CONSENTED: today only `vishal`, his own voice, his own say-so; AGENTS.md rule
5: never anyone else's voice, never a public figure's). `hpg/lips.sbatch` runs LAM_Audio2Expression on the wav, then
this module, which is plain numpy:

  1. A2E's weights per frame for ARKit's 52 blendshapes (arkit.read_a2e_json).
  2. ARKit's shapes on FLAME (arkit.load_arkit_on_flame) carried onto LAM's head Gaussians exactly as face_expr carries
     FLAME's expressions (face_expr.lam_fit + carry_fields: vertex pairs of the once-subdivided mesh, k R0 into LAM's
     frame, then s R into the avatar's), the speech shapes only (arkit.LOWER_FACE).
  3. For this utterance, every frame's mouth displacement of every head Gaussian is weights x shapes. Its 9 principal
     components (SVD over frames, about the neutral face, since expr 0 = neutral) become channels `mouth0`..`mouth8`
     of a new avatar/expr.bin; channel 9 stays the head swap's own `blink`. mouth_pca never builds the (frames x
     Gaussians) matrix: displacement is linear in the 32 weights, so the SVD runs on a QR of the shapes.
  4. motion.json = the living idle (idle.py) as long as the clip, `expr` per frame = the 9 coefficients and the idle's
     own blink curve. Coefficients are unit-variance, channels carry the metres: x_rest + sum_k expr[k] d[i][k].
  5. voice.m4a is the audio itself (AGENTS.md bundle contract); captions are another pipeline's job.

lips.json (next to head_swap.json) says how much of the mouth's motion the 9 channels keep (varianceKept: against the
motion's own mean, the stricter way; energyKept: against neutral) and the clip length.
"""

from __future__ import annotations

import json
import math
import shutil
from dataclasses import replace
from pathlib import Path

import numpy as np

from . import arkit as A
from . import face_expr as FE
from .gaussian_ply import read_ply
from .head_swap import (MAX_ALIGN_RMS_M, FLAME_VERTS, _smplx_rest, lam_head, living_idle, transform_gaussians,
                        umeyama, voice_consent_errors)
from .motion import Motion

N_MOUTH = 9
MOUTH_CHANNELS = (*(f"mouth{i}" for i in range(N_MOUTH)), "blink")
LIPS_FILE = "lips.json"
VOICE_FILE = "voice.m4a"
MIN_VARIANCE_KEPT = 0.95  # what the slide wants; below it lips.json says so and the CLI warns, it doesn't refuse
MIN_SPEECH_M = 1e-5       # RMS mouth displacement over the clip under this: silent audio, nothing to move
MAX_PEAK_M = 0.06         # a head Gaussian moving 6 cm in speech: wrong units or shapes
ROW_TOL_M = 2e-5          # a head Gaussian recomputed here vs the bundle's own (float32 on disk)
CHECK_RTOL = 5e-3         # FLAME channels recomputed here vs the bundle's expr.bin (float16 on disk)


# ---------------------------------------------------------------- the channels

def mouth_pca(d: np.ndarray, w: np.ndarray, n: int = N_MOUTH, chunk: int = 256) -> tuple[np.ndarray, np.ndarray, dict]:
    """(coefficients (T, n), channels (M, n, 3), report) for shapes d (M, C, 3) (metres per unit weight per Gaussian)
    and weights w (T, C) per frame. The per-frame displacement is X = w D (D: C x 3M); its first n principal
    components about zero (the neutral face) are the channels, the coefficients are unit-variance over the clip
    (channel k = sigma_k/sqrt(T) times its direction, in metres), so w D ~ coeffs @ channels. Components beyond the
    rank are zero. The sign of each is fixed so its biggest coefficient is positive."""
    d = np.asarray(d, dtype=np.float64)
    w = np.asarray(w, dtype=np.float64)
    M, C, _ = d.shape
    T = len(w)
    if w.shape != (T, C):
        raise ValueError(f"weights {w.shape} don't fit shapes for {C} blendshapes")
    D = d.transpose(1, 0, 2).reshape(C, M * 3)
    Q, Rq = np.linalg.qr(D.T)                       # D^T = Q Rq, Q orthonormal (3M, C)
    Y = w @ Rq.T                                    # X = Y Q^T and |X| = |Y| (Q has orthonormal columns)
    U, S, Vt = np.linalg.svd(Y, full_matrices=False)
    k = min(n, int((S > 1e-9 * max(S[0], 1e-300)).sum()))  # directions with no energy are not channels
    energy, resid = float((S ** 2).sum()), float((S[k:] ** 2).sum())
    centred = float(((Y - Y.mean(0)) ** 2).sum())
    rms = math.sqrt(energy / (T * M))
    if rms < MIN_SPEECH_M:
        raise ValueError(f"the mouth moves {rms * 1e6:.2f} um RMS over the clip: silent audio, or A2E found no speech")
    coeffs = np.zeros((T, n))
    channels = np.zeros((M, n, 3))
    scale = math.sqrt(T)
    coeffs[:, :k] = U[:, :k] * scale
    dirs = (S[:k, None] / scale) * (Vt[:k] @ Q.T)   # (k, 3M)
    flip = np.sign(coeffs[np.abs(coeffs[:, :k]).argmax(0), np.arange(k)])
    flip[flip == 0] = 1
    coeffs[:, :k] *= flip
    dirs *= flip[:, None]  # the product coeffs @ dirs is unchanged by flipping both
    channels[:, :k] = dirs.reshape(k, M, 3).transpose(1, 0, 2)
    peak = max((float(np.linalg.norm((coeffs[s:s + chunk, :k] @ dirs).reshape(-1, M, 3), axis=2).max())
                for s in range(0, T, chunk)), default=0.0)
    report = {"components": k, "energyKept": round(1 - resid / energy, 5),
              "varianceKept": round(float(np.clip(1 - resid / max(centred, 1e-30), 0, 1)), 5),
              "rmsMm": round(rms * 1000, 4), "peakMm": round(peak * 1000, 3)}
    if peak > MAX_PEAK_M:
        raise ValueError(f"a head Gaussian moves {peak * 100:.1f} cm in speech: wrong units or shapes")
    return coeffs, channels, report


def resample(coeffs: np.ndarray, fps_in: float, fps_out: float, n_out: int) -> np.ndarray:
    """(n_out, k): the coefficients, frame i at i / fps_in, read at f / fps_out by linear interpolation (the last
    frame held beyond the end). Interpolating the coefficients is the same as interpolating the weights."""
    t_in = np.arange(len(coeffs)) / fps_in
    t_out = np.arange(n_out) / fps_out
    return np.stack([np.interp(t_out, t_in, coeffs[:, k]) for k in range(coeffs.shape[1])], axis=1)


def frames_for(duration_s: float, fps: float) -> int:
    """Motion frames that cover the clip (the last frame is at or after its end)."""
    return max(1, math.ceil(duration_s * fps - 1e-9))


def lips_motion(src: Motion, source: dict | None, coeffs: np.ndarray, fps_a2e: float) -> Motion | None:
    """The living idle as long as the clip with `expr` = the mouth coefficients and the idle's own blink curve, in
    MOUTH_CHANNELS order. None when the avatar's motion is something to keep (a performance: its length is its own)."""
    n = frames_for(len(coeffs) / fps_a2e, float(int(round(src.fps))))
    idle = living_idle(src, source, seconds=n / int(round(src.fps)))
    if idle is None:
        return None
    if idle.num_frames != n:
        raise AssertionError(f"idle has {idle.num_frames} frames, wanted {n}")
    mouth = resample(coeffs, fps_a2e, idle.fps, n)
    return replace(idle, expr=np.concatenate([mouth, idle.expr[:, FE.BLINK:FE.BLINK + 1]], axis=1))


# ---------------------------------------------------------------- the bundle

def match_rows(all_xyz: np.ndarray, kept_xyz: np.ndarray, tol: float = ROW_TOL_M) -> np.ndarray:
    """Which rows of all_xyz the kept points are, in order (the head swap keeps a subset, in order). ValueError if
    some kept point isn't the next matching row: the head recomputed here isn't the one in the bundle."""
    rows = np.empty(len(kept_xyz), dtype=np.int64)
    j = 0
    for i in range(len(all_xyz)):
        if j < len(kept_xyz) and np.abs(all_xyz[i] - kept_xyz[j]).max() <= tol:
            rows[j] = i
            j += 1
    if j != len(kept_xyz):
        raise ValueError(f"only {j} of the bundle's {len(kept_xyz)} head Gaussians are in this LAM head: not the head "
                         "(photo, SMPL-X files) this bundle was swapped with")
    return rows


def lips_bundle(bundle: str | Path, person: str, offset_ply: str | Path, textured_obj: str | Path,
                smplx_npz: str | Path, flame_ids_npy: str | Path, flame_npz: str | Path, arkit_npz: str | Path,
                a2e_json: str | Path, voice_m4a: str | Path, dreams_dir: str | Path, new_id: str,
                name: str | None = None, held: str | Path | None = None) -> Path:
    """dreams_dir/new_id: a head-swapped bundle (head_swap.swap_bundle with FLAME, so it has expr.bin) whose lips follow
    this utterance. The consent gate runs first and raises PermissionError before anything is read or written."""
    src = Path(bundle)
    refused = voice_consent_errors(person, src, held, new_id)
    if refused:
        raise PermissionError("; ".join(refused))
    voice = Path(voice_m4a)
    if voice.suffix.lower() != ".m4a" or not voice.is_file() or voice.stat().st_size == 0:
        raise ValueError(f"{voice} must be the audio itself as a non-empty .m4a (AGENTS.md bundle contract: voice.m4a)")
    if not (src / "head_swap.json").is_file():
        raise ValueError(f"{src} isn't a head swap (no head_swap.json): the lips go on a <person>-head bundle")
    dream = json.loads((src / "dream.json").read_text())
    av = dream["avatar"]
    if av.get("exprChannels") != list(FE.EXPR_CHANNELS) or "expr" not in av:
        raise ValueError(f"{src} has no FLAME expr.bin (exprChannels {av.get('exprChannels')}): head-swap it with "
                         "FLAME first (or it already has a voice: start from the head swap)")

    utt = A.read_a2e_json(a2e_json)
    arkit = A.load_arkit_on_flame(arkit_npz)
    flame = FE.load_flame(flame_npz)
    first, d_old = FE.read_expr_bin(src / av["expr"])
    body = read_ply(src / av["file"])
    kept_xyz = body.xyz[first:first + len(d_old)]
    src_motion = Motion.load(src / av["motion"])

    # the head as the swap had it: LAM's Gaussians, aligned to this avatar's SMPL-X head
    head, base = lam_head(offset_ply, textured_obj)
    ids = np.load(flame_ids_npy).astype(np.int64).reshape(-1)
    if len(ids) != FLAME_VERTS:
        raise ValueError(f"{flame_ids_npy} has {len(ids)} ids, expected FLAME's {FLAME_VERTS}")
    _, verts, _ = _smplx_rest(smplx_npz, src_motion.betas)
    s, R, t = umeyama(base[:FLAME_VERTS], verts[ids])
    rms = float(np.sqrt((((s * base[:FLAME_VERTS] @ R.T + t) - verts[ids]) ** 2).sum(1).mean()))
    if rms > MAX_ALIGN_RMS_M:
        raise ValueError(f"LAM's FLAME mesh fits the SMPL-X head only to {rms * 100:.1f} cm RMS: wrong vertex ids?")
    rows = match_rows(transform_gaussians(head, s, R, t).xyz, kept_xyz)

    fit = FE.lam_fit(base, flame)

    def to_avatar(fields: np.ndarray) -> np.ndarray:  # (5023, 3, C) in FLAME's frame -> (count, C, 3) in the avatar's
        return (s * FE.carry_fields(fields, fit) @ R.T)[rows]

    # the bundle's own FLAME channels, recomputed by this route, must be what expr.bin holds: the same Gaussians, frame
    # and subdivision pairs (so ARKit's shapes land where FLAME's expressions already do)
    check = to_avatar(flame.expr_dirs[:, :, :FE.N_CHANNELS - 1])
    err = float(np.abs(check - d_old[:, :FE.N_CHANNELS - 1]).max())
    if err > CHECK_RTOL * max(float(np.abs(d_old[:, :FE.N_CHANNELS - 1]).max()), 1e-9):
        raise ValueError(f"expr.bin's FLAME channels differ from this route's by {err * 1000:.3f} mm: the head, FLAME "
                         "file or SMPL-X files aren't the ones the bundle was swapped with")

    shapes = to_avatar(arkit.lower_face)  # (count, 32, 3)
    coeffs, mouth, pca = mouth_pca(shapes, utt.weights[:, list(A.LOWER_FACE)])
    motion = lips_motion(src_motion, dream.get("source"), coeffs, utt.fps)
    if motion is None:
        raise ValueError(f"{src}'s motion is a performance (its own length): lips go on an idle head swap")
    d_new = np.concatenate([mouth, d_old[:, FE.BLINK:FE.BLINK + 1]], axis=1)  # mouth0..8, then the swap's own blink

    if Path(dreams_dir).resolve() != src.resolve().parent:  # the gate judged <bundle's folder>/<new_id> and its .held
        raise ValueError(f"dreams_dir {dreams_dir} isn't the folder holding {src.name}")
    out = Path(dreams_dir) / new_id
    if out.resolve() == src.resolve():
        raise ValueError("the lips go in a new bundle; give it a new id")
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(src, out, ignore=shutil.ignore_patterns("*.work"))
    FE.write_expr_bin(out / FE.EXPR_FILE, first, d_new)
    motion.save(out / av["motion"])
    shutil.copyfile(voice, out / VOICE_FILE)
    report = {"person": person, "clipS": round(utt.duration_s, 3), "a2e": {"fps": utt.fps, "frames": len(utt.weights),
                                                                          "shapes": [A.ARKIT_NAMES[i] for i in A.LOWER_FACE]},
              "motionFps": motion.fps, "motionFrames": motion.num_frames, "channels": list(MOUTH_CHANNELS),
              **pca, "meetsTarget": pca["varianceKept"] >= MIN_VARIANCE_KEPT, "target": MIN_VARIANCE_KEPT,
              "flameChannelCheckMm": round(err * 1000, 5), "voice": VOICE_FILE, "from": dream["id"]}
    (out / LIPS_FILE).write_text(json.dumps(report, indent=2) + "\n")
    src_id = dream["id"]
    dream.update(id=new_id, name=name or f"{dream['name']} (voice)", fps=motion.fps, frameCount=motion.num_frames,
                 durationS=round(motion.num_frames / motion.fps, 3))
    dream["avatar"] = {**av, "exprChannels": list(MOUTH_CHANNELS)}
    dream["source"] = {**(dream.get("source") or {}),
                       "voice": {"model": "LAM_Audio2Expression (aigc3d, Apache-2.0): speech -> ARKit blendshapes on "
                                          "FLAME, 9 principal components per utterance", "audio": VOICE_FILE,
                                 "person": person, "from": src_id}}
    (out / "dream.json").write_text(json.dumps(dream, indent=2) + "\n")
    return out
