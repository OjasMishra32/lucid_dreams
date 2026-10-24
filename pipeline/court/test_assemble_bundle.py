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
        self.assertEqual(list(others), ["x-one"])
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
