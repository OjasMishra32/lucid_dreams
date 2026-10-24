#!/bin/bash
# Court Side: submit court-job.sbatch per run id (login node: bash and awk only, no python). Usage:
#   court-job-submit.sh <id>...          each id's folder already uploaded to $L/data/court/<id>/
# Checks first, for every id, and submits nothing if any fails: the id, the uploaded files and the K frame's masks, the
# ids inside job.json and court-run.json, never submitted before (per tag), and the group's free space (MIN_GB,
# default 2: results only come back).
# SEEDS=N: N jobs per id, 4DAnyone seeds 1..N, results in $L/runs/<id>/seed<k>/; or TAG=<name>
# (e.g. winner) for one more job per id into $L/runs/<id>/<name>/. Env passed to the jobs: VARIANTS, REALS, CAPS,
# METRICS, ITERS, FACE, SEED, SEED_FLAG; NGPU (GPUs per job, default 4), MEM and TIME (sbatch overrides); DRY=1.
set -euo pipefail
L=${L:-/blue/iruchkin/vishalnaveen/lucid}; C=$L/code/pipeline/court
source "$(dirname "$0")/court-lib.sh"
(( $# )) || fail "no run ids"
TAGS=(); SEEDV=()
if [ -n "${SEEDS:-}" ]; then
  [[ $SEEDS =~ ^[1-9][0-9]?$ ]] || fail "SEEDS=$SEEDS"
  [ -z "${TAG:-}${SEED:-}" ] || fail "SEEDS goes alone (no TAG or SEED)"
  for ((k = 1; k <= SEEDS; k++)); do TAGS+=("seed$k"); SEEDV+=("$k"); done
else
  [[ -z ${TAG:-} || $TAG =~ ^[a-z0-9][a-z0-9-]*$ ]] || fail "TAG=$TAG"
  [[ -z ${SEED:-} || $SEED =~ ^[0-9]+$ ]] || fail "SEED=$SEED"
  TAGS=("${TAG:-}"); SEEDV=("${SEED:-}")
fi
seen=" "
for id in "$@"; do
  [[ $id =~ ^court-[a-z0-9][a-z0-9-]*$ ]] || fail "id '$id'"
  [[ $seen != *" $id "* ]] || fail "$id given twice"; seen="$seen$id "
  d=$L/data/court/$id
  for f in input.mp4 job.json court-run.json source-4k.mkv; do test -s "$d/$f" || fail "missing $d/$f"; done
  K=$(grep -Eo '"K": *[0-9]+' "$d/court-run.json" | grep -Eo '[0-9]+$' || true)
  [[ $K =~ ^[0-9]+$ ]] && (( K <= 120 )) || fail "$d/court-run.json has no K (0-120)"
  for f in "masks/$(printf %06d "$K").png" "ignore/$(printf %06d "$K").png"; do test -s "$d/$f" || fail "missing $d/$f"; done
  for f in job.json court-run.json; do
    grep -Eq "\"id\": *\"$id\"" "$d/$f" || fail "$d/$f is not for $id"
  done
  for t in "${TAGS[@]}"; do
    m=$L/runs/$id${t:+/$t}/logs/submitted
    test -e "$m" && fail "$id${t:+ ($t)} was submitted before ($(cat "$m")); use a new id or TAG"
  done
done
FREE=$(group_free_gb)
(( ${FREE:-0} >= ${MIN_GB:-2} )) || fail "group quota has ${FREE:-?} GB free, need ${MIN_GB:-2} for the results"
echo "OK: $# run(s) x ${#TAGS[@]} job(s) = $(( $# * ${#TAGS[@]} )) job(s) of ${NGPU:-4} GPU(s), ${FREE} GB free on /blue;" \
  "variants ${VARIANTS:-raw:default raw:agree}, real views ${REALS:-0 1 2}"
[ "${DRY:-0}" = 1 ] && { echo "DRY: nothing submitted"; exit 0; }
for id in "$@"; do
  for i in "${!TAGS[@]}"; do
    t=${TAGS[i]}; out=$L/runs/$id${t:+/$t}
    mkdir -p "$out/logs"
    cd "$out/logs"
    J=$(sbatch --parsable --gres=gpu:${NGPU:-4} ${MEM:+--mem=$MEM} ${TIME:+--time=$TIME} \
      --export=ALL,ID=$id,TAG=$t,SEED=${SEEDV[i]} "$C/court-job.sbatch")
    echo "job=$J $(date '+%F %T')" > "$out/logs/submitted"
    echo "SUBMITTED $id${t:+ $t} job=$J (log: $out/logs/court-job-$J.log)"
  done
done
