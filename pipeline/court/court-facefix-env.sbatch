#!/bin/bash
#SBATCH --job-name=court-facefix-env
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --time=00:45:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# Court Side: the env and models for court-job's FACEFIX (court_facefix.py: the player's real face on the views).
# A small venv layered on the 4danyone env (numpy, OpenCV, ffmpeg and the CUDA 12 / cuDNN 9 wheels come from there; only
# onnxruntime-gpu and onnx land in the venv) and the face models in $L/models/facefix: SCRFD det_10g and ArcFace
# w600k_r50 (InsightFace buffalo_l), inswapper_128, and inswapper_emap.npy (its last initializer, so the jobs need no
# onnx), each sha256-checked against the Mac's copies. Downloads land in node scratch; only checked files move to Blue
# (~0.8 GB). Ends with a CPU smoke test of the whole swap. Submit with court-facefix-env.sh. Safe to re-run.
set -euo pipefail
L=${L:-/blue/iruchkin/vishalnaveen/lucid}  # L: court-hpg.sh passes it
C=$L/code/pipeline/court
M=$L/models/facefix
ORT=onnxruntime-gpu==1.26.0  # the newest CUDA 12 / cuDNN 9 build (1.27 on are CUDA 13), as torch cu128 in 4danyone
BUFFALO=https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip
SWAP=https://huggingface.co/ezioruan/inswapper_128.onnx/resolve/main/inswapper_128.onnx
declare -A SHA=(
  [det_10g.onnx]=5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91
  [w600k_r50.onnx]=4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43
  [inswapper_128.onnx]=e4a3f08c753cb72d04e10aa0f7dbe3deebbf39567d4ead6dce08e98aa49e16af
)
EMAP_SHA=370af5bf707dafdbea8a40448d697d9697610bd223ecf92887af9c9cc7055ac8  # sha256 of the emap's little-endian float32 bytes
export PIP_CACHE_DIR=${TMPDIR:-/tmp}/pip TMPDIR=${TMPDIR:-/tmp}
module load conda/26.7 cuda/12.8.1
eval "$(conda shell.bash hook)"
conda activate $L/envs/4danyone
[ -x $L/envs/facefix/bin/python ] || python -m venv --system-site-packages $L/envs/facefix
source $L/envs/facefix/bin/activate
python -c "import onnxruntime, onnx" 2>/dev/null || pip install -q "$ORT" onnx
python -c "import onnxruntime as o, numpy, cv2; print('onnxruntime', o.__version__, o.get_available_providers(), 'numpy', numpy.__version__, 'cv2', cv2.__version__)"
mkdir -p "$M"
have() { [ -s "$M/$1" ] && [ "$(sha256sum "$M/$1" | cut -d' ' -f1)" = "${SHA[$1]}" ]; }
if ! have det_10g.onnx || ! have w600k_r50.onnx; then
  wget -q -O "$TMPDIR/buffalo_l.zip" "$BUFFALO"
  python -c "import zipfile, sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2], ['det_10g.onnx', 'w600k_r50.onnx'])" \
    "$TMPDIR/buffalo_l.zip" "$TMPDIR"
  for f in det_10g.onnx w600k_r50.onnx; do
    GOT=$(sha256sum "$TMPDIR/$f" | cut -d' ' -f1)
    [ "$GOT" = "${SHA[$f]}" ] || { echo "$f: sha256 $GOT, wanted ${SHA[$f]}" >&2; exit 1; }
    mv "$TMPDIR/$f" "$M/$f"
  done
fi
if ! have inswapper_128.onnx; then
  wget -q -O "$TMPDIR/inswapper_128.onnx" "$SWAP"
  GOT=$(sha256sum "$TMPDIR/inswapper_128.onnx" | cut -d' ' -f1)
  [ "$GOT" = "${SHA[inswapper_128.onnx]}" ] || { echo "inswapper_128.onnx: sha256 $GOT" >&2; exit 1; }
  mv "$TMPDIR/inswapper_128.onnx" "$M/inswapper_128.onnx"
fi
for f in "${!SHA[@]}"; do have "$f" || { echo "$M/$f: sha256 mismatch (left as is)" >&2; exit 1; }; done
python - "$M" "$EMAP_SHA" <<'PY'
import hashlib, sys
from pathlib import Path
import numpy as np, onnx
from onnx import numpy_helper
m, want = Path(sys.argv[1]), sys.argv[2]
e = numpy_helper.to_array(onnx.load(str(m / "inswapper_128.onnx")).graph.initializer[-1]).astype("<f4")
got = hashlib.sha256(e.tobytes()).hexdigest()
if e.shape != (512, 512) or got != want:
    sys.exit(f"inswapper emap: shape {e.shape}, sha256 {got}, wanted {want}")
np.save(m / "inswapper_emap.npy", e)
print("inswapper_emap.npy", e.shape, "ok")
PY
du -sh $L/envs/facefix "$M"
# the whole swap on CPU (the GPU is tried by the jobs and falls back to this): models load, a face is found and swapped
python - "$C" "$M" <<'PY'
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import court_facefix as ff
f = ff.Faces(Path(sys.argv[2]), swap=True, cpu_only=True)
print("facefix smoke test OK on", f.used)
PY
touch $L/envs/facefix/.court-facefix-ok   # court-hpg.sh won't rebuild it
echo SETUP_OK
