#!/bin/bash
# Court Side: preflight, then one player's whole chain. Usage: court-submit.sh <id>
# The run's folder (player_clip.py's runs/<id>/) is rsynced from the Mac to $L/data/court/<id>/ first. K and FOCAL come
# from its court-run.json, never from the command line. Nothing is submitted if a file is missing, a number is off,
# the run was submitted before, or the group quota is short.
# Env: VIEWS_ONLY=1 (4DAnyone views only: the Turbo checks), CAPS ("300000 250000 200000"), MIN_GB (20), ITERS, FACE.
set -euo pipefail
ID=${1:-}
L=${L:-/blue/iruchkin/vishalnaveen/lucid}; H=$L/code/pipeline/hpg; C=$L/code/pipeline/court
DATA=$L/data/court/$ID; RUN=$L/runs/$ID
fail() { echo "PREFLIGHT FAIL: $*" >&2; exit 1; }
[[ $ID =~ ^court-[a-z0-9][a-z0-9-]*$ ]] || fail "id '$ID'"
(( $# == 1 )) || fail "only the id is taken (K and FOCAL come from court-run.json)"
# the shipped chain trains on the real views with the real camera held: A/B settings belong in court-ab.sh
[ -z "${EXTRA:-}${RESULT:-}" ] || fail "EXTRA/RESULT are set ('${EXTRA:-}' '${RESULT:-}'): A/B runs go through court-ab.sh"
for f in input.mp4 job.json court-run.json; do test -s "$DATA/$f" || fail "missing $DATA/$f"; done
# K FOCAL, or a reason the two files disagree with each other or the id
read -r K FOCAL < <(python3 - "$DATA" "$ID" <<'PY'
import json, sys
d, rid = sys.argv[1], sys.argv[2]
r, j = json.load(open(f"{d}/court-run.json")), json.load(open(f"{d}/job.json"))
k, f = r.get("K"), r.get("FOCAL")
bad = [m for m, ok in [(f"court-run id {r.get('id')}", r.get("id") == rid), (f"job id {j.get('id')}", j.get("id") == rid),
                       (f"frames {j.get('frames')}", j.get("frames") == 121), (f"K {k}", isinstance(k, int) and 0 <= k <= 120),
                       (f"FOCAL {f}", isinstance(f, (int, float)) and f > 0),
                       (f"sourceFocal {j.get('sourceFocal')} vs FOCAL {f}", j.get("sourceFocal") == f)] if not ok]
print("BAD", "; ".join(bad)) if bad else print(k, f)
PY
) || fail "cannot read $DATA/court-run.json and job.json"
[ "$K" = BAD ] && fail "$FOCAL"
[[ $K =~ ^[0-9]+$ ]] && (( K <= 120 )) || fail "K=$K"
[[ $FOCAL =~ ^[0-9]+([.][0-9]+)?$ ]] || fail "FOCAL=$FOCAL"
if [ "${VIEWS_ONLY:-0}" != 1 ]; then
  P=$(printf '%06d' "$K")
  for f in source-4k.mkv "masks/$P.png" "ignore/$P.png"; do test -s "$DATA/$f" || fail "missing $DATA/$f"; done
fi
test -e "$RUN/logs/submitted" && fail "$ID was submitted before ($(cat "$RUN/logs/submitted")); use a new id"
# the group's free space: Limit - Use on the group's blue line (units k/m/g/t, with or without a trailing b)
FREE=$(blue_quota | awk 'function b(s, u) { sub(/[bB]$/, "", s); u = tolower(substr(s, length(s)))
    return (s + 0) * (u == "k" ? 2^10 : u == "m" ? 2^20 : u == "g" ? 2^30 : u == "t" ? 2^40 : 1) }
  /^Storage quotas for group/ { g = 1; next } /^Storage quotas for user/ { g = 0 }
  g && $1 ~ /^blue/ { printf "%d", (b($4) - b($2)) / 2^30; exit }')
(( ${FREE:-0} >= ${MIN_GB:-20} )) || fail "group quota has ${FREE:-?} GB free, need ${MIN_GB:-20}"
mkdir -p "$RUN/logs"
cp -r "$DATA"/. "$RUN"/
cd "$RUN/logs"
V=$(sbatch --parsable --export=ALL,RUN=$RUN "$H/stage-views.sbatch")
if [ "${VIEWS_ONLY:-0}" = 1 ]; then
  echo "views=$V" > "$RUN/logs/submitted"
  echo "SUBMITTED $ID views=$V"; exit 0
fi
CAPS=${CAPS:-"300000 250000 200000"}; R=""; E=""
for CAP in $CAPS; do
  T=$((CAP / 1000))k
  r=$(sbatch --parsable --dependency=afterok:$V --export=ALL,RUN=$RUN,K=$K,FOCAL=$FOCAL,CAP=$CAP,OUT=recon-$T,RESULT=views,EXTRA= "$C/court-freeze.sbatch")
  E="$E:$(sbatch --parsable --dependency=afterok:$r --export=ALL,RUN=$RUN,RECON=recon-$T,OUT=bundle-$T "$C/court-export.sbatch")"
  R="$R:$r"
done
M=$(sbatch --parsable --dependency=afterok:$V --job-name=court-metrics \
  --export=ALL,RUN=$RUN,K=$K,FOCAL=$FOCAL,CAP=${CAPS%% *},OUT=recon-metrics,HOLDOUT=8,RESULT=views,EXTRA= "$C/court-freeze.sbatch")
CV=$(sbatch --parsable --dependency=afterok$R:$M --export=ALL,RUN=$RUN,WHAT=views "$C/court-clean.sbatch")
CF=$(sbatch --parsable --dependency=afterok$E:$M --export=ALL,RUN=$RUN,WHAT=frames "$C/court-clean.sbatch")
echo "views=$V recons=$R metrics=$M exports=$E clean=$CV,$CF" > "$RUN/logs/submitted"
echo "SUBMITTED $ID K=$K FOCAL=$FOCAL views=$V recons=$R metrics=$M exports=$E clean=$CV,$CF"
