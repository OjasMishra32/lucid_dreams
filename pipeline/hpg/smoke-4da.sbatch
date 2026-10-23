#!/bin/bash
#SBATCH --job-name=lucid-smoke-4da
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-b200
#SBATCH --gpus=1
#SBATCH --cpus-per-task=16
#SBATCH --mem=128G
#SBATCH --time=01:00:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# First real run on a B200: the repo's example clip at 6 views, timed.
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
export HF_HOME=$L/cache/hf
module load conda/26.7
eval "$(conda shell.bash hook)"
conda activate $L/envs/4danyone
cd $L/repos/4DAnyone
nvidia-smi --query-gpu=name,memory.total --format=csv
CLIP=$(ls data/source/pexels/*.mp4 | head -1)
NAME=$(basename "$CLIP" .mp4)
/usr/bin/time -v python inference.py --video_path "$CLIP" --output_dir "$L/data/out/smoke/$NAME" --views_per_layer 6 2>&1 | tail -40
ls -la "$L/data/out/smoke/$NAME"
echo SMOKE_OK
