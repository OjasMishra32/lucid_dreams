#!/bin/bash
#SBATCH --job-name=lucid-digs-finetune
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-rtx6000
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=96G
#SBATCH --time=02:00:00
#SBATCH --mail-type=END,FAIL
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# The research claim: a one-photo DiGS avatar of the person in a finished replay run, fine-tuned on that run's
# 4DAnyone views, with PSNR / SSIM / LPIPS on 4 held-out views before and after. Needs digs-assets first.
#   sbatch --export=ALL,RUN_ID=<run id> avatars/hpg/digs-finetune.sbatch
# Writes $OUT/: motion_world.json, views/ (8 frames x every view, cut out), photo.jpg, and dreams/<run>-photo and
# dreams/<run>-tuned (bundles); the numbers are in dreams/<run>-tuned.work/results.md. Only consented people.
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
: "${RUN_ID:?set RUN_ID to a finished replay run}"
RUN=$L/runs/$RUN_ID
OUT=${OUT:-$L/data/avatars/finetune/$RUN_ID}
AV=$L/repos/lucid_dreams/avatars
FRAMES=${FRAMES:-8}
STEPS=${STEPS:-800}
mkdir -p "$OUT/dreams"
flock $L/repos/.lucid_dreams.lock git -C $L/repos/lucid_dreams pull -q --ff-only || echo "repo update skipped"
git -C $L/repos/lucid_dreams log -1 --format='lucid_dreams at %h %s'
[ -f "$RUN/views/cameras.json" ] && [ -d "$RUN/views/gvhmr" ] || { echo "$RUN/views has no 4DAnyone result yet"; exit 1; }
nvidia-smi --query-gpu=name,memory.total --format=csv

# 1. 4DAnyone env, in a subshell so none of its modules or paths reach step 2: the clip's motion in the views'
#    world, and the views cut out (kept for reruns).
(
  set +u; source $L/code/pipeline/hpg/env.sh; set -u
  cd $L/repos/4DAnyone
  python -u $AV/gvhmr_motion.py --gvhmr "$RUN/views/gvhmr" --out "$OUT/motion_world.json"
  [ -f "$OUT/views/cameras.json" ] || python -u $AV/prep_views.py --result "$RUN/views" --out "$OUT/views" --frames $FRAMES
)

# 2. DiGS env, set up exactly as digs-sample: the one-photo avatar from the clip 4DAnyone used (prepped.mp4: trimmed
#    and cropped to the person), then the fine-tune.
module load conda/26.7
eval "$(conda shell.bash hook)"
conda activate $L/envs/digs
export HF_HOME=$L/cache/hf U2NET_HOME=$L/models/rembg TORCH_HOME=$L/cache/torch
SRC=$( [ -f "$RUN/prepped.mp4" ] && echo "$RUN/prepped.mp4" || ls "$RUN"/input.* | head -1 )
ffmpeg -loglevel error -y -i "$SRC" -frames:v 1 "$OUT/photo.jpg"
cd $L/repos/DiGS-Avatar
python -u $AV/digs_avatar.py --image "$OUT/photo.jpg" --id "$RUN_ID-photo" --name "$RUN_ID (one photo)" \
  --out "$OUT/dreams" --nlf $L/models/nlf/nlf_l_multi_0.3.2.patch6.torchscript
python -u $AV/digs_finetune.py --views "$OUT/views" --motion "$OUT/motion_world.json" \
  --start "$OUT/dreams/$RUN_ID-photo.work/code.pt" --out "$OUT/dreams" --id "$RUN_ID-tuned" \
  --name "$RUN_ID (fine-tuned)" --steps $STEPS
cat "$OUT/dreams/$RUN_ID-tuned.work/results.md"
du -sh "$OUT"
echo FINETUNE_OK
