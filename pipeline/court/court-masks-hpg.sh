#!/bin/bash
# Court Side masks on HiPerGator, from the Mac, with the HiPerGator session open (`ssh hpg true`). One step per call:
#   court-masks-hpg.sh env                                                 upload the scripts, build the SAM env (once)
#   court-masks-hpg.sh people <frames dir> <sam_plan.json> <sam_people.py> <staging dir>
#                                                                          pack, upload, submit the all-people masks
#   court-masks-hpg.sh sam <name> <upload dir>   upload a court_sam.py set (or folder of sets), submit court-sam-<name>
#   court-masks-hpg.sh rematte <name>            the band matte again on court-sam-<name>'s masks (no upload)
#   court-masks-hpg.sh matte <clip> <masks dir> <staging dir> <name>...    pack, upload, submit the pair's soft edges
#   court-masks-hpg.sh fetch people <dir>      masks-people.tar into <dir>, unpacked there (label/, prob/, objects.json)
#   court-masks-hpg.sh fetch sam <name> <dir> [unpack flags]   masks-sam.tar into <dir>, unpacked there
#                                              (--size w,h for a cropped set, --single for one-frame sets)
#   court-masks-hpg.sh fetch rematte <name> <dir>   masks-alpha.tar into <dir>, unpacked as <dir>/<object>-alpha/
#   court-masks-hpg.sh fetch matte <masks dir> <staging dir>    the alpha mattes into <masks dir>/<name>-alpha/
# Data paths are arguments (nothing about the footage lives in git). The HPG side is court-hpg.sh: it checks the upload
# and the group quota, submits, and deletes nothing. Env: DRY=1 prints what would run; HOST (hpg) and L (its /blue base)
# for another allocation, plus ACCOUNT, QOS, PARTITION, CPUS, ENV_QOS, ENV_PARTITION, QUOTA_GROUP, MIN_GB for
# court-hpg.sh.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
HOST=${HOST:-hpg}; L=${L:-/blue/iruchkin/vishalnaveen/lucid}; C=$L/code/pipeline/court
PASS=" L=$L"
for v in ACCOUNT QOS PARTITION CPUS ENV_QOS ENV_PARTITION QUOTA_GROUP MIN_GB; do
  [ -n "${!v:-}" ] && PASS="$PASS $v=$(printf %q "${!v}")"
done
SSH="ssh -o ControlMaster=no -o BatchMode=yes"
run() { if [ "${DRY:-0}" = 1 ]; then echo "+ $*"; else "$@"; fi; }
if [ "${DRY:-0}" != 1 ]; then
  $SSH "$HOST" true 2>/dev/null || { echo "open the HiPerGator connection first: ssh $HOST true" >&2; exit 3; }
fi
up_code() {
  run $SSH "$HOST" "mkdir -p $C $L/data/court"
  run rsync -a -e "$SSH" "$HERE"/court-lib.sh "$HERE"/court-hpg.sh "$HERE"/court-sam-env.sbatch \
    "$HERE"/court-masks.sbatch "$HERE"/court-sam.sbatch "$HERE"/court-matte.sbatch "$HERE"/court_sam.py \
    "$HERE"/court_matte.py "$HOST:$C/"
}
submit() { run $SSH "$HOST" "env$PASS bash $C/court-hpg.sh $1"; }
case "${1:-}" in
  env)
    up_code
    submit court-sam-env ;;
  people)
    F=${2:?frames dir}; P=${3:?sam_plan.json}; S=${4:?sam_people.py}; O=${5:?staging dir}
    run python3 -I "$HERE/sam_pack.py" people --frames "$F" --plan "$P" --code "$S" --out "$O"
    up_code
    run rsync -a --partial -e "$SSH" "$O/court-sam-people/" "$HOST:$L/data/court/court-sam-people/"
    submit court-sam-people ;;
  sam)
    N=${2:?name}; U=${3:?upload dir}
    up_code
    # -H: sets that share one clip (hard links) send it once
    run rsync -aH --partial -e "$SSH" "$U/" "$HOST:$L/data/court/court-sam-$N/"
    submit "court-sam-$N" ;;
  rematte)
    N=${2:?name}
    up_code
    submit "court-rematte-$N" ;;
  matte)
    V=${2:?clip}; M=${3:?masks dir}; O=${4:?staging dir}; shift 4
    (( $# )) || { echo "name the masks to soften (folders in $M)" >&2; exit 1; }
    run python3 -I "$HERE/court_matte.py" pack --video "$V" --masks "$M" --names "$@" --out "$O"
    up_code
    run rsync -a --partial -e "$SSH" "$O/court-matte/" "$HOST:$L/data/court/court-matte/"
    submit court-matte ;;
  fetch)
    case "${2:-}" in
      people)
        O=${3:?dir}
        run mkdir -p "$O"
        run rsync -a -e "$SSH" "$HOST:$L/runs/court-sam-people/masks-people.tar" "$O/"
        run tar -xf "$O/masks-people.tar" -C "$O" ;;
      sam)
        N=${3:?name}; O=${4:?dir}
        run mkdir -p "$O"
        run rsync -a -e "$SSH" "$HOST:$L/runs/court-sam-$N/masks-sam.tar" "$O/"
        run python3 -I "$HERE/court_sam.py" unpack "$O/masks-sam.tar" --out "$O" "${@:5}" ;;
      rematte)
        N=${3:?name}; O=${4:?dir}
        run mkdir -p "$O"
        run rsync -a -e "$SSH" "$HOST:$L/runs/court-rematte-$N/masks-alpha.tar" "$O/"
        run python3 -I "$HERE/court_sam.py" unpack "$O/masks-alpha.tar" --out "$O" "${@:5}" ;;
      matte)
        M=${3:?masks dir}; O=${4:?staging dir}
        run mkdir -p "$O"
        run rsync -a -e "$SSH" "$HOST:$L/runs/court-matte/masks-matte.tar" "$O/"
        run python3 -I "$HERE/court_matte.py" unpack "$O/masks-matte.tar" --masks "$M" ;;
      *) echo "fetch people <dir> | fetch sam <name> <dir> [flags] | fetch matte <masks dir> <staging dir>" >&2
         exit 1 ;;
    esac ;;
  *) sed -n '2,15p' "$0" >&2; exit 1 ;;
esac
