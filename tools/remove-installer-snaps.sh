#!/usr/bin/env bash
# Remove the Ubuntu Server installer's "featured server snaps" from a bot box.
#
#   tools/remove-installer-snaps.sh            # remove them (asks sudo once)
#   tools/remove-installer-snaps.sh --dry-run  # say what would go, remove nothing
#
# bot-box2 was installed with most of the installer's optional snaps ticked:
# microk8s, Nextcloud, Rocket.Chat, Wekan, Prometheus, Mosquitto, SABnzbd and
# more. None of them does anything for the bot, and together they held about
# 3 GB of RAM and a steady share of the CPU that ffmpeg needs - a 1080p film
# was converting at 3.4x real time with the load average near 11 on 8 threads.
# SABnzbd also took port 8080 first, so the bot died on start with EADDRINUSE.
#
# Only the snaps named below are removed, and only if installed. The base
# snaps (core*, snapd, bare) and canonical-livepatch are left alone: they are
# Ubuntu's own plumbing, not installer extras. --purge skips the snapshot snapd
# would otherwise keep of each one's data, which is the point: nothing here
# holds anything the bot or the operator uses.
set -euo pipefail

SNAP=${SNAP_BIN:-snap}
DRY_RUN=0
for arg in "$@"; do
  case $arg in
    -n|--dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# microk8s first: it runs the most, and etcd and keepalived are its neighbours
# on the installer's list rather than its dependencies.
EXTRAS=(
  microk8s nextcloud rocketchat-server wekan sabnzbd prometheus mosquitto
  etcd keepalived lxd aws-cli doctl slcli powershell wormhole
  docker juju google-cloud-sdk heroku
)

# tools/bootstrap.sh asks this on every box, and a box without snapd is not
# an error: with set -e and pipefail, a missing `snap` used to end the script
# at the next line with exit 127 and nothing said.
command -v "$SNAP" >/dev/null 2>&1 || { echo "snap is not installed here - nothing to remove"; exit 0; }
installed=$("$SNAP" list 2>/dev/null | awk 'NR > 1 { print $1 }') \
  || { echo "snap list failed, so which snaps are installed cannot be told" >&2; exit 2; }
todo=()
for s in "${EXTRAS[@]}"; do
  grep -qx -- "$s" <<<"$installed" && todo+=("$s")
done

if (( ${#todo[@]} == 0 )); then
  echo "none of the installer's extra snaps is installed - nothing to remove"
  exit 0
fi

echo "installer snaps to remove: ${todo[*]}"
if (( DRY_RUN )); then
  for s in "${todo[@]}"; do echo "   would run: sudo $SNAP remove --purge $s"; done
  exit 0
fi

failed=()
for s in "${todo[@]}"; do
  echo "== removing $s"
  sudo "$SNAP" remove --purge "$s" || failed+=("$s")
done

if (( ${#failed[@]} )); then
  echo "could not remove: ${failed[*]} - run 'sudo snap remove --purge <name>' for each to see why" >&2
  exit 1
fi
echo "done: removed ${todo[*]}"
