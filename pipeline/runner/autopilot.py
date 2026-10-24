#!/usr/bin/env python3
"""Keeps the pipeline busy with no one at the keyboard.

Every minute: any new video in ~/Downloads/lucid-clips/ (once it has finished copying) is submitted to HiPerGator;
finished runs are fetched into <repo>/dreams/<id>/, where the viewer's library picks them up. With --seed-samples it
also runs 4DAnyone's sample clips of real people. Waits until SMPL-X is installed on HiPerGator before submitting.

    python3 pipeline/runner/autopilot.py [--seed-samples 3]
State: <repo>/dreams/.autopilot.json
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import lucid_runner as runner

DROP = Path.home() / "Downloads" / "lucid-clips"
VIDEO = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}
SAMPLES = runner.REMOTE + "/repos/4DAnyone/data/source/pexels"
SMPLX = runner.REMOTE + "/repos/4DAnyone/models/body_models/smplx/SMPLX_NEUTRAL.npz"


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
    state = json.loads(state_path.read_text()) if state_path.exists() else {"submitted": {}, "fetched": []}
    sizes: dict[str, int] = {}
    seeded = state.get("seeded", False)
    while True:
        try:
            ready = runner.remote(f"test -f {SMPLX} && echo yes || echo no").strip() == "yes"
            if not ready:
                log("waiting for SMPL-X on HiPerGator")
            else:
                queue = json.loads(Path(a.queue).read_text()) if Path(a.queue).exists() else []
                for item in queue:
                    if item["clip"] in [v["clip"] for v in state["submitted"].values()]:
                        continue
                    out = runner.submit("hpg:" + item["clip"], item["name"], item.get("id"), False, item.get("chunks", 6),
                                        item.get("startS", 0.0))
                    state["submitted"][out["id"]] = {"clip": item["clip"], "at": time.time()}
                    log(f"submitted queued clip {out['id']}")
                if a.seed_samples and not seeded:
                    clips = runner.remote(f"ls -1 {SAMPLES}/*.mp4").split()[: a.seed_samples]
                    for c in clips:
                        name = "Sample " + Path(c).stem.split("-")[0].split("_")[0]
                        out = runner.submit("hpg:" + c, name, None, False, 6)
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
                    out = runner.submit(f, f.stem.replace("_", " ").replace("-", " ").strip().title(), None, False, 6)
                    state["submitted"][out["id"]] = {"clip": str(f), "at": time.time()}
                    log(f"submitted {f.name} as {out['id']}")
            for run_id in list(state["submitted"]):
                if run_id in state["fetched"]:
                    continue
                st = runner.status(run_id)
                if st["status"] == "done":
                    runner.fetch(run_id, runner.DEFAULT_DEST, with_ply=False)
                    state["fetched"].append(run_id)
                    log(f"fetched {run_id}")
                elif st["status"] == "failed":
                    log(f"{run_id} failed at {st['stage']}")
                    state["fetched"].append(run_id)
            state_path.write_text(json.dumps(state, indent=2))
        except SystemExit as e:  # a dropped connection shouldn't kill the loop
            log(f"error: {e}")
        time.sleep(a.interval)


if __name__ == "__main__":
    main()
