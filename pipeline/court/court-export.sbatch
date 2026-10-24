#!/bin/bash
#SBATCH --job-name=court-export
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-b200
#SBATCH --gpus=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --time=00:30:00
#SBATCH --output=%x-%j.log
# Court Side: export the freeze frame with its full PLY (stage-export drops it). Needs RUN; optional RECON (recon),
# OUT (bundle). "Court Side" and no intent: export's shot pattern would otherwise add a hoop and ball physics.
set -euo pipefail
source /blue/iruchkin/vishalnaveen/lucid/code/pipeline/hpg/env.sh
cd "$RUN"
python -m lucid.export --recon "${RECON:-recon}" --out "${OUT:-bundle}" --id "$(basename "$RUN")" --name "Court Side" \
  --result views --clip prepped.mp4 --fps 25
