#!/bin/bash
#SBATCH --job-name=lucid-frames
#SBATCH --account=iruchkin
#SBATCH --qos=iruchkin
#SBATCH --partition=hpg-default
#SBATCH --cpus-per-task=2
#SBATCH --mem=8G
#SBATCH --time=00:20:00
#SBATCH --output=/blue/iruchkin/vishalnaveen/lucid/jobs/%x-%j.log
# A phone video of one person -> the best 8-12 frames, as the photo folder lhmpp-avatar.sbatch reads. CPU only, minutes.
#   sbatch --export=ALL,NAME=grandma,VIDEO=/blue/.../clip.mov avatars/hpg/video-frames.sbatch
# Then:  sbatch --export=ALL,NAME=grandma,TITLE="Grandma" avatars/hpg/lhmpp-avatar.sbatch
# VIDEO is a clip already on HiPerGator (it never leaves it); NAME names the photos folder
# data/avatars/photos/$NAME (OUT=... for elsewhere; it must hold no other photo). FRAMES_ARGS passes more flags to
# video_frames.py, e.g. FRAMES_ARGS="--count 12 --box 0.2,0.05,0.8,1.0 --crops --contact $L/data/avatars/$NAME-sheet.png".
# Only people who agreed (AGENTS.md rule 5; family clips: the family's yes, team/ian.md for Ian's grandma).
# Out: $OUT/frame-01.jpg ... in time order and pick.json (times, scores, what was rejected). Ends FRAMES_OK.
set -euo pipefail
L=/blue/iruchkin/vishalnaveen/lucid
NAME=${NAME:?set NAME, e.g. grandma}
VIDEO=${VIDEO:?set VIDEO to the clip on HiPerGator}
OUT=${OUT:-$L/data/avatars/photos/$NAME}
AV=$L/repos/lucid_dreams/avatars
flock $L/repos/.lucid_dreams.lock git -C $L/repos/lucid_dreams pull -q --ff-only || echo "repo update skipped"
[ -f "$VIDEO" ] || { echo "no video at $VIDEO"; exit 1; }
set +u; source $L/code/pipeline/hpg/env.sh; set -u   # the 4DAnyone env: numpy and ffmpeg
command -v ffmpeg >/dev/null || { echo "no ffmpeg in the 4DAnyone env"; exit 1; }
# shellcheck disable=SC2086  # FRAMES_ARGS is a flag list
python -u $AV/video_frames.py "$VIDEO" --out "$OUT" --overwrite ${FRAMES_ARGS:-}
ls -la "$OUT"
echo FRAMES_OK
