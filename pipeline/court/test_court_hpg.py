"""court-hpg.sh (SAM 2.1 masks on HiPerGator) through court-dryrun.sh, plus a direct run with a ready env (stubbed
sbatch and blue_quota; nothing leaves this machine). Run from the repo root:
python3 -I -m unittest discover -s pipeline/court -p 'test_*.py' -v"""

import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

STUB_SBATCH = """#!/bin/bash
n=$(( $(wc -l < "$SBATCH_LOG") + 1001 ))
script=${!#}
[ -f "$script" ] || { echo "sbatch: no such script $script" >&2; exit 1; }
echo "$n $*" >> "$SBATCH_LOG"
echo "$n"
"""
STUB_QUOTA = """#!/bin/bash
cat <<EOF
Storage quotas for group 'iruchkin':
Filesystem    Use     Quota    Limit    Grace       Files
-----------  ------  -------  -------  -------  --------
blue2         4.985T  5T       5T       -        95400576
EOF
"""
FILES = {"court-sam-people": ["frames.zip", "plan.json", "sam_people.py"], "court-matte": ["crops.zip"],
         "court-sam-env": []}


def make_upload(root: Path, rid: str, skip=()) -> Path:
    d = root / rid
    d.mkdir(parents=True)
    for name in FILES.get(rid, FILES["court-sam-people"]):
        if name not in skip:
            (d / name).write_bytes(b"x" * 100)
    return d


def dryrun(folder: Path, **env) -> tuple[int, str]:
    p = subprocess.run(["bash", str(HERE / "court-dryrun.sh"), str(folder)], capture_output=True, text=True,
                       env={**os.environ, "SCRIPT": "court-hpg.sh", "NO_PYTHON": "1", **env})
    return p.returncode, p.stdout + p.stderr


def calls(out: str) -> list[str]:
    return [x for x in out.split("--- exit")[1].splitlines()[1:] if re.match(r"^\d{4} ", x)]


def fake_l(root: Path, env_ready: bool) -> Path:
    """A fake $L with the code linked in, stub sbatch and blue_quota, and the SAM env built or not."""
    L = root / "L"
    for p in ["bin", "code", "data/court", "envs/sam2/bin", "models/sam2/checkpoints"]:
        (L / p).mkdir(parents=True)
    if env_ready:
        (L / "envs/sam2/.court-sam-ok").write_text("ok")
        (L / "models/sam2/checkpoints/sam2.1_hiera_large.pt").write_bytes(b"x")
    (L / "code/pipeline").symlink_to(HERE.parent)
    for name, body in [("sbatch", STUB_SBATCH), ("blue_quota", STUB_QUOTA)]:
        (L / "bin" / name).write_text(body)
        (L / "bin" / name).chmod(0o755)
    (L / "sbatch.log").write_text("")
    return L


def direct(L: Path, rid: str) -> tuple[int, str, list[str]]:
    p = subprocess.run(["bash", str(HERE / "court-hpg.sh"), rid], capture_output=True, text=True,
                       env={**os.environ, "L": str(L), "SBATCH_LOG": str(L / "sbatch.log"),
                            "PATH": f"{L / 'bin'}:{os.environ['PATH']}"})
    return p.returncode, p.stdout + p.stderr, (L / "sbatch.log").read_text().splitlines()


class Masks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_env_first(self):
        rc, out = dryrun(make_upload(self.root, "court-sam-env"))
        self.assertEqual(rc, 0, out)
        c = calls(out)
        self.assertEqual(len(c), 1, out)
        self.assertTrue(c[0].endswith("pipeline/court/court-sam-env.sbatch"), c[0])

    def test_env_already_built_is_not_rebuilt(self):
        rc, out, c = direct(fake_l(self.root, env_ready=True), "court-sam-env")
        self.assertNotEqual(rc, 0)
        self.assertIn("already built", out)
        self.assertEqual(c, [])

    def test_people_waits_for_the_env(self):
        rc, out = dryrun(make_upload(self.root, "court-sam-people"))
        self.assertNotEqual(rc, 0)
        self.assertIn("isn't built yet", out)
        self.assertEqual(calls(out), [])

    def test_people_with_the_env(self):
        L = fake_l(self.root, env_ready=True)
        make_upload(L / "data/court", "court-sam-people")
        rc, out, c = direct(L, "court-sam-people")
        self.assertEqual(rc, 0, out)
        self.assertEqual(len(c), 1, c)
        self.assertTrue(c[0].endswith("pipeline/court/court-masks.sbatch"), c[0])
        self.assertNotIn("--dependency", c[0])
        self.assertIn(f"RUN={L}/runs/court-sam-people,DATA={L}/data/court/court-sam-people", c[0])
        self.assertTrue((L / "runs/court-sam-people/logs/submitted").exists())
        self.assertIn("masks-people.tar", out)
        rc, out, c = direct(L, "court-sam-people")  # twice: refused, nothing more submitted
        self.assertNotEqual(rc, 0)
        self.assertIn("submitted before", out)
        self.assertEqual(len(c), 1)

    def test_prompted_sets_need_the_env(self):
        up = self.root / "court-sam-extras"
        for who in ("p1", "p2"):
            (up / who).mkdir(parents=True)
            (up / who / "frames.zip").write_bytes(b"x" * 100)
            (up / who / "prompts.json").write_text("{}")
        rc, out = dryrun(up)
        self.assertNotEqual(rc, 0)
        self.assertIn("isn't built yet", out)
        L = fake_l(self.root, env_ready=True)
        shutil.copytree(up, L / "data/court/court-sam-extras")
        rc, out, c = direct(L, "court-sam-extras")
        self.assertEqual(rc, 0, out)
        self.assertEqual(len(c), 1, c)
        self.assertTrue(c[0].endswith("pipeline/court/court-sam.sbatch"), c[0])
        self.assertIn("masks-sam.tar", out)

    def test_a_set_may_carry_its_clip(self):
        L = fake_l(self.root, env_ready=True)
        d = L / "data/court/court-sam-pair"
        d.mkdir()
        (d / "prompts.json").write_text("{}")
        (d / "A.mp4").write_bytes(b"x" * 100)
        rc, out, c = direct(L, "court-sam-pair")
        self.assertEqual(rc, 0, out)
        self.assertTrue(c[0].endswith("court-sam.sbatch"), c)

    def test_rematte_reuses_the_upload_and_the_masks(self):
        L = fake_l(self.root, env_ready=True)
        d = L / "data/court/court-sam-pair"
        d.mkdir()
        (d / "prompts.json").write_text("{}")
        (d / "A.mp4").write_bytes(b"x" * 100)
        rc, out, c = direct(L, "court-rematte-pair")
        self.assertNotEqual(rc, 0)
        self.assertIn("masks-sam.tar to matte", out)
        (L / "runs/court-sam-pair").mkdir(parents=True)
        (L / "runs/court-sam-pair/masks-sam.tar").write_bytes(b"x" * 100)
        rc, out, c = direct(L, "court-rematte-pair")
        self.assertEqual(rc, 0, out)
        self.assertIn(f"RUN={L}/runs/court-rematte-pair,DATA={L}/data/court/court-sam-pair,"
                      f"MASKS_TAR={L}/runs/court-sam-pair/masks-sam.tar", c[0])
        self.assertTrue(c[0].endswith("court-sam.sbatch"))
        self.assertIn("masks-alpha.tar", out)
        # a multi-set upload (one folder per view) rematted the same way
        v = L / "data/court/court-sam-views"
        for who in ("v1", "v2"):
            (v / who).mkdir(parents=True)
            (v / who / "prompts.json").write_text("{}")
            (v / who / "frames.zip").write_bytes(b"x" * 100)
        (L / "runs/court-sam-views").mkdir(parents=True)
        (L / "runs/court-sam-views/masks-sam.tar").write_bytes(b"x" * 100)
        rc, out, c = direct(L, "court-rematte-views")
        self.assertEqual(rc, 0, out)
        self.assertIn("MASKS_TAR=", c[-1])

    def test_a_prompted_upload_without_a_set_submits_nothing(self):
        L = fake_l(self.root, env_ready=True)
        (L / "data/court/court-sam-pair").mkdir()
        (L / "data/court/court-sam-pair/frames.zip").write_bytes(b"x")
        rc, out, c = direct(L, "court-sam-pair")
        self.assertNotEqual(rc, 0)
        self.assertIn("no set", out)
        self.assertEqual(c, [])

    def test_another_allocation(self):
        L = fake_l(self.root, env_ready=False)
        p = subprocess.run(["bash", str(HERE / "court-hpg.sh"), "court-sam-env"], capture_output=True, text=True,
                           env={**os.environ, "L": str(L), "SBATCH_LOG": str(L / "sbatch.log"),
                                "PATH": f"{L / 'bin'}:{os.environ['PATH']}", "ACCOUNT": "lab2", "QOS": "lab2",
                                "ENV_QOS": "lab2-b", "PARTITION": "hpg-rtx6000", "CPUS": "2"})
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        c = (L / "sbatch.log").read_text().splitlines()
        self.assertIn("--account=lab2 --qos=lab2-b --output=", c[0])  # the CPU build on the burst QOS
        self.assertIn(f"--export=ALL,L={L} ", c[0])
        self.assertNotIn("--partition", c[0])
        (L / "envs/sam2/.court-sam-ok").write_text("ok")
        (L / "models/sam2/checkpoints/sam2.1_hiera_large.pt").write_bytes(b"x")
        make_upload(L / "data/court", "court-sam-people")
        p = subprocess.run(["bash", str(HERE / "court-hpg.sh"), "court-sam-people"], capture_output=True, text=True,
                           env={**os.environ, "L": str(L), "SBATCH_LOG": str(L / "sbatch.log"),
                                "PATH": f"{L / 'bin'}:{os.environ['PATH']}", "ACCOUNT": "lab2", "QOS": "lab2",
                                "PARTITION": "hpg-rtx6000", "CPUS": "2"})
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        c = (L / "sbatch.log").read_text().splitlines()
        self.assertIn("--account=lab2 --qos=lab2 --partition=hpg-rtx6000 --cpus-per-task=2 --job-name=court-sam-people "
                      "--export=ALL,L=", c[1])
        p = subprocess.run(["bash", str(HERE / "court-hpg.sh"), "court-matte"], capture_output=True, text=True,
                           env={**os.environ, "L": str(L), "SBATCH_LOG": str(L / "sbatch.log"),
                                "PATH": f"{L / 'bin'}:{os.environ['PATH']}", "QOS": "x;rm"})
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("QOS=", p.stdout + p.stderr)

    def test_matte_needs_no_sam_env(self):
        rc, out = dryrun(make_upload(self.root, "court-matte"))
        self.assertEqual(rc, 0, out)
        c = calls(out)
        self.assertEqual(len(c), 1, out)
        self.assertTrue(c[0].endswith("pipeline/court/court-matte.sbatch"), c[0])
        self.assertIn("RUN=$L/runs/court-matte,DATA=$L/data/court/court-matte", c[0])
        self.assertIn("masks-matte.tar", out)

    def test_missing_input_submits_nothing(self):
        rc, out = dryrun(make_upload(self.root, "court-sam-people", skip=("plan.json",)))
        self.assertNotEqual(rc, 0)
        self.assertIn("PREFLIGHT FAIL", out)
        self.assertIn("plan.json", out)
        self.assertEqual(calls(out), [])

    def test_people_without_the_sam_script_submits_nothing(self):
        rc, out = dryrun(make_upload(self.root, "court-sam-people", skip=("sam_people.py",)))
        self.assertNotEqual(rc, 0)
        self.assertIn("sam_people.py", out)
        self.assertEqual(calls(out), [])

    def test_short_quota_submits_nothing(self):
        rc, out = dryrun(make_upload(self.root, "court-matte"), FREE_T="0.002")
        self.assertNotEqual(rc, 0)
        self.assertIn("GB free", out)
        self.assertEqual(calls(out), [])

    def test_quota_floor_is_five_gb(self):
        rc, out = dryrun(make_upload(self.root, "court-matte"), FREE_T="0.006")
        self.assertEqual(rc, 0, out)

    def test_unknown_id_is_refused(self):
        rc, out = dryrun(make_upload(self.root, "court-x-pair"))
        self.assertNotEqual(rc, 0)
        self.assertIn("PREFLIGHT FAIL", out)
        self.assertEqual(calls(out), [])


class Mac(unittest.TestCase):
    def mac(self, *args) -> list[str]:
        p = subprocess.run(["bash", str(HERE / "court-masks-hpg.sh"), *args], capture_output=True, text=True,
                           env={**os.environ, "DRY": "1"})
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        return p.stdout.splitlines()

    def test_env_uploads_the_scripts_then_submits(self):
        out = self.mac("env")
        self.assertIn("court-hpg.sh", out[1])
        self.assertIn("court_matte.py hpg:/blue/iruchkin/vishalnaveen/lucid/code/pipeline/court/", out[1])
        self.assertTrue(out[-1].endswith("bash /blue/iruchkin/vishalnaveen/lucid/code/pipeline/court/court-hpg.sh "
                                         "court-sam-env"), out[-1])

    def test_people_packs_uploads_submits(self):
        out = self.mac("people", "/f", "/p.json", "/s.py", "/stage")
        self.assertIn("sam_pack.py people --frames /f --plan /p.json --code /s.py --out /stage", out[0])
        self.assertIn("/stage/court-sam-people/ hpg:/blue/iruchkin/vishalnaveen/lucid/data/court/court-sam-people/",
                      out[-2])
        self.assertTrue(out[-1].endswith("court-hpg.sh court-sam-people"), out[-1])

    def test_matte_needs_names(self):
        p = subprocess.run(["bash", str(HERE / "court-masks-hpg.sh"), "matte", "/v.mp4", "/m", "/stage"],
                           capture_output=True, text=True, env={**os.environ, "DRY": "1"})
        self.assertNotEqual(p.returncode, 0)
        out = self.mac("matte", "/v.mp4", "/m", "/stage", "a", "b")
        self.assertIn("court_matte.py pack --video /v.mp4 --masks /m --names a b --out /stage", out[0])
        self.assertTrue(out[-1].endswith("court-hpg.sh court-matte"), out[-1])

    def test_sam_uploads_a_folder_and_submits(self):
        out = self.mac("sam", "extras", "/stage/court-sam-extras")
        self.assertIn("court_sam.py", out[1])
        self.assertIn("/stage/court-sam-extras/ hpg:/blue/iruchkin/vishalnaveen/lucid/data/court/court-sam-extras/",
                      out[-2])
        self.assertTrue(out[-1].endswith("court-hpg.sh court-sam-extras"), out[-1])

    def test_fetch_sam_passes_unpack_flags(self):
        out = self.mac("fetch", "sam", "views", "/m", "--single")
        self.assertIn("runs/court-sam-views/masks-sam.tar /m/", out[1])
        self.assertTrue(out[2].endswith("court_sam.py unpack /m/masks-sam.tar --out /m --single"), out[2])

    def test_another_host_and_allocation(self):
        p = subprocess.run(["bash", str(HERE / "court-masks-hpg.sh"), "sam", "pair2", "/stage/up"], capture_output=True,
                           text=True, env={**os.environ, "DRY": "1", "HOST": "hpg2", "L": "/blue/lab2/me/x",
                                           "ACCOUNT": "lab2", "QOS": "lab2", "PARTITION": "hpg-rtx6000"})
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        out = p.stdout.splitlines()
        self.assertIn("hpg2:/blue/lab2/me/x/code/pipeline/court/", out[1])
        self.assertIn("rsync -aH --partial", out[2])
        self.assertIn("/stage/up/ hpg2:/blue/lab2/me/x/data/court/court-sam-pair2/", out[2])
        self.assertTrue(out[3].endswith("hpg2 env L=/blue/lab2/me/x ACCOUNT=lab2 QOS=lab2 PARTITION=hpg-rtx6000 bash "
                                        "/blue/lab2/me/x/code/pipeline/court/court-hpg.sh court-sam-pair2"), out[3])

    def test_rematte_and_its_fetch(self):
        out = self.mac("rematte", "pair")
        self.assertTrue(out[-1].endswith("court-hpg.sh court-rematte-pair"), out[-1])
        out = self.mac("fetch", "rematte", "pair", "/m")
        self.assertIn("runs/court-rematte-pair/masks-alpha.tar /m/", out[1])
        self.assertTrue(out[2].endswith("court_sam.py unpack /m/masks-alpha.tar --out /m"), out[2])

    def test_fetch_matte_unpacks_into_the_masks(self):
        out = self.mac("fetch", "matte", "/m", "/stage")
        self.assertIn("hpg:/blue/iruchkin/vishalnaveen/lucid/runs/court-matte/masks-matte.tar /stage/", out[1])
        self.assertIn("court_matte.py unpack /stage/masks-matte.tar --masks /m", out[2])

if __name__ == "__main__":
    unittest.main()
