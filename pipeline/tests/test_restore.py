"""Standalone restoration tests; media is generated in temporary folders, never committed."""

import contextlib
import copy
from dataclasses import replace
from fractions import Fraction
import io
import json
import math
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from lucid import restore as rs


def metadata(rate="25", count=4, audio=False):
    fps = Fraction(rate)
    base = Fraction(1, fps.numerator)
    video = {"index": 0, "codec_type": "video", "width": 32, "height": 24, "pix_fmt": "yuv420p",
             "r_frame_rate": rate, "time_base": str(base), "sample_aspect_ratio": "1:1"}
    streams = [video]
    if audio:
        streams.append({"index": 1, "codec_type": "audio", "codec_name": "aac", "sample_rate": "48000",
                        "channels": 1, "channel_layout": "mono", "start_time": "0", "time_base": "1/48000"})
    return {"streams": streams, "frames": [{"media_type": "video", "best_effort_timestamp": i * fps.denominator,
                                             "duration": fps.denominator} for i in range(count)]}


def png_header(path, width=32, height=24):
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", width, height))


class MetadataTests(unittest.TestCase):
    def test_fractional_frame_rate_is_exact(self):
        media = rs.inspect(metadata("30000/1001"))
        self.assertEqual(media.fps, Fraction(30000, 1001))
        self.assertEqual(media.duration, Fraction(4004, 30000))

    def test_non_square_pixels_preserve_display_shape(self):
        data = metadata()
        data["streams"][0]["sample_aspect_ratio"] = "10:11"
        self.assertEqual(rs.inspect(data).sar, Fraction(10, 11))

    def test_variable_duplicate_and_backward_timestamps_are_rejected(self):
        for stamp in (0, -1, 10):
            data = metadata()
            data["frames"][1]["best_effort_timestamp"] = stamp
            with self.subTest(stamp=stamp), self.assertRaisesRegex(rs.RestoreError, "Variable-frame-rate"):
                rs.inspect(data)

    def test_partial_final_frame_is_rejected(self):
        data = metadata()
        data["frames"][-1]["duration"] = 2
        with self.assertRaisesRegex(rs.RestoreError, "partial final"):
            rs.inspect(data)

    def test_hdr_high_depth_rotation_and_unsupported_matrix_are_rejected(self):
        for update in ({"pix_fmt": "yuv420p10le"}, {"color_transfer": "smpte2084"},
                       {"color_space": "bt2020nc"}, {"side_data_list": [{"rotation": -90}]}, {"tags": {"rotate": "90"}}):
            data = metadata()
            data["streams"][0].update(update)
            with self.subTest(update=update), self.assertRaises(rs.RestoreError):
                rs.inspect(data)

    def test_invalid_streams_dimensions_frame_rates_and_timestamps_are_rejected(self):
        cases = [metadata() for _ in range(8)]
        cases[0]["streams"] = []
        cases[1]["streams"].append(copy.deepcopy(cases[1]["streams"][0]))
        cases[2]["streams"][0]["width"] = 0
        cases[3]["streams"][0]["r_frame_rate"] = "0/0"
        cases[4]["streams"][0]["sample_aspect_ratio"] = "0:1"
        cases[5]["frames"] = cases[5]["frames"][:1]
        del cases[6]["frames"][0]["best_effort_timestamp"]
        cases[7]["streams"][0]["time_base"] = "-1/25"
        for i, data in enumerate(cases):
            with self.subTest(case=i), self.assertRaises(rs.RestoreError):
                rs.inspect(data)

    def test_audio_leading_video_is_clearly_rejected(self):
        data = metadata(audio=True)
        data["streams"][1]["start_time"] = "-0.2"
        with self.assertRaisesRegex(rs.RestoreError, "Audio preceding"):
            rs.inspect(data)

    def test_audio_delayed_relative_to_video_is_supported(self):
        data = metadata(audio=True)
        data["streams"][1]["start_time"] = "0.25"
        self.assertEqual(len(rs.inspect(data).audio), 1)


class ValidationTests(unittest.TestCase):
    def test_output_timing_shape_and_audio_must_be_preserved(self):
        source = rs.inspect(metadata(audio=True))
        result = copy.deepcopy(source)
        result.video.update(width=128, height=96)
        packets = [[("SHA256:abc", Fraction(0), Fraction(1024, 48000))]]
        rs.validate(source, result, packets, packets)
        variants = [replace(result, fps=Fraction(30)), replace(result, pts=result.pts[:-1]),
                    replace(result, sar=Fraction(2)), replace(result, duration=Fraction(1)),
                    replace(result, pts=[p + Fraction(1, 10) for p in result.pts])]
        bad_size = copy.deepcopy(result)
        bad_size.video["width"] = 64
        variants.append(bad_size)
        bad_audio = copy.deepcopy(result)
        bad_audio.audio[0]["sample_rate"] = "44100"
        variants.append(bad_audio)
        for altered in variants:
            with self.subTest(altered=altered.summary()), self.assertRaises(rs.RestoreError):
                rs.validate(source, altered, packets, packets)

    def test_changed_audio_bytes_packet_counts_or_sync_are_rejected(self):
        source = rs.inspect(metadata(audio=True))
        result = copy.deepcopy(source)
        result.video.update(width=128, height=96)
        packets = [[("SHA256:abc", Fraction(0), Fraction(1024, 48000))]]
        for bad in ([], [[]], [[("SHA256:bad", Fraction(0), Fraction(1024, 48000))]],
                    [[("SHA256:abc", Fraction(1, 5), Fraction(1024, 48000))]]):
            with self.subTest(packets=bad), self.assertRaises(rs.RestoreError):
                rs.validate(source, result, packets, bad)

    def test_frames_must_be_complete_and_exactly_four_times_larger(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            png_header(root / "00000000.png", 128, 96)
            png_header(root / "00000001.png", 128, 96)
            rs.check_frames(root, 2, (128, 96))
            for count, size in ((3, (128, 96)), (2, (64, 48))):
                with self.subTest(count=count, size=size), self.assertRaises(rs.RestoreError):
                    rs.check_frames(root, count, size)
            (root / "00000001.png").write_bytes(b"corrupt")
            with self.assertRaisesRegex(rs.RestoreError, "malformed PNG"):
                rs.check_frames(root, 2, (128, 96))


class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="restore tests ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "original.mp4"
        self.source.write_bytes(b"original, never overwrite")
        self.output = self.root / "restored.mp4"
        self.models = self.root / "models"
        self.models.mkdir()
        for ext in ("param", "bin"):
            (self.models / f"realesrgan-x4plus.{ext}").write_bytes(b"fake model")

    def test_original_existing_hardlink_and_symlink_destinations_are_rejected(self):
        alias = self.root / "alias.mp4"
        alias.symlink_to(self.source)
        hardlink = self.root / "hardlink.mp4"
        os.link(self.source, hardlink)
        self.output.write_bytes(b"keep me")
        for path in (self.source, alias, hardlink, self.output):
            with self.subTest(path=path), self.assertRaisesRegex(rs.RestoreError, "Refusing to overwrite"):
                rs.restore(self.source, path, models=self.models)
        self.assertEqual(self.source.read_bytes(), b"original, never overwrite")
        self.assertEqual(self.output.read_bytes(), b"keep me")

    def test_missing_dependencies_and_models_are_actionable(self):
        with patch.object(rs.shutil, "which", return_value=None), self.assertRaisesRegex(rs.RestoreError, "Missing executable"):
            rs.restore(self.source, self.output, models=self.models)
        with patch.object(rs.shutil, "which", side_effect=lambda p: p), self.assertRaisesRegex(rs.RestoreError, "Missing realesrgan"):
            rs.restore(self.source, self.output, models=None)
        self.assertFalse(self.output.exists())

    def test_bad_options_and_output_paths_are_rejected(self):
        for kwargs in ({"timeout": 0}, {"timeout": float("nan")}, {"tile": 12}, {"field_order": "guess"}):
            with self.subTest(kwargs=kwargs), self.assertRaises(rs.RestoreError):
                rs.restore(self.source, self.output, models=self.models, **kwargs)
        for output in (self.root / "no.mp3", self.root / "missing" / "out.mp4"):
            with self.subTest(path=output), self.assertRaises(rs.RestoreError):
                rs.restore(self.source, output, models=self.models)

    def test_output_race_cannot_overwrite_an_existing_file(self):
        staged = self.root / "staged"
        staged.write_bytes(b"new")
        self.output.write_bytes(b"someone else's output")
        with self.assertRaises(FileExistsError):
            rs.publish([(staged, self.output)])
        self.assertEqual(self.output.read_bytes(), b"someone else's output")

    def test_failed_report_publication_rolls_back_only_our_new_video(self):
        staged = self.root / "staged"
        staged.write_bytes(b"new")
        report = self.root / "report.json"
        report.write_bytes(b"existing report")
        with self.assertRaises(FileExistsError):
            rs.publish([(staged, self.output), (staged, report)])
        self.assertFalse(self.output.exists())
        self.assertEqual(report.read_bytes(), b"existing report")

    def test_disk_space_failure_happens_before_frame_extraction(self):
        with patch.object(rs.shutil, "which", side_effect=lambda p: p), patch.object(rs, "probe", return_value=rs.inspect(metadata())), \
             patch.object(rs, "audio_packets", return_value=[]), patch.object(rs.shutil, "disk_usage", return_value=SimpleNamespace(free=0)):
            with self.assertRaisesRegex(rs.RestoreError, "disk space"):
                rs.restore(self.source, self.output, models=self.models)
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.root.glob(".lucid-restore-*")))

    def test_upscaler_failure_cleans_staging_and_keeps_original(self):
        def fail_upscale(command, timeout):
            if "-vf" in command:
                target = Path(command[-1]).parent
                for i in range(4):
                    png_header(target / f"{i:08d}.png")
                return ""
            raise rs.RestoreError("simulated GPU failure")
        with patch.object(rs.shutil, "which", side_effect=lambda p: p), patch.object(rs, "probe", return_value=rs.inspect(metadata())), \
             patch.object(rs, "audio_packets", return_value=[]), patch.object(rs, "run", side_effect=fail_upscale), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(rs.RestoreError, "GPU failure"):
                rs.restore(self.source, self.output, models=self.models)
        self.assertFalse(self.output.exists())
        self.assertEqual(self.source.read_bytes(), b"original, never overwrite")
        self.assertFalse(list(self.root.glob(".lucid-restore-*")))

    def test_timeouts_launch_failures_and_nonzero_exit_are_handled(self):
        for error in (subprocess.TimeoutExpired("tool", 1), OSError("cannot launch")):
            with self.subTest(error=error), patch.object(rs.subprocess, "run", side_effect=error), self.assertRaises(rs.RestoreError):
                rs.run(["tool"], 1)
        with patch.object(rs.subprocess, "run", return_value=subprocess.CompletedProcess([], 7, "", "model failure")):
            with self.assertRaisesRegex(rs.RestoreError, "exit 7.*model failure"):
                rs.run(["tool"])

    def test_cli_error_is_readable_without_traceback(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(rs.main([str(self.source), str(self.source)]), 1)
        self.assertIn("Refusing to overwrite", stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "real ffmpeg and ffprobe are required")
class FFmpegIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="restore real ffmpeg ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.models = self.root / "models"
        self.models.mkdir()
        for ext in ("param", "bin"):
            (self.models / f"realesrgan-x4plus.{ext}").write_bytes(b"test placeholder")
        self.fake = self.root / "fake esrgan"
        self.fake.write_text(f"#!{sys.executable}\nimport sys, subprocess\nfrom pathlib import Path\n"
                             "a=sys.argv\nassert a[a.index('-n')+1]=='realesrgan-x4plus' and a[a.index('-s')+1]=='4'\n"
                             "src=Path(a[a.index('-i')+1]); dst=Path(a[a.index('-o')+1])\n"
                             "subprocess.run(['ffmpeg','-nostdin','-v','error','-start_number','0','-i',str(src/'%08d.png'),"
                             "'-vf','scale=iw*4:ih*4','-fps_mode','passthrough','-start_number','0',str(dst/'%08d.png')],check=True)\n")
        self.fake.chmod(0o700)

    def clip(self, *, rate="5", audio=True, sar="1/1", audio_delay=0, video_delay=0, interlaced=False):
        source = self.root / "source.mp4"
        duration = 6 / float(Fraction(rate))
        command = ["ffmpeg", "-nostdin", "-v", "error", "-copyts", "-f", "lavfi", "-i", f"testsrc2=size=32x24:rate={rate}:duration={duration:.12f}"]
        if audio:
            command += ["-itsoffset", str(audio_delay), "-f", "lavfi", "-i", f"sine=sample_rate=48000:duration={duration:.12f}"]
        vf = f"setsar={sar},setpts=PTS+{video_delay}/TB"
        if interlaced:
            vf += ",setfield=tff"
        command += ["-vf", vf, "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-fps_mode", "passthrough"]
        if interlaced:
            command += ["-flags", "+ilme+ildct", "-x264-params", "tff=1"]
        if audio:
            command += ["-c:a", "aac"]
        rs.run(command + [source], 30)
        return source

    def perform(self, **kwargs):
        source = self.clip(**kwargs)
        before = source.read_bytes()
        output, report = self.root / "result.mp4", self.root / "report.json"
        with contextlib.redirect_stderr(io.StringIO()):
            result = rs.restore(source, output, models=self.models, esrgan=str(self.fake), report=report, timeout=30)
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(result["input"]["frameCount"], result["output"]["frameCount"])
        self.assertEqual(result["input"]["fps"], result["output"]["fps"])
        self.assertEqual(result["input"]["videoDurationS"], result["output"]["videoDurationS"])
        self.assertEqual(result["input"]["sampleAspectRatio"], result["output"]["sampleAspectRatio"])
        self.assertEqual(result["output"]["width"], 128)
        self.assertEqual(result["output"]["height"], 96)
        self.assertEqual(json.loads(report.read_text()), result)
        self.assertFalse(list(self.root.glob(".lucid-restore-*")))
        return result

    def test_full_ffmpeg_flow_with_original_audio_and_fake_upscaler(self):
        self.perform()
        decoded = []
        for name in ("source.mp4", "result.mp4"):
            decoded.append(subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(self.root / name),
                                           "-map", "0:a:0", "-c:a", "pcm_s16le", "-f", "s16le", "-"],
                                          capture_output=True, check=True).stdout)
        self.assertEqual(decoded[0], decoded[1], "Decoded original audio samples changed")

    def test_fractional_frame_rate_and_nonsquare_pixels_round_trip(self):
        self.perform(rate="30000/1001", sar="10/11")

    def test_silent_source_stays_silent(self):
        self.assertEqual(self.perform(audio=False)["output"]["audio"], [])

    def test_audio_video_relative_delay_is_preserved(self):
        self.perform(audio_delay=0.2)

    def test_nonzero_video_start_is_normalized_with_audio_sync_preserved(self):
        self.perform(video_delay=0.4, audio_delay=0.6)

    def test_interlaced_source_does_not_double_the_frame_rate(self):
        self.perform(interlaced=True)

    def test_real_variable_rate_video_is_rejected_before_upscaling(self):
        source = self.clip(audio=False)
        variable, output = self.root / "variable.mp4", self.root / "out.mp4"
        rs.run(["ffmpeg", "-nostdin", "-v", "error", "-i", source, "-vf", r"setpts=if(lt(N\,3)\,PTS\,PTS+0.2/TB)",
                "-fps_mode", "vfr", "-c:v", "libx264", "-an", variable], 30)
        before = variable.read_bytes()
        with self.assertRaisesRegex(rs.RestoreError, "Variable-frame-rate"):
            rs.restore(variable, output, models=self.models, esrgan=str(self.fake), timeout=30)
        self.assertEqual(variable.read_bytes(), before)
        self.assertFalse(output.exists())
        self.assertFalse(list(self.root.glob(".lucid-restore-*")))


@unittest.skipUnless(os.environ.get("LUCID_RESTORE_REAL_TOOLS") == "1" and os.environ.get("REALESRGAN_BIN")
                     and os.environ.get("REALESRGAN_MODELS") and shutil.which("ffmpeg"),
                     "set LUCID_RESTORE_REAL_TOOLS=1, REALESRGAN_BIN and REALESRGAN_MODELS for real GPU inference")
class RealESRGANTests(unittest.TestCase):
    def test_actual_x4plus_model_produces_a_valid_video(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "source.mp4", root / "result.mp4"
            rs.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=32x24:rate=2:duration=1",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", source], 30)
            with contextlib.redirect_stderr(io.StringIO()):
                result = rs.restore(source, output, models=Path(os.environ["REALESRGAN_MODELS"]), esrgan=os.environ["REALESRGAN_BIN"])
            self.assertEqual(result["output"]["frameCount"], 2)
            self.assertEqual(result["output"]["width"], 128)
            self.assertEqual(result["output"]["height"], 96)
            pixels = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(output), "-frames:v", "1",
                                     "-vf", "format=gray", "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
            self.assertGreater(max(pixels) - min(pixels), 32, "Real-ESRGAN produced a blank/flat test frame")


if __name__ == "__main__":
    unittest.main()
