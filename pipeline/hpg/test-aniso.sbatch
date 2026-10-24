#!/bin/bash
#SBATCH --job-name=lucid-test-aniso
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-b200,hpg-rtx6000
#SBATCH --gpus=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32G
#SBATCH --time=01:00:00
#SBATCH --array=0-2
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%A_%a.log
# A/B for the stretch penalty: frame 0 of a finished run, one weight per array task, every 8th view held out so the
# numbers are honest. Writes jobs/aniso/<run>/<weight>/peek-000000.jpg (truth | render, front, sides, back).
set -euo pipefail
source /blue/iruchkin/vishalnaveen/lucid/code/pipeline/hpg/env.sh
RUN=${RUN:-$L/runs/jump-shot}
W=(0 0.05 0.2)
w=${W[$SLURM_ARRAY_TASK_ID]}
OUT=$L/jobs/aniso/$(basename $RUN)/$w
mkdir -p $OUT
python -m lucid.recon --result $RUN/views --start 0 --end 1 --out $OUT --holdout-every 8 --aniso $w --peek 0,4,8,12,20
