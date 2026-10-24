#!/bin/bash
#SBATCH --job-name=lucid-lam-head
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-turin
#SBATCH --gpus=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
#SBATCH --time=04:00:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# A real face for a photo avatar. LAM (aigc3d/LAM, SIGGRAPH 2025, Apache-2.0) turns one photo into an animatable
# FLAME Gaussian head; it's trained on real talking-head video, so it blinks and talks like a person, which the
# full-body model's guessed face never does. Black-and-white photos are colourised first with DDColor (ICCV 2023,
# Apache-2.0), on the photo, not on the Gaussians.
#
# LAM is built for torch 2.3 / CUDA 12.1 (no Blackwell kernels), so it runs on the L4s (sm_89). The first run
# builds envs/lam (about 8 GB); later runs only infer.
#   sbatch --export=ALL,NAME=bobby-fischer lam-head.sbatch
# In:  data/avatars/faces/$NAME/*.jpg
# Out: data/avatars/heads/$NAME/{colour,videos,heads}/ : the photos LAM saw, a talking render per photo,
#      and per photo the canonical head (<photo>_gs_offset.ply) and its FLAME mesh (<photo>_shaped_mesh.obj).
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
NAME=${NAME:?set NAME}
FACES=$L/data/avatars/faces/$NAME OUT=$L/data/avatars/heads/$NAME WORK=$L/data/avatars/heads/$NAME/work
TMP=${TMPDIR:-/tmp}
# pip and conda caches stay on the node: our /blue footprint is near its cap
export HF_HOME=$L/cache/hf TORCH_HOME=$L/cache/torch PIP_CACHE_DIR=$TMP/pip CONDA_PKGS_DIRS=$TMP/conda-pkgs
export TORCH_CUDA_ARCH_LIST="8.9" FORCE_CUDA=1 MAX_JOBS=8
module load conda/26.7 cuda/12.4.1 gcc/12.2.0
eval "$(conda shell.bash hook)"

R=$L/repos/LAM
[ -d $R ] || git clone -q https://github.com/aigc3d/LAM.git $R
[ -d $L/repos/DDColor ] || git clone -q https://github.com/piddnad/DDColor.git $L/repos/DDColor
cd $R
if [ ! -f $L/envs/lam/.ok ]; then
  [ -d $L/envs/lam ] || mamba create -y -q -p $L/envs/lam -c conda-forge python=3.10 ffmpeg
  conda activate $L/envs/lam
  pip install -q torch==2.3.0 torchvision==0.18.0 torchaudio==2.3.0 --index-url https://download.pytorch.org/whl/cu121
  pip install -q xformers==0.0.26.post1 --index-url https://download.pytorch.org/whl/cu121
  # gradio is only for LAM's web demo; the CUDA packages are built below against the module's nvcc
  grep -vE '^(git\+|nvdiffrast|gradio|chumpy)' requirements.txt > $TMP/lam-req.txt
  pip install -q -r $TMP/lam-req.txt
  pip install -q --no-build-isolation chumpy  # its setup.py imports pip, which an isolated build doesn't have
  pip install -q matplotlib  # imported by LAM's renderer, missing from its requirements
  python -c "import pytorch3d" 2>/dev/null || pip install -q pytorch3d \
    -f https://dl.fbaipublicfiles.com/pytorch3d/packaging/wheels/py310_cu121_pyt230/download.html \
    || pip install -q --no-build-isolation "git+https://github.com/facebookresearch/pytorch3d.git"
  pip install -q --no-build-isolation "git+https://github.com/ashawkey/diff-gaussian-rasterization/" \
    "git+https://github.com/camenduru/simple-knn/" \
    "nvdiffrast@git+https://github.com/ShenhanQian/nvdiffrast@backface-culling"
  (cd external/landmark_detection/FaceBoxesV2/utils && sh make.sh)
  python -c "import torch, pytorch3d, diff_gaussian_rasterization, simple_knn, nvdiffrast.torch; print('LAM env OK', torch.__version__)"
  touch $L/envs/lam/.ok
else
  conda activate $L/envs/lam
fi

# weights and assets (the tars are deleted once unpacked)
W=model_zoo/lam_models/releases/lam/lam-20k/step_045500
[ -f $W/model.safetensors ] || huggingface-cli download 3DAIGC/LAM-20K --local-dir $W
if [ ! -d model_zoo/flame_tracking_models ] || [ ! -d assets/sample_motion ]; then
  huggingface-cli download 3DAIGC/LAM-assets --local-dir $TMP/lam-assets
  for t in LAM_assets thirdparty_models LAM_human_model; do tar -xf $TMP/lam-assets/$t.tar; done
  rm -rf $TMP/lam-assets
fi
ls model_zoo/human_parametric_models/flame_assets/flame/flame2023.pkl model_zoo/flame_tracking_models/FaceBoxesV2.pth >/dev/null

# the photos LAM sees: colour as they are, black-and-white colourised
mkdir -p $OUT/colour $WORK/in
PYTHONPATH=$L/repos/DDColor python - "$FACES" "$OUT/colour" "$WORK/in" "$NAME" <<'PY'
import shutil, sys
from pathlib import Path
import numpy as np
from PIL import Image
faces, colour, work = map(Path, sys.argv[1:4])
name = sys.argv[4]
grey = []
for f in sorted(faces.glob("*.jpg")):
    img = np.asarray(Image.open(f).convert("RGB").resize((256, 256)), dtype=np.float32)
    if np.percentile(img.max(axis=2) - img.min(axis=2), 95) < 12:  # same test as lucid.monochrome
        grey.append(f)
    else:
        shutil.copy(f, colour / f.name)
if grey:
    import cv2, torch
    from huggingface_hub import PyTorchModelHubMixin
    from ddcolor import DDColor, ColorizationPipeline
    class DDColorHF(DDColor, PyTorchModelHubMixin):
        def __init__(self, config=None, **kwargs):
            if isinstance(config, dict):
                kwargs = {**config, **kwargs}
            super().__init__(**kwargs)
    model = DDColorHF.from_pretrained("piddnad/ddcolor_modelscope").cuda().eval()
    pipe = ColorizationPipeline(model, input_size=512, device=torch.device("cuda"))
    for f in grey:
        cv2.imwrite(str(colour / f.name), pipe.process(cv2.imread(str(f))))
        print("[lam-head] colourised", f.name)
for f in sorted(colour.glob("*.jpg")):
    shutil.copy(f, work / f"{name}-{f.name}")
PY

# LAM writes tracking_output/ and exps/ into its working directory, so two jobs in one checkout trip over each
# other: each job runs from its own folder of links to the checkout
CWD=$WORK/cwd
rm -rf $CWD && mkdir -p $CWD
for f in $R/*; do case ${f##*/} in exps|tracking_output|dumps) ;; *) ln -s $f $CWD/ ;; esac; done
cd $CWD

# one talking head per photo, driven by LAM's sample motion; save_img also writes the canonical head
M=assets/sample_motion/export/$(ls assets/sample_motion/export | head -1)/
python -m lam.launch infer.lam --config configs/inference/lam-20k-8gpu.yaml \
  model_name=$W/ image_input=$WORK/in motion_seqs_dir=$M motion_img_dir=null \
  export_video=true export_mesh=false vis_motion=false motion_img_need_mask=true \
  render_fps=30 motion_video_read_fps=30 save_ply=false save_img=true \
  gaga_track_type="" cross_id=false test_sample=false rank=0 nodes=0 \
  video_dump=$OUT/videos image_dump=$WORK/images mesh_dump=$WORK/meshes
mkdir -p $OUT/heads
# _textured_mesh.obj: every Gaussian's position in order (the .ply holds offsets); head_swap.py needs it
cp exps/cano_gs/$NAME-*_gs_offset.ply exps/cano_gs/$NAME-*_shaped_mesh.obj exps/cano_gs/$NAME-*_textured_mesh.obj \
  $OUT/heads/ 2>/dev/null || true
rm -f $OUT/videos/*_audio.mp4  # LAM muxes its sample motion's voice in; nobody we build speaks in someone else's voice
cd $R && rm -rf $WORK/images $CWD
ls -la $OUT/videos $OUT/heads
[ -n "$(ls $OUT/heads/*_gs_offset.ply 2>/dev/null)" ] && echo LAM_HEAD_OK
