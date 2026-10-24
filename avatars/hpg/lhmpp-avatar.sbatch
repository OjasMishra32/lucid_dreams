#!/bin/bash
#SBATCH --job-name=lucid-lhmpp
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-turin
#SBATCH --gpus=1
#SBATCH --cpus-per-task=3
#SBATCH --mem=16G
#SBATCH --time=02:00:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# Many photos of one person -> one animatable Gaussian person. LHM++ (aigc3d/LHM-plusplus, March 2026; code Apache-2.0,
# weights CC BY-NC 4.0) reads any number of pose-free photos at once, so every photo shapes the same body
# and face. We ship its plain Gaussians (no neural refiner: a Quest can't run it), skinned with LHM++'s own weights.
#
# LHM++ is built for torch 2.3 / CUDA 12.1, so it runs on an L4 (sm_89), in a venv layered on envs/lam. The first run
# builds envs/lhmpp (~0.6 GB) and fetches the 700M PixelShuffle weights (5.2 GB) and the parts of LHMPP-Prior it reads
# (~1.2 GB) into models/lhmpp; later runs only infer.
#   sbatch --export=ALL,NAME=magnus-carlsen,TITLE="Magnus Carlsen" lhmpp-avatar.sbatch
# In:  data/avatars/photos/$NAME/*.jpg (up to 16, one session: same clothes, hair; faces clear, no hand over the face;
#      at least one extended pose; black and white is fine, it gets DDColor's colour), optional crops.json (see
#      avatars/lhmpp_avatar.py) and credit.txt there.
# Out: data/avatars/lhmpp/$NAME/: prep/ (what LHM++ saw), <variant>/$ID/ bundles, renders/ (front, 45, 90, 180
#      portrait + full body, compare.jpg), report.json; and dreams/$ID (the $VARIANT bundle). Only people who agreed,
#      or public figures for the demo, labelled (AGENTS.md, rule 5).
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
NAME=${NAME:?set NAME, e.g. magnus-carlsen}
PHOTOS=${PHOTOS:-$L/data/avatars/photos/$NAME}
ID=${ID:-$NAME-lhm}
TITLE=${TITLE:-$NAME}
INTENT=${INTENT:-}
VARIANTS=${VARIANTS:-matte}      # matte: person on white; raw: crop with its background (LHM++'s examples). On Magnus
                                 # raw left holes where a table filled the photo (50k of 160k Gaussians transparent)
VARIANT=${VARIANT:-matte}        # the one that becomes dreams/$ID
COMPARE=${COMPARE:-}             # "label=<bundle dir> ...": rendered the same way, side by side
WORK=${WORK:-$L/data/avatars/lhmpp/$NAME}
DREAMS=${DREAMS:-$L/data/avatars/dreams}
CODE=${CODE:-$L/repos/lucid_dreams/avatars}
MODEL=LHMPP-700M-PixelShuffle
R=$L/repos/LHM-plusplus V=$L/envs/lhmpp M=$L/models/lhmpp
TMP=${TMPDIR:-/tmp}
# caches stay on the node: the lab's /blue is nearly full
export HF_HOME=$TMP/hf TORCH_HOME=$L/cache/torch PIP_NO_CACHE_DIR=1 U2NET_HOME=$L/models/rembg
export TORCH_CUDA_ARCH_LIST="8.9" FORCE_CUDA=1 MAX_JOBS=3 OMP_NUM_THREADS=${SLURM_CPUS_PER_TASK:-3}
module load conda/26.7 cuda/12.4.1 gcc/12.2.0
eval "$(conda shell.bash hook)"
blue_quota 2>/dev/null | sed -n 4p || true
[ "$CODE" = "$L/repos/lucid_dreams/avatars" ] && { flock $L/repos/.lucid_dreams.lock git -C $L/repos/lucid_dreams pull -q --ff-only || echo "repo update skipped"; }
[ -d "$PHOTOS" ] || { echo "no photos at $PHOTOS"; exit 1; }
CREDIT=$(cat "$PHOTOS/credit.txt" 2>/dev/null || true)  # who took the photos, licence

# LHM++, pruned to its code
if [ ! -d $R ]; then
  git clone -q --depth 1 https://github.com/aigc3d/LHM-plusplus.git $R
  (cd $R && rm -rf .git assets/example_* assets/*.png assets/efficiency_analysis)
fi
if [ ! -f $V/.ok ]; then
  [ -d $V ] || $L/envs/lam/bin/python -m venv --system-site-packages $V
  . $V/bin/activate
  # --no-deps where a package would pull a different torch or numpy
  pip install -q --no-deps roma addict smplx==0.1.28 timm==1.0.15 kornia==0.7.2
  pip install -q kornia_rs rich spconv-cu121
  pip install -q --no-deps torch_scatter -f https://data.pyg.org/whl/torch-2.3.0+cu121.html
  pip install -q --no-deps gsplat==1.4.0 --index-url https://docs.gsplat.studio/whl/pt23cu121
  rm -rf $TMP/pointops && cp -r $R/lib/pointops $TMP/pointops && rm -rf $TMP/pointops/*.egg-info
  (cd $TMP/pointops && pip install -q --no-build-isolation .) && rm -rf $TMP/pointops
  python -c "import torch, pointops_cuda, spconv, torch_scatter, gsplat; print('LHM++ env OK')"
  touch $V/.ok
fi

# weights (ModelScope; not on Hugging Face yet) and the parts of LHMPP-Prior the PixelShuffle model reads
W=$M/$MODEL P=$M/pretrained_models
if [ ! -f $W/model.safetensors ]; then
  mkdir -p $TMP/w
  for f in config.json configuration.json model.safetensors; do
    wget -q -O $TMP/w/$f "https://modelscope.cn/models/Damo_XR_Lab/$MODEL/resolve/master/$f"
  done
  [ "$(stat -c %s $TMP/w/model.safetensors)" -gt 5000000000 ] || { echo "weights download incomplete"; exit 1; }
  mkdir -p $W && mv $TMP/w/* $W/ && rm -rf $TMP/w
fi
if [ ! -f $P/.ok ]; then
  $L/envs/lam/bin/huggingface-cli download 3DAIGC/LHMPP-Prior --local-dir $TMP/prior --include \
    "human_model_files/smplx/SMPLX_NEUTRAL.npz" "human_model_files/smplx/*.pkl" "human_model_files/smplx/*.npy" \
    "human_model_files/smplx/smplx_flip_correspondences.npz" "human_model_files/smplx/version.txt" \
    "human_model_files/smplx/smplx_uv/*" "human_model_files/flame/FLAME_NEUTRAL.pkl" \
    "human_model_files/flame/2019/generic_model.pkl" "human_model_files/flame/flame_*" \
    "human_model_files/flame_assets/*" "human_model_files/mano/*" "human_model_files/smpl_mean_params.npz" \
    "voxel_grid/cano_1_volume.npz" "voxel_grid/human_prior_constrain.npz" "dense_sample_points/*" \
    "arcface_resnet18.pth" >/dev/null 2>&1 || { echo "LHMPP-Prior download failed"; exit 1; }
  rm -rf $TMP/prior/.cache $TMP/prior/.huggingface
  S=$TMP/prior/human_model_files/smplx
  # LHM++ loads all three genders but poses with the neutral one; ours is the same file when it compares equal
  cmp -s $S/SMPLX_NEUTRAL.npz $L/models/smplx/SMPLX_NEUTRAL.npz && ln -sf $L/models/smplx/SMPLX_NEUTRAL.npz $S/SMPLX_NEUTRAL.npz
  ln -sf SMPLX_NEUTRAL.npz $S/SMPLX_MALE.npz && ln -sf SMPLX_NEUTRAL.npz $S/SMPLX_FEMALE.npz
  mkdir -p $M && rm -rf $P && mv $TMP/prior $P && touch $P/.ok
fi
ln -sfn $P $R/pretrained_models
du -sh $M $V $R

# 1. black-and-white photos get natural colour (DDColor, cached weights), on the photo; the rest pass through
[ -d $L/repos/DDColor ] || git clone -q https://github.com/piddnad/DDColor.git $L/repos/DDColor
( conda activate $L/envs/lam && HF_HOME=$L/cache/hf PYTHONPATH=$L/repos/DDColor \
  python -u $CODE/lhmpp_avatar.py colour --photos "$PHOTOS" --out "$WORK/colour" )
# 2. tight crops around the person (rembg lives in the DiGS env)
( conda activate $L/envs/digs && python -u $CODE/lhmpp_avatar.py prep --photos "$WORK/colour" --work "$WORK" )

# 3. LHM++ -> bundles, renders, comparison
. $V/bin/activate
cd $R
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
python -u $CODE/lhmpp_avatar.py build --work "$WORK" --model $W --smplx $L/models/smplx/SMPLX_NEUTRAL.npz \
  --id "$ID" --name "$TITLE" --variants "$VARIANTS" ${INTENT:+--intent "$INTENT"} ${CREDIT:+--credit "$CREDIT"} \
  ${COMPARE:+--compare-with $COMPARE} 2>&1 | grep -vE '^\s*$|FutureWarning|warnings.warn'
[ "${PIPESTATUS[0]}" -eq 0 ] || exit 1

# 4. the chosen variant becomes the dream
rm -rf "$DREAMS/$ID" && cp -r "$WORK/$VARIANT/$ID" "$DREAMS/$ID"
ls -la "$DREAMS/$ID" "$DREAMS/$ID/avatar" "$WORK/renders"
blue_quota 2>/dev/null | sed -n 4p || true
echo LHMPP_OK
