#!/usr/bin/env python3
"""Once Meta's DINOv3 weights are here, restart everything avatars need, as one Slurm chain.

Waits for dinov3_vitb16_pretrain_lvd1689m*.pth in ~/Downloads (or fetches --url straight onto HiPerGator), installs it
as DiGS-Avatar's pretrained/dinov3_vitb16.pth, queues digs-assets, then re-queues every photo in
~/Downloads/lucid-photos as an avatar and Vishal's fine-tune for each replay in --runs, all behind the assets job.

    python3 pipeline/runner/after_dinov3.py [--url <the link from Meta's email>]
"""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import time
from pathlib import Path

import lucid_runner as runner

L = runner.REMOTE
TARGET = f"{L}/repos/DiGS-Avatar/pretrained/dinov3_vitb16.pth"
PHOTOS = Path.home() / "Downloads" / "lucid-photos"


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def wait_for_download() -> Path:
    last = -1
    while True:
        found = sorted(Path.home().joinpath("Downloads").glob("dinov3_vitb16*.pth"))
        if found:
            size = found[0].stat().st_size
            if size == last and size > 100_000_000:  # finished copying (the ViT-B/16 file is about 340 MB)
                return found[0]
            last = size
        time.sleep(15)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--url", help="the dinov3_vitb16_pretrain_lvd1689m link from Meta's email (fetched on HiPerGator)")
    p.add_argument("--runs", nargs="*", default=["jump-shot", "jump-shot-2"], help="replays to fine-tune avatars on")
    a = p.parse_args()

    runner.remote(f"mkdir -p {L}/repos/DiGS-Avatar/pretrained")
    if a.url:
        log("fetching DINOv3 on HiPerGator")
        runner.remote(f"wget -q -O {TARGET}.part {shlex.quote(a.url)} && mv {TARGET}.part {TARGET}")
    else:
        log("waiting for dinov3_vitb16*.pth in ~/Downloads")
        f = wait_for_download()
        log(f"copying {f.name} ({f.stat().st_size / 1e6:.0f} MB) to HiPerGator")
        runner.rsync(str(f), f"{runner.HOST}:{TARGET}")
    size = runner.remote(f"stat -c %s {TARGET}").strip()
    log(f"installed {TARGET} ({int(size) / 1e6:.0f} MB)")

    # the latest avatar code, then the assets job everything else waits on
    subprocess.run(["rsync", "-a", "--exclude", "__pycache__", "--exclude", ".venv", "-e", runner.RSYNC_SSH,
                    f"{runner.REPO / 'avatars'}/", f"{runner.HOST}:{L}/code/avatars/"], check=True)
    assets = runner.remote(f"cd {L}/jobs && sbatch --parsable {L}/code/avatars/hpg/digs-assets.sbatch").strip()
    log(f"queued digs-assets as {assets}")

    for f in sorted(PHOTOS.iterdir()) if PHOTOS.exists() else []:
        if f.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            continue
        side = f.with_suffix(".txt")
        intent = side.read_text().strip() if side.exists() else ""
        out = runner.submit(f, f.stem.replace("-", " ").replace("_", " ").title(), runner.slug(f.stem), False, 12,
                            kind="avatar", intent=intent, after=assets)
        log(f"queued avatar {out['id']} after {assets}")

    for rid in a.runs:
        st = runner.status(rid)["status"]
        if st == "failed":
            log(f"{rid} failed; no fine-tune")
            continue
        deps = [assets]
        if st != "done":
            deps.insert(0, json.loads(runner.remote(f"cat {L}/runs/{rid}/slurm.json"))["export"])
        jid = runner.remote(f"cd {L}/jobs && sbatch --parsable --dependency=afterok:{':'.join(deps)} "
                            f"--export=ALL,RUN_ID={rid} {L}/code/avatars/hpg/digs-finetune.sbatch").strip()
        log(f"queued fine-tune on {rid} as {jid} after {':'.join(deps)}")
    log("AVATARS_REQUEUED")


if __name__ == "__main__":
    main()
