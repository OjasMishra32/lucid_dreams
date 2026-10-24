#!/bin/zsh
# Opens the shared HiPerGator connection (as HPG_USER, default vishalnaveen): password, then Duo, then ssh detaches into the background
# (-fN: no shell anywhere). Everything on this Mac then reaches HiPerGator through ~/.ssh/cm-hpg.
U=${HPG_USER:-vishalnaveen}
tries=0
until ssh -O check -o ControlPath=~/.ssh/cm-hpg hpg >/dev/null 2>&1; do
  # a wrong password or a declined Duo gets another go; an account HiPerGator doesn't know stops after three
  (( ++tries > 3 )) && { print "\nHiPerGator keeps refusing $U: check the username (HPG_USER=...) and that the account exists."; exit 1; }
  print "\nLog in to HiPerGator as $U (password, then approve Duo on your phone):"
  ssh -fN -o ControlMaster=yes -o ControlPath=~/.ssh/cm-hpg -o ControlPersist=yes \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=10 "$U@hpg.rc.ufl.edu" || sleep 2
done
print "Connected. Thanks! This window closes by itself."
sleep 3
