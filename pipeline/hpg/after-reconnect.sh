#!/bin/bash
# After the HiPerGator connection is back: install SMPL-X (npz for 4DAnyone, pkl for DiGS-Avatar) and queue Vishal's
# avatar asset job. The autopilot sees SMPL-X and submits the queued jump shots on its own.
set -uo pipefail
SSH="ssh -S $HOME/.ssh/cm-hpg -o BatchMode=yes -o ControlMaster=no hpg"
L=/blue/iruchkin/vishalnaveen/lucid
for i in $(seq 1 720); do ssh -O check -o ControlPath="$HOME/.ssh/cm-hpg" hpg >/dev/null 2>&1 && break; sleep 30; done
ssh -O check -o ControlPath="$HOME/.ssh/cm-hpg" hpg >/dev/null 2>&1 || { echo "no connection after 6 h"; exit 1; }
$SSH "mkdir -p $L/models/smplx $L/repos/4DAnyone/models/body_models/smplx"
rsync -a --partial -e "ssh -S $HOME/.ssh/cm-hpg -o BatchMode=yes -o ControlMaster=no" \
  "$HOME/Downloads/models/smplx/SMPLX_NEUTRAL.npz" "$HOME/Downloads/models/smplx/SMPLX_NEUTRAL.pkl" hpg:$L/models/smplx/ || exit 1
$SSH "cp $L/models/smplx/SMPLX_NEUTRAL.npz $L/repos/4DAnyone/models/body_models/smplx/ && ls -la $L/models/smplx"
cd "$(dirname "$0")/../.." && rsync -a --exclude __pycache__ --exclude .venv -e "ssh -S $HOME/.ssh/cm-hpg -o BatchMode=yes -o ControlMaster=no" avatars/ pipeline/ hpg:$L/code/ 2>/dev/null
rsync -a --exclude __pycache__ -e "ssh -S $HOME/.ssh/cm-hpg -o BatchMode=yes -o ControlMaster=no" pipeline/ hpg:$L/code/pipeline/
rsync -a --exclude __pycache__ --exclude .venv -e "ssh -S $HOME/.ssh/cm-hpg -o BatchMode=yes -o ControlMaster=no" avatars/ hpg:$L/code/avatars/
$SSH "cd $L/jobs && sbatch --parsable $L/code/avatars/hpg/digs-assets.sbatch" && echo "AVATAR_ASSETS_QUEUED"
echo SMPLX_INSTALLED
