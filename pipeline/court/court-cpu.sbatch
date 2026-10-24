#!/bin/bash
#SBATCH --job-name=court-cpu
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=16
#SBATCH --mem=32G
#SBATCH --time=01:00:00
#SBATCH --output=%x-%j.log
# Court Side: a CPU bundle (court-<name>: run.sh and its files, uploaded to DATA) run in node-local scratch. Submitted
# by court-hpg.sh with L, RUN, DATA and OUT_FILE (<name>.tar: what run.sh leaves beside itself, the only file copied
# back to RUN); with IN_TAR (a SAM run's masks-sam.tar) it is unpacked into $TMPDIR/in, which becomes run.sh's
# argument; JOB_ENV's NAME=value pairs arrive in the environment. Python: the 4danyone env (numpy, opencv), as PY.
# The upload on Blue is only read; nothing deleted.
set -euo pipefail
L=${L:-/blue/iruchkin/vishalnaveen/lucid}  # L: court-hpg.sh passes it
module load conda/26.7 >/dev/null 2>&1
eval "$(conda shell.bash hook)"
conda activate $L/envs/4danyone
export TMPDIR=${TMPDIR:-/tmp}
python3 -c "import numpy, cv2; print('python', numpy.__version__, cv2.__version__)"
export PY=$(command -v python3)  # run.sh's python: this env's
T=$TMPDIR/bundle
cp -r "$DATA" "$T"
ARGS=()
if [ -n "${IN_TAR:-}" ]; then
  mkdir -p "$TMPDIR/in"
  tar -xf "$IN_TAR" -C "$TMPDIR/in"
  ARGS=("$TMPDIR/in")
fi
cd "$T"
bash run.sh ${ARGS[@]+"${ARGS[@]}"}
cp "$T/${OUT_FILE:?}" "$RUN/$OUT_FILE.part" && mv "$RUN/$OUT_FILE.part" "$RUN/$OUT_FILE"
ls -l "$RUN/$OUT_FILE"
