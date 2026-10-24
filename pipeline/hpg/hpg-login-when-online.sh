#!/bin/zsh
# Waits for the network, then opens the shared HiPerGator connection as Vishal (he types the password + Duo).
# Keeps re-prompting until the connection is up, so it can sit in a tab until he's free.
until ssh -O check -o ControlPath=~/.ssh/cm-hpg hpg >/dev/null 2>&1; do
  until nc -z -G 5 hpg.rc.ufl.edu 22 >/dev/null 2>&1; do print -n "."; sleep 5; done
  print "\nHiPerGator reachable. Log in as vishalnaveen (password + Duo):"
  ssh -o ControlMaster=auto -o ControlPath=~/.ssh/cm-hpg -o ControlPersist=24h \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=10 vishalnaveen@hpg.rc.ufl.edu
  sleep 2
done
print "HiPerGator connection is up."
