"""Read-only demo-readiness validator tests using tiny synthetic bundles."""

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from lucid.validate_bundle import main, validate


def bundle(root: Path, *, captions=False) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "frames").mkdir()
    for i in range(2):
        (root / "frames" / f"{i:06d}.spz").write_bytes(b"SPZ\0" + bytes([i]))
    (root / "preview.mp4").write_bytes(b"video")
    (root / "thumb.jpg").write_bytes(b"image")
    data = {"id": root.name, "name": "Test dream", "kind": "replay", "fps": 25.0, "frameCount": 2,
            "durationS": 0.08, "units": "meters", "upAxis": "+Y",
            "bounds": {"min": [-.5, 0, -.5], "max": [.5, 1.8, .5]},
            "frames": {"dir": "frames", "spz": "%06d.spz"}, "avatar": None,
            "audio": None, "preview": "preview.mp4", "thumb": "thumb.jpg", "source": None,
            "metrics": {"psnr": None, "ssim": None, "lpips": None, "views": None},
            "createdAt": "2026-10-25T00:00:00Z"}
    if captions:
        (root / "captions.vtt").write_text("WEBVTT\n\n1\n00:00:00.000 --> 00:00:00.050\nHello.\n")
        data["captions"] = "captions.vtt"
    (root / "dream.json").write_text(json.dumps(data))
    return root


class ValidateBundleTests(unittest.TestCase):
    def test_valid_replay_is_ready_and_read_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = bundle(Path(tmp) / "valid", captions=True)
            before = {p.relative_to(path): p.read_bytes() for p in path.rglob("*") if p.is_file()}
            report = validate(path)
            self.assertTrue(report.ready, report.as_dict())
            self.assertTrue(any(c["check"] == "Reconstruction assets" and c["level"] == "pass" for c in report.checks))
            after = {p.relative_to(path): p.read_bytes() for p in path.rglob("*") if p.is_file()}
            self.assertEqual(before, after)

    def test_missing_frame_and_missing_referenced_audio_are_critical(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = bundle(Path(tmp) / "broken")
            (path / "frames" / "000001.spz").unlink()
            data = json.loads((path / "dream.json").read_text())
            data["audio"] = "missing.m4a"
            (path / "dream.json").write_text(json.dumps(data))
            report = validate(path)
            self.assertFalse(report.ready)
            messages = "\n".join(c["message"] for c in report.checks if c["level"] == "error")
            self.assertIn("Missing 1 streamed SPZ", messages)
            self.assertIn("missing.m4a", messages)

    def test_bad_json_empty_asset_and_overlapping_vtt_are_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = bundle(Path(tmp) / "corrupt", captions=True)
            (path / "preview.mp4").write_bytes(b"")
            (path / "captions.vtt").write_text("WEBVTT\n\n00:00:00.000 --> 00:00:00.060\nA\n\n00:00:00.040 --> 00:00:00.070\nB\n")
            report = validate(path)
            self.assertFalse(report.ready)
            messages = "\n".join(c["message"] for c in report.checks if c["level"] == "error")
            self.assertIn("empty referenced asset", messages)
            self.assertIn("overlap", messages)

    def test_optional_joints_props_experience_and_accessibility_are_validated(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = bundle(Path(tmp) / "complete")
            (path / "joints.json").write_text(json.dumps({"names": ["pelvis"], "frames": [[[0, 1, 0]], [[0, 1, 0]]]}))
            (path / "props.json").write_text(json.dumps({"objects": [{"kind": "basketball", "track": [[0, 1, 0], None]}]}))
            (path / "experience.json").write_text(json.dumps({"mode": "teach", "place": "ahead", "steps": [{"start": 0, "end": .08}]}))
            (path / "caption-accessibility.json").write_text(json.dumps({"schemaVersion": 1, "preset": "focus", "captions": "captions.vtt",
                "presentation": {"fontFamily": "system-ui", "fontScale": 1.2, "letterSpacingEm": .02, "lineSpacing": 1.25, "foreground": "#FFFFFF", "background": "#101010", "backgroundOpacity": .94, "position": "bottom"},
                "cueLimits": {"maxLines": 1, "maxCharsPerLine": 28, "minDurationS": 1, "maxDurationS": 3.5, "oneGroupAtATime": True}}))
            data = json.loads((path / "dream.json").read_text())
            data.update({"joints": "joints.json", "props": "props.json", "experience": "experience.json"})
            (path / "dream.json").write_text(json.dumps(data))
            self.assertTrue(validate(path).ready, validate(path).as_dict())

    def test_directory_and_json_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle(root / "a")
            bundle(root / "b")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(main([str(root), "--json"]), 0)
            data = json.loads(out.getvalue())
            self.assertTrue(data["ready"])
            self.assertEqual(len(data["reports"]), 2)


if __name__ == "__main__":
    unittest.main()
