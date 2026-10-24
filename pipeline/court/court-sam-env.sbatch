#!/bin/bash
#SBATCH --job-name=court-sam-env
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --time=00:45:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# Court Side: SAM 2.1 (Meta, Apache-2.0) for the instance masks (court-masks.sbatch). A small venv layered on the
# 4danyone env (reuses its torch 2.8 + cu128, which has the Blackwell kernels), sam2 pinned to the commit the Mac and PC
# masks run, its CUDA post-processing extension compiled for L4 (sm_89), B200 (sm_100) and RTX PRO 6000 (sm_120).
# Weights: sam2.1_hiera_large.pt from Meta's own URL, sha256-checked against the Mac's copy, so every host runs the same
# model. Disk on Blue: ~0.9 GB of weights + a few MB of venv; pip and the build stay in $TMPDIR. Safe to re-run.
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
COMMIT=2b90b9f5ceec907a1c18123530e92e794ad901a4   # facebookresearch/sam2, 2024-12-15 (the Mac's vendor/sam2 checkout)
URL=https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt
SHA=2647878d5dfa5098f2f8649825738a9345572bae2d4350a2468587ece47dd318
CK=$L/models/sam2/checkpoints/sam2.1_hiera_large.pt   # SAM2_ROOT=$L/models/sam2: sam_people.py reads <root>/checkpoints
export PIP_CACHE_DIR=${TMPDIR:-/tmp}/pip TMPDIR=${TMPDIR:-/tmp}
export TORCH_CUDA_ARCH_LIST="8.9;10.0;12.0" MAX_JOBS=4
module load conda/26.7 cuda/12.8.1
eval "$(conda shell.bash hook)"
conda activate $L/envs/4danyone
[ -x $L/envs/sam2/bin/python ] || python -m venv --system-site-packages $L/envs/sam2
source $L/envs/sam2/bin/activate
# torch, torchvision, numpy, pillow, tqdm come from 4danyone; only sam2 and its two config libraries land in the venv
python -c "import sam2, sys; sys.exit(sam2.__file__.startswith('$L/envs/sam2/') is False)" 2>/dev/null || {
  pip install -q "hydra-core>=1.3.2" "iopath>=0.1.10"
  pip install -q --no-build-isolation --no-deps "SAM-2 @ git+https://github.com/facebookresearch/sam2.git@$COMMIT"
}
mkdir -p "$(dirname $CK)"
if [ ! -s $CK ]; then
  # downloaded and checked in node scratch; only a verified file is moved onto Blue
  wget -q -O $TMPDIR/sam2.1_hiera_large.pt $URL
  GOT=$(sha256sum $TMPDIR/sam2.1_hiera_large.pt | cut -d' ' -f1)
  [ "$GOT" = $SHA ] || { echo "sam2.1_hiera_large.pt: sha256 $GOT, wanted $SHA" >&2; exit 1; }
  mv $TMPDIR/sam2.1_hiera_large.pt $CK
fi
GOT=$(sha256sum $CK | cut -d' ' -f1)
[ "$GOT" = $SHA ] || { echo "$CK: sha256 $GOT, wanted $SHA (left as is)" >&2; exit 1; }
echo "sam2.1_hiera_large.pt $(( $(stat -c %s $CK) / 2**20 )) MB, sha256 ok"
# the hole-filling extension (the Mac's MPS runs skip it; masks are the same or cleaner with it)
python -c "import torch; from sam2 import _C" 2>/dev/null && echo "sam2._C: built" ||
  echo "sam2._C: not built (hole filling skipped, as on the Mac)"
# the exact build court-masks uses, on CPU: configs resolve, the checkpoint loads into the large model
SAM2_ROOT=$L/models/sam2 python - <<'PY'
import os, torch, sam2
from sam2.build_sam import build_sam2_video_predictor
ck = os.path.join(os.environ["SAM2_ROOT"], "checkpoints", "sam2.1_hiera_large.pt")
p = build_sam2_video_predictor("configs/sam2.1/sam2.1_hiera_l.yaml", ck, device="cpu")
print("predictor OK", type(p).__name__, "torch", torch.__version__, "cuda", torch.version.cuda,
      "archs", torch.cuda.get_arch_list() if torch.cuda.is_available() else "(no GPU here)", "sam2 at", sam2.__file__)
PY
du -sh $L/envs/sam2 $L/models/sam2
touch $L/envs/sam2/.court-sam-ok   # court-hpg.sh skips this job from now on
echo SETUP_OK
