#!/usr/bin/env python3
"""Keeps the pipeline busy with no one at the keyboard.

Every minute: any new video in ~/Downloads/lucid-clips/ (once it has finished copying) is submitted to HiPerGator;
finished runs are fetched into <repo>/dreams/<id>/, where the viewer's library picks them up. With --seed-samples it
also runs 4DAnyone's sample clips of real people. Waits until SMPL-X is installed on HiPerGator before submitting.
A photo in ~/Downloads/lucid-photos/ (a consenting person, or a freely licensed photo of a public figure for the
chess demo under AGENTS.md's consent rule; head to toe; iPhone HEIC is fine) becomes an avatar, named
after the file (vishal.jpg -> "Vishal", id vishal), once the avatar assets are installed.
A text file with the same name next to a clip or photo (guitar-teacher.mp4 + guitar-teacher.txt) is the intent: what
you want to do with that person ("teach me this strum"); it goes into dream.json for the experience step.
A queue item's "then" jobs, e.g. [{"job": "avatars/hpg/digs-finetune.sbatch", "env": {}}], are submitted with
RUN_ID=<its id> once its run is done and the avatar assets are installed.

    python3 pipeline/runner/autopilot.py [--seed-samples 3]
State: <repo>/dreams/.autopilot.json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import time
from pathlib import Path

import lucid_runner as runner

DROP = Path.home() / "Downloads" / "lucid-clips"
VIDEO = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}
PHOTOS = Path.home() / "Downloads" / "lucid-photos"
PHOTO = {".jpg", ".jpeg", ".png", ".heic"}
SAMPLES = runner.REMOTE + "/repos/4DAnyone/data/source/pexels"
SMPLX = runner.REMOTE + "/repos/4DAnyone/models/body_models/smplx/SMPLX_NEUTRAL.npz"
ASSETS_STATE = (f"grep -l ASSETS_OK {runner.REMOTE}/jobs/lucid-digs-assets-*.log >/dev/null 2>&1 && echo done || "
                f"squeue -h -n lucid-digs-assets -o %i | head -1")


def assets() -> tuple[bool, str]:
    """(can queue avatar work now, the Slurm job id it must wait for or ""). Done -> (True, ""); queued or running
    -> (True, jid); neither yet -> (False, "")."""
    out = runner.remote(ASSETS_STATE).strip()
    if out == "done":
        return True, ""
    return (True, out) if out else (False, "")


def intent_for(f: Path) -> str:
    side = f.with_suffix(".txt")
    return side.read_text().strip() if side.exists() else ""


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--seed-samples", type=int, default=0, help="also run this many of 4DAnyone's sample clips")
    p.add_argument("--interval", type=int, default=60)
    p.add_argument("--queue", default=str(runner.REPO / "pipeline" / "runner" / "queue.json"),
                   help='clips already on HiPerGator to run first: [{"clip": "/blue/...mp4", "name": "...", "startS": 3.5}]')
    a = p.parse_args()
    state_path = runner.DEFAULT_DEST / ".autopilot.json"
    runner.DEFAULT_DEST.mkdir(parents=True, exist_ok=True)
    DROP.mkdir(parents=True, exist_ok=True)
    PHOTOS.mkdir(parents=True, exist_ok=True)
    state = json.loads(state_path.read_text()) if state_path.exists() else {"submitted": {}, "fetched": []}
    # only runs that are really in the library count as fetched (older versions also marked failures fetched)
    state["fetched"] = [r for r in state.get("fetched", []) if (runner.DEFAULT_DEST / r / "dream.json").exists()]
    sizes: dict[str, int] = {}
    seeded = state.get("seeded", False)
    while True:
        try:
            ready = runner.remote(f"test -f {SMPLX} && echo yes || echo no").strip() == "yes"
            queue = json.loads(Path(a.queue).read_text()) if Path(a.queue).exists() else []
            if not ready:
                log("waiting for SMPL-X on HiPerGator")
            else:
                for item in queue:
                    if item["clip"] in [v["clip"] for v in state["submitted"].values()]:
                        continue
                    out = runner.submit("hpg:" + item["clip"], item["name"], item.get("id"), False, item.get("chunks", 12),
                                        item.get("startS", 0.0), intent=item.get("intent", ""))
                    state["submitted"][out["id"]] = {"clip": item["clip"], "at": time.time(), "slurm": out.get("slurm", {})}
                    log(f"submitted queued clip {out['id']}")
                if a.seed_samples and not seeded:
                    clips = runner.remote(f"ls -1 {SAMPLES}/*.mp4").split()[: a.seed_samples]
                    for c in clips:
                        name = "Sample " + Path(c).stem.split("-")[0].split("_")[0]
                        out = runner.submit("hpg:" + c, name, None, False, 12)
                        state["submitted"][out["id"]] = {"clip": c, "at": time.time()}
                        log(f"submitted sample {out['id']}")
                    seeded = state["seeded"] = True
                for f in sorted(DROP.iterdir()):
                    if f.suffix.lower() not in VIDEO or str(f) in [v["clip"] for v in state["submitted"].values()]:
                        continue
                    size = f.stat().st_size
                    if sizes.get(str(f)) != size:  # still copying: wait for the size to settle
                        sizes[str(f)] = size
                        continue
                    out = runner.submit(f, f.stem.replace("_", " ").replace("-", " ").strip().title(), None, False, 12,
                                        intent=intent_for(f))
                    state["submitted"][out["id"]] = {"clip": str(f), "at": time.time()}
                    log(f"submitted {f.name} as {out['id']}")
            runs_file = runner.DEFAULT_DEST / ".runs.json"  # runs submitted by hand or by other tools
            for rid in json.loads(runs_file.read_text()) if runs_file.exists() else []:
                state["submitted"].setdefault(rid, {"clip": "", "at": time.time()})
            for run_id in list(state["submitted"]):
                if run_id in state["fetched"]:
                    continue
                st = runner.status(run_id)
                if st["status"] == "done":
                    runner.fetch(run_id, runner.DEFAULT_DEST, with_ply=False)
                    state["fetched"].append(run_id)
                    log(f"fetched {run_id}")
                elif st["status"] == "failed":
                    if run_id not in state.setdefault("failed", []):  # kept apart: a resubmitted run comes home
                        log(f"{run_id} failed at {st['stage']}")
                        state["failed"].append(run_id)
                elif run_id in state.get("failed", []):
                    state["failed"].remove(run_id)
                    log(f"{run_id} is running again")
            # photos -> avatars (Vishal's DiGS job needs its assets first)
            photos = [f for f in sorted(PHOTOS.iterdir()) if f.suffix.lower() in PHOTO
                      and str(f) not in [v["clip"] for v in state["submitted"].values()]]
            settled = []
            for f in photos:
                size = f.stat().st_size
                if sizes.get(str(f)) == size:
                    settled.append(f)
                sizes[str(f)] = size
            can, assets_jid = assets() if ready and settled else (False, "")
            if ready and settled and not can:
                log(f"{len(settled)} photo(s) wait for the avatar assets job to be queued")
            elif ready:
                for f in settled:
                    src = f
                    if f.suffix.lower() == ".heic":  # DiGS reads JPEG/PNG
                        src = runner.DEFAULT_DEST / ".photos" / (f.stem + ".jpg")
                        src.parent.mkdir(parents=True, exist_ok=True)
                        subprocess.run(["sips", "-s", "format", "jpeg", str(f), "--out", str(src)], check=True,
                                       capture_output=True)
                    rid = runner.slug(f.stem)
                    out = runner.submit(src, f.stem.replace("_", " ").replace("-", " ").strip().title(), rid, False, 12,
                                        0.0, kind="avatar", intent=intent_for(f), after=assets_jid)
                    state["submitted"][out["id"]] = {"clip": str(f), "at": time.time(), "kind": "avatar"}
                    log(f"submitted photo {f.name} as avatar {out['id']}")
            # follow-up jobs (e.g. Vishal's fine-tune): queued in Slurm behind the run's export and the avatar assets, so
            # they run through the night even if this Mac loses its connection. Job paths are relative to the repo clone.
            followed = state.setdefault("followed", [])
            for item in queue:
                rid, jobs = item.get("id"), item.get("then", [])
                if not jobs or rid in followed or rid not in state["submitted"]:
                    continue
                st = runner.status(rid)["status"]
                if st == "failed":
                    followed.append(rid)
                    continue
                can, assets_jid = assets()
                if not can:
                    continue
                export_jid = "" if st == "done" else str(state["submitted"][rid].get("slurm", {}).get("export", ""))
                if st != "done" and not export_jid:
                    export_jid = json.loads(runner.remote(f"cat {runner.REMOTE}/runs/{rid}/slurm.json")).get("export", "")
                deps = ":".join(j for j in (export_jid, assets_jid) if j)
                dep = f"--dependency=afterok:{deps} " if deps else ""
                for job in jobs:
                    env = ",".join(f"{k}={v}" for k, v in {"RUN_ID": rid, **job.get("env", {})}.items())
                    # the repo clone appears when the assets job runs; until then, the code synced at connect time
                    repo = f"{runner.REMOTE}/repos/lucid_dreams"
                    jid = runner.remote(f"if [ -d {repo}/.git ]; then cd {repo} && git pull -q --ff-only; "
                                        f"else cd {runner.REMOTE}/code; fi && "
                                        f"sbatch --parsable {dep}--export=ALL,{env} {job['job']}").strip()
                    log(f"{rid}: queued {job['job']} as job {jid}" + (f" (after {deps})" if deps else ""))
                followed.append(rid)
            state_path.write_text(json.dumps(state, indent=2))
        except SystemExit as e:  # a dropped connection shouldn't kill the loop
            log(f"error: {e}")
        time.sleep(a.interval)


if __name__ == "__main__":
    main()
