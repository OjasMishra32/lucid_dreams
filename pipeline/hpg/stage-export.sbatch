#!/bin/bash
#SBATCH --job-name=lucid-export
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-rtx6000,hpg-b200,hpg-turin
#SBATCH --gpus=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
#SBATCH --time=01:00:00
#SBATCH --output=%x-%j.log
# Stage "export": placed frames (PLY + SPZ), preview.mp4, thumb.jpg, audio, dream.json. Needs RUN.
set -euo pipefail
source /blue/iruchkin/vishalnaveen/lucid/code/pipeline/hpg/env.sh
cd "$RUN"
python -m lucid.status mark "$RUN" export running
read -r ID NAME FPS < <(python - <<'PY'
import json; j = json.load(open("job.json")); print(j["id"], json.dumps(j.get("name", j["id"])), j.get("fps", 25))
PY
)
INTENT=$(python -c 'import json; print(json.load(open("job.json")).get("intent", ""))')
CLIP=$( [ -f prepped.mp4 ] && echo prepped.mp4 || ls input.* | head -1 )
python -m lucid.export --recon recon --out bundle --id "$ID" --name "$(python -c "import json,sys; print(json.loads(sys.argv[1]))" "$NAME")" \
  --result views --clip "$CLIP" --fps "$FPS" --intent "$INTENT" || { python -m lucid.status mark "$RUN" export failed; exit 1; }
python -m lucid.status mark "$RUN" export done
# the bundle holds placed copies of every frame: drop the intermediates (the lab's storage is nearly full)
rm -rf recon/frames views/skeletons
