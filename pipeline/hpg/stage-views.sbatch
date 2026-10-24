#!/bin/bash
#SBATCH --job-name=lucid-views
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-b200,hpg-rtx6000
#SBATCH --gpus=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=48G
#SBATCH --time=02:00:00
#SBATCH --output=%x-%j.log
# Stage "views": 4DAnyone turns the input clip into synchronized multi-view videos + cameras. Needs RUN (run dir).
set -euo pipefail
source "$(dirname "$0")/env.sh" 2>/dev/null || source /blue/iruchkin/vishalnaveen/lucid/code/pipeline/hpg/env.sh
cd "$RUN"
python -m lucid.status mark "$RUN" views running
CLIP=$(ls input.* | head -1)
# portrait 9:16, person centred, 121+ frames (landscape clips get a fixed crop around the person)
python -m lucid.prep_clip "$CLIP" --out prepped.mp4 --start-s "$(python -c "import json; print(json.load(open('job.json')).get('startS', 0))")" > prep.json \
  || { python -m lucid.status mark "$RUN" views failed; exit 1; }
CLIP=prepped.mp4
read -r VPL PITCHES TURBO < <(python - <<'PY'
import json; j = json.load(open("job.json"))
print(j.get("viewsPerLayer", 16), json.dumps(j.get("layerPitches", [-10, 15, 35])).replace(" ", ""), str(j.get("turbo", False)).lower())
PY
)
cd "$L/repos/4DAnyone"
EXTRA=""
# the flag is --enable_turbo (default True); asking for --turbo matched nothing, so every run so far was 4-step Turbo
[ "$TURBO" = "false" ] && EXTRA="--enable_turbo=False"
python inference.py --video_path "$RUN/$CLIP" --output_dir "$RUN/views" --views_per_layer "$VPL" --layer_pitches "$PITCHES" $EXTRA \
  || { python -m lucid.status mark "$RUN" views failed; exit 1; }
python -m lucid.status mark "$RUN" views done
