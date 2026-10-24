#!/bin/bash
#SBATCH --job-name=lucid-avatar-preview
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-turin
#SBATCH --gpus=1
#SBATCH --cpus-per-task=3
#SBATCH --mem=16G
#SBATCH --time=00:30:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# An avatar bundle's card preview on black, from its front (avatars/avatar_preview.py), in the LHM++ env on an L4.
#   sbatch --export=ALL,BUNDLE=vishal-lhm avatars/hpg/avatar-preview.sbatch
# Out: data/avatars/dreams/$BUNDLE/preview.mp4 + thumb.jpg (replaced). Ends PREVIEW_OK.
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
BUNDLE=${BUNDLE:?set BUNDLE to an avatar bundle id}
D=${DREAMS:-$L/data/avatars/dreams}/$BUNDLE
CODE=${CODE:-$L/code/avatars}
[ -f "$D/dream.json" ] || { echo "no bundle at $D"; exit 1; }
module load conda/26.7 cuda/12.4.1 gcc/12.2.0
. $L/envs/lhmpp/bin/activate
cd $L/repos/LHM-plusplus
python -u $CODE/avatar_preview.py "$D" ${PREVIEW_ARGS:-}
