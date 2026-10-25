#!/usr/bin/env bash
# What cron runs: the hourly check (tools/hourly-debug.mjs), on the hour, and
# at once when the bot asks for it.
#
# Installed by deploy/install-hourly-debug.sh as a tick every minute, through
# deploy/hourly-debug/tick.sh (which says why a file of its own):
#   * * * * * mkdir -p <state> && /bin/bash <app>/deploy/hourly-debug/tick.sh >> <state>/cron.log 2>&1
#
# --tick, at minute 00, is the hourly run, as it always was - and at 01 to 04
# too when the 00 tick came late (below). At any other minute it runs the
# check only when the bot has asked for one, by writing
# check-now.json in its data folder - for a library keeper's #issue, the
# operator's request (2026-10-12): "Needless to say #issue tickets submitted
# by head admin 5558100180 get top priority" and "Meaning it should activate
# bot to send yo a notification to check right away". The bot cannot start
# the check itself: its unit has NoNewPrivileges, which breaks the sudo the
# check restarts it with, and a child of the bot's service dies with the
# bot's cgroup when the check restarts it. So cron runs it, as every hour,
# with cron's environment and the token from the settings file. With no
# request a tick ends at once and prints nothing - cron.log would otherwise
# grow by 1,440 lines a day - before it reads the settings file or anything
# else. The check itself (`run --asked`) waits for the request to be due, and
# a tick that finds a run going leaves it for a later minute, silently. An
# asked run that failed is not tried again every minute (below).
#
# cron starts it with almost no environment, so everything is spelled out
# here: the node the service uses, a PATH with git, gh, npm and the Claude
# CLI on it, and the settings file with the Claude login token.
#
# One run at a time: a run that is still researching when the next hour
# comes keeps going, and the new one steps aside (flock -n). A run that hangs
# is ended at 100 minutes (research is capped at 55, a restart and its
# check at about 30), before it could block the one after next.
#
# Arguments are passed on: `run.sh --dry-run` scans and prints what it would
# do, with this environment, and changes nothing. `run.sh verify-token` makes
# the installer's one tiny call to Claude, in the same sandbox a run uses.
# `run.sh` alone runs the check now, by hand. --tick is tick.sh's alone, and
# is never passed on.
set -uo pipefail

APP_DIR="${HOURLY_DEBUG_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
ENV_FILE="${HOURLY_DEBUG_ENV_FILE:-$HOME/.config/whatsapp-bot/hourly-debug.env}"
STATE_DIR="${HOURLY_DEBUG_STATE_DIR:-$HOME/.local/share/whatsapp-bot-debug}"

TICK=0 ASKED=0 HOURLY=0
# Where a tick notes the hour whose run it began, an asked run that failed,
# and the request as an asked run found it.
HOURLY_STAMP=$STATE_DIR/hourly-tick
ASKED_FAILED=$STATE_DIR/asked-failed
ASKED_SEEN=$STATE_DIR/asked-request
if [[ ${1:-} == --tick ]]; then
  shift
  TICK=1
  # The time, with no process started for it (printf is bash's own).
  # HOURLY_DEBUG_NOW, in seconds, is the tests' clock; cron never sets it.
  now=${HOURLY_DEBUG_NOW:-}
  [[ -n $now ]] || printf -v now '%(%s)T' -1
  printf -v minute '%(%M)T' "$now"
  # The hour as hours since 1970, not as the clock names it: on the night
  # the clocks go back, 01:00 comes twice, and an hour named by the clock
  # was "the hour before" at 01:01 to 01:04 of the second pass, each a whole
  # hourly run more (found in review, 2026-10-12, in America/New_York - the
  # zone a WSL box takes from Windows). The minute stays the clock's: cron
  # goes by it. Minutes 00 to 04 of a local hour fall in one UTC hour in
  # every zone (whole, half or three-quarter hours off UTC), so the count
  # tells the hours apart as the clock did, but for the hour that comes twice.
  hour=$(( now / 3600 ))
  if [[ $minute == 00 ]]; then
    HOURLY=1
  elif (( 10#$minute < 5 )); then
    # cron woken late - the VM or WSL paused for a few minutes across the
    # hour - runs the ticks of the minutes it missed then, up to five minutes
    # late, and the 00 tick reads 01 to 04 on the clock. The old "0 * * * *"
    # line still ran the check then (found in review, 2026-10-12). So the
    # hour's run is still owed when the last one began in the hour before
    # this; with no stamp - a box just installed - it waits for the hour.
    last=
    [[ -r $HOURLY_STAMP ]] && read -r last <"$HOURLY_STAMP"
    [[ $last == "$(( hour - 1 ))" ]] && HOURLY=1
  fi
  if (( ! HOURLY )); then
    # The data folder as tools/hourly-debug.mjs settings() finds it.
    data_dir=${HOURLY_DEBUG_DATA_DIR:-${DATA_DIR:-$APP_DIR/data}}
    request=$data_dir/check-now.json
    [[ -e $request ]] || exit 0
    # An asked run that failed is not tried again every minute: until the
    # bot asks again (it writes the file anew) or the hour's run, the
    # request waits. A run that crashed before it took the request (say a
    # shipped fix to the scanner that chokes on a row) was otherwise all of
    # it again every minute - a question to the bot, a day of logs scanned,
    # a stack trace in cron.log - where it had cost one try an hour (found
    # in review, 2026-10-12). The hour's run reads a keeper's #issue a day
    # back, and takes the request when it can. The failure bears the time
    # the request had when that run began (asked_failed, below), not its
    # own: dated when it ended, it held back an #issue the bot asked for
    # while the run went on, until the hour (found in review, 2026-10-12).
    [[ $request -nt $ASKED_FAILED ]] || exit 0
    ASKED=1
    set -- --asked
  fi
fi

# An asked tick that could not run: noted, as above, with the time of the
# request it was started for. Only a tick's: by hand, a run that fails is
# somebody's to see.
asked_failed() {
  (( ASKED )) && printf 'exited %s\n' "$1" >"$ASKED_FAILED" 2>/dev/null && touch -r "$ASKED_SEEN" "$ASKED_FAILED" 2>/dev/null
  return 0
}

mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"

# The request's time as this asked run finds it, for asked_failed: an ask
# the bot writes from now on is newer. Taken by a run since, it is gone, and
# any ask to come is newer than now.
(( ASKED )) && { touch -r "$request" "$ASKED_SEEN" 2>/dev/null || touch "$ASKED_SEEN"; }

# The hour's run is begun: the stamp a late tick goes by (above). Before the
# lock, so an hour left to a run still going counts as begun, as before.
(( HOURLY )) && printf '%s\n' "$hour" >"$HOURLY_STAMP"

# cron appends this script's output to cron.log, a few lines a run. Kept to its
# last half megabyte, rewritten in place: cron holds it open for appending.
LOG="$STATE_DIR/cron.log"
if [[ -f $LOG ]] && (( $(stat -c %s "$LOG" 2>/dev/null || echo 0) > 2 * 1024 * 1024 )); then
  tail -c 524288 "$LOG" >"$LOG.tmp" && cat "$LOG.tmp" >"$LOG"; rm -f "$LOG.tmp"
fi

# The settings file holds the Claude token, so it is read as KEY=value text,
# never sourced: a line in it can only ever set a variable, and only the
# check's own switches - never a path to a program this script or the check
# runs (node, python, claude, the directories). Those come from cron's line
# or the defaults, so an edit to this file cannot swap in a program that then
# runs outside the sandbox.
if [[ -f $ENV_FILE && -r $ENV_FILE ]]; then
  if [[ $(stat -c %a "$ENV_FILE" 2>/dev/null) != 600 ]]; then
    echo "[hourly-check] $ENV_FILE holds a login token and is readable by others - chmod 600 it" >&2
  fi
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[[:space:]]*(export[[:space:]]+)?(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|HOURLY_DEBUG_(CLAUDE|PUSH|RESTART|EMAIL|CLAUDE_TIMEOUT_MIN|MODEL|FS_SANDBOX|VERIFY_SEC))=(.*)$ ]] || continue
    key=${BASH_REMATCH[2]} val=${BASH_REMATCH[4]}
    val=${val%$'\r'}
    [[ $val =~ ^\"(.*)\"$ || $val =~ ^\'(.*)\'$ ]] && val=${BASH_REMATCH[1]}
    export "$key=$val"
  done <"$ENV_FILE"
fi

# The node the service runs, so the check runs on the same version as the bot.
NODE=${HOURLY_DEBUG_NODE:-}
if [[ -z $NODE ]]; then
  NODE=$(systemctl show -p ExecStart --value "${HOURLY_DEBUG_UNIT:-whatsapp-bot}" 2>/dev/null | sed -n 's/^{ path=\([^ ;]*\).*/\1/p')
  [[ -x $NODE ]] || NODE=$(command -v node 2>/dev/null)
  [[ -x $NODE ]] || NODE=$HOME/.local/node/bin/node
fi
if [[ ! -x $NODE ]]; then
  echo "[hourly-check] no node found (looked at the service's, PATH's and ~/.local/node)" >&2
  asked_failed 1
  exit 1
fi
export PATH="$(dirname "$NODE"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export HOURLY_DEBUG_APP_DIR="$APP_DIR" HOURLY_DEBUG_STATE_DIR="$STATE_DIR" HOURLY_DEBUG_ENV_FILE="$ENV_FILE"

if [[ ${1:-} == verify-token ]]; then
  exec /usr/bin/timeout 180 "$NODE" "$APP_DIR/tools/hourly-debug.mjs" verify-token
fi

# An asked tick says nothing of its own: until the request is due it comes
# every minute, and the check prints a line when it does run.
(( ASKED )) || echo "[hourly-check] $(date -u +%FT%TZ) start${*:+ ($*)}"
/usr/bin/flock -n -E 75 "$STATE_DIR/run.lock" \
  /usr/bin/timeout --kill-after=60 100m \
  "$NODE" "$APP_DIR/tools/hourly-debug.mjs" run "$@"
rc=$?
case $rc in
  0) ;;
  # A run is going; the request stays for a later minute, and that run may
  # well take it. Not a line every minute while it researches.
  75) (( ASKED )) && exit 0
      echo "[hourly-check] the previous run is still going - this hour is left to it" ;;
  124) echo "[hourly-check] stopped after 100 minutes" ;;
  *) echo "[hourly-check] exited $rc" ;;
esac
if (( rc == 0 )); then
  (( TICK )) && [[ -e $ASKED_FAILED ]] && rm -f "$ASKED_FAILED"
else
  asked_failed "$rc"
fi
exit $rc
