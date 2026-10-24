#!/bin/zsh
# Waits for the network, then opens the shared HiPerGator connection as Vishal (he types the password + Duo).
until ping -c 1 -t 2 hpg.rc.ufl.edu >/dev/null 2>&1; do print -n "."; sleep 5; done
print "\nHiPerGator reachable. Log in as vishalnaveen:"
exec ssh -o ControlMaster=auto -o ControlPath=~/.ssh/cm-hpg -o ControlPersist=24h \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=10 vishalnaveen@hpg.rc.ufl.edu
