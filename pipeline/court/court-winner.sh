#!/bin/bash
# Court Side: the grid's winner gets the headset's other two caps. Usage: court-winner.sh <id> raw|up
# Trains 250k and 200k (CAPS) from the views that won (re-making SeedVR2's views-up first if they're gone), exports
# both, then drops the run's views and frames. K and FOCAL come from the run's court-run.json.
set -euo pipefail
ID=${1:-}; V=${2:-}
L=${L:-/blue/iruchkin/vishalnaveen/lucid}; H=$L/code/pipeline/hpg; C=$L/code/pipeline/court; RUN=$L/runs/$ID
fail() { echo "WINNER FAIL: $*" >&2; exit 1; }
[[ $ID =~ ^court-[a-z0-9][a-z0-9-]*$ ]] || fail "id '$ID'"
[[ $V == raw || $V == up ]] || fail "variant '$V' (raw or up)"
[ -z "${EXTRA:-}${RESULT:-}" ] || fail "EXTRA/RESULT are set: the winner's caps train exactly like the grid"
read -r K FOCAL < <(python3 -c 'import json, sys; r = json.load(open(sys.argv[1])); print(r["K"], r["FOCAL"])' \
  "$RUN/court-run.json") || fail "no $RUN/court-run.json"
[[ $K =~ ^[0-9]+$ ]] && (( K <= 120 )) && [[ $FOCAL =~ ^[0-9]+([.][0-9]+)?$ ]] || fail "K=$K FOCAL=$FOCAL"
ls "$RUN"/views/videos/*.mp4 >/dev/null 2>&1 || fail "$RUN/views/videos is gone (KEEP_FULL_VIEWS=0?): re-make the views first"
cd "$RUN/logs"
DEPS="--kill-on-invalid-dep=yes"; dep=""; res=views; LINE=""
if [ "$V" = up ]; then
  res=views-up
  if ! ls "$RUN"/views-up/videos/*.mp4 >/dev/null 2>&1; then
    U=$(sbatch --parsable --export=ALL,RUN=$RUN "$H/stage-upscale.sbatch")
    dep="--dependency=afterok:$U"; LINE="upscale=$U "
  fi
fi
R=""; E=""
for CAP in ${CAPS:-250000 200000}; do
  T=$((CAP / 1000))k
  r=$(sbatch --parsable $DEPS $dep --export=ALL,RUN=$RUN,K=$K,FOCAL=$FOCAL,CAP=$CAP,OUT=recon-$V-$T,RESULT=$res,EXTRA= "$C/court-freeze.sbatch")
  e=$(sbatch --parsable $DEPS --dependency=afterok:$r --export=ALL,RUN=$RUN,RECON=recon-$V-$T,OUT=bundle-$V-$T "$C/court-export.sbatch")
  R="$R:$r"; E="$E:$e"; LINE="$LINE$V-$T=$r export=$e "
done
cv=$(sbatch --parsable $DEPS --dependency=afterany$R --export=ALL,RUN=$RUN,WHAT=views "$C/court-clean.sbatch")
cf=$(sbatch --parsable $DEPS --dependency=afterany$E --export=ALL,RUN=$RUN,WHAT=frames "$C/court-clean.sbatch")
echo "${LINE}clean=$cv,$cf" >> "$RUN/logs/submitted"
echo "WINNER $ID $V K=$K FOCAL=$FOCAL ${LINE}clean=$cv,$cf"
