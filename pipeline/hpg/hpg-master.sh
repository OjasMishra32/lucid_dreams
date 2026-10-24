#!/bin/zsh
# Opens the shared HiPerGator connection as vishalnaveen: password, then Duo, then ssh detaches into the background
# (-fN: no shell anywhere). Everything on this Mac then reaches HiPerGator through ~/.ssh/cm-hpg.
until ssh -O check -o ControlPath=~/.ssh/cm-hpg hpg >/dev/null 2>&1; do
  print "\nLog in to HiPerGator as vishalnaveen (password, then approve Duo on your phone):"
  ssh -fN -o ControlMaster=yes -o ControlPath=~/.ssh/cm-hpg -o ControlPersist=yes \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=10 vishalnaveen@hpg.rc.ufl.edu || sleep 2
done
print "Connected. Thanks! This window closes by itself."
sleep 3
