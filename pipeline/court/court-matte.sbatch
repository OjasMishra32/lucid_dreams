#!/bin/bash
#SBATCH --job-name=court-matte
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-turin,hpg-b200,hpg-rtx6000
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32G
#SBATCH --time=00:45:00
#SBATCH --output=%x-%j.log
# Court Side: soft edges for the pair's SAM 2.1 masks (court_matte.py run): the BiRefNet model 4DAnyone ships, kept
# only in a thin band around SAM's edge. Fits an L4, so it takes whichever GPU is free first. Submitted by court-hpg.sh
# with RUN and DATA ($L/data/court/court-matte: crops.zip from `court_matte.py pack` on the Mac). Writes on the node's
# $TMPDIR and copies one uncompressed tar (alpha/<name>/NNNNNN.png crops, index.json, report.json) to $RUN.
# Nothing is deleted.
set -euo pipefail
L=${L:-/blue/iruchkin/vishalnaveen/lucid}; C=$L/code/pipeline/court  # L: court-hpg.sh passes it
source "${ENV_SH:-$L/code/pipeline/hpg/env.sh}"
export TMPDIR=${TMPDIR:-/tmp}
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
OUT=$TMPDIR/matte
python "$C/court_matte.py" run "$DATA/crops.zip" "$OUT"
cd "$RUN"
tar -cf masks-matte.tar.part -C "$OUT" . && mv masks-matte.tar.part masks-matte.tar
ls -l masks-matte.tar
du -sh "$RUN" "$DATA"
