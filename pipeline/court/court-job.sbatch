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
# Stages $L/data/court/$ID/ in, makes the 4DAnyone views (Turbo or 24 steps, from job.json), SeedVR2 2x views if a
# variant asks for them, then every freeze of frame K (one per variant and cap), a held-out metrics recon per variant
# and an export per freeze, spread over the node's GPUs; copies only results back to $L/runs/$ID/ (the gate-2 view
# samples as soon as the views exist). Writes nothing else on /blue and deletes nothing outside its own scratch.
# K and FOCAL are read from $L/data/court/$ID/court-run.json just before each recon, so a corrected FOCAL uploaded
# while the views run is used; each recon logs and records the K and FOCAL it trained with.
# Env: ID; VARIANTS ("raw:default raw:agree up:default up:agree": views raw|up x mode default|agree, where agree
# = recon --source-agree, solid from every side but a few cm off the real camera); CAPS (300000); METRICS (1);
# ITERS (15000); FACE (2.0); MIN_SCRATCH_GB (200); KEEP_MB (900: past that the recon PLYs stay behind).
set -euo pipefail
L=${L:-/blue/iruchkin/vishalnaveen/lucid}; C=$L/code/pipeline/court
: "${ID:?ID}"
[[ $ID =~ ^court-[a-z0-9][a-z0-9-]*$ ]] || { echo "court-job: bad id '$ID'" >&2; exit 1; }
DATA=$L/data/court/$ID; OUTD=$L/runs/$ID
VARIANTS=${VARIANTS:-"raw:default raw:agree up:default up:agree"}; CAPS=${CAPS:-300000}; METRICS=${METRICS:-1}
S=${TMPDIR:-/tmp}/court-$ID-${SLURM_JOB_ID:-$$}
log() { echo "[court-job $(date +%T)] $*"; }
for v in $VARIANTS; do
  [[ $v =~ ^(raw|up):(default|agree)$ ]] || { echo "court-job: variant '$v' (raw|up):(default|agree)" >&2; exit 1; }
done
mkdir -p "$S"
trap 'cd /; rm -rf "$S"' EXIT  # our own scratch only

# --- the node --------------------------------------------------------------------------------------------------------
log "$ID on $(hostname), job ${SLURM_JOB_ID:-local}; GPUs:"
nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader | sed 's/^/  /'
NG=$(nvidia-smi -L | grep -c '^GPU' || true)
(( NG >= 1 )) || { log "no GPU"; exit 1; }
GPUNAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)
FREE_S=$(df -Pk "$S" | awk 'NR == 2 { printf "%d", $4 / 1048576 }')
(( FREE_S >= ${MIN_SCRATCH_GB:-200} )) || { log "scratch $S has $FREE_S GB free, need ${MIN_SCRATCH_GB:-200}"; exit 1; }
log "scratch $S: $FREE_S GB free"
source "${ENV_SH:-$L/code/pipeline/hpg/env.sh}"
export HF_HOME=$S/hf PIP_CACHE_DIR=$S/pip XDG_CACHE_HOME=$S/cache  # no caches on /blue
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
log "K=$K FOCAL=$FOCAL $( ((TURBO)) && echo Turbo || echo 24-step) views; variants: $VARIANTS; caps: $CAPS"
UP=0; [[ " $VARIANTS " == *" up:"* ]] && UP=1
if (( UP )); then  # SeedVR2's weights into scratch while the views are made
  ( source "$L/envs/seedvr2/bin/activate" && $PY "$C/court_fetch_seedvr2.py" "$S/seedvr2" ) > "$S/fetch.log" 2>&1 &
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
log "prep + 4DAnyone views"
$PY -m lucid.prep_clip input.mp4 --out prepped.mp4 --start-s 0 > prep.json
( cd "$L/repos/4DAnyone" && CUDA_VISIBLE_DEVICES=0 $PY inference.py --video_path "$S/run/prepped.mp4" \
    --output_dir "$S/run/views" --views_per_layer "$VPL" --layer_pitches "$PITCHES" \
    $( ((TURBO)) || echo --enable_turbo=False ) )
SAMPLES=(views/videos/00.mp4 views/videos/04.mp4 views/videos/08.mp4 views/videos/12.mp4)
copy_back prep.json prepped.mp4 views/cameras.json views/metadata.json views/gvhmr "${SAMPLES[@]}"
log "views done; gate-2 samples in $OUTD/views"

# --- SeedVR2 2x ------------------------------------------------------------------------------------------------------
if (( UP )); then
  wait "$FETCH" || { cat "$S/fetch.log"; log "SeedVR2 weights not fetched"; exit 1; }
  log "SeedVR2 2x on $NG GPU(s)"
  ALL=($(ls views/videos/*.mp4 | sort))
  IFS=, read -r W H FPS FRAMES < <(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,nb_frames -of csv=p=0 "${ALL[0]}")
  RES=$(( ( (W < H ? W : H) * 2 + 8 ) / 16 * 16 )); BATCH=$(( (FRAMES + 2) / 4 * 4 + 1 ))
  mkdir -p views-up/videos
  pids=()
  for ((g = 0; g < NG; g++)); do
    mkdir -p "$S/up-in-$g" "$S/up-out-$g"
    for ((i = g; i < ${#ALL[@]}; i += NG)); do cp "${ALL[i]}" "$S/up-in-$g/"; done
    ( source "$L/envs/seedvr2/bin/activate" && CUDA_VISIBLE_DEVICES=$g $PY "$L/repos/SeedVR2-cli/inference_cli.py" \
        "$S/up-in-$g" --output "$S/up-out-$g" --resolution "$RES" --batch_size "$BATCH" \
        --dit_model seedvr2_ema_3b_fp16.safetensors --model_dir "$S/seedvr2" --video_backend ffmpeg \
        --color_correction lab --cache_dit --cache_vae --vae_encode_tiled --vae_decode_tiled ) > "$S/up-$g.log" 2>&1 &
    pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || { cat "$S"/up-*.log; log "SeedVR2 failed"; exit 1; }; done
  for f in "${ALL[@]}"; do
    b=$(basename "$f"); o=$(ls "$S"/up-out-*/"$b")
    IFS=, read -r w h r n < <(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,nb_frames -of csv=p=0 "$o")
    [ "$n" = "$FRAMES" ] && [ "$r" = "$FPS" ] || { log "SeedVR2 $b: $n frames at $r, wanted $FRAMES at $FPS"; exit 1; }
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
  copy_back views-up/cameras.json "${SAMPLES[@]/views/views-up}"
fi

# --- freezes, metrics and exports, one queue per GPU -----------------------------------------------------------------
TASKS=()
for v in $VARIANTS; do
  for cap in $CAPS; do TASKS+=("freeze $v $cap"); done
  (( METRICS )) && TASKS+=("metrics $v ${CAPS%% *}")
done
recon() {  # recon freeze|metrics views:mode cap gpu
  local kind=$1 views=${2%%:*} mode=${2##*:} cap=$3 g=$4 out res k f t
  read -r k f t _ < <(runinfo) || { log "bad run record"; return 1; }
  [ "$views" = up ] && res=views-up || res=views
  if [ "$kind" = metrics ]; then out=recon-metrics-$views-$mode; else out=recon-$views-$mode-$((cap / 1000))k; fi
  log "$out: K=$k FOCAL=$f on GPU $g ($GPUNAME)"
  mkdir -p "$out"
  printf '{"K": %s, "FOCAL": %s, "views": "%s", "mode": "%s", "cap": %s, "gpu": "%s"}\n' \
    "$k" "$f" "$res" "$mode" "$cap" "$GPUNAME" > "$out/used.json"
  CUDA_VISIBLE_DEVICES=$g $PY -m lucid.recon --result "$res" --start "$k" --end "$((k + 1))" --out "$out" \
    --cap "$cap" --iters-first "${ITERS:-15000}" --sh-degree 1 --aniso 0.05 --peek 0,4,8,12,20 \
    --source-video source-4k.mkv --source-masks masks --source-ignore ignore --source-focal "$f" \
    --source-weight 3.0 --source-every 1 --source-iters 4000 --face-weight "${FACE:-2.0}" \
    $( [ "$kind" = metrics ] && echo --holdout-every 8 ) $( [ "$mode" = agree ] && echo --source-agree ) > "$out.log" 2>&1 \
    || { log "$out FAILED (see $out.log)"; return 1; }
  [ "$kind" = metrics ] && return 0
  CUDA_VISIBLE_DEVICES=$g $PY -m lucid.export --recon "$out" --out "bundle-${out#recon-}" --id "$ID" --name "Court Side" \
    --result views --clip prepped.mp4 --fps 25 > "bundle-${out#recon-}.log" 2>&1 \
    || { log "bundle-${out#recon-} FAILED"; return 1; }
  log "$out done"
}
pids=()
for ((g = 0; g < NG; g++)); do
  ( rc=0
    for ((i = g; i < ${#TASKS[@]}; i += NG)); do recon ${TASKS[i]} "$g" || rc=1; done
    exit $rc ) &
  pids+=($!)
done
RC=0
for p in "${pids[@]}"; do wait "$p" || RC=1; done

# --- results back to /blue -------------------------------------------------------------------------------------------
KEEP=(recon-*/recon-*.json recon-*/source-camera-*.json recon-*/peek-*.jpg recon-*/used.json recon-*.log bundle-*)
PLYS=($(ls recon-*-*k/frames/*.ply 2>/dev/null || true))
MB=$( { du -ck "${KEEP[@]}" ${PLYS[@]+"${PLYS[@]}"} 2>/dev/null || true; } | awk 'END { printf "%d", $1 / 1024 }')
(( MB <= ${KEEP_MB:-900} )) || { log "results are $MB MB: the recon PLYs stay behind (the bundles keep a PLY each)"; PLYS=(); }
copy_back "${KEEP[@]}" ${PLYS[@]+"${PLYS[@]}"}
$PY "$C/court_grid_report.py" "$OUTD" || true
log "results in $OUTD ($(du -sh "$OUTD" | cut -f1)); exit $RC"
exit $RC
