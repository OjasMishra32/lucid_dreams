#!/bin/bash
#SBATCH --job-name=court-sam
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-turin,hpg-b200,hpg-rtx6000
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=64G
#SBATCH --time=01:30:00
#SBATCH --output=%x-%j.log
# Court Side: SAM 2.1 large video masks from box/click prompts (court_sam.py run), every set of an upload in one job,
# all objects of a set in one SAM state, forward and backward from its ref frame. Fits an L4 (24 GB), so it takes
# whichever GPU is free first. Submitted by court-hpg.sh with RUN and DATA ($L/data/court/court-sam-<name>: one set, or
# one folder per set, each prompts.json + frames.zip, or + the clip it names: decoded here, and with "matte": true the
# BiRefNet-banded soft edges follow on the same node). Frames and masks live in the node's $TMPDIR; one uncompressed
# tar ([<set>/]masks|prob|alpha/<name>/*.png, report.json, prompts.json) is copied to $RUN. With MASKS_TAR (an earlier
# run's masks-sam.tar) only the matte runs, on those masks: $RUN/masks-alpha.tar. Deletes nothing.
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid; C=$L/code/pipeline/court
module load conda/26.7 cuda/12.8.1 >/dev/null 2>&1
eval "$(conda shell.bash hook)"
conda activate $L/envs/4danyone
source $L/envs/sam2/bin/activate
export SAM2_ROOT=$L/models/sam2 TMPDIR=${TMPDIR:-/tmp} HF_HOME=$L/cache/hf TORCH_HOME=$L/cache/torch
export PYTHONPATH=$L/repos/4DAnyone:${PYTHONPATH:-}   # fdanyone's BiRefNet, for the matte
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
OUT=$TMPDIR/masks-sam
if [ -n "${MASKS_TAR:-}" ]; then  # court-rematte-<name>: only the matte, on an earlier run's masks
  python "$C/court_sam.py" rematte "$DATA" "$MASKS_TAR" "$OUT"
  TAR=masks-alpha.tar
else
  python "$C/court_sam.py" run "$DATA" "$OUT"
  TAR=masks-sam.tar
fi
cd "$RUN"
tar -cf "$TAR.part" -C "$OUT" . && mv "$TAR.part" "$TAR"
ls -l "$TAR"
du -sh "$RUN" "$DATA"
