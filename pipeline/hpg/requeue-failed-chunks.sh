#!/bin/bash
# requeue-failed-chunks.sh <run dir>: re-runs only the reconstruction chunks of a run that failed, and re-queues its
# export behind them (and behind any chunks still running). Updates slurm.json; prints the new ids.
set -euo pipefail
RUN=$1
H=/blue/iruchkin/vishalnaveen/lucid/code/pipeline/hpg
read -r R E CHUNKS < <(python3 -c "import json; d=json.load(open('$RUN/slurm.json')); print(d['reconstruct'], d['export'], d.get('chunks', 6))")
FAILED=$(sacct -j "$R" -n -X -o JobID%24,State%12 | awk '$2 ~ /FAILED|CANCELLED|TIMEOUT|OUT_OF_ME|NODE_FAIL/ {split($1, a, "_"); print a[2]}' | sort -n | paste -sd, -)
if [ -z "$FAILED" ]; then echo "{\"run\": \"$(basename $RUN)\", \"failed\": []}"; exit 0; fi
cd "$RUN/logs"
R2=$(sbatch --parsable --array="$FAILED" --export=ALL,RUN="$RUN",CHUNKS="$CHUNKS" "$H/stage-recon.sbatch")
scancel "$E" 2>/dev/null || true
E2=$(sbatch --parsable --dependency=afterany:"$R",afterok:"$R2" --export=ALL,RUN="$RUN" "$H/stage-export.sbatch")
python3 - "$RUN" "$R2" "$E2" <<'PY'
import json, sys
run, r2, e2 = sys.argv[1:]
p = f"{run}/slurm.json"; d = json.load(open(p))
d.setdefault("requeued", []).append(r2); d["export"] = e2
json.dump(d, open(p, "w"))
PY
echo "{\"run\": \"$(basename $RUN)\", \"failed\": [$FAILED], \"reconstruct\": \"$R2\", \"export\": \"$E2\"}"
