#!/bin/bash
# Court Side freeze grid on HiPerGator (court-grid.sh runs it from the Mac). For each run id already uploaded to
# $L/data/court/<id>/: its 4DAnyone views (Turbo or 24 steps, from its job.json), then per variant one freeze of frame K
# at CAP, one metrics recon (every 8th view held out) and one export, all queued at once; the runs start in waves sized
# to the group's free space, and each run's views go as soon as its recons end (whatever their outcome).
# Usage: court-grid-hpg.sh <id>...      (priority order: when space is short the first ids go first)
# Variants (VARIANTS, default "raw up"): raw = the views as made; up = SeedVR2 2x first (stage-upscale.sbatch; whatever
# it adds is imagined). The real view is A's frame K alone: recon takes one --source-video today. Never --source-agree.
# A full-quality run keeps views/ (KEEP_FULL_VIEWS=1) for the winner's 250k/200k caps (court-winner.sh); views-up/
# always goes. Env: VARIANTS, CAP (300000), KEEP_FULL_VIEWS (1), MIN_GB (20), DRY (1: print the plan only),
# per-run disk guesses RAW_GB (3), UP_GB (8), OUT_GB (1), SEED_GB (8: SeedVR2's weights if absent).
set -euo pipefail
L=${L:-/blue/iruchkin/vishalnaveen/lucid}; H=$L/code/pipeline/hpg; C=$L/code/pipeline/court
source "$(dirname "$0")/court-lib.sh"
(( $# >= 1 )) || fail "no run ids"
[ -z "${EXTRA:-}${RESULT:-}" ] || fail "EXTRA/RESULT are set: the grid's variants are fixed (A/B extras: court-ab.sh)"
VARIANTS=${VARIANTS:-"raw up"}; CAP=${CAP:-300000}; T=$((CAP / 1000))k; KEEP=${KEEP_FULL_VIEWS:-1}
RAW_GB=${RAW_GB:-3}; UP_GB=${UP_GB:-8}; OUT_GB=${OUT_GB:-1}; SEED_GB=${SEED_GB:-8}; MIN_GB=${MIN_GB:-20}
UP=0
for v in $VARIANTS; do
  case $v in raw) ;; up) UP=1 ;; *) fail "variant '$v' (raw or up)" ;; esac
done
IDS=("$@"); KS=(); FS=(); TS=()
for id in "${IDS[@]}"; do preflight "$id" 0; KS+=("$K"); FS+=("$FOCAL"); TS+=("$TURBO"); done
# disk: kept views of full-quality runs + one wave of runs in flight + SeedVR2's weights if they must be fetched
SEED=0
if (( UP )) && [ ! -s "$L/models/seedvr2/seedvr2_ema_3b_fp16.safetensors" ]; then SEED=1; fi
KEPT=0
for t in "${TS[@]}"; do if (( KEEP && ! t )); then KEPT=$((KEPT + RAW_GB)); fi; done
PER=$((RAW_GB + UP * UP_GB + OUT_GB))
FREE=$(group_free_gb)
AVAIL=$(( ${FREE:-0} - MIN_GB - SEED * SEED_GB - KEPT ))
(( AVAIL >= PER )) || fail "group quota has ${FREE:-?} GB free: ${MIN_GB} reserve + $((SEED * SEED_GB)) SeedVR2 + $KEPT kept views + $PER per run in flight doesn't fit (try VARIANTS=raw, KEEP_FULL_VIEWS=0 or fewer ids)"
N=$#; W=$(( AVAIL / PER )); if (( W > N )); then W=$N; fi
# GPU-hours on a B200, rough: views 0.25 (Turbo) / 1.0 (24 steps), SeedVR2 1.6 (8 x ~12 min), freeze or metrics 0.6, export 0.1
GPUH=$(python3 - "$UP" "$(echo $VARIANTS | wc -w)" "${TS[@]}" <<'PY'
import sys
up, nv, turbo = int(sys.argv[1]), int(sys.argv[2]), [int(t) for t in sys.argv[3:]]
print(round(sum((0.25 if t else 1.0) + up * 1.6 + nv * (0.6 + 0.6 + 0.1) for t in turbo), 1))
PY
)
echo "GRID $N runs x {$VARIANTS} at ${T}: ~${GPUH} GPU-h; ${FREE} GB free -> $W run(s) in flight at once," \
  "peak ~$((SEED * SEED_GB + KEPT + W * PER)) GB (+${MIN_GB} reserve)"
for i in "${!IDS[@]}"; do
  echo "  ${IDS[i]} K=${KS[i]} FOCAL=${FS[i]} $(if (( TS[i] )); then echo Turbo; else echo 24-step; fi)"
done
[ "${DRY:-0}" = 1 ] && { echo "DRY: nothing submitted"; exit 0; }
DEPS="--kill-on-invalid-dep=yes"  # a job whose afterok can never hold is cancelled, so afterany waits never hang
S=""
if (( SEED )); then S=$(sbatch --parsable "$H/setup-seedvr2.sbatch"); fi
GATE=()
for i in "${!IDS[@]}"; do
  id=${IDS[i]}; RUN=$L/runs/$id; K=${KS[i]}; FOCAL=${FS[i]}
  mkdir -p "$RUN/logs"
  cp -r "$L/data/court/$id"/. "$RUN"/
  cd "$RUN/logs"
  dep=""
  if (( i >= W )); then dep="--dependency=afterany:${GATE[i - W]}"; fi
  V=$(sbatch --parsable $DEPS $dep --export=ALL,RUN=$RUN "$H/stage-views.sbatch")
  R=""; E=""; LINE="views=$V"
  for v in $VARIANTS; do
    if [ "$v" = up ]; then
      U=$(sbatch --parsable $DEPS --dependency=afterok:$V${S:+:$S} --export=ALL,RUN=$RUN "$H/stage-upscale.sbatch")
      after=$U; res=views-up; R="$R:$U"; LINE="$LINE upscale=$U"
    else
      after=$V; res=views
    fi
    f=$(sbatch --parsable $DEPS --dependency=afterok:$after \
      --export=ALL,RUN=$RUN,K=$K,FOCAL=$FOCAL,CAP=$CAP,OUT=recon-$v-$T,RESULT=$res,EXTRA= "$C/court-freeze.sbatch")
    m=$(sbatch --parsable $DEPS --dependency=afterok:$after --job-name=court-metrics \
      --export=ALL,RUN=$RUN,K=$K,FOCAL=$FOCAL,CAP=$CAP,OUT=recon-metrics-$v,HOLDOUT=8,RESULT=$res,EXTRA= "$C/court-freeze.sbatch")
    e=$(sbatch --parsable $DEPS --dependency=afterok:$f \
      --export=ALL,RUN=$RUN,RECON=recon-$v-$T,OUT=bundle-$v-$T "$C/court-export.sbatch")
    R="$R:$f:$m"; E="$E:$e"; LINE="$LINE $v=$f metrics-$v=$m export-$v=$e"
  done
  what=views
  if (( KEEP && ! TS[i] )); then what=views-up; fi
  cv=$(sbatch --parsable $DEPS --dependency=afterany:$V$R --export=ALL,RUN=$RUN,WHAT=$what "$C/court-clean.sbatch")
  cf=$(sbatch --parsable $DEPS --dependency=afterany$R$E --export=ALL,RUN=$RUN,WHAT=frames "$C/court-clean.sbatch")
  GATE[i]=$cv
  LINE="$LINE clean-$what=$cv clean-frames=$cf"
  echo "$LINE" > "$RUN/logs/submitted"
  echo "SUBMITTED $id K=$K FOCAL=$FOCAL $LINE${dep:+ (waits on ${dep#*:})}"
done
echo "Metrics as they land: python3 $C/court_grid_report.py $L/runs/court-*"
