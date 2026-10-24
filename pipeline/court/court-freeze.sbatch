#!/bin/bash
#SBATCH --job-name=court-freeze
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-b200
#SBATCH --gpus=1
#SBATCH --cpus-per-task=3
#SBATCH --mem=20G
#SBATCH --time=01:30:00
#SBATCH --output=%x-%j.log
# Court Side: the freeze frame K only, trained cold at CAP, with the real native-4K frame as a solved view (our mask,
# whoever is in front ignored, the calibrated focal held). Needs RUN, K, FOCAL; optional CAP, OUT, ITERS, FACE, HOLDOUT.
# The metrics run is this script with OUT=recon-metrics HOLDOUT=8. A/B runs (court-ab.sh) set RESULT (views-up) or
# EXTRA (recon flags) and always write to ab-*: --source-agree moves the person off the real camera, so it is refused
# for any other output.
set -euo pipefail
if [[ ${EXTRA:-} == *--source-a* && ${OUT:-recon} != ab-* ]]; then  # argparse takes any unique prefix
  echo "court-freeze: --source-agree only in a labelled A/B (OUT=ab-*), never for the shipped freeze" >&2; exit 1
fi
source /blue/iruchkin/vishalnaveen/lucid/code/pipeline/hpg/env.sh
cd "$RUN"
python -m lucid.recon --result "${RESULT:-views}" --start "$K" --end "$((K + 1))" --out "${OUT:-recon}" \
  --cap "${CAP:-300000}" --iters-first "${ITERS:-15000}" --sh-degree 1 --aniso 0.05 --peek 0,4,8,12,20 \
  --source-video source-4k.mkv --source-masks masks --source-ignore ignore --source-focal "$FOCAL" \
  --source-weight 3.0 --source-every 1 --source-iters 4000 --face-weight "${FACE:-2.0}" \
  ${HOLDOUT:+--holdout-every "$HOLDOUT"} ${EXTRA:-}
