#!/bin/bash
#SBATCH --job-name=lucid-upscale
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-b200,hpg-rtx6000
#SBATCH --gpus=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
#SBATCH --time=02:00:00
#SBATCH --array=0-7
#SBATCH --output=%x-%A_%a.log
# Stage "upscale": SeedVR2 3B fp16 (one-step diffusion video restoration) upscales every 4DAnyone view video.
# views/videos/*.mp4 -> views-up/videos/ with the same names, frame count and fps, plus views-up/cameras.json with the
# intrinsics scaled, so views-up/ is a drop-in --result for lucid.recon. Not in the chain yet; doesn't touch status.json.
# Needs RUN (run dir). Optional SCALE (default 2), BATCH (frames per diffusion window, 4n+1; default the whole clip,
# which keeps detail steady over time). One array task per slice of videos (48 views / 8 tasks = 6), model loaded once.
# Env + weights: setup-seedvr2.sbatch.
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
module load conda/26.7 cuda/12.8.1 >/dev/null 2>&1
eval "$(conda shell.bash hook)"
conda activate $L/envs/4danyone
source $L/envs/seedvr2/bin/activate
cd "$RUN"
mapfile -t ALL < <(ls views/videos/*.mp4 | sort)
N=${#ALL[@]} K=${SLURM_ARRAY_TASK_COUNT:-1} I=${SLURM_ARRAY_TASK_ID:-0}
STEP=$(( (N + K - 1) / K ))
MINE=("${ALL[@]:$((I * STEP)):$STEP}")
[ ${#MINE[@]} -gt 0 ] || { echo "[upscale] task $I has no videos"; exit 0; }
probe() { ffprobe -v error -select_streams v:0 -show_entries stream=width,height,nb_frames,r_frame_rate -of csv=p=0 "$1"; }
IFS=, read -r W H FPS FRAMES < <(probe "${ALL[0]}")
SCALE=${SCALE:-2}
RES=$(python -c "print(round(min($W, $H) * $SCALE / 16) * 16)")
BATCH=${BATCH:-$(( (FRAMES + 2) / 4 * 4 + 1 ))}   # smallest 4n+1 >= FRAMES; SeedVR2 pads and trims the rest
IN=${TMPDIR:-/tmp}/upscale-in-$I OUT=${TMPDIR:-/tmp}/upscale-out-$I
rm -rf "$IN" "$OUT"
mkdir -p "$IN" "$OUT" views-up/videos
for f in "${MINE[@]}"; do cp "$f" "$IN/"; done
echo "[upscale] task $I: ${#MINE[@]} videos, ${W}x${H} -> short side $RES, $FRAMES frames at $FPS, window $BATCH"
python $L/repos/SeedVR2-cli/inference_cli.py "$IN" --output "$OUT" --resolution "$RES" --batch_size "$BATCH" \
  --dit_model seedvr2_ema_3b_fp16.safetensors --model_dir $L/models/seedvr2 --video_backend ffmpeg \
  --color_correction lab --cache_dit --cache_vae --vae_encode_tiled --vae_decode_tiled  # tiled VAE is 2-2.5x faster here
for f in "${MINE[@]}"; do
  b=$(basename "$f")
  IFS=, read -r w h r n < <(probe "$OUT/$b")
  [ "$n" = "$FRAMES" ] && [ "$r" = "$FPS" ] || { echo "[upscale] $b: $n frames at $r, wanted $FRAMES at $FPS"; exit 1; }
  cp "$OUT/$b" "views-up/videos/.$b.part" && mv "views-up/videos/.$b.part" "views-up/videos/$b"
  echo "[upscale] $b ${w}x${h} $n frames"
done
if [ "$I" = 0 ]; then
  python - "$RUN" <<'PY'
import json, shutil, subprocess, sys
from pathlib import Path
run = Path(sys.argv[1])
cams = json.loads((run / "views/cameras.json").read_text())
w0, h0 = cams["cameras"][0]["image_width"], cams["cameras"][0]["image_height"]
# every view comes out at the same size; read it from the first finished one
first = sorted((run / "views-up/videos").glob("*.mp4"))[0]
w, h = map(int, subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                         "stream=width,height", "-of", "csv=p=0", str(first)], text=True).split(","))
sx, sy = w / w0, h / h0
for c in cams["cameras"]:
    c["K"][0] = [c["K"][0][0] * sx, c["K"][0][1], c["K"][0][2] * sx]
    c["K"][1] = [c["K"][1][0], c["K"][1][1] * sy, c["K"][1][2] * sy]
    c["image_width"], c["image_height"] = w, h
(run / "views-up/cameras.json").write_text(json.dumps(cams, indent=1))
if (run / "views/metadata.json").exists():
    shutil.copy(run / "views/metadata.json", run / "views-up/metadata.json")
print(f"[upscale] cameras.json scaled {w0}x{h0} -> {w}x{h}")
PY
fi
rm -rf "$IN" "$OUT"
echo "[upscale] task $I done"
