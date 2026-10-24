"""The show bake: timeline + frames + layers -> the stacked H.264 streams and the video/ part of the court bundle.

    python -m pipeline.court.bake.bake --synth <dir>     # the synthetic clip end to end (tests, CI); writes <dir>/bundle/video/
    python -m pipeline.court.bake.bake --real            # the real clip -> ~/court-side-data/luka/bundle/court-side/video/

Writes (paths in video.json are "video/...", relative to court.json's folder):
  show.h264 (1536 x 2160, 72 Hz, avc1.640033), show-small.h264 (same frames, 1280 wide), show-90.h264 (own timeline at 90 Hz),
  pass1.mp4 (pass 1 for a <video> element), frames.json / cards.json (+ frames-90.json / cards-90.json), freeze.png,
  freeze-clean.png, stands-mask.png, inpaint-mask.png (the last three only from the layers' plates; reported missing otherwise),
  video.json = { "video": <court.json's video block>, "camera": <centre, sourceFps, captureFps, slow, ...> }.
Then format.ts's validators run on all of it (fmtcheck.py, node, read-only against origin/court-side).

The stages that need other modules sit behind two small interfaces so this file never imports the footage code directly:
  Provider  layers(display_frame) -> Layers (live, plate, mattes, people), freeze() -> RGB image [+ optional masks]
  Cameras   frames_json(timeline) -> list, camera_block() -> dict
(`pipeline/court/bake/providers.py` adapts source.py / interp.py / the layers' files and cameras.py to them.)
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterator, Mapping, Protocol, Sequence

import numpy as np

from pipeline.court.bake import cards as cards_mod
from pipeline.court.bake import encode, fmtcheck, stack
from pipeline.court.bake.cards import Person, TileSlots
from pipeline.court.bake.stack import Layout


@dataclass
class Layers:
    """Everything the stacker needs for one display frame. Images are RGB uint8 at the live aspect (any size)."""

    live: np.ndarray
    plate: np.ndarray | None = None  # None: live-only stacking (the plate region repeats the live frame)
    mattes: Mapping[str, np.ndarray] = field(default_factory=dict)  # id -> 8-bit matte, full frame at the live aspect
    people: Sequence[Person] = ()  # boxes in live-region pixels of the layout


class Provider(Protocol):
    def layers(self, frame) -> Layers: ...  # a timeline DisplayFrame (.i, .src, .interp, .segment)
    def freeze(self) -> np.ndarray: ...  # F, undistorted, as sharp as the source gets (RGB, any size at the live aspect)
    def freeze_clean(self) -> np.ndarray | None: ...  # F's plate, or None
    def stands_mask(self) -> np.ndarray | None: ...
    def inpaint_mask(self) -> np.ndarray | None: ...


class Cameras(Protocol):
    def frames_json(self, timeline) -> list: ...
    def camera_block(self) -> dict: ...


@dataclass
class Options:
    layout: Layout = stack.MAIN
    small_width: int = 1280
    n_slots: int = 6
    crf: float = 18
    preset: str = "veryfast"
    mad_bound: float = encode.MAD_BOUND
    protect_qp: int | None = None  # None: calibrate on the lead-in to F
    make_source: int | None = None
    small: bool = True
    hz90: bool = True
    pass1_mp4: bool = True
    log: Callable[[str], None] = lambda s: print(s, file=sys.stderr, flush=True)


class Renderer:
    """The stacked frames of one timeline, in order, plus the cards.json they imply (rebuilt on every pass)."""

    def __init__(self, timeline, provider: Provider, layout: Layout, n_slots: int, log=None):
        self.tl, self.provider, self.layout, self.n_slots, self.log = timeline, provider, layout, n_slots, log
        self.cards: list[dict] = []
        self.dropped: list[tuple[str, int]] = []
        self.missing_mattes: set[str] = set()

    def render(self, frame, slots: TileSlots) -> tuple[np.ndarray, list[dict]]:
        lay = self.provider.layers(frame)
        people = [p for p in lay.people if p.id in lay.mattes]
        self.missing_mattes |= {p.id for p in lay.people if p.id not in lay.mattes}
        cards = cards_mod.build_cards(self.layout, people, slots)
        return stack.stack_frame(self.layout, lay.live, lay.plate, cards, lay.mattes), cards

    def stacked(self) -> Iterator[np.ndarray]:
        slots = TileSlots(self.layout, self.n_slots)
        self.cards = []
        t0 = time.time()
        for k, fr in enumerate(self.tl.frames):
            img, cards = self.render(fr, slots)
            self.cards.append({"cards": cards})
            if self.log and k % 100 == 0:
                self.log(f"  [{self.tl.hz} Hz] frame {k}/{len(self.tl.frames)} ({time.time() - t0:.0f} s)")
            yield img
        self.dropped = list(slots.dropped)

    def sample(self, indices: Sequence[int]) -> list[np.ndarray]:
        slots = TileSlots(self.layout, self.n_slots)
        return [self.render(self.tl.frames[i], slots)[0] for i in indices]


def freeze_indices(tl) -> list[int]:
    """Display frames that show F itself (a real frame whose source is the freeze source): where F must be lossless."""
    return [f.i for f in tl.frames if not f.interp and f.src == tl.freeze]


def video_name(hz: int, main_hz: int) -> str:
    return "show.h264" if hz == main_hz else f"show-{hz}.h264"


def encode_timeline(
    tl, provider: Provider, layout: Layout, opts: Options, out: Path, outputs: Sequence[encode.Output], reference: np.ndarray, protect_qp: int | None
) -> tuple[Renderer, list[encode.Result], dict]:
    """Render and encode one timeline into `outputs` (the first is the layout's own size); returns the quality of F."""
    rend = Renderer(tl, provider, layout, opts.n_slots, opts.log)
    protect = freeze_indices(tl)
    qp = protect_qp if protect_qp is not None else opts.protect_qp
    if qp is None:
        f_last = tl.segments["eases"][0]["frames"][1]
        lead = list(range(max(tl.segments["eases"][0]["frames"][0], f_last - 12), f_last + 1))
        qp, mad = encode.calibrate_protect_qp(rend.sample(lead), layout, tl.hz, opts.crf, opts.mad_bound, reference=reference, preset=opts.preset)
        opts.log(f"[{tl.hz} Hz] protect QP {qp} (trial MAD {mad:.3f})")
    quality: dict = {}
    for attempt in range(4):
        results = encode.encode(rend.stacked(), outputs, len(tl.frames), tl.hz, tl.idr, opts.crf, opts.preset, protect=protect, protect_qp=qp)
        got = encode.decode_frames(outputs[0].path, protect, layout.width, layout.height)
        errs = {i: encode.frame_error(got[i], layout, reference) for i in protect}
        worst = max(e["mad_luma"] for e in errs.values())
        quality = {"protect_qp": qp, "frames": protect, "worst_mad_luma": worst, "worst_mad_rgb": max(e["mad_rgb"] for e in errs.values()), "min_psnr": min(e["psnr"] for e in errs.values()), "attempts": attempt + 1}
        opts.log(f"[{tl.hz} Hz] F decoded: luma MAD {worst:.3f} (bound {opts.mad_bound}) at QP {qp}")
        if worst <= opts.mad_bound or qp <= 1:
            break
        qp = max(1, qp - 3)
    quality["ok"] = quality["worst_mad_luma"] <= opts.mad_bound
    return rend, results, quality


def write_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, separators=(",", ":")))


def bake(timelines: Mapping[int, object], provider: Provider, cameras: Cameras, out_dir: Path, opts: Options = Options(), main_hz: int = 72) -> dict:
    """Bake every timeline into out_dir/video/ and validate. `timelines` maps display Hz -> timeline; main_hz is show.h264's."""
    vdir = Path(out_dir) / "video"
    vdir.mkdir(parents=True, exist_ok=True)
    tl = timelines[main_hz]
    layout = opts.layout
    small_layout = layout.scaled(opts.small_width) if opts.small else None
    report: dict = {"streams": {}, "missing": [], "warnings": []}

    freeze_img = provider.freeze()
    encode.write_png(vdir / "freeze.png", freeze_img)

    # main (+ small from the same pass, + pass1.mp4)
    outputs = [encode.Output(vdir / "show.h264", layout.width, layout.height)]
    if small_layout:
        outputs.append(encode.Output(vdir / "show-small.h264", small_layout.width, small_layout.height))
    if opts.pass1_mp4:
        outputs.append(encode.Output(vdir / "pass1.mp4", layout.width, layout.height, fmt="mp4", limit=tl.segments["pass1"][1] + 1))
    rend, results, quality = encode_timeline(tl, provider, layout, opts, vdir, outputs, freeze_img, None)
    report["streams"]["main"] = {"frames": len(tl.frames), "bytes": {r.path.name: r.bytes for r in results}, "idr": results[0].idr, "f": quality}
    write_json(vdir / "frames.json", cameras.frames_json(tl))
    write_json(vdir / "cards.json", rend.cards)
    if rend.dropped:
        report["warnings"].append(f"{len(rend.dropped)} people found no matte slot (first: {rend.dropped[0]}); raise n_slots")
    if rend.missing_mattes:
        report["warnings"].append(f"people without a matte, no card made: {sorted(rend.missing_mattes)}")
    cards_per_frame = [len(c["cards"]) for c in rend.cards]
    report["streams"]["main"]["cards"] = {"max": max(cards_per_frame, default=0), "frames_with_cards": sum(1 for c in cards_per_frame if c)}

    video: dict = {
        "file": "video/show.h264", "codec": results[0].codec, "width": layout.width, "height": layout.height,
        "regions": layout.regions_json(), "displayHz": tl.hz, "pass2Speed": tl.pass2_speed, "fallbacks": {},
        "frames": "video/frames.json", "cards": "video/cards.json", "segments": tl.segments, "cutoff": tl.cutoff,
        "freezeSource": tl.freeze, "freeze": "video/freeze.png", "freezeClean": "video/freeze-clean.png", "standsMask": "video/stands-mask.png",
    }
    if opts.make_source is not None:
        video["makeSource"] = opts.make_source
    fb = video["fallbacks"]
    if small_layout:
        r = results[1]
        fb["small"] = {"file": "video/show-small.h264", "codec": r.codec, "width": small_layout.width, "height": small_layout.height}
    if opts.pass1_mp4:
        fb["element"] = "video/pass1.mp4"

    # the 90 Hz bake: its own frames, cards, segments, cutoff; same stacked size as the main stream, so its cards stay in
    # main pixels (level 5.2 at 90 Hz -> avc1.640034)
    if opts.hz90 and 90 in timelines:
        t90 = timelines[90]
        outs = [encode.Output(vdir / "show-90.h264", layout.width, layout.height)]
        r90, res90, q90 = encode_timeline(t90, provider, layout, opts, vdir, outs, freeze_img, None)
        report["streams"]["hz90"] = {"frames": len(t90.frames), "bytes": {r.path.name: r.bytes for r in res90}, "idr": res90[0].idr, "f": q90}
        write_json(vdir / "frames-90.json", cameras.frames_json(t90))
        write_json(vdir / "cards-90.json", r90.cards)
        fb["hz90"] = {
            "file": "video/show-90.h264", "codec": res90[0].codec, "width": layout.width, "height": layout.height, "displayHz": 90,
            "frames": "video/frames-90.json", "cards": "video/cards-90.json", "segments": t90.segments, "cutoff": t90.cutoff,
        }

    # F's plate and masks come from the layers' data; never faked
    for name, getter, key in (("freeze-clean.png", provider.freeze_clean, "freezeClean"), ("stands-mask.png", provider.stands_mask, "standsMask"), ("inpaint-mask.png", provider.inpaint_mask, "inpaintMask")):
        img = getter()
        if img is None:
            report["missing"].append(name)
            continue
        encode.write_png(vdir / name, img if img.ndim == 3 else np.repeat(img[..., None], 3, -1))
        video[key] = f"video/{name}"

    info = {"video": video, "camera": cameras.camera_block()}
    write_json(vdir / "video.json", info)
    check = fmtcheck.check_bundle(vdir)
    report["format"] = check
    report["ok"] = bool(check["ok"]) and all(s["f"]["ok"] for s in report["streams"].values())
    return report


# ---------------------------------------------------------------- CLI


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--synth", metavar="DIR", help="bake the synthetic clip into DIR (a temp-style work dir)")
    mode.add_argument("--real", action="store_true", help="bake the real clip into the private bundle")
    ap.add_argument("--out", help="bundle folder (real: default ~/court-side-data/luka/bundle/court-side)")
    ap.add_argument("--config", help="private bake_config.json (real)")
    ap.add_argument("--crf", type=float, default=18)
    ap.add_argument("--preset", default="veryfast")
    ap.add_argument("--no-hz90", action="store_true")
    ap.add_argument("--no-small", action="store_true")
    ap.add_argument("--no-pass1-mp4", action="store_true")
    ap.add_argument("--protect-qp", type=int)
    args = ap.parse_args(argv)
    from pipeline.court.bake import providers  # the footage-side adapters (source / interp / layers / cameras)

    opts = Options(crf=args.crf, preset=args.preset, protect_qp=args.protect_qp, hz90=not args.no_hz90, small=not args.no_small, pass1_mp4=not args.no_pass1_mp4)
    run = providers.synth_run if args.synth else providers.real_run
    report = run(Path(args.synth) if args.synth else None, args.out, args.config, opts, bake)
    print(json.dumps(report, indent=1, default=str))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
