#!/bin/bash
#SBATCH --job-name=lucid-digs-perform
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-rtx6000
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
#SBATCH --time=01:00:00
#SBATCH --mail-type=END,FAIL
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# "You, perfected": an avatar (code.pt from digs-sample or digs-finetune) performs the move from a replay run.
#   sbatch --export=ALL,AVATAR=$L/data/avatars/dreams/vishal.work/code.pt,RUN_ID=<pro clip run>,ID=vishal-jumper,NAME="Vishal, the jumper" avatars/hpg/digs-perform.sbatch
# Only consented avatars; a public figure's clip lends its motion only (AGENTS.md, Consent).
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
: "${AVATAR:?set AVATAR to a code.pt}" "${RUN_ID:?set RUN_ID to the run whose move to play}" "${ID:?set ID}"
NAME=${NAME:-$ID}
OUT=${OUT:-$L/data/avatars/dreams}
AV=$L/repos/lucid_dreams/avatars
MOTION=$L/data/avatars/motions/$RUN_ID.json
mkdir -p "$OUT" "$(dirname "$MOTION")"
git -C $L/repos/lucid_dreams pull -q --ff-only
if [ ! -f "$MOTION" ]; then  # 4DAnyone env in a subshell, so nothing of it reaches the DiGS step
  ( set +u; source $L/code/pipeline/hpg/env.sh; set -u
    cd $L/repos/4DAnyone
    python -u $AV/gvhmr_motion.py --gvhmr "$L/runs/$RUN_ID/views/gvhmr" --out "$MOTION" )
fi
module load conda/26.7
eval "$(conda shell.bash hook)"
conda activate $L/envs/digs
export HF_HOME=$L/cache/hf
cd $L/repos/DiGS-Avatar
python -u $AV/digs_perform.py --start "$AVATAR" --motion "$MOTION" --out "$OUT" --id "$ID" --name "$NAME"
ls -la "$OUT/$ID" "$OUT/$ID/avatar"
echo PERFORM_OK
