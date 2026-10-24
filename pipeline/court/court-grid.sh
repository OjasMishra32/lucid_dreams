#!/bin/bash
# Court Side freeze grid from the Mac, in one command, with the HiPerGator session open (`ssh hpg true`): uploads the
# court scripts to $L/code/pipeline/court/ and each run folder to $L/data/court/<id>/, then submits one court-job.sbatch
# per run there (court-job-submit.sh: checks, then sbatch; each job works in node-local scratch) and prints the job ids.
# Usage: court-grid.sh <runs dir> [id...]
#   ids default to every court-* folder in <runs dir>: Turbo first, then stride 2 before stride 1, then by name.
# Env: CHECK=1 changes nothing anywhere (one read-only ssh: which of these ids already have folders on /blue, and the
#      group's free space; exit 1 when any does); PLAN=1 UPLOADS (mkdir + rsync on HPG), then runs the HPG side's
#      checks and submits nothing; DRY=1 only prints what would run, without connecting;
#      HOST (hpg); VARIANTS, REALS, CAPS, METRICS, ITERS, FACE, NGPU, MEM, TIME, MIN_GB, SEEDS, SEED, SEED_FLAG and
#      TAG, MIN_SCRATCH_GB, KEEP_MB are passed to the HPG side.
#      Another allocation or login: ACCOUNT, QOS, PARTITION (sbatch overrides) and COURT_HPG_L (that login's /blue base:
#      uploads go there and the jobs read code, env.sh, data and write runs there), with HOST its ssh host; ENV_SH
#      (the jobs' environment script, when that login's stack has its own) and QUOTA_GROUP (whose /blue space counts).
#      COURT_DATA_L: scripts, uploads and results go there instead (e.g. /home while /blue is full; the stack at the
#      /blue base is then only read); CPUS: --cpus-per-task per job.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
RUNS=$(cd "${1:?usage: court-grid.sh <runs dir> [id...]}" && pwd); shift
HOST=${HOST:-hpg}; L=${COURT_HPG_L:-/blue/iruchkin/vishalnaveen/lucid}
D=${COURT_DATA_L:-$L}  # where the scripts, uploads and results go (the stack at $L is only read then)
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
for v in VARIANTS REALS CAPS METRICS ITERS FACE NGPU MEM TIME MIN_GB SEEDS SEED SEED_FLAG TAG MIN_SCRATCH_GB KEEP_MB \
         ACCOUNT QOS PARTITION ENV_SH QUOTA_GROUP CPUS; do
  [ -n "${!v:-}" ] && PASS="$PASS $v=$(printf %q "${!v}")"
done
[ -n "${COURT_HPG_L:-}" ] && PASS="$PASS L=$(printf %q "$L")"
[ -n "${COURT_DATA_L:-}" ] && PASS="$PASS COURT_DATA_L=$(printf %q "$D")"
[ "${PLAN:-0}" = 1 ] && PASS="$PASS DRY=1"
SSH="ssh -o ControlMaster=no -o BatchMode=yes"
REMOTE="env$PASS bash $D/code/pipeline/court/court-job-submit.sh ${IDS[*]}"
run() { if [ "${DRY:-0}" = 1 ]; then echo "+ $*"; else "$@"; fi; }
if [ "${DRY:-0}" != 1 ]; then
  $SSH "$HOST" true 2>/dev/null || { echo "open the HiPerGator connection first: ssh $HOST true" >&2; exit 3; }
fi
if [ "${CHECK:-0}" = 1 ]; then
  run $SSH "$HOST" "bad=0; for id in ${IDS[*]}; do for p in $D/data/court/\$id $D/runs/\$id; do
      [ -e \$p ] && { echo EXISTS \$p; bad=1; }; done; done
    . $D/code/pipeline/court/court-lib.sh 2>/dev/null && echo \"group free: \$(group_free_gb) GB\"
    [ \$bad = 0 ] && echo 'CHECK OK: none of these ids is on /blue yet'; exit \$bad"
  exit
fi
run $SSH "$HOST" "mkdir -p $D/code/pipeline/court $D/data/court"
run rsync -a -e "$SSH" "$HERE"/{court-job.sbatch,court-job-submit.sh,court-lib.sh,court_fetch_seedvr2.py,court_grid_report.py} \
  "$HOST:$D/code/pipeline/court/"
for id in "${IDS[@]}"; do
  run rsync -a -e "$SSH" "$RUNS/$id/" "$HOST:$D/data/court/$id/"
done
run $SSH "$HOST" "$REMOTE"
