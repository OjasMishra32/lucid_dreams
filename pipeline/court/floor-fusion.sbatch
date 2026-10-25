#!/bin/bash
#SBATCH --job-name=court-mosaic4k
#SBATCH --cpus-per-task=4
#SBATCH --mem=8G
#SBATCH --time=01:30:00
#SBATCH --output=%x-%A_%a.log
# Court Side (stream E): the floor from above, fused from every frame of the 4K source (floor_fusion.py). CPU only.
# Submitted by floor-fusion-submit.sh (which passes the account, QOS and partition) with DATA (the upload: floor_fusion.py, plan.json, run.json, cams.json, det.json,
# masks.tar, source.mp4; court.json and floor-before.jpg for the sheet) and OUT. MODE:
#   probe   one task: can this python decode the source? (the array waits on it)
#   tile    array task N fuses plan tile N (one decode of the source per task)
#   stitch  after the array: master/floor.png + count.png, the shipped floors and the seat-view before/after sheet
# Everything is unpacked and written on the node's $TMPDIR; only results are copied to $OUT. Nothing on Blue is deleted.
set -euo pipefail
: "${DATA:?DATA}" "${OUT:?OUT}" "${MODE:?MODE}"
: "${L2:?L2 (the cluster base, where envs/ lives)}"
PY=${PY:-$L2/envs/4danyone/bin/python}
module load ffmpeg >/dev/null 2>&1 || true  # a decoder of last resort for the source (floor_fusion.read_frames)
export OMP_NUM_THREADS=${SLURM_CPUS_PER_TASK:-4} OPENBLAS_NUM_THREADS=${SLURM_CPUS_PER_TASK:-4}
T=${TMPDIR:-/tmp}/mosaic4k-${SLURM_JOB_ID:-0}-${SLURM_ARRAY_TASK_ID:-0}
mkdir -p "$T" "$OUT/tiles" "$OUT/logs"
FF="$PY -I $DATA/floor_fusion.py"
case $MODE in
  probe)
    $FF probe --video "$DATA/source.mp4"
    ;;
  tile)
    N=${SLURM_ARRAY_TASK_ID:?array task}
    tar -xf "$DATA/masks.tar" -C "$T"
    # run.json: {"masks": "<pattern inside masks.tar>", "exclude": ["x0,y0,x1,y1", ...]} (the clip's own numbers)
    MASKS=$($PY -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["masks"])' "$DATA/run.json")
    EXCL=$($PY -I -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1])).get("exclude", [])))' "$DATA/run.json")
    $FF tile --plan "$DATA/plan.json" --tile "$N" --cams "$DATA/cams.json" --video "$DATA/source.mp4" \
      --masks "$T/$MASKS" --det "$DATA/det.json" ${EXCL:+--exclude $EXCL} --out "$T/tiles"
    S=$(printf 'tile-%03d' "$N")
    cp "$T/tiles/$S.png" "$T/tiles/$S-count.png" "$T/tiles/$S.json" "$OUT/tiles/"
    ;;
  stitch)
    $FF stitch --plan "$DATA/plan.json" --tiles "$OUT/tiles" --out "$OUT/master"
    # the shipped candidates (WxH, the whole court): the bundle picks one by the Quest's memory
    for SZ in ${SIZES:-2048x2048 2048x4096 3584x4096}; do
      $FF ship --master "$OUT/master" --size "$SZ" --out "$OUT/ship-$SZ"
      $FF sheet --court "$DATA/court.json" --before "$DATA/floor-before.jpg" --after "$OUT/ship-$SZ/floor.jpg" \
        --out "$OUT/sheet-$SZ.jpg"
    done
    du -sh "$OUT"
    ;;
  *) echo "MODE=$MODE?" >&2; exit 2 ;;
esac
