#!/bin/bash
#SBATCH --job-name=lucid-blink
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --time=00:20:00
#SBATCH --mail-type=END,FAIL
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# Blinks and the 20 s living idle for ANY SMPL-X avatar bundle (a DiGS photo avatar, an LHM++ one), in place. CPU only.
# SMPL-X's head has FLAME's topology, so no LAM head is needed: the blink is fitted to the avatar's own eyelids.
#   sbatch --export=ALL,BUNDLE=<id> avatars/hpg/blink.sbatch
# BUNDLE=<id> is a folder under data/avatars/dreams (digs-sample's, digs-finetune's, lhmpp-avatar's, ...). It stops
# if the id is in dreams/.held. It adds no likeness, so there is no consent gate. KEEP_MOTION=1 keeps the bundle's
# motion.json (a performance or a fine-tune's clip is always kept).
# In:  data/avatars/dreams/$BUNDLE, SMPLX_NEUTRAL.npz and SMPL-X__FLAME_vertex_ids.npy under models/smplx
#      (SMPLX_DIR=... for elsewhere), FLAME's expressions at models/flame/flame2023_expr.npz (extracted once below).
# Out: the same bundle, updated: the Gaussians reordered head-last (skin.bin and reality.ply with them),
#      avatar/expr.bin + exprChannels, the living idle, and face.json (the blink's openFraction, counts).
#      Running it twice changes nothing. Check the log for OK, and face.json expr.blink.openFraction near 0.
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
BUNDLE=${BUNDLE:?set BUNDLE to the avatar bundle id, e.g. vishal}
SMPLX_DIR=${SMPLX_DIR:-$L/models/smplx}
DREAMS=$L/data/avatars/dreams
AV=$L/repos/lucid_dreams/avatars
flock $L/repos/.lucid_dreams.lock git -C $L/repos/lucid_dreams pull -q --ff-only || echo "repo update skipped"
git -C $L/repos/lucid_dreams log -1 --format='lucid_dreams at %h %s'

NPZ=$(find -L "$SMPLX_DIR" -maxdepth 4 -name SMPLX_NEUTRAL.npz | head -1)
IDS=$(find -L "$SMPLX_DIR" -maxdepth 4 -name 'SMPL-X__FLAME_vertex_ids.npy' | head -1)
[ -n "$NPZ" ] || { echo "no SMPLX_NEUTRAL.npz under $SMPLX_DIR"; exit 1; }
[ -n "$IDS" ] || { echo "no SMPL-X__FLAME_vertex_ids.npy under $SMPLX_DIR (SMPL-X site, model-transfer download)"; exit 1; }
[ -f "$DREAMS/$BUNDLE/dream.json" ] || { echo "no avatar bundle at $DREAMS/$BUNDLE"; exit 1; }

# numpy only: the 4DAnyone env (any env with numpy works)
set +u; source $L/code/pipeline/hpg/env.sh; set -u
export PYTHONPATH=$AV:$PYTHONPATH

# 0. FLAME for blinks, once (hpg/flame.sh)
source $AV/hpg/flame.sh
[ -f "$FLAME_NPZ" ] || { echo "no $FLAME_NPZ: NO BLINKS, nothing to do"; exit 1; }

KEEP=()
[ "${KEEP_MOTION:-0}" = 1 ] && KEEP=(--keep-motion)
python -u -m lucid_avatars blink "$DREAMS/$BUNDLE" --smplx "$NPZ" --flame-ids "$IDS" --flame-expr "$FLAME_NPZ" \
  ${KEEP[@]+"${KEEP[@]}"}
ls -la "$DREAMS/$BUNDLE" "$DREAMS/$BUNDLE/avatar"
echo BLINK_OK
