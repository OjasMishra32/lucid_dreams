"""Runs format.ts's validators over a baked video/ folder via node, against a read-only extract of origin/court-side.

`check_bundle(video_dir)` returns the runner's report: {"ok": bool, "problems": [...], "report": [per stream]}. The
extract (`git archive` of apps/webxr/src/court and the court.json fixture) goes to a temp dir and is deleted after;
pass `checkout=` to use an existing checkout instead (for example the QA worktree). Nothing in it is ever edited.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNNER = HERE / "fmtcheck.mjs"
PARTS = ["apps/webxr/src/court", "apps/webxr/scripts/court/fixtures"]


def repo_root() -> Path:
    return Path(subprocess.run(["git", "-C", str(HERE), "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True).stdout.strip())


def extract(dest: Path, ref: str = "origin/court-side") -> Path:
    """`git archive` of the format files at `ref` into dest (read only on the repo)."""
    arch = subprocess.run(["git", "-C", str(repo_root()), "archive", ref, *PARTS], capture_output=True, check=True)
    subprocess.run(["tar", "-x", "-C", str(dest)], input=arch.stdout, check=True)
    return dest


def check_bundle(video_dir: Path | str, checkout: Path | str | None = None, info: Path | str | None = None) -> dict:
    video_dir = Path(video_dir)
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(checkout) if checkout else extract(Path(tmp))
        cmd = ["node", str(RUNNER), str(root), str(video_dir)]
        if info:
            cmd += ["--info", str(info)]
        r = subprocess.run(cmd, capture_output=True, text=True)
    out = r.stdout.strip().splitlines()
    try:
        return json.loads(out[-1])
    except (IndexError, json.JSONDecodeError):
        return {"ok": False, "problems": [f"validator did not run: {r.stderr.strip()[-600:] or r.stdout.strip()[-600:]}"], "report": []}
