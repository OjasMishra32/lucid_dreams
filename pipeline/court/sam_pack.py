"""The upload folder for court-hpg.sh court-sam-people: the frames a SAM plan names, zipped as they are, the plan, and
the exact sam_people.py that will run on them.

    python3 -I sam_pack.py people --frames <dir of NNNNNN.jpg> --plan <sam_plan.json> --code <sam_people.py> --out <dir>

Writes <out>/court-sam-people/frames.zip (stored, not recompressed: the JPEGs go up byte for byte), plan.json and
sam_people.py. That folder is what gets rsynced to $L/data/court/court-sam-people/. Every frame the plan lists must
exist, or nothing is written.
"""

import argparse
import json
import os
import shutil
import sys
from pathlib import Path
import zipfile


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("set", choices=["people"])
    ap.add_argument("--frames", type=Path, required=True)
    ap.add_argument("--plan", type=Path, required=True)
    ap.add_argument("--code", type=Path, required=True, help="the sam_people.py to run on HiPerGator")
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args(argv)
    plan = json.loads(a.plan.read_text())
    names = [f"{int(n):06d}.jpg" for n in plan["frames"]]
    missing = [n for n in names if not (a.frames / n).is_file()]
    if missing:
        sys.exit(f"sam_pack: {len(missing)} of {len(names)} frames missing in {a.frames}, e.g. {missing[:3]}")
    d = a.out / f"court-sam-{a.set}"
    d.mkdir(parents=True, exist_ok=True)
    part = d / "frames.zip.part"
    with zipfile.ZipFile(part, "w", zipfile.ZIP_STORED) as z:
        for n in names:
            z.write(a.frames / n, n)
    os.replace(part, d / "frames.zip")
    shutil.copyfile(a.plan, d / "plan.json")
    shutil.copyfile(a.code, d / "sam_people.py")
    mb = (d / "frames.zip").stat().st_size / 2**20
    print(f"{d}: {len(names)} frames ({names[0]}..{names[-1]}), frames.zip {mb:.0f} MB")


if __name__ == "__main__":
    main()
