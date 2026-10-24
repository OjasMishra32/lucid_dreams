"""court-job.sbatch (stubbed GPU tools) and court-job-submit.sh (stubbed sbatch/blue_quota). Nothing leaves this
machine. Run from the repo root: python3 -I -m unittest discover -s pipeline/court -p 'test_*.py' -v"""

import json
import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

STUB_PY = r'''#!/usr/bin/env python3
import json, os, shutil, subprocess, sys
from pathlib import Path
a = sys.argv[1:]
def rec():
    with open(os.environ["STUB_LOG"], "a") as fh:
        fh.write(json.dumps({"args": a, "cuda": os.environ.get("CUDA_VISIBLE_DEVICES")}) + "\n")
def opt(name):
    return a[a.index(name) + 1]
if a[:2] == ["-m", "lucid.prep_clip"]:
    rec(); shutil.copy(a[2], opt("--out")); print("{}")
    if os.environ.get("STUB_AFTER_PREP"):
        subprocess.run(os.environ["STUB_AFTER_PREP"], shell=True, check=True)
elif a and a[0].endswith("inference.py"):
    rec(); out = Path(opt("--output_dir")); (out / "videos").mkdir(parents=True); (out / "gvhmr").mkdir()
    for i in range(48):
        shutil.copy(os.environ["STUB_TINY"], out / "videos" / f"{i:02d}.mp4")
    cams = [{"camera_id": i, "K": [[10, 0, 8], [0, 10, 16], [0, 0, 1]], "image_width": 16, "image_height": 32} for i in range(48)]
    (out / "cameras.json").write_text(json.dumps({"cameras": cams}))
    (out / "metadata.json").write_text("{}"); (out / "gvhmr" / "m.pt").write_bytes(b"x")
elif a and a[0].endswith("court_fetch_seedvr2.py"):
    rec(); Path(a[1]).mkdir(parents=True, exist_ok=True)
    if os.environ.get("STUB_FAIL") == "fetch":
        sys.exit(4)
elif a and a[0].endswith("inference_cli.py"):
    rec(); out = Path(opt("--output")); out.mkdir(parents=True, exist_ok=True)
    for f in Path(a[1]).glob("*.mp4"):
        shutil.copy(os.environ["STUB_TINY2"], out / f.name)
elif a[:2] == ["-m", "lucid.recon"]:
    if "--extra-sources" in a:
        a.append(json.loads(Path(opt("--extra-sources")).read_text()))
    rec(); out = Path(opt("--out")); k = int(opt("--start")); (out / "frames").mkdir(parents=True, exist_ok=True)
    if os.environ.get("STUB_FAIL") and os.environ["STUB_FAIL"] == out.name:
        sys.exit(3)
    (out / "frames" / f"{k:06d}.ply").write_bytes(b"p" * 1000)
    (out / f"recon-{k:06d}-{k + 1:06d}.json").write_text(json.dumps({
        "frames": [{"frame": k, "psnr": 30.0, "ssim": 0.9, "sourcePsnr": 35.0, "gaussians": 1}],
        "source": {"iou": 0.9, "focal": float(opt("--source-focal")), "focalHeld": True}}))
    (out / f"peek-{k:06d}.jpg").write_bytes(b"j")
elif a[:2] == ["-m", "lucid.export"]:
    rec(); out = Path(opt("--out")); (out / "frames").mkdir(parents=True)
    (out / "dream.json").write_text("{}"); (out / "frames" / "000000.ply").write_bytes(b"p")
else:
    os.execvp("python3", ["python3", *a])
'''

NVIDIA = '''#!/bin/bash
case "$*" in
  -L) echo "GPU 0: NVIDIA B200 (UUID: a)"; echo "GPU 1: NVIDIA B200 (UUID: b)" ;;
  *index,name*) echo "0, NVIDIA B200, 183359 MiB"; echo "1, NVIDIA B200, 183359 MiB" ;;
  *) echo "NVIDIA B200"; echo "NVIDIA B200" ;;
esac
'''


def tiny(path: Path, w: int, h: int):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=gray:s={w}x{h}:r=25", "-frames:v", "3",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path)], check=True)


def make_data(root: Path, rid: str, k: int = 118, focal: float = 1234.5, turbo: bool = True, skip=(), extras=(),
              **job_over) -> Path:
    d = root / rid
    (d / "masks").mkdir(parents=True)
    (d / "ignore").mkdir()
    for name in ("input.mp4", "source-4k.mkv", f"masks/{k:06d}.png", f"ignore/{k:06d}.png"):
        if name not in skip:
            (d / name).write_bytes(b"x" * 100)
    job = {"id": rid, "name": "Court Side", "kind": "replay", "turbo": turbo, "viewsPerLayer": 16,
           "layerPitches": [-10, 15, 35], "fps": 25, "frames": 121, "intent": "", **job_over}
    (d / "job.json").write_text(json.dumps(job, indent=1))
    (d / "court-run.json").write_text(json.dumps({"id": rid, "K": k, "FOCAL": focal}, indent=1))
    if extras:
        for name, w in extras:
            for f in (f"real/{name}/{name}.mkv", f"real/{name}/masks/000000.png", f"real/{name}/ignore/000000.png"):
                (d / f).parent.mkdir(parents=True, exist_ok=True)
                (d / f).write_bytes(b"x")
        (d / "real" / "extras.json").write_text(json.dumps([{"name": n, "weight": w, "focal": 99.5} for n, w in extras],
                                                           indent=1))
    return d


ALL4 = "raw:default raw:agree up:default up:agree"


class Job(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = self.t = Path(self.tmp.name)
        self.L, self.bin, self.scratch = t / "L", t / "bin", t / "scratch"
        for p in (self.L / "data" / "court", self.L / "code", self.L / "repos" / "4DAnyone",
                  self.L / "envs" / "seedvr2" / "bin", self.bin, self.scratch):
            p.mkdir(parents=True)
        (self.L / "code" / "pipeline").symlink_to(HERE.parent)
        (self.L / "envs" / "seedvr2" / "bin" / "activate").write_text("")
        (t / "env.sh").write_text("")
        for name, text in (("python", STUB_PY), ("nvidia-smi", NVIDIA)):
            (self.bin / name).write_text(text)
            (self.bin / name).chmod(stat.S_IRWXU)
        tiny(t / "tiny.mp4", 16, 32)
        tiny(t / "tiny2.mp4", 32, 64)
        self.id = "court-turbo-main-s2"
        self.data = make_data(self.L / "data" / "court", self.id)

    def tearDown(self):
        self.tmp.cleanup()

    def run_job(self, **env):
        e = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}", "L": str(self.L), "TMPDIR": str(self.scratch),
             "ENV_SH": str(self.t / "env.sh"), "ID": self.id, "MIN_SCRATCH_GB": "0", "SLURM_JOB_ID": "77",
             "STUB_LOG": str(self.t / "calls.jsonl"), "STUB_TINY": str(self.t / "tiny.mp4"),
             "STUB_TINY2": str(self.t / "tiny2.mp4"), **env}
        p = subprocess.run(["bash", str(HERE / "court-job.sbatch")], capture_output=True, text=True, env=e)
        log = self.t / "calls.jsonl"
        self.calls = [json.loads(x) for x in log.read_text().splitlines()] if log.exists() else []
        return p

    def recons(self):
        return [c for c in self.calls if c["args"][:2] == ["-m", "lucid.recon"]]

    def test_full_grid_in_scratch(self):
        hook = f"""python3 -c "import json; p='{self.data}/court-run.json'; r=json.load(open(p)); r['FOCAL']=2000.5; json.dump(r, open(p,'w'))" """
        p = self.run_job(STUB_AFTER_PREP=hook, VARIANTS=ALL4)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        out = self.L / "runs" / self.id
        for v in ("raw-default", "raw-agree", "up-default", "up-agree"):
            self.assertTrue((out / f"bundle-{v}-r0-300k" / "dream.json").exists(), v)
            self.assertTrue((out / f"recon-{v}-r0-300k" / "frames" / "000118.ply").exists(), v)
            self.assertTrue((out / f"recon-metrics-{v}-r0" / "recon-000118-000119.json").exists(), v)
            used = json.loads((out / f"recon-{v}-r0-300k" / "used.json").read_text())
            self.assertEqual((used["K"], used["FOCAL"], used["gpu"]), (118, 2000.5, "NVIDIA B200"))
        self.assertFalse((out / "recon-metrics-raw-default-r0" / "frames").exists())
        self.assertEqual(sorted(x.name for x in (out / "views" / "videos").iterdir()),
                         ["00.mp4", "04.mp4", "08.mp4", "12.mp4"])
        self.assertEqual(len(list((out / "views-up" / "videos").iterdir())), 4)
        cams = json.loads((out / "views-up" / "cameras.json").read_text())["cameras"][0]
        self.assertEqual((cams["image_width"], cams["K"][0][0]), (32, 20.0))
        for f in ("prepped.mp4", "prep.json", "views/cameras.json", "views/gvhmr/m.pt"):
            self.assertTrue((out / f).exists(), f)
        r = self.recons()
        self.assertEqual(len(r), 8)
        for c in r:
            a = " ".join(c["args"])
            self.assertIn("--source-focal 2000.5 ", a)  # read when the recon starts, not when the job did
            self.assertEqual("--source-agree" in a, "-agree" in a)
            self.assertEqual("--holdout-every 8" in a, "recon-metrics" in a)
            self.assertEqual("--result views-up" in a, "-up-" in a or a.endswith("up") or "metrics-up" in a)
        self.assertEqual({c["cuda"] for c in r}, {"0", "1"})
        views = next(c for c in self.calls if c["args"][0].endswith("inference.py"))
        self.assertNotIn("--enable_turbo=False", views["args"])
        self.assertEqual(views["cuda"], "0")
        self.assertEqual(list(self.scratch.iterdir()), [])  # its scratch is gone
        self.assertEqual(sorted(x.name for x in self.L.iterdir()), ["code", "data", "envs", "repos", "runs"])
        self.assertIn("raw-default-r0  300k", subprocess.run(["python3", str(HERE / "court_grid_report.py"), str(out)],
                                              capture_output=True, text=True).stdout)

    def test_winner_caps_without_upscale(self):
        p = self.run_job(VARIANTS="raw:default", CAPS="250000 200000", METRICS="0")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        outs = sorted(c["args"][c["args"].index("--out") + 1] for c in self.recons())
        self.assertEqual(outs, ["recon-raw-default-r0-200k", "recon-raw-default-r0-250k"])
        self.assertFalse(any(c["args"][0].endswith(("inference_cli.py", "court_fetch_seedvr2.py")) for c in self.calls))

    def test_full_quality_views(self):
        self.data = make_data(self.L / "data" / "court", "court-main-s2", turbo=False)
        self.id = "court-main-s2"
        p = self.run_job(VARIANTS="raw:default", METRICS="0")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        views = next(c for c in self.calls if c["args"][0].endswith("inference.py"))
        self.assertIn("--enable_turbo=False", views["args"])

    def test_one_failed_recon_keeps_the_rest(self):
        p = self.run_job(STUB_FAIL="recon-up-agree-r0-300k", VARIANTS=ALL4)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("recon-up-agree-r0-300k FAILED", p.stdout)
        out = self.L / "runs" / self.id
        self.assertTrue((out / "bundle-raw-default-r0-300k" / "dream.json").exists())
        self.assertFalse((out / "bundle-up-agree-r0-300k").exists())

    def test_seedvr2_failure_keeps_the_raw_variants(self):
        p = self.run_job(STUB_FAIL="fetch", VARIANTS=ALL4)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("SeedVR2 FAILED: going on with raw:default raw:agree", p.stdout)
        out = self.L / "runs" / self.id
        self.assertTrue((out / "bundle-raw-default-r0-300k" / "dream.json").exists())
        self.assertTrue((out / "bundle-raw-agree-r0-300k" / "dream.json").exists())
        self.assertEqual(len(self.recons()), 4)
        self.assertTrue(all(f"--source-masks {self.data}/masks " in " ".join(c["args"]) for c in self.recons()))

    def test_other_real_views_train_and_hold_out(self):
        self.data = make_data(self.L / "data" / "court", "court-def-s2", extras=(("X1", 1.0), ("X2", 0.7)))
        self.id = "court-def-s2"
        p = self.run_job(VARIANTS="raw:default", REALS="0 1 2 3")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("REALS 3: only 2", p.stderr)
        got = {}
        for c in self.recons():
            out = c["args"][c["args"].index("--out") + 1]
            xs = c["args"][-1] if isinstance(c["args"][-1], list) else []
            got[out] = [(Path(e["video"]).stem, e["weight"], e["offset"]) for e in xs]
        self.assertEqual(got, {
            "recon-raw-default-r0-300k": [],
            "recon-metrics-raw-default-r0": [("X1", 0.0, -118), ("X2", 0.0, -118)],
            "recon-raw-default-r1-300k": [("X1", 1.0, -118)],
            "recon-metrics-raw-default-r1": [("X1", 1.0, -118), ("X2", 0.0, -118)],
            "recon-raw-default-r2-300k": [("X1", 1.0, -118), ("X2", 0.7, -118)],
            "recon-metrics-raw-default-r2": [("X1", 1.0, -118), ("X2", 0.7, -118)]})
        out = self.L / "runs" / self.id
        self.assertTrue((out / "recon-metrics-raw-default-r1.extra.json").exists())
        rep = subprocess.run(["python3", str(HERE / "court_grid_report.py"), "--rank", str(out)], capture_output=True,
                             text=True).stdout
        self.assertEqual(len(rep.strip().splitlines()), 4)

    def test_seed_and_tag(self):
        p = self.run_job(TAG="seed2", SEED="2", SEED_FLAG="--seed", VARIANTS="raw:default", METRICS="0")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        views = next(c for c in self.calls if c["args"][0].endswith("inference.py"))
        self.assertEqual(views["args"][-2:], ["--seed", "2"])
        self.assertTrue((self.L / "runs" / self.id / "seed2" / "bundle-raw-default-r0-300k" / "dream.json").exists())
        p = self.run_job(TAG="seed3", SEED="3", VARIANTS="raw:default", METRICS="0")  # 4DAnyone's own --seed
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        views = [c for c in self.calls if c["args"][0].endswith("inference.py")][-1]
        self.assertEqual(views["args"][-2:], ["--seed", "3"])
        p = self.run_job(TAG="seed4", SEED="x")
        self.assertNotEqual(p.returncode, 0)

    def test_caps_are_checked(self):
        for caps in ("300k", "300000 300400"):
            p = self.run_job(CAPS=caps)
            self.assertNotEqual(p.returncode, 0, caps)
            self.assertIn("cap", p.stderr)
        self.assertEqual(self.calls, [])

    def test_too_little_scratch_stops_before_anything(self):
        p = self.run_job(MIN_SCRATCH_GB="999999999")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("need 999999999", p.stdout)
        self.assertFalse((self.L / "runs").exists())
        self.assertEqual(self.calls, [])

    def test_bad_variant(self):
        p = self.run_job(VARIANTS="raw:default views:agree")
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.calls, [])


def dryrun(*args, **env) -> tuple[int, str]:
    p = subprocess.run(["bash", str(HERE / "court-dryrun.sh"), *map(str, args)], capture_output=True, text=True,
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

    def test_one_job_per_run(self):
        a = make_data(self.root, "court-turbo-main-s2")
        b = make_data(self.root, "court-turbo-def-s2")
        rc, out = dryrun(a, b, NO_PYTHON="1")  # the login node runs no python
        self.assertEqual(rc, 0, out)
        c = calls(out)
        self.assertEqual(len(c), 2, out)
        self.assertTrue(all("--gres=gpu:4 " in x and x.endswith("court/court-job.sbatch") for x in c))
        self.assertIn("ID=court-turbo-main-s2,", c[0])
        self.assertIn("ID=court-turbo-def-s2,", c[1])
        self.assertIn("SUBMITTED court-turbo-def-s2 job=1002", out)

    def test_missing_file_submits_nothing(self):
        a = make_data(self.root, "court-turbo-main-s2")
        b = make_data(self.root, "court-def-s1", k=117, skip=("source-4k.mkv",))
        rc, out = dryrun(a, b)
        self.assertNotEqual(rc, 0)
        self.assertIn("missing", out)
        self.assertEqual(calls(out), [])

    def test_record_for_another_run(self):
        rc, out = dryrun(make_data(self.root, "court-def-s2", id="court-main-s2"))
        self.assertNotEqual(rc, 0)
        self.assertIn("is not for court-def-s2", out)

    def test_short_quota(self):
        rc, out = dryrun(make_data(self.root, "court-main-s2"), FREE_T="0.001")
        self.assertNotEqual(rc, 0)
        self.assertIn("group quota has 1 GB free", out)
        self.assertEqual(calls(out), [])

    def test_dry_and_gpus(self):
        rc, out = dryrun(make_data(self.root, "court-main-s2"), DRY="1")
        self.assertEqual(rc, 0, out)
        self.assertEqual(calls(out), [])
        rc, out = dryrun(make_data(self.root, "court-def-s2"), NGPU="2")
        self.assertIn("--gres=gpu:2 ", calls(out)[0])

    def test_another_account(self):
        rc, out = dryrun(make_data(self.root, "court-main-s2"), NO_PYTHON="1")
        self.assertNotIn("--account", calls(out)[0])  # the script's own #SBATCH lines rule by default
        rc, out = dryrun(make_data(self.root, "court-def-s2"), ACCOUNT="acct2", QOS="qos2-b", PARTITION="hpg-b200",
                         NO_PYTHON="1")
        self.assertEqual(rc, 0, out)
        self.assertIn(" --account=acct2 --qos=qos2-b --partition=hpg-b200 ", calls(out)[0])
        self.assertIn("account acct2, qos qos2-b", out)
        rc, out = dryrun(make_data(self.root, "court-x-s2"), ACCOUNT="a b")
        self.assertNotEqual(rc, 0)
        self.assertIn("PREFLIGHT FAIL: ACCOUNT", out)

    def test_the_jobs_stack_must_be_readable_from_this_login(self):
        rc, out = dryrun(make_data(self.root, "court-main-s2"), STACK="0")
        self.assertNotEqual(rc, 0)
        self.assertIn("PREFLIGHT FAIL: this login can't read the 4DAnyone stack", out)
        self.assertEqual(calls(out), [])

    def test_same_id_twice(self):
        a = make_data(self.root, "court-main-s2")
        rc, out = dryrun(a, a)
        self.assertNotEqual(rc, 0)
        self.assertEqual(calls(out), [])

    def test_mask_at_k_must_be_there(self):
        d = make_data(self.root, "court-def-s1", k=117)
        (d / "court-run.json").write_text(json.dumps({"id": "court-def-s1", "K": 118, "FOCAL": 1.0}, indent=1))
        rc, out = dryrun(d)
        self.assertNotEqual(rc, 0)
        self.assertIn("masks/000118.png", out)

    def test_slow_quota_output_is_read_to_the_end(self):
        rc, out = dryrun(make_data(self.root, "court-main-s2"), QUOTA_SLOW="1")
        self.assertEqual(rc, 0, out)
        self.assertEqual(len(calls(out)), 1)

    def test_seeds_one_job_each(self):
        a = make_data(self.root, "court-main-s2")
        rc, out = dryrun(a, SEEDS="3")
        self.assertEqual(rc, 0, out)
        c = calls(out)
        self.assertEqual([re.search(r"TAG=(\S*?),SEED=(\d+)", x).groups() for x in c],
                         [("seed1", "1"), ("seed2", "2"), ("seed3", "3")])
        rc, out = dryrun(a, SEEDS="3", TAG="x")
        self.assertNotEqual(rc, 0)

    def test_bad_id(self):
        rc, out = dryrun(make_data(self.root, "Court-Main"))
        self.assertNotEqual(rc, 0)
        self.assertIn("PREFLIGHT FAIL: id", out)


class GridCheck(unittest.TestCase):
    """court-grid.sh CHECK=1: one read-only ssh (stubbed to run here), no upload, no mkdir."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = self.root = Path(self.tmp.name)
        self.L, self.runs, bin_ = root / "blue", root / "runs", root / "bin"
        (self.L / "code" / "pipeline" / "court").mkdir(parents=True)
        (self.L / "code" / "pipeline" / "court" / "court-lib.sh").write_text((HERE / "court-lib.sh").read_text())
        bin_.mkdir()
        self.log = root / "calls.log"
        for name, body in (("ssh", 'echo "ssh $*" >> "$CALLS"; exec bash -c "${@: -1}"'),
                           ("rsync", 'echo "rsync $*" >> "$CALLS"'),
                           ("blue_quota", "printf 'Storage quotas for group x:\\nblue2  4.990T  5T  5T  -  1\\n'")):
            f = bin_ / name
            f.write_text(f"#!/bin/bash\n{body}\n")
            f.chmod(0o755)
        self.env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "CALLS": str(self.log),
                    "COURT_HPG_L": str(self.L), "CHECK": "1"}
        for rid in ("court-a-r2", "court-b-r2"):
            make_data(self.runs, rid)

    def tearDown(self):
        self.tmp.cleanup()

    def grid(self):
        before = sorted(str(x) for x in self.L.rglob("*"))
        p = subprocess.run(["bash", str(HERE / "court-grid.sh"), str(self.runs), "court-a-r2", "court-b-r2"],
                           capture_output=True, text=True, env=self.env)
        self.assertEqual(sorted(str(x) for x in self.L.rglob("*")), before)  # nothing made on "HPG"
        calls = self.log.read_text().splitlines()
        self.assertFalse([c for c in calls if c.startswith("rsync") or "mkdir" in c], calls)
        return p.returncode, p.stdout + p.stderr

    def test_new_ids_pass_and_nothing_changes(self):
        rc, out = self.grid()
        self.assertEqual(rc, 0, out)
        self.assertIn("CHECK OK", out)
        self.assertIn("group free: 10 GB", out)

    def test_an_id_already_on_blue_fails(self):
        (self.L / "data" / "court" / "court-b-r2").mkdir(parents=True)
        rc, out = self.grid()
        self.assertEqual(rc, 1, out)
        self.assertIn(f"EXISTS {self.L}/data/court/court-b-r2", out)
        self.assertNotIn("CHECK OK", out)


class GridDry(unittest.TestCase):
    """court-grid.sh DRY=1 prints what it would run (no ssh): the HiPerGator login, /blue base and Slurm account."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.runs = Path(self.tmp.name) / "runs"
        make_data(self.runs, "court-a-r2")

    def tearDown(self):
        self.tmp.cleanup()

    def grid(self, **env):
        p = subprocess.run(["bash", str(HERE / "court-grid.sh"), str(self.runs), "court-a-r2"], capture_output=True,
                           text=True, env={**os.environ, "DRY": "1", **env})
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        return [x for x in p.stdout.splitlines() if x.startswith("+ ")]

    def test_defaults(self):
        lines = self.grid()
        self.assertTrue(all(" hpg " in x or "hpg:/blue/iruchkin/vishalnaveen/lucid/" in x for x in lines), lines)
        self.assertNotIn("ACCOUNT", lines[-1])

    def test_another_login_base_and_account(self):
        lines = self.grid(HOST="hpg2", COURT_HPG_L="/blue/grp2/user2/lucid", ACCOUNT="grp2", QOS="grp2-b")
        self.assertFalse([x for x in lines if "iruchkin" in x or " hpg " in x or "hpg:" in x], lines)
        self.assertIn("hpg2:/blue/grp2/user2/lucid/data/court/court-a-r2/", lines[-2])
        self.assertIn("ACCOUNT=grp2", lines[-1])
        self.assertIn("QOS=grp2-b", lines[-1])
        self.assertIn("L=/blue/grp2/user2/lucid", lines[-1])
        self.assertIn("bash /blue/grp2/user2/lucid/code/pipeline/court/court-job-submit.sh court-a-r2", lines[-1])


if __name__ == "__main__":
    unittest.main()
