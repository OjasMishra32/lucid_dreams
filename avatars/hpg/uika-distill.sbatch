#!/bin/bash
#SBATCH --job-name=lucid-uika-distill
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-turin
#SBATCH --gpus=1
#SBATCH --cpus-per-task=3
#SBATCH --mem=24G
#SBATCH --time=01:00:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# A sharp, solid head for an SMPL-X avatar from many photos: UIKA (ant-research/UIKA, CVPR 2026, MIT) is the teacher,
# its head distilled onto the avatar's own body (avatars/uika_head.py: teacher, distill, finish, judge; about 6 min on
# an L4 for Magnus: UIKA 1.5 min, the fit 2.5 min, the judge 1 min).
#   sbatch --export=ALL,NAME=magnus-carlsen,USE=c11:c31:c42:c46 avatars/hpg/uika-distill.sbatch
# AVATAR=<bundle> the body (default $NAME-lhm) in DREAMS (default dreams/); ID=<new bundle> (default $NAME-uika), written
# next to it; STAGES=teacher:distill:judge; FACES=<photo folder>; CLEANUP=<lhmpp_cleanup.py flags for the body>;
# PREP=<LHM++ prep/raw photos for its identity yardstick>; BODY=current fits the head on the body as it is (already
# cleaned or slimmed; then CLEANUP=skip), BODY=raw (default) on LHM++'s raw body, cleaned after;
# STEPS=<fit steps>; SIZE=<teacher px, default 1024>; CODE=<avatars folder> (default the repo checkout).
# Who: consenting people, or the chess opponents the project lead approved from freely licensed photos (OPPONENTS in
# uika_head.py; AGENTS.md rule 5). The gate runs before anything is read.
# In:  data/avatars/faces/$NAME/*.jpg (close-ups; USE=a:b:c picks some by stem), dreams/$AVATAR, models/smplx.
# Out: data/avatars/heads/$NAME/uika/ (views/ + cameras.json, flame.npy, gaussians.npz, contact.png, references.png),
#      dreams/$ID (avatar.ply + skin.bin replaced, cleaned by lhmpp_cleanup.py, preview.mp4, thumb.jpg,
#      uika_head.json), data/avatars/heads/$NAME/judge-$ID/ (portraits old vs new, posed frame 0, identity).
# UIKA runs on torch 2.3 (no Blackwell kernels), so an L4. Its env is a venv layered on envs/lam (which already has
# torch 2.3.0+cu121, xformers 0.0.26.post1, pytorch3d, the 3DGS rasterizer UIKA calls, transformers 4.41.2), plus
# envs/lhmpp's packages (gsplat 1.4.0) through a .pth: ~0.2 GB. Weights (~5.1 GB) in models/uika = UIKA's model_zoo;
# FLAME 2023 comes from LHM++'s pretrained_models (the same files UIKA asks for), linked, not copied.
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
NAME=${NAME:?set NAME, e.g. magnus-carlsen}
AVATAR=${AVATAR:-$NAME-lhm}
NEW=${ID:-$NAME-uika}
STAGES=${STAGES:-teacher,distill,judge}
STAGES=${STAGES//:/,}  # sbatch --export splits on commas: STAGES=distill:judge
CODE=${CODE:-$L/repos/lucid_dreams/avatars}
DREAMS=${DREAMS:-$L/data/avatars/dreams} FACES=${FACES:-$L/data/avatars/faces/$NAME}
TEACHER=$L/data/avatars/heads/$NAME/uika HELD=$L/data/avatars/dreams/.held
PREP=${PREP:-$L/data/avatars/lhmpp/$NAME/prep/raw}
JUDGE=$L/data/avatars/heads/$NAME/judge-$NEW
U=$L/repos/UIKA E=$L/envs/uika M=$L/models/uika
UIKA_REF=${UIKA_REF:-c539f41df842ff21faba49cd60e65e73774e8fbd}
TMP=${TMPDIR:-/tmp}
export HF_HOME=$TMP/hf TORCH_HOME=$L/cache/torch PIP_NO_CACHE_DIR=1 OMP_NUM_THREADS=${SLURM_CPUS_PER_TASK:-3}
export PYTHONPATH=$CODE PYTHONUNBUFFERED=1
blue_quota 2>/dev/null | sed -n 4p || true
[ "$CODE" = "$L/repos/lucid_dreams/avatars" ] && { flock $L/repos/.lucid_dreams.lock git -C $L/repos/lucid_dreams pull -q --ff-only || echo "repo update skipped"; }
PY=$E/bin/python
$L/envs/lam/bin/python -c "
import sys; sys.path.insert(0, '$CODE')
from uika_head import gate_errors
e = gate_errors('$NAME', '$HELD')
print('REFUSED', *e, sep='\n     ') if e else print('[gate] $NAME may go through')
sys.exit(2 if e else 0)"

# UIKA, its env and weights, once (a lock: one build at a time)
exec 9>$L/repos/.uika.lock
flock 9
[ -d $U/.git ] || git clone -q https://github.com/ant-research/UIKA.git $U
git -C $U cat-file -e "$UIKA_REF^{commit}" 2>/dev/null || git -C $U fetch -q origin
git -C $U checkout -q "$UIKA_REF"
if [ ! -f $E/.ok ]; then
  [ -d $E ] || $L/envs/lam/bin/python -m venv --system-site-packages $E
  # --no-deps throughout: nothing may pull another torch or numpy
  $E/bin/pip install -q --no-deps dreifus boxx megfile "timm==1.0.15" pytorch_lightning lightning_utilities torchmetrics
  $E/bin/pip install -q --no-deps --no-build-isolation insightface==0.7.3 onnxruntime==1.18.1 onnx==1.16.1 easydict \
    prettytable albumentations==1.3.1 qudida==0.0.4 scikit-learn==1.5.2 joblib threadpoolctl cloudpickle
  echo "$L/envs/lhmpp/lib/python3.10/site-packages" > $E/lib/python3.10/site-packages/zz_lhmpp.pth
  (cd $U && $PY -c "import torch, gsplat, insightface; torch._dynamo.config.disable = True
from uika.runners.infer.checkpoint import build_model_from_config; print('UIKA env OK')")
  touch $E/.ok
fi
if [ ! -f $M/.ok ]; then
  mkdir -p $M/uika $M/tools $M/human_parametric_models
  $PY - <<EOF
import hashlib, shutil, tarfile, urllib.request
from pathlib import Path
from huggingface_hub import hf_hub_download
M = Path("$M")
def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 24), b""): h.update(b)
    return h.hexdigest()
tar = hf_hub_download("Yuukki/UIKA", "human_parametric_models.tar", local_dir="$TMP/uika-hp")
with tarfile.open(tar) as t:
    for m in t.getmembers():
        if m.isfile() and Path(m.name).name not in ("flame2023.pkl", "FLAME_masks.pkl"):
            with t.extractfile(m) as s, open(M / "human_parametric_models" / Path(m.name).name, "wb") as d:
                shutil.copyfileobj(s, d)
for url, name, want in [
        ("https://github.com/chroneus/stylematte/releases/download/weights/stylematte_synth.pth", "stylematte_synth.pt",
         "5ce985571e909b6677d7d25e560216fa3f620e5cd337a8382ee0799c6d9af16c"),
        ("https://huggingface.co/okupyn/vgg_heads/resolve/main/vgg_heads_l.trcd", "vgg_heads_l.trcd",
         "18acb79c53032db11e8f502c12fdd34b5f642e9bc9041bce152c7b716c1b6f74")]:
    dst = M / "tools" / name
    with urllib.request.urlopen(url) as r, open(dst, "wb") as f:
        shutil.copyfileobj(r, f)
    assert sha(dst) == want, name
p = hf_hub_download("Yuukki/UIKA", "uika.safetensors", local_dir=str(M / "uika"))
assert sha(p) == "a1d7f56e0e8073de5699f9ad247c08c88f203c79bff37babdfdc84e7641eb46a", "uika.safetensors checksum"
EOF
  rm -rf $TMP/uika-hp $M/uika/.huggingface $M/uika/.cache
  F=$L/models/lhmpp/pretrained_models/human_model_files/flame_assets/flame
  ln -sf $F/flame2023.pkl $M/human_parametric_models/flame2023.pkl
  ln -sf $F/FLAME_masks.pkl $M/human_parametric_models/FLAME_masks.pkl
  touch $M/.ok
fi
ln -sfn $M $U/model_zoo
flock -u 9
du -sh $E $M

SMPLX=$L/models/smplx/SMPLX_NEUTRAL.npz IDS=$L/models/smplx/SMPL-X__FLAME_vertex_ids.npy
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
if [[ ",$STAGES," == *",teacher,"* ]]; then
  (cd $U && $PY -u $CODE/uika_head.py teacher --person "$NAME" --photos "$FACES" ${USE:+--use "$USE"} \
    --out "$TEACHER" --uika $U --held "$HELD" ${SIZE:+--size "$SIZE"}) 2>&1 | grep -vE "NVML|warnings.warn"
  [ "${PIPESTATUS[0]}" -eq 0 ] || exit 1
fi
if [[ ",$STAGES," == *",distill,"* ]]; then
  $PY -u $CODE/uika_head.py distill --person "$NAME" --avatar "$DREAMS/$AVATAR" --teacher "$TEACHER" \
    --smplx "$SMPLX" --flame-ids "$IDS" --flame-masks $M/human_parametric_models/FLAME_masks.pkl --id "$NEW" \
    --held "$HELD" --body "${BODY:-raw}" ${STEPS:+--steps "$STEPS"} \
    ${SEAM_OFFSET:+--seam-offset "$SEAM_OFFSET"} 2>&1 | grep -vE "NVML|warnings.warn"
  [ "${PIPESTATUS[0]}" -eq 0 ] || exit 1
  # CLEANUP: the body's own flags (e.g. "--body-only --mute 0.35 --flatten 0.35 --deflate 0.5"); the head is kept
  # either way (finish restores its fitted colours)
  # shellcheck disable=SC2086
  [ "${CLEANUP:-}" = skip ] || $PY -u $CODE/lhmpp_cleanup.py "$DREAMS/$NEW" --smplx "$SMPLX" ${CLEANUP:-}
  $PY -u $CODE/uika_head.py finish "$DREAMS/$NEW" 2>&1 | grep -vE "NVML|warnings.warn"
  [ "${PIPESTATUS[0]}" -eq 0 ] || exit 1
fi
if [[ ",$STAGES," == *",judge,"* ]]; then
  # LHM++'s yardstick (its ArcFace, on the LHM++ prep photos) runs from its checkout, which reads ./pretrained_models
  (cd $L/repos/LHM-plusplus && $PY -u $CODE/uika_head.py judge --old "$DREAMS/$AVATAR" --new "$DREAMS/$NEW" \
    --photos "$FACES" ${USE:+--use "$USE"} --prep "$PREP" --teacher "$TEACHER" \
    --insightface-root $L/models/insightface --out "$JUDGE") 2>&1 | grep -vE "NVML|warnings.warn"
  [ "${PIPESTATUS[0]}" -eq 0 ] || exit 1
fi
blue_quota 2>/dev/null | sed -n 4p || true
echo UIKA_DISTILL_OK
