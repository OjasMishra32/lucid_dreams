#!/bin/bash
#SBATCH --job-name=lucid-digs-sample
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-rtx6000
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
#SBATCH --time=01:00:00
#SBATCH --mail-type=END,FAIL
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# One photo -> an avatar dream bundle with DiGS-Avatar (RTX PRO 6000: setup-digs built the CUDA extensions
# for sm_100/sm_120 only, so not L4). Needs setup-digs and digs-assets first. Override per photo, e.g.
#   sbatch --export=ALL,IMAGE=$L/data/avatars/inputs/grandma.jpg,ID=grandma-01,NAME="Grandma" digs-sample.sbatch
# Only photos of people who agreed (AGENTS.md, Consent).
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
IMAGE=${IMAGE:-$L/data/avatars/inputs/sample.jpg}
ID=${ID:-sample-avatar}
NAME=${NAME:-Sample avatar}
OUT=${OUT:-$L/data/avatars/dreams}
export HF_HOME=$L/cache/hf U2NET_HOME=$L/models/rembg
module load conda/26.7
eval "$(conda shell.bash hook)"
conda activate $L/envs/digs
git -C $L/repos/lucid_dreams pull -q --ff-only
git -C $L/repos/lucid_dreams log -1 --format='lucid_dreams at %h %s'
cd $L/repos/DiGS-Avatar
[ -f "$IMAGE" ] || { echo "no photo at $IMAGE"; exit 1; }
[ -f lib/models/deformers/smplx/SMPLX/SMPLX_NEUTRAL.pkl ] || { echo "run digs-assets.sbatch first"; exit 1; }
nvidia-smi --query-gpu=name,memory.total --format=csv
/usr/bin/time -v python -u $L/repos/lucid_dreams/avatars/digs_avatar.py \
  --image "$IMAGE" --id "$ID" --name "$NAME" --out "$OUT" \
  --nlf $L/models/nlf/nlf_l_multi_0.3.2.patch6.torchscript 2>&1 | grep -v '^\s*$'
ls -la "$OUT/$ID" "$OUT/$ID/avatar" "$OUT/$ID.work"
echo SAMPLE_OK
