#!/bin/bash
#SBATCH --job-name=lucid-setup-digs
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=8
#SBATCH --mem=48G
#SBATCH --time=04:00:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# Builds the DiGS-Avatar environment for Blackwell GPUs (B200 sm_100, RTX PRO 6000 sm_120) and pulls its public weights.
# CUDA extensions (pytorch3d, simple-knn, diff-gaussian-rasterization) compile here on CPU with nvcc 12.8.
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
export HF_HOME=$L/cache/hf PIP_CACHE_DIR=$L/cache/pip CONDA_PKGS_DIRS=$L/cache/conda-pkgs
export TORCH_CUDA_ARCH_LIST="10.0;12.0" FORCE_CUDA=1 MAX_JOBS=8
module load conda/26.7 cuda/12.8.1
eval "$(conda shell.bash hook)"
[ -d $L/envs/digs ] || mamba create -y -q -p $L/envs/digs -c conda-forge python=3.11 ffmpeg
conda activate $L/envs/digs
pip install -q torch==2.8.* torchvision==0.23.* torchaudio==2.8.* --index-url https://download.pytorch.org/whl/cu128
cd $L/repos/DiGS-Avatar
grep -vE '^(torch|torchvision|torchaudio|pytorch3d|simple-knn|xformers)\s*$' requirements.txt > /tmp/digs-req.txt
pip install -q -r /tmp/digs-req.txt
# what DiGS imports but its requirements miss; mmcv-lite: the full mmcv has no wheel for torch 2.8 / cu128
pip install -q mmengine mmcv-lite pytz ipdb
pip install -q xformers==0.0.32.post2 --index-url https://download.pytorch.org/whl/cu128 || echo "xformers wheel missing; continuing"
python -c "import pytorch3d" 2>/dev/null || pip install -q --no-build-isolation "git+https://github.com/facebookresearch/pytorch3d.git"
python -c "import simple_knn" 2>/dev/null || pip install -q --no-build-isolation "git+https://github.com/camenduru/simple-knn.git"
python -c "import diff_gaussian_rasterization" 2>/dev/null || pip install -q --no-build-isolation "git+https://github.com/graphdeco-inria/diff-gaussian-rasterization.git"
pip install -q gdown
pip install -q --no-build-isolation -e .
python - <<'PY'
from huggingface_hub import snapshot_download
for repo in ["Efficient-Large-Model/Sana_Sprint_1.6B_1024px", "mit-han-lab/dc-ae-f32c32-sana-1.1", "yiyuzhuang/IDOL"]:
    print(repo, snapshot_download(repo))
PY
mkdir -p checkpoints
[ -f checkpoints/student.ckpt ] || gdown "https://drive.google.com/uc?id=1r4S8JQgAT8ARrjG2VDjxxb6YS0CYwr0U" -O checkpoints/student.ckpt
python -c "import torch, pytorch3d, simple_knn, diff_gaussian_rasterization; print('imports OK', torch.__version__)"
du -sh $L/envs/digs $L/cache/hf checkpoints
echo SETUP_OK
