#!/bin/bash
# Court Side freeze grid from the Mac, in one command, with the HiPerGator session open (`ssh hpg true`): uploads the
# court scripts to $L/code/pipeline/court/ and each run folder to $L/data/court/<id>/, then submits one court-job.sbatch
# per run there (court-job-submit.sh: checks, then sbatch; each job works in node-local scratch) and prints the job ids.
# Usage: court-grid.sh <runs dir> [id...]
#   ids default to every court-* folder in <runs dir>: Turbo first, then stride 2 before stride 1, then by name.
# Env: PLAN=1 uploads, then runs the HPG side's checks and submits nothing; DRY=1 only prints what would run;
#      HOST (hpg); VARIANTS, CAPS, METRICS, ITERS, FACE, NGPU, MEM, TIME and MIN_GB are passed to the HPG side.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
RUNS=$(cd "${1:?usage: court-grid.sh <runs dir> [id...]}" && pwd); shift
HOST=${HOST:-hpg}; L=/blue/iruchkin/vishalnaveen/lucid
if (( $# )); then IDS=("$@"); else
  IDS=($(cd "$RUNS" && ls -d court-* | python3 -c 'import sys
ids = sys.stdin.read().split()
print(" ".join(sorted(ids, key=lambda i: ("turbo" not in i, not i.endswith("-s2"), i))))'))
fi
(( ${#IDS[@]} )) || { echo "no court-* run folders in $RUNS" >&2; exit 1; }
for id in "${IDS[@]}"; do
  for f in input.mp4 job.json court-run.json source-4k.mkv; do
    test -s "$RUNS/$id/$f" || { echo "missing $RUNS/$id/$f" >&2; exit 1; }
  done
done
PASS=""
for v in VARIANTS CAPS METRICS ITERS FACE NGPU MEM TIME MIN_GB; do
  [ -n "${!v:-}" ] && PASS="$PASS $v=$(printf %q "${!v}")"
done
[ "${PLAN:-0}" = 1 ] && PASS="$PASS DRY=1"
SSH="ssh -o ControlMaster=no -o BatchMode=yes"
REMOTE="env$PASS bash $L/code/pipeline/court/court-job-submit.sh ${IDS[*]}"
run() { if [ "${DRY:-0}" = 1 ]; then echo "+ $*"; else "$@"; fi; }
if [ "${DRY:-0}" != 1 ]; then
  $SSH "$HOST" true 2>/dev/null || { echo "open the HiPerGator connection first: ssh $HOST true" >&2; exit 3; }
fi
run $SSH "$HOST" "mkdir -p $L/code/pipeline/court $L/data/court"
run rsync -a -e "$SSH" "$HERE"/{court-job.sbatch,court-job-submit.sh,court-lib.sh,court_fetch_seedvr2.py,court_grid_report.py} \
  "$HOST:$L/code/pipeline/court/"
for id in "${IDS[@]}"; do
  run rsync -a -e "$SSH" "$RUNS/$id/" "$HOST:$L/data/court/$id/"
done
run $SSH "$HOST" "$REMOTE"
