#!/bin/bash
# Court Side: run court-submit.sh (or SCRIPT=court-ab.sh) on this machine against a fake $L, with sbatch and blue_quota
# stubbed, to see the exact chain it would submit. Usage: court-dryrun.sh <run folder> [args after the id...]
# The folder's name is the id; it goes to $L/data/court/<id> (or INTO=runs: $L/runs/<id>, as after a submit).
# Env: FREE_T (the stub quota's free space in TB, default 0.2), plus anything the script reads (VIEWS_ONLY, CAPS).
# The stub sbatch refuses a script that doesn't exist in this checkout, so wrong paths fail here too.
set -euo pipefail
SRC=$(cd "$1" && pwd); shift
ID=$(basename "$SRC")
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
SCRIPT=${SCRIPT:-court-submit.sh}; INTO=${INTO:-data/court}
mkdir -p "$T/bin" "$T/code" "$T/$INTO"
ln -s "$(dirname "$HERE")" "$T/code/pipeline"
cp -r "$SRC" "$T/$INTO/$ID"
[ "$INTO" = runs ] && mkdir -p "$T/runs/$ID/logs"
cat > "$T/bin/sbatch" <<'SH'
#!/bin/bash
n=$(( $(wc -l < "$SBATCH_LOG") + 1001 ))
script=${!#}
[ -f "$script" ] || { echo "sbatch: no such script $script" >&2; exit 1; }
echo "$n $*" >> "$SBATCH_LOG"
echo "$n"
SH
cat > "$T/bin/blue_quota" <<SH
#!/bin/bash
cat <<EOF
Storage quotas for group 'iruchkin':
Filesystem    Use     Quota    Limit    Grace       Files
-----------  ------  -------  -------  -------  --------
blue2         $(python3 -c "print(f'{5 - ${FREE_T:-0.2}:.3f}T')")  5T       5T       -        95400576

Storage quotas for user 'vishalnaveen':
Filesystem    Use    Quota    Limit    Grace      Files
-----------  -----  -------  -------  -------  -------
blue2         4k     0k       0k       -              1
EOF
SH
chmod +x "$T/bin/sbatch" "$T/bin/blue_quota"
touch "$T/sbatch.log"
set +e
L=$T SBATCH_LOG=$T/sbatch.log PATH="$T/bin:$PATH" bash "$HERE/$SCRIPT" "$ID" "$@"
rc=$?
set -e
echo "--- exit $rc; sbatch calls:"
sed "s#$T#\$L#g" "$T/sbatch.log" 2>/dev/null || echo "(none)"
if [ -f "$T/runs/$ID/logs/submitted" ]; then
  echo "--- \$L/runs/$ID:"; (cd "$T/runs/$ID" && find . -type f | sort)
fi
exit $rc
