"""The player's real face on the generated views: an identity swap on 4DAnyone's view videos (court-job FACEFIX).

4DAnyone invents the faces the broadcast camera never saw. This keeps each generated face's pose, light and expression
and takes its identity from a few real crops of the same player (a ref dir of .jpg/.png crops, one face each):
SCRFD finds the face and its 5 points, inswapper_128 renders it with the reference identity (the mean ArcFace embedding
of the crops) and a feathered mask pastes it back. Per video the 5 points are smoothed over time and the swap fades in
and out with the face's size and turn (a profile or the back of the head gets nothing), so the frames don't flicker; a
video in which no face qualifies is not written at all, and the job keeps its original byte for byte.

  python court_facefix.py fix   --ref DIR --models DIR --out DIR [--report F] video.mp4...  fixed copies in --out
  python court_facefix.py score --ref DIR --models DIR --frame K [--judge F] video.mp4...    ArcFace cosine at frame K
  python court_facefix.py refs  --ref DIR --models DIR                                       each crop vs the rest

Models (one dir): det_10g.onnx and w600k_r50.onnx (InsightFace buffalo_l), inswapper_128.onnx and
inswapper_emap.npy (the swapper's last initializer, saved once so this needs no onnx package). numpy, OpenCV,
onnxruntime (CUDA when it works, else CPU) and ffmpeg/ffprobe on PATH.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np

# ArcFace's 5-point template at 112 px: eyes, nose tip, mouth corners (the subject's right first, as SCRFD gives them)
ARC = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]],
               np.float32)
DET_SCORE = 0.5   # SCRFD score for a face
MIN_EYE = 9.0     # px between the eyes: smaller faces fade out (full strength from 1.5x this)
TURN = (0.5, 0.75)  # nose off the eyes' midpoint, in eye distances (three-quarter views 0.2-0.45, SCRFD's points on a
                    # profile 1-10): full swap below the first, none past the second
GAP = 3           # missed frames inside a run of detections that are bridged
ERODE = 2         # frames trimmed off each end of a run before the fade (runs shorter than 2*ERODE+1 vanish)
SIGMA_PTS = 1.2   # temporal smoothing of the 5 points, frames
SIGMA_GATE = 1.0  # the fade's softness, frames
CRF = 12          # x264 quality of the fixed videos (near lossless at these sizes)
IMAGES = (".jpg", ".jpeg", ".png")


# --- geometry -----------------------------------------------------------------------------------------------------
def similarity(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Least-squares similarity transform (Umeyama, no reflection) taking points src onto dst, as a 2x3 matrix."""
    src, dst = np.asarray(src, np.float64), np.asarray(dst, np.float64)
    ms, md = src.mean(0), dst.mean(0)
    s, d = src - ms, dst - md
    u, sv, vt = np.linalg.svd(d.T @ s / len(src))
    e = np.ones(2)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        e[1] = -1
    r = u @ np.diag(e) @ vt
    scale = (sv * e).sum() / s.var(0).sum()
    return np.hstack([scale * r, (md - scale * r @ ms)[:, None]]).astype(np.float32)


def align(kps: np.ndarray, size: int) -> np.ndarray:
    """The 2x3 matrix taking a face's 5 points onto ArcFace's template at size 112 (recognition) or 128 (inswapper,
    InsightFace's norm_crop2: the 112 template shifted 8 px right)."""
    if size % 112 == 0:
        dst = ARC * (size / 112)
    else:
        r = size / 128
        dst = ARC * r
        dst[:, 0] += 8 * r
    return similarity(kps, dst)


def turn(kps: np.ndarray) -> float:
    """How far the nose sits off the eyes' midpoint along the eye line, in eye distances: 0 frontal, ~0.5 profile."""
    le, re, nose = kps[0], kps[1], kps[2]
    v = re - le
    return abs(float(np.dot(nose - le, v) / max(float(np.dot(v, v)), 1e-6)) - 0.5)


def eye_px(kps: np.ndarray) -> float:
    return float(np.linalg.norm(kps[1] - kps[0]))


def smoothstep(x: float, a: float, b: float) -> float:
    t = min(max((x - a) / (b - a), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def inside(kps: np.ndarray, width: int, height: int) -> float:
    """The share of the face's aligned 128 px box (its bounding box in the image) that lies inside the frame."""
    pts = cv2.transform(np.array([[[0, 0], [128, 0], [0, 128], [128, 128]]], np.float32),
                        cv2.invertAffineTransform(align(kps, 128)))[0]
    (x0, y0), (x1, y1) = pts.min(0), pts.max(0)
    area = max((x1 - x0) * (y1 - y0), 1e-6)
    return float(max(0.0, min(x1, width) - max(x0, 0)) * max(0.0, min(y1, height) - max(y0, 0)) / area)


def face_gate(kps: np.ndarray, min_eye: float = MIN_EYE, turn_range: tuple[float, float] = TURN,
              frame: tuple[int, int] | None = None) -> float:
    """0..1: how much of the swap a face gets for its size and turn (and, given the frame's (width, height), for how
    much of it is in the picture: a face cut by the edge fades out)."""
    g = smoothstep(eye_px(kps), min_eye, 1.5 * min_eye) * (1.0 - smoothstep(turn(kps), *turn_range))
    return g * smoothstep(inside(kps, *frame), 0.75, 0.9) if frame else g


# --- SCRFD (det_10g) -----------------------------------------------------------------------------------------------
def nms(boxes: np.ndarray, scores: np.ndarray, thr: float = 0.4) -> list[int]:
    order = scores.argsort()[::-1]
    area = (boxes[:, 2] - boxes[:, 0] + 1) * (boxes[:, 3] - boxes[:, 1] + 1)
    keep = []
    while order.size:
        i, rest = order[0], order[1:]
        keep.append(int(i))
        w = np.maximum(0.0, np.minimum(boxes[i, 2], boxes[rest, 2]) - np.maximum(boxes[i, 0], boxes[rest, 0]) + 1)
        h = np.maximum(0.0, np.minimum(boxes[i, 3], boxes[rest, 3]) - np.maximum(boxes[i, 1], boxes[rest, 1]) + 1)
        inter = w * h
        order = rest[inter / (area[i] + area[rest] - inter) <= thr]
    return keep


def scrfd_decode(outs: list[np.ndarray], width: int, height: int, thr: float = DET_SCORE):
    """SCRFD's 9 raw outputs (scores, box distances, point offsets at strides 8, 16, 32; two anchors per cell) at an
    input of width x height -> boxes (n, 4), scores (n,), kps (n, 5, 2) in input pixels, after NMS."""
    bs, ss, ks = [], [], []
    for i, stride in enumerate((8, 16, 32)):
        sc = outs[i].reshape(-1)
        bb = outs[i + 3].reshape(-1, 4) * stride
        kp = outs[i + 6].reshape(-1, 5, 2) * stride
        gh, gw = height // stride, width // stride
        c = np.stack(np.mgrid[:gh, :gw][::-1], -1).reshape(-1, 2).astype(np.float32) * stride
        c = np.repeat(c, 2, axis=0)
        m = sc >= thr
        c = c[m]
        ss.append(sc[m])
        bs.append(np.hstack([c - bb[m, :2], c + bb[m, 2:]]))
        ks.append(c[:, None, :] + kp[m])
    boxes, scores, kps = np.concatenate(bs), np.concatenate(ss), np.concatenate(ks)
    if not len(scores):
        return boxes.reshape(0, 4), scores, kps.reshape(0, 5, 2)
    keep = nms(boxes, scores)
    return boxes[keep], scores[keep], kps[keep]


# --- the models ----------------------------------------------------------------------------------------------------
def _providers(ort, cpu_only: bool) -> list:
    if not cpu_only and "CUDAExecutionProvider" in ort.get_available_providers():
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


class Faces:
    """SCRFD + ArcFace (+ inswapper when swapping) through onnxruntime; CUDA if it runs, else CPU."""

    def __init__(self, models: Path, swap: bool = True, cpu_only: bool = False, threads: int | None = None):
        import onnxruntime as ort
        if hasattr(ort, "preload_dlls") and not cpu_only:
            try:  # CUDA/cuDNN from the nvidia-* wheels beside torch, when the env has them
                ort.preload_dlls()
            except Exception:  # noqa: BLE001 - CPU still works
                pass
        self.ort, self.models = ort, Path(models)
        self.threads = threads or int(os.environ.get("OMP_NUM_THREADS", "0") or 0) or None
        self.providers = _providers(ort, cpu_only)
        try:
            self._load(swap)
        except Exception as e:  # noqa: BLE001 - a CUDA EP that loads but can't run on this GPU
            if self.providers[0] == "CPUExecutionProvider":
                raise
            print(f"[facefix] CUDA failed ({type(e).__name__}: {str(e)[:200]}); on CPU", file=sys.stderr)
            self.providers = ["CPUExecutionProvider"]
            self._load(swap)

    def _session(self, name: str):
        o = self.ort.SessionOptions()
        o.log_severity_level = 3
        if self.threads:
            o.intra_op_num_threads = self.threads
        return self.ort.InferenceSession(str(self.models / name), o, providers=self.providers)

    def _load(self, swap: bool):
        self.det = self._session("det_10g.onnx")
        self.rec = self._session("w600k_r50.onnx")
        self.det_in = self.det.get_inputs()[0].name
        self.rec_in = self.rec.get_inputs()[0].name
        self.swapper = None
        if swap:
            self.swapper = self._session("inswapper_128.onnx")
            self.emap = np.load(self.models / "inswapper_emap.npy").astype(np.float32)
        # warm up: a CUDA EP that can't run here fails now, not mid-video
        z = np.zeros((128, 128, 3), np.uint8)
        self.detect(z)
        self.embed(z, ARC + 8)
        if swap:
            self.swap(z, ARC + 8, np.ones(512, np.float32) / np.sqrt(512))
        sessions = [self.det, self.rec] + ([self.swapper] if swap else [])
        self.used = "+".join(sorted({x.get_providers()[0] for x in sessions}))
        if self.providers[0] == "CUDAExecutionProvider" and self.used != "CUDAExecutionProvider":
            print(f"[facefix] CUDA was asked for but the networks run on {self.used}", file=sys.stderr)

    def detect(self, img: np.ndarray, thr: float = DET_SCORE, size: int = 640):
        """Faces in a BGR image: boxes (n, 4), scores (n,), kps (n, 5, 2) in image pixels."""
        h, w = img.shape[:2]
        s = min(size / w, size / h)
        nw, nh = max(1, int(round(w * s))), max(1, int(round(h * s)))
        pad = np.zeros((size, size, 3), np.uint8)
        pad[:nh, :nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
        blob = cv2.dnn.blobFromImage(pad, 1.0 / 128, (size, size), (127.5, 127.5, 127.5), swapRB=True)
        boxes, scores, kps = scrfd_decode(self.det.run(None, {self.det_in: blob}), size, size, thr)
        return boxes / s, scores, kps / s

    def detect_one(self, img: np.ndarray, thr: float = DET_SCORE, near: np.ndarray | None = None):
        """The largest face (or, given `near`, last frame's box, the face around it), its 5 points refined on a crop
        where it is ~150 px: (score, box, kps) or None."""
        if near is not None:
            r = self._refine(img, near, thr)
            if r is not None:
                return r
        boxes, scores, kps = self.detect(img, thr)
        if not len(scores):
            return None
        i = int(np.argmax((boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])))
        return self._refine(img, boxes[i], thr) or (float(scores[i]), boxes[i], kps[i])

    def _refine(self, img: np.ndarray, b: np.ndarray, thr: float):
        side = 2.5 * max(b[2] - b[0], b[3] - b[1])
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        x0, y0, n = int(round(cx - side / 2)), int(round(cy - side / 2)), max(8, int(round(side)))
        crop = np.zeros((n, n, 3), np.uint8)
        h, w = img.shape[:2]
        sx0, sy0, sx1, sy1 = max(x0, 0), max(y0, 0), min(x0 + n, w), min(y0 + n, h)
        if sx1 <= sx0 or sy1 <= sy0:
            return None
        crop[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = img[sy0:sy1, sx0:sx1]
        rb, rs, rk = self.detect(crop, thr, size=384)
        if not len(rs):
            return None
        j = int(np.argmin(np.hypot((rb[:, 0] + rb[:, 2]) / 2 - n / 2, (rb[:, 1] + rb[:, 3]) / 2 - n / 2)))
        return float(rs[j]), rb[j] + [x0, y0, x0, y0], rk[j] + [x0, y0]

    def embed(self, img: np.ndarray, kps: np.ndarray, sess=None) -> np.ndarray:
        """L2-normalised ArcFace embedding of the face at kps (sess: another 112 px recogniser, e.g. a judge)."""
        crop = cv2.warpAffine(img, align(kps, 112), (112, 112), borderValue=0.0)
        blob = cv2.dnn.blobFromImage(crop, 1.0 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True)
        sess = sess or self.rec
        v = sess.run(None, {sess.get_inputs()[0].name: blob})[0][0].astype(np.float32)
        return v / max(float(np.linalg.norm(v)), 1e-12)

    def latent(self, identity: np.ndarray) -> np.ndarray:
        """inswapper's source vector for an ArcFace identity."""
        v = identity.astype(np.float32) @ self.emap
        return v / np.linalg.norm(v)

    def swap(self, img: np.ndarray, kps: np.ndarray, latent: np.ndarray):
        """(the swapped 128 px face as float32 BGR, its 2x3 alignment matrix)."""
        m = align(kps, 128)
        crop = cv2.warpAffine(img, m, (128, 128), borderMode=cv2.BORDER_REPLICATE)
        blob = cv2.dnn.blobFromImage(crop, 1.0 / 255, (128, 128), (0, 0, 0), swapRB=True)
        out = self.swapper.run(None, {"target": blob, "source": latent[None].astype(np.float32)})[0][0]
        return np.clip(out.transpose(1, 2, 0)[:, :, ::-1] * 255.0, 0, 255).astype(np.float32), m


def paste_mask(size: int = 128) -> np.ndarray:
    """The feathered region of the 128 px aligned face that is pasted: brow to chin, cheek to cheek, soft edges."""
    m = np.zeros((size, size), np.float32)
    cv2.ellipse(m, (64, 70), (44, 54), 0, 0, 360, 1.0, -1)
    return cv2.GaussianBlur(m, (0, 0), 6.0)


MASK = paste_mask()


def paste(img: np.ndarray, face: np.ndarray, m: np.ndarray, alpha: float) -> np.ndarray:
    """img (uint8) with face (128 px, aligned by m) blended in at alpha through the feathered mask."""
    h, w = img.shape[:2]
    inv = cv2.invertAffineTransform(m)
    pts = cv2.transform(np.array([[[0, 0], [128, 0], [0, 128], [128, 128]]], np.float32), inv)[0]
    x0, y0 = np.floor(pts.min(0)).astype(int) - 2
    x1, y1 = np.ceil(pts.max(0)).astype(int) + 2
    x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, w), min(y1, h)
    if x1 <= x0 or y1 <= y0:
        return img
    inv[:, 2] -= [x0, y0]
    size = (x1 - x0, y1 - y0)
    f = cv2.warpAffine(face, inv, size, flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    a = cv2.warpAffine(MASK, inv, size, flags=cv2.INTER_LINEAR, borderValue=0.0)[..., None] * alpha
    out = img.copy()
    roi = out[y0:y1, x0:x1].astype(np.float32)
    out[y0:y1, x0:x1] = np.clip(roi * (1 - a) + f * a + 0.5, 0, 255).astype(np.uint8)
    return out


# --- the reference identity ----------------------------------------------------------------------------------------
def ref_images(ref: Path) -> list[Path]:
    return sorted(p for p in Path(ref).iterdir() if p.suffix.lower() in IMAGES and not p.name.startswith(("_", ".")))


def ref_embeddings(faces: Faces, ref: Path, sess=None) -> tuple[list[str], np.ndarray]:
    """(names, embeddings) of the face in every crop of the ref dir (a crop without a face is an error)."""
    names, embs = [], []
    for p in ref_images(ref):
        img = cv2.imread(str(p))
        f = None if img is None else faces.detect_one(img, thr=0.3)
        if f is None:
            raise SystemExit(f"facefix: no face in reference {p}")
        names.append(p.name)
        embs.append(faces.embed(img, f[2], sess))
    if not embs:
        raise SystemExit(f"facefix: no reference crops (.jpg/.png) in {ref}")
    return names, np.stack(embs)


def mean_identity(embs: np.ndarray) -> np.ndarray:
    v = embs.mean(0)
    return v / np.linalg.norm(v)


# --- video ---------------------------------------------------------------------------------------------------------
def packets(path: Path) -> int:
    return int(subprocess.run(["ffprobe", "-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries",
                               "stream=nb_read_packets", "-of", "csv=p=0", str(path)], capture_output=True, text=True,
                              check=True).stdout.strip())


def probe(path: Path) -> tuple[int, int, str]:
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height,r_frame_rate", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True, check=True).stdout.strip().split(",")
    return int(out[0]), int(out[1]), out[2]


def read_frames(path: Path) -> tuple[list[np.ndarray], str]:
    w, h, rate = probe(path)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-fps_mode", "passthrough", "-f", "rawvideo",
                          "-pix_fmt", "bgr24", "-"], capture_output=True, check=True).stdout
    n = len(raw) // (w * h * 3)
    if n * w * h * 3 != len(raw) or n != packets(path):
        raise RuntimeError(f"{path}: decoded {len(raw) / (w * h * 3):.2f} frames of {packets(path)}")
    a = np.frombuffer(raw, np.uint8).reshape(n, h, w, 3)
    return [a[i] for i in range(n)], rate


def write_frames(path: Path, frames: list[np.ndarray], rate: str, crf: int = CRF):
    """H.264 (yuv420p) at the given rate, every frame kept: checked by counting the packets before it is in place."""
    h, w = frames[0].shape[:2]
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.stem + ".part.mp4")
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
                          "-r", rate, "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", str(crf),
                          "-pix_fmt", "yuv420p", "-r", rate, str(tmp)], stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(np.ascontiguousarray(f).tobytes())
    p.stdin.close()
    if p.wait():
        raise RuntimeError(f"ffmpeg failed writing {path}")
    n = packets(tmp)
    if n != len(frames):
        raise RuntimeError(f"{path}: wrote {n} frames, wanted {len(frames)}")
    os.replace(tmp, path)


# --- the swap over a video, steady in time -------------------------------------------------------------------------
def _gauss(n: int, sigma: float) -> np.ndarray:
    r = max(1, int(round(2 * sigma)))
    x = np.arange(-r, r + 1, dtype=np.float64)
    return np.exp(-0.5 * (x / sigma) ** 2)


def plan(kps: list[np.ndarray | None], gates: list[float], gap: int = GAP, erode: int = ERODE,
         sigma_pts: float = SIGMA_PTS, sigma_gate: float = SIGMA_GATE) -> tuple[np.ndarray, np.ndarray]:
    """Per frame: smoothed 5 points (n, 5, 2; NaN where nothing is pasted) and the swap's strength 0..1.
    Gaps of up to `gap` missed frames inside a run are bridged linearly; each run's points are smoothed with a
    Gaussian over its own frames only; the strength is the per-frame gate trimmed by `erode` frames at each end of a
    run (so a run fades in and out instead of popping) and blurred."""
    n = len(kps)
    pts = np.full((n, 5, 2), np.nan)
    g = np.zeros(n)
    for i, (k, s) in enumerate(zip(kps, gates)):
        if k is not None:
            pts[i], g[i] = k, s
    have = ~np.isnan(pts[:, 0, 0])
    idx = np.flatnonzero(have)
    for a, b in zip(idx[:-1], idx[1:]):  # bridge short gaps
        if 1 < b - a <= gap + 1:
            for t in range(a + 1, b):
                u = (t - a) / (b - a)
                pts[t] = (1 - u) * pts[a] + u * pts[b]
                g[t] = (1 - u) * g[a] + u * g[b]
    have = ~np.isnan(pts[:, 0, 0])
    out = np.full_like(pts, np.nan)
    kern = _gauss(n, sigma_pts)
    r = len(kern) // 2
    for t in np.flatnonzero(have):
        lo, hi = max(0, t - r), min(n, t + r + 1)
        w = kern[lo - t + r:hi - t + r] * have[lo:hi]
        seg = np.where(have[lo:hi, None, None], pts[lo:hi], 0.0)
        out[t] = (w[:, None, None] * seg).sum(0) / w.sum()
    ge = g.copy()
    for t in range(n):  # trim run ends: the min over +-erode frames (a missed frame is 0; the video's ends aren't)
        lo, hi = max(0, t - erode), min(n, t + erode + 1)
        ge[t] = g[lo:hi].min() if have[lo:hi].all() else 0.0
    kern = _gauss(n, sigma_gate)
    r = len(kern) // 2
    gs = np.zeros(n)
    for t in range(n):
        lo, hi = max(0, t - r), min(n, t + r + 1)
        w = kern[lo - t + r:hi - t + r]
        gs[t] = (w * ge[lo:hi]).sum() / w.sum()
    gs[~have] = 0.0
    gs[gs < 0.02] = 0.0
    out[gs == 0] = np.nan
    return out, gs


def fix_video(faces: Faces, src: Path, dst: Path, latent: np.ndarray, strength: float = 1.0,
              min_eye: float = MIN_EYE, turn_range: tuple[float, float] = TURN) -> dict:
    """Swap the face through one view video. Writes dst only when some frame changed; returns its record."""
    t0 = time.time()
    frames, rate = read_frames(src)
    kps, gates, turns, near = [], [], [], None
    for f in frames:
        d = faces.detect_one(f, near=near)
        near = None if d is None else d[1]
        if d is None:
            kps.append(None)
            gates.append(0.0)
            turns.append(None)
            continue
        kps.append(d[2])
        gates.append(face_gate(d[2], min_eye, turn_range, (f.shape[1], f.shape[0])))
        turns.append(round(turn(d[2]), 3))
    pts, strength_t = plan(kps, gates)
    strength_t = strength_t * strength
    changed = np.flatnonzero(strength_t > 0)
    rec = {"video": src.name, "frames": len(frames), "rate": rate, "detected": int(sum(k is not None for k in kps)),
           "swapped": int(len(changed)), "strength": [round(float(s), 3) for s in strength_t], "turn": turns,
           "eye_px": [None if k is None else round(eye_px(k), 1) for k in kps]}
    if len(changed):
        out = list(frames)
        for t in changed:
            face, m = faces.swap(frames[t], pts[t], latent)
            out[t] = paste(frames[t], face, m, float(strength_t[t]))
        write_frames(dst, out, rate)
        rec["out"] = str(dst)
    rec["seconds"] = round(time.time() - t0, 1)
    return rec


# --- CLI -----------------------------------------------------------------------------------------------------------
def frame_at(path: Path, k: int) -> np.ndarray:
    frames, _ = read_frames(path)
    return frames[min(k, len(frames) - 1)]


def cmd_fix(a) -> int:
    faces = Faces(a.models, swap=True, cpu_only=a.cpu)
    names, embs = ref_embeddings(faces, a.ref)
    ident = mean_identity(embs)
    latent = faces.latent(ident)
    a.out.mkdir(parents=True, exist_ok=True)
    print(f"[facefix] {len(names)} reference crop(s), self-agreement {float((embs @ ident).mean()):.3f}; "
          f"{len(a.videos)} video(s) on {faces.used}", flush=True)
    recs = []
    for v in a.videos:
        r = fix_video(faces, v, a.out / v.name, latent, a.strength, a.min_eye, (a.turn_full, a.turn_none))
        recs.append(r)
        print(f"[facefix] {v.name}: face in {r['detected']}/{r['frames']} frames, swapped {r['swapped']}"
              f"{' -> ' + r['out'] if 'out' in r else ' (left as is)'} in {r['seconds']} s", flush=True)
    if a.report:
        a.report.write_text(json.dumps({"provider": faces.used, "refs": names, "videos": recs}, indent=1))
    return 0


def cmd_score(a) -> int:
    faces = Faces(a.models, swap=False, cpu_only=a.cpu)
    judges = {"arcface": None}
    if a.judge:
        judges[Path(a.judge).stem] = faces._session(Path(a.judge).name) if Path(a.judge).parent == faces.models \
            else faces.ort.InferenceSession(str(a.judge), providers=faces.providers)
    idents = {j: mean_identity(ref_embeddings(faces, a.ref, s)[1]) for j, s in judges.items()}
    rows = []
    for v in a.videos:
        img = frame_at(v, a.frame)
        d = faces.detect_one(img, thr=0.3)
        row = {"video": str(v), "frame": a.frame, "face": d is not None}
        if d is not None:
            row.update(turn=round(turn(d[2]), 3), eye_px=round(eye_px(d[2]), 1))
            for j, s in judges.items():
                row[j] = round(float(faces.embed(img, d[2], s) @ idents[j]), 4)
        rows.append(row)
        print(json.dumps(row), flush=True)
    if a.report:
        a.report.write_text(json.dumps(rows, indent=1))
    return 0


def cmd_refs(a) -> int:
    faces = Faces(a.models, swap=True, cpu_only=a.cpu)
    names, embs = ref_embeddings(faces, a.ref)
    for i, n in enumerate(names):
        rest = mean_identity(np.delete(embs, i, 0)) if len(names) > 1 else embs[i]
        print(f"{n}: {float(embs[i] @ rest):.3f} to the others")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("fix", "score", "refs"):
        s = sub.add_parser(name)
        s.add_argument("--ref", type=Path, required=True, help="dir of the player's real face crops")
        s.add_argument("--models", type=Path, required=True)
        s.add_argument("--cpu", action="store_true", help="never CUDA")
        if name != "refs":
            s.add_argument("--report", type=Path)
            s.add_argument("videos", type=Path, nargs="+")
    f = sub.choices["fix"]
    f.add_argument("--out", type=Path, required=True, help="the fixed videos (same names); untouched ones not written")
    f.add_argument("--strength", type=float, default=1.0, help="0..1: how much of the swap is blended in")
    f.add_argument("--min-eye", type=float, default=MIN_EYE)
    f.add_argument("--turn-full", type=float, default=TURN[0])
    f.add_argument("--turn-none", type=float, default=TURN[1])
    s = sub.choices["score"]
    s.add_argument("--frame", type=int, required=True)
    s.add_argument("--judge", help="another 112 px recogniser .onnx scored beside ArcFace (e.g. glintr100)")
    a = p.parse_args(argv)
    return {"fix": cmd_fix, "score": cmd_score, "refs": cmd_refs}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
