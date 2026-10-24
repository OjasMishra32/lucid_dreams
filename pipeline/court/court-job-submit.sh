#!/bin/bash
# Court Side: submit court-job.sbatch per run id (login node: bash and awk only, no python). Usage:
#   court-job-submit.sh <id>...          each id's folder already uploaded to $L/data/court/<id>/
# Checks first, for every id, and submits nothing if any fails: the id, the uploaded files and the K frame's masks, the
# ids inside job.json and court-run.json, never submitted before (per tag), and the group's free space (MIN_GB,
# default 2: results only come back).
# SEEDS=N: N jobs per id, 4DAnyone seeds 1..N, results in $L/runs/<id>/seed<k>/; or TAG=<name>
# (e.g. winner) for one more job per id into $L/runs/<id>/<name>/. Env passed to the jobs: VARIANTS, REALS, CAPS,
# METRICS, ITERS, FACE, SEED, SEED_FLAG; NGPU (GPUs per job, default 4), MEM and TIME (sbatch overrides); DRY=1.
# Another allocation: ACCOUNT, QOS, PARTITION override the job script's own #SBATCH lines; L (its /blue base, holding
# code/, data/ and runs/ and what env.sh points at) and ENV_SH (the environment script the jobs source) reach the jobs
# too; QUOTA_GROUP picks whose /blue space is checked. COURT_DATA_L: uploads, results and these scripts live there
# instead of under $L (free space then from df); CPUS: --cpus-per-task.
set -euo pipefail
L=${L:-/blue/iruchkin/vishalnaveen/lucid}  # the stack the jobs source (env.sh): only read
D=${COURT_DATA_L:-$L}; C=$D/code/pipeline/court  # uploads, results and these scripts (COURT_DATA_L: elsewhere)
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
[[ -z ${CPUS:-} || $CPUS =~ ^[1-9][0-9]*$ ]] || fail "CPUS=$CPUS"
for v in ACCOUNT QOS PARTITION; do
  [[ -z ${!v:-} || ${!v} =~ ^[A-Za-z0-9_.,-]+$ ]] || fail "$v='${!v}'"
done
seen=" "
for id in "$@"; do
  [[ $id =~ ^court-[a-z0-9][a-z0-9-]*$ ]] || fail "id '$id'"
  [[ $seen != *" $id "* ]] || fail "$id given twice"; seen="$seen$id "
  d=$D/data/court/$id
  for f in input.mp4 job.json court-run.json source-4k.mkv; do test -s "$d/$f" || fail "missing $d/$f"; done
  K=$(grep -Eo '"K": *[0-9]+' "$d/court-run.json" | grep -Eo '[0-9]+$' || true)
  [[ $K =~ ^[0-9]+$ ]] && (( K <= 120 )) || fail "$d/court-run.json has no K (0-120)"
  for f in "masks/$(printf %06d "$K").png" "ignore/$(printf %06d "$K").png"; do test -s "$d/$f" || fail "missing $d/$f"; done
  for f in job.json court-run.json; do
    grep -Eq "\"id\": *\"$id\"" "$d/$f" || fail "$d/$f is not for $id"
  done
  for t in "${TAGS[@]}"; do
    m=$D/runs/$id${t:+/$t}/logs/submitted
    test -e "$m" && fail "$id${t:+ ($t)} was submitted before ($(cat "$m")); use a new id or TAG"
  done
done
# the jobs source env.sh, which names the 4DAnyone stack's own /blue base: this login must be able to read it
E=${ENV_SH:-$L/code/pipeline/hpg/env.sh}
SL=$(sed -n 's/^export L=//p' "$E" 2>/dev/null | sed -n 1p)
test -r "$E" && test -x "$SL/envs/4danyone/bin/python" && test -r "$SL/repos/4DAnyone/inference.py" \
  || fail "this login can't read the 4DAnyone stack ($E -> ${SL:-?}/envs/4danyone, repos/4DAnyone)"
# and its lucid package (on PYTHONPATH from there) must take every option the jobs pass
R=$SL/code/pipeline/lucid/recon.py
for f in prep_clip.py export.py recon.py; do test -r "$SL/code/pipeline/lucid/$f" || fail "no $SL/code/pipeline/lucid/$f"; done
OPTS="--source-video --source-masks --source-ignore --source-focal --face-weight --extra-sources"
[[ " ${VARIANTS:-raw:default raw:agree} " == *":agree "* ]] && OPTS="$OPTS --source-agree"
for o in $OPTS; do grep -Eq -e "[\"']$o[\"']" "$R" || fail "$R lacks $o (that stack's lucid.recon is older than the jobs)"; done
if [ -n "${COURT_DATA_L:-}" ]; then
  FREE=$(df -Pk "$D" | awk 'NR == 2 { printf "%d", $4 / 1048576 }'); WHERE="in $D"
else
  FREE=$(group_free_gb); WHERE="on /blue"
fi
(( ${FREE:-0} >= ${MIN_GB:-2} )) || fail "group quota has ${FREE:-?} GB free, need ${MIN_GB:-2} for the results"
echo "OK: $# run(s) x ${#TAGS[@]} job(s) = $(( $# * ${#TAGS[@]} )) job(s) of ${NGPU:-4} GPU(s), ${FREE} GB free $WHERE;" \
  "variants ${VARIANTS:-raw:default raw:agree}, real views ${REALS:-0 1 2}" \
  "${ACCOUNT:+; account $ACCOUNT}${QOS:+, qos $QOS}${PARTITION:+, partition $PARTITION}"
[ "${DRY:-0}" = 1 ] && { echo "DRY: nothing submitted"; exit 0; }
for id in "$@"; do
  for i in "${!TAGS[@]}"; do
    t=${TAGS[i]}; out=$D/runs/$id${t:+/$t}
    mkdir -p "$out/logs"
    cd "$out/logs"
    J=$(sbatch --parsable --gres=gpu:${NGPU:-4} ${MEM:+--mem=$MEM} ${TIME:+--time=$TIME} \
      ${CPUS:+--cpus-per-task=$CPUS} ${ACCOUNT:+--account=$ACCOUNT} ${QOS:+--qos=$QOS} ${PARTITION:+--partition=$PARTITION} \
      --export=ALL,ID=$id,TAG=$t,SEED=${SEEDV[i]} "$C/court-job.sbatch")
    echo "job=$J $(date '+%F %T')" > "$out/logs/submitted"
    echo "SUBMITTED $id${t:+ $t} job=$J (log: $out/logs/court-job-$J.log)"
  done
done
