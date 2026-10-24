#!/bin/bash
#SBATCH --job-name=lucid-recon
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-b200
#SBATCH --gpus=1
#SBATCH --cpus-per-task=3
#SBATCH --mem=20G
#SBATCH --time=03:00:00
#SBATCH --output=%x-%A_%a.log
# Stage "reconstruct": one array task per chunk of frames; each chunk warm-starts frame to frame. Needs RUN, CHUNKS.
set -euo pipefail
source /blue/iruchkin/vishalnaveen/lucid/code/pipeline/hpg/env.sh
cd "$RUN"
TOTAL=$(python -c "import av; c=av.open('views/videos/00.mp4'); print(c.streams.video[0].frames or 121)")
read -r START END < <(python -c "
n=$TOTAL; k=$CHUNKS; i=$SLURM_ARRAY_TASK_ID; step=-(-n//k); print(i*step, min(n,(i+1)*step))")
read -r ITF ITW CAP SH ANISO SRC < <(python - <<'PY'
import json; j = json.load(open("job.json"))
print(j.get("itersFirst", 7000), j.get("itersWarm", 1500), j.get("cap", 300000), j.get("shDegree", 1), j.get("aniso", 0),
      int(bool(j.get("sourceView", False))))
PY
)
# 121 frames in 12 chunks of 11 leaves the last chunk empty: that's success, not a failure that blocks the export
if [ "$START" -ge "$END" ]; then echo "[recon] chunk $SLURM_ARRAY_TASK_ID has no frames"; exit 0; fi
python -m lucid.status mark "$RUN" reconstruct running
python -m lucid.recon --result "$RUN/views" --start "$START" --end "$END" --out "$RUN/recon" \
  --iters-first "$ITF" --iters-warm "$ITW" --cap "$CAP" --sh-degree "$SH" --aniso "$ANISO" --peek 0,4,8,12,20 \
  $([ "$SRC" = 1 ] && [ -f "$RUN/prepped.mp4" ] && echo --source-video "$RUN/prepped.mp4")
