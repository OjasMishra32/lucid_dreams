"""SyncNet confidence of the before and after face renders (lips_render.py): the number for the slide.

Runs in the SyncNet env (hpg/syncnet.sbatch builds `envs/syncnet`; numpy and this folder on PYTHONPATH are all this
script needs, SyncNet itself runs in its own process):
  python lips_sync_score.py dreams/vishal-head-voice --person vishal --renders lips/vishal-head-voice.sync \
      --syncnet syncnet_python

Our 224 x 224 crops are fed to SyncNet directly, exactly as its own `demo_syncnet.py` takes a video: `SyncNetInstance
.evaluate` extracts the frames and a 16 kHz mono wav with ffmpeg, runs the lip and audio streams over 5-frame / 0.2 s
windows, and reports AV offset, Min dist (LSE-D) and Confidence (LSE-C: the median over offsets of the clip's mean
distance minus its minimum). Its S3FD face-detection and tracking steps (run_pipeline.py) are skipped: the crops are
already the face, framed the way that pipeline frames it (about 1.4 x the detector's box, 224 px), and the same crop
and the same audio go through for both renders, so the only difference is the mouth.

Writes lips_sync.json into the bundle {before, after: {conf, dist, offset}, deltaConf, model, fps, clipS, ...}, the raw
SyncNet logs next to the renders, and one line: `SYNC conf before X after Y`. The consent gate (lips.py's) runs first;
--check runs it alone.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from lucid_avatars import lip_sync as S


def score_video(syncnet: Path, video: Path, tmp: Path, reference: str, python: str = sys.executable,
                model: str = f"data/{S.MODEL}", vshift: int = 15, log: Path | None = None) -> dict:
    """{"offset", "dist", "conf"} of one crop video through the SyncNet checkout's demo_syncnet.py (cwd = the checkout,
    as its relative paths expect); the raw output goes to `log`."""
    cmd = [python, "demo_syncnet.py", "--initial_model", model, "--videofile", str(video.resolve()),
           "--tmp_dir", str(tmp.resolve()), "--reference", reference, "--vshift", str(vshift)]
    run = subprocess.run(cmd, cwd=syncnet, capture_output=True, text=True)
    text = run.stdout + run.stderr
    if log is not None:
        log.write_text(text)
    if run.returncode != 0:
        raise SystemExit(f"SyncNet failed on {video.name} (exit {run.returncode}):\n{text[-2000:]}")
    return S.parse_syncnet(text)


def commit_of(repo: Path) -> str | None:
    try:
        out = subprocess.run(["git","-C", str(repo), "rev-parse", "--short", "HEAD"], capture_output=True,
                             text=True, check=True)
        return out.stdout.strip() or None
    except (OSError, subprocess.CalledProcessError):
        return None


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("bundle", type=Path, help="the voice-driven bundle the renders were made from")
    p.add_argument("--person", required=True)
    p.add_argument("--renders", type=Path, help="lips_render.py's --out")
    p.add_argument("--syncnet", type=Path, help="the syncnet_python checkout, with data/syncnet_v2.model")
    p.add_argument("--held", type=Path, default=None)
    p.add_argument("--vshift", type=int, default=15, help="SyncNet's offset search, frames each way")
    p.add_argument("--check", action="store_true", help="run the consent gate only (hpg/syncnet.sbatch does, first)")
    a = p.parse_args()

    refused = S.sync_consent_errors(a.person, a.bundle, a.held)  # first: before audio, renders or SyncNet
    if refused:
        print("REFUSED", *refused, sep="\n     ")
        return 2
    if a.check:
        print(f"consent OK: {a.person}'s own voice-driven bundle {a.bundle.name} may be rendered and scored")
        return 0
    if a.renders is None or a.syncnet is None:
        p.error("--renders and --syncnet are needed (or --check)")

    info = json.loads((a.renders / "render.json").read_text())
    if info.get("bundle") != a.bundle.name or info.get("person") != a.person:
        raise SystemExit(f"{a.renders} holds renders of {info.get('bundle')!r}, not {a.bundle.name!r}")
    tmp = a.renders / "syncnet-tmp"
    scores = {}
    for name in ("before", "after"):
        crops = a.renders / f"{name}_crops.avi"
        if not crops.is_file():
            raise SystemExit(f"no {crops}: run lips_render.py first")
        scores[name] = score_video(a.syncnet, crops, tmp, name, vshift=a.vshift, log=a.renders / f"syncnet_{name}.log")
        print(f"[syncnet] {name}: {scores[name]}")
    report = S.sync_report(scores["before"], scores["after"], person=a.person, bundle=a.bundle.name,
                           clip_s=info["clipS"], frames=info["frames"], syncnetCommit=commit_of(a.syncnet),
                           vshift=a.vshift, input="our 224x224 face crops fed directly (demo_syncnet.py)",
                           renders={"before": "before.mp4", "after": "after.mp4"})
    (a.bundle / S.SYNC_FILE).write_text(json.dumps(report, indent=2) + "\n")
    (a.renders / S.SYNC_FILE).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print(S.sync_line(report))
    if not report["improved"]:
        print("WARNING: the voice-driven mouth did not beat the idle: look at after.mp4 and compare.png before quoting this")
    return 0


if __name__ == "__main__":
    sys.exit(main())
