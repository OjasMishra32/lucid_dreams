#!/bin/bash
#SBATCH --job-name=court-masks
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-turin,hpg-b200,hpg-rtx6000
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32G
#SBATCH --time=01:30:00
#SBATCH --output=%x-%j.log
# Court Side: every floor-level person's instance mask, ids kept, with SAM 2.1 large (layers' sam_people.py, uploaded
# with its frames and plan so the exact tested copy runs). Fits an L4 (24 GB), so it takes whichever GPU is free first.
# Submitted by court-hpg.sh with RUN and DATA ($L/data/court/court-sam-people: frames.zip, plan.json, sam_people.py).
# Frames are unpacked and masks written on the node's $TMPDIR; only one uncompressed tar of the PNGs
# (label/ 16-bit ids, prob/ 8-bit soft edges, objects.json, log.txt) is copied to $RUN. Nothing on Blue is deleted.
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
module load conda/26.7 cuda/12.8.1 >/dev/null 2>&1
eval "$(conda shell.bash hook)"
conda activate $L/envs/4danyone
source $L/envs/sam2/bin/activate
export SAM2_ROOT=$L/models/sam2 TMPDIR=${TMPDIR:-/tmp}
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
OUT=$TMPDIR/masks-people
python "$DATA/sam_people.py" "$DATA/frames.zip" "$DATA/plan.json" "$OUT" --model large --chunk "${CHUNK:-32}"
cd "$RUN"
tar -cf masks-people.tar.part -C "$OUT" . && mv masks-people.tar.part masks-people.tar
ls -l masks-people.tar
du -sh "$RUN" "$DATA"
