#!/bin/bash
# submit.sh <run dir> [views job id]: queues views -> reconstruct (array, one GPU per chunk) -> export, each waiting on
# the last. With a views job id, reuses that views job (queued or running) and queues only reconstruct + export.
set -euo pipefail
RUN=$1
H=/blue/iruchkin/vishalnaveen/lucid/code/pipeline/hpg
CHUNKS=$(python3 -c "import json; print(json.load(open('$RUN/job.json')).get('chunks', 6))")
mkdir -p "$RUN/logs"
cd "$RUN/logs"
V=${2:-$(sbatch --parsable --export=ALL,RUN="$RUN" "$H/stage-views.sbatch")}
R=$(sbatch --parsable --dependency=afterok:"$V" --array=0-$((CHUNKS - 1)) --export=ALL,RUN="$RUN",CHUNKS="$CHUNKS" "$H/stage-recon.sbatch")
E=$(sbatch --parsable --dependency=afterok:"$R" --export=ALL,RUN="$RUN" "$H/stage-export.sbatch")
printf '{"views": "%s", "reconstruct": "%s", "export": "%s", "chunks": %s}\n' "$V" "$R" "$E" "$CHUNKS" > "$RUN/slurm.json"
cat "$RUN/slurm.json"
