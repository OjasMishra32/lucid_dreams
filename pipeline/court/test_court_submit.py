"""court-submit.sh through court-dryrun.sh (stubbed sbatch and blue_quota; nothing leaves this machine). Run from the
repo root: python3 -I -m unittest discover -s pipeline/court -p 'test_*.py' -v"""

import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def make_run(root: Path, rid: str, k: int = 118, focal: float = 1234.5, skip=(), **job_over) -> Path:
    d = root / rid
    (d / "masks").mkdir(parents=True)
    (d / "ignore").mkdir()
    files = {"input.mp4": b"x" * 100, "source-4k.mkv": b"x" * 100, f"masks/{k:06d}.png": b"png",
             f"ignore/{k:06d}.png": b"png"}
    for name, data in files.items():
        if name not in skip:
            (d / name).write_bytes(data)
    job = {"id": rid, "name": "Court Side", "kind": "replay", "turbo": False, "fps": 25, "frames": 121, "intent": "",
           "sourceMasks": "masks", "sourceIgnore": "ignore", "sourceFocal": focal, **job_over}
    (d / "job.json").write_text(json.dumps(job))
    (d / "court-run.json").write_text(json.dumps({"id": rid, "K": k, "FOCAL": focal}))
    return d


def dryrun(folder: Path, *args, **env) -> tuple[int, str]:
    p = subprocess.run(["bash", str(HERE / "court-dryrun.sh"), str(folder), *args], capture_output=True, text=True,
                       env={**os.environ, **env})
    return p.returncode, p.stdout + p.stderr


def calls(out: str) -> list[str]:
    return [x for x in out.split("--- exit")[1].splitlines()[1:] if re.match(r"^\d{4} ", x)]


class Submit(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_full_chain(self):
        rc, out = dryrun(make_run(self.root, "court-main-s2"))
        self.assertEqual(rc, 0, out)
        c = calls(out)
        self.assertEqual(len(c), 10, out)  # views, 3 x (freeze, export), metrics, 2 cleans
        self.assertTrue(c[0].endswith("pipeline/hpg/stage-views.sbatch"))
        freezes = [x for x in c if x.endswith("court-freeze.sbatch")]
        self.assertEqual(len(freezes), 4)
        self.assertTrue(all("K=118,FOCAL=1234.5" in x and "--dependency=afterok:1001 " in x for x in freezes))
        self.assertIn("OUT=recon-metrics,HOLDOUT=8", freezes[-1])
        exports = [x for x in c if x.endswith("court-export.sbatch")]
        self.assertEqual([re.search(r"afterok:(\d+)", x).group(1) for x in exports], ["1002", "1004", "1006"])
        self.assertIn("--dependency=afterok:1002:1004:1006:1008 ", c[8])
        self.assertIn("WHAT=views", c[8])
        self.assertIn("--dependency=afterok:1003:1005:1007:1008 ", c[9])
        self.assertIn("SUBMITTED court-main-s2 K=118 FOCAL=1234.5", out)

    def test_views_only(self):
        rc, out = dryrun(make_run(self.root, "court-turbo-main-s1", k=117, skip=("source-4k.mkv",)), VIEWS_ONLY="1")
        self.assertEqual(rc, 0, out)
        self.assertEqual(len(calls(out)), 1)

    def test_missing_ignore_submits_nothing(self):
        rc, out = dryrun(make_run(self.root, "court-def-s1", k=117, skip=("ignore/000117.png",)))
        self.assertNotEqual(rc, 0)
        self.assertIn("PREFLIGHT FAIL: missing", out)
        self.assertEqual(calls(out), [])

    def test_ids_must_agree(self):
        rc, out = dryrun(make_run(self.root, "court-def-s2", id="court-main-s2"))
        self.assertNotEqual(rc, 0)
        self.assertIn("job id court-main-s2", out)
        self.assertEqual(calls(out), [])

    def test_focal_must_agree(self):
        rc, out = dryrun(make_run(self.root, "court-def-s2", sourceFocal=999.0))
        self.assertNotEqual(rc, 0)
        self.assertIn("sourceFocal", out)

    def test_short_quota_submits_nothing(self):
        rc, out = dryrun(make_run(self.root, "court-main-s2"), FREE_T="0.01")
        self.assertNotEqual(rc, 0)
        self.assertIn("group quota has 10 GB free", out)
        self.assertEqual(calls(out), [])

    def test_bad_id(self):
        rc, out = dryrun(make_run(self.root, "Court-Main"))
        self.assertNotEqual(rc, 0)
        self.assertIn("PREFLIGHT FAIL: id", out)

    def test_source_agree_is_refused(self):
        rc, out = dryrun(make_run(self.root, "court-main-s2"), EXTRA="--source-agree")
        self.assertNotEqual(rc, 0)
        self.assertIn("court-ab.sh", out)
        self.assertEqual(calls(out), [])

    def test_only_the_id_is_taken(self):
        rc, out = dryrun(make_run(self.root, "court-main-s2"), "118", "1234.5")
        self.assertNotEqual(rc, 0)
        self.assertEqual(calls(out), [])

    def test_shipped_freezes_clear_any_extra_flags(self):
        rc, out = dryrun(make_run(self.root, "court-main-s2"))
        self.assertTrue(all("RESULT=views,EXTRA= " in x for x in calls(out) if x.endswith("court-freeze.sbatch")))


class Freeze(unittest.TestCase):
    def run_freeze(self, **env):
        return subprocess.run(["bash", str(HERE / "court-freeze.sbatch")], capture_output=True, text=True,
                              env={**os.environ, "RUN": "/nonexistent", "K": "118", "FOCAL": "1", **env})

    def test_source_agree_only_into_an_ab_folder(self):
        for flag in ("--source-agree", "--source-ag"):
            p = self.run_freeze(EXTRA=flag, OUT="recon-300k")
            self.assertNotEqual(p.returncode, 0)
            self.assertIn("never for the shipped freeze", p.stderr)
        p = self.run_freeze(EXTRA="--source-agree", OUT="ab-agree-300k")
        self.assertNotIn("never for the shipped freeze", p.stderr)  # goes on (and stops at env.sh off the cluster)


class Clean(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run_dir = Path(self.tmp.name) / "court-main-s2"
        for f in ("views/videos/00.mp4", "views/cameras.json", "views/gvhmr/m.pt", "source-4k.mkv",
                  "recon-300k/frames/000000.ply", "recon-300k/recon-0.json"):
            (self.run_dir / f).parent.mkdir(parents=True, exist_ok=True)
            (self.run_dir / f).write_bytes(b"x")

    def tearDown(self):
        self.tmp.cleanup()

    def clean(self, **env):
        base = {k: v for k, v in os.environ.items() if k != "RUN"}
        return subprocess.run(["bash", str(HERE / "court-clean.sbatch")], capture_output=True, text=True,
                              cwd=self.run_dir, env={**base, **env})

    def test_views_cleanup_keeps_the_real_frame(self):
        p = self.clean(RUN=str(self.run_dir), WHAT="views")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertFalse((self.run_dir / "views/videos").exists())
        for f in ("views/cameras.json", "views/gvhmr/m.pt", "source-4k.mkv", "recon-300k/frames/000000.ply"):
            self.assertTrue((self.run_dir / f).exists(), f)

    def test_frames_cleanup(self):
        p = self.clean(RUN=str(self.run_dir), WHAT="frames")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertFalse((self.run_dir / "recon-300k/frames").exists())
        self.assertTrue((self.run_dir / "recon-300k/recon-0.json").exists())

    def test_unset_run_deletes_nothing(self):
        p = self.clean(WHAT="views")
        self.assertNotEqual(p.returncode, 0)
        self.assertTrue((self.run_dir / "views/videos/00.mp4").exists())


class TurboClean(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.L = Path(self.tmp.name)
        for rid in ("court-turbo-main-s2", "court-main-s2"):
            (self.L / "runs" / rid / "views").mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def tclean(self, *args):
        env = {**os.environ, "L": str(self.L), "RUN": str(self.L / "runs" / "court-main-s2")}
        return subprocess.run(["bash", str(HERE / "court-turbo-clean.sh"), *args], capture_output=True, text=True,
                              env=env)

    def test_removes_only_the_named_turbo_run(self):
        self.assertEqual(self.tclean("court-turbo-main-s2").returncode, 0)
        self.assertFalse((self.L / "runs/court-turbo-main-s2").exists())
        self.assertTrue((self.L / "runs/court-main-s2").exists())

    def test_without_an_id_nothing_goes(self):
        self.assertNotEqual(self.tclean().returncode, 0)
        self.assertNotEqual(self.tclean("court-main-s2").returncode, 0)
        self.assertNotEqual(self.tclean("court-turbo-main-s2/..").returncode, 0)
        self.assertTrue((self.L / "runs/court-turbo-main-s2").exists())
        self.assertTrue((self.L / "runs/court-main-s2").exists())


class AB(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_upscale_then_freeze_waits_on_the_views_job(self):
        d = make_run(self.root, "court-turbo-main-s2")
        (d / "logs").mkdir()
        (d / "logs" / "submitted").write_text("views=555\n")
        rc, out = dryrun(d, "up", SCRIPT="court-ab.sh", INTO="runs")
        self.assertEqual(rc, 0, out)
        c = calls(out)
        self.assertEqual(len(c), 2, out)
        self.assertIn("--dependency=afterok:555 ", c[0])
        self.assertTrue(c[0].endswith("pipeline/hpg/stage-upscale.sbatch"))
        self.assertIn("--dependency=afterok:1001 ", c[1])
        self.assertIn("K=118,FOCAL=1234.5,CAP=300000,OUT=ab-up-300k,RESULT=views-up,EXTRA= ", c[1])

    def test_agree_is_labelled_and_needs_no_wait_once_views_exist(self):
        d = make_run(self.root, "court-turbo-def-s2")
        (d / "views").mkdir()
        (d / "views" / "cameras.json").write_text("{}")
        rc, out = dryrun(d, "agree", SCRIPT="court-ab.sh", INTO="runs")
        self.assertEqual(rc, 0, out)
        c = calls(out)
        self.assertEqual(len(c), 1)
        self.assertNotIn("--dependency", c[0])
        self.assertIn("OUT=ab-agree-300k,RESULT=views,EXTRA=--source-agree ", c[0])


if __name__ == "__main__":
    unittest.main()
