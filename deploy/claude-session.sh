#!/usr/bin/env bash
# The Claude Code session on this checkout, held in a detached tmux session
# named "claude", so that it comes back after a reboot and an SSH login lands
# in it. deploy/install-claude-session.sh installs what runs this.
#
#   deploy/claude-session.sh start    claude-session.service's ExecStart: wait for the network, then run
#                                     `claude --continue` (or --resume <the pinned id>) in tmux session
#                                     "claude" - unless that session is there already, or an interactive
#                                     claude already runs on this checkout
#   deploy/claude-session.sh stop     its ExecStop: end tmux session "claude", and no other
#   deploy/claude-session.sh status   whether it runs, what it resumes, and what would stop a start now
#   deploy/claude-session.sh unit     print the user unit for this checkout
#   deploy/claude-session.sh hook     print the ~/.bashrc hook that attaches an SSH login to it
#
# Why (the operator, 2026-09-30): "How do I set in the vm that this session
# ... should automatically resume after a reboot?" The session ran as `claude
# --resume <id>` typed into a plain SSH login, so every reboot ended it and
# nothing brought it back. Claude Code has no resume-after-reboot of its own;
# what it has is `--continue` (the most recent conversation in the current
# directory, the permission mode it had included) and `--resume <id>`. So a
# user unit starts one of those at boot, inside tmux, where it has a terminal
# and outlives every login.
#
# The one thing it must never do is start a second process on a conversation
# that a process already holds: two processes on one conversation write into
# one transcript with no lock between them, and their messages interleave. So
# nothing starts while tmux session "claude" exists, nor while an interactive
# claude runs with its working directory in this checkout (or, with a pinned
# id, anywhere with that id on its command line). Print-mode ones (-p,
# --print) are not in the way: interactive --continue passes over their
# conversations, and the hourly check's research session is one, in its own
# clone.
#
# Settings, each optional:
#   ~/.config/whatsapp-bot/claude-session.env   CLAUDE_SESSION_ID=<id> pins the conversation
#                                                (deploy/install-claude-session.sh --pin <id>); a
#                                                CLAUDE_SESSION_ID in the unit's environment (a drop-in)
#                                                wins over the file
# and, for the tests: CLAUDE_SESSION_BIN, CLAUDE_SESSION_PROC, CLAUDE_SESSION_NET_WAIT,
# CLAUDE_SESSION_NET_HOST, CLAUDE_SESSION_CONFIG, CLAUDE_SESSION_LOG.
#
# Every decision `start` makes is one line on stdout (the unit's journal:
# journalctl --user -u claude-session) and in
# ~/.local/state/whatsapp-bot/claude-session.log, whose last line the
# claude-session routine reports.
#
# Exit: 0 done, or nothing to do (a start refused on purpose is 0 too); 1
# failed; 2 usage.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SESSION=claude
# '=' makes tmux take the name exactly: "-t claude" alone would also match a
# session called "claude-notes" when there is no "claude".
TARGET="=$SESSION"
CLAUDE_BIN=${CLAUDE_SESSION_BIN:-$HOME/.local/bin/claude}
PROC=${CLAUDE_SESSION_PROC:-/proc}
NET_WAIT=${CLAUDE_SESSION_NET_WAIT:-120}
NET_HOST=${CLAUDE_SESSION_NET_HOST:-api.anthropic.com}
CONFIG=${CLAUDE_SESSION_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/whatsapp-bot/claude-session.env}
LOG=${CLAUDE_SESSION_LOG:-${XDG_STATE_HOME:-$HOME/.local/state}/whatsapp-bot/claude-session.log}
HOOK_BEGIN='# >>> whatsapp-bot: claude-session >>>'
HOOK_END='# <<< whatsapp-bot: claude-session <<<'

usage() { sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

log() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  printf '%s\n' "$line"
  { mkdir -p -- "${LOG%/*}" && printf '%s\n' "$line" >> "$LOG"; } 2>/dev/null || return 0
  # Kept short: it is a record of what each boot did, not a debug log.
  if (( $(wc -l < "$LOG" 2>/dev/null || echo 0) > 400 )); then
    { tail -n 200 -- "$LOG" > "$LOG.tmp" && mv -f -- "$LOG.tmp" "$LOG"; } 2>/dev/null || true
  fi
}

valid_id() { [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9-]{7,63}$ ]]; }

# The pinned conversation, or nothing. Read, never sourced: the file is
# settings, and nothing in it is run. The whole value is taken and then
# checked, so that one which is not an id is refused rather than cut down
# to something that looks like one.
PINNED=''
read_pin() {
  local line=''
  PINNED=${CLAUDE_SESSION_ID:-}
  if [[ -z $PINNED && -r $CONFIG ]]; then
    line=$(grep -E '^[[:space:]]*(export[[:space:]]+)?CLAUDE_SESSION_ID=' -- "$CONFIG" | tail -n 1 || true)
    PINNED=${line#*=}
    PINNED=${PINNED%"${PINNED##*[![:space:]]}"}
    if [[ $PINNED =~ ^\"(.*)\"$ || $PINNED =~ ^\'(.*)\'$ ]]; then PINNED=${BASH_REMATCH[1]}; fi
  fi
  [[ -z $PINNED ]] || valid_id "$PINNED"
}

session_exists() { tmux has-session -t "$TARGET" 2>/dev/null; }

# Whether a process is Claude Code: the native binary (comm "claude"), one
# started by a path ending in claude, or an npm install run by node.
is_claude() {
  local comm=$1 a0=${2##*/}
  [[ $comm == claude || $a0 == claude ]] && return 0
  [[ $a0 == node* && ${3:-} == *@anthropic-ai/claude-code/* ]]
}
is_print() {
  local a
  for a in "$@"; do [[ $a == -p || $a == --print ]] && return 0; done
  return 1
}

# Every interactive claude of this user that holds a conversation this start
# could resume: one working in this checkout, or one with the pinned id on
# its command line. One line each.
blockers() {
  local id=$1 d comm cwd real a hit
  local -a argv
  real=$(realpath -- "$APP_DIR" 2>/dev/null || printf '%s' "$APP_DIR")
  for d in "$PROC"/[0-9]*; do
    [[ -O $d ]] || continue
    { read -r comm < "$d/comm"; } 2>/dev/null || continue
    argv=()
    mapfile -d '' -t argv < "$d/cmdline" 2>/dev/null || continue
    (( ${#argv[@]} )) || continue
    is_claude "$comm" "${argv[@]}" || continue
    is_print "${argv[@]}" && continue
    cwd=$(readlink -- "$d/cwd" 2>/dev/null) || cwd=''
    cwd=${cwd% (deleted)}
    hit=0
    if [[ -n $cwd ]]; then
      for a in "$real" "$APP_DIR"; do [[ $cwd == "$a" || $cwd == "$a"/* ]] && hit=1; done
    fi
    if [[ -n $id ]]; then
      for a in "${argv[@]}"; do [[ $a == *"$id"* ]] && hit=1; done
    fi
    (( hit )) || continue
    a="${argv[*]}"
    printf 'pid %s: %s (in %s)\n' "${d##*/}" "${a:0:160}" "${cwd:-a directory that cannot be read}"
  done
  return 0
}

# Whether a start may go ahead now. Says why not.
may_start() {
  local b line
  if session_exists; then
    log "tmux session \"$SESSION\" is there already: nothing started (tmux attach -t $SESSION)"
    return 1
  fi
  b=$(blockers "$PINNED")
  if [[ -n $b ]]; then
    log "not started: Claude Code already runs on this conversation, and a second process on it would interleave both into one transcript:"
    while IFS= read -r line; do log "  $line"; done <<<"$b"
    return 1
  fi
}

# At boot a user unit can start before the network is up, and user units
# cannot wait for network-online.target, which is the system manager's. So
# the start waits here, a bounded while, for the name Claude Code talks to.
wait_for_network() {
  local waited=0
  while ! getent ahosts "$NET_HOST" >/dev/null 2>&1; do
    if (( waited >= NET_WAIT )); then
      log "$NET_HOST still does not resolve after ${NET_WAIT}s: starting all the same (the conversation is on disk, and Claude Code tries the network again when it is asked something)"
      return 0
    fi
    (( waited )) || log "waiting up to ${NET_WAIT}s for the network ($NET_HOST)"
    sleep 2
    waited=$((waited + 2))
  done
}

cmd_start() {
  # One start at a time: the unit at boot and a --start-now by hand.
  local rundir=${XDG_RUNTIME_DIR:-/tmp}
  if command -v flock >/dev/null && [[ -d $rundir && -w $rundir ]] && exec 9>"$rundir/claude-session-$(id -u).lock" && ! flock -n 9; then
    log "another start is under way: nothing done"
    return 0
  fi
  command -v tmux >/dev/null || { log "not started: tmux is not installed (sudo apt-get install -y tmux)"; return 1; }
  [[ -x $CLAUDE_BIN ]] || { log "not started: Claude Code is not at $CLAUDE_BIN (curl -fsSL https://claude.ai/install.sh | bash)"; return 1; }
  if ! read_pin; then
    # Resuming "the most recent one" instead would pick a conversation
    # nobody chose.
    log "not started: CLAUDE_SESSION_ID in $CONFIG is not a session id (deploy/install-claude-session.sh --pin <id>, or --unpin)"
    return 1
  fi
  may_start || return 0
  wait_for_network
  # Again: something may have started in the meantime.
  may_start || return 0

  local -a args=(--continue)
  [[ -n $PINNED ]] && args=(--resume "$PINNED")
  # A login shell, so PATH gets what /etc/profile.d and ~/.profile add (on
  # WSL, /usr/lib/wsl/lib for the GPU), and exec, so claude itself is the
  # pane's process. Its arguments go in as arguments, never pasted into the
  # script text.
  if ! tmux new-session -d -s "$SESSION" -c "$APP_DIR" \
      bash -lc 'cd -- "$1" && shift && exec "$@"' claude-session "$APP_DIR" "$CLAUDE_BIN" "${args[@]}"; then
    log "not started: tmux new-session failed"
    return 1
  fi
  # A claude that exits with an error at once (no conversation here to
  # continue, a login that expired) would otherwise take its message with
  # it: the pane stays, showing it, for whoever attaches. /exit (status 0)
  # still ends the session.
  tmux set-option -w -t "$TARGET:" remain-on-exit failed >/dev/null 2>&1 \
    || log "note: could not keep a failed start on screen (tmux set-option remain-on-exit failed)"
  log "started: $CLAUDE_BIN ${args[*]} in $APP_DIR, in tmux session \"$SESSION\" (tmux attach -t $SESSION)"
}

cmd_stop() {
  if session_exists; then
    tmux kill-session -t "$TARGET" || true
    log "stopped: tmux session \"$SESSION\" ended"
  fi
  return 0
}

cmd_status() {
  local b
  if session_exists; then echo "running: tmux session \"$SESSION\" (tmux attach -t $SESSION)"; else echo "not running: no tmux session \"$SESSION\""; fi
  if ! read_pin; then echo "resumes: nothing - CLAUDE_SESSION_ID in $CONFIG is not a session id"
  elif [[ -n $PINNED ]]; then echo "resumes: conversation $PINNED (pinned in $CONFIG)"
  else echo "resumes: the most recent conversation in $APP_DIR (claude --continue)"
  fi
  b=$(blockers "$PINNED")
  if [[ -n $b ]]; then
    echo "interactive Claude Code on this conversation now (a start refuses while one runs; the session's own counts):"
    while IFS= read -r line; do echo "  $line"; done <<<"$b"
  fi
  if [[ -s $LOG ]]; then echo "last: $(tail -n 1 -- "$LOG")"; fi
  return 0
}

# systemd reads % as a specifier and quotes and spaces as syntax: a path with
# any of them would be a different ExecStart than it looks.
check_path() {
  [[ $APP_DIR =~ ^[A-Za-z0-9._/@+-]+$ ]] && return 0
  echo "claude-session: $APP_DIR has a character a unit's ExecStart would misread (only letters, digits and . _ / @ + - are safe)" >&2
  return 1
}

# Type=oneshot with RemainAfterExit, not Type=forking: `start` may rightly
# start nothing (the session is there, or a claude already runs), and exits
# 0 either way - which under forking would read as a daemon that died. The
# tmux server it forks stays in the unit's cgroup, and the unit stays active.
# KillMode=process: stopping the unit ends tmux session "claude" (ExecStop)
# and nothing else; with the default, systemd would also kill the tmux server
# and every other session somebody has opened in it. No Restart=: a session
# ended with /exit stays ended until the next boot.
cmd_unit() {
  check_path || return 1
  cat <<EOF
# Written by deploy/install-claude-session.sh, from the checkout below;
# its --remove takes it out. The why is in deploy/claude-session.sh.
[Unit]
Description=Claude Code session on $APP_DIR, in tmux session "$SESSION"
Documentation=file://$APP_DIR/docs/operations.md

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/bash $APP_DIR/deploy/claude-session.sh start
ExecStop=/bin/bash $APP_DIR/deploy/claude-session.sh stop
KillMode=process
TimeoutStartSec=300

[Install]
WantedBy=default.target
EOF
}

# Only an interactive shell on an SSH terminal attaches: SSH_TTY is set only
# when ssh gave the login a terminal, $- has "i" only in an interactive
# shell, and both ends must be terminals. scp, rsync, `ssh host cmd` (with
# -t too), the Claude desktop app's and the hourly check's commands have
# none of that, and pass straight through. Not inside tmux already, and
# CLAUDE_NO_ATTACH=1 skips it. Not exec: detaching (Ctrl-b d) comes back to
# this shell.
cmd_hook() {
  cat <<EOF
$HOOK_BEGIN
# Written by deploy/install-claude-session.sh (its --remove takes it out). An
# interactive SSH login is an ordinary shell; when the Claude session (tmux
# session "$SESSION") is running it says so in one line, and \`claude-attach\`
# steps into it - Ctrl-b d leaves it running and comes back here. It used to
# attach every SSH login, so no login could get a plain shell (the operator,
# 2026-10-07); CLAUDE_ATTACH=1 in the environment brings that back. Nothing
# that is not an interactive SSH login is touched.
claude-attach() { tmux attach-session -t =$SESSION; }
if [ -n "\${SSH_TTY-}" ] && [ -z "\${TMUX-}" ] && [ "\${CLAUDE_NO_ATTACH-}" != 1 ] && [ -t 0 ] && [ -t 1 ]; then
  case \$- in
    *i*)
      if command -v tmux >/dev/null 2>&1 && tmux has-session -t =$SESSION 2>/dev/null; then
        if [ "\${CLAUDE_ATTACH-}" = 1 ]; then
          echo 'Attaching to the Claude session (tmux session "$SESSION"): Ctrl-b d detaches and leaves it running.'
          tmux attach-session -t =$SESSION
        else
          echo 'The Claude session is running (tmux session "$SESSION"): type claude-attach to open it.'
        fi
      fi
      ;;
  esac
fi
$HOOK_END
EOF
}

case ${1:-} in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  unit) cmd_unit ;;
  hook) cmd_hook ;;
  -h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
