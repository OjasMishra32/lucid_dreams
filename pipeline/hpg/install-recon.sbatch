#!/bin/bash
#SBATCH --job-name=lucid-install-recon
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G
#SBATCH --time=02:00:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# Adds the reconstruction stack (gsplat + metrics) to the 4DAnyone env, compiled for B200 (sm_100) and RTX PRO 6000 (sm_120).
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
export HF_HOME=$L/cache/hf PIP_CACHE_DIR=$L/cache/pip
export TORCH_CUDA_ARCH_LIST="10.0;12.0" MAX_JOBS=8 BUILD_NO_CUDA=0
module load conda/26.7 cuda/12.8.1
eval "$(conda shell.bash hook)"
conda activate $L/envs/4danyone
pip install -q ninja plyfile lpips
pip install -q --no-build-isolation "git+https://github.com/nerfstudio-project/gsplat.git@v1.5.3"
python -c "import gsplat, torch; print('gsplat', gsplat.__version__, 'torch', torch.__version__)"
echo INSTALL_OK
