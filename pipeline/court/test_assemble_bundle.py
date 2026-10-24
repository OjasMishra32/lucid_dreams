"""assemble.py end to end on the synthetic stand-in: a calibration made from the stand-in's own cameras, synthetic crowd
audio and calibrated soles, then --validate (format.ts's validators through node, files, codecs, sizes, coordinates).
Run from the repo root after `node apps/webxr/scripts/court/standin.mjs`:
python3 -I -m unittest discover -s pipeline/court -p 'test_assemble*.py' -v"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import assemble as A  # noqa: E402
import assemble_audio as au  # noqa: E402
import assemble_geom as g  # noqa: E402
import assemble_splats as sp  # noqa: E402
from test_assemble import person  # noqa: E402
from test_assemble_audio import SR, crowd  # noqa: E402

STANDIN = A.DEFAULT_STANDIN


@unittest.skipUnless((STANDIN / "court.json").exists() and shutil.which("node"), "needs the stand-in (standin.mjs) and node")
class Bundle(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        S = json.loads((STANDIN / "court.json").read_text())
        frames = json.loads((STANDIN / S["video"]["frames"]).read_text())
        # a calibration that is the stand-in's own camera, in the calibration's layout (camera-from-world R)
        by_src = {}
        for fr in frames:
            if not fr["interp"]:
                by_src[int(fr["src"])] = fr
        calib = {"image_size": [S["camera"]["width"], S["camera"]["height"]], "C": S["camera"]["centre"],
                 "frames": [{"source_frame": n, "R": g.quat_to_matrix(fr["q"]).T.tolist(), "f": fr["f"]} for n, fr in sorted(by_src.items())],
                 "summary": {"click_reproj_px": {"median": 0.5, "p95": 2.0}}}
        (cls.tmp / "calib.json").write_text(json.dumps(calib))
        au.write_wav(cls.tmp / "loop.wav", crowd(seconds=19.0), SR)
        # extras as the extras stream writes them: one landed (a body in export space: feet at the origin, the camera
        # that posed it at -z), one still planned
        ex = cls.tmp / "extras"
        rng = np.random.default_rng(3)
        P = person(rng, n=3000, height=2.0)
        n = len(P)
        sp.write_ply(ex / "x-one" / "body.ply", sp.Splats.new(P, np.tile([1, 0, 0, 0], (n, 1)), np.full((n, 3), -4.6), np.full(n, 3.0), np.zeros((n, 3))))
        (ex / "x-one" / "extra.json").write_text(json.dumps({"id": "x-one", "name": "One", "kind": "splats", "file": "body.ply", "reality": None,
                                                             "pose": {"camera": "C"}, "foot": {"xz": [9.0, -3.0], "y": 0.0}, "height_m": 2.0,
                                                             "cameraCentre": [0.0, 11.0, 31.0]}))
        # one placed in court metres already, every Gaussian imagined ("reality": "all"), and one left out
        Pc = person(rng, n=3000, height=1.9, foot=(10.0, -5.0))
        sp.write_ply(ex / "x-three" / "placed.ply", sp.Splats.new(Pc, np.tile([1, 0, 0, 0], (n, 1)), np.full((n, 3), -4.6), np.full(n, 3.0), np.zeros((n, 3))))
        (ex / "x-three" / "extra.json").write_text(json.dumps({"id": "x-three", "kind": "body", "file": "placed.ply", "reality": "all", "space": "court",
                                                               "pose": {"camera": "C"}, "foot": {"xz": [10.0, -5.0]}, "height_m": None}))
        (ex / "x-out").mkdir(parents=True)
        (ex / "x-out" / "extra.json").write_text(json.dumps({"id": "x-out", "kind": "out", "file": None, "foot": {"xz": [0, 0]}}))
        (ex / "x-two").mkdir(parents=True)
        (ex / "x-two" / "extra.json").write_text(json.dumps({"id": "x-two", "kind": "splats", "file": None, "pose": {"camera": "C"},
                                                             "foot": {"xz": [10.0, 2.0]}, "height_m": 1.9, "status": "planned"}))
        cls.planes = [{"kind": "plane", "points": [[17.0, 0, -9.6], [17.0, 0, 9.6], [17.0, 2.5, 9.6], [17.0, 2.5, -9.6]]},
                      {"kind": "plane", "points": [[18.5, 2.5, -9.6], [18.5, 2.5, 9.6], [18.5, 12, 9.6], [18.5, 12, -9.6]]}]
        (cls.tmp / "stands.json").write_text(json.dumps({"proxy": cls.planes, "report": {"points": 50, "front": {"x": 17.0}, "upper": {"fit": False}}}))
        cam = S["camera"]
        cfg = {
            "stands": {"proxyFile": str(cls.tmp / "stands.json")},
            "extras": str(ex),
            "title": "Synthetic", "caption": "Synthetic · two players", "credit": "Synthetic test bundle.",
            "out": str(cls.tmp / "bundle" / "court-side"), "calib": str(cls.tmp / "calib.json"),
            "source": {"freezeSource": S["video"]["freezeSource"], "sourceFps": cam["sourceFps"], "captureFps": cam["captureFps"], "slow": cam["slow"]},
            "players": [{"id": "a", "name": "A", "foot": [[5.6, 0.6]]}, {"id": "b", "name": "B", "foot": [[6.4, 1.5]]}],
            "audio": {"loop": str(cls.tmp / "loop.wav")},
        }
        (cls.tmp / "assemble.json").write_text(json.dumps(cfg))
        cls.code = A.main(["--config", str(cls.tmp / "assemble.json")])
        cls.out = Path(cfg["out"])

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_assembles_and_validates(self):
        self.assertEqual(self.code, 0)
        errs, pending, info = A.validate(self.out, A.WEBXR)
        self.assertEqual(errs, [])
        self.assertTrue(any("show" in p for p in pending))  # the show is the stand-in's, and says so

    def test_players_stand_on_their_soles(self):
        court = json.loads((self.out / "court.json").read_text())
        asm = json.loads((self.out / "assembly.json").read_text())
        for pid, foot in (("a", [5.6, 0.6]), ("b", [6.4, 1.5])):
            np.testing.assert_allclose(asm["players"][pid]["contact"], foot, atol=0.01)
        self.assertEqual([p["id"] for p in court["freeze"]["players"]], ["a", "b"])
        np.testing.assert_allclose(court["seat"]["pairCentre"], [6.0, 0.0, 1.05], atol=0.01)

    def test_measured_stands_replace_the_stand_in(self):
        court = json.loads((self.out / "court.json").read_text())
        self.assertEqual(court["freeze"]["stands"], {"proxy": self.planes, "cards": []})

    def test_extras_stand_where_the_manifest_says(self):
        court = json.loads((self.out / "court.json").read_text())
        asm = json.loads((self.out / "assembly.json").read_text())
        others = {o["id"]: o for o in court["freeze"]["others"]}
        self.assertEqual(list(others), ["x-one", "x-three"])
        np.testing.assert_allclose(others["x-three"]["foot"], [10.0, 0.0, -5.0], atol=0.01)
        f = sp.read_ply(self.out / others["x-three"]["file"])
        r = sp.read_ply(self.out / others["x-three"]["reality"])
        self.assertFalse(np.any(np.all(np.isclose(f.dc, r.dc), 1)))  # all of it tinted
        self.assertFalse(any("x-out" in n for n in asm["notes"]))
        np.testing.assert_allclose(others["x-one"]["foot"], [9.0, 0.0, -3.0], atol=0.01)
        self.assertAlmostEqual(others["x-one"]["height"], 2.0, delta=0.05)
        self.assertEqual(others["x-one"]["pose"], "C")
        self.assertTrue(any("x-two" in n for n in asm["notes"]))

    def test_idr_frames_are_found_where_the_segments_start(self):
        S = json.loads((STANDIN / "court.json").read_text())
        seg = S["video"]["segments"]
        starts = sorted([seg["pass1"][0], seg["pass2"][0], seg["resume"][0]] + [e["frames"][0] for e in seg["eases"]])
        h = A.h264_info(STANDIN / S["video"]["file"])
        self.assertEqual(h["idrFrames"], starts)

    def test_a_pair_behind_camera_f_fails(self):
        bad = self.tmp / "behind"
        shutil.copytree(self.out, bad)
        court = json.loads((bad / "court.json").read_text())
        C = np.array(court["camera"]["centre"])
        pc = np.array(court["seat"]["pairCentre"])
        court["seat"]["pairCentre"] = [round(float(x), 3) for x in (2 * C - pc) * [1, 0, 1]]  # mirrored behind the camera
        (bad / "court.json").write_text(json.dumps(court))
        errs, _, _ = A.validate(bad, A.WEBXR)
        self.assertTrue(any("behind camera F" in e for e in errs), errs)

    def test_a_staged_show_without_its_plates_gets_the_assemblys_own(self):
        """The bake's first stage: the streams, frames, cards and freeze.png, but no clean plate or stands mask named.
        It is taken whole, the two plates are made here, and the bundle still validates."""
        S = json.loads((STANDIN / "court.json").read_text())
        show = self.tmp / "show"
        shutil.copytree(STANDIN / "video", show / "video")
        video = json.loads(json.dumps(S["video"]))
        for k in ("freezeClean", "standsMask", "inpaintMask"):
            video.pop(k, None)
            (show / "video" / Path(S["video"].get(k, "x/none")).name).unlink(missing_ok=True)
        cam = S["camera"]
        (show / "video.json").write_text(json.dumps({"video": video, "camera": {"centre": cam["centre"], "sourceFps": cam["sourceFps"],
                                                                                 "captureFps": cam["captureFps"], "slow": cam["slow"]}}))
        old = 1_700_000_000
        for p in [show / "video.json", *(show / "video").iterdir()]:
            os.utime(p, (old, old))  # written long ago: complete
        cfg = json.loads((self.tmp / "assemble.json").read_text())
        cfg.update({"show": str(show), "out": str(self.tmp / "bundle2" / "court-side")})
        (self.tmp / "assemble2.json").write_text(json.dumps(cfg))
        self.assertEqual(A.main(["--config", str(self.tmp / "assemble2.json")]), 0)
        out = Path(cfg["out"])
        asm = json.loads((out / "assembly.json").read_text())
        self.assertEqual(asm["pieces"]["show"]["source"], "real")
        self.assertEqual(asm["pieces"]["show:standsMask"]["source"], "stand-in")
        errs, pending, _ = A.validate(out, A.WEBXR)
        self.assertEqual(errs, [])
        self.assertTrue(any("show:freezeClean" in p for p in pending))
        made = A.check_frames(out, self.tmp / "frames")
        self.assertEqual([p.name.split("-show")[0] for p in made[:3]], ["watch", "mid-ease", "at-F"])
        self.assertTrue(all(p.stat().st_size > 1000 for p in made))

    def staged_show(self, name: str) -> tuple[Path, dict]:
        S = json.loads((STANDIN / "court.json").read_text())
        show = self.tmp / name
        shutil.copytree(STANDIN / "video", show / "video")
        cam = S["camera"]
        manifest = {"video": json.loads(json.dumps(S["video"])), "camera": {"centre": cam["centre"], "sourceFps": cam["sourceFps"],
                                                                             "captureFps": cam["captureFps"], "slow": cam["slow"]}}
        return show, manifest

    def stage(self, show: Path, manifest: dict) -> None:
        (show / "video.json").write_text(json.dumps(manifest))
        old = 1_700_000_000
        for p in [show / "video.json", *(show / "video").iterdir()]:
            os.utime(p, (old, old), follow_symlinks=False)

    def assemble_with(self, name: str, **cfg_over) -> tuple[int, Path]:
        cfg = json.loads((self.tmp / "assemble.json").read_text())
        cfg.update({"out": str(self.tmp / name / "court-side"), **cfg_over})
        (self.tmp / f"{name}.json").write_text(json.dumps(cfg))
        return A.main(["--config", str(self.tmp / f"{name}.json")]), Path(cfg["out"])

    def test_a_manifest_path_leaving_the_bundle_copies_nothing(self):
        show, manifest = self.staged_show("show-leak")
        (self.tmp / "leaked.h264").write_bytes(b"private")
        manifest["video"]["fallbacks"]["element"] = "../../leaked.h264"
        self.stage(show, manifest)
        code, out = self.assemble_with("leak", show=str(show))
        self.assertEqual(code, 0)
        asm = json.loads((out / "assembly.json").read_text())
        self.assertEqual(asm["pieces"]["show"]["source"], "stand-in")
        self.assertTrue(any("leaked.h264" in n for n in asm["notes"]), asm["notes"])
        self.assertEqual([p for p in out.parent.parent.rglob("leaked.h264")], [self.tmp / "leaked.h264"])

    def test_a_show_found_in_the_bundle_stays_findable(self):
        show, manifest = self.staged_show("show-inplace")
        self.stage(show, manifest)
        code, out = self.assemble_with("inplace", show=str(show))
        self.assertTrue((out / "video" / "video.json").exists())
        old = 1_700_000_000
        for p in (out / "video").iterdir():
            os.utime(p, (old, old))
        cfg = json.loads((self.tmp / "inplace.json").read_text())
        cfg.pop("show")
        (self.tmp / "inplace.json").write_text(json.dumps(cfg))
        self.assertEqual(A.main(["--config", str(self.tmp / "inplace.json")]), 0)
        asm = json.loads((out / "assembly.json").read_text())
        self.assertEqual(asm["pieces"]["show"]["source"], "real")
        self.assertTrue((out / "video" / "video.json").exists())

    def test_a_show_changing_while_copied_is_not_taken(self):
        show, manifest = self.staged_show("show-moving")
        self.stage(show, manifest)
        real_copy = A.Writer.copy

        def copy_and_touch(w, src, rel, within=None):  # the producer rewrites frames.json while we copy
            r = real_copy(w, src, rel, within=within)
            if rel.endswith("frames.json"):
                f = show / "video" / "frames.json"
                f.write_text(f.read_text() + " ")
            return r

        A.Writer.copy = copy_and_touch
        try:
            code, out = self.assemble_with("moving", show=str(show))
        finally:
            A.Writer.copy = real_copy
        asm = json.loads((out / "assembly.json").read_text())
        self.assertEqual(asm["pieces"]["show"]["source"], "stand-in")
        self.assertTrue(any("changed while" in n for n in asm["notes"]), asm["notes"])

    def test_a_shows_cameras_carry_the_calibrations_flags(self):
        """A show with its own cameras: compared with the calibration's, and the frames the calibration interpolated or
        flagged inside the show are named in the cameras piece and the notes."""
        calib = json.loads((self.tmp / "calib.json").read_text())
        srcs = [fr["source_frame"] for fr in calib["frames"]]
        mid = srcs[len(srcs) // 2]
        for fr in calib["frames"]:
            fr["source"] = "layers+interp" if fr["source_frame"] in (mid, mid + 1) else "layers+lines"
        calib["flags"] = {"no_lines": [[mid - 1, mid + 2]], "offset_gt_1p5px": [srcs[-1] + 50]}
        (self.tmp / "calib-flags.json").write_text(json.dumps(calib))
        show, manifest = self.staged_show("show-flags")
        self.stage(show, manifest)
        code, out = self.assemble_with("flags", show=str(show), calib=str(self.tmp / "calib-flags.json"))
        self.assertEqual(code, 0)
        asm = json.loads((out / "assembly.json").read_text())
        cams = asm["pieces"]["cameras"]
        self.assertEqual(cams["calibFlags"], {"interp": [[mid, mid + 1]], "no_lines": [[mid - 1, mid + 2]]})
        self.assertLess(cams["vsCalib"]["maxDeg"], 0.05)
        self.assertGreater(cams["vsCalib"]["frames"], 0)
        self.assertTrue(any(n.startswith("cameras: the calibration flags") and f"interp {mid}-{mid + 1}" in n for n in asm["notes"]), asm["notes"])

    def test_an_extras_declared_foot_and_height_are_kept(self):
        court = json.loads((self.out / "court.json").read_text())
        others = {o["id"]: o for o in court["freeze"]["others"]}
        self.assertEqual(others["x-one"]["foot"], [9.0, 0.0, -3.0])
        self.assertEqual(others["x-one"]["height"], 2.0)

    def test_a_relief_off_the_court_fails(self):
        bad = self.copy_bad("relief")
        court = json.loads((bad / "court.json").read_text())
        pos = np.array([[105.0, 0.0, 0.0], [105.5, 0.0, 0.0], [105.0, 1.9, 0.1]], np.float32)
        (bad / "others").mkdir(exist_ok=True)
        (bad / "others" / "r.glb").write_bytes(sp.glb(pos, np.array([0, 1, 2]), "r"))
        court["freeze"]["others"].append({"id": "r", "kind": "relief", "file": "others/r.glb", "reality": "others/r.glb", "pose": "A",
                                          "foot": [5.0, 0.0, 1.0], "height": 1.9, "maxRayAngle": 5.0,
                                          "shadow": court["freeze"]["others"][0]["shadow"], "reflection": court["freeze"]["others"][0]["reflection"]})
        (bad / "court.json").write_text(json.dumps(court))
        errs, _, _ = A.validate(bad, A.WEBXR)
        self.assertTrue(any(e.startswith("r:") and "foot" in e for e in errs), errs)
        self.assertTrue(any(e.startswith("r:") and "off the court" in e for e in errs), errs)

    def test_a_stream_changing_size_mid_way_fails(self):
        import subprocess

        bad = self.copy_bad("resize")
        court = json.loads((bad / "court.json").read_text())
        main = bad / court["video"]["file"]
        extra = self.tmp / "other-size.h264"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=640x900:d=0.04:r=25", "-frames:v", "1",
                        "-c:v", "libx264", "-x264-params", "aud=1", "-pix_fmt", "yuv420p", "-bsf:v", "h264_mp4toannexb", "-f", "h264",
                        str(extra)], check=True)
        main.write_bytes(main.read_bytes() + extra.read_bytes())
        errs, _, _ = A.validate(bad, A.WEBXR)
        self.assertTrue(any(court["video"]["file"] in e and "640x900" in e for e in errs), errs)

    def test_a_stream_without_access_unit_delimiters_fails(self):
        bad = self.copy_bad("noaud")
        court = json.loads((bad / "court.json").read_text())
        main = bad / court["video"]["file"]
        data = main.read_bytes()
        units = A.annexb_units(data)
        keep = bytearray()
        starts = [o - 3 for _, o in units] + [len(data)]  # the 3-byte start code before each NAL payload
        for (t, o), a, b in zip(units, starts, starts[1:]):
            if t != 9:
                keep += data[a:b]
        main.write_bytes(bytes(keep))
        errs, _, _ = A.validate(bad, A.WEBXR)
        self.assertTrue(any(court["video"]["file"] in e and "access unit delimiter" in e for e in errs), errs)

    def copy_bad(self, name: str) -> Path:
        bad = self.tmp / name
        shutil.copytree(self.out, bad)
        return bad

    def test_a_stream_of_the_wrong_size_or_length_fails(self):
        import subprocess

        bad = self.copy_bad("tiny")
        court = json.loads((bad / "court.json").read_text())
        small = court["video"]["fallbacks"]["small"]["file"]
        # a 1-frame 64x90 stream where the 1280-wide copy should be: its size, length and IDRs must all fail
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=64x90:d=0.04:r=25", "-frames:v", "1",
                        "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-bsf:v", "h264_mp4toannexb", "-f", "h264",
                        str(bad / small)], check=True)
        errs, _, _ = A.validate(bad, A.WEBXR)
        self.assertTrue(any(small in e and "64x90" in e for e in errs), errs)
        self.assertTrue(any(small in e and "1 frame" in e for e in errs), errs)
        self.assertTrue(any(small in e and "IDR" in e for e in errs), errs)

    def test_an_extra_off_its_foot_point_fails(self):
        bad = self.copy_bad("shifted")
        court = json.loads((bad / "court.json").read_text())
        o = court["freeze"]["others"][0]
        s = sp.read_ply(bad / o["file"])
        s.table["x"] += 100.0
        s.table["y"] -= 20.0
        sp.write_ply(bad / o["file"], s)
        errs, _, _ = A.validate(bad, A.WEBXR)
        self.assertTrue(any(o["id"] in e and "foot" in e for e in errs), errs)
        self.assertTrue(any(o["id"] in e and "floor" in e for e in errs), errs)

    def test_p42_unmeasured_is_pending_or_an_error_when_strict(self):
        bad = self.copy_bad("p42")
        asm = json.loads((bad / "assembly.json").read_text())
        asm["pieces"]["player:a"]["source"] = "real"  # a real body given as a bare PLY: no run report to check
        (bad / "assembly.json").write_text(json.dumps(asm))
        errs, pending, _ = A.validate(bad, A.WEBXR)
        self.assertTrue(any("P42" in p and "a" in p for p in pending), pending)
        errs, _, _ = A.validate(bad, A.WEBXR, strict=True)
        self.assertTrue(any("P42" in e for e in errs), errs)

    def test_a_validation_error_is_named(self):
        bad = self.tmp / "bad"
        shutil.copytree(self.out, bad)
        court = json.loads((bad / "court.json").read_text())
        court["seat"]["distance"] = 9
        (bad / "court.json").write_text(json.dumps(court))
        (bad / court["freeze"]["players"][0]["proxy"]).unlink()
        errs, _, _ = A.validate(bad, A.WEBXR)
        self.assertTrue(any("seat.distance" in e for e in errs), errs)
        self.assertTrue(any("proxy.glb: missing" in e for e in errs), errs)


if __name__ == "__main__":
    unittest.main()
