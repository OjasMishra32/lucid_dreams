"""court_grid_report.py: one row per run and variant; a seed's re-run under a tag (seed1-mgpu) stands in for that seed."""

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


if __name__ == "__main__":
    unittest.main()
