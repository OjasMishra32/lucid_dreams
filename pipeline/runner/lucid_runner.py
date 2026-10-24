#!/usr/bin/env python3
"""The Mac side of the pipeline: sends a clip to HiPerGator, reports progress, brings the dream bundle back.
Stdlib only. Raami's bridge calls this (or imports it) to implement the job API in AGENTS.md.

    lucid_runner.py submit <clip> --name "Steph's jumper" [--id curry-01] [--turbo] [--chunks 6]
    lucid_runner.py status <id>          -> {"id", "status", "stage", "progress", "etaS", "message"}
    lucid_runner.py fetch <id> [--dest DIR] [--with-ply]
    lucid_runner.py list

Needs the shared SSH connection (~/.ssh/cm-hpg) that Ojasva opens with pipeline/hpg/hpg-login.sh.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

REMOTE = "/blue/iruchkin/vishalnaveen/lucid"
SOCKET = str(Path.home() / ".ssh" / "cm-hpg")
HOST = "hpg"
REPO = Path(__file__).resolve().parents[2]
DEFAULT_DEST = REPO / "dreams"
SSH = ["ssh", "-S", SOCKET, "-o", "BatchMode=yes", "-o", "ControlMaster=no", HOST]
RSYNC_SSH = f"ssh -S {SOCKET} -o BatchMode=yes -o ControlMaster=no"


def sh(cmd: list[str], **kw) -> str:
    out = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if out.returncode != 0:
        raise SystemExit(f"{' '.join(cmd[:3])}... failed: {out.stderr.strip()[-400:]}")
    return out.stdout


def remote(cmd: str) -> str:
    return sh(SSH + [cmd])


def rsync(src: str, dst: str, *extra: str) -> None:
    sh(["rsync", "-a", "--delete-after", *extra, "-e", RSYNC_SSH, src, dst])


def sync_code() -> None:
    """The pipeline code always runs from the repo as it is on this Mac."""
    remote(f"mkdir -p {REMOTE}/code")
    rsync(f"{REPO / 'pipeline'}/", f"{HOST}:{REMOTE}/code/pipeline/", "--exclude", "__pycache__")


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "dream"


def remember(run_id: str) -> None:
    """Every submitted run is listed in <dreams>/.runs.json, so the autopilot fetches it however it was submitted."""
    path = DEFAULT_DEST / ".runs.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    runs = json.loads(path.read_text()) if path.exists() else []
    if run_id not in runs:
        path.write_text(json.dumps(runs + [run_id], indent=1))


def submit(clip: Path | str, name: str, run_id: str | None, turbo: bool, chunks: int, start_s: float = 0.0,
           kind: str = "replay", intent: str = "", after: str = "") -> dict:
    """clip: a local file, or "hpg:/path" for a clip already on HiPerGator. intent: what you want to do with this
    person ("teach me this strum"), carried into dream.json for the experience step. after: a Slurm job id an avatar
    job waits for (the avatar assets), so it can be queued before they're installed."""
    on_hpg = isinstance(clip, str) and clip.startswith("hpg:")
    if not on_hpg and not Path(clip).exists():
        raise SystemExit(f"no such clip: {clip}")
    run_id = run_id or f"{slug(name)}-{time.strftime('%m%d-%H%M%S')}"
    run = f"{REMOTE}/runs/{run_id}"
    sync_code()
    remote(f"mkdir -p {run}")
    if on_hpg:
        src = clip[4:]
        remote(f"cp {src} {run}/input{Path(src).suffix.lower()}")
    else:
        rsync(str(clip), f"{HOST}:{run}/input{Path(clip).suffix.lower()}")
    if kind == "avatar":  # one photo -> a rigged person (Vishal's DiGS-Avatar job)
        job = {"id": run_id, "name": name, "kind": "avatar", "intent": intent, "submittedAt": time.time()}
        remote(f"cat > {run}/job.json <<'JSON'\n{json.dumps(job)}\nJSON")
        dep = f"--dependency=afterok:{after} " if after else ""
        jid = remote(f"mkdir -p {run}/logs && cd {run}/logs && sbatch --parsable {dep}--export=ALL,RUN={run} "
                     f"{REMOTE}/code/pipeline/hpg/stage-avatar.sbatch").strip()
        remote(f"echo '{{\"avatar\": \"{jid}\"}}' > {run}/slurm.json")
        remember(run_id)
        return {"id": run_id, "slurm": {"avatar": jid}}
    job = {"id": run_id, "name": name, "kind": "replay", "turbo": turbo, "chunks": chunks,
           "viewsPerLayer": 16, "layerPitches": [-10, 15, 35], "itersFirst": 7000, "itersWarm": 1500,
           "cap": 300000, "shDegree": 1, "aniso": 0.05, "fps": 25, "frames": 121, "startS": start_s, "intent": intent,
           "submittedAt": time.time()}
    remote(f"cat > {run}/job.json <<'JSON'\n{json.dumps(job)}\nJSON")
    slurm = json.loads(remote(f"bash {REMOTE}/code/pipeline/hpg/submit.sh {run}").strip().splitlines()[-1])
    remember(run_id)
    return {"id": run_id, "slurm": slurm}


def status(run_id: str) -> dict:
    out = remote(f"cd {REMOTE}/runs/{run_id} && PYTHONPATH={REMOTE}/code/pipeline python3 -m lucid.status show .")
    return json.loads(out)


def fetch(run_id: str, dest: Path, with_ply: bool) -> dict:
    target = dest / run_id
    target.mkdir(parents=True, exist_ok=True)
    # replay frames ship as SPZ too, so their PLYs stay on HiPerGator unless asked; an avatar's PLY is the avatar
    extra = [] if with_ply else ["--exclude", "/frames/*.ply"]
    rsync(f"{HOST}:{REMOTE}/runs/{run_id}/bundle/", f"{target}/", *extra)
    return json.loads((target / "dream.json").read_text())


def list_runs() -> list[dict]:
    names = remote(f"ls -1t {REMOTE}/runs 2>/dev/null || true").split()
    return [status(n) for n in names]


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("submit")
    s.add_argument("clip", help='local file, or "hpg:/path" for a clip already on HiPerGator')
    s.add_argument("--start-s", type=float, default=0.0, help="where the 5-second window starts in the clip")
    s.add_argument("--name", required=True)
    s.add_argument("--id")
    s.add_argument("--turbo", action="store_true", help="faster, slightly softer views (previews)")
    s.add_argument("--chunks", type=int, default=12, help="GPUs used in parallel for reconstruction")
    s.add_argument("--kind", choices=["replay", "avatar"], default="replay", help="avatar: the file is a photo")
    s.add_argument("--intent", default="", help='what you want to do with them, e.g. "teach me this strum"')
    st = sub.add_parser("status")
    st.add_argument("id")
    f = sub.add_parser("fetch")
    f.add_argument("id")
    f.add_argument("--dest", type=Path, default=DEFAULT_DEST)
    f.add_argument("--with-ply", action="store_true")
    sub.add_parser("list")
    a = p.parse_args(argv)
    if a.cmd == "submit":
        clip = a.clip if a.clip.startswith("hpg:") else Path(a.clip)
        out = submit(clip, a.name, a.id, a.turbo, a.chunks, a.start_s, a.kind, a.intent)
    elif a.cmd == "status":
        out = status(a.id)
    elif a.cmd == "fetch":
        out = fetch(a.id, a.dest, a.with_ply)
    else:
        out = list_runs()
    json.dump(out, sys.stdout)
    print()


if __name__ == "__main__":
    main()
