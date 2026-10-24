#!/bin/bash
#SBATCH --job-name=lucid-syncnet
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-rtx6000,hpg-b200,hpg-turin
#SBATCH --gpus=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32G
#SBATCH --time=01:00:00
#SBATCH --mail-type=END,FAIL
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# The slide number for voice-driven lips: SyncNet confidence (LSE-C, plus LSE-D and the AV offset) of a front face render
# of the speaking avatar with its own voice, BEFORE (the same avatar and audio, mouth channels zeroed: idle and blink
# only) and AFTER (mouth driven by the voice). SyncNet = joonson/syncnet_python (MIT, Chung and Zisserman).
# Consenting people only (AGENTS.md rule 5): lips.py's gate (VOICE_CONSENTED: today only vishal, his own voice; the
# bundle must be his own voice-driven bundle, none of them in dreams/.held) runs first, before the audio, any render, any
# environment or any download. Never anyone else's voice, never a public figure.
#   sbatch --export=ALL,NAME=vishal avatars/hpg/syncnet.sbatch        (after lips.sbatch made vishal-head-voice)
# BUNDLE=<id> picks the voice-driven bundle (default $NAME-head-voice); FACTOR=3 is the render side in 224 px units
# (3 = 672 px, the full-resolution mp4 people watch; the SyncNet crops are 224 px either way).
# In:  data/avatars/dreams/$BUNDLE (lips.sbatch: avatar/expr.bin with mouth0..8 + blink, motion.json, voice.m4a, lips.json)
# Out: data/avatars/lips/$BUNDLE.sync/{before,after}.mp4 (voice muxed, to watch), {before,after}_crops.avi (SyncNet's
#      input), compare.png (widest mouth, before | after), render.json, syncnet_{before,after}.log; and
#      data/avatars/dreams/$BUNDLE/lips_sync.json {before, after: {conf, dist, offset}, deltaConf, model, fps, clipS}.
#      The log's last line: `SYNC conf before X after Y`.
# Built once: envs/syncnet (python 3.10, ffmpeg, current torch wheels, numpy, scipy, opencv, python_speech_features;
#      versions are logged; if its torch has no kernels for the GPU, SyncNet runs on the CPU, minutes for a 30 s clip),
#      repos/syncnet_python and its data/syncnet_v2.model (robots.ox.ac.uk, the repo's own download script's URL).
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
NAME=${NAME:?set NAME to the consenting person, e.g. vishal}
BUNDLE=${BUNDLE:-$NAME-head-voice}
FACTOR=${FACTOR:-3}
DREAMS=$L/data/avatars/dreams
AV=$L/repos/lucid_dreams/avatars
WORK=$L/data/avatars/lips/$BUNDLE.sync
TMP=${TMPDIR:-/tmp}
SN=$L/repos/syncnet_python
SN_ENV=$L/envs/syncnet
flock $L/repos/.lucid_dreams.lock git -C $L/repos/lucid_dreams pull -q --ff-only || echo "repo update skipped"
git -C $L/repos/lucid_dreams log -1 --format='lucid_dreams at %h %s'

# 0. the consent gate, before anything else (numpy only): REFUSED stops the job here
set +u; source $L/code/pipeline/hpg/env.sh; set -u
export PYTHONPATH=$AV:${PYTHONPATH:-}
python -u $AV/lips_sync_score.py "$DREAMS/$BUNDLE" --person "$NAME" --check

[ -f "$DREAMS/$BUNDLE/voice.m4a" ] && [ -f "$DREAMS/$BUNDLE/lips.json" ] || { echo "$BUNDLE isn't voice-driven (lips.sbatch NAME=$NAME)"; exit 1; }
nvidia-smi --query-gpu=name,memory.total --format=csv
mkdir -p "$WORK"

# 1. the two front renders on the GPU (4DAnyone env: gsplat), mouth driven and mouth zeroed
python -u $AV/lips_render.py "$DREAMS/$BUNDLE" --person "$NAME" --out "$WORK" --factor "$FACTOR"
ls -la "$WORK"

# 2. SyncNet's env, code and weights, once
export PIP_CACHE_DIR=$TMP/pip CONDA_PKGS_DIRS=$TMP/conda-pkgs
if [ ! -f $SN_ENV/.ok ]; then
  [ -d $SN_ENV ] || mamba create -y -q -p $SN_ENV -c conda-forge python=3.10 ffmpeg
  $SN_ENV/bin/python -m pip install -q torch numpy scipy opencv-python-headless python_speech_features
  touch $SN_ENV/.ok
fi
$SN_ENV/bin/python -c "
import sys, torch, numpy, scipy, cv2, python_speech_features
print('syncnet env:', 'python', sys.version.split()[0], 'torch', torch.__version__, 'numpy', numpy.__version__,
      'scipy', scipy.__version__, 'opencv', cv2.__version__, 'cuda', torch.version.cuda)"
[ -d $SN ] || git clone -q https://github.com/joonson/syncnet_python.git $SN
git -C $SN log -1 --format='syncnet_python at %h %s'
mkdir -p $SN/data
[ -s $SN/data/syncnet_v2.model ] || wget -q -O $SN/data/syncnet_v2.model.part http://www.robots.ox.ac.uk/~vgg/software/lipsync/data/syncnet_v2.model
[ -s $SN/data/syncnet_v2.model.part ] && mv -f $SN/data/syncnet_v2.model.part $SN/data/syncnet_v2.model
[ -s $SN/data/example.avi ] || wget -q -O $SN/data/example.avi http://www.robots.ox.ac.uk/~vgg/software/lipsync/data/example.avi
[ -s $SN/data/syncnet_v2.model ] || { echo "no $SN/data/syncnet_v2.model"; exit 1; }
export PATH=$SN_ENV/bin:$PATH  # SyncNet shells out to ffmpeg
if ! $SN_ENV/bin/python -c "import torch; (torch.zeros(1, device='cuda') + 1).item()" 2>/dev/null; then
  echo "[syncnet] this torch has no kernels for this GPU: SyncNet runs on the CPU"
  export CUDA_VISIBLE_DEVICES=""
fi

# 3. SyncNet's own example clip first: the env is right if its confidence is about 10 (their README: offset 3, min dist
#    5.353, confidence 10.021); then both renders. lips_sync_score.py writes lips_sync.json into the bundle.
( cd $SN && $SN_ENV/bin/python demo_syncnet.py --videofile data/example.avi --tmp_dir $WORK/syncnet-example 2>&1 | grep -E "AV offset|Min dist|Confidence" | sed 's/^/[example.avi] /' ) \
  || echo "[example.avi] SyncNet's own example FAILED: the scores below are not to be trusted"
$SN_ENV/bin/python -u $AV/lips_sync_score.py "$DREAMS/$BUNDLE" --person "$NAME" --renders "$WORK" --syncnet $SN
echo "look at $WORK/after.mp4 and compare.png before quoting the number; lips_sync.json is in the bundle"
echo SYNCNET_OK
