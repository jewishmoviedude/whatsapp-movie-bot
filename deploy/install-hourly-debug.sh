#!/usr/bin/env bash
# Install, check or remove the hourly check (tools/hourly-debug.mjs).
#
#   deploy/install-hourly-debug.sh             install, or bring an install up to date
#   deploy/install-hourly-debug.sh --status    what is in place and what is missing
#   deploy/install-hourly-debug.sh --remove    take it out of cron (keeps its records)
#   deploy/install-hourly-debug.sh --no-verify install without the test call to Claude
#   deploy/install-hourly-debug.sh --set-token save the token `claude setup-token` printed
#                                              (asked for hidden, or read from stdin), then test it
#
# Run it as the user the bot runs as, from the live checkout (the one the
# service runs), not as root. Running it again is harmless: it replaces its
# own cron line and leaves everything else in the crontab alone.
#
# What it sets up:
#   - a cron entry, "* * * * * ... tick.sh" - a tick every minute. On the
#     hour it is the hourly check, as the operator asked; at any other
#     minute it runs the check only when the bot has asked for one at once,
#     for a library keeper's #issue (the operator, 2026-10-12: "Needless to
#     say #issue tickets submitted by head admin 5558100180 get top priority"
#     and "Meaning it should activate bot to send yo a notification to check
#     right away"), and otherwise ends at once and prints nothing
#     (deploy/hourly-debug/run.sh --tick, which tick.sh runs; tick.sh says
#     why the line does not call run.sh itself: an older checkout's run.sh
#     would take the tick for a whole run). Installing again replaces an
#     older "0 * * * *" line: both carry the same tag. cron rather than a
#     systemd timer because it needs no root: a user timer would also need
#     lingering turned on, and a system one a unit in /etc.
#   - ~/.config/whatsapp-bot/hourly-debug.env (mode 600), which holds the
#     Claude login token and any settings (see docs/operations.md).
# What it only checks, because it needs the operator:
#   - the token: made once with `claude setup-token`, which opens a browser
#     login and prints a long-lived token for headless use;
#   - sudo for `systemctl restart whatsapp-bot`, without which the check
#     reports a restart as needed instead of making it;
#   - the sandbox (deploy/hourly-debug/sandbox.py: python3, and Landlock in
#     the kernel), which runs the research session with no_new_privs, so sudo
#     cannot work inside it, and lets it write only its own clone - the
#     session is never started without it. On WSL, whose init holds the
#     seccomp listener it polices signals with, it runs the session in user,
#     PID and mount namespaces of its own instead;
#   - what else could hand the session root: full passwordless sudo is
#     closed to it by no_new_privs but is still worth narrowing, and the lxd
#     group is root by a door no_new_privs does not close. Both are warnings:
#     they are the operator's call.
set -uo pipefail

MODE=install VERIFY=1
for a in "$@"; do
  case $a in
    --status) MODE=status ;;
    --remove) MODE=remove ;;
    --no-verify) VERIFY=0 ;;
    --set-token) MODE=token ;;
    *) echo "usage: $0 [--status | --remove | --no-verify | --set-token]" >&2; exit 2 ;;
  esac
done

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${HOURLY_DEBUG_ENV_FILE:-$HOME/.config/whatsapp-bot/hourly-debug.env}"
STATE_DIR="${HOURLY_DEBUG_STATE_DIR:-$HOME/.local/share/whatsapp-bot-debug}"
DATA_DIR="${HOURLY_DEBUG_DATA_DIR:-$APP_DIR/data}"
CLAUDE_BIN="${HOURLY_DEBUG_CLAUDE_BIN:-$HOME/.local/bin/claude}"
UNIT="${HOURLY_DEBUG_UNIT:-whatsapp-bot}"
SYSTEMCTL="${HOURLY_DEBUG_SYSTEMCTL:-/usr/bin/systemctl}"
TAG='# whatsapp-bot-hourly-check'
# The state folder is made first: cron's shell opens the log before run.sh
# starts, so with the folder gone (cleared to win back disk space) every run
# failed at the redirect, into cron mail nobody reads, and the check stopped
# without a word.
LINE="* * * * * mkdir -p $STATE_DIR && /bin/bash $APP_DIR/deploy/hourly-debug/tick.sh >> $STATE_DIR/cron.log 2>&1 $TAG"

ok() { echo "  ok    $*"; }
todo() { echo "  TODO  $*"; }
warn() { echo "  WARN  $*"; }
say() { echo "$*"; }

if [[ $EUID -eq 0 ]]; then
  say "Run this as the bot's user, not root: the check pushes with that user's GitHub login and runs Claude with that user's token."
  exit 1
fi

current_crontab() { crontab -l 2>/dev/null || true; }

# Whether the check's line in cron is the tick every minute through tick.sh,
# the shape $LINE has, from whichever checkout.
cron_ticks() {
  current_crontab | grep -F "$TAG" \
    | grep -Eq '^\*[[:space:]]+\*[[:space:]]+\*[[:space:]]+\*[[:space:]]+\*[[:space:]].*/deploy/hourly-debug/tick\.sh[[:space:]]'
}

token_in_file() {
  [[ -r $ENV_FILE ]] && grep -Eq '^[[:space:]]*(export[[:space:]]+)?(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.+' "$ENV_FILE"
}

sudo_ok() { sudo -n -l "$SYSTEMCTL" restart "$UNIT" >/dev/null 2>&1; }
in_lxd() { id -nG 2>/dev/null | tr ' ' '\n' | grep -qx lxd; }
PYTHON="${HOURLY_DEBUG_PYTHON:-/usr/bin/python3}"

# The one real call to Claude this script makes: a single word back, no
# tools, nothing saved - through run.sh and the same sandbox a run uses, so
# it proves the token works headless from cron's point of view and that
# Claude Code starts inside the sandbox, before the first real run needs
# either.
# Returns 0 when the token works, 1 when it does not, and 3 when it could not
# be tried because the sandbox would not start: on WSL (2026-09-29) that
# said "the Claude token did not work", and the panel and the routines check
# then asked for a new token, which would have failed the same way. On WSL
# the sandbox now runs in namespaces of its own and the call is made there,
# so 3 is left for a box where neither sandbox can start.
verify_token() {
  local out
  out=$(HOURLY_DEBUG_ENV_FILE="$ENV_FILE" HOURLY_DEBUG_STATE_DIR="$STATE_DIR" HOURLY_DEBUG_CLAUDE_BIN="$CLAUDE_BIN" \
    /bin/bash "$APP_DIR/deploy/hourly-debug/run.sh" verify-token 2>&1) && [[ $(tail -n1 <<<"$out") == ok ]] && return 0
  echo "${out:0:300}"
  [[ $(tail -n1 <<<"$out") == "no sandbox - "* ]] && return 3
  return 1
}

# What this script last did, for the panel's fresh-install checklist and for
# tools/routines.mjs: data/hourly-debug/install.json. The bot cannot find out
# for itself - its unit sets NoNewPrivileges, and crontab needs its setgid bit
# to read a crontab - so the installer leaves the facts where the panel
# already reads the check's runs. Only fixed words go in: never the token, a
# path or an error text.
#   record <install|remove|token> <ok|failed|not-run|no-sandbox>
record() {
  [[ -d $DATA_DIR ]] || return 0
  local cron=false token=false dir="$DATA_DIR/hourly-debug" tmp
  if current_crontab | grep -qF "$TAG"; then cron=true; fi
  if token_in_file; then token=true; fi
  mkdir -p "$dir" && chmod 700 "$dir" || return 0
  tmp=$(mktemp "$dir/.install.json.XXXXXX") || return 0
  if printf '{\n  "at": "%s",\n  "event": "%s",\n  "cron": %s,\n  "token": %s,\n  "verify": "%s"\n}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$cron" "$token" "$2" >"$tmp" && chmod 600 "$tmp"; then
    mv -f "$tmp" "$dir/install.json"
  fi
  rm -f "$tmp"
}

ensure_env_file() {
  mkdir -p "$(dirname "$ENV_FILE")" && chmod 700 "$(dirname "$ENV_FILE")" || return 1
  if [[ ! -f $ENV_FILE ]]; then
    (umask 077 && cat >"$ENV_FILE") <<'EOF' || return 1
# Settings for the hourly check (deploy/install-hourly-debug.sh).
# Read as KEY=value lines, never sourced. Keep this file mode 600.
#
# The Claude login for headless runs, from `claude setup-token`. Put it here
# with deploy/install-hourly-debug.sh --set-token, which reads it hidden:
# CLAUDE_CODE_OAUTH_TOKEN=
#
# Optional (defaults shown):
# HOURLY_DEBUG_CLAUDE=1               0: scan and report, never start Claude
# HOURLY_DEBUG_PUSH=1                 0: push fixes to a branch per run instead of main
# HOURLY_DEBUG_RESTART=1              0: never restart; report a restart as needed
# HOURLY_DEBUG_EMAIL=1                0: panel only, no email
# HOURLY_DEBUG_CLAUDE_TIMEOUT_MIN=40  how long a research session may take
# HOURLY_DEBUG_MODEL=                 a model name or alias; empty for the default
EOF
    say "Wrote $ENV_FILE."
  fi
  chmod 600 "$ENV_FILE"
}

# --set-token: the one step of the setup that needs a person, made safe to
# do. The instructions used to say `echo 'CLAUDE_CODE_OAUTH_TOKEN=...' >>`
# the file, which leaves a long-lived login token in ~/.bash_history. Here it
# is read with no echo (or from stdin: tools/bootstrap.sh hands over what it
# read the same way), written with bash builtins only - never on a command
# line, where `ps` would show it - into a file made 600 in a folder made 700,
# replacing any token already there, and tested with the same one tiny
# sandboxed call the install makes.
set_token() {
  local token='' line tmp why
  if [[ -t 0 ]]; then
    say "Paste the token that \`claude setup-token\` printed (it is not shown as you type), then press Enter:"
    IFS= read -rs token || true
    echo
  else
    IFS= read -r token || true
  fi
  token=${token%$'\r'}
  token=${token#"${token%%[![:space:]]*}"}
  token=${token%"${token##*[![:space:]]}"}
  if [[ -z $token ]]; then say "No token given; nothing was changed."; return 2; fi
  # A token is one word of letters, digits and -_. Anything else is a paste
  # of the wrong thing, and a quote or a $ in the file would be read back
  # differently from how it went in.
  if [[ ! $token =~ ^[A-Za-z0-9._-]+$ ]]; then
    say "That is not a token: it has spaces, quotes or other characters in it. Nothing was changed."
    return 2
  fi
  [[ $token == sk-ant-* ]] || warn "it does not start with sk-ant-, as the tokens claude setup-token prints do; saved all the same"
  ensure_env_file || { say "Could not create $ENV_FILE."; return 1; }
  tmp=$(mktemp "$ENV_FILE.XXXXXX") || { say "Could not write next to $ENV_FILE."; return 1; }
  if {
    while IFS= read -r line || [[ -n $line ]]; do
      [[ $line =~ ^[[:space:]]*(export[[:space:]]+)?CLAUDE_CODE_OAUTH_TOKEN[[:space:]]*= ]] && continue
      printf '%s\n' "$line"
    done <"$ENV_FILE"
    printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$token"
  } >"$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$ENV_FILE"; then
    token=''
  else
    rm -f "$tmp"
    say "Could not write $ENV_FILE; nothing was changed."
    return 1
  fi
  ok "the token is in $ENV_FILE (mode 600, its folder 700)"
  if (( ! VERIFY )); then record token not-run; return 0; fi
  if [[ ! -x $CLAUDE_BIN ]]; then
    todo "not tested: Claude Code is not at $CLAUDE_BIN (curl -fsSL https://claude.ai/install.sh | bash), then run $0 again"
    record token not-run
    return 0
  fi
  local rc=0
  why=$(verify_token) || rc=$?
  if (( rc == 0 )); then
    ok "the Claude token works headless"
    record token ok
    return 0
  fi
  if (( rc == 3 )); then
    todo "the token is saved, but not tested: $why (node tools/routines.mjs --only hourly-check says why)"
    record token no-sandbox
    return 0
  fi
  todo "the Claude token did not work: $why"
  record token failed
  return 1
}

status() {
  say "Hourly check on $(hostname), for $APP_DIR"
  local line; line=$(current_crontab | grep -F "$TAG" | sed "s/ $TAG//")
  if [[ -z $line ]]; then todo "cron: not installed - run $0"
  elif cron_ticks; then ok "cron: $line"
  # An older line, on the hour only, is still the hourly check, but a library
  # keeper's #issue waits for the hour under it; it said "ok" here while
  # tools/routines.mjs and hourly-debug.mjs status flagged it (found in
  # review, 2026-10-12).
  else todo "cron: $line - not the tick every minute through tick.sh, so a library keeper's #issue waits for the hour - run $0"; fi
  if [[ -f $ENV_FILE ]]; then
    local mode; mode=$(stat -c %a "$ENV_FILE")
    [[ $mode == 600 ]] && ok "settings: $ENV_FILE (600)" || todo "settings: $ENV_FILE is mode $mode - chmod 600 it, it holds a login token"
  else
    todo "settings: $ENV_FILE does not exist - run $0"
  fi
  if [[ -x $CLAUDE_BIN ]]; then ok "claude: $CLAUDE_BIN ($("$CLAUDE_BIN" --version 2>/dev/null | head -n1))"; else todo "claude: not found at $CLAUDE_BIN (install Claude Code, or give cron's line HOURLY_DEBUG_CLAUDE_BIN=<path>)"; fi
  if token_in_file; then ok "claude login: a token is in the settings file"; else todo "claude login: no token - see step 1 below"; fi
  if sudo_ok; then ok "sudo: may run systemctl restart $UNIT"; else todo "sudo: cannot run systemctl restart $UNIT without a password - see step 2 below"; fi
  local abi; abi=$("$PYTHON" "$APP_DIR/deploy/hourly-debug/sandbox.py" --abi 2>/dev/null)
  if [[ ! -x $PYTHON ]]; then todo "sandbox: $PYTHON is missing (sudo apt install python3) - research is never started without it"
  elif (( ${abi:-0} >= 1 )); then ok "sandbox: no_new_privs and Landlock (ABI $abi) - the research session cannot use sudo, and writes only its own clone"
  else todo "sandbox: this kernel has no Landlock - research is not started; HOURLY_DEBUG_FS_SANDBOX=0 in the settings file runs it with no_new_privs only"; fi
  # What Landlock does not stop, tried from inside the sandbox as every run
  # does: a UNIX socket (systemd-run --user, the lxd socket) and a signal to a
  # process outside it - this shell stands in for the bot.
  if [[ -x $PYTHON ]]; then
    local probe; probe=$("$PYTHON" "$APP_DIR/deploy/hourly-debug/sandbox.py" --probe $$ 2>&1 | tail -n1)
    if [[ $probe == closed ]]; then
      ok "sandbox: no UNIX sockets (systemd-run --user, lxd) and no signals to the bot - tried from inside it"
      # WSL's init holds the seccomp listener the usual sandbox needs, so
      # there it runs in namespaces of its own (2026-09-29).
      if [[ $("$PYTHON" "$APP_DIR/deploy/hourly-debug/sandbox.py" --mode 2>/dev/null) == namespaces ]]; then
        ok "sandbox: in user, PID and mount namespaces of its own - the seccomp listener is taken here (WSL's init)"
      fi
    else todo "sandbox: it leaves ${probe:-its doors untested} open - research is not started while it does"; fi
  fi
  # Full passwordless sudo is not warned about: it is the operator's permanent
  # choice on a bot box (2026-09-30: "I don't care if sudo is passwordless root
  # ... it's not like there's any confidential data"), and the research session
  # cannot use it anyway (no_new_privs).
  if in_lxd; then warn "lxd: this account is in the lxd group, which is root by a door no_new_privs does not close - see step 3 below"; fi
  if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then ok "github: gh is logged in (pushes fixes)"; else todo "github: gh is not logged in - gh auth login"; fi
  # On by default since 2026-10-12, so "on" alone is not enough: with no
  # address and app password nothing can be sent (emailReady in src/util/mailer.js).
  if grep -q '"enabled": *true' <(node -e 'try{const c=require(process.argv[1]);const e=c.email??{};process.stdout.write(JSON.stringify({enabled:!!(e.enabled&&e.user&&e.appPassword&&((e.provider??"gmail")!=="custom"||e.host))}))}catch{}' "$APP_DIR/data/config.json" 2>/dev/null); then
    ok "email: on - reports are emailed"
  else
    todo "email: off, or with no address and app password, in Settings -> Email alerts - reports only reach the panel"
  fi
  local last; last=$(tail -n 3 "$STATE_DIR/cron.log" 2>/dev/null | grep -v '^$' | tail -n1)
  [[ -n $last ]] && say "  last log line: $last"
}

next_steps() {
  local shown=0
  if ! cron_ticks; then
    shown=1
    cat <<EOF

Put the check in cron as a tick every minute - the hourly run on the hour,
and the check at once for a library keeper's #issue (it replaces an older
line, on the hour only):

     $0
EOF
  fi
  if ! token_in_file; then
    shown=1
    cat <<EOF

1. Give the check a Claude login it can use from cron (once):

     $CLAUDE_BIN setup-token

   It opens a browser login and prints a long-lived token - on this box, or
   on any computer where you use Claude Code. Then:

     $0 --set-token

   and paste it. It is read without being shown, saved to $ENV_FILE
   (mode 600), and tested with one tiny call. Do not echo it into the file:
   a command line lands in your shell history.
EOF
  fi
  if ! sudo_ok; then
    shown=1
    cat <<EOF

2. Let it restart the bot (once). This allows exactly one command, nothing
   else, and has visudo check the rule before it is put in place - a broken
   file in /etc/sudoers.d locks everyone out of sudo:

     T=\$(mktemp) && echo "$USER ALL=(root) NOPASSWD: $SYSTEMCTL restart $UNIT" > "\$T" && sudo visudo -cf "\$T" \\
       && sudo install -m 0440 -o root -g root "\$T" /etc/sudoers.d/91-whatsapp-bot-restart && rm -f "\$T"

   Full passwordless sudo (docs/server-setup.md, "Give Claude Code sudo")
   covers it too. Without either, a needed restart is reported, not made.
EOF
  fi
  if in_lxd; then
    shown=1
    cat <<EOF

3. Worth considering (your call - nothing breaks either way). The research
   session reads text written by strangers in public groups. It runs with
   no_new_privs, so sudo cannot work inside it, and it has no git login; the
   check itself does the one restart and the push. What no_new_privs does
   not close:
     - the lxd group is root without sudo. If LXD is not used here:
         sudo gpasswd -d $USER lxd        (takes effect at the next login)
   Complete separation is a user of its own for the check, with no sudo and
   its own GitHub login - docs/operations.md, "The hourly check".
EOF
  fi
  (( shown )) || say $'\nNothing left to do.'
}

case $MODE in
  status)
    status
    next_steps
    exit 0
    ;;
  remove)
    if current_crontab | grep -qF "$TAG"; then
      current_crontab | grep -vF "$TAG" | crontab - && say "Removed the hourly check from cron."
    else
      say "The hourly check is not in cron."
    fi
    record remove not-run
    say "Left in place: $ENV_FILE (your token), $STATE_DIR (its clone and log), $APP_DIR/data/hourly-debug (its reports)."
    say "Delete them by hand if you want them gone."
    exit 0
    ;;
  token)
    set_token
    exit $?
    ;;
esac

# --- install --------------------------------------------------------------
[[ -f $APP_DIR/tools/hourly-debug.mjs && -f $APP_DIR/deploy/hourly-debug/run.sh && -f $APP_DIR/deploy/hourly-debug/tick.sh ]] || {
  say "$APP_DIR does not have the hourly check in it - update the checkout first."; exit 1; }
for t in crontab flock timeout git; do
  command -v "$t" >/dev/null 2>&1 || { say "$t is not installed."; exit 1; }
done

mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"
ensure_env_file || { say "Could not create $ENV_FILE."; exit 1; }

verified=not-run
if token_in_file && [[ -x $CLAUDE_BIN ]] && (( VERIFY )); then
  vrc=0
  why=$(verify_token) || vrc=$?
  if (( vrc == 0 )); then
    ok "the Claude token works headless"; verified=ok
  elif (( vrc == 3 )); then
    todo "the token is there, but not tested: $why (node tools/routines.mjs --only hourly-check says why)"; verified=no-sandbox
  else
    todo "the Claude token did not work: $why"; verified=failed
  fi
fi

{ current_crontab | grep -vF "$TAG"; echo "$LINE"; } | crontab - || { say "Could not write the crontab."; exit 1; }
say "Installed: $LINE"
record install "$verified"
say ""
status
next_steps
cat <<EOF

The first run is at the top of the next hour, or sooner for a library
keeper's #issue. To see what it would do now, changing nothing:

  $APP_DIR/deploy/hourly-debug/run.sh --dry-run
EOF
