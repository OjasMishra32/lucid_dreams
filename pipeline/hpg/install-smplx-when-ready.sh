#!/bin/bash
# Waits (up to 4 h) for an SMPL-X zip to finish downloading into ~/Downloads, then installs SMPLX_NEUTRAL.npz on
# HiPerGator for 4DAnyone and the avatars, and resubmits the 4DAnyone GPU test.
set -uo pipefail
SSH="ssh -S $HOME/.ssh/cm-hpg -o BatchMode=yes -o ControlMaster=no hpg"
L=/blue/iruchkin/vishalnaveen/lucid
for i in $(seq 1 480); do
  Z=$(ls -t "$HOME"/Downloads/models_smplx*.zip 2>/dev/null | head -1)
  if [ -n "$Z" ] && ! ls "$HOME"/Downloads/*.crdownload "$HOME"/Downloads/*.download >/dev/null 2>&1; then
    if unzip -tq "$Z" >/dev/null 2>&1; then break; fi
  fi
  Z=""; sleep 30
done
[ -z "${Z:-}" ] && { echo "no SMPL-X zip after 4 h"; exit 1; }
T=$(mktemp -d)
NPZ=$(unzip -Z1 "$Z" | grep -m1 'SMPLX_NEUTRAL.npz$') || { echo "SMPLX_NEUTRAL.npz not in $Z"; exit 1; }
unzip -q -o "$Z" "$NPZ" -d "$T"
$SSH "mkdir -p $L/models/smplx $L/repos/4DAnyone/models/body_models/smplx"
scp -q -o ControlPath="$HOME/.ssh/cm-hpg" "$T/$NPZ" hpg:$L/models/smplx/SMPLX_NEUTRAL.npz
$SSH "cp $L/models/smplx/SMPLX_NEUTRAL.npz $L/repos/4DAnyone/models/body_models/smplx/ && ls -la $L/repos/4DAnyone/models/body_models/smplx/ && cd $L/jobs && sbatch --parsable smoke-4da.sbatch"
rm -rf "$T"
echo SMPLX_INSTALLED
