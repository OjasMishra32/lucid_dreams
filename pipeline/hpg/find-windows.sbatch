#!/bin/bash
#SBATCH --job-name=lucid-find-windows
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-turin,hpg-rtx6000
#SBATCH --gpus=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G
#SBATCH --time=01:00:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# Scores a film (FILM) or every film in a directory (FILMS) for replay windows: one person, whole body, still camera.
# Writes <film>.windows.json next to each film.
#   sbatch --export=ALL,FILM=$L/data/clips/pd/keaton.webm pipeline/hpg/find-windows.sbatch
set -euo pipefail
source /blue/iruchkin/vishalnaveen/lucid/code/pipeline/hpg/env.sh
export YOLO_WEIGHTS=$L/repos/4DAnyone/models/gvhmr/yolov8x.pt  # the detector 4DAnyone ships
for f in ${FILM:-} ${FILMS:+"$FILMS"/*.webm "$FILMS"/*.mp4}; do
  [ -f "$f" ] || continue
  python -u -m lucid.find_windows "$f" --top 6 > "${f%.*}.windows.json" && echo "OK $f" || echo "FAILED $f"
done
echo WINDOWS_DONE
