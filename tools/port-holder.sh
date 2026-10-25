#!/usr/bin/env bash
# Which process holds a TCP port, and the command that would free it.
#
#   tools/port-holder.sh 8080
#
# exit 0: free, or held by whatsapp-bot.service itself
# exit 1: held by something else - it says what, and how to stop it
# exit 2: could not tell
#
# It never stops anything: what holds the port may be something the operator
# wants, and that is theirs to decide.
#
# Why: on the box built on 2026-09-29 the Ubuntu installer's "featured snaps"
# (sabnzbd, microk8s, nextcloud, rocketchat-server, wekan, prometheus,
# mosquitto and more) had been ticked, and SABnzbd sat on 8080, the panel's
# port. The bot died at start with EADDRINUSE, over and over - and a unit that
# crash-loops makes deploy/auto-update.sh take the newest commit back out, a
# good commit blamed for somebody else's port. tools/bootstrap.sh asks this
# before it starts the bot.
set -uo pipefail

PORT=${1:-}
PROC=${PORT_HOLDER_PROC:-/proc}
[[ $PORT =~ ^[0-9]+$ ]] || { echo "usage: $0 <port>" >&2; exit 2; }
command -v ss >/dev/null || { echo "ss (iproute2) is missing, so who holds port $PORT cannot be told"; exit 2; }

# Another user's process (a snap's service runs as root) shows its name and
# pid only to root, so sudo first, never waiting on a password.
# PORT_HOLDER_SUDO=0 does without: bootstrap.sh --dry-run runs no sudo at all.
if [[ ${PORT_HOLDER_SUDO:-1} == 0 ]] || ! lines=$(sudo -n ss -Hltnp "sport = :$PORT" 2>/dev/null); then
  lines=$(ss -Hltnp "sport = :$PORT" 2>/dev/null) || { echo "ss failed, so who holds port $PORT cannot be told"; exit 2; }
fi
if [[ -z ${lines//[[:space:]]/} ]]; then
  echo "port $PORT is free"
  exit 0
fi

pid=$(grep -oE 'pid=[0-9]+' <<<"$lines" | head -n1)
pid=${pid#pid=}
name=$(grep -oE '\(\("[^"]+"' <<<"$lines" | head -n1)
name=${name#((\"}
name=${name%\"}
if [[ -z $pid ]]; then
  echo "port $PORT is in use, by a process this user cannot see"
  echo "  see which:  sudo ss -ltnp 'sport = :$PORT'"
  exit 1
fi

# The unit it runs in, from its cgroup: a snap's services are
# snap.<snap>.<app>.service.
unit=$(grep -oE '[^/]+\.service' "$PROC/$pid/cgroup" 2>/dev/null | tail -n1)
if [[ $unit == whatsapp-bot.service ]]; then
  echo "port $PORT is held by the bot itself (whatsapp-bot.service, pid $pid)"
  exit 0
fi
if [[ $unit =~ ^snap\.([^.]+)\. ]]; then
  snap=${BASH_REMATCH[1]}
  echo "port $PORT is held by ${name:-pid $pid} (pid $pid), from the snap \"$snap\" ($unit)"
  echo "  stop it, and keep it off at boot:  sudo snap stop --disable $snap"
  echo "  or remove it:                      sudo snap remove $snap"
  # One of the Ubuntu installer's "featured snaps" is seldom alone: bot-box2
  # had fifteen, holding about 3 GB of RAM between them. The script that
  # removes them all is the better answer, so it is named when it applies.
  extras="$(dirname "${BASH_SOURCE[0]}")/remove-installer-snaps.sh"
  if [[ -f $extras ]] && sed -n '/^EXTRAS=(/,/^)/p' "$extras" | tr -s ' \t()' '\n' | grep -x -- "$snap" >/dev/null; then
    echo "  or remove every one of the installer's extra snaps:  tools/remove-installer-snaps.sh (--dry-run first)"
  fi
elif [[ -n $unit ]]; then
  echo "port $PORT is held by ${name:-pid $pid} (pid $pid), from $unit"
  echo "  stop it, and keep it off at boot:  sudo systemctl disable --now $unit"
else
  echo "port $PORT is held by ${name:-pid $pid} (pid $pid), started by hand rather than by a service"
  echo "  stop it:  sudo kill $pid"
fi
exit 1
