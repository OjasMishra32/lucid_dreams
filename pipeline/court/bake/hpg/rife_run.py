"""RIFE in-betweens for the show bake (runs on a GPU node; plain torch + numpy + OpenCV or Pillow, no repo imports).

Reads needs.json (rife_needs.py: pairs [{a, b, w, out}], checks [{a, m, c, w}], frame_pattern) and the raw frames it
names, and writes each pair's `out` (the frame a -> b at time fraction w) with Practical-RIFE (hzwer, MIT): any
timestep, scale 1.0 at 1080p, inputs padded to a multiple of 128 as its inference_video.py does. Then scores the
held-out checks (a -> c at m's time vs the real frame m: PSNR, RIFE and a plain dissolve) into checks.json, and
writes done.json (counts, timing, model file hash). Outputs already present are kept (a rerun resumes).

    python rife_run.py --rife DIR --frames DIR --needs needs.json --out DIR [--fp16] [--quality 95] [--fake]
DIR for --rife: a Practical-RIFE checkout whose train_log/ holds a v4.x model (RIFE_HDv3.py, IFNet_HDv3.py,
flownet.pkl). --fake blends instead of running RIFE (for the Mac test of this script's plumbing only).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import types
from pathlib import Path

import numpy as np

try:
    import cv2
except ImportError:  # Pillow fallback
    cv2 = None
    from PIL import Image


def read_rgb(path: Path) -> np.ndarray:
    if cv2 is not None:
        img = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if img is None:
            raise FileNotFoundError(path)
        return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    return np.asarray(Image.open(path).convert("RGB"))


def write_rgb(path: Path, img: np.ndarray, quality: int) -> None:
    tmp = path.with_name(path.stem + ".part" + path.suffix)
    if cv2 is not None:
        params = []
        if path.suffix.lower() in (".jpg", ".jpeg"):
            params = [cv2.IMWRITE_JPEG_QUALITY, quality]
            if hasattr(cv2, "IMWRITE_JPEG_SAMPLING_FACTOR"):
                params += [cv2.IMWRITE_JPEG_SAMPLING_FACTOR, cv2.IMWRITE_JPEG_SAMPLING_FACTOR_444]
        if not cv2.imwrite(str(tmp), cv2.cvtColor(img, cv2.COLOR_RGB2BGR), params):
            raise OSError(f"could not write {path}")
    else:
        kw = {"quality": quality, "subsampling": 0} if path.suffix.lower() in (".jpg", ".jpeg") else {}
        Image.fromarray(img).save(tmp, **kw)
    tmp.replace(path)


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    e = np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2)
    return 99.0 if e < 1e-10 else float(10 * np.log10(255.0 ** 2 / e))


class Blend:
    name = "fake-blend"

    def __call__(self, a, b, w):
        return np.clip((1 - w) * a.astype(np.float32) + w * b.astype(np.float32) + 0.5, 0, 255).astype(np.uint8)


class Rife:
    def __init__(self, rife_dir: Path, fp16: bool, scale: float = 1.0):
        import torch
        import torch.nn.functional as F

        self.torch, self.F, self.scale, self.fp16 = torch, F, scale, fp16
        sys.path.insert(0, str(rife_dir))
        try:
            import torchvision  # noqa: F401  (model/loss.py imports it; only training uses it)
        except ImportError:
            stub = types.ModuleType("model.loss")
            for n in ("EPE", "SOBEL", "VGGPerceptualLoss", "Ternary"):
                setattr(stub, n, type(n, (torch.nn.Module,), {"forward": lambda self, *a, **k: 0}))
            sys.modules["model.loss"] = stub
        from train_log.RIFE_HDv3 import Model  # Practical-RIFE v4.x

        torch.backends.cudnn.benchmark = True
        self.model = Model()
        # Model.load_model(-1) keeps only "module."-prefixed keys and loads non-strictly: a checkpoint without the
        # prefix would silently leave random weights. Load it ourselves, strictly.
        sd = torch.load(str(rife_dir / "train_log" / "flownet.pkl"), map_location="cpu", weights_only=True)
        sd = {k.replace("module.", "", 1): v for k, v in sd.items()}
        res = self.model.flownet.load_state_dict(sd, strict=False)
        if res.missing_keys:
            raise RuntimeError(f"flownet.pkl lacks {len(res.missing_keys)} weights, e.g. {res.missing_keys[:4]}")
        if res.unexpected_keys:
            print(f"[rife] ignoring {len(res.unexpected_keys)} extra checkpoint keys", flush=True)
        self.model.eval()
        self.model.device()
        self.dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        if fp16:
            self.model.flownet.half()
        self.name = f"Practical-RIFE {getattr(self.model, 'version', '4.x')}"
        self._cache = {}

    def tensor(self, img: np.ndarray, key):
        if key in self._cache:
            return self._cache[key]
        if len(self._cache) > 6:
            self._cache.pop(next(iter(self._cache)))
        t = self.torch.from_numpy(np.ascontiguousarray(img.transpose(2, 0, 1))).to(self.dev, non_blocking=True)
        t = t.unsqueeze(0).float() / 255.0
        h, w = img.shape[:2]
        tmp = max(128, int(128 / self.scale))
        ph, pw = ((h - 1) // tmp + 1) * tmp, ((w - 1) // tmp + 1) * tmp
        t = self.F.pad(t, (0, pw - w, 0, ph - h))
        if self.fp16:
            t = t.half()
        self._cache[key] = t
        return t

    def __call__(self, a, b, w, ka=None, kb=None):
        h, wd = a.shape[:2]
        with self.torch.no_grad():
            out = self.model.inference(self.tensor(a, ka), self.tensor(b, kb), float(w), self.scale)
        out = out[0, :, :h, :wd].float().clamp(0, 1).mul(255).add(0.5).byte().permute(1, 2, 0).cpu().numpy()
        return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--rife", type=Path, default=None)
    ap.add_argument("--frames", type=Path, required=True)
    ap.add_argument("--needs", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--fp16", action="store_true")
    ap.add_argument("--quality", type=int, default=95)
    ap.add_argument("--fake", action="store_true")
    a = ap.parse_args(argv)
    man = json.loads(a.needs.read_text())
    pat = man["frame_pattern"]
    a.out.mkdir(parents=True, exist_ok=True)
    missing = [s for s in man["frames"] if not (a.frames / pat.format(src=s)).exists()]
    if missing:
        sys.exit(f"rife_run: {len(missing)} input frames missing, first {missing[:5]}")
    t0 = time.time()
    if a.fake:
        net, model_hash = Blend(), None
    else:
        if a.rife is None or not (a.rife / "train_log" / "flownet.pkl").exists():
            sys.exit("rife_run: --rife must be a Practical-RIFE dir with train_log/flownet.pkl")
        net = Rife(a.rife, a.fp16)
        model_hash = hashlib.sha256((a.rife / "train_log" / "flownet.pkl").read_bytes()).hexdigest()
    print(f"[rife] {net.name}, {len(man['pairs'])} in-betweens, {len(man.get('checks', []))} checks", flush=True)
    frames = {}

    def frame(s):
        if s not in frames:
            if len(frames) > 8:
                frames.pop(next(iter(frames)))
            frames[s] = read_rgb(a.frames / pat.format(src=s))
        return frames[s]

    done = skipped = 0
    for i, p in enumerate(sorted(man["pairs"], key=lambda p: (p["a"], p["b"], p["w"]))):
        dst = a.out / p["out"]
        if dst.exists():
            skipped += 1
            continue
        A, B = frame(p["a"]), frame(p["b"])
        img = net(A, B, p["w"]) if a.fake else net(A, B, p["w"], p["a"], p["b"])
        write_rgb(dst, img, a.quality)
        done += 1
        if done % 100 == 0:
            print(f"[rife] {done + skipped}/{len(man['pairs'])} ({time.time() - t0:.0f} s)", flush=True)
    t_pairs = time.time() - t0
    rows = []
    for c in man.get("checks", []):
        A, M, C = frame(c["a"]), frame(c["m"]), frame(c["c"])
        r = net(A, C, c["w"]) if a.fake else net(A, C, c["w"], c["a"], c["c"])
        rows.append({**c, "psnr": round(psnr(r, M), 2), "psnr_dissolve": round(psnr(Blend()(A, C, c["w"]), M), 2)})
    if rows:
        pr, pd = np.mean([r["psnr"] for r in rows]), np.mean([r["psnr_dissolve"] for r in rows])
        print(f"[rife] held-out checks: PSNR {pr:.2f} dB (dissolve {pd:.2f} dB) over {len(rows)} triples", flush=True)
        (a.out / "checks.json").write_text(json.dumps({"mean_psnr": round(float(pr), 2),
                                                       "mean_psnr_dissolve": round(float(pd), 2), "rows": rows}, indent=1))
    (a.out / "needs.json").write_text(json.dumps(man))
    rep = {"model": net.name, "flownet_sha256": model_hash, "written": done, "kept": skipped,
           "seconds_pairs": round(t_pairs, 1), "seconds_total": round(time.time() - t0, 1)}
    (a.out / "done.json").write_text(json.dumps(rep, indent=1))
    print("[rife] RIFE_OK", json.dumps(rep), flush=True)


if __name__ == "__main__":
    main()
