#!/bin/bash
# Court Side: the mask jobs on HiPerGator, smallest first. Usage: court-hpg.sh <id>
#   court-sam-env     the SAM 2.1 venv + weights (court-sam-env.sbatch, CPU, once; ~0.9 GB on Blue)
#   court-sam-people  every floor-level person, ids kept (court-masks.sbatch); needs the env built, and
#                     $L/data/court/court-sam-people/{frames.zip, plan.json, sam_people.py} (sam_pack.py, then rsync)
#   court-sam-<name>  SAM masks from box/click prompts (court-sam.sbatch), e.g. court-sam-pair, court-sam-extras;
#                     needs the env built, and $L/data/court/court-sam-<name>/ holding one set or one folder per set,
#                     each prompts.json + frames.zip, or + the clip it names (decoded on the node)
#   court-rematte-<name>  the band matte again on court-sam-<name>'s masks (court-sam.sbatch, MASKS_TAR): reuses
#                     its upload and $L/runs/court-sam-<name>/masks-sam.tar; result masks-alpha.tar
#   court-matte       soft edges for the pair's SAM masks (court-matte.sbatch); needs
#                     $L/data/court/court-matte/crops.zip (court_matte.py pack, then rsync)
# Nothing is submitted if a file is missing, a job was submitted before, or the group quota has less than MIN_GB (5)
# free. Login-node safe: bash, awk and sbatch only. Deletes nothing.
set -euo pipefail
ID=${1:-}
L=${L:-/blue/iruchkin/vishalnaveen/lucid}; C=$L/code/pipeline/court
DATA=$L/data/court/$ID; RUN=$L/runs/$ID
source "$(dirname "$0")/court-lib.sh"
(( $# == 1 )) || fail "one id: court-sam-env, court-sam-people, court-sam-<name>, court-rematte-<name> or court-matte"
ENV_OK=$L/envs/sam2/.court-sam-ok
# SAM sets in an upload: the folder itself or its subfolders, each prompts.json + frames.zip (or a clip it names)
count_sets() {
  local n=0 d
  for d in "$1" "$1"/*/; do
    if [ -s "$d/prompts.json" ] && { [ -s "$d/frames.zip" ] || compgen -G "$d/*.mp4" >/dev/null; }; then
      n=$((n + 1))
    fi
  done
  echo $n
}
case $ID in
  court-sam-env) NEED="" ;;
  court-sam-people) NEED="frames.zip plan.json sam_people.py"; JOB=court-masks.sbatch; TAR=masks-people.tar ;;
  court-matte) NEED="crops.zip"; JOB=court-matte.sbatch; TAR=masks-matte.tar ;;
  court-rematte-*)
    [[ $ID =~ ^court-rematte-([a-z0-9][a-z0-9-]*)$ ]] || fail "id '$ID'"
    SRC=court-sam-${BASH_REMATCH[1]}; DATA=$L/data/court/$SRC
    NEED=""; JOB=court-sam.sbatch; TAR=masks-alpha.tar
    EXTRA=",MASKS_TAR=$L/runs/$SRC/masks-sam.tar"
    test -s "$L/runs/$SRC/masks-sam.tar" || fail "no $L/runs/$SRC/masks-sam.tar to matte"
    (( $(count_sets "$DATA") )) || fail "no set (prompts.json + frames.zip or a clip) in $DATA or its folders" ;;
  court-sam-*)
    [[ $ID =~ ^court-sam-[a-z0-9][a-z0-9-]*$ ]] || fail "id '$ID'"
    NEED=""; JOB=court-sam.sbatch; TAR=masks-sam.tar
    (( $(count_sets "$DATA") )) || fail "no set (prompts.json + frames.zip or a clip) in $DATA or its folders" ;;
  *) fail "id '$ID' (court-sam-env, court-sam-people, court-sam-<name> or court-matte)" ;;
esac
for f in $NEED; do test -s "$DATA/$f" || fail "missing $DATA/$f"; done
if [ "$ID" = court-sam-env ]; then
  test -e "$ENV_OK" && fail "the SAM env is already built ($ENV_OK)"
elif [[ $ID == court-sam-* || $ID == court-rematte-* ]]; then
  test -e "$ENV_OK" && test -s "$L/models/sam2/checkpoints/sam2.1_hiera_large.pt" ||
    fail "the SAM env isn't built yet: court-hpg.sh court-sam-env, and wait for its SETUP_OK in $L/jobs/"
fi
if [ "$ID" != court-sam-env ] && test -e "$RUN/logs/submitted"; then
  fail "$ID was submitted before ($(cat "$RUN/logs/submitted"))"
fi
FREE=$(group_free_gb)
(( ${FREE:-0} >= ${MIN_GB:-5} )) || fail "group quota has ${FREE:-?} GB free, need ${MIN_GB:-5}"
if [ "$ID" = court-sam-env ]; then
  mkdir -p "$L/jobs"
  cd "$L/jobs"
  J=$(sbatch --parsable "$C/court-sam-env.sbatch")
  echo "SUBMITTED court-sam-env job=$J (log: $L/jobs/court-sam-env-$J.log, ends with SETUP_OK)"
  exit 0
fi
mkdir -p "$RUN/logs"
cd "$RUN/logs"
J=$(sbatch --parsable --export=ALL,RUN=$RUN,DATA=$DATA${EXTRA:-} "$C/$JOB")
echo "job=$J" > "$RUN/logs/submitted"
echo "SUBMITTED $ID job=$J (log: $RUN/logs/${JOB%.sbatch}-$J.log; result: $RUN/$TAR)"
