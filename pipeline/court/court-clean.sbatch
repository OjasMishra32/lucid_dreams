#!/bin/bash
#SBATCH --job-name=court-clean
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=1
#SBATCH --mem=1G
#SBATCH --time=00:10:00
#SBATCH --output=%x-%j.log
# Court Side: WHAT=views after every recon (keeps cameras.json, metadata.json, gvhmr/ and source-4k.mkv, so a re-run
# freeze still passes the preflight); WHAT=frames after every export. Refuses an unset RUN or a run that isn't Court Side.
set -euo pipefail
[[ $(basename "$RUN") == court-* ]] || { echo "not a court run: $RUN" >&2; exit 1; }
cd "$RUN"
case "${WHAT:?views or frames}" in
  views) rm -rf views/videos views/skeletons views/.inference ;;
  frames) rm -rf recon*/frames ;;
esac
du -sh "$RUN"
