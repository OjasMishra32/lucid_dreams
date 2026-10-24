#!/bin/zsh
# Runs once the shared HiPerGator connection is up: syncs pipeline/ to $L/code and installs voice isolation.
# (after-reconnect.sh handles SMPL-X and the avatar assets; the autopilot handles runs.)
cd "${0:A:h}/../.."
L=/blue/iruchkin/vishalnaveen/lucid
until ssh -O check -o ControlPath=~/.ssh/cm-hpg hpg >/dev/null 2>&1; do sleep 20; done
rsync -az -e "ssh -o ControlPath=$HOME/.ssh/cm-hpg" --exclude __pycache__ pipeline/ hpg:$L/code/pipeline/ || exit 1
ssh -o ControlPath=~/.ssh/cm-hpg hpg "grep -l DEMUCS_OK $L/jobs/lucid-install-demucs-*.log >/dev/null 2>&1 && echo already installed || (cd $L/jobs && sbatch $L/code/pipeline/hpg/install-demucs.sbatch)"
