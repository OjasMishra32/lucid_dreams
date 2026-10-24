#!/bin/bash
#SBATCH --job-name=court-job
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-b200,hpg-rtx6000
#SBATCH --nodes=1
#SBATCH --gres=gpu:4
#SBATCH --cpus-per-task=12
#SBATCH --mem=200G
#SBATCH --time=08:00:00
#SBATCH --output=%x-%j.log
# Court Side: one run's whole freeze grid on one node, entirely in node-local scratch (Slurm wipes it at the end).
# Stages $L/data/court/$ID/ in, makes the 4DAnyone views (Turbo or 24 steps, from job.json; on all the job's GPUs, as
# RC kills a job whose allocated GPU idles for an hour), SeedVR2 2x views if a
# variant asks for them, then every freeze of frame K (one per variant and cap), a held-out metrics recon per variant
# and an export per freeze, spread over the node's GPUs; copies only results back to $L/runs/$ID/ (the gate-2 view
# samples as soon as the views exist). Writes nothing else on /blue and deletes nothing outside its own scratch.
# K and FOCAL are read from $L/data/court/$ID/court-run.json just before each recon (with that upload's real frame,
# masks and ignore, read in place), so a corrected FOCAL uploaded while the views run is used; each recon logs and
# records the K and FOCAL it trained with. If SeedVR2 fails, the up variants are dropped and the exit code says so.
# Env: ID; VARIANTS ("raw:default raw:agree"; views raw|up x mode default|agree, where up = SeedVR2 2x views and
# agree = recon --source-agree, solid from every side but a few cm off the real camera); REALS ("0 1 2": how many of
# the run's other real views (real/extras.json, in order, with their weights) train beside A's frame); CAPS (300000);
# METRICS (1: per variant a recon holding out every 8th view and every unused real view, weight 0); ITERS (15000);
# FACE (2.0); TAG (results in $L/runs/$ID/$TAG); SEED (4DAnyone's seed; SEED_FLAG, default --seed); MIN_SCRATCH_GB
# (200); KEEP_MB (900: past that the recon PLYs stay behind); VIEWS_FROM (a folder holding a whole earlier set of views,
# videos/NN.mp4 + cameras.json, e.g. a gated seed's saved from its scratch: used instead of making new ones, with the
# prepped.mp4 beside it). COURT_DATA_L: where data/court/, runs/ and these scripts
# live when not beside the stack at $L (e.g. /home while /blue is full); the stack is then only read.
# FACEFIX (opt-in): a dir of the player's real face crops; right after the views, court_facefix.py gives every view's
# face that identity (pose, light and expression kept; profiles and the back of the head untouched), before SeedVR2 and
# every recon; the fixed ring samples come back in views-facefix/ beside the originals in views/. FACEFIX_PY and
# FACEFIX_MODELS: its env's python and models ($D/envs/facefix/bin/python, $D/models/facefix, D = COURT_DATA_L or L:
# court-facefix-env.sbatch). With VIEWS_FROM the copied views are fixed (in scratch; the saved ones are only read).
# Checked before the views; if the swap fails the job stops (the same job without FACEFIX is the plain run).
# FACEFIX_WAIT=<minutes>: the env may still be building (submitted beside this job): then it is checked after the
# views, once its built marker appears (waiting up to that long; the GPUs idle meanwhile, so keep it under an hour).
set -euo pipefail
L=${L:-/blue/iruchkin/vishalnaveen/lucid}  # the stack (env.sh, repos, envs): only read
D=${COURT_DATA_L:-$L}; C=$D/code/pipeline/court  # these court scripts, the uploads and the results: COURT_DATA_L moves them
: "${ID:?ID}"
[[ $ID =~ ^court-[a-z0-9][a-z0-9-]*$ ]] || { echo "court-job: bad id '$ID'" >&2; exit 1; }
DATA=$D/data/court/$ID; OUTD=$D/runs/$ID${TAG:+/$TAG}
VARIANTS=${VARIANTS:-"raw:default raw:agree"}; REALS=${REALS:-"0 1 2"}; CAPS=${CAPS:-300000}; METRICS=${METRICS:-1}
[[ -z ${TAG:-} || $TAG =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "court-job: bad tag '$TAG'" >&2; exit 1; }
SEED_FLAG=${SEED_FLAG:---seed}  # 4DAnyone inference.py's own seed option (default 42 when not given)
[[ -z ${SEED:-} || $SEED =~ ^[0-9]+$ ]] || { echo "court-job: SEED must be a whole number" >&2; exit 1; }
S=${TMPDIR:-/tmp}/court-$ID${TAG:+-$TAG}-${SLURM_JOB_ID:-$$}
log() { echo "[court-job $(date +%T)] $*"; }
for v in $VARIANTS; do
  [[ $v =~ ^(raw|up):(default|agree)$ ]] || { echo "court-job: variant '$v' (raw|up):(default|agree)" >&2; exit 1; }
done
seen=" "
for cap in $CAPS; do
  [[ $cap =~ ^[1-9][0-9]{3,}$ && $seen != *" $((cap / 1000)) "* ]] || { echo "court-job: cap '$cap' (whole numbers, distinct in thousands)" >&2; exit 1; }
  seen="$seen$((cap / 1000)) "
done
mkdir -p "$S"
trap 'cd /; rm -rf "$S"' EXIT  # our own scratch only

# --- the node --------------------------------------------------------------------------------------------------------
log "$ID on $(hostname), job ${SLURM_JOB_ID:-local}; GPUs:"
nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader | sed 's/^/  /'
NG=$(nvidia-smi -L | grep -c '^GPU' || true)
(( NG >= 1 )) || { log "no GPU"; exit 1; }
GPUNAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | sed -n 1p)
FREE_S=$(df -Pk "$S" | awk 'NR == 2 { printf "%d", $4 / 1048576 }')
(( FREE_S >= ${MIN_SCRATCH_GB:-200} )) || { log "scratch $S has $FREE_S GB free, need ${MIN_SCRATCH_GB:-200}"; exit 1; }
log "scratch $S: $FREE_S GB free"
CPUS=${SLURM_CPUS_PER_TASK:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 12)}
RT=$(( CPUS / NG > 0 ? CPUS / NG : 1 ))  # the recons run one per GPU at once
log "threads: $CPUS for the views, $RT per recon on $NG GPUs"
export NCCL_IB_DISABLE=1  # multi-GPU views: NCCL over some nodes' RoCE bonds fails ("Remote IB device is incompatible")
source "${ENV_SH:-$L/code/pipeline/hpg/env.sh}"  # 4DAnyone and recon keep reading their model caches from there
PY=${PY:-python}

# --- inputs ----------------------------------------------------------------------------------------------------------
mkdir -p "$S/run"
cp -r "$DATA"/. "$S/run"/
cd "$S/run"
# K FOCAL TURBO VPL PITCHES from the uploaded run record, fresh each call
runinfo() {
  $PY - "$DATA" "$ID" <<'PY'
import json, sys
d, rid = sys.argv[1], sys.argv[2]
r, j = json.load(open(f"{d}/court-run.json")), json.load(open(f"{d}/job.json"))
k, f = r.get("K"), r.get("FOCAL")
ok = (r.get("id") == rid == j.get("id") and j.get("frames") == 121 and isinstance(k, int) and 0 <= k <= 120
      and isinstance(f, (int, float)) and f > 0)
if not ok:
    sys.exit(f"court-run.json/job.json disagree or are off: id {r.get('id')}/{j.get('id')} K {k} FOCAL {f}")
print(k, f, int(bool(j.get("turbo"))), j.get("viewsPerLayer", 16), json.dumps(j.get("layerPitches", [-10, 15, 35])).replace(" ", ""))
PY
}
read -r K FOCAL TURBO VPL PITCHES < <(runinfo) || { log "bad run record"; exit 1; }
P=$(printf '%06d' "$K")
for f in input.mp4 source-4k.mkv "masks/$P.png" "ignore/$P.png"; do test -s "$f" || { log "missing $f"; exit 1; }; done
NX=0; [ -s "$DATA/real/extras.json" ] && NX=$(grep -c '"name"' "$DATA/real/extras.json" || true)
REALS=$(for r in $REALS; do if [[ $r =~ ^[0-9]$ ]] && (( r <= NX )); then echo "$r"; else echo "REALS $r: only $NX other real view(s)" >&2; fi; done | xargs)
log "K=$K FOCAL=$FOCAL $( ((TURBO)) && echo Turbo || echo 24-step) views${SEED:+, seed $SEED}; variants: $VARIANTS;" \
  "real views: A + {${REALS// /,}} of $NX; caps: $CAPS; results -> $OUTD"
ff_check() {  # the env and models are there, every crop has a face, and the models load and run (CPU, seconds)
  test -x "$FF_PY" || { log "FACEFIX: no $FF_PY (court-facefix-env.sh)"; return 1; }
  local m
  for m in det_10g.onnx w600k_r50.onnx inswapper_128.onnx inswapper_emap.npy; do
    test -s "$FF_MODELS/$m" || { log "FACEFIX: no $FF_MODELS/$m"; return 1; }
  done
  OMP_NUM_THREADS=$CPUS "$FF_PY" "$C/court_facefix.py" refs --cpu --ref "$FACEFIX" --models "$FF_MODELS" \
    || { log "FACEFIX: the face crops or models in $FACEFIX / $FF_MODELS don't work"; return 1; }
}
FF_LATER=0
if [ -n "${FACEFIX:-}" ]; then  # checked now, not after the views
  FF_PY=${FACEFIX_PY:-$D/envs/facefix/bin/python}; FF_MODELS=${FACEFIX_MODELS:-$D/models/facefix}
  FF_BUILT=$(dirname "$(dirname "$FF_PY")")/.court-facefix-ok  # court-facefix-env.sbatch's last step
  compgen -G "$FACEFIX/*.jpg" > /dev/null || compgen -G "$FACEFIX/*.png" > /dev/null \
    || { log "FACEFIX: no .jpg/.png face crops in $FACEFIX"; exit 1; }
  if [[ ${FACEFIX_WAIT:-0} =~ ^[1-9][0-9]*$ ]] && ! test -e "$FF_BUILT"; then
    FF_LATER=1  # the env is still being built beside this job: wait for it after the views, not now
    log "FACEFIX: the env isn't built yet; after the views this waits up to $FACEFIX_WAIT min for $FF_BUILT"
  else
    ff_check || exit 1
  fi
  log "FACEFIX: the face in $FACEFIX goes onto the views before anything trains on them"
fi
UP=0; [[ " $VARIANTS " == *" up:"* ]] && UP=1
if (( UP )); then  # SeedVR2's weights into scratch while the views are made
  ( export HF_HOME=$S/hf HF_HUB_DISABLE_XET=1 && source "$L/envs/seedvr2/bin/activate" \
      && $PY "$C/court_fetch_seedvr2.py" "$S/seedvr2" ) > "$S/fetch.log" 2>&1 &
  FETCH=$!
fi

# --- views -----------------------------------------------------------------------------------------------------------
copy_back() {  # copy_back <path relative to the run>... : results only, into $OUTD
  local p
  for p in "$@"; do
    [ -e "$S/run/$p" ] || continue
    mkdir -p "$OUTD/$(dirname "$p")"
    cp -r "$S/run/$p" "$OUTD/$(dirname "$p")/"
  done
}
if [ -n "${VIEWS_FROM:-}" ]; then  # a gated seed's own views (saved from its scratch while it ran): no 4DAnyone run
  NV=$(( VPL * ($(tr -cd , <<< "$PITCHES" | wc -c) + 1) ))
  nv=$(find "$VIEWS_FROM/videos" -maxdepth 1 -name '[0-9][0-9].mp4' 2>/dev/null | wc -l)
  (( nv == NV )) && test -s "$VIEWS_FROM/cameras.json" || { log "VIEWS_FROM $VIEWS_FROM: $nv views, need $NV + cameras.json"; exit 1; }
  log "prep + the views of $VIEWS_FROM ($nv, no 4DAnyone run)"
  if [ -s "$VIEWS_FROM/../prepped.mp4" ] && [ -s "$VIEWS_FROM/../prep.json" ]; then  # the clip those views were made from
    cp "$VIEWS_FROM/../prepped.mp4" "$VIEWS_FROM/../prep.json" .
  else
    $PY -m lucid.prep_clip input.mp4 --out prepped.mp4 --start-s 0 > prep.json
  fi
  cp -r "$VIEWS_FROM" "$S/run/views"
else
log "prep + 4DAnyone views"  # on every GPU the job holds (inference.py's gpu_ids: all visible); RC kills idle ones
$PY -m lucid.prep_clip input.mp4 --out prepped.mp4 --start-s 0 > prep.json
( cd "$L/repos/4DAnyone" && export OMP_NUM_THREADS=$CPUS MKL_NUM_THREADS=$CPUS && $PY inference.py --video_path "$S/run/prepped.mp4" \
    --output_dir "$S/run/views" --views_per_layer "$VPL" --layer_pitches "$PITCHES" \
    $( ((TURBO)) || echo --enable_turbo=False ) ${SEED:+$SEED_FLAG $SEED} )
fi
SAMPLES=(views/videos/{00,02,04,06,08,10,12,14}.mp4)  # the first ring every 45 degrees, its back included (~12 MB)
copy_back prep.json prepped.mp4 views/cameras.json views/metadata.json views/gvhmr "${SAMPLES[@]}"
log "views done; gate-2 samples in $OUTD/views"

# --- FACEFIX (opt-in): the player's real face on every view, one share of the views per GPU ---------------------------
if [ -n "${FACEFIX:-}" ]; then
  if (( FF_LATER )); then
    end=$(( SECONDS + FACEFIX_WAIT * 60 ))
    until test -e "$FF_BUILT" || (( SECONDS >= end )); do sleep "${FACEFIX_POLL_S:-30}"; done
    test -e "$FF_BUILT" || { log "FACEFIX: no env after $FACEFIX_WAIT min ($FF_BUILT): stopping"; exit 1; }
    ff_check || exit 1
  fi
  log "FACEFIX on $NG GPU(s)"
  ALL=($(ls views/videos/*.mp4 | sort)); pids=()
  mkdir -p views-facefix/videos
  for ((g = 0; g < NG; g++)); do
    mine=(); for ((i = g; i < ${#ALL[@]}; i += NG)); do mine+=("${ALL[i]}"); done
    (( ${#mine[@]} )) || continue
    OMP_NUM_THREADS=$RT CUDA_VISIBLE_DEVICES=$g "$FF_PY" "$C/court_facefix.py" fix --ref "$FACEFIX" --models "$FF_MODELS" \
      --out views-facefix/videos --report "views-facefix/report-$g.json" "${mine[@]}" > "views-facefix/facefix-$g.log" 2>&1 &
    pids+=($!)
  done
  FF_OK=1
  for p in "${pids[@]}"; do wait "$p" || { FF_OK=0; kill "${pids[@]}" 2>/dev/null || true; }; done
  cat views-facefix/facefix-*.log
  copy_back views-facefix/report-*.json views-facefix/facefix-*.log
  (( FF_OK )) || { log "FACEFIX FAILED (views-facefix/facefix-*.log): stopping"; exit 1; }
  copy_back "${SAMPLES[@]/views/views-facefix}"  # the fixed ones among the samples (a view left as is isn't there)
  FIXED=($(ls views-facefix/videos/*.mp4 2>/dev/null || true))
  for f in ${FIXED[@]+"${FIXED[@]}"}; do mv "$f" views/videos/; done
  log "FACEFIX: ${#FIXED[@]} of ${#ALL[@]} views got the face; samples in $OUTD/views-facefix"
fi

# --- SeedVR2 2x (on any failure the up variants are dropped and the raw ones go on) --------------------------------------
RC=0
upscale() {
  wait "$FETCH" || { cat "$S/fetch.log"; log "SeedVR2 weights not fetched"; return 1; }
  log "SeedVR2 2x on $NG GPU(s)"
  local ALL W H FPS FRAMES RES BATCH g i p f b o w h r n pids=()
  ALL=($(ls views/videos/*.mp4 | sort))
  probe() { ffprobe -v error -count_packets -select_streams v:0 \
      -show_entries stream=width,height,r_frame_rate,nb_read_packets -of csv=p=0 "$1"; }
  IFS=, read -r W H FPS FRAMES < <(probe "${ALL[0]}") || return 1
  RES=$(( ( (W < H ? W : H) * 2 + 8 ) / 16 * 16 )); BATCH=$(( (FRAMES + 2) / 4 * 4 + 1 ))
  mkdir -p views-up/videos
  for ((g = 0; g < NG; g++)); do
    mkdir -p "$S/up-in-$g" "$S/up-out-$g"
    for ((i = g; i < ${#ALL[@]}; i += NG)); do cp "${ALL[i]}" "$S/up-in-$g/"; done
    ( source "$L/envs/seedvr2/bin/activate" && OMP_NUM_THREADS=$RT CUDA_VISIBLE_DEVICES=$g $PY "$L/repos/SeedVR2-cli/inference_cli.py" \
        "$S/up-in-$g" --output "$S/up-out-$g" --resolution "$RES" --batch_size "$BATCH" \
        --dit_model seedvr2_ema_3b_fp16.safetensors --model_dir "$S/seedvr2" --video_backend ffmpeg \
        --color_correction lab --cache_dit --cache_vae --vae_encode_tiled --vae_decode_tiled ) > "$S/up-$g.log" 2>&1 &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || { tail -20 "$S"/up-*.log; log "SeedVR2 failed"; return 1; }; done
  for f in "${ALL[@]}"; do
    b=$(basename "$f"); o=$(ls "$S"/up-out-*/"$b" 2>/dev/null | sed -n 1p)
    [ -n "$o" ] || { log "SeedVR2 made no $b"; return 1; }
    IFS=, read -r w h r n < <(probe "$o") || return 1
    [ "$n" = "$FRAMES" ] && [ "$r" = "$FPS" ] || { log "SeedVR2 $b: $n frames at $r, wanted $FRAMES at $FPS"; return 1; }
    mv "$o" views-up/videos/
  done
  $PY - "$S/run" "$w" "$h" <<'PY'
import json, shutil, sys
from pathlib import Path
run, w, h = Path(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3])
cams = json.loads((run / "views/cameras.json").read_text())
w0, h0 = cams["cameras"][0]["image_width"], cams["cameras"][0]["image_height"]
for c in cams["cameras"]:
    c["K"][0] = [c["K"][0][0] * w / w0, c["K"][0][1], c["K"][0][2] * w / w0]
    c["K"][1] = [c["K"][1][0], c["K"][1][1] * h / h0, c["K"][1][2] * h / h0]
    c["image_width"], c["image_height"] = w, h
(run / "views-up/cameras.json").write_text(json.dumps(cams, indent=1))
if (run / "views/metadata.json").exists():
    shutil.copy(run / "views/metadata.json", run / "views-up/metadata.json")
print(f"[upscale] cameras.json scaled {w0}x{h0} -> {w}x{h}")
PY
}
if (( UP )); then
  if upscale; then
    copy_back views-up/cameras.json "${SAMPLES[@]/views/views-up}"
  else
    RC=1
    VARIANTS=$(for v in $VARIANTS; do [[ $v == up:* ]] || echo "$v"; done | xargs)
    log "SeedVR2 FAILED: going on with ${VARIANTS:-nothing}"
  fi
fi

# --- freezes, metrics and exports, one queue per GPU -----------------------------------------------------------------
TASKS=()
for v in $VARIANTS; do
  for r in $REALS; do
    for cap in $CAPS; do TASKS+=("freeze $v:$r $cap"); done
    (( METRICS )) && TASKS+=("metrics $v:$r ${CAPS%% *}")
  done
done
extras_json() {  # extras_json K n freeze|metrics: the first n other real views at their weights (+ the rest at 0)
  $PY - "$DATA" "$1" "$2" "$3" <<'PY'
import json, sys
d, k, n, kind = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
views = json.load(open(f"{d}/real/extras.json"))
use = [dict(v, weight=v.get("weight", 1.0) if i < n else 0.0) for i, v in enumerate(views) if i < n or kind == "metrics"]
print(json.dumps([{"video": f"{d}/real/{v['name']}/{v['name']}.mkv", "offset": -k, "masks": f"{d}/real/{v['name']}/masks",
                   "ignore": f"{d}/real/{v['name']}/ignore", "focal": v["focal"], "weight": v["weight"]} for v in use]))
PY
}
recon() {  # recon freeze|metrics views:mode:reals cap gpu
  local kind=$1 spec=$2 cap=$3 g=$4 views mode r out res k f t xs=""
  IFS=: read -r views mode r <<< "$spec"
  read -r k f t _ < <(runinfo) || { log "bad run record"; return 1; }
  local p6; p6=$(printf '%06d' "$k")
  for x in source-4k.mkv "masks/$p6.png" "ignore/$p6.png"; do
    test -s "$DATA/$x" || { log "$x missing in $DATA for K=$k"; return 1; }
  done
  [ "$views" = up ] && res=views-up || res=views
  if [ "$kind" = metrics ]; then out=recon-metrics-$views-$mode-r$r; else out=recon-$views-$mode-r$r-$((cap / 1000))k; fi
  if (( r > 0 )) || [[ $kind == metrics && $NX -gt 0 ]]; then
    extras_json "$k" "$r" "$kind" > "$out.extra.json" || { log "$out: extra views unreadable"; return 1; }
    xs="--extra-sources $S/run/$out.extra.json"
  fi
  log "$out: K=$k FOCAL=$f on GPU $g ($GPUNAME)"
  mkdir -p "$out"
  printf '{"K": %s, "FOCAL": %s, "views": "%s", "mode": "%s", "reals": %s, "cap": %s, "seed": "%s", "gpu": "%s"}\n' \
    "$k" "$f" "$res" "$mode" "$r" "$cap" "${SEED:-}" "$GPUNAME" > "$out/used.json"
  OMP_NUM_THREADS=$RT MKL_NUM_THREADS=$RT CUDA_VISIBLE_DEVICES=$g $PY -m lucid.recon --result "$res" --start "$k" --end "$((k + 1))" --out "$out" \
    --cap "$cap" --iters-first "${ITERS:-15000}" --sh-degree 1 --aniso 0.05 --peek 0,4,8,12,20 \
    --source-video "$DATA/source-4k.mkv" --source-masks "$DATA/masks" --source-ignore "$DATA/ignore" --source-focal "$f" \
    --source-weight 3.0 --source-every 1 --source-iters 4000 --face-weight "${FACE:-2.0}" \
    $( [ "$kind" = metrics ] && echo --holdout-every 8 ) $( [ "$mode" = agree ] && echo --source-agree ) $xs > "$out.log" 2>&1 \
    || { log "$out FAILED (see $out.log)"; return 1; }
  [ "$kind" = metrics ] && return 0
  OMP_NUM_THREADS=$RT MKL_NUM_THREADS=$RT CUDA_VISIBLE_DEVICES=$g $PY -m lucid.export --recon "$out" --out "bundle-${out#recon-}" --id "$ID" --name "Court Side" \
    --result views --clip prepped.mp4 --fps 25 > "bundle-${out#recon-}.log" 2>&1 \
    || { log "bundle-${out#recon-} FAILED"; return 1; }
  log "$out done"
}
(( ${#TASKS[@]} )) || { log "nothing to train"; exit 1; }
pids=()
for ((g = 0; g < NG; g++)); do
  ( rc=0
    for ((i = g; i < ${#TASKS[@]}; i += NG)); do recon ${TASKS[i]} "$g" || rc=1; done
    exit $rc ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" || RC=1; done

# --- results back to /blue -------------------------------------------------------------------------------------------
KEEP=(recon-*/recon-*.json recon-*/source-camera-*.json recon-*/peek-*.jpg recon-*/used.json recon-*.log recon-*.extra.json
      bundle-*)
PLYS=($(ls recon-*-*k/frames/*.ply 2>/dev/null || true))
MB=$( { du -ck "${KEEP[@]}" ${PLYS[@]+"${PLYS[@]}"} 2>/dev/null || true; } | awk 'END { printf "%d", $1 / 1024 }')
(( MB <= ${KEEP_MB:-900} )) || { log "results are $MB MB: the recon PLYs stay behind (the bundles keep a PLY each)"; PLYS=(); }
copy_back "${KEEP[@]}" ${PLYS[@]+"${PLYS[@]}"}
$PY "$C/court_grid_report.py" "$OUTD" || true
log "results in $OUTD ($(du -sh "$OUTD" | cut -f1)); exit $RC"
exit $RC
