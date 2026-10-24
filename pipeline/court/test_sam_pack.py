"""sam_pack.py: the Mac-side upload folder for court-hpg.sh. Run from the repo root:
python3 -I -m unittest discover -s pipeline/court -p 'test_*.py' -v"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent


def pack(*args) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-I", str(HERE / "sam_pack.py"), *map(str, args)], capture_output=True,
                          text=True)


class Pack(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.frames = self.root / "frames"
        self.frames.mkdir()
        for n in (10, 11, 12, 14):
            (self.frames / f"{n:06d}.jpg").write_bytes(b"jpg%d" % n)

    def tearDown(self):
        self.tmp.cleanup()

    def test_people_takes_only_the_plan_frames(self):
        plan = self.root / "sam_plan.json"
        plan.write_text(json.dumps({"frames": [10, 12], "cands": {}}))
        code = self.root / "sam_people.py"
        code.write_text("print('sam')\n")
        p = pack("people", "--frames", self.frames, "--plan", plan, "--code", code, "--out", self.root / "up")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        d = self.root / "up" / "court-sam-people"
        self.assertEqual((d / "sam_people.py").read_text(), "print('sam')\n")
        with zipfile.ZipFile(d / "frames.zip") as z:
            self.assertEqual(sorted(z.namelist()), ["000010.jpg", "000012.jpg"])
            self.assertTrue(all(i.compress_type == zipfile.ZIP_STORED for i in z.infolist()))
            self.assertEqual(z.read("000012.jpg"), b"jpg12")
        self.assertEqual(json.loads((d / "plan.json").read_text())["frames"], [10, 12])

    def test_a_missing_frame_stops_it(self):
        plan = self.root / "sam_plan.json"
        plan.write_text(json.dumps({"frames": [10, 13]}))
        code = self.root / "sam_people.py"
        code.write_text("")
        p = pack("people", "--frames", self.frames, "--plan", plan, "--code", code, "--out", self.root / "up")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("000013.jpg", p.stderr)
        self.assertFalse((self.root / "up" / "court-sam-people" / "frames.zip").exists())


if __name__ == "__main__":
    unittest.main()
