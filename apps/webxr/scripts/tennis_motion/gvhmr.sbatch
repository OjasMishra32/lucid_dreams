#!/bin/bash
#SBATCH --job-name=tennis-gvhmr
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-b200,hpg-rtx6000
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=4
#SBATCH --mem=48G
#SBATCH --time=01:00:00
#SBATCH --output=%x-%j.log
# GVHMR (inside 4DAnyone) on every video in $T/src: scaled to at most 1920 px, then gvhmr_clip.py -> $T/out/<id>.npz
# (about a minute per clip). Copy gvhmr_clip.py to $T first; delete $T/src, $T/in and $T/work afterwards (disk).
set -uo pipefail
source /blue/iruchkin/vishalnaveen/lucid/code/pipeline/hpg/env.sh
T=${T:-$L/scratch/tennis}
mkdir -p $T/in $T/out
cd $T/src
for f in ${CLIPS:-*.mp4}; do
  id=${f%%.*}
  [ -f $T/in/$id.mp4 ] && continue
  src=$f; [ -f $id.orig.mp4 ] && src=$id.orig.mp4
  ffmpeg -v error -y -i $src -vf "scale=w=1920:h=1920:force_original_aspect_ratio=decrease:force_divisible_by=2" \
    -c:v libx264 -crf 16 -preset fast -an $T/in/$id.mp4
done
cd $L/repos/4DAnyone
for f in $T/in/${CLIPS:-*.mp4}; do
  id=$(basename $f .mp4)
  [ -f $T/out/$id.npz ] && continue
  echo "== $id $(date +%T)"
  python $T/gvhmr_clip.py --video $f --out $T/out/$id.npz --work $T/work/$id || echo "FAILED $id"
done
echo DONE $(date +%T)
