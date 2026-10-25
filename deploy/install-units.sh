#!/usr/bin/env bash
# Install the systemd pieces a bot box needs, from this checkout.
#
#   deploy/install-units.sh [--dry-run] [--non-interactive] [--node <path>] <piece>...
#
#   whatsapp-bot     whatsapp-bot.service, rendered for this machine by
#                    deploy/render-whatsapp-bot-unit.sh. Installed and
#                    daemon-reloaded, and NEVER enabled or started: whether
#                    this box may run the bot is somebody's decision (CLAUDE.md,
#                    rule 3), and tools/bootstrap.sh asks it.
#   grow-root-disk   /usr/local/sbin/grow-root-disk and grow-root-disk.service,
#                    enabled at boot. Not run: tools/bootstrap.sh runs it once.
#   nic-offload      on a Hyper-V NIC (hv_netvsc): TCP segmentation offload
#                    off now, and <nic>-no-offload.service to turn it off at
#                    every boot. Anywhere else it does nothing and exits 4.
#                    On WSL grow-root-disk does nothing (exit 4); the NIC fix
#                    applies there too - WSL's NIC is hv_netvsc with the same fault.
#
#   --dry-run          print every action, change nothing
#   --non-interactive  sudo -n: fail rather than ask for a password
#                      (tools/routines.mjs --fix, which may run with nobody
#                      at the terminal)
#   --node <path>      the node the unit runs. Default: the one the installed
#                      unit already runs, so a re-render never switches the
#                      bot's node under it; else the one on PATH.
#
# tools/bootstrap.sh and tools/routines.mjs --fix both install these through
# this one script, so a box rebuilt from nothing and a box brought up to date
# by a new Claude session get the same files. Before it, bootstrap wrote them
# inline and the docs repeated the commands by hand - and bot-box ended up
# with the offload turned off by hand and no unit to turn it off again after
# a reboot, which puts uploads back at 1.5 Mbit/s.
#
# Every write compares first: running it again changes nothing, and a unit
# that is already right is not reloaded.
#
# Exit: 0 done (or already in place), 1 failed, 2 usage, 4 not applicable here.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$APP_DIR/deploy"
DRY_RUN=0
SUDO=(sudo)
NODE_BIN=''
PIECES=()

usage() { sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while (( $# )); do
  case $1 in
    -n|--dry-run) DRY_RUN=1 ;;
    --non-interactive) SUDO=(sudo -n) ;;
    --node) shift; NODE_BIN=${1:-} ;;
    -h|--help) usage; exit 0 ;;
    whatsapp-bot|grow-root-disk|nic-offload) PIECES+=("$1") ;;
    *) echo "install-units: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
(( ${#PIECES[@]} )) || { usage >&2; exit 2; }
if [[ $EUID -eq 0 ]]; then
  echo "install-units: run this as the bot's user, not root; it calls sudo itself" >&2
  exit 2
fi

info() { printf '   %s\n' "$*"; }
run() {
  printf '   + %s\n' "$(printf '%q ' "$@")"
  (( DRY_RUN )) && return 0
  "$@"
}

# Where the files really go: / on a box. INSTALL_UNITS_ROOT is for tests. The
# dry run in test/sealed-backup.test.mjs stubs every command, but this script
# read the real /etc/systemd/system/whatsapp-bot.service to decide whether to
# write it, so on a box that already had the unit (bot-box2, and the hourly
# check's own runs there) it said "already up to date" and the suite failed.
ROOT=${INSTALL_UNITS_ROOT:-}

# Write stdin to a root-owned file, but only if it would change it. Sets
# WROTE=1 when it did (or, in a dry run, would have). `dest` is the path as
# printed; the file read and written is $ROOT$dest.
WROTE=0
write_root_file() {
  local mode=$1 dest=$2 content existing real
  real=$ROOT$dest
  content=$(cat; printf .)
  content=${content%.}
  WROTE=0
  if [[ -f $real ]]; then
    existing=$(cat -- "$real" 2>/dev/null; printf .)
    if [[ $existing == "$content." ]]; then
      info "= $dest is already up to date"
      return 0
    fi
  fi
  WROTE=1
  printf '   + write %s (mode %s, owner root)\n' "$dest" "$mode"
  (( DRY_RUN )) && return 0
  # Checked one by one: each piece is run under `|| r=$?` below, which
  # switches set -e off inside it.
  printf '%s' "$content" | "${SUDO[@]}" tee -- "$real" >/dev/null || return 1
  "${SUDO[@]}" chown root:root -- "$real" || return 1
  "${SUDO[@]}" chmod "$mode" -- "$real" || return 1
}

unit_enabled() { [[ $(systemctl is-enabled "$1" 2>/dev/null || true) == enabled ]]; }
enable_unit() {
  if unit_enabled "$1"; then info "= $1 is already enabled"; else run "${SUDO[@]}" systemctl enable "$1"; fi
}

install_whatsapp_bot() {
  local node=$NODE_BIN unit
  if [[ -z $node ]]; then
    # The installed unit's node first: on bot-box that is ~/.local/node, while
    # PATH may find another. Re-rendering must not change what the bot runs on.
    node=$(systemctl show -p ExecStart --value whatsapp-bot.service 2>/dev/null | sed -n 's/^{ path=\([^ ;]*\).*/\1/p' || true)
    [[ -n $node && -x $node ]] || node=$(command -v node || true)
    [[ -n $node ]] || node=$HOME/.local/node/bin/node
  fi
  unit=$(bash "$DEPLOY/render-whatsapp-bot-unit.sh" "$(id -un)" "$(id -gn)" "$APP_DIR" "$node") || return 1
  [[ $unit == *"ExecStart=$node src/index.js"* ]] || { echo "install-units: rendering whatsapp-bot.service failed" >&2; return 1; }
  write_root_file 644 /etc/systemd/system/whatsapp-bot.service <<<"$unit" || return 1
  if (( WROTE )); then run "${SUDO[@]}" systemctl daemon-reload || return 1; fi
  info "whatsapp-bot.service runs $node from $APP_DIR (installed only: never enabled or started from here)"
}

# WSL (the bot on the laptop, 2026-09-29): its disk is a VHDX Windows
# manages and its NIC is WSL's, so neither Hyper-V piece belongs there - and
# WSL's eth0 can use hv_netvsc too, which the NIC check alone took for the VM's.
is_wsl() { grep -qi microsoft "$ROOT/proc/sys/kernel/osrelease" 2>/dev/null; }

install_grow_root_disk() {
  local changed=0
  if is_wsl; then info "WSL: / is a VHDX Windows manages - grow-root-disk not needed"; return 4; fi
  write_root_file 755 /usr/local/sbin/grow-root-disk < "$DEPLOY/grow-root-disk" || return 1
  (( changed += WROTE )) || true
  write_root_file 644 /etc/systemd/system/grow-root-disk.service < "$DEPLOY/grow-root-disk.service" || return 1
  (( changed += WROTE )) || true
  if (( changed )); then run "${SUDO[@]}" systemctl daemon-reload || return 1; fi
  enable_unit grow-root-disk.service || return 1
}

install_nic_offload() {
  local iface driver ethtool unit
  # Not exempt on WSL: its mirrored NIC is hv_netvsc too, and on 2026-09-30
  # uploads from WSL ran at 162 KB/s until tso/gso were turned off on eth1,
  # then at 5,176 KB/s. The default-route NIC is used, so eth1 there, not eth0.
  iface=$(ip route show default 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}' || true)
  driver=''
  if [[ -n $iface ]]; then
    driver=$(basename "$(readlink -f "/sys/class/net/$iface/device/driver" 2>/dev/null || true)" 2>/dev/null || true)
  fi
  if [[ $driver != hv_netvsc ]]; then
    info "NIC ${iface:-unknown} uses driver ${driver:-unknown}, not hv_netvsc: offload fix not needed"
    return 4
  fi
  # Offload on gave 29% TCP retransmits and 1.5 Mbit/s uploads here; off gave
  # 86 Mbit/s. See deploy/eth0-no-offload.service.
  ethtool=$(command -v ethtool || echo /usr/sbin/ethtool)
  run "${SUDO[@]}" "$ethtool" -K "$iface" tso off gso off || return 1
  unit=$(sed -e "s#/usr/sbin/ethtool#$ethtool#g" -e "s#eth0#$iface#g" "$DEPLOY/eth0-no-offload.service")
  [[ -n $unit ]] || { echo "install-units: could not render $DEPLOY/eth0-no-offload.service" >&2; return 1; }
  write_root_file 644 "/etc/systemd/system/$iface-no-offload.service" <<<"$unit" || return 1
  if (( WROTE )); then run "${SUDO[@]}" systemctl daemon-reload || return 1; fi
  enable_unit "$iface-no-offload.service" || return 1
  info "$iface offload off, and turned off again at every boot by $iface-no-offload.service"
}

rc=0
for piece in "${PIECES[@]}"; do
  r=0
  case $piece in
    whatsapp-bot) install_whatsapp_bot || r=$? ;;
    grow-root-disk) install_grow_root_disk || r=$? ;;
    nic-offload) install_nic_offload || r=$? ;;
  esac
  # A piece that does not apply here (4) is only the answer when it was the
  # only one asked for; a failure anywhere wins.
  if (( r == 4 )); then (( rc == 0 && ${#PIECES[@]} == 1 )) && rc=4
  elif (( r != 0 )); then rc=1
  fi
done
exit "$rc"
