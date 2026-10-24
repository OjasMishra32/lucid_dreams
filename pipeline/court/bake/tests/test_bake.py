"""bake.py's stages (render -> encode -> F check -> bundle files -> format.ts validators) against a fake provider, fake
cameras and a hand-made timeline. No other bake module is imported: the end-to-end test on synth.py is test_e2e_synth.py."""

import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import pytest

from pipeline.court.bake import bake, encode, fmtcheck
from pipeline.court.bake.bake import Layers, Options
from pipeline.court.bake.cards import Person
from pipeline.court.bake.stack import synthetic_layout

LAY = synthetic_layout(256)
FREEZE = 500


@dataclass
class DF:
    i: int
    segment: str
    src: float
    interp: bool


@dataclass
class TL:
    hz: int
    pass2_speed: float
    freeze: int
    frames: list
    segments: dict
    cutoff: int
    idr: list


def make_timeline(hz, n1=24, n2=30, ease=(10, 8), n_resume=12):
    """pass 1, pass 2 (F at its 20th frame), two eases ending on F, a resume; every other pass-1 frame an in-between."""
    frames, segs = [], {}
    for k in range(n1):
        frames.append(DF(len(frames), "pass1", 400 + k / 2, k % 2 == 1))
    p2 = len(frames)
    for k in range(n2):
        frames.append(DF(len(frames), "pass2", FREEZE - 20 + k, False))
    segs["pass1"], segs["pass2"] = [0, p2 - 1], [p2, len(frames) - 1]
    eases = []
    for e, n in enumerate(ease):
        first = len(frames)
        for k in range(1, n + 1):
            frames.append(DF(len(frames), f"ease{e}", FREEZE if k == n else FREEZE - (n - k) * 0.25, k != n))
        eases.append({"start": p2 + 20 - n // 2, "frames": [first, len(frames) - 1], "seconds": round(n / hz, 4)})
    r0 = len(frames)
    for k in range(n_resume):
        frames.append(DF(len(frames), "resume", FREEZE + 1 + k, False))
    segs["resume"], segs["eases"] = [r0, len(frames) - 1], eases
    idr = sorted([0, p2, r0] + [e["frames"][0] for e in eases])
    return TL(hz, 0.6, FREEZE, frames, segs, eases[-1]["start"], idr)


def scene(src, w=384, h=216):
    """Moving background + noise (deterministic per src) and two moving people as (matte, box in a 256x144 live region)."""
    rng = np.random.default_rng(int(src * 4))
    yy, xx = np.mgrid[0:h, 0:w]
    img = np.stack([xx * 255 / w, yy * 255 / h, (xx + yy + 2 * src) % 256], -1).astype(np.float32)
    img += rng.normal(0, 3, img.shape)
    plate = np.clip(img, 0, 255).astype(np.uint8)
    live = plate.copy()
    mattes, people = {}, []
    for k, pid in enumerate(("luka", "gobert")):
        x0 = int(60 + 90 * k + (src * 2) % 30) * w // 256
        m = np.zeros((h, w), np.uint8)
        m[60:200, x0 : x0 + 40] = 255
        live[m > 0] = (230, 60 + 120 * k, 60)
        mattes[pid] = m
        box = tuple(v * 256 / w for v in (x0 - 2, 58, x0 + 42, 202))
        people.append(Person(pid, box, (1.0 + k, 0.0, 2.0 - k), k))
    return live, plate, mattes, people


class FakeProvider:
    def __init__(self, live_only=False):
        self.live_only = live_only

    def layers(self, frame):
        live, plate, mattes, people = scene(frame.src)
        if self.live_only:
            return Layers(live)
        return Layers(live, plate, mattes, people)

    def freeze(self):
        return scene(FREEZE)[0]

    def freeze_clean(self):
        return None if self.live_only else scene(FREEZE)[1]

    def stands_mask(self):
        return None

    def inpaint_mask(self):
        return None


class FakeCameras:
    def frames_json(self, tl):
        return [{"src": f.src, "interp": f.interp, "q": [0.0, 0.0, 0.0, 1.0], "f": 1000.0 + (0 if f.src == FREEZE else 1.0)} for f in tl.frames]

    def camera_block(self):
        return {"centre": [-20.0, 1.0, 3.0], "width": 384, "height": 216, "cx": 191.5, "cy": 107.5, "k1": 0, "sourceFps": 60.0, "captureFps": 120.0, "slow": 2.67}


def run_bake(tmp_path, **kw):
    # the stand-in cameras give F the same camera in every ease (validateFrames requires it); in-betweens differ
    opts = Options(layout=LAY, small_width=128, n_slots=4, crf=26, preset="veryfast", log=lambda s: None, **kw)
    tls = {72: make_timeline(72), 90: make_timeline(90, ease=(12, 8))}
    return bake.bake(tls, FakeProvider(kw.pop("live_only", False)), FakeCameras(), tmp_path, opts), tls


def test_bake_writes_the_bundle_validates_and_lands_F(tmp_path):
    rep, tls = run_bake(tmp_path)
    v = tmp_path / "video"
    for name in ("show.h264", "show-small.h264", "show-90.h264", "pass1.mp4", "frames.json", "cards.json", "frames-90.json", "cards-90.json", "freeze.png", "freeze-clean.png", "video.json"):
        assert (v / name).is_file(), name
    assert rep["missing"] == ["stands-mask.png", "inpaint-mask.png"]
    assert rep["format"]["ok"], rep["format"]["problems"]
    assert rep["ok"], rep
    assert sorted(p.name for p in v.iterdir() if p.suffix == ".png") == ["freeze-clean.png", "freeze.png"]
    # streams: one access unit per frame, IDRs at the timeline's, codec per size and rate
    info = json.loads((v / "video.json").read_text())
    assert info["video"]["codec"] == "avc1.640033" and info["video"]["fallbacks"]["hz90"]["codec"] == encode.codec_for(LAY.width, LAY.height, 90)
    for name, tl in (("show.h264", tls[72]), ("show-small.h264", tls[72]), ("show-90.h264", tls[90])):
        s = encode.scan_h264(v / name)
        assert (s.frames, s.idr) == (len(tl.frames), tl.idr), name
    # F in the stream equals freeze.png within the bound, on every frame that shows it
    freeze = cv2.cvtColor(cv2.imread(str(v / "freeze.png")), cv2.COLOR_BGR2RGB)
    tl = tls[72]
    idx = bake.freeze_indices(tl)
    assert len(idx) >= 3  # the pass-2 frame and the ends of both eases
    got = encode.decode_frames(v / "show.h264", idx, LAY.width, LAY.height)
    for i in idx:
        assert encode.frame_error(got[i], LAY, freeze)["mad_luma"] <= 1.0
    assert rep["streams"]["main"]["f"]["ok"]
    # cards: every frame has both people, stable tiles, validators already passed
    cards = json.loads((v / "cards.json").read_text())
    assert len(cards) == len(tl.frames) and all(len(c["cards"]) == 2 for c in cards)
    assert len({tuple(c["cards"][0]["tile"][:2]) for c in cards if c["cards"][0]["id"] == "luka"}) == 1
    frames = json.loads((v / "frames.json").read_text())
    assert len(frames) == len(tl.frames)


def test_live_only_stacking_has_no_cards_and_reports_missing_plate_files(tmp_path):
    opts = Options(layout=LAY, small_width=128, crf=26, preset="veryfast", hz90=False, pass1_mp4=False, log=lambda s: None)
    rep = bake.bake({72: make_timeline(72)}, FakeProvider(live_only=True), FakeCameras(), tmp_path, opts)
    assert rep["missing"] == ["freeze-clean.png", "stands-mask.png", "inpaint-mask.png"]
    cards = json.loads((tmp_path / "video" / "cards.json").read_text())
    assert all(c["cards"] == [] for c in cards)
    assert rep["format"]["ok"], rep["format"]["problems"]
    # the plate region repeats the live frame
    got = encode.decode_frames(tmp_path / "video" / "show.h264", [3], LAY.width, LAY.height)[3]
    assert encode.luma_mad(got[: LAY.live[3]], got[LAY.plate[1] : LAY.plate[1] + LAY.plate[3]]) < 3.0  # same picture, coded lossily twice


def test_a_bad_stream_fails_the_report(tmp_path, monkeypatch):
    real = fmtcheck.check_bundle
    monkeypatch.setattr(fmtcheck, "check_bundle", lambda *a, **k: {"ok": False, "problems": ["x"], "report": []})
    opts = Options(layout=LAY, small_width=128, crf=26, preset="veryfast", hz90=False, pass1_mp4=False, log=lambda s: None)
    rep = bake.bake({72: make_timeline(72)}, FakeProvider(), FakeCameras(), tmp_path, opts)
    assert rep["ok"] is False
