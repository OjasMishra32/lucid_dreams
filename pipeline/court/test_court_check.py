"""court-check.sbatch and court-check-submit.sh on a made-up tree (stubbed sbatch): the run folders are only read, the
results land in a new checks folder, and the submitter checks its input before submitting anything."""

import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def tree(root: Path, rid="court-main-s9"):
    """$D with the court code linked in, an empty data folder and one seed whose recon already has a p42.json."""
    (root / "code" / "pipeline").mkdir(parents=True)
    (root / "code" / "pipeline" / "court").symlink_to(HERE)
    (root / "data" / "court" / rid).mkdir(parents=True)
    rec = root / "runs" / rid / "seed1" / "recon-raw-default-r0-300k"
    rec.mkdir(parents=True)
    (rec / "p42.json").write_text("{\"mine\": true}")
    (rec / "used.json").write_text("{\"K\": 3, \"FOCAL\": 100.0}")
    (root / "env.sh").write_text("")
    return rid, rec


def files(p: Path):
    return sorted(str(x.relative_to(p)) for x in p.rglob("*"))


class Job(unittest.TestCase):
    def run_job(self, root, rid, job="5"):
        env = dict(os.environ, L=str(root), ENV_SH=str(root / "env.sh"), PY=sys.executable, TMPDIR=str(root / "tmp"),
                   ID=rid, SLURM_JOB_ID=job)
        (root / "tmp").mkdir(exist_ok=True)
        return subprocess.run(["bash", str(HERE / "court-check.sbatch")], capture_output=True, text=True, env=env)

    def test_reads_the_runs_and_writes_a_new_checks_folder(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            rid, rec = tree(root)
            before = files(root / "runs")
            p = self.run_job(root, rid)
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            self.assertEqual(files(root / "runs"), before)
            self.assertEqual((rec / "p42.json").read_text(), "{\"mine\": true}")
            out = root / "checks" / f"{rid}-5"
            for f in ("p42.txt", "stance.txt", "sheet.txt", "report.txt", "checks.tar"):
                self.assertTrue((out / f).exists(), f)
            again = self.run_job(root, rid)  # the same job id: never into an existing folder
            self.assertNotEqual(again.returncode, 0)
            self.assertIn("exists", again.stderr)

    def test_no_seed_folders(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            rid, _ = tree(root)
            (root / "runs" / rid / "seed1").rename(root / "runs" / rid / "winner")
            p = self.run_job(root, rid)
            self.assertNotEqual(p.returncode, 0)
            self.assertIn("no seed* folders", p.stderr)


class Submit(unittest.TestCase):
    def submit(self, root, *ids, **env):
        bin_ = root / "bin"
        bin_.mkdir(exist_ok=True)
        sb = bin_ / "sbatch"
        sb.write_text("#!/bin/bash\necho \"$*\" >> \"$CALLS\"\necho \"REF=$REF\" >> \"$CALLS\"\necho 4242\n")
        sb.chmod(sb.stat().st_mode | stat.S_IEXEC)
        e = dict(os.environ, L=str(root), PATH=f"{bin_}:{os.environ['PATH']}", CALLS=str(root / "calls"), **env)
        p = subprocess.run(["bash", str(HERE / "court-check-submit.sh"), *ids], capture_output=True, text=True, env=e)
        calls = (root / "calls").read_text().splitlines() if (root / "calls").exists() else []
        return p, calls

    def test_one_job_per_id_on_the_account_given(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            rid, _ = tree(root)
            p, calls = self.submit(root, rid, ACCOUNT="lab2", QOS="lab2-b", REF="0.5,0.4,0.2")
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertIn("--account=lab2 --qos=lab2-b", calls[0])
            self.assertIn(f"--export=ALL,ID={rid}", calls[0])
            self.assertTrue(calls[0].endswith("court/court-check.sbatch"))
            self.assertEqual(calls[1], "REF=0.5,0.4,0.2")
            self.assertIn(f"SUBMITTED court-check {rid} job=4242", p.stdout)

    def test_checks_before_submitting(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            rid, _ = tree(root)
            for ids, env, msg in (((rid, "court-nothere"), {}, "no "), ((rid,), {"REF": "0.5;rm"}, "REF="),
                                  ((rid,), {"QOS": "a b"}, "QOS="), (("../x",), {}, "bad run id")):
                p, calls = self.submit(root, *ids, **env)
                self.assertNotEqual(p.returncode, 0, ids)
                self.assertIn(msg, p.stderr)
                self.assertEqual(calls, [])

    def test_dry_submits_nothing_and_makes_nothing(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            rid, _ = tree(root)
            p, calls = self.submit(root, rid, DRY="1")
            self.assertEqual(p.returncode, 0, p.stderr)
            self.assertIn("DRY: sbatch", p.stdout)
            self.assertEqual(calls, [])
            self.assertFalse((root / "checks").exists())


if __name__ == "__main__":
    unittest.main()
