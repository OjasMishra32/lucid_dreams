"""Accessibility presets stay separate from transcript text and timing."""

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from lucid import caption_accessibility as ca
from lucid.captions import Cue, make_cues


class AccessibilityTests(unittest.TestCase):
    def test_standard_preserves_existing_caption_limits(self):
        contract = ca.resolve()
        self.assertEqual(contract["preset"], "standard")
        self.assertEqual(ca.cue_limits(contract), {"max_lines": 2, "max_chars": 42, "min_ms": 1000, "max_ms": 6000})

    def test_presets_are_safe_and_distinct(self):
        reading = ca.resolve("reading-friendly")
        low = ca.resolve("low-vision")
        focus = ca.resolve("focus")
        self.assertGreater(reading["presentation"]["letterSpacingEm"], 0)
        self.assertGreater(low["presentation"]["fontScale"], 1)
        self.assertEqual(focus["cueLimits"]["maxLines"], 1)
        self.assertTrue(focus["cueLimits"]["oneGroupAtATime"])

    def test_custom_validation_rejects_unsafe_values(self):
        for override in ({"presentation": {"foreground": "blue"}}, {"presentation": {"fontScale": 9}},
                         {"cueLimits": {"maxLines": 3}}, {"cueLimits": {"minDurationS": 5, "maxDurationS": 1}},
                         {"unknown": 1}):
            with self.subTest(override=override), self.assertRaises(ca.AccessibilityError):
                ca.resolve("custom", override)

    def test_focus_grouping_preserves_every_word_and_never_starts_early(self):
        words = [Cue(1000, 1200, "Please"), Cue(1250, 1450, "watch"), Cue(1500, 1700, "this"),
                 Cue(1750, 1950, "carefully."), Cue(2500, 2700, "Now"), Cue(2750, 3000, "try.")]
        limits = ca.cue_limits(ca.resolve("focus"))
        cues = make_cues(words, 4000, **limits)
        self.assertEqual(" ".join(c.text.replace("\n", " ") for c in cues), "Please watch this carefully. Now try.")
        self.assertEqual(cues[0].start, words[0].start)
        self.assertTrue(all(c.end >= c.start for c in cues))
        self.assertTrue(all(a.end <= b.start for a, b in zip(cues, cues[1:])))

    def test_sidecar_round_trip_and_cli_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "caption-accessibility.json"
            contract = ca.resolve("low-vision")
            target.write_text(json.dumps(contract))
            self.assertEqual(ca.read(target)["preset"], "low-vision")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                self.assertEqual(ca.main(["--preset", "focus", "--out", str(target)]), 2)
            self.assertIn("Refusing to overwrite", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
