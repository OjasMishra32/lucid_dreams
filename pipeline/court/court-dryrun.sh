#!/bin/bash
# Court Side: run court-job-submit.sh (or SCRIPT=<another login-node script>) on this machine against a fake $L, with
# sbatch and blue_quota stubbed, to see exactly what it would submit.
# Usage: court-dryrun.sh <run folder>... [more args]   (each folder's name is a run id; other args follow the ids)
# The folders go to $L/data/court/<id> (or INTO=runs: $L/runs/<id>, as after a submit).
# Env: FREE_T (the stub quota's free space in TB, default 0.2), NO_PYTHON=1 (fail on any python call), SEEDVR2=0
# (its weights absent), QUOTA_OTHER_FIRST=1 (a full group listed before ours), STACK=0 (no 4DAnyone stack where env.sh
# points; old / noagree: its lucid.recon predates --extra-sources / --source-agree), FACEFIX_STACK=1 (the facefix env
# and models under $L; built: and marked built), plus anything the
# script reads (VARIANTS, NGPU, DRY...). The stub sbatch refuses a script that doesn't exist in this checkout.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT=${SCRIPT:-court-job-submit.sh}; INTO=${INTO:-data/court}
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
DR=${COURT_DATA_L:-$T}  # where the uploads and results go
mkdir -p "$T/bin" "$T/code" "$T/$INTO" "$T/models/seedvr2" "$DR/$INTO"
[ "$DR" = "$T" ] || { mkdir -p "$DR/code/pipeline"; ln -s "$HERE" "$DR/code/pipeline/court"; }
mkdir -p "$T/code/pipeline/lucid"; ln -s "$HERE" "$T/code/pipeline/court"
[ "${SEEDVR2:-1}" = 1 ] && echo weights > "$T/models/seedvr2/seedvr2_ema_3b_fp16.safetensors"
printf 'export L=%s\n' "$T" > "$T/env.sh"  # the jobs' environment, pointing at a stand-in stack
if [ "${STACK:-1}" != 0 ]; then
  mkdir -p "$T/envs/4danyone/bin" "$T/repos/4DAnyone"
  opts="--source-video --source-masks --source-ignore --source-focal --face-weight"
  [ "${STACK:-1}" = old ] || opts="$opts --extra-sources"
  [ "${STACK:-1}" = 1 ] && opts="$opts --source-agree"
  for o in $opts; do echo "p.add_argument(\"$o\")"; done > "$T/code/pipeline/lucid/recon.py"
  touch "$T/code/pipeline/lucid/prep_clip.py" "$T/code/pipeline/lucid/export.py"
  printf '#!/bin/sh\nexit 99\n' > "$T/envs/4danyone/bin/python"; chmod +x "$T/envs/4danyone/bin/python"
  echo stub > "$T/repos/4DAnyone/inference.py"
fi
if [ "${FACEFIX_STACK:-0}" != 0 ]; then
  mkdir -p "$T/envs/facefix/bin" "$T/models/facefix"
  printf '#!/bin/sh\nexit 99\n' > "$T/envs/facefix/bin/python"; chmod +x "$T/envs/facefix/bin/python"
  for m in det_10g.onnx w600k_r50.onnx inswapper_128.onnx inswapper_emap.npy; do echo m > "$T/models/facefix/$m"; done
  [ "$FACEFIX_STACK" = built ] && touch "$T/envs/facefix/.court-facefix-ok"
fi
IDS=(); ARGS=()
for a in "$@"; do
  if [ -d "$a" ]; then
    id=$(basename "$a"); IDS+=("$id"); cp -r "$a" "$DR/$INTO/$id"
    [ "$INTO" = runs ] && mkdir -p "$DR/runs/$id/logs"
  else
    ARGS+=("$a")
  fi
done
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
[ "\${QUOTA_OTHER_FIRST:-0}" = 1 ] && printf "Storage quotas for group 'other':\nFilesystem Use Quota Limit Grace Files\nblue2 5T 5T 5T - 1\n\n"
cat <<EOF
Storage quotas for group 'iruchkin':
Filesystem    Use     Quota    Limit    Grace       Files
-----------  ------  -------  -------  -------  --------
blue2         $(python3 -c "print(f'{5 - ${FREE_T:-0.2}:.3f}T')")  5T       5T       -        95400576

EOF
[ "\${QUOTA_SLOW:-0}" = 1 ] && sleep 1
cat <<EOF
Storage quotas for user 'vishalnaveen':
Filesystem    Use    Quota    Limit    Grace      Files
-----------  -----  -------  -------  -------  -------
blue2         4k     0k       0k       -              1
EOF
SH
chmod +x "$T/bin/sbatch" "$T/bin/blue_quota"
if [ "${NO_PYTHON:-0}" = 1 ]; then  # a login node: any python call is a failure
  for py in python python3; do printf '#!/bin/sh\necho "$0 $*" >> "%s/python.log"; exit 99\n' "$T" > "$T/bin/$py"; done
  chmod +x "$T/bin/python" "$T/bin/python3"
fi
touch "$T/sbatch.log"
set +e
L=$T ENV_SH=$T/env.sh SBATCH_LOG=$T/sbatch.log PATH="$T/bin:$PATH" bash "$HERE/$SCRIPT" ${IDS[@]+"${IDS[@]}"} ${ARGS[@]+"${ARGS[@]}"}
rc=$?
set -e
if [ -s "$T/python.log" ]; then echo "PYTHON WAS CALLED: $(cat "$T/python.log")"; rc=1; fi
echo "--- exit $rc; sbatch calls:"
sed "s#$T#\$L#g" "$T/sbatch.log" 2>/dev/null || echo "(none)"
for id in ${IDS[@]+"${IDS[@]}"}; do
  if [ -f "$T/runs/$id/logs/submitted" ]; then
    echo "--- \$L/runs/$id:"; (cd "$T/runs/$id" && find . -type f | sort)
  fi
done
exit $rc
