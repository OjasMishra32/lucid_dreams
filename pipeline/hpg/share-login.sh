#!/bin/zsh
# Lets Vishal log in to HiPerGator on this Mac from anywhere, without getting a shell here: an upterm session that
# only his GitHub SSH keys can join (or KEYS=<authorized_keys file>), where each guest gets nothing but
# hpg-master.sh, with no file transfer. The session ends by itself once the connection is up.
#   zsh pipeline/hpg/share-login.sh        then send Vishal the ssh command it prints
cd "${0:A:h}/../.."
REPO=$PWD
upterm session stop hpg-login >/dev/null 2>&1
upterm host --detach --accept --no-sftp --skip-host-key-check --name hpg-login --join-timeout 3h \
  --authorized-user "github:${GITHUB_USER:-vishal-naveen}" ${KEYS:+--authorized-keys "$KEYS"} \
  --force-command "zsh $REPO/pipeline/hpg/hpg-master.sh" \
  -- zsh -c 'until ssh -O check -o ControlPath=~/.ssh/cm-hpg hpg >/dev/null 2>&1; do sleep 5; done; sleep 15' || exit 1
print "\nSend Vishal this (he runs it in his own terminal):"
upterm session info hpg-login -o json | python3 -c 'import json,sys; print("  " + json.load(sys.stdin)["sshCommand"])'
