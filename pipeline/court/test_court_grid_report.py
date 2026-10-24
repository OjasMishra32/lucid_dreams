"""court_grid_report.py: one row per run and variant; a seed's re-run under a tag (seed1-mgpu) stands in for that
seed; the pick order."""

import io
import json
import os
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import court_grid_report as rep  # noqa: E402


def recon(run: Path, psnr: float):
    for name, extra in (("recon-raw-default-r0-300k", {"sourcePsnr": 40.0}), ("recon-metrics-raw-default-r0", {})):
        d = run / name
        d.mkdir(parents=True)
        (d / "recon-000060-000061.json").write_text(json.dumps(
            {"frames": [{"psnr": psnr, "ssim": 0.9, **extra}], "source": {"iou": 0.9, "focal": 1.0}}))


class Seeds(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.r = Path(self.tmp.name) / "court-x-s2"
        (self.r / "seed1" / "logs").mkdir(parents=True)  # cancelled: a partial log only
        (self.r / "seed1" / "logs" / "court-job-1.log").write_text("views...\n")
        recon(self.r / "seed1-mgpu", 25.0)
        recon(self.r / "seed2", 24.0)

    def tearDown(self):
        self.tmp.cleanup()

    def test_seed_numbers(self):
        self.assertEqual([rep.seed_of(Path(n)) for n in ("seed1", "seed1-mgpu", "seed12-x", "court-x-s2")],
                         [1, 1, 12, None])

    def test_a_tagged_rerun_stands_in_for_its_seed(self):
        picked = rep.pick_runs(sorted(self.r.glob("seed*")))
        self.assertEqual([p.name for p in picked], ["seed1-mgpu", "seed2"])

    def test_both_with_results_keeps_the_newer(self):
        recon(self.r / "seed1", 23.0)
        old = time.time() - 3600
        for f in (self.r / "seed1").rglob("*"):
            os.utime(f, (old, old))
        self.assertEqual([p.name for p in rep.pick_runs(sorted(self.r.glob("seed*")))], ["seed1-mgpu", "seed2"])

    def test_report_counts_each_seed_once(self):
        out = io.StringIO()
        with redirect_stdout(out):
            rep.main([str(p) for p in sorted(self.r.glob("seed*"))])
        lines = [x for x in out.getvalue().splitlines()[1:] if x.strip()]
        self.assertEqual(len(lines), 2, out.getvalue())
        self.assertTrue(lines[0].startswith("court-x-s2/seed1-mgpu"))


def freeze(run: Path, variant: str, views: float, held: dict, p42=None, stance=None):
    """A freeze recon and its metrics recon: held = {extra view name: held-out PSNR} (weight 0 in the metrics)."""
    d, m = run / f"recon-{variant}-300k", run / f"recon-metrics-{variant}"
    d.mkdir(parents=True)
    m.mkdir(parents=True)
    (d / "recon-000060-000061.json").write_text(json.dumps({"frames": [{"sourcePsnr": 40.0}], "source": {"iou": 0.9}}))
    (m / "recon-000060-000061.json").write_text(json.dumps(
        {"frames": [{"psnr": views, "ssim": 0.9, **{f"sourcePsnr.{n}": v for n, v in held.items()}}]}))
    (run / f"recon-metrics-{variant}.extra.json").write_text(json.dumps(
        [{"video": f"/x/{n}/{n}.mkv", "weight": 0} for n in held]))
    if p42 is not None:
        (d / "p42.json").write_text(json.dumps({"pass": p42, "iouFinal": 0.99 if p42 else 0.9}))
    if stance is not None:
        (d / "stance.json").write_text(json.dumps({"stance": stance, "along": stance * 0.9, "across": stance * 0.4}))


class Pick(unittest.TestCase):
    """The pick order after the eye gate: P42, then r2 if its held-out views are within 0.5 dB of the best r0/r1,
    else r0/r1 by the held-out depth view."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run = Path(self.tmp.name) / "court-x-s2" / "seed1"

    def tearDown(self):
        self.tmp.cleanup()

    def pick(self):
        rows = list(rep.rows(self.run))
        return [r["variant"] for r in rep.pick_order(rows, depth_view="D")]

    def test_r2_wins_within_half_a_db(self):
        freeze(self.run, "raw-default-r0", 26.0, {"B": 30.0, "D": 25.0}, p42=True)
        freeze(self.run, "raw-default-r1", 26.2, {"D": 27.0}, p42=True)
        freeze(self.run, "raw-default-r2", 25.8, {}, p42=True)
        self.assertEqual(self.pick(), ["raw-default-r2", "raw-default-r1", "raw-default-r0"])

    def test_r2_loses_past_half_a_db_and_the_depth_view_ranks_the_rest(self):
        freeze(self.run, "raw-default-r0", 26.0, {"B": 30.0, "D": 28.0}, p42=True)
        freeze(self.run, "raw-default-r1", 26.2, {"D": 27.0}, p42=True)
        freeze(self.run, "raw-default-r2", 25.6, {}, p42=True)
        self.assertEqual(self.pick(), ["raw-default-r0", "raw-default-r1", "raw-default-r2"])

    def test_a_p42_failure_drops_out(self):
        freeze(self.run, "raw-default-r0", 26.0, {"D": 28.0}, p42=True)
        freeze(self.run, "raw-agree-r0", 27.0, {"D": 29.0}, p42=False)
        self.assertEqual(self.pick(), ["raw-default-r0"])

    def test_the_table_shows_each_held_out_view_p42_and_stance(self):
        freeze(self.run, "raw-default-r1", 26.2, {"D": 27.0}, p42=True, stance=0.5)
        out = io.StringIO()
        with redirect_stdout(out):
            rep.main([str(self.run), "--pick", "--depth-view", "D"])
        text = out.getvalue()
        self.assertIn("D 27.00", text)
        self.assertIn("PASS 0.990", text)
        self.assertIn("0.50 (0.45/0.20)", text)
        self.assertIn("pick court-x-s2: 1. seed1 recon-raw-default-r1-300k", text)


if __name__ == "__main__":
    unittest.main()
