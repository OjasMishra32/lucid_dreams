#!/bin/bash
#SBATCH --job-name=lucid-recon
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-b200,hpg-rtx6000,hpg-turin
#SBATCH --gpus=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=96G
#SBATCH --time=03:00:00
#SBATCH --output=%x-%A_%a.log
# Stage "reconstruct": one array task per chunk of frames; each chunk warm-starts frame to frame. Needs RUN, CHUNKS.
set -euo pipefail
source /blue/iruchkin/vishalnaveen/lucid/code/pipeline/hpg/env.sh
cd "$RUN"
TOTAL=$(python -c "import av; c=av.open('views/videos/00.mp4'); print(c.streams.video[0].frames or 121)")
read -r START END < <(python -c "
n=$TOTAL; k=$CHUNKS; i=$SLURM_ARRAY_TASK_ID; step=-(-n//k); print(i*step, min(n,(i+1)*step))")
read -r ITF ITW CAP SH < <(python - <<'PY'
import json; j = json.load(open("job.json"))
print(j.get("itersFirst", 7000), j.get("itersWarm", 1500), j.get("cap", 300000), j.get("shDegree", 1))
PY
)
python -m lucid.status mark "$RUN" reconstruct running
[ "$START" -lt "$END" ] && python -m lucid.recon --result "$RUN/views" --start "$START" --end "$END" --out "$RUN/recon" \
  --iters-first "$ITF" --iters-warm "$ITW" --cap "$CAP" --sh-degree "$SH"
