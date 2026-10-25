#!/usr/bin/env bash
# Set up the Linux side of a WSL bot box, from this checkout.
#
#   deploy/wsl-setup.sh [--dry-run] [--non-interactive] <piece>...
#
#   systemd     /etc/wsl.conf: [boot] systemd=true, every other line kept.
#               Takes effect when WSL restarts (wsl.exe --shutdown, from
#               Windows), which this never does: it would stop the bot.
#   vm-units    disable and stop what a distro cloned from the Hyper-V VM
#               brings that fights WSL (src/core/wsl.js, VM_UNITS)
#   ssh         sshd on port 2222 - Windows holds 22 in mirrored networking -
#               in sshd_config.d and in an ssh.socket drop-in
#   wslconfig   %UserProfile%\.wslconfig on the Windows side: [wsl2]
#               networkingMode=mirrored and vmIdleTimeout=-1, every other line
#               and the file's line endings kept. No sudo. Takes effect when
#               WSL restarts, which this never does.
#
#   --dry-run          print every action, change nothing
#   --non-interactive  sudo -n: fail rather than ask for a password
#                      (tools/routines.mjs --fix)
#
# The routines wsl-systemd, wsl-vm-units, tailscale-ssh (on WSL) and
# wsl-config in src/core/routines.js check what this sets up; tools/bootstrap.sh
# and node tools/routines.mjs --fix both run it. The one WSL piece it cannot
# do is on Windows: the scheduled task that starts WSL with Windows
# (wsl-autostart; node tools/wsl-config.mjs --autostart prints it).
#
# Every write compares first: running it again changes nothing.
#
# Exit: 0 done (or already in place), 1 failed, 2 usage, 4 not WSL.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=0
SUDO=(sudo)
PIECES=()

usage() { sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while (( $# )); do
  case $1 in
    -n|--dry-run) DRY_RUN=1 ;;
    --non-interactive) SUDO=(sudo -n) ;;
    -h|--help) usage; exit 0 ;;
    systemd|vm-units|ssh|wslconfig) PIECES+=("$1") ;;
    *) echo "wsl-setup: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
(( ${#PIECES[@]} )) || { usage >&2; exit 2; }
if [[ $EUID -eq 0 ]]; then
  echo "wsl-setup: run this as the bot's user, not root; it calls sudo itself" >&2
  exit 2
fi

info() { printf '   %s\n' "$*"; }
run() {
  printf '   + %s\n' "$(printf '%q ' "$@")"
  (( DRY_RUN )) && return 0
  "$@"
}

# Where the files really go: / on a box. WSL_SETUP_ROOT is for tests, as
# INSTALL_UNITS_ROOT is for deploy/install-units.sh.
ROOT=${WSL_SETUP_ROOT:-}
NODE_BIN=${NODE_BIN:-$(command -v node || echo "$HOME/.local/node/bin/node")}

if [[ -z ${WSL_SETUP_FORCE:-} ]] && ! grep -qi microsoft "$ROOT/proc/sys/kernel/osrelease" 2>/dev/null; then
  info "not WSL (the kernel's release does not name Microsoft): nothing to do"
  exit 4
fi

# Write stdin to a file, only if it would change it. With sudo for a root
# file, without for the user's own (.wslconfig on the Windows side).
WROTE=0
write_file() {
  local how=$1 mode=$2 dest=$3 content existing real
  real=$ROOT$dest
  content=$(cat; printf .)
  content=${content%.}
  WROTE=0
  if [[ -f $real ]]; then
    existing=$(cat -- "$real" 2>/dev/null; printf .)
    if [[ $existing == "$content." ]]; then info "= $dest is already up to date"; return 0; fi
  fi
  WROTE=1
  printf '   + write %s%s\n' "$dest" "$([[ $how == root ]] && echo " (mode $mode, owner root)")"
  (( DRY_RUN )) && return 0
  if [[ $how == root ]]; then
    "${SUDO[@]}" mkdir -p -- "$(dirname "$real")" || return 1
    printf '%s' "$content" | "${SUDO[@]}" tee -- "$real" >/dev/null || return 1
    "${SUDO[@]}" chown root:root -- "$real" || return 1
    "${SUDO[@]}" chmod "$mode" -- "$real" || return 1
  else
    # A copy of what was there first, once: .wslconfig is the operator's file.
    [[ -f $real && ! -f $real.before-wsl-setup ]] && cp -p -- "$real" "$real.before-wsl-setup"
    printf '%s' "$content" > "$real" || return 1
  fi
}

setup_systemd() {
  local text
  if [[ ! -x $NODE_BIN ]]; then
    # A fresh distro, before install.sh has put Node there. Ubuntu's own WSL
    # images already ask for systemd; one with no [boot] section at all gets
    # it appended, and anything else waits for Node.
    if grep -qiE '^[[:space:]]*systemd[[:space:]]*=[[:space:]]*true' "$ROOT/etc/wsl.conf" 2>/dev/null; then
      info "= /etc/wsl.conf already asks for systemd"; return 0
    fi
    if grep -qi '^[[:space:]]*\[boot\]' "$ROOT/etc/wsl.conf" 2>/dev/null; then
      echo "wsl-setup: /etc/wsl.conf has a [boot] section without systemd=true; run ./install.sh (Node), then this again" >&2
      return 1
    fi
    text=$(cat "$ROOT/etc/wsl.conf" 2>/dev/null; printf .)
    text=${text%.}
    [[ -z $text || $text == *$'\n' ]] || text+=$'\n'
    text+=$'[boot]\nsystemd=true\n.'
  else
    text=$("$NODE_BIN" "$APP_DIR/tools/wsl-config.mjs" --edit "$ROOT/etc/wsl.conf" boot.systemd=true; printf .) || return 1
  fi
  # printf, not <<<: a here-string adds a line ending of its own. And fed
  # with < <(...), not a pipe, so write_file runs in this shell and WROTE
  # reaches the line below.
  write_file root 644 /etc/wsl.conf < <(printf '%s' "${text%.}") || return 1
  if (( WROTE )); then
    info "systemd starts with WSL from its next start: from Windows, at a quiet moment, wsl.exe --shutdown (this stops the bot)"
  fi
}

setup_vm_units() {
  local unit en act any=0
  # src/core/wsl.js's VM_UNITS, which the check reads; test/wsl.test.mjs
  # holds the two lists together. Written out so this needs no Node.
  local units=(systemd-networkd.service systemd-networkd.socket systemd-networkd-wait-online.service
    networkd-dispatcher.service grow-root-disk.service eth0-no-offload.service open-vm-tools.service tailscaled.service)
  for unit in "${units[@]}"; do
    en=$(systemctl is-enabled "$unit" 2>/dev/null || true)
    act=$(systemctl is-active "$unit" 2>/dev/null || true)
    case $en in
      enabled|enabled-runtime|alias|linked|linked-runtime) ;;
      *) [[ $act == active ]] || continue ;;
    esac
    any=1
    run "${SUDO[@]}" systemctl disable --now "$unit" || return 1
  done
  (( any )) || info "= none of the VM's units is on"
}

setup_ssh() {
  local socket=ssh.socket changed=0
  command -v sshd >/dev/null || [[ -x /usr/sbin/sshd ]] || run "${SUDO[@]}" apt-get -o DPkg::Lock::Timeout=600 install -y openssh-server || return 1
  write_file root 644 /etc/ssh/sshd_config.d/10-wsl-port.conf \
    < <(printf '# WSL shares the Windows host ports (mirrored networking), and Windows holds 22.\nPort 2222\n') || return 1
  (( changed += WROTE )) || true
  # Ubuntu 24.04 starts sshd from ssh.socket, which listens where its own
  # unit says, not where sshd_config does: the empty ListenStream= clears 22.
  write_file root 644 "/etc/systemd/system/$socket.d/10-wsl-port.conf" \
    < <(printf '[Socket]\nListenStream=\nListenStream=0.0.0.0:2222\nListenStream=[::]:2222\n') || return 1
  (( changed += WROTE )) || true
  if (( changed )); then
    run "${SUDO[@]}" systemctl daemon-reload || return 1
    # Existing SSH sessions are their own processes and stay up.
    if systemctl is-enabled "$socket" >/dev/null 2>&1; then run "${SUDO[@]}" systemctl restart "$socket" || return 1
    else run "${SUDO[@]}" systemctl restart ssh || return 1; fi
  fi
  info "sshd on 2222: ssh -p 2222 $(id -un)@<the laptop's Tailscale name or LAN address>"
}

setup_wslconfig() {
  local home file text
  home=$("$NODE_BIN" "$APP_DIR/tools/wsl-config.mjs" --windows-home) || return 1
  file=$home/.wslconfig
  text=$("$NODE_BIN" "$APP_DIR/tools/wsl-config.mjs" --edit "$ROOT$file" wsl2.networkingMode=mirrored wsl2.vmIdleTimeout=-1; printf .) || return 1
  write_file user 644 "$file" < <(printf '%s' "${text%.}") || return 1
  if (( WROTE )); then
    info "WSL reads it when it next starts: from Windows, at a quiet moment, wsl.exe --shutdown (this stops the bot)"
  fi
}

rc=0
for piece in "${PIECES[@]}"; do
  r=0
  case $piece in
    systemd) setup_systemd || r=$? ;;
    vm-units) setup_vm_units || r=$? ;;
    ssh) setup_ssh || r=$? ;;
    wslconfig) setup_wslconfig || r=$? ;;
  esac
  (( r == 0 )) || rc=1
done
exit "$rc"
