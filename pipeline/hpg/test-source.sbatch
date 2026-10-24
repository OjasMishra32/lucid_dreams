#!/bin/bash
#SBATCH --job-name=lucid-test-source
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-b200
#SBATCH --gpus=1
#SBATCH --cpus-per-task=3
#SBATCH --mem=48G
#SBATCH --time=01:00:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# The real-frame view on two frames of a finished run: solves the clip's camera, trains with its 4K crop, and writes
# peek-source-000000.jpg (real frame | render) plus the usual held-out numbers. Compare with jobs/aniso/<run>/0.05.
set -euo pipefail
source /blue/iruchkin/vishalnaveen/lucid/code/pipeline/hpg/env.sh
RUN=${RUN:-$L/runs/jump-shot}
OUT=$L/jobs/source/$(basename $RUN)
rm -rf $OUT && mkdir -p $OUT
python -m lucid.recon --result $RUN/views --start 0 --end 2 --out $OUT --holdout-every 8 --aniso 0.05 \
  --source-video $RUN/prepped.mp4 --peek 0,4,8,12,20
# and the export on those two frames, so the solved camera drives "seen vs imagined"
python -m lucid.export --recon $OUT --out $OUT/bundle --id source-test --name "Source test" --result $RUN/views \
  --clip $RUN/prepped.mp4 --fps 25 --intent ""
python -c "import json; d=json.load(open('$OUT/bundle/dream.json')); print('SOURCE_TEST_OK seen', d['metrics'].get('seenFraction'))"
