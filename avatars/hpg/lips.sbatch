#!/bin/bash
#SBATCH --job-name=lucid-lips
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-turin
#SBATCH --gpus=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=32G
#SBATCH --time=01:30:00
#SBATCH --mail-type=END,FAIL
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# A consenting person's own voice moves their own lips: LAM_Audio2Expression (aigc3d, Apache-2.0) turns the audio into
# ARKit blendshape weights, lucid_avatars/lips.py maps ARKit's shapes (LAM's own, fitted to FLAME) onto the head
# swap's Gaussians and writes a bundle whose expr.bin has mouth0..mouth8 + blink and whose motion.json speaks.
# Consenting people only (AGENTS.md rule 5): the person must be in lucid_avatars/head_swap.py's VOICE_CONSENTED (today
# only vishal, his own voice), the bundle must be their own head swap, none of them in dreams/.held; the gate runs
# first (after the repo update), before any environment is built, anything downloaded or the audio touched. Never
# anyone else's voice, never a public figure's.
#   sbatch --export=ALL,NAME=vishal,AUDIO=/blue/iruchkin/vishalnaveen/lucid/data/avatars/voice/vishal.m4a \
#     avatars/hpg/lips.sbatch
# BUNDLE=<id> picks the head swap (default $NAME-head: run head-swap.sbatch first, with FLAME); PHOTO=<stem> another LAM
# head than the one the swap used; ID=<new id> (default $BUNDLE-voice); MAX_S=120 caps the audio's length in seconds.
# In:  data/avatars/dreams/$BUNDLE (head-swap.sbatch), data/avatars/heads/$NAME/heads, models/flame/flame2023_expr.npz
#      (hpg/flame.sh makes it), SMPLX_NEUTRAL.npz + SMPL-X__FLAME_vertex_ids.npy under models/smplx, AUDIO: the
#      person's own recording (m4a, wav, mp3...; their voice alone, no music).
# Out: data/avatars/dreams/$ID: the head swap with avatar/expr.bin (mouth0..8, blink), motion.json as long as the clip,
#      voice.m4a, lips.json (variance of the mouth's motion the 9 channels keep, want > 0.95; clip length).
# Built once: envs/a2e (python 3.10, torch 2.1.2 cu121: L4 only; it also runs the FBX extract), the A2E repo and its
#      weights, models/flame/arkit_on_flame.npz (ARKit's 52 shapes on FLAME out of LAM's template FBX; it never leaves
#      HiPerGator: licences).
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
NAME=${NAME:?set NAME to the consenting person, e.g. vishal}
BUNDLE=${BUNDLE:-$NAME-head}
NEW_ID=${ID:-$BUNDLE-voice}
AUDIO=${AUDIO:?set AUDIO to the person's own recording}
MAX_S=${MAX_S:-120}
SMPLX_DIR=${SMPLX_DIR:-$L/models/smplx}
DREAMS=$L/data/avatars/dreams HEADS=$L/data/avatars/heads/$NAME
AV=$L/repos/lucid_dreams/avatars
ARKIT_NPZ=$L/models/flame/arkit_on_flame.npz
WORK=$L/data/avatars/lips/$NEW_ID.work
TMP=${TMPDIR:-/tmp}
flock $L/repos/.lucid_dreams.lock git -C $L/repos/lucid_dreams pull -q --ff-only || echo "repo update skipped"
git -C $L/repos/lucid_dreams log -1 --format='lucid_dreams at %h %s'

# 0. the consent gate, before anything else (numpy only): REFUSED stops the job here
set +u; source $L/code/pipeline/hpg/env.sh; set -u
export PYTHONPATH=$AV:${PYTHONPATH:-}
python -u -m lucid_avatars lips "$DREAMS/$BUNDLE" --person "$NAME" --id "$NEW_ID" --check

[ -f "$AUDIO" ] || { echo "no audio at $AUDIO"; exit 1; }
[ -f "$DREAMS/$BUNDLE/head_swap.json" ] || { echo "no head swap at $DREAMS/$BUNDLE (head-swap.sbatch NAME=$NAME)"; exit 1; }
source $AV/hpg/flame.sh  # FLAME for the expressions, once (the bundle needs its expr.bin anyway); sets FLAME_NPZ
[ -f "$FLAME_NPZ" ] || { echo "no $FLAME_NPZ: no FLAME, no lips"; exit 1; }
NPZ=$(find -L "$SMPLX_DIR" -maxdepth 4 -name SMPLX_NEUTRAL.npz | head -1)
IDS=$(find -L "$SMPLX_DIR" -maxdepth 4 -name 'SMPL-X__FLAME_vertex_ids.npy' | head -1)
[ -n "$NPZ" ] && [ -n "$IDS" ] || { echo "SMPLX_NEUTRAL.npz or SMPL-X__FLAME_vertex_ids.npy missing under $SMPLX_DIR"; exit 1; }
ls "$HEADS"/heads/*_gs_offset.ply >/dev/null || { echo "no LAM head in $HEADS/heads (lam-head.sbatch NAME=$NAME)"; exit 1; }
mkdir -p "$WORK"
trap 'rm -f "$WORK/voice.wav"' EXIT  # the 16 kHz copy of their voice never outlives the job

# 1. LAM_Audio2Expression's env, code and weights, once (torch 2.1.2 cu121 has no Blackwell kernels: L4s only). It is
#    also the python 3.10 that LAM's FBX SDK wheel needs, so the ARKit extract below runs in it.
A=$L/repos/LAM_Audio2Expression
A2E_PY=$L/envs/a2e/bin/python
[ -d $A ] || git clone -q https://github.com/aigc3d/LAM_Audio2Expression.git $A
export HF_HOME=$L/cache/hf PIP_CACHE_DIR=$TMP/pip CONDA_PKGS_DIRS=$TMP/conda-pkgs
if [ ! -f $L/envs/a2e/.ok ]; then
  [ -d $L/envs/a2e ] || mamba create -y -q -p $L/envs/a2e -c conda-forge python=3.10 ffmpeg
  ( conda activate $L/envs/a2e
    pip install -q torch==2.1.2 torchaudio==2.1.2 --index-url https://download.pytorch.org/whl/cu121
    # its requirements.txt without gradio and the render wheel (the web demo's); scipy comes with librosa
    pip install -q numpy==1.26.3 omegaconf==2.3.0 addict==2.4.0 yapf==0.40.1 librosa==0.11.0 transformers==4.36.2 \
      termcolor==3.0.1 scipy huggingface_hub
    python -c "import torch, librosa, transformers, addict, yapf, omegaconf, scipy; print('A2E env OK', torch.__version__)" )
  touch $L/envs/a2e/.ok
fi
if [ ! -f $A/pretrained_models/lam_audio2exp_streaming.tar ]; then
  ( conda activate $L/envs/a2e
    cd $A
    huggingface-cli download 3DAIGC/LAM_audio2exp --local-dir $TMP/a2e-dl
    for t in $TMP/a2e-dl/LAM_audio2exp_assets.tar $TMP/a2e-dl/LAM_audio2exp_streaming.tar; do
      [ -f "$t" ] && tar -xf "$t"
    done
    rm -rf $TMP/a2e-dl )
fi
[ -f $A/pretrained_models/lam_audio2exp_streaming.tar ] || { echo "no $A/pretrained_models/lam_audio2exp_streaming.tar after the download"; exit 1; }

# 2. ARKit's 52 shapes on FLAME, once, from LAM's chat-avatar template (their FBX SDK wheel reads it, as their
#    tools/generateARKITGLBWithBlender.py does). The extractor REFUSES a mesh that doesn't fit FLAME's template.
if [ ! -f "$ARKIT_NPZ" ]; then
  FBX=$L/models/arkit/template_file.fbx
  if [ ! -f "$FBX" ]; then
    mkdir -p "$L/models/arkit" "$TMP/oac"
    wget -q -O "$TMP/oac/sample_oac.tar" https://virutalbuy-public.oss-cn-hangzhou.aliyuncs.com/share/aigc3d/data/LAM/sample_oac.tar
    tar -xf "$TMP/oac/sample_oac.tar" -C "$TMP/oac"
    cp "$(find "$TMP/oac" -name template_file.fbx | head -1)" "$FBX"
    rm -rf "$TMP/oac"
  fi
  if ! $A2E_PY -c "import fbx" 2>/dev/null; then
    WHEEL=fbx-2020.3.4-cp310-cp310-manylinux1_x86_64.whl  # pip needs the wheel's own file name
    wget -q -O "$TMP/$WHEEL" https://virutalbuy-public.oss-cn-hangzhou.aliyuncs.com/share/aigc3d/data/LAM/$WHEEL
    $A2E_PY -m pip install -q "$TMP/$WHEEL"
  fi
  $A2E_PY -c "import fbx; print('FBX SDK OK')"
  PYTHONPATH=$AV $A2E_PY $AV/arkit_on_flame_npz.py "$FBX" --list  # what the template holds, for the log
  TMP_NPZ=$ARKIT_NPZ.tmp.$$.npz  # written whole, then moved
  if PYTHONPATH=$AV $A2E_PY $AV/arkit_on_flame_npz.py "$FBX" "$FLAME_NPZ" "$TMP_NPZ"
  then mv -f "$TMP_NPZ" "$ARKIT_NPZ"
  else rm -f "$TMP_NPZ"; echo "[arkit] extract FAILED or REFUSED (see above): no lips without ARKit's shapes on FLAME"; exit 1
  fi
fi

# 3. the audio: wav 16 kHz mono for A2E (its default config would run spleeter to isolate vocals; off here, the
#    recording is the voice alone), m4a (AAC) for the bundle; capped at MAX_S seconds
# 4. A2E: ARKit weights per frame at 30 fps -> $WORK/bsData.json
( conda activate $L/envs/a2e
  ffmpeg -y -loglevel error -i "$AUDIO" -vn -t "$MAX_S" -ac 1 -ar 16000 "$WORK/voice.wav"
  ffmpeg -y -loglevel error -i "$AUDIO" -vn -t "$MAX_S" -ac 1 -c:a aac -b:a 96k "$WORK/voice.m4a"
  nvidia-smi --query-gpu=name,memory.total --format=csv
  cd $A
  python -u inference.py --config-file configs/lam_audio2exp_config_streaming.py \
    --options save_path=$WORK/a2e weight=pretrained_models/lam_audio2exp_streaming.tar \
    audio_input=$WORK/voice.wav ex_vol=False save_json_path=$WORK/bsData.json )
[ -s "$WORK/bsData.json" ] || { echo "A2E wrote no $WORK/bsData.json (see its log above)"; exit 1; }

# 5. the bundle (CPU, numpy): runs the gate again, refuses a head that isn't the swap's, writes and validates $NEW_ID
python -u -m lucid_avatars lips "$DREAMS/$BUNDLE" --person "$NAME" --id "$NEW_ID" --heads "$HEADS/heads" \
  ${PHOTO:+--photo "$PHOTO"} --smplx "$NPZ" --flame-ids "$IDS" --flame-expr "$FLAME_NPZ" --arkit "$ARKIT_NPZ" \
  --a2e-json "$WORK/bsData.json" --voice "$WORK/voice.m4a"
ls -la "$DREAMS/$NEW_ID"
echo "check lips.json: varianceKept > 0.95, clipS = the recording's length; look at a render before anyone sees it"
echo LIPS_OK
