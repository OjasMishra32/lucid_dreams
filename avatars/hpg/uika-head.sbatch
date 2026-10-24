#!/bin/bash
#SBATCH --job-name=lucid-uika-head
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-turin
#SBATCH --gpus=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=64G
#SBATCH --time=04:00:00
#SBATCH --mail-type=END,FAIL
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# The head distill's teacher: UIKA (ant-research/UIKA, CVPR 2026, MIT) turns a consenting person's folder of photos
# into a FLAME Gaussian head; avatars/uika_views.py renders its neutral head from 91 views in UIKA's own renderer, for
# head-distill.sbatch to fit opaque SMPL-X-head Gaussians to.
# Consenting people only (AGENTS.md rule 5): the person must be in lucid_avatars/head_swap.py's CONSENTED, the photos
# their own folder, and nobody in dreams/.held; the gate runs first, before anything is built, downloaded or read.
# Never a public figure.
#   sbatch --export=ALL,NAME=vishal avatars/hpg/uika-head.sbatch
# SIZE=768 renders smaller views (default 1024); UIKA_REF=<commit> another UIKA commit (the script was written
# against c539f41's inference code; another commit may change it).
# In:  data/avatars/faces/$NAME/*.jpg (also .jpeg, .png; up to 16 used, by name): close-ups and other angles of the
#      person, one person per photo. FLAME 2023 (hpg/flame.sh fetches it once into models/flame, as for blinks).
# Out: data/avatars/heads/$NAME/uika/: views/NNN.png (RGBA) + views/cameras.json (K, world-to-camera in UIKA's FLAME
#      frame), flame.npy (UIKA's FLAME mesh for this head, 5023 x 3), contact.png (the eye-level views: look at it).
# Built once, under a lock: envs/uika (python 3.10; UIKA's pins: torch 2.3.0 / torchvision 0.18.0 / xformers
#      0.0.26.post1 and install/requirements.txt), repos/UIKA at UIKA_REF, its model_zoo (uika.safetensors ~4.6 GB,
#      StyleMatte, VGGHead, FLAME helpers). Nothing of UIKA's ever goes in our repo.
# UIKA's README builds for CUDA 11.8 (cu118 wheels + conda's CUDA 11.8 toolkit, which needs gcc <= 11). This job takes
#      the nearest proven route instead: the same pinned versions as cu121 wheels, built against the cuda/12.4.1 and
#      gcc/12.2.0 modules, exactly as lam-head.sbatch built LAM's identical torch 2.3.0 stack on these L4s (sm_89).
#      torch 2.3 has no Blackwell kernels, so L4s only (hpg-turin), not head-swap's B200 / RTX PRO 6000 partitions.
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
NAME=${NAME:?set NAME to the consenting person, e.g. vishal}
FACES=$L/data/avatars/faces/$NAME OUT=$L/data/avatars/heads/$NAME/uika DREAMS=$L/data/avatars/dreams
AV=$L/repos/lucid_dreams/avatars
U=$L/repos/UIKA E=$L/envs/uika
UIKA_REF=${UIKA_REF:-c539f41df842ff21faba49cd60e65e73774e8fbd}
TMP=${TMPDIR:-/tmp}
flock $L/repos/.lucid_dreams.lock git -C $L/repos/lucid_dreams pull -q --ff-only || echo "repo update skipped"
git -C $L/repos/lucid_dreams log -1 --format='lucid_dreams at %h %s'

# 0. the consent gate, before anything else (numpy only: the 4DAnyone env). REFUSED stops the job here.
set +u; source $L/code/pipeline/hpg/env.sh; set -u
PYTHONPATH=$AV:${PYTHONPATH:-} python -u -m lucid_avatars uika-check --person "$NAME" --photos "$FACES" --out "$OUT" \
  --held "$DREAMS/.held"
[ -d "$FACES" ] || { echo "no photos folder $FACES (one or more photos of $NAME go there)"; exit 1; }
N_PHOTOS=$(find "$FACES" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) ! -name '.*' | wc -l)
[ "$N_PHOTOS" -gt 0 ] || { echo "no photos (.jpg/.jpeg/.png) in $FACES"; exit 1; }
echo "[uika] $N_PHOTOS photos of $NAME"
set +u; conda deactivate; set -u

# 1. UIKA's code, env and weights, once (a lock, so two people's jobs never build it twice at the same time)
export HF_HOME=$L/cache/hf TORCH_HOME=$L/cache/torch PIP_CACHE_DIR=$TMP/pip CONDA_PKGS_DIRS=$TMP/conda-pkgs
export TORCH_CUDA_ARCH_LIST="8.9" FORCE_CUDA=1 MAX_JOBS=8
module load conda/26.7 cuda/12.4.1 gcc/12.2.0
eval "$(conda shell.bash hook)"
# envs/uika may be a conda env (built below) or a venv layered on envs/lam (as the legends' UIKA runs left it)
use_uika() { if [ -f $E/pyvenv.cfg ]; then . $E/bin/activate; else set +u; conda activate $E; set -u; fi; }
exec 9>$L/repos/.uika.lock
flock 9
[ -d $U/.git ] || git clone -q https://github.com/ant-research/UIKA.git $U
git -C $U cat-file -e "$UIKA_REF^{commit}" 2>/dev/null || git -C $U fetch -q origin
git -C $U checkout -q "$UIKA_REF"
git -C $U log -1 --format='UIKA at %h %ci %s'
if [ ! -f $E/.ok ]; then
  echo "[uika] building $E (first run; about an hour). The exact steps:"
  set -x
  [ -d $E ] || mamba create -y -q -p $E -c conda-forge python=3.10 ffmpeg
  use_uika
  pip install -q torch==2.3.0 torchvision==0.18.0 torchaudio==2.3.0 --index-url https://download.pytorch.org/whl/cu121
  pip install -q -U xformers==0.0.26.post1 --index-url https://download.pytorch.org/whl/cu121
  pip install -q Cython wheel ninja "setuptools==80.10.2"  # its requirements build with --no-build-isolation
  # UIKA's requirements.txt (its pins) without what inference never imports (checked: uika/, tools/human_matting,
  # tools/vgghead_detector): its web demo (gradio, dearpygui, nvitop) and its metrics' face tools (dlib and
  # insightface are C++ builds; tensorflow, jaxlib, face-detection-tflite). The git builds follow below.
  grep -vE '^(git\+|nvdiffrast|gradio|dlib|insightface|tensorflow|jaxlib|face-detection-tflite|dearpygui|nvitop)' \
    $U/install/requirements.txt > $TMP/uika-req.txt
  pip install -q -r $TMP/uika-req.txt --no-build-isolation
  python -c "import pytorch3d" 2>/dev/null || pip install -q pytorch3d \
    -f https://dl.fbaipublicfiles.com/pytorch3d/packaging/wheels/py310_cu121_pyt230/download.html \
    || pip install -q --no-build-isolation "git+https://github.com/facebookresearch/pytorch3d.git"
  pip install -q --no-build-isolation "git+https://github.com/ashawkey/diff-gaussian-rasterization/" \
    "git+https://github.com/camenduru/simple-knn/" \
    "nvdiffrast@git+https://github.com/ShenhanQian/nvdiffrast@backface-culling" \
    "git+https://github.com/rahul-goel/fused-ssim/"
  (cd $U && python -c "import torch, pytorch3d, diff_gaussian_rasterization, simple_knn, nvdiffrast.torch, xformers
import uika.models, tools.human_matting, tools.vgghead_detector
print('UIKA env OK', torch.__version__, torch.version.cuda)")
  set +x
  touch $E/.ok
else
  use_uika
fi
pip list 2>/dev/null | grep -iE '^(torch|torchvision|xformers|numpy|transformers|diffusers|pytorch3d) ' || true

# FLAME 2023's flame2023.pkl + FLAME_masks.pkl (UIKA asks for them by these names; its tar leaves them out: FLAME's
# licence): hpg/flame.sh fetches them once into models/flame (from LAM's public assets, the same FLAME 2023 release)
source $AV/hpg/flame.sh
[ -f "$FL/flame2023.pkl" ] && [ -f "$FL/FLAME_masks.pkl" ] || { echo "no FLAME 2023 in $FL: UIKA can't run"; exit 1; }
HP=$U/model_zoo/human_parametric_models
mkdir -p "$HP"
ln -sf "$FL/flame2023.pkl" "$HP/flame2023.pkl"
ln -sf "$FL/FLAME_masks.pkl" "$HP/FLAME_masks.pkl"
# UIKA's own installer: its checkpoint (sha256-checked), FLAME helpers, StyleMatte, VGGHead; the HF cache stays on the
# node (no second 4.6 GB copy on /blue)
(cd $U && HF_HOME=$TMP/hf-uika python install/prepare_assets.py --no-color) || true
rm -rf $TMP/hf-uika
(cd $U && python install/prepare_assets.py --verify-only --no-color) || { echo "UIKA's assets are incomplete (above)"; exit 1; }
flock -u 9

# 2. the teacher's views: the gate again, then UIKA (from its repo: its config paths are relative)
nvidia-smi --query-gpu=name,memory.total --format=csv
mkdir -p "$OUT"
cd $U
PYTHONPATH=$U:$AV python -u $AV/uika_views.py --person "$NAME" --photos "$FACES" --out "$OUT" --held "$DREAMS/.held" \
  --uika $U ${SIZE:+--size "$SIZE"}
ls -la "$OUT"
ls "$OUT/views" | wc -l
echo "look at $OUT/contact.png before distilling; then head-distill.sbatch NAME=$NAME"
echo UIKA_HEAD_OK
