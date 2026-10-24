"""Run status for the job API (stdlib only, so it runs on the login node too).

    python -m lucid.status mark <run dir> <stage> <running|done|failed>   (called by the stage jobs)
    python -m lucid.status show <run dir>                                  (prints the GET /api/jobs/:id JSON)

Stages: upload, check, views, upscale, reconstruct, export (upscale is skipped while it's off).
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

WEIGHTS = {"upload": 0.03, "check": 0.02, "views": 0.35, "upscale": 0.0, "reconstruct": 0.5, "export": 0.1}
ORDER = list(WEIGHTS)
# rough seconds per stage on one B200 / RTX PRO 6000 at hero settings, for the ETA only
EXPECTED = {"views": 360, "reconstruct": 1500, "export": 120}


def _load(run: Path) -> dict:
    p = run / "status.json"
    return json.loads(p.read_text()) if p.exists() else {"stages": {}}


def mark(run: Path, stage: str, state: str) -> None:
    s = _load(run)
    entry = s["stages"].setdefault(stage, {})
    entry["state"] = state
    entry.setdefault("startedAt", time.time())
    if state in ("done", "failed"):
        entry["endedAt"] = time.time()
    tmp = run / "status.json.tmp"
    tmp.write_text(json.dumps(s, indent=2))
    tmp.replace(run / "status.json")


def show(run: Path) -> dict:
    job = json.loads((run / "job.json").read_text()) if (run / "job.json").exists() else {"id": run.name}
    s = _load(run)["stages"]
    s.setdefault("upload", {"state": "done"})
    s.setdefault("check", {"state": "done"})
    if (run / "bundle" / "dream.json").exists():
        return {"id": job["id"], "status": "done", "stage": "export", "progress": 1.0, "etaS": 0, "message": "Ready"}
    failed = next((k for k in ORDER if s.get(k, {}).get("state") == "failed"), None)
    if failed:
        return {"id": job["id"], "status": "failed", "stage": failed, "progress": _progress(run, s), "etaS": None,
                "message": f"The {failed} step failed. Ojasva is on it."}
    current = next((k for k in ORDER if s.get(k, {}).get("state") == "running"), None)
    started = any(s.get(k, {}).get("state") in ("running", "done") for k in ("views", "reconstruct", "export"))
    status = "running" if started else "queued"
    stage = current or ("views" if not started else next(k for k in ORDER if s.get(k, {}).get("state") != "done"))
    progress = _progress(run, s)
    remaining = sum(EXPECTED.get(k, 0) for k in ORDER[ORDER.index(stage):]) if stage in ORDER else 0
    if job.get("kind") == "avatar" and stage in ("views", "reconstruct"):
        stage = "reconstruct"
    message = {
        "views": "Imagining every angle of them",
        "reconstruct": "Building them in 3D" if job.get("kind") == "avatar" else "Building them in 3D, frame by frame",
        "export": "Getting them ready for your room",
    }.get(stage, "Waiting for a GPU")
    return {"id": job["id"], "status": status, "stage": stage, "progress": round(progress, 3),
            "etaS": int(remaining * (1 - _stage_fraction(run, s, stage))), "message": message}


def _stage_fraction(run: Path, s: dict, stage: str) -> float:
    e = s.get(stage, {})
    if e.get("state") == "done":
        return 1.0
    if stage == "reconstruct":
        total = int(json.loads((run / "job.json").read_text()).get("frames", 121)) if (run / "job.json").exists() else 121
        done = len(list((run / "recon" / "frames").glob("*.spz"))) if (run / "recon" / "frames").exists() else 0
        return min(done / max(total, 1), 0.99)
    if e.get("state") == "running" and stage in EXPECTED:
        return min((time.time() - e.get("startedAt", time.time())) / EXPECTED[stage], 0.95)
    return 0.0


def _progress(run: Path, s: dict) -> float:
    return sum(w * _stage_fraction(run, s, k) for k, w in WEIGHTS.items())


if __name__ == "__main__":
    cmd, run = sys.argv[1], Path(sys.argv[2])
    if cmd == "mark":
        mark(run, sys.argv[3], sys.argv[4])
    elif cmd == "show":
        print(json.dumps(show(run)))
    else:
        raise SystemExit(__doc__)
