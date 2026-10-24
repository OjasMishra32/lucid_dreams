#!/bin/bash
# Court Side: delete one Turbo check's run folder once its views have been fetched and looked at.
# Usage: court-turbo-clean.sh <court-turbo-... id>. The path is built here from the id alone, never from $RUN.
# The uploaded inputs in $L/data/court/<id>/ stay.
set -euo pipefail
ID=${1:-}
L=${L:-/blue/iruchkin/vishalnaveen/lucid}
[[ $ID =~ ^court-turbo-[a-z0-9][a-z0-9-]*$ ]] || { echo "court-turbo-clean: '$ID' is not a court-turbo-* id" >&2; exit 1; }
DIR="$L/runs/$ID"
[ -d "$DIR" ] || { echo "court-turbo-clean: no $DIR" >&2; exit 1; }
du -sh "$DIR"
rm -rf -- "$DIR"
echo "removed $DIR"
