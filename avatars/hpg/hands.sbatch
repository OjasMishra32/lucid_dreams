#!/bin/bash
#SBATCH --job-name=lucid-hands
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-turin
#SBATCH --gpus=1
#SBATCH --cpus-per-task=3
#SBATCH --mem=16G
#SBATCH --time=00:40:00
#SBATCH --mail-type=END,FAIL
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# Real fingers for an avatar bundle. WiLoR (Potamias et al., CVPR 2025, via the WiLoR-mini package) finds both hands in
# the source photo, or in each sampled frame of a clip, regresses their MANO poses, and the bundle's motion.json gets
# those as SMPL-X finger rotations in place of DiGS's hand mean (a time series for a clip). Where the detector is
# unsure the original hands stay. Adds no likeness, so there is no consent gate.
#   sbatch --export=ALL,BUNDLE=<id>,PHOTO=<photo on HPG>            avatars/hpg/hands.sbatch
#   sbatch --export=ALL,BUNDLE=<id>,VIDEO=<clip on HPG>,START=2.0   avatars/hpg/hands.sbatch
# BUNDLE=<id> is a folder under data/avatars/dreams. Optional: BOX=x0,y0,x1,y1 (the person, so other people's hands
# stay out), START / SPAN / OFFSET (clip times: where the fit reads, how long, and which clip time is the bundle's
# motion frame 0, default START), EVERY=2 (fit every 2nd clip frame), STRENGTH=1 (0-1, how much of a sure fit to use).
# In:  data/avatars/dreams/$BUNDLE; models/mano/MANO_RIGHT.pkl (OUR copy from our own MANO registration
#      https://mano.is.tue.mpg.de, non-commercial: it is never fetched from a mirror, the job stops without it);
#      WiLoR's weights (wilor_final.ckpt, detector.pt, mano_mean_params.npz) are fetched once into models/wilor.
#      Licences: WiLoR's models are CC BY-NC-ND 4.0 (we keep only the poses it outputs), MANO is non-commercial.
# Out: the bundle's avatar/motion.json updated, the original kept as avatar/motion.hands-original.json (a rerun starts
#      from it), hands.json (found / confidence / how much of each hand is the fit). Look for HANDS_OK, then look at the
#      hands in the viewer: a hand that is wrong is a hand with a confident detection and a bad pose.
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
BUNDLE=${BUNDLE:?set BUNDLE to the avatar bundle id, e.g. vishal}
PHOTO=${PHOTO:-}
VIDEO=${VIDEO:-}
[ -n "$PHOTO$VIDEO" ] || { echo "set PHOTO=<photo> or VIDEO=<clip> (on HPG)"; exit 1; }
[ -z "$PHOTO" ] || [ -z "$VIDEO" ] || { echo "set PHOTO or VIDEO, not both"; exit 1; }
DREAMS=${DREAMS:-$L/data/avatars/dreams}
CODE=${CODE:-$L/repos/lucid_dreams/avatars}
V=$L/envs/wilor W=$L/models/wilor MANO=$L/models/mano/MANO_RIGHT.pkl
TMP=${TMPDIR:-/tmp}
export HF_HOME=$TMP/hf TORCH_HOME=$L/cache/torch PIP_NO_CACHE_DIR=1 OMP_NUM_THREADS=${SLURM_CPUS_PER_TASK:-3}
module load conda/26.7 cuda/12.4.1
eval "$(conda shell.bash hook)"
[ "$CODE" = "$L/repos/lucid_dreams/avatars" ] && { flock $L/repos/.lucid_dreams.lock git -C $L/repos/lucid_dreams pull -q --ff-only || echo "repo update skipped"; }
[ -f "$DREAMS/$BUNDLE/dream.json" ] || { echo "no avatar bundle at $DREAMS/$BUNDLE"; exit 1; }
[ -z "$PHOTO" ] || [ -f "$PHOTO" ] || { echo "no photo at $PHOTO"; exit 1; }
[ -z "$VIDEO" ] || [ -f "$VIDEO" ] || { echo "no clip at $VIDEO"; exit 1; }
[ -f "$MANO" ] || { echo "no $MANO: MANO_RIGHT.pkl comes from our own registration at mano.is.tue.mpg.de (non-commercial); put it there. Not fetched from a mirror (its licence forbids redistribution)."; exit 1; }

# 1. env once: a venv layered on envs/lam (torch 2.3 cu121, python 3.10), plus WiLoR-mini and what it pulls in
if [ ! -f $V/.ok ]; then
  [ -d $V ] || $L/envs/lam/bin/python -m venv --system-site-packages $V
  . $V/bin/activate
  pip install -q git+https://github.com/warmshao/WiLoR-mini
  python -c "import torch, wilor_mini, ultralytics, cv2; print('WiLoR env OK, torch', torch.__version__)"
  touch $V/.ok
fi
. $V/bin/activate

# 2. WiLoR's weights once (not MANO): wilor_final.ckpt, detector.pt, mano_mean_params.npz
mkdir -p $W/pretrained_models
for f in wilor_final.ckpt detector.pt mano_mean_params.npz; do
  [ -f $W/pretrained_models/$f ] || python - "$f" "$W" <<'PY'
import sys
from huggingface_hub import hf_hub_download
f, w = sys.argv[1:]
print("fetched", hf_hub_download("warmshao/WiLoR-mini", f, subfolder="pretrained_models", local_dir=w))
PY
done
[ -f $W/pretrained_models/MANO_RIGHT.pkl ] || cp "$MANO" $W/pretrained_models/MANO_RIGHT.pkl
ls -la $W/pretrained_models
export HF_HUB_OFFLINE=1  # from here nothing may download: a missing file must stop the job, not pull a MANO mirror

ARGS=("$DREAMS/$BUNDLE" --weights "$W" --strength "${STRENGTH:-1}" --work "$L/data/avatars/hands/$BUNDLE")
[ -n "$PHOTO" ] && ARGS+=(--photo "$PHOTO")
if [ -n "$VIDEO" ]; then
  ARGS+=(--video "$VIDEO" --every "${EVERY:-2}" --clip-start "${START:-0}")
  [ -n "${SPAN:-}" ] && ARGS+=(--clip-seconds "$SPAN")
  [ -n "${OFFSET:-}" ] && ARGS+=(--clip-offset "$OFFSET")
fi
[ -n "${BOX:-}" ] && ARGS+=(--box "$BOX")
python -u $CODE/fit_hands.py "${ARGS[@]}"
ls -la "$DREAMS/$BUNDLE" "$DREAMS/$BUNDLE/avatar"
echo HANDS_DONE
