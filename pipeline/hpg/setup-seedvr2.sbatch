#!/bin/bash
#SBATCH --job-name=lucid-setup-seedvr2
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --time=01:00:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# SeedVR2 (ByteDance-Seed, Apache-2.0, one-step diffusion video restoration) for the "upscale" stage, run through
# numz's standalone CLI (ComfyUI-SeedVR2_VideoUpscaler, Apache-2.0: SDPA attention, no flash-attn or apex, no ComfyUI).
# Disk: a small venv layered on the 4danyone env (reuses its torch 2.8 + cu128) and the 3B fp16 DiT + VAE (~7.5 GB).
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
export PIP_CACHE_DIR=${TMPDIR:-/tmp}/pip HF_HOME=${TMPDIR:-/tmp}/hf HF_HUB_DISABLE_XET=1
module load conda/26.7 cuda/12.8.1
eval "$(conda shell.bash hook)"
conda activate $L/envs/4danyone
REPO=$L/repos/SeedVR2-cli
[ -d $REPO ] || git clone -q https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler.git $REPO
git -C $REPO checkout -q 4490bd1   # v2.5.23+, Dec 2025
[ -x $L/envs/seedvr2/bin/python ] || python -m venv --system-site-packages $L/envs/seedvr2
source $L/envs/seedvr2/bin/activate
# torch, opencv, numpy, einops, omegaconf, safetensors come from 4danyone; only these land in the venv
pip install -q "diffusers>=0.33.1" "peft>=0.17.0" "rotary_embedding_torch>=0.5.3" gguf
python - <<'PY'
import hashlib, os
from huggingface_hub import hf_hub_download
d = "/blue/iruchkin/vishalnaveen/lucid/models/seedvr2"
want = {"seedvr2_ema_3b_fp16.safetensors": "2fd0e03a3dad24e07086750360727ca437de4ecd456f769856e960ae93e2b304",
        "ema_vae_fp16.safetensors": "20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1"}
for name, sha in want.items():
    p = os.path.join(d, name)
    if not os.path.exists(p):
        hf_hub_download("numz/SeedVR2_comfyUI", name, local_dir=d)
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 24), b""):
            h.update(b)
    assert h.hexdigest() == sha, f"{name}: sha256 mismatch"
    print(name, os.path.getsize(p) // 2**20, "MB, sha256 ok")
PY
python -c "import torch, diffusers, peft, rotary_embedding_torch, cv2; print('imports OK', torch.__version__, diffusers.__version__)"
du -sh $L/envs/seedvr2 $L/models/seedvr2
echo SETUP_OK
