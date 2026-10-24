#!/bin/bash
# Court Side: submit court-job.sbatch once per run id (login node: bash and awk only, no python). Usage:
#   court-job-submit.sh <id>...          each id's folder already uploaded to $L/data/court/<id>/
# Checks first, for every id, and submits nothing if any fails: the id, the uploaded files, the ids inside job.json and
# court-run.json, never submitted before, and the group's free space (MIN_GB, default 2: results only come back).
# Env passed to the jobs: VARIANTS, CAPS, METRICS, ITERS, FACE; NGPU (GPUs per job, default 4), MEM and TIME (sbatch
# overrides); DRY=1 checks only.
set -euo pipefail
L=${L:-/blue/iruchkin/vishalnaveen/lucid}; C=$L/code/pipeline/court
source "$(dirname "$0")/court-lib.sh"
(( $# )) || fail "no run ids"
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
  test -e "$L/runs/$id/logs/submitted" && fail "$id was submitted before ($(cat "$L/runs/$id/logs/submitted")); use a new id"
done
FREE=$(group_free_gb)
(( ${FREE:-0} >= ${MIN_GB:-2} )) || fail "group quota has ${FREE:-?} GB free, need ${MIN_GB:-2} for the results"
echo "OK: $# run(s), ${FREE} GB free on /blue, ${NGPU:-4} GPU(s) each, variants ${VARIANTS:-raw:default raw:agree up:default up:agree}"
[ "${DRY:-0}" = 1 ] && { echo "DRY: nothing submitted"; exit 0; }
for id in "$@"; do
  mkdir -p "$L/runs/$id/logs"
  cd "$L/runs/$id/logs"
  J=$(sbatch --parsable --gres=gpu:${NGPU:-4} ${MEM:+--mem=$MEM} ${TIME:+--time=$TIME} --export=ALL,ID=$id "$C/court-job.sbatch")
  echo "job=$J $(date '+%F %T')" > "$L/runs/$id/logs/submitted"
  echo "SUBMITTED $id job=$J (log: $L/runs/$id/logs/court-job-$J.log)"
done
