#!/bin/bash
# Court Side (stream E): submit the 4K floor fusion (floor-fusion.sbatch) on HiPerGator. Login node: bash and awk only.
#   floor-fusion-submit.sh        from the upload folder DATA (default: where this script sits)
# Checks first and submits nothing if any fails: every input in DATA, the jobs' python, the plan's tile count, OUT
# never submitted before, the group's free space (MIN_GB, default 2; QUOTA_GROUP picks the group). Then three jobs,
# each waiting on the one before: a 1-CPU decode probe, the tile array (one task per plan tile, CONC at a time,
# default 20 x 4 CPUs = 80 cores) and the stitch (master floor, shipped candidates, seat-view sheets).
# From the environment (nothing about the allocation is written here): L2 (the cluster base: runs/ and envs/),
# ACCOUNT and QOS (required), PARTITION (optional). TAG names the run (OUT=$L2/runs/mosaic4k/$TAG, default run1);
# DRY=1 checks only; PY the python (default the 4DAnyone env's under L2).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/court-lib.sh"
[ -n "${L2:-}" ] || fail "L2 (the cluster base) not set"
[ -n "${ACCOUNT:-}" ] && [ -n "${QOS:-}" ] || fail "ACCOUNT and QOS not set (the allocation to run on)"
DATA=${DATA:-$HERE}
TAG=${TAG:-run1}
OUT=${OUT:-$L2/runs/mosaic4k/$TAG}
PY=${PY:-$L2/envs/4danyone/bin/python}
SB=$HERE/floor-fusion.sbatch
[[ $TAG =~ ^[a-z0-9][a-z0-9-]*$ ]] || fail "TAG=$TAG"
for f in floor_fusion.py plan.json run.json cams.json det.json masks.tar source.mp4 court.json floor-before.jpg; do
  test -s "$DATA/$f" || fail "missing $DATA/$f"
done
test -r "$SB" || fail "no $SB"
test -x "$PY" || fail "no python at $PY"
N=$(grep -o '"frames": *\[' "$DATA/plan.json" | wc -l | tr -d ' ')
(( N >= 1 && N <= 500 )) || fail "plan.json has $N tiles"
test -e "$OUT/logs/submitted" && fail "$OUT was submitted before ($(cat "$OUT/logs/submitted")); use a new TAG"
CONC=${CONC:-20}
[[ $CONC =~ ^[1-9][0-9]*$ ]] || fail "CONC=$CONC"
for v in ACCOUNT QOS PARTITION; do
  [[ -z ${!v:-} || ${!v} =~ ^[A-Za-z0-9_.,-]+$ ]] || fail "$v='${!v}'"
done
FREE=$(group_free_gb)
(( ${FREE:-0} >= ${MIN_GB:-2} )) || fail "group quota has ${FREE:-?} GB free, need ${MIN_GB:-2} for the results"
echo "OK: $N tiles, $CONC at a time x 4 CPUs; DATA $DATA; OUT $OUT; ${FREE} GB free" \
  "${ACCOUNT:+; account $ACCOUNT}${QOS:+, qos $QOS}${PARTITION:+, partition $PARTITION}"
[ "${DRY:-0}" = 1 ] && { echo "DRY: nothing submitted"; exit 0; }
mkdir -p "$OUT/logs"
cd "$OUT/logs"
X=(${ACCOUNT:+--account=$ACCOUNT} ${QOS:+--qos=$QOS} ${PARTITION:+--partition=$PARTITION})
E="ALL,DATA=$DATA,OUT=$OUT,L2=$L2,PY=$PY"
P=$(sbatch --parsable ${X[@]+"${X[@]}"} --cpus-per-task=1 --mem=4G --time=00:15:00 --export="$E,MODE=probe" "$SB")
A=$(sbatch --parsable ${X[@]+"${X[@]}"} --dependency=afterok:$P --array=0-$((N - 1))%$CONC --export="$E,MODE=tile" "$SB")
S=$(sbatch --parsable ${X[@]+"${X[@]}"} --dependency=afterok:$A --mem=16G --time=00:45:00 --export="$E,MODE=stitch" "$SB")
echo "probe=$P array=$A stitch=$S $(date '+%F %T')" > "$OUT/logs/submitted"
echo "SUBMITTED probe=$P array=$A ($N tasks, $CONC at a time) stitch=$S; logs in $OUT/logs"
