#!/bin/bash
#SBATCH --job-name=lucid-clean-check
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-b200
#SBATCH --gpus=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=48G
#SBATCH --time=01:00:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/logs/clean-check-%j.log
# lucid.clean's proof for replays: renders against the real frames and the generated views, with and without what
# lucid.clean drops, plus contact sheets. Keep files come from the Mac (python -m lucid.clean <bundle> --keep-out ...).
#   sbatch --export=ALL,RUNS="jump-shot-hq golf-01",KEEPS=$L/jobs/clean/keep,OUT=$L/jobs/clean/out pipeline/hpg/clean-check.sbatch
# CODE (default $L/code/pipeline) is the pipeline checkout to run. Per run: $OUT/<run>/check.json, sheet-*.jpg,
# real-camera.jpg, and a summary line; keep files are $KEEPS/<run>.<variant>.keep.npz (every variant is measured).
# SUPPORT=<clean-support.sbatch's OUT> measures held-out chunks through their refined real cameras. CHECK_ARGS passes
# more flags (separate lists with colons: --export splits on commas), e.g. CHECK_ARGS='--sheet-variant a:b --sheets 10:76'.
set -u
L=/blue/iruchkin/vishalnaveen/lucid
set +u; source $L/code/pipeline/hpg/env.sh; set -u
export PYTHONPATH=${CODE:-$L/code/pipeline}:$L/repos/4DAnyone
export OMP_NUM_THREADS=4
OUT=${OUT:-$L/jobs/clean/out}
for r in ${RUNS:?name the runs}; do
  echo "===== $r"
  KS=$(ls ${KEEPS:-/nonexistent}/$r.*.keep.npz 2>/dev/null | sort)
  CAMS=${SUPPORT:-/nonexistent}/$r/real-cameras.json
  python -u -m lucid.clean_check --run $L/runs/$r --out $OUT/$r ${KS:+--keep $KS} $([ -f $CAMS ] && echo --cameras $CAMS) \
    ${CHECK_ARGS:-} || echo "CHECK_FAILED $r"
done
echo JOB_DONE
