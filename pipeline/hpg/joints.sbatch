#!/bin/bash
#SBATCH --job-name=lucid-joints
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=4
#SBATCH --mem=24G
#SBATCH --time=01:30:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/logs/joints-%j.log
# joints.json for replay bundles (pipeline/lucid/joints.py): GVHMR's motion in 4DAnyone's world (CPU), then the body
# joints in bundle space, checked against the reconstruction, written with "joints" named in dream.json.
#   sbatch --export=ALL,RUNS="golf-01 dance-01" pipeline/hpg/joints.sbatch
# Each run prints its alignment ([joints] ... head_xz, pelvis_xz, ankle_up, inside) and JOINTS_OK or JOINTS_OFF.
set -u
L=/blue/iruchkin/vishalnaveen/lucid
REPO=$L/repos/lucid_dreams
mkdir -p $L/logs
flock $L/repos/.lucid_dreams.lock git -C $REPO pull -q --ff-only || echo "repo update skipped"
set +u; source $L/code/pipeline/hpg/env.sh; set -u
export OMP_NUM_THREADS=4
cd $L/repos/4DAnyone
for r in ${RUNS:?name the runs: RUNS="golf-01 dance-01"}; do
  RUN=$L/runs/$r
  echo "===== $r"
  [ -f $RUN/bundle/dream.json ] || { echo "no bundle yet"; continue; }
  [ -f $RUN/views/gvhmr/motion_world.json ] || python -u $REPO/avatars/gvhmr_motion.py --device cpu \
    --gvhmr $RUN/views/gvhmr --out $RUN/views/gvhmr/motion_world.json
  PYTHONPATH=$REPO/pipeline:$REPO/avatars:$PYTHONPATH python -u -m lucid.joints $RUN/bundle \
    --motion $RUN/views/gvhmr/motion_world.json --write
done
echo JOB_DONE
