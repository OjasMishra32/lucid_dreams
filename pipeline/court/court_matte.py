"""Soft edges for the pair's SAM 2.1 masks: BiRefNet's alpha, but only in a thin band around SAM's edge.

  Mac:  python3 -I court_matte.py pack --video <clip> --masks <masks dir> --names <name>... --out <staging dir>
  HPG:  python court_matte.py run <crops.zip> <out dir>          (court-matte.sbatch, the 4danyone env, one GPU)
  Mac:  python3 -I court_matte.py unpack <masks-matte.tar> --masks <masks dir>

pack crops every frame that has a mask for a name (the mask's box + pad, from the clip decoded exactly as
player_clip.py decodes it) and writes crops.zip: crops/<name>/NNNNNN.jpg, own/<name>/NNNNNN.png (that name's mask),
others/<name>/NNNNNN.png (every other name's mask in the same crop) and index.json (boxes, band).
run puts each crop through the BiRefNet model 4DAnyone ships (the one lucid.source_view and lucid.frames use),
letterboxed square so nothing is squashed, and keeps the net's alpha only inside +-band px of SAM's edge; deeper
inside it is 255 and farther out 0, and wherever another name's mask is (and this one's isn't) it is 0, so another
person can never leak in. If the net misses the player (it calls less than RECALL of SAM's eroded interior theirs), that
crop keeps SAM's binary. Writes alpha/<name>/NNNNNN.png (8-bit, crop-sized), index.json and report.json.
unpack pastes the crops back into full frames: <masks>/<name>-alpha/NNNNNN.png beside each <masks>/<name>/.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import tarfile
import zipfile
from pathlib import Path

import cv2
import numpy as np

BAND = 12      # px at 4K: hair, fingers and jersey edges sit within this of SAM's edge
PAD = 48       # px of context around each mask's box
RECALL = 0.9   # the net must call this share of SAM's eroded interior foreground, or the crop keeps SAM's binary
JPEG_Q = 95


def _kernel(r: int) -> np.ndarray:
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def band_alpha(own: np.ndarray, others: np.ndarray, net: np.ndarray, band: int = BAND) -> tuple[np.ndarray, bool]:
    """8-bit alpha: own's binary outside +-band of its edge, the net's alpha inside it, 0 on other names' pixels.
    Returns (alpha, used_net); used_net is False when the net missed the player and SAM's binary is returned."""
    own = own.astype(bool)
    o8 = own.astype(np.uint8)
    inner = cv2.erode(o8, _kernel(band)) > 0
    outer = cv2.dilate(o8, _kernel(band)) > 0
    hard = o8 * 255
    if inner.any() and float((net[inner] >= 0.5).mean()) < RECALL:
        return hard, False
    a = hard.astype(np.float32) / 255.0
    ring = outer & ~inner
    a[ring] = np.clip(net[ring], 0.0, 1.0)
    a[others.astype(bool) & ~own] = 0.0
    return np.round(a * 255).astype(np.uint8), True


def box_of(mask: np.ndarray, pad: int) -> list[int] | None:
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    h, w = mask.shape
    return [max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad),
            min(w, int(xs.max()) + 1 + pad), min(h, int(ys.max()) + 1 + pad)]


def _png(m: np.ndarray) -> bytes:
    ok, b = cv2.imencode(".png", m)
    assert ok
    return b.tobytes()


def _fit(m: np.ndarray, size: list[int]) -> np.ndarray:
    """A mask at the frame's size (masks made at another size are resized, nearest)."""
    return m if m.shape[::-1] == tuple(size) else cv2.resize(m, tuple(size), interpolation=cv2.INTER_NEAREST)


def _png_in(z: zipfile.ZipFile, name: str) -> np.ndarray:
    return cv2.imdecode(np.frombuffer(z.read(name), np.uint8), cv2.IMREAD_GRAYSCALE)


def _read(folder: Path, n: int) -> np.ndarray | None:
    p = folder / f"{n:06d}.png"
    return cv2.imread(str(p), cv2.IMREAD_GRAYSCALE) if p.exists() else None


# --- Mac: pack and unpack -----------------------------------------------------------------------------------------


def pack(masks: Path, names: list[str], frames, out: Path, band: int = BAND, pad: int = PAD) -> Path:
    """frames: (n, rgb uint8 HxWx3) pairs in frame order (or a dict), consumed one at a time.
    Writes <out>/court-matte/crops.zip; returns that folder."""
    d = out / "court-matte"
    d.mkdir(parents=True, exist_ok=True)
    items, size = [], None
    part = d / "crops.zip.part"
    with zipfile.ZipFile(part, "w", zipfile.ZIP_STORED) as z:
        for n, rgb in (sorted(frames.items()) if isinstance(frames, dict) else frames):
            size = [rgb.shape[1], rgb.shape[0]]
            got = {k: _read(masks / k, n) for k in names}
            for name in names:
                own = got[name]
                if own is None:
                    continue
                own = _fit(own, size)
                box = box_of(own > 127, pad)
                if box is None:
                    continue
                x0, y0, x1, y1 = box
                oth = np.zeros(own.shape, np.uint8)
                for k, m in got.items():
                    if k != name and m is not None:
                        m = _fit(m, size)
                        oth = np.maximum(oth, (m > 127).astype(np.uint8) * 255)
                ok, jpg = cv2.imencode(".jpg", cv2.cvtColor(rgb[y0:y1, x0:x1], cv2.COLOR_RGB2BGR),
                                       [cv2.IMWRITE_JPEG_QUALITY, JPEG_Q, cv2.IMWRITE_JPEG_SAMPLING_FACTOR,
                                        cv2.IMWRITE_JPEG_SAMPLING_FACTOR_444])
                assert ok
                z.writestr(f"crops/{name}/{n:06d}.jpg", jpg.tobytes())
                z.writestr(f"own/{name}/{n:06d}.png", _png(((own[y0:y1, x0:x1] > 127) * 255).astype(np.uint8)))
                z.writestr(f"others/{name}/{n:06d}.png", _png(oth[y0:y1, x0:x1]))
                items.append({"name": name, "frame": n, "box": box})
        z.writestr("index.json", json.dumps({"band": band, "size": size, "items": items}))
    os.replace(part, d / "crops.zip")
    return d


def unpack(tar: Path, masks: Path) -> int:
    """Pastes alpha crops from the HPG tar into <masks>/<name>-alpha/NNNNNN.png; returns how many were written."""
    with tarfile.open(tar) as t:
        idx = json.load(t.extractfile("./index.json"))
        w, h = idx["size"]
        n = 0
        for it in idx["items"]:
            f = t.extractfile(f"./alpha/{it['name']}/{it['frame']:06d}.png")
            crop = cv2.imdecode(np.frombuffer(f.read(), np.uint8), cv2.IMREAD_GRAYSCALE)
            x0, y0, x1, y1 = it["box"]
            full = np.zeros((h, w), np.uint8)
            full[y0:y1, x0:x1] = crop
            p = masks / f"{it['name']}-alpha" / f"{it['frame']:06d}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(p), full)
            n += 1
    return n


# --- HPG: run -------------------------------------------------------------------------------------------------------


def letterbox(img: np.ndarray, s: int) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    h, w = img.shape[:2]
    k = s / max(h, w)
    nw, nh = max(1, round(w * k)), max(1, round(h * k))
    out = np.zeros((s, s, 3), np.uint8)
    ox, oy = (s - nw) // 2, (s - nh) // 2
    out[oy:oy + nh, ox:ox + nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA if k < 1 else cv2.INTER_CUBIC)
    return out, (ox, oy, nw, nh)


def run(crops: Path, out: Path, side: int, chunk: int = 256):
    from fdanyone.assets import resolve_foreground_model
    from fdanyone.download import ensure_foreground_model
    from fdanyone.foreground import predict_foreground_masks
    import fdanyone

    model_dir = str(Path(fdanyone.__file__).resolve().parents[1] / "models")
    ensure_foreground_model(model_dir)
    model = resolve_foreground_model(model_dir)
    report = {"side": side, "items": []}
    with zipfile.ZipFile(crops) as z:
        idx = json.loads(z.read("index.json"))
        band = idx["band"]
        items = idx["items"]
        for c0 in range(0, len(items), chunk):
            part = items[c0:c0 + chunk]
            imgs, geo = [], []
            for it in part:
                rgb = cv2.cvtColor(cv2.imdecode(np.frombuffer(z.read(f"crops/{it['name']}/{it['frame']:06d}.jpg"),
                                                              np.uint8), cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
                sq, g = letterbox(rgb, side)
                imgs.append(sq)
                geo.append((g, rgb.shape[:2]))
            # 4DAnyone's BiRefNet (fdanyone/foreground.py): one raster per call, so the crops go in letterboxed to
            # one square; it returns the sigmoid as 8-bit masks at that size (the model loads once per call)
            nets = np.asarray(predict_foreground_masks(tuple(imgs), model, "cuda"))
            for it, net, ((ox, oy, nw, nh), (h, w)) in zip(part, nets, geo):
                net = cv2.resize(net[oy:oy + nh, ox:ox + nw].astype(np.float32) / 255.0, (w, h),
                                 interpolation=cv2.INTER_LINEAR)
                own = _png_in(z, f"own/{it['name']}/{it['frame']:06d}.png") > 127
                oth = _png_in(z, f"others/{it['name']}/{it['frame']:06d}.png") > 127
                a, used = band_alpha(own, oth, net, band)
                p = out / "alpha" / it["name"] / f"{it['frame']:06d}.png"
                p.parent.mkdir(parents=True, exist_ok=True)
                cv2.imwrite(str(p), a)
                inner = cv2.erode(own.astype(np.uint8), _kernel(band)) > 0
                recall = float((net[inner] >= 0.5).mean()) if inner.any() else None
                report["items"].append({**it, "net": used, "recall": recall,
                                        "changed": int((a != own.astype(np.uint8) * 255).sum())})
            print(f"[matte] {min(c0 + chunk, len(items))}/{len(items)}", flush=True)
    (out / "index.json").write_text(json.dumps(idx))
    kept = sum(not r["net"] for r in report["items"])
    report["keptSam"] = kept
    (out / "report.json").write_text(json.dumps(report, indent=1))
    print(f"[matte] {len(items)} crops, {kept} kept SAM's binary (the net missed the player)", flush=True)


def matte_video(frames, masks: Path, names: list[str], out: Path, band: int = BAND, pad: int = PAD,
                side: int = 1024, chunk: int = 32) -> dict:
    """The band rule on full frames: frames are (n, rgb) pairs, masks/<name>/<n:06d>.png full-frame SAM masks.
    Writes out/<name>/<n:06d>.png (8-bit alpha, full frame); returns a summary (crops, how many kept SAM's binary)."""
    from fdanyone.assets import resolve_foreground_model
    from fdanyone.download import ensure_foreground_model
    from fdanyone.foreground import predict_foreground_masks
    import fdanyone

    model_dir = str(Path(fdanyone.__file__).resolve().parents[1] / "models")
    ensure_foreground_model(model_dir)
    model = resolve_foreground_model(model_dir)
    summary = {"band": band, "side": side, "crops": 0, "keptSam": [], "noMask": 0}

    def flush(batch):
        nets = np.asarray(predict_foreground_masks(tuple(b["sq"] for b in batch), model, "cuda"))
        for b, net in zip(batch, nets):
            ox, oy, nw, nh = b["geo"]
            x0, y0, x1, y1 = b["box"]
            net = cv2.resize(net[oy:oy + nh, ox:ox + nw].astype(np.float32) / 255.0, (x1 - x0, y1 - y0),
                             interpolation=cv2.INTER_LINEAR)
            a, used = band_alpha(b["own"][y0:y1, x0:x1], b["oth"][y0:y1, x0:x1], net, band)
            full = np.zeros(b["own"].shape, np.uint8)
            full[y0:y1, x0:x1] = a
            p = out / b["name"] / f"{b['n']:06d}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(p), full)
            summary["crops"] += 1
            if not used:
                summary["keptSam"].append([b["name"], b["n"]])

    batch = []
    for n, rgb in frames:
        got = {k: _read(masks / k, n) for k in names}
        for name in names:
            own = got[name]
            if own is None or not (own > 127).any():
                summary["noMask"] += 1
                continue
            own = own > 127
            oth = np.zeros(own.shape, bool)
            for k, m in got.items():
                if k != name and m is not None:
                    oth |= m > 127
            box = box_of(own, pad)
            sq, geo = letterbox(rgb[box[1]:box[3], box[0]:box[2]], side)
            batch.append({"n": n, "name": name, "own": own, "oth": oth, "box": box, "sq": sq, "geo": geo})
        if len(batch) >= chunk:
            flush(batch)
            batch = []
            print(f"[matte] {summary['crops']} crops", flush=True)
    if batch:
        flush(batch)
    print(f"[matte] {summary['crops']} crops, {len(summary['keptSam'])} kept SAM's binary", flush=True)
    return summary


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pack")
    p.add_argument("--video", type=Path, required=True)
    p.add_argument("--masks", type=Path, required=True)
    p.add_argument("--names", nargs="+", required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--band", type=int, default=BAND)
    p.add_argument("--pad", type=int, default=PAD)
    r = sub.add_parser("run")
    r.add_argument("crops", type=Path)
    r.add_argument("out", type=Path)
    r.add_argument("--side", type=int, default=1024, help="square side the crops are letterboxed to for the net")
    u = sub.add_parser("unpack")
    u.add_argument("tar", type=Path)
    u.add_argument("--masks", type=Path, required=True)
    a = ap.parse_args(argv)
    if a.cmd == "pack":
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import subprocess
        from player_clip import decode_frames
        wanted = sorted({int(f.stem) for k in a.names for f in (a.masks / k).glob("[0-9]*.png")})
        if not wanted:
            sys.exit(f"matte pack: no masks under {a.masks}/{{{','.join(a.names)}}}")
        w, h = map(int, subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                                 "stream=width,height", "-of", "csv=p=0", str(a.video)],
                                                text=True).strip().split(","))
        d = pack(a.masks, a.names, decode_frames(a.video, set(wanted), w, h), a.out, a.band, a.pad)
        print(f"{d}/crops.zip: {len(wanted)} frames ({wanted[0]}-{wanted[-1]}), "
              f"{(d / 'crops.zip').stat().st_size / 2**20:.0f} MB")
    elif a.cmd == "run":
        run(a.crops, a.out, a.side)
    else:
        print(f"{unpack(a.tar, a.masks)} alpha mattes -> {a.masks}/<name>-alpha/")


if __name__ == "__main__":
    main()
