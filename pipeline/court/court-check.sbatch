#!/bin/bash
#SBATCH --job-name=court-check
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin-b
#SBATCH --cpus-per-task=2
#SBATCH --mem=16G
#SBATCH --time=00:30:00
#SBATCH --output=%x-%j.log
# Court Side: the pick's checks where the runs are, so only a sheet and small files come back. For run ID's seed
# folders ($D/runs/$ID/$GLOB, default seed*): P42 (court_p42.py), the stance in court space (court_stance.py; REF = the
# measured stance,along,across from the private notes), the gate-2 sheet with its orbit row (court_gate2_sheet.py) and
# the pick report (court_grid_report.py --pick --depth-view ${DEPTH_VIEW:-stance}). Submitted by court-check-submit.sh.
# The run folders are only read: the tools work in a tree of links on $TMPDIR (their p42.json / stance.json are written
# there, never through a link), and everything lands in a new $D/checks/$ID-<job id>/. Nothing is deleted.
set -euo pipefail
L=${L:-/blue/iruchkin/vishalnaveen/lucid}; D=${COURT_DATA_L:-$L}; C=$D/code/pipeline/court
: "${ID:?ID=<run id>}"
source "${ENV_SH:-$L/code/pipeline/hpg/env.sh}"
command -v ffmpeg > /dev/null || module load ffmpeg > /dev/null 2>&1 || true
command -v ffmpeg > /dev/null || echo "court-check: no ffmpeg: the sheet's video tiles will be grey" >&2
PY=${PY:-python}
RUNS=$D/runs/$ID; JOB=${SLURM_JOB_ID:-$$}
T=${TMPDIR:-/tmp}/court-check-$ID-$JOB; OUT=$D/checks/$ID-$JOB
[ -d "$RUNS" ] || { echo "court-check: no $RUNS" >&2; exit 1; }
[ ! -e "$OUT" ] || { echo "court-check: $OUT exists" >&2; exit 1; }
mkdir -p "$T/$ID" "$OUT"
n=0
for run in "$RUNS"/${GLOB:-seed*}/; do
  [ -d "$run" ] || continue
  s=$T/$ID/$(basename "$run"); mkdir -p "$s"; n=$((n + 1))
  for e in "$run"*; do
    if [[ -d $e && $(basename "$e") == recon-* ]]; then
      mkdir -p "$s/$(basename "$e")"
      for f in "$e"/*; do
        case $(basename "$f") in p42.json|stance.json) ;; *) ln -s "$f" "$s/$(basename "$e")/" ;; esac
      done
    else
      ln -s "$e" "$s/"
    fi
  done
done
(( n )) || { echo "court-check: no ${GLOB:-seed*} folders in $RUNS" >&2; exit 1; }
echo "court-check $ID: $n folder(s) -> $OUT"
cd "$T"
set +e
$PY "$C/court_p42.py" --clips "$D/data/court" "$T/$ID"/*/ > "$OUT/p42.txt" 2>&1
$PY "$C/court_stance.py" --clips "$D/data/court" ${REF:+--ref "$REF"} "$T/$ID"/*/ > "$OUT/stance.txt" 2>&1
$PY "$C/court_gate2_sheet.py" --out "$OUT/gate-$ID.jpg" --clips "$D/data/court" "$T/$ID"/*/ > "$OUT/sheet.txt" 2>&1
$PY "$C/court_grid_report.py" --pick --depth-view "${DEPTH_VIEW:-stance}" "$T/$ID"/*/ > "$OUT/report.txt" 2>&1
set -e
find "$ID" \( -name p42.json -o -name stance.json \) -type f | tar -cf "$OUT/checks.tar" -T -
cat "$OUT/p42.txt" "$OUT/stance.txt" "$OUT/report.txt"
ls -l "$OUT"
