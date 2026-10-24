#!/bin/bash
#SBATCH --job-name=lucid-install-demucs
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --time=00:30:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# Voice isolation for export (Demucs htdemucs, vocals vs the rest) in the 4DAnyone env, without touching its PyTorch:
# torchaudio is pinned to the installed torch build first, so pip has nothing to upgrade. Caches the model weights.
set -euo pipefail
source /blue/iruchkin/vishalnaveen/lucid/code/pipeline/hpg/env.sh
TORCH=$(python -c 'import torch; print(torch.__version__.split("+")[0])')
python -c 'import torchaudio' 2>/dev/null || pip install -q "torchaudio==$TORCH" --index-url https://download.pytorch.org/whl/cu128
pip install -q demucs
python - <<'PY'
import torch, torchaudio
from demucs.pretrained import get_model
get_model("htdemucs")
print("torch", torch.__version__, "torchaudio", torchaudio.__version__, "htdemucs cached")
PY
echo DEMUCS_OK
