#!/bin/bash
# Court Side gate-2 A/B on a run that has (or is making) its 4DAnyone views: one labelled freeze of frame K, written to
# ab-<kind>-<cap>k and never exported or shipped. Usage: court-ab.sh <id> views|up|agree
#   views  the freeze from views/ (the baseline for both comparisons)
#   up     SeedVR2 2x first (pipeline/hpg/stage-upscale.sbatch -> views-up/), then the freeze from views-up/
#          (it invents detail: whatever it adds is imagined, and the Reality check marks it)
#   agree  the freeze with recon --source-agree (side views cleaner, but the person moves off the real camera)
# K and FOCAL come from the run's court-run.json. Waits on the run's views job when views/ isn't finished. Env: CAP.
set -euo pipefail
ID=${1:-}; KIND=${2:-}
L=${L:-/blue/iruchkin/vishalnaveen/lucid}; H=$L/code/pipeline/hpg; C=$L/code/pipeline/court; RUN=$L/runs/$ID
fail() { echo "A/B FAIL: $*" >&2; exit 1; }
[[ $ID =~ ^court-[a-z0-9][a-z0-9-]*$ ]] || fail "id '$ID'"
read -r K FOCAL < <(python3 -c 'import json, sys; r = json.load(open(sys.argv[1])); print(r["K"], r["FOCAL"])' \
  "$RUN/court-run.json") || fail "no $RUN/court-run.json"
[[ $K =~ ^[0-9]+$ ]] && (( K <= 120 )) && [[ $FOCAL =~ ^[0-9]+([.][0-9]+)?$ ]] || fail "K=$K FOCAL=$FOCAL"
P=$(printf '%06d' "$K")
for f in source-4k.mkv "masks/$P.png" "ignore/$P.png"; do test -s "$RUN/$f" || fail "missing $RUN/$f"; done
DEP=""
if [ ! -s "$RUN/views/cameras.json" ]; then
  V=$(sed -n 's/^views=\([0-9]*\).*/\1/p' "$RUN/logs/submitted" 2>/dev/null)
  [ -n "$V" ] || fail "$RUN has no views and no views job to wait on"
  DEP="--dependency=afterok:$V"
fi
CAP=${CAP:-300000}; T=$((CAP / 1000))k
cd "$RUN/logs"
case "$KIND" in
  views) J=$(sbatch --parsable $DEP --job-name=court-ab --export=ALL,RUN=$RUN,K=$K,FOCAL=$FOCAL,CAP=$CAP,OUT=ab-views-$T,RESULT=views,EXTRA= "$C/court-freeze.sbatch") ;;
  up) U=$(sbatch --parsable $DEP --export=ALL,RUN=$RUN "$H/stage-upscale.sbatch")
      J=$(sbatch --parsable --dependency=afterok:$U --job-name=court-ab --export=ALL,RUN=$RUN,K=$K,FOCAL=$FOCAL,CAP=$CAP,OUT=ab-up-$T,RESULT=views-up,EXTRA= "$C/court-freeze.sbatch")
      J="upscale=$U freeze=$J" ;;
  agree) J=$(sbatch --parsable $DEP --job-name=court-ab --export=ALL,RUN=$RUN,K=$K,FOCAL=$FOCAL,CAP=$CAP,OUT=ab-agree-$T,RESULT=views,EXTRA=--source-agree "$C/court-freeze.sbatch") ;;
  *) fail "kind '$KIND' (views, up or agree)" ;;
esac
echo "A/B $ID $KIND -> $RUN/ab-$KIND-$T: $J"
