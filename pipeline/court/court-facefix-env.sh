#!/bin/bash
# Court Side: builds court-job's FACEFIX env once (court-facefix-env.sbatch: a CPU job, ~0.8 GB of models on Blue).
# Login node: bash and awk only, no python. Deletes nothing. Usage: court-facefix-env.sh
# Env: L (the /blue base holding code/, envs/4danyone, models/, jobs/); ACCOUNT, QOS (e.g. a burst QOS: no GPU needed)
# and PARTITION override the job's #SBATCH lines; QUOTA_GROUP picks whose /blue space is checked; DRY=1 checks only.
set -euo pipefail
L=${L:-/blue/iruchkin/vishalnaveen/lucid}; C=$L/code/pipeline/court
source "$(dirname "$0")/court-lib.sh"
(( $# == 0 )) || fail "no arguments (env: L, ACCOUNT, QOS, PARTITION)"
for v in ACCOUNT QOS PARTITION; do
  [[ -z ${!v:-} || ${!v} =~ ^[A-Za-z0-9_.,-]+$ ]] || fail "$v='${!v}'"
done
test -e "$L/envs/facefix/.court-facefix-ok" && fail "the facefix env is already built ($L/envs/facefix/.court-facefix-ok)"
test -x "$L/envs/4danyone/bin/python" || fail "no $L/envs/4danyone (the facefix venv is layered on it)"
for f in court-facefix-env.sbatch court_facefix.py; do test -r "$C/$f" || fail "no $C/$f (upload the court scripts)"; done
FREE=$(group_free_gb)
(( ${FREE:-0} >= ${MIN_GB:-2} )) || fail "group quota has ${FREE:-?} GB free, need ${MIN_GB:-2}"
SB=(${ACCOUNT:+--account=$ACCOUNT} ${QOS:+--qos=$QOS} ${PARTITION:+--partition=$PARTITION})
echo "OK: facefix env into $L/envs/facefix and $L/models/facefix; $FREE GB free${SB[*]+; ${SB[*]}}"
[ "${DRY:-0}" = 1 ] && { echo "DRY: nothing submitted"; exit 0; }
mkdir -p "$L/jobs"
cd "$L/jobs"
J=$(sbatch --parsable ${SB[@]+"${SB[@]}"} --output="$L/jobs/%x-%j.log" --export=ALL,L=$L "$C/court-facefix-env.sbatch")
echo "SUBMITTED court-facefix-env job=$J (log: $L/jobs/court-facefix-env-$J.log, ends with SETUP_OK)"
