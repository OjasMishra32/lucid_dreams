#!/bin/bash
#SBATCH --job-name=court-rife
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-b200,hpg-rtx6000
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32G
#SBATCH --time=00:45:00
#SBATCH --output=%x-%j.log
# Court Side show bake: RIFE in-betweens. Everything runs in node-local scratch ($TMPDIR, wiped by Slurm): stages the
# uploaded frames.tar + needs.json and the Practical-RIFE model in, writes every listed in-between, copies only the
# results (the images, needs.json, checks.json, done.json) to $L/runs/$ID/out/. Reads $L/data/court/$ID/ in place,
# writes nothing else on /blue, deletes nothing on /blue.
# Env: ID (court-rife), RIFE ($L/models/rife/Practical-RIFE, from rife_setup.sh), FP16 (0), QUALITY (93).
set -euo pipefail
L=${L:-/blue/iruchkin/vishalnaveen/lucid}
ID=${ID:-court-rife}
[[ $ID =~ ^court-rife[a-z0-9-]*$ ]] || { echo "rife.sbatch: bad id '$ID'" >&2; exit 1; }
DATA=$L/data/court/$ID; OUTD=$L/runs/$ID/out
RIFE=${RIFE:-$L/models/rife/Practical-RIFE}
CODE=$L/code/pipeline/court/bake/hpg
S=${TMPDIR:-/tmp}/court-rife-${SLURM_JOB_ID:-$$}
log() { echo "[rife-job $(date +%T)] $*"; }
for f in "$DATA/frames.tar" "$DATA/needs.json" "$RIFE/train_log/flownet.pkl" "$RIFE/model/warplayer.py" "$CODE/rife_run.py"; do
  [[ -s $f ]] || { log "missing $f"; exit 1; }
done
[[ -e $OUTD/done.json ]] && { log "$OUTD/done.json exists: use a new ID (nothing overwritten)"; exit 1; }
mkdir -p "$S" "$OUTD"
trap 'cd /; rm -rf "$S"' EXIT  # our own scratch only
log "$ID on $(hostname), job ${SLURM_JOB_ID:-local}: $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1)"

module load conda/26.7 cuda/12.8.1
eval "$(conda shell.bash hook)"
conda activate "$L/envs/4danyone"
python -c "import torch, numpy; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())"

mkdir -p "$S/frames" "$S/out"
tar -xf "$DATA/frames.tar" -C "$S/frames"
cp "$DATA/needs.json" "$S/needs.json"
cp -r "$RIFE" "$S/rife"
log "staged $(ls "$S/frames" | wc -l) frames, $(du -sh "$S/frames" | cut -f1)"

ARGS=(--rife "$S/rife" --frames "$S/frames" --needs "$S/needs.json" --out "$S/out" --quality "${QUALITY:-93}")
[[ ${FP16:-0} == 1 ]] && ARGS+=(--fp16)
python "$CODE/rife_run.py" "${ARGS[@]}"

cp "$S/out/"* "$OUTD/"
log "results: $(ls "$OUTD" | wc -l) files, $(du -sh "$OUTD" | cut -f1) in $OUTD"
grep -h '' "$OUTD/done.json"
