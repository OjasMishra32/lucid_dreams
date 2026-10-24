#!/bin/bash
# Court Side: submit court-check.sbatch per run id (login node: bash only, no python). Usage:
#   [REF=stance,along,across] court-check-submit.sh <id>...
# One CPU job per id: P42, stance, the gate-2 sheet and the pick report on $D/runs/<id>/seed*, results in
# $D/checks/<id>-<job id>/ (fetch that folder: a jpg, text and a small tar). REF is the measured stance from the private
# notes (one player per call). Env passed to the jobs: L, COURT_DATA_L, ENV_SH, GLOB (the folders, default seed*),
# DEPTH_VIEW (default stance), SWEEP (qa-sweep's output root: its face gate and floater tiebreak); ACCOUNT, QOS,
# PARTITION override the job script's #SBATCH lines; DRY=1 prints.
set -euo pipefail
L=${L:-/blue/iruchkin/vishalnaveen/lucid}; D=${COURT_DATA_L:-$L}; C=$D/code/pipeline/court
fail() { echo "court-check-submit: $*" >&2; exit 1; }
(( $# )) || fail "no run ids"
[[ -z ${REF:-} || $REF =~ ^[0-9.]+,[0-9.]+,[0-9.]+$ ]] || fail "REF=$REF (stance,along,across in metres)"
[[ -z ${GLOB:-} || $GLOB =~ ^[A-Za-z0-9*?._-]+$ ]] || fail "GLOB=$GLOB"
[[ -z ${SWEEP:-} || -d $SWEEP ]] || fail "SWEEP=$SWEEP is not a folder"
for v in ACCOUNT QOS PARTITION DEPTH_VIEW; do
  [[ -z ${!v:-} || ${!v} =~ ^[A-Za-z0-9._,-]+$ ]] || fail "$v=${!v}"
done
test -r "$C/court-check.sbatch" || fail "no $C/court-check.sbatch"
for id in "$@"; do
  [[ $id =~ ^court-[a-z0-9-]+$ ]] || fail "bad run id $id"
  [ -d "$D/runs/$id" ] || fail "no $D/runs/$id"
done
export L COURT_DATA_L ENV_SH GLOB DEPTH_VIEW REF SWEEP
for id in "$@"; do
  cmd=(sbatch --parsable ${ACCOUNT:+--account=$ACCOUNT} ${QOS:+--qos=$QOS} ${PARTITION:+--partition=$PARTITION}
       --chdir="$D/checks" --export=ALL,ID=$id "$C/court-check.sbatch")
  if [ "${DRY:-0}" = 1 ]; then echo "DRY: ${cmd[*]}"; continue; fi
  mkdir -p "$D/checks"
  J=$("${cmd[@]}")
  echo "SUBMITTED court-check $id job=$J (results: $D/checks/$id-$J/, log: $D/checks/court-check-$J.log)"
done
