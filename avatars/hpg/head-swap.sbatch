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
# 0. FLAME (blinks), once. LAM is retired and its repo deleted, so FLAME's two files come on their own from LAM's
#    public assets (3DAIGC/LAM-assets, LAM_human_model.tar) through node-local space into models/flame; this env reads
#    FLAME's chumpy pickle without chumpy. Nothing of FLAME's leaves HiPerGator (its licence).
FL=$L/models/flame
FLAME_NPZ=$FL/flame2023_expr.npz
if [ ! -f "$FLAME_NPZ" ]; then
  mkdir -p "$FL"
  if [ ! -f "$FL/flame2023.pkl" ] || [ ! -f "$FL/FLAME_masks.pkl" ]; then
    X=${TMPDIR:-/tmp}/lam-human-$$
    mkdir -p "$X"
    echo "[expr] fetching FLAME 2023 from 3DAIGC/LAM-assets (LAM_human_model.tar, node-local, deleted after)"
    if HF_HOME=$X/hf huggingface-cli download 3DAIGC/LAM-assets LAM_human_model.tar --local-dir "$X" >/dev/null; then
      WANT=$(tar -tf "$X/LAM_human_model.tar" | grep -E 'flame_assets/flame/(flame2023|FLAME_masks)\.pkl$' || true)
      # shellcheck disable=SC2086  # two plain member paths
      [ -n "$WANT" ] && tar -xf "$X/LAM_human_model.tar" -C "$X" $WANT \
        && find "$X" \( -name flame2023.pkl -o -name FLAME_masks.pkl \) -exec cp {} "$FL/" \;
    fi
    rm -rf "$X"
  fi
  if [ -f "$FL/flame2023.pkl" ] && [ -f "$FL/FLAME_masks.pkl" ]; then
    TMP_NPZ=$FLAME_NPZ.tmp.$$.npz  # written whole, then moved: a killed or concurrent job never leaves half a file
    if python $AV/flame_expr_npz.py "$FL/flame2023.pkl" "$FL/FLAME_masks.pkl" "$TMP_NPZ"
    then mv -f "$TMP_NPZ" "$FLAME_NPZ"
    else rm -f "$TMP_NPZ"; echo "[expr] FLAME extract FAILED (see above): NO BLINKS for this head"
    fi
  else
    echo "[expr] NO FLAME: $FL/flame2023.pkl or FLAME_masks.pkl missing and the download failed: NO BLINKS"
  fi
fi
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
