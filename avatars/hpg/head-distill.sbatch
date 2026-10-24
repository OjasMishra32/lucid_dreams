#!/bin/bash
#SBATCH --job-name=lucid-head-distill
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-rtx6000,hpg-b200,hpg-turin
#SBATCH --gpus=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=64G
#SBATCH --time=01:30:00
#SBATCH --mail-type=END,FAIL
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# A real face on a consenting person's own avatar, distilled: fresh, opaque SMPL-X-head Gaussians fitted with gsplat to
# their UIKA head's renders (uika-head.sbatch), the frozen body rendered too so the neck seam is fitted in context;
# then blinks and the 20 s living idle (any_face), as for any SMPL-X avatar.
# Consenting people only (AGENTS.md rule 5): the person must be in lucid_avatars/head_swap.py's CONSENTED, the avatar,
# the photos and the teacher their own, the output a new <person>-... id that never replaces another bundle (a head
# swap included), nobody in dreams/.held; the gate runs first, in this script and again in head_distill.py.
# Never a public figure.
#   sbatch --export=ALL,NAME=vishal avatars/hpg/head-distill.sbatch
# AVATAR=<bundle id> another of the person's avatars (default NAME); ID=<new id> (default $AVATAR-head; if that is
# already a LAM head swap it is refused: use ID=$AVATAR-head-2, which the web app also ranks as a head candidate);
# STEPS=5000 the fit's steps; SEAM_OFFSET=0.01 moves the jaw-line seam up 1 cm; KEEP_MOTION=1 keeps the motion.
# In:  data/avatars/dreams/$AVATAR, data/avatars/heads/$NAME/uika (uika-head.sbatch), data/avatars/faces/$NAME (the
#      photo in compare.png and the identity score), SMPLX_NEUTRAL.npz and SMPL-X__FLAME_vertex_ids.npy under
#      models/smplx, FLAME at models/flame (hpg/flame.sh) for the blinks.
# Out: data/avatars/dreams/$ID: the bundle (head last in avatar.ply, skinned from its SMPL-X face), reality.ply,
#      head_distill.json (heldOut.psnr/ssim before and after on teacher views the fit never saw, alignRmsM, opacity,
#      offsets, identity), compare.png (photo | old face | teacher | distilled, front and 3/4), preview.mp4 + thumb.jpg,
#      and from any_face: avatar/expr.bin (blinks), the living idle, face.json.
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
NAME=${NAME:?set NAME to the consenting person, e.g. vishal}
AVATAR=${AVATAR:-$NAME}
NEW=${ID:-$AVATAR-head}
SMPLX_DIR=${SMPLX_DIR:-$L/models/smplx}
DREAMS=$L/data/avatars/dreams TEACHER=$L/data/avatars/heads/$NAME/uika FACES=$L/data/avatars/faces/$NAME
AV=$L/repos/lucid_dreams/avatars
flock $L/repos/.lucid_dreams.lock git -C $L/repos/lucid_dreams pull -q --ff-only || echo "repo update skipped"
git -C $L/repos/lucid_dreams log -1 --format='lucid_dreams at %h %s'

# 4DAnyone env: numpy for the gate and the bundle, gsplat for the fit and the renders
set +u; source $L/code/pipeline/hpg/env.sh; set -u
export PYTHONPATH=$AV:$PYTHONPATH

# 0. the consent gate, before anything is read (REFUSED stops the job here)
python -u -m lucid_avatars distill-check "$DREAMS/$AVATAR" --person "$NAME" --teacher "$TEACHER" --id "$NEW"

NPZ=$(find -L "$SMPLX_DIR" -maxdepth 4 -name SMPLX_NEUTRAL.npz | head -1)
IDS=$(find -L "$SMPLX_DIR" -maxdepth 4 -name 'SMPL-X__FLAME_vertex_ids.npy' | head -1)
[ -n "$NPZ" ] || { echo "no SMPLX_NEUTRAL.npz under $SMPLX_DIR"; exit 1; }
[ -n "$IDS" ] || { echo "no SMPL-X__FLAME_vertex_ids.npy under $SMPLX_DIR (SMPL-X site, model-transfer download)"; exit 1; }
[ -f "$DREAMS/$AVATAR/dream.json" ] || { echo "no avatar bundle at $DREAMS/$AVATAR (digs-sample.sbatch ID=$NAME)"; exit 1; }
[ -f "$TEACHER/views/cameras.json" ] && [ -f "$TEACHER/flame.npy" ] \
  || { echo "no UIKA teacher in $TEACHER (uika-head.sbatch NAME=$NAME)"; exit 1; }

# FLAME for the blinks, once (hpg/flame.sh; sets FLAME_NPZ)
source $AV/hpg/flame.sh

nvidia-smi --query-gpu=name,memory.total --format=csv

# 1. the distill (GPU): gate again, align, cut, seed, fit, bundle, compare.png, turntable, identity
mkdir -p $L/models/insightface
python -u $AV/head_distill.py --person "$NAME" --avatar "$DREAMS/$AVATAR" --teacher "$TEACHER" --photos "$FACES" \
  --smplx "$NPZ" --flame-ids "$IDS" --id "$NEW" --seam-offset "${SEAM_OFFSET:-0}" ${STEPS:+--steps "$STEPS"} \
  --insightface-root $L/models/insightface

# 2. blinks and the living idle: the new head is SMPL-X's own surface, so any_face fits the blink to its eyelids
KEEP=()
[ "${KEEP_MOTION:-0}" = 1 ] && KEEP=(--keep-motion)
if [ -f "$FLAME_NPZ" ]; then
  python -u -m lucid_avatars blink "$DREAMS/$NEW" --smplx "$NPZ" --flame-ids "$IDS" --flame-expr "$FLAME_NPZ" \
    ${KEEP[@]+"${KEEP[@]}"} || echo "[expr] the blink step failed (above): $NEW has no blinks"
else
  echo "[expr] no $FLAME_NPZ: NO BLINKS for $NEW"
fi

python -u -m lucid_avatars validate "$DREAMS/$NEW"
ls -la "$DREAMS/$NEW"
echo "look at $DREAMS/$NEW/compare.png; head_distill.json heldOut.psnr (after vs psnrBefore), opacity, alignRmsM"
echo HEAD_DISTILL_OK
