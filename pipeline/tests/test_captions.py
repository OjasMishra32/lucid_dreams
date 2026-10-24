"""Run from repo root: PYTHONPATH=pipeline python3 -m unittest discover -s pipeline/tests -v."""

from array import array
import contextlib
import io
import json
import math
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

from lucid import captions as cc


FIXTURE = Path(__file__).parent / "fixtures" / "silence-tone.wav"
PIPELINE = Path(__file__).resolve().parents[1]


def segment(start, end, text):
    # whisper.cpp -oj -ml 1 -sow uses integer millisecond offsets, not Python Whisper's seconds schema.
    return {"offsets": {"from": start, "to": end}, "text": text}


def pcm(duration=4000, intervals=((0, 4000),), amplitude=10000):
    samples = array("h", [0]) * (duration * 16)
    for start, end in intervals:
        for i in range(start * 16, min(end * 16, len(samples))):
            samples[i] = round(amplitude * math.sin(2 * math.pi * 440 * i / 16000))
    return samples


def write_wav(path, samples, rate=16000, channels=1, width=2):
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(width)
        wav.setframerate(rate)
        data = array("h", samples)
        if sys.byteorder != "little":
            data.byteswap()
        wav.writeframes(data.tobytes())


class CleaningTests(unittest.TestCase):
    def words(self, entries, samples=None, duration=4000, silence_db=-50):
        return cc.words_from_json({"transcription": entries}, samples if samples is not None else pcm(), duration, silence_db)

    def test_millisecond_offsets_and_unicode_are_preserved(self):
        self.assertEqual(self.words([segment(1230, 1740, "  Héllo 世界  ")]), [cc.Cue(1230, 1740, "Héllo 世界")])

    def test_tags_music_symbols_and_split_annotations_are_removed(self):
        entries = [segment(0, 200, "[Music]"), segment(200, 400, "(soft"), segment(400, 600, " music)"),
                   segment(600, 800, "♪♫"), segment(800, 1300, " Hello"), segment(1300, 1500, "(laughs)")]
        self.assertEqual(self.words(entries), [cc.Cue(800, 1300, "Hello")])

    def test_unclosed_annotation_is_an_error(self):
        with self.assertRaisesRegex(cc.CaptionError, "unfinished"):
            self.words([segment(0, 500, "[Music")])

    def test_spoken_parenthetical_text_is_not_treated_as_a_noise_tag(self):
        self.assertEqual(self.words([segment(1000, 1500, "(I think)")]), [cc.Cue(1000, 1500, "(I think)")])

    def test_silence_hallucination_removed_without_moving_real_speech(self):
        samples = pcm(intervals=((1200, 2000),))
        entries = [segment(0, 500, "Thank you."), segment(1250, 1900, "Hello"), segment(3000, 3500, "Thank you.")]
        self.assertEqual(self.words(entries, samples), [cc.Cue(1250, 1900, "Hello")])

    def test_quiet_speech_threshold_is_configurable(self):
        entries = [segment(1000, 1500, "quiet")]
        samples = pcm(amplitude=40)
        self.assertEqual(self.words(entries, samples), [])
        self.assertEqual(self.words(entries, samples, silence_db=-70), [cc.Cue(1000, 1500, "quiet")])

    def test_silent_word_does_not_borrow_energy_from_adjacent_speech(self):
        entries = [segment(1000, 1200, "Hello"), segment(1200, 1210, "Thanks")]
        self.assertEqual(self.words(entries, pcm(intervals=((1000, 1200),))), [cc.Cue(1000, 1200, "Hello")])

    def test_punctuation_joins_previous_word_without_a_space(self):
        entries = [segment(1000, 1300, "Hello"), segment(1300, 1400, ","), segment(1400, 1700, "world"), segment(1700, 1800, ".")]
        self.assertEqual(self.words(entries), [cc.Cue(1000, 1400, "Hello,"), cc.Cue(1400, 1800, "world.")])

    def test_zero_duration_word_keeps_its_timestamp(self):
        self.assertEqual(self.words([segment(1000, 1000, "Hello")]), [cc.Cue(1000, 1000, "Hello")])

    def test_words_are_clipped_to_bundle_playback_window(self):
        self.assertEqual(self.words([segment(2000, 2500, "end"), segment(2500, 2700, "outside")], duration=2300),
                         [cc.Cue(2000, 2300, "end")])

    def test_bad_transcript_shapes_are_errors(self):
        for data in ({}, {"transcription": None}, {"transcription": {}}, {"transcription": [None]},
                     {"transcription": [{"text": 4}]}):
            with self.subTest(data=data), self.assertRaises(cc.CaptionError):
                cc.words_from_json(data, pcm(), 4000, -50)

    def test_invalid_offsets_are_errors_not_retimed_words(self):
        for entry in ({"text": "Hello"}, {"text": "Hello", "offsets": []}, segment(-1, 2, "Hello"),
                      segment(1000, 900, "Hello"), segment(0.5, 1000, "Hello"), segment(True, 1000, "Hello"),
                      segment(0, float("nan"), "Hello")):
            with self.subTest(entry=entry), self.assertRaises(cc.CaptionError):
                self.words([entry])
        with self.assertRaisesRegex(cc.CaptionError, "unordered"):
            self.words([segment(1000, 1300, "first"), segment(900, 1400, "second")])

    def test_empty_and_silent_transcripts_are_valid(self):
        self.assertEqual(self.words([]), [])
        self.assertEqual(self.words([segment(0, 2000, "Thank you.")], pcm(intervals=())), [])


class CueTests(unittest.TestCase):
    def assert_valid(self, cues, duration):
        previous = 0
        for cue in cues:
            self.assertGreaterEqual(cue.start, previous)
            self.assertGreaterEqual(cue.end - cue.start, 1000)
            self.assertLessEqual(cue.end - cue.start, 6000)
            self.assertLessEqual(cue.end, duration)
            self.assertLessEqual(len(cue.text.splitlines()), 2)
            self.assertTrue(all(len(line) <= 42 for line in cue.text.splitlines()))
            previous = cue.end

    def test_leading_silence_is_preserved_and_minimum_hold_does_not_move_start(self):
        cues = cc.make_cues([cc.Cue(1230, 1500, "Hello.")], 4000)
        self.assertEqual(cues, [cc.Cue(1230, 2230, "Hello.")])

    def test_wraps_at_42_characters_and_keeps_all_words(self):
        words = [cc.Cue(i * 220, (i + 1) * 220, f"word{i:02}") for i in range(30)]
        cues = cc.make_cues(words, 7500)
        self.assert_valid(cues, 7500)
        self.assertEqual(" ".join(c.text.replace("\n", " ") for c in cues), " ".join(w.text for w in words))

    def test_long_speech_splits_at_real_word_boundaries(self):
        words = [cc.Cue(i * 1000, (i + 1) * 1000, "word") for i in range(15)]
        cues = cc.make_cues(words, 15000)
        self.assert_valid(cues, 15000)
        self.assertGreaterEqual(len(cues), 3)
        self.assertTrue(all(c.start in {w.start for w in words} for c in cues))

    def test_short_final_word_can_merge_into_previous_cue(self):
        cues = cc.make_cues([cc.Cue(0, 900, "Hello"), cc.Cue(900, 1200, "there.")], 1200)
        self.assertEqual(cues, [cc.Cue(0, 1200, "Hello there.")])

    def test_gaps_remain_gaps_and_short_cue_does_not_overlap_next(self):
        cues = cc.make_cues([cc.Cue(0, 200, "One"), cc.Cue(2000, 2300, "Two")], 4000)
        self.assertEqual(cues, [cc.Cue(0, 1000, "One"), cc.Cue(2000, 3000, "Two")])

    def test_overlapping_word_estimates_are_kept_in_one_cue(self):
        cues = cc.make_cues([cc.Cue(1000, 1600, "One"), cc.Cue(1500, 1800, "two")], 3000)
        self.assertEqual(cues, [cc.Cue(1000, 2000, "One two")])

    def test_impossible_limits_fail_instead_of_dropping_or_retiming_speech(self):
        for words, duration in (([cc.Cue(0, 500, "short")], 500), ([cc.Cue(0, 6500, "long")], 7000),
                                ([cc.Cue(0, 1500, "x" * 85)], 2000)):
            with self.subTest(words=words), self.assertRaisesRegex(cc.CaptionError, "Cannot fit"):
                cc.make_cues(words, duration)

    def test_seeded_timelines_preserve_words_and_invariants(self):
        rng = random.Random(7)
        for trial in range(40):
            clock, words = rng.randrange(0, 1500), []
            for i in range(rng.randrange(1, 60)):
                end = clock + rng.randrange(100, 450)
                words.append(cc.Cue(clock, end, f"word{i}"))
                clock = end + rng.randrange(0, 120)
            duration = clock + 1500
            cues = cc.make_cues(words, duration)
            with self.subTest(trial=trial):
                self.assert_valid(cues, duration)
                self.assertEqual(" ".join(c.text.replace("\n", " ") for c in cues), " ".join(w.text for w in words))

    def test_vtt_milliseconds_hours_unicode_and_escaping(self):
        vtt = cc.webvtt([cc.Cue(3601234, 3602345, "Héllo <b> & goodbye\n世界 --> yes")])
        self.assertIn("01:00:01.234 --> 01:00:02.345", vtt)
        self.assertIn("Héllo &lt;b&gt; &amp; goodbye\n世界 --&gt; yes", vtt)
        self.assertTrue(vtt.startswith("WEBVTT\n\n1\n"))
        self.assertEqual(cc.webvtt([]), "WEBVTT\n\n")

    def test_complete_sentences_get_separate_cues_when_they_fit(self):
        text = "Hello there. This feels natural."
        words = [cc.Cue(i * 500, (i + 1) * 500, word) for i, word in enumerate(text.split())]
        self.assertEqual(cc.make_cues(words, 2500), [cc.Cue(0, 1000, "Hello there."), cc.Cue(1000, 2500, "This feels natural.")])

    def test_long_sentence_splits_before_a_clause_instead_of_filling_six_seconds(self):
        text = "Keep your shoulders relaxed and slowly raise both hands."
        words = [cc.Cue(i * 800, (i + 1) * 800, word) for i, word in enumerate(text.split())]
        cues = cc.make_cues(words, 7200)
        self.assertEqual(cues, [cc.Cue(0, 3200, "Keep your shoulders relaxed"), cc.Cue(3200, 7200, "and slowly raise both hands.")])
        self.assert_valid(cues, 7200)

    def test_comma_clause_is_a_natural_boundary(self):
        text = "First check the framing, then start the recording."
        words = [cc.Cue(i * 400, (i + 1) * 400, word) for i, word in enumerate(text.split())]
        cues = cc.make_cues(words, 3600)
        self.assertEqual([c.text for c in cues], ["First check the framing,", "then start the recording."])
        self.assert_valid(cues, 3600)

    def test_audible_pause_can_separate_phrases_without_punctuation(self):
        words = [cc.Cue(0, 500, "First"), cc.Cue(500, 1000, "rest"), cc.Cue(1000, 1500, "now"),
                 cc.Cue(1900, 2650, "move"), cc.Cue(2650, 3400, "slowly")]
        self.assertEqual(cc.make_cues(words, 3400), [cc.Cue(0, 1500, "First rest now"), cc.Cue(1900, 3400, "move slowly")])

    def test_phrase_split_does_not_strand_function_words_or_lose_text(self):
        text = "I love this lesson because my teacher says we are gonna practice today."
        words = [cc.Cue(i * 500 + 230, (i + 1) * 500 + 230, word) for i, word in enumerate(text.split())]
        original = list(words)
        duration = words[-1].end
        cues = cc.make_cues(words, duration)
        self.assertEqual([c.text.replace("\n", " ") for c in cues],
                         ["I love this lesson", "because my teacher says we are gonna practice today."])
        self.assertEqual(" ".join(c.text.replace("\n", " ") for c in cues), text)
        self.assertEqual(words, original)
        self.assertTrue(all(c.start in {w.start for w in words} for c in cues))
        self.assert_valid(cues, duration)

    def test_abbreviations_and_initials_do_not_end_a_sentence(self):
        for prefix in ("Dr.", "Mr.", "A.", "U.S."):
            text = f"{prefix} Smith is here. Please begin."
            words = [cc.Cue(i * 500, (i + 1) * 500, word) for i, word in enumerate(text.split())]
            with self.subTest(prefix=prefix):
                cues = cc.make_cues(words, 3000)
                self.assertEqual([c.text for c in cues], [f"{prefix} Smith is here.", "Please begin."])

    def test_two_line_caption_breaks_at_a_phrase_boundary(self):
        self.assertEqual(cc.wrap("Keep your feet on the floor and slowly raise both hands"),
                         "Keep your feet on the floor\nand slowly raise both hands")

    def test_short_sentences_may_merge_to_preserve_minimum_duration(self):
        words = [cc.Cue(0, 200, "Hi."), cc.Cue(200, 500, "Go.")]
        self.assertEqual(cc.make_cues(words, 1000), [cc.Cue(0, 1000, "Hi. Go.")])

    def test_quoted_sentence_end_is_recognized(self):
        words = [cc.Cue(0, 1000, "Stop!”"), cc.Cue(1000, 2000, "Now"), cc.Cue(2000, 3000, "continue.")]
        self.assertEqual(cc.make_cues(words, 3000), [cc.Cue(0, 1000, "Stop!”"), cc.Cue(1000, 3000, "Now continue.")])

    def test_sentence_preference_cannot_override_overlapping_word_timestamps(self):
        words = [cc.Cue(0, 1600, "Hello."), cc.Cue(1500, 2000, "Continue.")]
        self.assertEqual(cc.make_cues(words, 3000), [cc.Cue(0, 2000, "Hello. Continue.")])


class AudioTests(unittest.TestCase):
    def test_tiny_fixture_has_silence_and_a_known_tone(self):
        samples = cc.read_pcm(FIXTURE)
        self.assertEqual(len(samples), 1600)
        self.assertEqual(cc.rms_db(samples, 0, 25), -math.inf)
        self.assertAlmostEqual(cc.rms_db(samples, 25, 75), -13.32, places=1)
        self.assertEqual(cc.rms_db(samples, 75, 100), -math.inf)

    def test_invalid_empty_and_truncated_wav_are_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "audio.wav"
            for rate, channels, width in ((8000, 1, 2), (16000, 2, 2), (16000, 1, 1)):
                write_wav(path, pcm(100), rate, channels, width)
                with self.subTest(rate=rate, channels=channels, width=width), self.assertRaises(cc.CaptionError):
                    cc.read_pcm(path)
            write_wav(path, array("h"))
            with self.assertRaisesRegex(cc.CaptionError, "empty"):
                cc.read_pcm(path)
            path.write_bytes(b"not a WAV")
            with self.assertRaises(cc.CaptionError):
                cc.read_pcm(path)
            path.write_bytes(FIXTURE.read_bytes()[:-100])
            with self.assertRaisesRegex(cc.CaptionError, "truncated"):
                cc.read_pcm(path)


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="caption test ")
        self.addCleanup(self.temp.cleanup)
        self.bundle = Path(self.temp.name).resolve()
        self.manifest = self.bundle / "dream.json"
        self.dream = {"id": "speech", "kind": "replay", "durationS": 4, "audio": "audio.m4a", "startS": 17,
                      "frames": {"dir": "frames", "spz": "%06d.spz"}, "metrics": {"psnr": 32.5},
                      "experience": "experience.json", "custom": {"keep": [1, "hello"]}}
        self.manifest.write_text(json.dumps(self.dream), encoding="utf-8")
        self.original = self.manifest.read_bytes()
        self.audio = self.bundle / "audio.m4a"
        self.audio.write_bytes(b"private audio placeholder; decoder is mocked")
        self.model = self.bundle / "model.bin"
        self.model.write_bytes(b"mock model")
        self.output = self.bundle / "captions.vtt"

    def fake_run(self, command, **kwargs):
        if command[0].endswith("ffmpeg"):
            write_wav(Path(command[-1]), pcm(intervals=((1200, 2200),)))
        else:
            prefix = Path(command[command.index("-of") + 1])
            prefix.with_suffix(".json").write_text(json.dumps({"transcription": [
                segment(0, 500, "Thank you."), segment(1250, 1650, "Hello"), segment(1650, 2100, "world.")]}))
        return subprocess.CompletedProcess(command, 0, "", "")

    def generate(self, **kwargs):
        with patch.object(cc.shutil, "which", side_effect=lambda name: "/tools/" + name), \
             patch.object(cc.subprocess, "run", side_effect=self.fake_run) as run:
            count = cc.generate(self.bundle, self.model, **kwargs)
        return count, run

    def test_prefers_voice_and_falls_back_to_audio(self):
        self.assertEqual(cc.audio_path(self.bundle, self.dream), self.audio)
        voice = self.bundle / "voice.m4a"
        voice.write_bytes(b"voice")
        self.assertEqual(cc.audio_path(self.bundle, self.dream), voice)
        alternate = self.bundle / "separated.m4a"
        alternate.write_bytes(b"voice")
        self.assertEqual(cc.audio_path(self.bundle, {"voice": alternate.name}), alternate)

    def test_missing_audio_and_escaping_paths_are_errors(self):
        self.audio.unlink()
        with self.assertRaisesRegex(cc.CaptionError, "No voice or audio"):
            cc.audio_path(self.bundle, self.dream)
        for value in ("../outside.m4a", str(self.bundle / "absolute.m4a"), ["wrong type"]):
            with self.subTest(value=value), self.assertRaises(cc.CaptionError):
                cc.audio_path(self.bundle, {"voice": value})

    def test_complete_flow_preserves_metadata_and_bundle_clock(self):
        count, run = self.generate()
        self.assertEqual(count, 1)
        self.assertIn("00:00:01.250 --> 00:00:02.250", self.output.read_text())
        self.assertIn("Hello world.", self.output.read_text())
        self.assertNotIn("Thank you", self.output.read_text())
        self.assertEqual(json.loads(self.manifest.read_text()), {**self.dream, "captions": "captions.vtt"})
        ffmpeg_command, whisper_command = [c.args[0] for c in run.call_args_list]
        self.assertNotIn("-ss", ffmpeg_command)
        self.assertIn("aresample=16000:async=1:first_pts=0", ffmpeg_command)
        self.assertEqual(ffmpeg_command[ffmpeg_command.index("-ar") + 1], "16000")
        self.assertEqual(ffmpeg_command[ffmpeg_command.index("-ac") + 1], "1")
        self.assertEqual(ffmpeg_command[ffmpeg_command.index("-c:a") + 1], "pcm_s16le")
        self.assertEqual(whisper_command[whisper_command.index("-ml") + 1], "1")
        self.assertIn("-sow", whisper_command)
        self.assertIn("-oj", whisper_command)
        self.assertNotIn("-tr", whisper_command)
        self.assertEqual(sorted(p.name for p in self.bundle.iterdir()), ["audio.m4a", "captions.vtt", "dream.json", "model.bin"])

    def test_missing_model_and_dependencies_do_not_touch_outputs(self):
        self.output.write_text("existing captions")
        with self.assertRaisesRegex(cc.CaptionError, "model not found"):
            cc.generate(self.bundle, self.bundle / "absent.bin")
        for missing in ("ffmpeg", "whisper-cli"):
            with self.subTest(missing=missing), patch.object(cc.shutil, "which", side_effect=lambda name: None if name == missing else name):
                with self.assertRaisesRegex(cc.CaptionError, "Missing executable"):
                    cc.generate(self.bundle, self.model)
        self.assertEqual(self.output.read_text(), "existing captions")
        self.assertEqual(self.manifest.read_bytes(), self.original)

    def test_invalid_options_and_duration_are_errors(self):
        for kwargs in ({"timeout": 0}, {"timeout": float("inf")}, {"silence_db": 1}, {"silence_db": float("nan")}):
            with self.subTest(kwargs=kwargs), self.assertRaises(cc.CaptionError):
                self.generate(**kwargs)
        for duration in (None, "4", 0, -1, float("nan"), True):
            self.manifest.write_text(json.dumps({**self.dream, "durationS": duration}))
            with self.subTest(duration=duration), self.assertRaisesRegex(cc.CaptionError, "durationS"):
                self.generate()
        self.assertFalse(self.output.exists())

    def test_transcription_failures_preserve_existing_files(self):
        self.output.write_text("existing captions")
        def failing(command, **kwargs):
            if command[0].endswith("ffmpeg"):
                return self.fake_run(command, **kwargs)
            return subprocess.CompletedProcess(command, 7, "", "model could not be loaded")
        with patch.object(cc.shutil, "which", side_effect=lambda name: name), patch.object(cc.subprocess, "run", side_effect=failing):
            with self.assertRaisesRegex(cc.CaptionError, "exit 7.*model could not"):
                cc.generate(self.bundle, self.model)
        self.assertEqual(self.output.read_text(), "existing captions")
        self.assertEqual(self.manifest.read_bytes(), self.original)

    def test_decoder_failure_preserves_existing_files(self):
        self.output.write_text("existing captions")
        with patch.object(cc.shutil, "which", side_effect=lambda name: name), \
             patch.object(cc.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "corrupt audio")):
            with self.assertRaisesRegex(cc.CaptionError, "corrupt audio"):
                cc.generate(self.bundle, self.model)
        self.assertEqual(self.output.read_text(), "existing captions")
        self.assertEqual(self.manifest.read_bytes(), self.original)

    def test_malformed_manifest_has_a_readable_error(self):
        for content in ("{", "[]"):
            self.manifest.write_text(content)
            stderr = io.StringIO()
            with self.subTest(content=content), contextlib.redirect_stderr(stderr):
                self.assertEqual(cc.main([str(self.bundle)]), 1)
            self.assertIn("JSON", stderr.getvalue())
            self.assertNotIn("Traceback", stderr.getvalue())

    def test_missing_or_malformed_transcription_does_not_publish(self):
        for content in (None, "{invalid", "[]", "{}", '{"transcription":[{"text":"hi"}]}'):
            def tool(command, **kwargs):
                if command[0].endswith("ffmpeg"):
                    return self.fake_run(command, **kwargs)
                if content is not None:
                    Path(command[command.index("-of") + 1]).with_suffix(".json").write_text(content)
                return subprocess.CompletedProcess(command, 0, "", "")
            with self.subTest(content=content), patch.object(cc.shutil, "which", side_effect=lambda name: name), \
                 patch.object(cc.subprocess, "run", side_effect=tool):
                with self.assertRaises(cc.CaptionError):
                    cc.generate(self.bundle, self.model)
            self.assertFalse(self.output.exists())
            self.assertEqual(self.manifest.read_bytes(), self.original)

    def test_publish_rejects_changed_manifest_and_symlinks(self):
        self.manifest.write_text(json.dumps({**self.dream, "guide": "guide.json"}))
        with self.assertRaisesRegex(cc.CaptionError, "changed during"):
            cc.publish(self.bundle, self.original, "WEBVTT\n\n")
        self.assertFalse(self.output.exists())
        self.manifest.write_bytes(self.original)
        self.output.symlink_to(self.audio)
        with self.assertRaisesRegex(cc.CaptionError, "symlink"):
            cc.publish(self.bundle, self.original, "WEBVTT\n\n")
        self.assertEqual(self.audio.read_bytes(), b"private audio placeholder; decoder is mocked")

    def test_manifest_write_failure_rolls_back_captions(self):
        real_replace = os.replace
        def fail_manifest(source, destination):
            if destination == self.manifest:
                raise OSError("simulated disk failure")
            return real_replace(source, destination)
        for existing in (False, True):
            if existing:
                self.output.write_text("previous captions")
            with self.subTest(existing=existing), patch.object(cc.os, "replace", side_effect=fail_manifest):
                with self.assertRaisesRegex(OSError, "disk failure"):
                    cc.publish(self.bundle, self.original, "WEBVTT\n\n")
            self.assertEqual(self.manifest.read_bytes(), self.original)
            self.assertEqual(self.output.read_text() if existing else self.output.exists(), "previous captions" if existing else False)
            self.assertFalse(list(self.bundle.glob(".captions-*")))

    def test_empty_transcript_writes_valid_empty_vtt(self):
        with patch.object(cc, "words_from_json", return_value=[]):
            count, _ = self.generate()
        self.assertEqual(count, 0)
        self.assertEqual(self.output.read_text(), "WEBVTT\n\n")

    def test_cli_exit_status_and_readable_error(self):
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), patch.dict(os.environ, {}, clear=True):
            result = cc.main([str(self.bundle)])
        self.assertEqual(result, 1)
        self.assertIn("--model", stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())

    def test_cli_accepts_model_environment_without_running_tools_implicitly_in_tests(self):
        stdout = io.StringIO()
        with patch.dict(os.environ, {"WHISPER_MODEL": str(self.model)}), patch.object(cc, "generate", return_value=2) as generate, \
             contextlib.redirect_stdout(stdout):
            self.assertEqual(cc.main([str(self.bundle)]), 0)
        self.assertEqual(generate.call_args.args, (self.bundle, self.model))
        self.assertIn("Wrote 2 cues", stdout.getvalue())


class CommandTests(unittest.TestCase):
    def test_timeout_launch_error_and_decoder_failure_are_actionable(self):
        failures = (subprocess.TimeoutExpired("ffmpeg", 1), FileNotFoundError("missing"),
                    subprocess.CompletedProcess(["ffmpeg"], 2, "", "invalid media"))
        for failure in failures:
            kwargs = {"side_effect": failure} if isinstance(failure, Exception) else {"return_value": failure}
            with self.subTest(failure=failure), patch.object(cc.subprocess, "run", **kwargs):
                with self.assertRaises(cc.CaptionError):
                    cc.run_tool(["ffmpeg"], 1)

    def test_real_cli_process_with_fake_external_tools_and_spaced_paths(self):
        # Tests real argv transport, temp files, JSON parsing and publication; NOT speech recognition or ffmpeg.
        with tempfile.TemporaryDirectory(prefix="caption CLI ") as directory:
            root = Path(directory)
            bundle = root / "dream ü with spaces"
            bundle.mkdir()
            (bundle / "dream.json").write_text(json.dumps({"id": "cli", "durationS": 3, "audio": "audio.m4a"}))
            (bundle / "audio.m4a").write_bytes(b"fake media")
            model = root / "fake model.bin"
            model.write_bytes(b"fake model")
            decoder, whisper = root / "fake ffmpeg", root / "fake whisper"
            decoder.write_text(f"#!{sys.executable}\nimport sys, wave\nfrom array import array\n"
                               "with wave.open(sys.argv[-1], 'wb') as w:\n"
                               " w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)\n"
                               " w.writeframes((array('h', [0])*12000 + array('h', [10000])*12000 + array('h', [0])*24000).tobytes())\n")
            whisper.write_text(f"#!{sys.executable}\nimport sys, json\nfrom pathlib import Path\n"
                               "assert sys.argv[sys.argv.index('-ml')+1] == '1'\n"
                               "p = Path(sys.argv[sys.argv.index('-of')+1]).with_suffix('.json')\n"
                               "p.write_text(json.dumps({'transcription':[{'text':'Hello.', 'offsets':{'from':750,'to':1500}}]}))\n")
            decoder.chmod(0o700)
            whisper.chmod(0o700)
            env = {**os.environ, "PYTHONPATH": str(PIPELINE)}
            result = subprocess.run([sys.executable, "-m", "lucid.captions", str(bundle), "--model", str(model),
                                     "--ffmpeg", str(decoder), "--whisper", str(whisper)],
                                    capture_output=True, text=True, env=env, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Wrote 1 cues", result.stdout)
            self.assertIn("00:00:00.750 --> 00:00:01.750", (bundle / "captions.vtt").read_text())
            self.assertEqual(json.loads((bundle / "dream.json").read_text())["captions"], "captions.vtt")


class ExternalToolTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is not installed; real AAC decoding/synchronization unverified")
    def test_real_ffmpeg_preserves_leading_silence_and_aac_timing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, encoded, decoded = root / "source.wav", root / "audio.m4a", root / "decoded.wav"
            write_wav(source, pcm(3000, intervals=((1000, 1800),)))
            cc.run_tool(["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(source), "-c:a", "aac", str(encoded)], 30)
            cc.run_tool(["ffmpeg", "-nostdin", "-y", "-v", "error", "-i", str(encoded), "-map", "0:a:0", "-vn",
                         "-af", "aresample=16000:async=1:first_pts=0", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(decoded)], 30)
            samples = cc.read_pcm(decoded)
            self.assertLess(cc.rms_db(samples, 0, 900), -50)
            active = [t for t in range(0, len(samples) // 16 - 20, 20) if cc.rms_db(samples, t, t + 20) > -40]
            self.assertAlmostEqual(active[0], 1000, delta=40)
            self.assertAlmostEqual(active[-1] + 20, 1800, delta=40)
            self.assertAlmostEqual(len(samples) / 16000, 3, delta=0.1)

    @unittest.skipUnless(os.environ.get("LUCID_CAPTIONS_REAL_TOOLS") == "1" and shutil.which("ffmpeg")
                         and shutil.which("whisper-cli") and os.environ.get("WHISPER_MODEL"),
                         "set LUCID_CAPTIONS_REAL_TOOLS=1 and WHISPER_MODEL with ffmpeg/whisper-cli installed")
    def test_real_whisper_silence_does_not_publish_hallucinations(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory)
            (bundle / "dream.json").write_text(json.dumps({"id": "silent", "durationS": 3, "audio": "audio.wav"}))
            write_wav(bundle / "audio.wav", pcm(3000, intervals=()))
            count = cc.generate(bundle, Path(os.environ["WHISPER_MODEL"]))
            self.assertEqual(count, 0)
            self.assertEqual((bundle / "captions.vtt").read_text(), "WEBVTT\n\n")


if __name__ == "__main__":
    unittest.main()
