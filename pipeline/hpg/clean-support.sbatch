#!/bin/bash
#SBATCH --job-name=lucid-clean-support
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-b200
#SBATCH --gpus=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=48G
#SBATCH --time=01:30:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/logs/clean-support-%j.log
# What the cameras say about each Gaussian of a replay (lucid.clean_support), for lucid.clean --support:
#   sbatch --export=ALL,RUNS="jump-shot-hq golf-01",OUT=$L/jobs/clean/support pipeline/hpg/clean-support.sbatch
# Per run: $OUT/<run>/support.npz (~20 MB; fetch it to the Mac, then delete it here) and real-cameras.json.
set -u
L=/blue/iruchkin/vishalnaveen/lucid
set +u; source $L/code/pipeline/hpg/env.sh; set -u
export PYTHONPATH=${CODE:-$L/code/pipeline}:$L/repos/4DAnyone
export OMP_NUM_THREADS=4
OUT=${OUT:-$L/jobs/clean/support}
for r in ${RUNS:?name the runs}; do
  echo "===== $r"
  python -u -m lucid.clean_support --run $L/runs/$r --out $OUT/$r || echo "SUPPORT_FAILED $r"
done
echo JOB_DONE
