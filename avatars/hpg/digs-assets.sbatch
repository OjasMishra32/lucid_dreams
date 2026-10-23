#!/bin/bash
#SBATCH --job-name=lucid-digs-assets
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=4
#SBATCH --mem=24G
#SBATCH --time=01:00:00
#SBATCH --mail-type=END,FAIL
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# CPU only. Run once after setup-digs: puts the assets DiGS inference reads where it reads them (about 1.5 GB),
# fetches NLF and the rembg person matte, links SMPL-X, and checks student.ckpt carries the weights we can't download.
# SMPLX_DIR must hold SMPLX_NEUTRAL.pkl or .npz somewhere inside (from models_smplx_v1_1.zip).
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
SMPLX_DIR=${SMPLX_DIR:-$L/models/smplx}
REPO=$L/repos/lucid_dreams
export HF_HOME=$L/cache/hf PIP_CACHE_DIR=$L/cache/pip U2NET_HOME=$L/models/rembg
module load conda/26.7
eval "$(conda shell.bash hook)"
conda activate $L/envs/digs
mkdir -p $L/models/nlf $U2NET_HOME $L/data/avatars/inputs $L/data/avatars/dreams

# Our avatar code (digs_avatar.py + lucid_avatars) next to the other repos.
if [ -d $REPO/.git ]; then git -C $REPO pull -q --ff-only; else git clone -q https://github.com/OjasMishra32/lucid_dreams.git $REPO; fi
git -C $REPO log -1 --format='lucid_dreams at %h %s'

cd $L/repos/DiGS-Avatar
pip install -q rembg onnxruntime-gpu imageio-ffmpeg  # imageio-ffmpeg: H.264 preview.mp4 that browsers play

# SMPL-X (licensed, not downloadable here): DiGS loads lib/models/deformers/smplx/SMPLX/SMPLX_NEUTRAL.pkl.
# Link the .pkl if SMPLX_DIR has one; otherwise convert the .npz install-smplx-when-ready.sh put there
# (the SMPL-X loader reads both into the same struct of arrays).
SX=lib/models/deformers/smplx/SMPLX
if [ ! -f $SX/SMPLX_NEUTRAL.pkl ]; then
  PKL=$(find -L "$SMPLX_DIR" -maxdepth 4 -name SMPLX_NEUTRAL.pkl | head -1)
  NPZ=$(find -L "$SMPLX_DIR" -maxdepth 4 -name SMPLX_NEUTRAL.npz | head -1)
  mkdir -p $SX
  if [ -n "$PKL" ]; then ln -sfn "$PKL" $SX/SMPLX_NEUTRAL.pkl
  elif [ -n "$NPZ" ]; then
    python -c "import numpy as np, pickle, sys; d = dict(np.load(sys.argv[1], allow_pickle=True)); pickle.dump(d, open(sys.argv[2] + '.part', 'wb'))" "$NPZ" $SX/SMPLX_NEUTRAL.pkl
    mv $SX/SMPLX_NEUTRAL.pkl.part $SX/SMPLX_NEUTRAL.pkl
  else echo "no SMPLX_NEUTRAL.pkl or .npz under $SMPLX_DIR: unzip models_smplx_v1_1.zip there"; exit 1; fi
fi
ls -laL $SX/

python - <<'PY'
import os, shutil, zipfile
from huggingface_hub import hf_hub_download, snapshot_download

# IDOL Gaussian/UV init cache: only cache_sub2.zip (270 MB) is needed, not the whole IDOL repo.
if not os.path.isdir("assets/idol_cache/cache_sub2"):
    z = hf_hub_download("yiyuzhuang/IDOL", "cache_sub2.zip")
    tmp = "assets/idol_cache/.unzip"  # unzip aside, then rename, so a killed job can't leave half a cache
    shutil.rmtree(tmp, ignore_errors=True)
    zipfile.ZipFile(z).extractall(tmp)
    os.rename(os.path.join(tmp, "cache_sub2"), "assets/idol_cache/cache_sub2")
    shutil.rmtree(tmp)
assert os.path.isdir("assets/idol_cache/cache_sub2"), os.listdir("assets/idol_cache")
print("idol cache:", sorted(os.listdir("assets/idol_cache/cache_sub2"))[:8])

# AutoencoderDC.from_pretrained needs the diffusers-format repo, not the plain dc-ae one setup-digs pulled.
snapshot_download("mit-han-lab/dc-ae-f32c32-sana-1.1-diffusers", local_dir="pretrained/vae_dc")
print("vae_dc:", sorted(os.listdir("pretrained/vae_dc")))
PY

# DINOv3 code for torch.hub (source="local"). Its weights are gated; see the student.ckpt check below.
[ -d pretrained/dinov3/.git ] || git clone -q --depth 1 https://github.com/facebookresearch/dinov3.git pretrained/dinov3

# NLF SMPL-X fitter (code MIT; models for non-commercial research).
NLF=$L/models/nlf/nlf_l_multi_0.3.2.patch6.torchscript
[ -s $NLF ] || { wget -q -O $NLF.part https://github.com/isarandi/nlf/releases/download/v0.3.2/nlf_l_multi_0.3.2.patch6.torchscript && mv $NLF.part $NLF; }

python - <<'PY'
import collections, os, torch
import rembg

rembg.new_session("u2net_human_seg")  # downloads the person matte model into $U2NET_HOME
print("rembg model:", os.listdir(os.environ["U2NET_HOME"]))

sd = torch.load("checkpoints/student.ckpt", map_location="cpu", weights_only=False)
sd = sd.get("state_dict", sd)
prefixes = collections.Counter(".".join(k.split(".")[:2]) for k in sd)
for p, n in sorted(prefixes.items()):
    print(f"  {n:>6}  {p}")
dino = sum(k.startswith("dino_encoder.dino_model.") for k in sd)
if dino == 0 and not os.path.exists("pretrained/dinov3_vitb16.pth"):
    raise SystemExit("student.ckpt has no DINOv3 weights and pretrained/dinov3_vitb16.pth is missing: "
                     "get the Meta-format dinov3_vitb16 .pth (gated) and put it there")
print("DINOv3 weights:", f"{dino} tensors in student.ckpt" if dino else "pretrained/dinov3_vitb16.pth")
PY

python -c "import torch, torchvision; m = torch.jit.load('$NLF'); print('NLF loads:', type(m).__name__)"
du -sh assets/idol_cache pretrained/vae_dc pretrained/dinov3 $L/models/nlf $U2NET_HOME
echo ASSETS_OK
