#!/bin/bash
# Court Side: preflight, then one player's whole chain. Usage: court-submit.sh <id>
# The run's folder (player_clip.py's runs/<id>/) is rsynced from the Mac to $L/data/court/<id>/ first. K and FOCAL come
# from its court-run.json, never from the command line. Nothing is submitted if a file is missing, a number is off,
# the run was submitted before, or the group quota is short. (The A/B grid is court-grid-hpg.sh.)
# Env: VIEWS_ONLY=1 (4DAnyone views only: the Turbo checks), CAPS ("300000 250000 200000"), MIN_GB (20), ITERS, FACE.
set -euo pipefail
ID=${1:-}
L=${L:-/blue/iruchkin/vishalnaveen/lucid}; H=$L/code/pipeline/hpg; C=$L/code/pipeline/court
DATA=$L/data/court/$ID; RUN=$L/runs/$ID
source "$(dirname "$0")/court-lib.sh"
[[ $ID =~ ^court-[a-z0-9][a-z0-9-]*$ ]] || fail "id '$ID'"
(( $# == 1 )) || fail "only the id is taken (K and FOCAL come from court-run.json)"
# the shipped chain trains on the real views with the real camera held: A/B settings belong in court-ab.sh
[ -z "${EXTRA:-}${RESULT:-}" ] || fail "EXTRA/RESULT are set ('${EXTRA:-}' '${RESULT:-}'): A/B runs go through court-ab.sh"
preflight "$ID" "${VIEWS_ONLY:-0}"
FREE=$(group_free_gb)
(( ${FREE:-0} >= ${MIN_GB:-20} )) || fail "group quota has ${FREE:-?} GB free, need ${MIN_GB:-20}"
mkdir -p "$RUN/logs"
cp -r "$DATA"/. "$RUN"/
cd "$RUN/logs"
V=$(sbatch --parsable --export=ALL,RUN=$RUN "$H/stage-views.sbatch")
if [ "${VIEWS_ONLY:-0}" = 1 ]; then
  echo "views=$V" > "$RUN/logs/submitted"
  echo "SUBMITTED $ID views=$V"; exit 0
fi
CAPS=${CAPS:-"300000 250000 200000"}; R=""; E=""
for CAP in $CAPS; do
  T=$((CAP / 1000))k
  r=$(sbatch --parsable --dependency=afterok:$V --export=ALL,RUN=$RUN,K=$K,FOCAL=$FOCAL,CAP=$CAP,OUT=recon-$T,RESULT=views,EXTRA= "$C/court-freeze.sbatch")
  E="$E:$(sbatch --parsable --dependency=afterok:$r --export=ALL,RUN=$RUN,RECON=recon-$T,OUT=bundle-$T "$C/court-export.sbatch")"
  R="$R:$r"
done
M=$(sbatch --parsable --dependency=afterok:$V --job-name=court-metrics \
  --export=ALL,RUN=$RUN,K=$K,FOCAL=$FOCAL,CAP=${CAPS%% *},OUT=recon-metrics,HOLDOUT=8,RESULT=views,EXTRA= "$C/court-freeze.sbatch")
CV=$(sbatch --parsable --dependency=afterok$R:$M --export=ALL,RUN=$RUN,WHAT=views "$C/court-clean.sbatch")
CF=$(sbatch --parsable --dependency=afterok$E:$M --export=ALL,RUN=$RUN,WHAT=frames "$C/court-clean.sbatch")
echo "views=$V recons=$R metrics=$M exports=$E clean=$CV,$CF" > "$RUN/logs/submitted"
echo "SUBMITTED $ID K=$K FOCAL=$FOCAL views=$V recons=$R metrics=$M exports=$E clean=$CV,$CF"
