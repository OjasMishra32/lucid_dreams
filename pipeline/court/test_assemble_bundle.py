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

    def test_check_frames_at_source_frames_and_the_make(self):
        """Frames to look at by source frame: the first show frame nearest each asked one, and the make's."""
        court = json.loads((self.out / "court.json").read_text())
        frames = json.loads((self.out / court["video"]["frames"]).read_text())
        made = A.check_frames(self.out, self.tmp / "frames-at", at=[300])
        names = [p.name for p in made]
        n = min(range(len(frames)), key=lambda i: (abs(frames[i]["src"] - 300), i))
        self.assertIn(f"src0300-show{n:04d}.jpg", names)
        m = min(range(len(frames)), key=lambda i: (abs(frames[i]["src"] - court["video"]["makeSource"]), i))
        self.assertIn(f"make-show{m:04d}.jpg", names)
        self.assertTrue(all(p.stat().st_size > 1000 for p in made))
        n = court["video"]["segments"]["eases"][0]["frames"][1]
        self.assertIn(f"at-F-splats-under-show{n:04d}.jpg", names)
        self.assertIn(f"at-F-splats-outline-show{n:04d}.jpg", names)

    def test_a_mask_at_f_gives_each_players_silhouette_iou(self):
        """A player's mask at F (raw source pixels) against its splats' true coverage seen from camera F: its own
        silhouette scores ~1, the same mask moved half a body away scores low."""
        import cv2

        court = json.loads((self.out / "court.json").read_text())
        frames = json.loads((self.out / court["video"]["frames"]).read_text())
        camF = A.frame_camera(court["camera"], frames, court["video"])
        a = sp.read_ply(self.out / court["freeze"]["players"][0]["splats"])
        cam = camF.scaled(960)
        own = np.where(sp.coverage_image(a, cam, (0.0, 0.0, float(cam.w), float(cam.h)), cam.w, cam.h) >= 0.5, 255, 0).astype(np.uint8)
        cv2.imwrite(str(self.tmp / "mask-a.png"), cv2.resize(own, (camF.w, camF.h), interpolation=cv2.INTER_NEAREST))
        x = np.nonzero(own.any(0))[0]
        moved = np.roll(own, (x.max() - x.min()) // 2, axis=1)
        cv2.imwrite(str(self.tmp / "mask-b.png"), cv2.resize(moved, (camF.w, camF.h), interpolation=cv2.INTER_NEAREST))
        cfg = json.loads((self.tmp / "assemble.json").read_text())
        players = [{**cfg["players"][0], "maskF": str(self.tmp / "mask-a.png")}, {**cfg["players"][1], "maskF": str(self.tmp / "mask-b.png")}]
        code, out = self.assemble_with("masks", players=players)
        self.assertEqual(code, 0)
        asm = json.loads((out / "assembly.json").read_text())
        self.assertGreater(asm["pieces"]["player:a"]["silhouetteIoU"], 0.95)
        self.assertLess(asm["pieces"]["player:b"]["silhouetteIoU"], 0.3)
        self.assertTrue(any(n.startswith("silhouette IoU at F") for n in asm["notes"]), asm["notes"])

    def test_foot_error_is_against_a_depth_true_reference_only(self):
        """footError (and the camera placement's vsFeet) compare the soles with a depth-true reference (players[].footRef:
        a steep camera's or GVHMR's feet), never the source camera's own ground clicks, which can't see depth."""
        cfg = json.loads((self.tmp / "assemble.json").read_text())
        players = [{**cfg["players"][0], "footRef": {"source": "C", "xz": [[5.6, 0.6]]}}, cfg["players"][1]]
        code, out = self.assemble_with("footref", players=players)
        self.assertEqual(code, 0)
        asm = json.loads((out / "assembly.json").read_text())
        self.assertEqual(asm["players"]["a"]["footError"]["against"], "C")
        self.assertLess(asm["players"]["a"]["footError"]["m"], 0.5)
        self.assertNotIn("footError", asm["players"]["b"])
        self.assertIn("ground clicks", asm["players"]["b"]["placement"]["depthNote"])

    def test_a_freeze_runs_crop_mask_is_the_silhouette_check(self):
        """With its freeze run's clip folder (court-run.json, masks/<K>.png, ignore/<K>.png), a player is checked at the
        run's own crop through its still camera, the ignored pixels left out."""
        import cv2

        court = json.loads((self.out / "court.json").read_text())
        frames = json.loads((self.out / court["video"]["frames"]).read_text())
        camF = A.frame_camera(court["camera"], frames, court["video"])
        a = sp.read_ply(self.out / court["freeze"]["players"][0]["splats"])
        u, v, _ = camF.project(a.pos[a.alpha > 0.5].astype(float))
        x0, y0 = int(u.min()) - 40, int(v.min()) - 40
        cw, ch = int(u.max()) + 40 - x0, int(v.max()) + 40 - y0
        clip = self.tmp / "clip-a"
        (clip / "masks").mkdir(parents=True, exist_ok=True)
        (clip / "ignore").mkdir(parents=True, exist_ok=True)
        still = {"R": camF.R.T.tolist(), "C": camF.C.tolist(), "K": [[camF.f, 0, camF.cx - x0], [0, camF.f, camF.cy - y0], [0, 0, 1]]}
        (clip / "court-run.json").write_text(json.dumps({"K": 7, "crop": [x0, y0, cw, ch], "still": still}))
        cam = A.still_camera(json.loads((clip / "court-run.json").read_text()))
        cov = np.where(sp.coverage_image(a, cam, (0.0, 0.0, float(cw), float(ch)), cw, ch) >= 0.5, 255, 0).astype(np.uint8)
        cov[:, : cw // 4] = 0  # a person in front hides the left quarter: the mask lost it, the ignore map holds it
        ign = np.zeros_like(cov)
        ign[:, : cw // 4] = 255
        cv2.imwrite(str(clip / "masks" / "000007.png"), cov)
        cv2.imwrite(str(clip / "ignore" / "000007.png"), ign)
        cfg = json.loads((self.tmp / "assemble.json").read_text())
        players = [{**cfg["players"][0], "courtRun": str(clip / "court-run.json")}, cfg["players"][1]]
        code, out = self.assemble_with("crop-mask", players=players)
        self.assertEqual(code, 0)
        asm = json.loads((out / "assembly.json").read_text())
        self.assertGreater(asm["pieces"]["player:a"]["silhouetteIoU"], 0.97)
        self.assertEqual(asm["pieces"]["player:a"]["silhouetteAgainst"], "crop")

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

    def test_a_waived_gate_is_reported_and_not_counted(self):
        """A recorded waiver (config `waivers`, court.json's list) turns that gate's failures into WAIVED lines with
        their numbers; anything else still fails."""
        bad = self.copy_bad("waived")
        asm = json.loads((bad / "assembly.json").read_text())
        asm["pieces"]["player:a"]["source"] = "real"
        asm["players"]["a"]["run"] = {"variant": "v", "cap": "1k", "iou": 0.7, "focal": 100.0, "focalHeld": True, "FOCAL": 100.0,
                                      "p42": {"iouSolve": 0.7, "iouFinal": 0.8123, "focalHeld": True, "focal": 100.0, "FOCAL": 100.0, "bar": 0.95, "pass": False}}
        (bad / "assembly.json").write_text(json.dumps(asm))
        errs, _, _ = A.validate(bad, A.WEBXR)
        self.assertTrue(any("(P42)" in e and "0.8123" in e for e in errs), errs)
        court = json.loads((bad / "court.json").read_text())
        court["waivers"] = ["P42"]
        (bad / "court.json").write_text(json.dumps(court))
        asm["waivers"] = {"P42": "turbo test"}
        (bad / "assembly.json").write_text(json.dumps(asm))
        errs, _, info = A.validate(bad, A.WEBXR)
        self.assertFalse(any("P42" in e for e in errs), errs)
        self.assertTrue(any(x.startswith("WAIVED P42 (turbo test)") and "0.8123" in x for x in info), info)
        court["seat"]["distance"] = 9  # an unwaived failure still fails
        (bad / "court.json").write_text(json.dumps(court))
        errs, _, _ = A.validate(bad, A.WEBXR)
        self.assertTrue(any("seat.distance" in e for e in errs), errs)

    def test_p42_is_geos_p42_json(self):
        """P42 reads court_p42.py's verdict: focal held at FOCAL and the trained render's IoU (iouFinal) >= 0.95 pass,
        whatever the pre-training solve's IoU (iouSolve, shown); a real body's run without p42.json fails loudly."""
        bad = self.copy_bad("p42-json")
        asm = json.loads((bad / "assembly.json").read_text())
        asm["pieces"]["player:a"]["source"] = "real"
        run = {"variant": "v", "cap": "1k", "iou": 0.8584, "focal": 100.0, "focalHeld": True, "FOCAL": 100.0}
        asm["players"]["a"]["run"] = {**run, "p42": {"iouSolve": 0.8584, "iouFinal": 0.9995, "focalHeld": True, "focal": 100.0, "FOCAL": 100.0, "bar": 0.95, "pass": True}}
        (bad / "assembly.json").write_text(json.dumps(asm))
        errs, _, info = A.validate(bad, A.WEBXR)
        self.assertFalse(any("P42" in e for e in errs), errs)
        self.assertTrue(any("iouFinal 0.9995" in x and "iouSolve 0.8584" in x for x in info), info)
        asm["players"]["a"]["run"] = {**run, "p42": {"iouSolve": 0.8584, "iouFinal": 0.9995, "focalHeld": True, "focal": 99.0, "FOCAL": 100.0, "bar": 0.95, "pass": True}}
        (bad / "assembly.json").write_text(json.dumps(asm))
        errs, _, _ = A.validate(bad, A.WEBXR)
        self.assertTrue(any("(P42)" in e and "FOCAL" in e for e in errs), errs)  # its own pass can't hide a focal off FOCAL
        asm["players"]["a"]["run"] = {**run, "p42": None}
        (bad / "assembly.json").write_text(json.dumps(asm))
        errs, _, _ = A.validate(bad, A.WEBXR)
        self.assertTrue(any("(P42)" in e and "p42.json" in e for e in errs), errs)

    def test_ball_in_body_is_checked_on_the_holders_splats(self):
        """freeze.ballInBody names the player whose splats hold the ball: --validate counts their solid splats at the
        ball (info), and fails when there's no ball-sized blob there or when the ball would erase them."""
        bad = self.copy_bad("ball-in-body")
        court = json.loads((bad / "court.json").read_text())
        holder = court["freeze"]["players"][0]
        s = sp.read_ply(bad / holder["splats"])
        court["freeze"]["ballInBody"] = holder["id"]
        court["freeze"]["ball"]["erase"] = []
        court["freeze"]["ball"]["centre"] = [float(x) for x in np.median(s.pos[s.alpha > 0.5], 0)]  # inside the body: plenty of splats
        (bad / "court.json").write_text(json.dumps(court))
        errs, _, info = A.validate(bad, A.WEBXR)
        self.assertFalse(any("ballInBody" in e for e in errs), errs)
        self.assertTrue(any(x.startswith(f"ballInBody {holder['id']}:") for x in info), info)
        court["freeze"]["ball"]["centre"] = [0.0, 5.0, 0.0]  # nothing of theirs there
        court["freeze"]["ball"]["erase"] = [{"player": holder["id"], "radius": 0.15}]
        (bad / "court.json").write_text(json.dumps(court))
        errs, _, _ = A.validate(bad, A.WEBXR)
        self.assertTrue(any("ballInBody" in e and "splats" in e for e in errs), errs)
        self.assertTrue(any("ballInBody" in e and "erase" in e for e in errs), errs)

    def test_a_waiver_in_the_config_lands_in_court_json(self):
        code, out = self.assemble_with("waiver-cfg", waivers={"P42": "turbo test"})
        self.assertEqual(code, 0)
        self.assertEqual(json.loads((out / "court.json").read_text())["waivers"], ["P42"])
        self.assertEqual(json.loads((out / "assembly.json").read_text())["waivers"], {"P42": "turbo test"})

    def test_the_pair_is_cut_to_its_budget_by_contribution(self):
        """capPair: each pair body keeps its largest contributions seen from camera F; the reality copy keeps the same
        Gaussians; capPsnr measures what the cut costs (seat view and an 8-view orbit, cut vs whole)."""
        code, out = self.assemble_with("capped", capPair=8000, capPsnr=True)
        self.assertEqual(code, 0)
        asm = json.loads((out / "assembly.json").read_text())
        for pid in ("a", "b"):
            c = asm["players"][pid]["cap"]
            self.assertEqual(c["kept"], 8000)
            self.assertGreater(c["from"], 8000)
            self.assertEqual(len(sp.read_ply(out / f"players/{pid}/freeze.ply")), 8000)
            self.assertEqual(len(sp.read_ply(out / f"players/{pid}/reality.ply")), 8000)
            self.assertEqual(len(c["psnr"]["orbit"]), 8)
            self.assertTrue(all(x > 10 for x in [c["psnr"]["seat"], *c["psnr"]["orbit"]]), c["psnr"])

    def test_a_coarse_proxy_fails_p8s_sampling(self):
        """P8 needs the pair's proxies sampled at about half a centimetre at the silhouettes: a 5 cm grid fails."""
        court = json.loads((self.out / "court.json").read_text())
        info = json.loads((self.out / "assembly.json").read_text())["players"]["a"]["proxy"]
        self.assertLessEqual(info["cellM"], 0.005)
        bad = self.tmp / "coarse"
        shutil.copytree(self.out, bad)
        gu, gv = np.meshgrid(np.arange(11) * 0.05, np.arange(41) * 0.05)
        pos = np.stack([5.0 + 0 * gu, gv, gu], -1).reshape(-1, 3)
        idx = [[j * 11 + i, (j + 1) * 11 + i, j * 11 + i + 1] for j in range(40) for i in range(10)]
        (bad / court["freeze"]["players"][0]["proxy"]).write_bytes(sp.glb(pos, np.array(idx).ravel(), "coarse"))
        errs, _, _ = A.validate(bad, A.WEBXR)
        self.assertTrue(any("proxy.glb" in e and "P8" in e for e in errs), errs)
        # Codex 2: fine across, coarse along (4 mm x 50 mm cells) fails too
        gu, gv = np.meshgrid(np.arange(41) * 0.004, np.arange(41) * 0.05)
        pos = np.stack([5.0 + 0 * gu, gv, gu], -1).reshape(-1, 3)
        idx = [[j * 41 + i, (j + 1) * 41 + i, j * 41 + i + 1] for j in range(40) for i in range(40)]
        (bad / court["freeze"]["players"][0]["proxy"]).write_bytes(sp.glb(pos, np.array(idx).ravel(), "thin"))
        errs, _, _ = A.validate(bad, A.WEBXR)
        self.assertTrue(any("proxy.glb" in e and "P8" in e for e in errs), errs)

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
