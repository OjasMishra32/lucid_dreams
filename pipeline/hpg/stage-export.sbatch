#!/bin/bash
#SBATCH --job-name=lucid-export
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-b200
#SBATCH --gpus=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --time=01:00:00
#SBATCH --output=%x-%j.log
# Stage "export": placed frames (PLY + SPZ), preview.mp4, thumb.jpg, audio, dream.json. Needs RUN.
set -euo pipefail
source /blue/iruchkin/vishalnaveen/lucid/code/pipeline/hpg/env.sh
cd "$RUN"
python -m lucid.status mark "$RUN" export running
# one field per call: names and intents have spaces (Raami caught "Jump shot" splitting)
job() { python -c 'import json, sys; j = json.load(open("job.json")); print(j.get(sys.argv[1]) or sys.argv[2])' "$1" "$2"; }
ID=$(job id run)
NAME=$(job name "$ID")
FPS=$(job fps 25)
INTENT=$(job intent "")
CLIP=$( [ -f prepped.mp4 ] && echo prepped.mp4 || ls input.* | head -1 )
python -m lucid.export --recon recon --out bundle --id "$ID" --name "$NAME" --no-ply \
  --result views --clip "$CLIP" --fps "$FPS" --intent "$INTENT" || { python -m lucid.status mark "$RUN" export failed; exit 1; }
python -m lucid.status mark "$RUN" export done
# the bundle holds placed copies of every frame: drop the intermediates (the lab's storage is nearly full)
rm -rf recon/frames views/skeletons
