#!/bin/bash
#SBATCH --job-name=lucid-setup-4da
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin-b
#SBATCH --cpus-per-task=16
#SBATCH --mem=64G
#SBATCH --time=04:00:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# Builds the 4DAnyone environment (PyTorch 2.8 cu128 for Blackwell GPUs) and pulls its weights and example clip.
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
export HF_HOME=$L/cache/hf PIP_CACHE_DIR=$L/cache/pip CONDA_PKGS_DIRS=$L/cache/conda-pkgs
module load conda/26.7
eval "$(conda shell.bash hook)"
[ -d $L/envs/4danyone ] || mamba create -y -q -p $L/envs/4danyone -c conda-forge python=3.11 ffmpeg
conda activate $L/envs/4danyone
pip install -q torch==2.8.* torchvision==0.23.* --index-url https://download.pytorch.org/whl/cu128
cd $L/repos/4DAnyone
pip install -q -r requirements.txt
python scripts/download_smplx.py
python scripts/download_model.py
python scripts/download_example.py
python -c "import torch; print('torch', torch.__version__, 'cuda', torch.version.cuda, 'archs', torch.cuda.get_arch_list())"
du -sh $L/envs/4danyone $L/cache/hf $L/repos/4DAnyone
echo SETUP_OK
