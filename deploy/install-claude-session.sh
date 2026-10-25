#!/usr/bin/env bash
# Make the Claude Code session on this checkout come back after a reboot: a
# user unit starts it at boot in a detached tmux session named "claude", and
# an SSH login is told it is there (claude-attach opens it).
#
#   deploy/install-claude-session.sh               install, or bring an install up to date: tmux if it is
#                                                  missing, linger on, claude-session.service written and
#                                                  enabled at boot (NOT started), the ~/.bashrc hook
#   deploy/install-claude-session.sh --start-now   the same, then start the session now - which the launcher
#                                                  refuses while an interactive claude runs on this checkout
#   deploy/install-claude-session.sh --pin <id>    resume that conversation (claude --resume <id>) rather than
#                                                  the most recent one in the checkout (claude --continue)
#   deploy/install-claude-session.sh --unpin       back to the most recent one
#   deploy/install-claude-session.sh --status      what is in place; changes nothing (exit 1: something is not)
#   deploy/install-claude-session.sh --remove      disable and delete the unit, and take the hook out of
#                                                  ~/.bashrc; a session running now is left running
#
#   --dry-run          print every action, change nothing
#   --non-interactive  sudo -n: fail rather than wait for a password (tools/routines.mjs --fix)
#
# Run it as the user Claude Code runs as, not root: the unit, the hook and the
# conversations are that user's. It calls sudo for two things only: `loginctl
# enable-linger` and, when tmux is missing, apt-get.
#
# Why (the operator, 2026-09-30): "How do I set in the vm that this session
# ... should automatically resume after a reboot?" The session was `claude
# --resume <id>` typed into a plain SSH login, so a reboot ended it for good.
# deploy/claude-session.sh is what runs at boot, and says why it is built the
# way it is. The pieces here:
#   - linger: without it the user's systemd starts only at that user's first
#     login, so after a reboot nothing would start the session until somebody
#     SSHed in - and the login would find no session to attach to.
#   - ~/.config/systemd/user/claude-session.service, from `deploy/claude-session.sh
#     unit`, enabled at boot.
#   - the hook in ~/.bashrc, from `deploy/claude-session.sh hook`, between its
#     marker lines: an interactive SSH login is told about tmux session "claude"
#     when there is one, and nothing else is touched.
#
# It never starts the session unless asked to (--start-now), and
# tools/routines.mjs --fix never asks. The conversation to resume is usually
# running at that very moment in a plain SSH login - it was when this was
# written - and a second process on one conversation interleaves both into
# one transcript. Enabled, it starts at the next boot, when nothing else runs.
#
# Every write compares first: running it again changes nothing.
#
# Exit: 0 done (or already in place), 1 failed, 2 usage.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCHER=$APP_DIR/deploy/claude-session.sh
UNIT_NAME=claude-session.service
CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
UNIT_DIR=$CONFIG_HOME/systemd/user
UNIT_FILE=$UNIT_DIR/$UNIT_NAME
# What `systemctl --user enable` makes for WantedBy=default.target, and so
# what "enabled at boot" is, readable with no user bus to ask.
WANTS=$UNIT_DIR/default.target.wants/$UNIT_NAME
BASHRC=$HOME/.bashrc
PIN_FILE=${CLAUDE_SESSION_CONFIG:-$CONFIG_HOME/whatsapp-bot/claude-session.env}
CLAUDE_BIN=${CLAUDE_SESSION_BIN:-$HOME/.local/bin/claude}
# Where logind records linger, which any user may read. The tests point it
# elsewhere.
LINGER_DIR=${CLAUDE_SESSION_LINGER_DIR:-/var/lib/systemd/linger}
USER_NAME=$(id -un)
# systemctl --user finds the user's manager through XDG_RUNTIME_DIR, which a
# login sets and a bare `sudo -u` or cron does not.
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}

usage() { sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

MODE=install
DRY_RUN=0
START_NOW=0
SUDO=(sudo)
PIN=''
while (( $# )); do
  case $1 in
    -n|--dry-run) DRY_RUN=1 ;;
    --non-interactive) SUDO=(sudo -n) ;;
    --start-now) START_NOW=1 ;;
    --status) MODE=status ;;
    --remove) MODE=remove ;;
    --pin) MODE=pin; PIN=${2:-}; (( $# > 1 )) && shift ;;
    --unpin) MODE=unpin ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install-claude-session: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
if [[ $EUID -eq 0 ]]; then
  echo "install-claude-session: run this as the user Claude Code runs as, not root: it calls sudo itself" >&2
  exit 2
fi

info() { printf '   %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'install-claude-session: %s\n' "$*" >&2; exit 1; }
run() {
  printf '   + %s\n' "$(printf '%q ' "$@")"
  (( DRY_RUN )) && return 0
  "$@"
}

linger_on() {
  [[ $(loginctl show-user "$USER_NAME" -p Linger 2>/dev/null || true) == Linger=yes ]] || [[ -e $LINGER_DIR/$USER_NAME ]]
}
enabled() { [[ -e $WANTS || -L $WANTS ]]; }
session_exists() { command -v tmux >/dev/null && tmux has-session -t =claude 2>/dev/null; }

# The hook as the launcher prints it; its first and last lines are the
# markers it is found by.
HOOK=''
HOOK_BEGIN=''
HOOK_END=''
load_hook() {
  HOOK=$(bash "$LAUNCHER" hook) || die "deploy/claude-session.sh hook failed"
  HOOK_BEGIN=${HOOK%%$'\n'*}
  HOOK_END=${HOOK##*$'\n'}
}

# ~/.bashrc with the hook's block taken out (and the blank line put before
# it), on stdout. Fails on a begin marker with no end after it: the rest of
# the file would look like the block, and would go with it. The markers go
# in through the environment: awk -v would read backslashes in them.
without_hook() {
  B=$HOOK_BEGIN E=$HOOK_END awk '
    { lines[NR] = $0 }
    END {
      b = ENVIRON["B"]; e = ENVIRON["E"]; open = 0
      for (i = 1; i <= NR; i++) {
        if (lines[i] == b) { if (open) exit 3; open = 1; start[i] = 1; continue }
        if (lines[i] == e) { if (!open) exit 3; open = 0 }
      }
      if (open) exit 3
      skip = 0
      for (i = 1; i <= NR; i++) {
        if (start[i]) { skip = 1; continue }
        if (skip) { if (lines[i] == e) skip = 0; continue }
        if (lines[i] == "" && start[i + 1]) continue
        print lines[i]
      }
    }' "$RC"
}

# ~/.bashrc with its (first) block replaced by the current hook, where it
# was; any later copy of the block goes.
with_hook_replaced() {
  B=$HOOK_BEGIN E=$HOOK_END H=$HOOK awk '
    $0 == ENVIRON["B"] { if (!done) print ENVIRON["H"]; done = 1; skip = 1; next }
    skip { if ($0 == ENVIRON["E"]) skip = 0; next }
    { print }' "$RC"
}

# The file the hook goes in: ~/.bashrc, or what it links to (a dotfiles
# checkout), which a rename over the link would otherwise cut loose.
RC=$BASHRC
resolve_rc() { if [[ -L $BASHRC ]]; then RC=$(readlink -f -- "$BASHRC"); else RC=$BASHRC; fi; }

has_hook_block() { [[ -f $RC ]] && grep -qxF -- "$HOOK_BEGIN" "$RC"; }
hook_current() { [[ -f $RC ]] && [[ $(cat -- "$RC") == *"$HOOK"* ]]; }

# Write stdin to $1 when it would change it. Sets WROTE.
WROTE=0
write_file() {
  local dest=$1 mode=$2 content existing
  content=$(cat; printf .)
  content=${content%.}
  WROTE=0
  if [[ -f $dest ]]; then
    existing=$(cat -- "$dest"; printf .)
    if [[ $existing == "$content." ]]; then info "= $dest is up to date"; return 0; fi
  fi
  WROTE=1
  printf '   + write %s (mode %s)\n' "$dest" "$mode"
  (( DRY_RUN )) && return 0
  mkdir -p -- "$(dirname -- "$dest")"
  local tmp="$dest.tmp.$$"
  printf '%s' "$content" > "$tmp"
  chmod "$mode" -- "$tmp"
  mv -f -- "$tmp" "$dest"
}

install_hook() {
  local new mode=644
  load_hook
  resolve_rc
  if [[ -f $RC ]]; then
    mode=$(stat -c %a -- "$RC" 2>/dev/null || echo 644)
    if has_hook_block; then
      without_hook >/dev/null || die "$RC has \"$HOOK_BEGIN\" with no \"$HOOK_END\" after it: put that right by hand, then run this again"
      if hook_current && [[ $(grep -cxF -- "$HOOK_BEGIN" "$RC") == 1 ]]; then
        info "= the hook in $RC is up to date"
        return 0
      fi
      # An older hook: the new one takes its place, where it was.
      new=$(with_hook_replaced)
    else
      new="$(cat -- "$RC")"$'\n\n'"$HOOK"
    fi
  else
    new=$HOOK
  fi
  write_file "$RC" "$mode" <<<"$new"
}

remove_hook() {
  local new mode
  load_hook
  resolve_rc
  has_hook_block || { info "= no hook in $RC"; return 0; }
  new=$(without_hook) || die "$RC has \"$HOOK_BEGIN\" with no \"$HOOK_END\" after it: take it out by hand"
  mode=$(stat -c %a -- "$RC" 2>/dev/null || echo 644)
  write_file "$RC" "$mode" <<<"$new"
}

# ----------------------------------------------------------------- modes ---

do_status() {
  local missing=0 unit
  load_hook
  resolve_rc
  if command -v tmux >/dev/null; then info "tmux: $(tmux -V)"; else info "tmux: NOT installed"; missing=1; fi
  if [[ -x $CLAUDE_BIN ]]; then info "Claude Code: $CLAUDE_BIN"; else info "Claude Code: NOT at $CLAUDE_BIN"; fi
  if linger_on; then info "linger: on for $USER_NAME"; else info "linger: OFF for $USER_NAME (after a reboot, nothing starts the session)"; missing=1; fi
  unit=$(bash "$LAUNCHER" unit 2>/dev/null || true)
  if [[ ! -f $UNIT_FILE ]]; then info "unit: $UNIT_FILE is NOT there"; missing=1
  elif [[ $(cat -- "$UNIT_FILE") != "$unit" ]]; then info "unit: $UNIT_FILE DIFFERS from what this checkout writes"; missing=1
  else info "unit: $UNIT_FILE"
  fi
  if enabled; then info "at boot: enabled"; else info "at boot: NOT enabled"; missing=1; fi
  if hook_current; then info "SSH login: told about the session, claude-attach opens it (the hook in $RC)"
  elif has_hook_block; then info "SSH login: the hook in $RC DIFFERS from this checkout's"; missing=1
  else info "SSH login: NOT told about the session, no claude-attach (no hook in $RC)"; missing=1
  fi
  bash "$LAUNCHER" status | sed 's/^/   /'
  return "$missing"
}

do_pin() {
  [[ $PIN =~ ^[A-Za-z0-9][A-Za-z0-9-]{7,63}$ ]] || { echo "install-claude-session: --pin takes a session id (as in claude --resume <id>)" >&2; exit 2; }
  if ! compgen -G "$HOME/.claude/projects/*/$PIN.jsonl" >/dev/null; then
    warn "no conversation $PIN under ~/.claude/projects on this box: pinned all the same, but the session will fail to start until there is"
  fi
  write_file "$PIN_FILE" 600 <<EOF
# deploy/install-claude-session.sh --pin: the conversation claude-session.service
# resumes at boot (claude --resume <id>). --unpin goes back to the most recent one.
CLAUDE_SESSION_ID=$PIN
EOF
  (( DRY_RUN )) || chmod 700 -- "$(dirname -- "$PIN_FILE")" 2>/dev/null || true
  info "at the next start, the session resumes conversation $PIN"
}

do_unpin() {
  if [[ -f $PIN_FILE ]]; then run rm -f -- "$PIN_FILE"; else info "= nothing is pinned"; fi
  info "at the next start, the session resumes the most recent conversation in $APP_DIR (claude --continue)"
}

do_remove() {
  if enabled; then
    run systemctl --user disable "$UNIT_NAME" || true
    if (( ! DRY_RUN )) && enabled; then run rm -f -- "$WANTS"; fi
  else
    info "= not enabled at boot"
  fi
  if [[ -f $UNIT_FILE ]]; then
    run rm -f -- "$UNIT_FILE"
    run systemctl --user daemon-reload || warn "systemctl --user daemon-reload failed: the user manager forgets the unit at its next start"
  else
    info "= $UNIT_FILE is not there"
  fi
  remove_hook
  # What --remove leaves, each for a reason: ending the session could end
  # the very one that runs this; linger is harmless on its own; the pin is a
  # choice somebody made.
  info "left as it is: a session running now ($(session_exists && echo 'tmux kill-session -t claude ends it' || echo 'none runs')), linger (sudo loginctl disable-linger $USER_NAME), and the pin, if any ($PIN_FILE)"
}

do_install() {
  local unit
  printf 'The Claude session for %s: tmux session "claude", back after every reboot\n' "$APP_DIR"
  (( DRY_RUN )) && info "DRY RUN: every action is printed, and nothing is changed"

  if command -v tmux >/dev/null; then
    info "= tmux is installed ($(tmux -V))"
  else
    run "${SUDO[@]}" apt-get -o DPkg::Lock::Timeout=600 install -y tmux || die "installing tmux failed"
  fi
  if [[ -x $CLAUDE_BIN ]]; then
    info "= Claude Code is at $CLAUDE_BIN"
  else
    warn "Claude Code is not at $CLAUDE_BIN yet: the session cannot start until it is (curl -fsSL https://claude.ai/install.sh | bash)"
  fi

  if linger_on; then
    info "= linger is on for $USER_NAME"
  else
    run "${SUDO[@]}" loginctl enable-linger "$USER_NAME" || die "loginctl enable-linger failed (it needs sudo)"
  fi

  unit=$(bash "$LAUNCHER" unit) || die "writing the unit for $APP_DIR failed (see above)"
  write_file "$UNIT_FILE" 644 <<<"$unit"
  if (( WROTE )); then
    run systemctl --user daemon-reload || warn "systemctl --user daemon-reload failed (no user manager to reach?): it reads the unit when it starts"
  fi

  if enabled; then
    info "= $UNIT_NAME is enabled at boot"
  else
    run systemctl --user enable "$UNIT_NAME" || warn "enabling it through the user manager failed: linking it by hand"
    # What enable makes, made by hand where no user manager answered.
    if (( ! DRY_RUN )) && ! enabled; then
      run mkdir -p -- "$(dirname -- "$WANTS")"
      run ln -sfn -- "$UNIT_FILE" "$WANTS"
    fi
  fi

  install_hook

  if (( ! START_NOW )); then
    info "not started now: it starts at the next boot. To start it before then, once no other claude runs on this checkout: $0 --start-now"
    return 0
  fi
  if session_exists; then
    info "= the session is running already: tmux attach -t claude"
    return 0
  fi
  # restart, not start: a unit whose claude has since exited is still
  # "active (exited)", and start would do nothing. Its stop half ends no
  # session, since there is none.
  run systemctl --user restart "$UNIT_NAME" || die "systemctl --user restart $UNIT_NAME failed: journalctl --user -u claude-session"
  (( DRY_RUN )) || bash "$LAUNCHER" status | sed 's/^/   /'
}

case $MODE in
  install) do_install ;;
  status) do_status ;;
  remove) do_remove ;;
  pin) do_pin ;;
  unpin) do_unpin ;;
esac
