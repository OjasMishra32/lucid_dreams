#!/bin/zsh
# HiPerGator login: asks for the username, then opens a shared SSH connection (~/.ssh/cm-hpg, kept 24 h)
# so later commands can reuse it without another password + Duo.
print -n "HiPerGator username (yours, or sbernalorta): "
read u
exec ssh -o ControlMaster=auto -o ControlPath=~/.ssh/cm-hpg -o ControlPersist=24h \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=10 "$u@hpg.rc.ufl.edu"
