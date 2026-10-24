#!/bin/bash
#SBATCH --job-name=lucid-head-swap
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-rtx6000,hpg-b200,hpg-turin
#SBATCH --gpus=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32G
#SBATCH --time=00:30:00
#SBATCH --mail-type=END,FAIL
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# A real face on a consenting person's avatar: LAM's one-photo head (lam-head.sbatch) in place of DiGS's guessed one.
# Consenting people only (AGENTS.md rule 5): the person must be in lucid_avatars/head_swap.py's CONSENTED, the avatar
# must be their own, and neither may be in dreams/.held; otherwise it stops before touching anything. Never a
# public figure.
#   sbatch --export=ALL,NAME=vishal avatars/hpg/head-swap.sbatch
# AVATAR=<bundle id> picks another of the person's avatars (default NAME, e.g. AVATAR=vishal-tuned); PHOTO=<stem>
# picks which LAM head (default the first); SEAM_OFFSET=0.01 moves the jaw-line seam up 1 cm.
# In:  data/avatars/dreams/$AVATAR (digs-sample ID=$NAME), data/avatars/heads/$NAME/{heads,colour} (lam-head),
#      SMPLX_NEUTRAL.npz and SMPL-X__FLAME_vertex_ids.npy under models/smplx (SMPLX_DIR=... for elsewhere).
# Out: data/avatars/dreams/$AVATAR-head: the bundle, with preview.mp4 + thumb.jpg of the new face, head_swap.json
#      (fit, seam, counts, identity, the blink's fit) and compare.png (photo | old face | new face, front and 3/4).
#      With FLAME (fetched once into models/flame, extracted to flame2023_expr.npz) it also gets avatar/expr.bin
#      (expressions + this face's blink), the 20 s living idle that blinks, and blink.png (open | shut, eyes zoomed).
#      KEEP_MOTION=1 keeps the source's motion.json.
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
NAME=${NAME:?set NAME to the consenting person, e.g. vishal}
AVATAR=${AVATAR:-$NAME}
SMPLX_DIR=${SMPLX_DIR:-$L/models/smplx}
DREAMS=$L/data/avatars/dreams HEADS=$L/data/avatars/heads/$NAME
AV=$L/repos/lucid_dreams/avatars
flock $L/repos/.lucid_dreams.lock git -C $L/repos/lucid_dreams pull -q --ff-only || echo "repo update skipped"
git -C $L/repos/lucid_dreams log -1 --format='lucid_dreams at %h %s'

NPZ=$(find -L "$SMPLX_DIR" -maxdepth 4 -name SMPLX_NEUTRAL.npz | head -1)
IDS=$(find -L "$SMPLX_DIR" -maxdepth 4 -name 'SMPL-X__FLAME_vertex_ids.npy' | head -1)
[ -n "$NPZ" ] || { echo "no SMPLX_NEUTRAL.npz under $SMPLX_DIR"; exit 1; }
[ -n "$IDS" ] || { echo "no SMPL-X__FLAME_vertex_ids.npy under $SMPLX_DIR (SMPL-X site, model-transfer download)"; exit 1; }
[ -f "$DREAMS/$AVATAR/dream.json" ] || { echo "no avatar bundle at $DREAMS/$AVATAR (digs-sample.sbatch ID=$NAME)"; exit 1; }
ls "$HEADS"/heads/*_gs_offset.ply >/dev/null || { echo "no LAM head in $HEADS/heads (lam-head.sbatch NAME=$NAME)"; exit 1; }

# 4DAnyone env: numpy for the swap, gsplat for the renders
set +u; source $L/code/pipeline/hpg/env.sh; set -u
export PYTHONPATH=$AV:$PYTHONPATH
# 0. FLAME for blinks, once (hpg/flame.sh)
source $AV/hpg/flame.sh
EXPR=()
if [ -f "$FLAME_NPZ" ]; then EXPR=(--flame-expr "$FLAME_NPZ"); else echo "[expr] no $FLAME_NPZ: no expr.bin, NO BLINKS"; fi
[ "${KEEP_MOTION:-0}" = 1 ] && EXPR+=(--keep-motion)

nvidia-smi --query-gpu=name,memory.total --format=csv

# 1. the swap (CPU, numpy): refuses unless consented, writes and validates $AVATAR-head
python -u -m lucid_avatars head-swap "$DREAMS/$AVATAR" "$HEADS/heads" --person "$NAME" --smplx "$NPZ" \
  --flame-ids "$IDS" ${PHOTO:+--photo "$PHOTO"} --seam-offset "${SEAM_OFFSET:-0}" --id "$AVATAR-head" \
  ${EXPR[@]+"${EXPR[@]}"}

# 2. the new face on the GPU: turntable, side-by-side with the photo, identity
mkdir -p $L/models/insightface
python -u $AV/head_swap_render.py --old "$DREAMS/$AVATAR" --new "$DREAMS/$AVATAR-head" --photos "$HEADS/colour" \
  --person "$NAME" --insightface-root $L/models/insightface
ls -la "$DREAMS/$AVATAR-head"
echo HEAD_SWAP_OK
