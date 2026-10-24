"""SAM 2.1 large video masks from box (and click) prompts, for one or more clips in one GPU job.

  Mac:  python3 -I court_sam.py pack --video <clip> --range A-B --prompts <prompts.json> --out <dir>
                                    [--crop x0,y0,x1,y1]
  HPG:  python court_sam.py run <upload dir> <out dir>          (court-sam.sbatch, the sam2 venv, one GPU)
        python court_sam.py rematte <set dir> <masks-sam.tar> <out dir>   (the matte again, on an earlier run's masks)
  Mac:  python3 -I court_sam.py unpack <masks-sam.tar> --out <masks dir> [--set <name>]

A clip (a "set") is a folder holding frames.zip (images whose names sort in frame order; the name's stem is the frame
number) and prompts.json: {"ref": <frame>, "objects": {name: {"<frame>": [x0, y0, x1, y1] | {"box": [...],
"points": [[x, y], ...], "labels": [1, 0, ...]}}}, "crop": [x0, y0, x1, y1] (optional, pack writes it)}. Or, instead of
frames.zip, the clip itself: prompts.json names it ("video": "<file in the set>", "range": [A, B]) and frames A..B are
decoded on the node exactly as player_clip.py decodes them; "matte": true then also writes BiRefNet-banded soft edges
(court_matte.py) to alpha/<name>/<stem>.png, full frame. Boxes and
points are in that clip's own pixels. Every object of a clip shares one SAM state; tracking runs forward and backward
from ref (default: the first prompted frame). run takes every set under the upload dir (the dir itself if it is one)
and writes <out>/<set>/masks/<name>/<stem>.png (0/255: logit > 0), prob/<name>/<stem>.png (8-bit sigmoid: the soft
edge) and report.json (per object, the frames it came out empty on).
pack cuts the clip's frames A..B out of the video exactly as player_clip.py decodes them (JPEG q95, 4:4:4), optionally
to a fixed crop (prompts given in full-frame pixels are moved into it). unpack pastes masks back to full frames when
there was a crop: <out>/<name>/<stem>.png and <out>/<name>-prob/<stem>.png (<out>/<set>/... for an upload of
several sets, unless --set picks one).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path

import numpy as np

JPEG_Q = 95


def parse_prompt(v) -> dict:
    """A prompt entry as keyword arguments for add_new_points_or_box."""
    if isinstance(v, list):
        return {"box": np.asarray(v, np.float32)}
    out = {}
    if v.get("box") is not None:
        out["box"] = np.asarray(v["box"], np.float32)
    if v.get("points"):
        out["points"] = np.asarray(v["points"], np.float32)
        out["labels"] = np.asarray(v.get("labels", [1] * len(v["points"])), np.int32)
    if not out:
        raise ValueError(f"empty prompt {v}")
    return out


def frame_index(stems: list[str]):
    """key -> the frame's position in the clip; a key matches a stem exactly or by number ("7" = "000007")."""
    exact = {s: i for i, s in enumerate(stems)}
    by_num = {int(s): i for i, s in enumerate(stems) if s.isdigit()}

    def at(key, who: str) -> int:
        k = str(key)
        if k in exact:
            return exact[k]
        if k.isdigit() and int(k) in by_num:
            return by_num[int(k)]
        raise KeyError(f"{who}: frame {key} isn't in the clip")
    return at


def segment(pred, frames_dir: str, stems: list[str], prompts: dict):
    """Yields (index, {name: logits HxW float32}) for every frame, from SAM's video predictor `pred`, forward and
    backward from ref. frames_dir holds 00000.jpg.. in the order of `stems`."""
    at = frame_index(stems)
    names = list(prompts["objects"])
    st = pred.init_state(video_path=frames_dir, offload_video_to_cpu=True)
    prompted = []
    for oid, name in enumerate(names, 1):
        for key, v in prompts["objects"][name].items():
            pred.add_new_points_or_box(st, frame_idx=at(key, name), obj_id=oid, **parse_prompt(v))
            prompted.append(at(key, name))
    ref = at(prompts["ref"], "ref") if prompts.get("ref") is not None else min(prompted)
    seen = set()
    for reverse in (False, True):
        if reverse and ref == 0:
            break
        for idx, ids, logits in pred.propagate_in_video(st, start_frame_idx=ref, reverse=reverse):
            if idx in seen:
                continue
            seen.add(idx)
            lg = logits[:, 0].float().cpu().numpy() if hasattr(logits, "float") else np.asarray(logits)[:, 0]
            yield idx, {names[int(o) - 1]: lg[k] for k, o in enumerate(ids)}
    pred.reset_state(st)


VF = ("select='between(n\\,{lo}\\,{hi})',scale=in_color_matrix=bt709:in_range=tv:out_range=pc:"
      "flags=accurate_rnd+full_chroma_int+lanczos,format=rgb24")  # player_clip.decode_frames' filter


def decode_video(video: Path, lo: int, hi: int):
    """(n, rgb uint8) for frames lo..hi (decoded frame numbers from 0), by ffmpeg with player_clip.py's filter; PyAV
    if this ffmpeg can't decode the clip (its rgb24 is ~2 levels off, harmless for masks)."""
    import subprocess

    w, h = map(int, subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                             "stream=width,height", "-of", "csv=p=0", str(video)],
                                            text=True).strip().split(",")[:2])
    proc = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(video), "-vf", VF.format(lo=lo, hi=hi),
                             "-fps_mode", "passthrough", "-f", "rawvideo", "-"], stdout=subprocess.PIPE)
    n = lo
    try:
        while n <= hi:
            buf = proc.stdout.read(w * h * 3)
            if len(buf) < w * h * 3:
                break
            yield n, np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            n += 1
    finally:
        proc.kill()
        proc.stdout.close()
        proc.wait()
    if n == lo:
        print(f"[decode] ffmpeg gave no frames of {video.name}; PyAV instead", flush=True)
        import av

        with av.open(str(video)) as c:
            for i, f in enumerate(c.decode(c.streams.video[0])):
                if i > hi:
                    break
                if i >= lo:
                    yield i, f.to_ndarray(format="rgb24")
                    n = i + 1
    if n <= hi:
        raise ValueError(f"{video} ends at frame {n - 1}, before {hi}")


def zip_frames(path: Path):
    """(n, rgb) for every image in a set's frames.zip, in order; n is the stem's number."""
    import cv2

    with zipfile.ZipFile(path) as z:
        for m in sorted((m for m in z.namelist() if not m.endswith("/")), key=lambda m: Path(m).stem):
            bgr = cv2.imdecode(np.frombuffer(z.read(m), np.uint8), cv2.IMREAD_COLOR)
            yield int(Path(m).stem), cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def write_png(path: Path, m: np.ndarray):
    from PIL import Image

    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(m).save(path)


def run_set(pred, set_dir: Path, out: Path, work: Path, matte: bool = True) -> dict:
    prompts = json.loads((set_dir / "prompts.json").read_text())
    frames = work / "frames"
    shutil.rmtree(frames, ignore_errors=True)
    frames.mkdir(parents=True)
    if prompts.get("video"):
        import cv2

        lo, hi = prompts["range"]
        stems = []
        for i, (n, rgb) in enumerate(decode_video(set_dir / prompts["video"], lo, hi)):
            cv2.imwrite(str(frames / f"{i:05d}.jpg"), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR),
                        [cv2.IMWRITE_JPEG_QUALITY, JPEG_Q])
            stems.append(f"{n:06d}")
        print(f"[sam] {set_dir.name}: decoded {prompts['video']} {lo}-{hi}", flush=True)
    else:
        with zipfile.ZipFile(set_dir / "frames.zip") as z:
            members = sorted((m for m in z.namelist() if not m.endswith("/")), key=lambda m: Path(m).stem)
            stems = [Path(m).stem for m in members]
            for i, m in enumerate(members):
                with z.open(m) as src, open(frames / f"{i:05d}.jpg", "wb") as dst:
                    shutil.copyfileobj(src, dst)
    t0 = time.time()
    empty = {n: [] for n in prompts["objects"]}
    n = 0
    for idx, by_name in segment(pred, str(frames), stems, prompts):
        for name, lg in by_name.items():
            m = lg > 0
            if not m.any():
                empty[name].append(stems[idx])
            write_png(out / "masks" / name / f"{stems[idx]}.png", (m * 255).astype(np.uint8))
            p = 255 / (1 + np.exp(-np.clip(lg, -30, 30)))
            write_png(out / "prob" / name / f"{stems[idx]}.png", np.round(p).astype(np.uint8))
        n += 1
    rep = {"frames": len(stems), "written": n, "seconds": round(time.time() - t0, 1), "empty": empty,
           "crop": prompts.get("crop"), "ref": prompts.get("ref")}
    (out / "report.json").write_text(json.dumps(rep, indent=1))
    (out / "prompts.json").write_text(json.dumps(prompts))
    print(f"[sam] {set_dir.name}: {n}/{len(stems)} frames, {len(prompts['objects'])} objects, {rep['seconds']} s, "
          f"empty frames {sum(len(v) for v in empty.values())}", flush=True)
    shutil.rmtree(frames, ignore_errors=True)
    if matte:
        matte_set(set_dir, out, rep)
    return rep


def matte_set(set_dir: Path, out: Path, rep: dict) -> dict:
    """The BiRefNet band matte for a set whose prompts ask for it ("matte": true), on out/masks; updates report.json.
    Run it outside SAM's bf16 autocast: BiRefNet runs in fp16 and autocast would mix the two."""
    prompts = json.loads((set_dir / "prompts.json").read_text())
    if prompts.get("matte"):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import court_matte

        if prompts.get("video"):
            lo, hi = prompts["range"]
            frames = decode_video(set_dir / prompts["video"], lo, hi)
        else:
            frames = zip_frames(set_dir / "frames.zip")
        try:
            rep["matte"] = court_matte.matte_video(frames, out / "masks", list(prompts["objects"]), out / "alpha")
        except Exception as e:  # the binary masks stand on their own
            rep["matte"] = {"error": repr(e)}
            print(f"[matte] FAILED, binary masks only: {e!r}", flush=True)
        (out / "report.json").write_text(json.dumps(rep, indent=1))
    return rep


def sets_in(upload: Path) -> list[Path]:
    if (upload / "prompts.json").exists():
        return [upload]
    return sorted(d for d in upload.iterdir() if (d / "prompts.json").exists()
                  and ((d / "frames.zip").exists() or json.loads((d / "prompts.json").read_text()).get("video")))


def run(upload: Path, out: Path):
    import torch
    from sam2.build_sam import build_sam2_video_predictor

    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    ck = os.path.join(os.environ["SAM2_ROOT"], "checkpoints", "sam2.1_hiera_large.pt")
    pred = build_sam2_video_predictor("configs/sam2.1/sam2.1_hiera_l.yaml", ck, device="cuda")
    sets = sets_in(upload)
    if not sets:
        sys.exit(f"court_sam: no set (prompts.json + frames.zip) under {upload}")
    work = Path(tempfile.mkdtemp(prefix="court_sam_"))
    with torch.inference_mode():
        for s in sets:
            o = out if s == upload else out / s.name
            with torch.autocast("cuda", dtype=torch.bfloat16):
                rep = run_set(pred, s, o, work, matte=False)
            matte_set(s, o, rep)
    shutil.rmtree(work, ignore_errors=True)


def rematte(upload: Path, tar: Path, out: Path) -> dict:
    """The band matte again, on an earlier run's masks (its masks-sam.tar) for the same upload (one set, or one
    folder per set): [<set>/]alpha/ under out. Returns {set: matte summary} ("." for a one-set upload)."""
    import torch

    done = {}
    with tarfile.open(tar) as t:
        for s in sets_in(upload):
            pre = "./" if s == upload else f"./{s.name}/"
            o = out if s == upload else out / s.name
            members = [m for m in t.getmembers() if m.name.startswith(pre + "masks/") or m.name == pre + "report.json"]
            for m in members:  # each set's files land in its own folder under out
                m.name = m.name[len(pre):]
            t.extractall(o, members=members)
            rep = json.loads((o / "report.json").read_text())
            rep.pop("matte", None)
            with torch.inference_mode():
                rep = matte_set(s, o, rep)
            shutil.copyfile(s / "prompts.json", o / "prompts.json")
            shutil.rmtree(o / "masks")  # the binaries are already home; only the alpha goes back
            done["." if s == upload else s.name] = rep.get("matte")
    return done


# --- Mac: pack and unpack -----------------------------------------------------------------------------------------


def shift_prompts(prompts: dict, crop: list[int] | None) -> dict:
    """Prompts in full-frame pixels moved into the crop's pixels (unchanged without a crop)."""
    if not crop:
        return prompts
    x0, y0 = crop[0], crop[1]
    out = {**prompts, "crop": crop, "objects": {}}
    for name, per in prompts["objects"].items():
        out["objects"][name] = {}
        for stem, v in per.items():
            v = {"box": v} if isinstance(v, list) else dict(v)
            if v.get("box") is not None:
                b = v["box"]
                v["box"] = [b[0] - x0, b[1] - y0, b[2] - x0, b[3] - y0]
            if v.get("points"):
                v["points"] = [[x - x0, y - y0] for x, y in v["points"]]
            out["objects"][name][stem] = v
    return out


def pack(frames, prompts: dict, out: Path, crop: list[int] | None = None) -> Path:
    """frames: (n, rgb uint8 HxWx3) pairs (or a dict). Writes <out>/frames.zip + prompts.json; returns <out>."""
    import cv2

    out.mkdir(parents=True, exist_ok=True)
    part = out / "frames.zip.part"
    with zipfile.ZipFile(part, "w", zipfile.ZIP_STORED) as z:
        for n, rgb in (sorted(frames.items()) if isinstance(frames, dict) else frames):
            if crop:
                rgb = rgb[crop[1]:crop[3], crop[0]:crop[2]]
            ok, jpg = cv2.imencode(".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR),
                                   [cv2.IMWRITE_JPEG_QUALITY, JPEG_Q, cv2.IMWRITE_JPEG_SAMPLING_FACTOR,
                                    cv2.IMWRITE_JPEG_SAMPLING_FACTOR_444])
            assert ok
            z.writestr(f"{n:06d}.jpg", jpg.tobytes())
    os.replace(part, out / "frames.zip")
    (out / "prompts.json").write_text(json.dumps(shift_prompts(prompts, crop)))
    return out


def unpack(tar: Path, out: Path, set_name: str | None = None, size: tuple[int, int] | None = None,
           single: bool = False) -> int:
    """Masks from the HPG tar into <out>/<name>/<stem>.png and <out>/<name>-prob|alpha/<stem>.png, pasted into the
    full frame (size = (w, h)) when the set had a crop; single-frame sets with single=True as <out>/<name>.png and
    <out>/<name>-prob|alpha.png. Returns how many mask files were written."""
    import cv2

    pre = f"./{set_name}/" if set_name else "./"
    n = 0
    with tarfile.open(tar) as t:
        names = t.getnames()
        if pre + "prompts.json" not in names and set_name is None:  # one folder per set: each into <out>/<set>/
            sets = sorted(m.split("/")[1] for m in names if m.count("/") == 2 and m.endswith("/prompts.json"))
            return sum(unpack(tar, out / s, s, size, single) for s in sets)
        prompts = json.load(t.extractfile(pre + "prompts.json"))
        crop = prompts.get("crop")
        if crop and size is None:
            raise ValueError("this set was cropped: pass the full frame size")
        for m in t.getmembers():
            if not m.isfile() or not m.name.startswith(pre) or not m.name.endswith(".png"):
                continue
            parts = m.name[len(pre):].split("/")
            if len(parts) != 3 or parts[0] not in ("masks", "prob", "alpha"):
                continue
            kind, name, fname = parts
            img = cv2.imdecode(np.frombuffer(t.extractfile(m).read(), np.uint8), cv2.IMREAD_GRAYSCALE)
            if crop:
                full = np.zeros((size[1], size[0]), np.uint8)
                full[crop[1]:crop[3], crop[0]:crop[2]] = img
                img = full
            p = out / (name if kind == "masks" else f"{name}-{kind}") / fname
            if single:
                p = out / (f"{name}.png" if kind == "masks" else f"{name}-{kind}.png")
            p.parent.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(p), img)
            n += kind == "masks"
    return n


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pack")
    p.add_argument("--video", type=Path, required=True)
    p.add_argument("--range", required=True, help="A-B: decoded frame numbers, inclusive")
    p.add_argument("--prompts", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--crop", default=None, help="x0,y0,x1,y1 in full-frame pixels")
    r = sub.add_parser("run")
    r.add_argument("upload", type=Path)
    r.add_argument("out", type=Path)
    m = sub.add_parser("rematte")
    m.add_argument("set", type=Path)
    m.add_argument("tar", type=Path, help="the earlier run's masks-sam.tar")
    m.add_argument("out", type=Path)
    u = sub.add_parser("unpack")
    u.add_argument("tar", type=Path)
    u.add_argument("--out", type=Path, required=True)
    u.add_argument("--set", default=None)
    u.add_argument("--size", default=None, help="w,h of the full frame (needed when the set was cropped)")
    u.add_argument("--single", action="store_true", help="one frame per set: <out>[/<set>]/<name>.png")
    a = ap.parse_args(argv)
    if a.cmd == "pack":
        import subprocess
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from player_clip import decode_frames
        lo, hi = map(int, a.range.split("-"))
        prompts = json.loads(a.prompts.read_text())
        bad = [s for per in prompts["objects"].values() for s in per if not lo <= int(s) <= hi]
        if bad:
            sys.exit(f"court_sam pack: prompts on frames outside {lo}-{hi}: {bad}")
        w, h = map(int, subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                                 "stream=width,height", "-of", "csv=p=0", str(a.video)],
                                                text=True).strip().split(","))
        crop = [int(v) for v in a.crop.split(",")] if a.crop else None
        d = pack(decode_frames(a.video, set(range(lo, hi + 1)), w, h), prompts, a.out, crop)
        print(f"{d}: frames {lo}-{hi}{f' cropped to {crop}' if crop else ''}, "
              f"frames.zip {(d / 'frames.zip').stat().st_size / 2**20:.0f} MB")
    elif a.cmd == "run":
        run(a.upload, a.out)
    elif a.cmd == "rematte":
        print(json.dumps(rematte(a.set, a.tar, a.out)))
    else:
        size = tuple(int(v) for v in a.size.split(",")) if a.size else None
        print(f"{unpack(a.tar, a.out, a.set, size, a.single)} masks -> {a.out}")


if __name__ == "__main__":
    main()
