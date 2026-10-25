#!/usr/bin/env bash
# Bring this checkout up to date with GitHub, then get out of the way.
#
# whatsapp-bot.service runs this as ExecStartPre=, so every start of the bot -
# a boot, a crash restart, a `systemctl restart` - first fast-forwards the
# checkout to the branch it tracks, and only then launches node. The bot gets
# rebuilt on new Ubuntu boxes fairly often, and before this each of them
# stayed on whatever commit it was cloned at until somebody remembered to log
# in and pull by hand.
#
# It runs BEFORE node, not from inside it, for two reasons:
#   - No extra restart. Pulling from inside the process would mean exiting to
#     load the new code, and every restart is another WhatsApp login. The
#     reconnect counts in docs/whatsapp-ban-risk.md are why that matters.
#   - A bad commit cannot stop the fix from arriving. If node itself did the
#     pulling, a syntax error on main would crash it before it could fetch
#     the commit that repairs it; this script does not load the app at all.
#
# It must never be the reason the bot does not start. Every path that is not
# a clean fast-forward leaves the code as it was, says why in the journal,
# and exits 0. It never resets over, stashes, checks out or cleans anybody's
# work: a box with local edits, local commits, a detached HEAD or no upstream
# branch is somebody's deliberate state, and is left alone. The one reset it
# does is `--keep`, back to the commit it came from, undoing its own switch.
#
# A commit that crash-loops is taken back out. Every start opens a WhatsApp
# socket with no backoff, and the unit restarts every 10s, so a commit that
# dies after connecting would reconnect ~300 times an hour, unattended, on
# every box that restarts - exactly the pattern that got numbers logged out.
# After an update, if systemd has to restart the bot 3 times within 10
# minutes of a start, this goes back to the last commit that ran, and does not
# take that commit again until a newer one is pushed.
#
# Turn it off on one box with AUTO_UPDATE=0 in .env (or the environment).
# .env is read as text for that one key, never sourced: it holds MASTER_KEY.
#
# To see what the next start would do, without changing anything:
#   deploy/auto-update.sh --check
# Run without --check it really updates, so it refuses while the bot is
# running from this directory: changing the code under a live process gives a
# mixed-version bot (the panel's files are read from disk on every request).
# The last outcome of a real run is in data/auto-update.json, which the
# panel's Diagnostics card and fresh-install checklist show.
set -uo pipefail

CHECK=0
case "${1:-}" in
  '') ;;
  --check) CHECK=1 ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$APP_DIR/data"
STATUS_FILE="$DATA_DIR/auto-update.json"
STATE_FILE="$DATA_DIR/auto-update.state"
STAGE_DIR="$APP_DIR/.auto-update-staging"
PREV_MODULES="$APP_DIR/.node_modules.previous"

# Tracked files that the app and its tools rewrite, not a person. The panel's
# catalogue rebuild keeps a copy of its list in library/ for the repo
# (src/web/api.js, finishCatalogue); the bot's own list is in
# data/state.json. tools/build-descriptions.mjs regenerates content/ from
# data/ - and runs whenever it is imported, which test/rules-freshness does,
# so a plain `npm test` on a live box rewrites it. Counted as local edits,
# either would stop a box from ever updating again. Globs, matched per path.
GENERATED=('library/clean-titles.md' 'library/clean-titles.json'
  'content/README.md' 'content/descriptions/*' 'content/rules/*')

# Paths no commit may touch. git treats ignored files as expendable: a commit
# that added data/config.json would silently overwrite this box's session,
# settings and all, and .env holds the MASTER_KEY that decrypts them.
PROTECTED=(data .env '.env.*' node_modules 'certs/*.crt' 'certs/*.pem')

FETCH_ATTEMPTS=${AUTO_UPDATE_FETCH_ATTEMPTS:-4}
FETCH_TIMEOUT=${AUTO_UPDATE_FETCH_TIMEOUT:-45}
NPM_TIMEOUT=${AUTO_UPDATE_NPM_TIMEOUT:-600}
# Seconds between fetch attempts. At boot the network - and on some boxes a
# VPN - can still be coming up after network-online.target has been reached.
RETRY_DELAYS=(${AUTO_UPDATE_RETRY_DELAYS:-5 10 20})
# A start this soon after the previous one, made by systemd rather than a
# person, means the previous run died on its own.
QUICK_SECS=${AUTO_UPDATE_QUICK_SECS:-600}
ROLLBACK_AFTER=${AUTO_UPDATE_ROLLBACK_AFTER:-3}

# A remote URL can carry a token (https://user:token@github.com/...), and git
# quotes URLs in its errors. Nothing it says goes to the journal or the panel
# with one in.
scrub() { printf '%s' "$*" | sed -E 's#(://)[^/@[:space:]]+@#\1***@#g'; }
say() { echo "[auto-update] $(scrub "$*")"; }

json_escape() {
  local s=$1
  s=${s//[[:cntrl:]]/ }
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "$s"
}

# result is one of: updated, up-to-date, off, skipped, failed, rolled-back.
#   off     - AUTO_UPDATE=0 on this box
#   skipped - left alone on purpose (local edits, local commits, pinned...)
#   failed  - wanted to update and could not (network, auth, npm, a bad commit)
# --check only says it; the file describes real starts.
record() {
  local result=$1 reason from=${3:-} to=${4:-} count=${5:-0}
  reason=$(scrub "$2")
  say "$reason"
  (( CHECK )) && return 0
  [[ -d $DATA_DIR ]] || return 0
  local tmp="$STATUS_FILE.$$.tmp"
  {
    printf '{\n'
    printf '  "checkedAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "result": "%s",\n' "$result"
    printf '  "reason": "%s",\n' "$(json_escape "$reason")"
    printf '  "branch": "%s",\n' "$(json_escape "${UPSTREAM:-}")"
    printf '  "head": "%s",\n' "$(git rev-parse HEAD 2>/dev/null)"
    printf '  "from": "%s",\n' "$from"
    printf '  "to": "%s",\n' "$to"
    printf '  "commits": %d,\n' "$count"
    printf '  "trial": "%s",\n' "${TRIAL_SHA:-}"
    printf '  "rejected": "%s"\n' "${REJECTED_SHA:-}"
    printf '}\n'
  } >"$tmp" 2>/dev/null && mv -f "$tmp" "$STATUS_FILE" 2>/dev/null
  rm -f "$tmp" 2>/dev/null
  return 0
}

finish() { record "$@"; exit 0; }

# git and npm put the useful line first ("fatal: ...", "error: ...") and
# boilerplate like "Aborting" last, so quote the first error-looking line.
first_error() {
  local line
  line=$(printf '%s\n' "$1" | grep -m1 -iE 'error|fatal') ||
    line=$(printf '%s\n' "$1" | grep -m1 -v '^[[:space:]]*$')
  printf '%s' "${line:0:300}"
}

# The key from the environment wins; otherwise the last AUTO_UPDATE= line in
# .env, read as plain text.
setting() {
  local key=$1 val
  val=$(printenv "$key" 2>/dev/null) && { printf '%s' "$val"; return; }
  [[ -r $APP_DIR/.env ]] || return 0
  val=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$key=" "$APP_DIR/.env" 2>/dev/null | tail -n1) || return 0
  val=${val#*=}
  val=${val%%#*}
  val=${val//[\"\' $'\r']/}
  printf '%s' "$val"
}

# data/auto-update.state: this script's memory between starts, one key=value
# per line. Kept apart from the JSON so that bash never has to parse JSON.
LAST_START_AT='' LAST_NRESTARTS='' TRIAL_SHA='' TRIAL_PREV='' TRIAL_QUICK=0 REJECTED_SHA=''
load_state() {
  [[ -r $STATE_FILE ]] || return 0
  local k v
  while IFS='=' read -r k v; do
    case $k in
      last_start_at) [[ $v =~ ^[0-9]+$ ]] && LAST_START_AT=$v ;;
      last_nrestarts) [[ $v =~ ^[0-9]+$ ]] && LAST_NRESTARTS=$v ;;
      trial_sha) [[ $v =~ ^[0-9a-f]{40}$ ]] && TRIAL_SHA=$v ;;
      trial_prev) [[ $v =~ ^[0-9a-f]{40}$ ]] && TRIAL_PREV=$v ;;
      trial_quick) [[ $v =~ ^[0-9]+$ ]] && TRIAL_QUICK=$v ;;
      rejected_sha) [[ $v =~ ^[0-9a-f]{40}$ ]] && REJECTED_SHA=$v ;;
    esac
  done <"$STATE_FILE"
}
save_state() {
  (( CHECK )) && return 0
  [[ -d $DATA_DIR ]] || return 0
  local tmp="$STATE_FILE.$$.tmp"
  printf 'last_start_at=%s\nlast_nrestarts=%s\ntrial_sha=%s\ntrial_prev=%s\ntrial_quick=%s\nrejected_sha=%s\n' \
    "$NOW" "${NRESTARTS:-}" "$TRIAL_SHA" "$TRIAL_PREV" "$TRIAL_QUICK" "$REJECTED_SHA" >"$tmp" 2>/dev/null &&
    mv -f "$tmp" "$STATE_FILE" 2>/dev/null
  rm -f "$tmp" 2>/dev/null
  return 0
}

# How many times systemd has restarted this unit by itself. A person's
# `systemctl restart` does not move it; a crash under Restart=always does.
# Empty when not run by systemd, or when systemd cannot be asked.
# The unit is found from this process's cgroup; AUTO_UPDATE_UNIT names it
# instead, for a unit installed under another name.
restart_count() {
  local unit=${AUTO_UPDATE_UNIT:-} n
  [[ -n ${INVOCATION_ID:-} ]] || return 0
  [[ -n $unit ]] || unit=$(sed -n 's#^0::.*/\([^/]*\.service\)$#\1#p' /proc/self/cgroup 2>/dev/null | head -n1)
  [[ -n $unit ]] || return 0
  n=$(timeout 10 systemctl show -p NRestarts --value "$unit" 2>/dev/null) || return 0
  [[ $n =~ ^[0-9]+$ ]] && printf '%s' "$n"
}

is_generated() {
  local g
  for g in "${GENERATED[@]}"; do
    # shellcheck disable=SC2053 - unquoted on purpose: $g is a glob.
    [[ $1 == $g ]] && return 0
  done
  return 1
}

# Tracked files that differ from HEAD, apart from the ones the app writes.
local_edits() {
  local f
  while IFS= read -r -d '' f; do
    is_generated "$f" || printf '%s\n' "$f"
  done < <(git diff -z --name-only HEAD 2>/dev/null)
}

use_home_node() {
  # Same fallback as start.sh: node from a tarball in ~/.local/node when
  # there is no system one. systemd's PATH does not include it.
  if ! command -v node >/dev/null 2>&1 && [[ -x ${HOME:-}/.local/node/bin/node ]]; then
    export PATH="$HOME/.local/node/bin:$PATH"
  fi
}

# npm ci empties node_modules before it installs, so in place a failure - no
# network, a full disk, a timeout - would leave a bot that cannot start at
# all. Install into a staging directory instead, from the lockfile of the
# commit about to be used, and swap it in only once it is complete.
stage_deps() {
  local sha=$1 out
  use_home_node
  command -v npm >/dev/null 2>&1 || { DEPS_ERROR="npm is not installed"; return 1; }
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR" || { DEPS_ERROR="could not create $STAGE_DIR"; return 1; }
  git show "$sha:package.json" >"$STAGE_DIR/package.json" 2>/dev/null
  local cmd=(npm ci)
  if ! git show "$sha:package-lock.json" >"$STAGE_DIR/package-lock.json" 2>/dev/null; then
    rm -f "$STAGE_DIR/package-lock.json"
    cmd=(npm install)
  fi
  # install.sh installs production dependencies only. A box that someone
  # gave the dev ones, to run the whole test suite, keeps them.
  local omit=(--omit=dev)
  [[ -d $APP_DIR/node_modules/linkedom ]] && omit=(--include=dev)
  if ! out=$(cd "$STAGE_DIR" && timeout --kill-after=10 "$NPM_TIMEOUT" "${cmd[@]}" "${omit[@]}" --no-audit --no-fund --loglevel=error 2>&1); then
    DEPS_ERROR="npm: $(first_error "$out")"
    return 1
  fi
  [[ -d $STAGE_DIR/node_modules ]] || mkdir -p "$STAGE_DIR/node_modules"
}

# Put $1 (a complete node_modules) in place. The one it replaces goes to $2,
# or is deleted when $2 is empty. Returns 1, with the old one back in place,
# if the swap could not be made.
swap_modules() {
  local incoming=$1 keep=$2 aside="$APP_DIR/.node_modules.old.$$"
  if [[ -d $APP_DIR/node_modules ]]; then
    mv "$APP_DIR/node_modules" "$aside" || return 1
  fi
  if ! mv "$incoming" "$APP_DIR/node_modules"; then
    [[ -d $aside ]] && mv "$aside" "$APP_DIR/node_modules"
    return 1
  fi
  if [[ -d $aside ]]; then
    if [[ -n $keep ]]; then rm -rf "$keep"; mv "$aside" "$keep" || rm -rf "$aside"; else rm -rf "$aside"; fi
  fi
  return 0
}

deps_differ() { ! git diff --quiet "$1" "$2" -- package.json package-lock.json 2>/dev/null; }

# A bot already running from this checkout: node, started as src/index.js,
# with this directory as its working directory. Under systemd the previous
# run has exited before ExecStartPre; this catches a copy started by hand.
bot_running() {
  local pid
  for pid in $(pgrep -f 'src/index\.js' 2>/dev/null); do
    [[ $(cat "/proc/$pid/comm" 2>/dev/null) == node ]] || continue
    [[ $(readlink "/proc/$pid/cwd" 2>/dev/null) == "$APP_DIR" ]] || continue
    printf '%s' "$pid"
    return 0
  done
  return 1
}

cd "$APP_DIR" || exit 0

if [[ $EUID -eq 0 ]]; then
  # A root-run pull would leave root-owned files in .git that the service
  # user then cannot update, and every later run would fail.
  say "not running as root - run it as the user that owns $APP_DIR"
  exit 0
fi

command -v git >/dev/null 2>&1 || finish skipped "git is not installed"
if ! err=$(git rev-parse --is-inside-work-tree 2>&1); then
  # Usually "not a git repository"; on a checkout cloned by another user it
  # is git's "dubious ownership" refusal, which is worth seeing verbatim.
  finish skipped "$APP_DIR is not a usable git checkout: $(first_error "$err")"
fi

if (( ! CHECK )) && pid=$(bot_running); then
  say "the bot is running from $APP_DIR (pid $pid) - not changing its code underneath it. It updates itself when it next starts; to update now, restart the service. To only look: $0 --check"
  exit 0
fi

# One run at a time: a manual run and a service start can overlap. The lock
# lives in data/, which is the one directory the app is sure to own.
if [[ -d $DATA_DIR ]] && command -v flock >/dev/null 2>&1; then
  exec 9>"$DATA_DIR/.auto-update.lock" || true
  flock -n 9 || { say "another update is already running - leaving it to that one"; exit 0; }
fi

# Only now that this run holds the lock may it clear the staging directory: a
# run that bowed out above must not delete the one that is using it.
trap 'rm -rf "$STAGE_DIR" 2>/dev/null' EXIT

# ---------------------------------------------------------------------------
# Did the last update crash-loop? Decided before anything else, and even when
# updates are turned off: a bad commit already in place is still a bad commit.
load_state
NOW=$(date +%s)
NRESTARTS=$(restart_count)
SINCE_LAST=$(( LAST_START_AT ? NOW - LAST_START_AT : 1 << 30 ))
AUTO_RESTART=0
[[ -n $NRESTARTS && -n $LAST_NRESTARTS ]] && (( NRESTARTS > LAST_NRESTARTS )) && AUTO_RESTART=1
HEAD_NOW=$(git rev-parse HEAD 2>/dev/null)

if (( CHECK )) && [[ -n $TRIAL_SHA ]]; then
  say "$(git rev-parse --short "$TRIAL_SHA") is on trial since the last update ($TRIAL_QUICK crash-restart(s) so far; $ROLLBACK_AFTER take it back out)"
elif [[ -n $TRIAL_SHA ]]; then
  if [[ $HEAD_NOW != "$TRIAL_SHA" ]]; then
    # Somebody moved HEAD by hand; whatever they chose is not on trial.
    TRIAL_SHA='' TRIAL_PREV='' TRIAL_QUICK=0
    rm -rf "$PREV_MODULES"
  elif (( SINCE_LAST >= QUICK_SECS )); then
    say "$(git rev-parse --short "$TRIAL_SHA") ran for $((SINCE_LAST / 60)) minutes - keeping it"
    TRIAL_SHA='' TRIAL_PREV='' TRIAL_QUICK=0
    rm -rf "$PREV_MODULES"
  elif (( AUTO_RESTART )); then
    TRIAL_QUICK=$((TRIAL_QUICK + 1))
    say "$(git rev-parse --short "$TRIAL_SHA") died ${SINCE_LAST}s after starting (restart $TRIAL_QUICK of $ROLLBACK_AFTER before it is taken back out)"
  fi
fi
save_state

if (( ! CHECK )) && [[ -n $TRIAL_SHA ]] && (( TRIAL_QUICK >= ROLLBACK_AFTER )); then
  BAD=$TRIAL_SHA GOOD=$TRIAL_PREV
  SHORT_BAD=$(git rev-parse --short "$BAD") SHORT_GOOD=$(git rev-parse --short "$GOOD" 2>/dev/null)
  EDITS=$(local_edits)
  if [[ -n $EDITS ]]; then
    finish failed "$SHORT_BAD keeps crashing, but there are local changes to tracked files, so it was not rolled back: $(echo "$EDITS" | head -n5 | paste -sd' ' -)" "$BAD" "$GOOD"
  fi
  if deps_differ "$GOOD" "$BAD" && [[ ! -d $PREV_MODULES ]]; then
    stage_deps "$GOOD" || finish failed "$SHORT_BAD keeps crashing, and the dependencies of $SHORT_GOOD could not be reinstalled to go back to it ($DEPS_ERROR)" "$BAD" "$GOOD"
    mv "$STAGE_DIR/node_modules" "$PREV_MODULES" || finish failed "$SHORT_BAD keeps crashing, and $SHORT_GOOD's dependencies could not be put in place" "$BAD" "$GOOD"
  fi
  if ! err=$(git reset --quiet --keep "$GOOD" 2>&1); then
    finish failed "$SHORT_BAD keeps crashing, and going back to $SHORT_GOOD failed: $(first_error "$err")" "$BAD" "$GOOD"
  fi
  if [[ -d $PREV_MODULES ]] && ! swap_modules "$PREV_MODULES" ''; then
    git reset --quiet --keep "$BAD" 2>/dev/null
    finish failed "$SHORT_BAD keeps crashing, and $SHORT_GOOD's node_modules could not be moved back into place, so it stays on $SHORT_BAD" "$BAD" "$GOOD"
  fi
  REJECTED_SHA=$BAD TRIAL_SHA='' TRIAL_PREV='' TRIAL_QUICK=0
  save_state
  record rolled-back "$SHORT_BAD was restarted $ROLLBACK_AFTER times within $((QUICK_SECS / 60)) minutes of starting - went back to $SHORT_GOOD, and will not take $SHORT_BAD again; the next commit pushed after it will be tried" "$BAD" "$GOOD"
  # Carry on: if a fix has been pushed since, it is picked up right now.
fi

# ---------------------------------------------------------------------------
case "$(setting AUTO_UPDATE | tr '[:upper:]' '[:lower:]')" in
  0|false|no|off) finish off "turned off on this box (AUTO_UPDATE=0)" ;;
esac

BRANCH=$(git symbolic-ref -q --short HEAD) ||
  finish skipped "HEAD is detached at $(git rev-parse --short HEAD 2>/dev/null) - a pinned commit is left alone"
UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) ||
  finish skipped "branch $BRANCH tracks no remote branch - nothing to pull from"
REMOTE=$(git config "branch.$BRANCH.remote")
MERGE_REF=$(git config "branch.$BRANCH.merge")
[[ $REMOTE == . ]] && finish skipped "branch $BRANCH tracks a local branch ($UPSTREAM) - nothing to pull from"

EDITS=$(local_edits)
if [[ -n $EDITS ]]; then
  finish skipped "local changes to tracked files - not pulling over them: $(echo "$EDITS" | head -n5 | paste -sd' ' -)"
fi
if [[ -e $(git rev-parse --git-path MERGE_HEAD) || -e $(git rev-parse --git-path rebase-merge) ||
      -e $(git rev-parse --git-path rebase-apply) || -e $(git rev-parse --git-path index.lock) ]]; then
  finish skipped "a merge, rebase or another git command is in progress in this checkout"
fi

# The repo is private. Every box is set up with `gh auth login`, so let git
# ask gh for the token even where `gh auth setup-git` was never run, or where
# restoring the old machine's ~/.gitconfig replaced what it wrote. Never
# prompt: there is nobody at a terminal during a boot.
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND=${GIT_SSH_COMMAND:-ssh -o BatchMode=yes}
GIT=(git -c gc.autoDetach=false -c maintenance.autoDetach=false)
if command -v gh >/dev/null 2>&1; then
  GH=$(command -v gh)
  GIT+=(-c credential.https://github.com.helper= -c "credential.https://github.com.helper=!'$GH' auth git-credential")
fi

# Only the tracked branch. A plain `git fetch` would also bring the
# force-pushed sealed-backup branch (encrypted keys) into this checkout.
attempt=1
while :; do
  err=$(timeout --kill-after=5 "$FETCH_TIMEOUT" "${GIT[@]}" fetch --quiet --no-tags "$REMOTE" "$MERGE_REF" 2>&1) && break
  if (( attempt >= FETCH_ATTEMPTS )); then
    finish failed "could not fetch $UPSTREAM after $attempt attempts, starting the code already here: $(first_error "$err")"
  fi
  delay=${RETRY_DELAYS[attempt-1]:-${RETRY_DELAYS[-1]:-10}}
  say "fetch attempt $attempt failed ($(first_error "$err")) - retrying in ${delay}s"
  sleep "$delay"
  attempt=$((attempt + 1))
done

OLD=$(git rev-parse HEAD)
NEW=$(git rev-parse FETCH_HEAD)
SHORT_OLD=$(git rev-parse --short "$OLD")
SHORT_NEW=$(git rev-parse --short "$NEW")

[[ $OLD == "$NEW" ]] && finish up-to-date "up to date with $UPSTREAM at $SHORT_OLD" "$OLD" "$NEW"
if git merge-base --is-ancestor "$NEW" "$OLD"; then
  finish skipped "$BRANCH has commits that are not on $UPSTREAM ($SHORT_OLD is ahead of $SHORT_NEW) - not touching them" "$OLD" "$NEW"
fi
if ! git merge-base --is-ancestor "$OLD" "$NEW"; then
  finish skipped "$BRANCH and $UPSTREAM have diverged ($SHORT_OLD vs $SHORT_NEW) - needs a person" "$OLD" "$NEW"
fi
if [[ $NEW == "$REJECTED_SHA" ]]; then
  finish skipped "$SHORT_NEW was taken back out after it crash-looped - staying on $SHORT_OLD until something newer is pushed" "$OLD" "$NEW"
fi
REJECTED_SHA=''
COUNT=$(git rev-list --count "$OLD..$NEW")

TOUCHED=$(git diff --name-only "$OLD" "$NEW" -- "${PROTECTED[@]}" 2>/dev/null | head -n5 | paste -sd' ' -)
if [[ -n $TOUCHED ]]; then
  finish failed "$SHORT_NEW changes files that belong to this box and are never taken from git ($TOUCHED) - staying on $SHORT_OLD; that commit needs fixing" "$OLD" "$NEW" "$COUNT"
fi
# Any other ignored file an incoming commit would replace: refuse the same way,
# where git itself would not.
while IFS= read -r -d '' f; do
  if [[ -e $f || -L $f ]] && git check-ignore -q --no-index -- "$f" 2>/dev/null; then
    finish failed "$SHORT_NEW adds $f, which exists here as an ignored local file - staying on $SHORT_OLD rather than overwrite it" "$OLD" "$NEW" "$COUNT"
  fi
done < <(git diff -z --name-only --diff-filter=A "$OLD" "$NEW" 2>/dev/null)

if (( CHECK )); then
  say "the next start would update $SHORT_OLD -> $SHORT_NEW ($COUNT commit(s) from $UPSTREAM)$(deps_differ "$OLD" "$NEW" && echo ', installing new dependencies first'):"
  git log --no-merges --format='[auto-update]   %h %s' -n 20 "$OLD..$NEW"
  exit 0
fi

NEED_DEPS=0
if deps_differ "$OLD" "$NEW" || [[ ! -d $APP_DIR/node_modules ]]; then
  NEED_DEPS=1
  say "$COUNT new commit(s) change the dependencies - installing them before switching"
  stage_deps "$NEW" || finish failed "could not install the new dependencies, staying on $SHORT_OLD: $DEPS_ERROR" "$OLD" "$NEW" "$COUNT"
fi

# The app's copies of its catalogue give way to the pushed ones; the bot's
# own list is in data/state.json and is not touched. Kept in data/ anyway.
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
while IFS= read -r -d '' f; do
  is_generated "$f" || continue
  git diff --quiet "$OLD" "$NEW" -- "$f" 2>/dev/null && continue
  mkdir -p "$DATA_DIR/auto-update-replaced" &&
    { [[ ! -e $f ]] || cp -p "$f" "$DATA_DIR/auto-update-replaced/$STAMP-${f//\//_}"; } &&
    git show "HEAD:$f" >"$f" 2>/dev/null &&
    say "$f: the pushed copy replaces the one generated on this box (kept in data/auto-update-replaced/)"
done < <(git diff -z --name-only HEAD 2>/dev/null)

if ! err=$(git merge --ff-only --quiet "$NEW" 2>&1); then
  finish failed "fast-forward to $SHORT_NEW failed, staying on $SHORT_OLD: $(first_error "$err")" "$OLD" "$NEW" "$COUNT"
fi

# Every box pulls on its next start, so a commit that does not even parse
# would take all of them down at once. Parse every changed script, and stay
# on the old code if one fails. This catches syntax only; a crash at run
# time is what the rollback above is for.
use_home_node
if command -v node >/dev/null 2>&1; then
  while IFS= read -r -d '' f; do
    [[ -f $f ]] || continue
    if ! err=$(node --check "$f" 2>&1); then
      git reset --quiet --keep "$OLD" 2>/dev/null
      finish failed "$SHORT_NEW does not parse ($f: $(first_error "$err")) - staying on $SHORT_OLD" "$OLD" "$NEW" "$COUNT"
    fi
  done < <(git diff -z --name-only --diff-filter=AMR "$OLD" "$NEW" -- '*.js' '*.mjs' '*.cjs')
fi

# While a trial is still unproven, the node_modules kept for going back
# belong to the commit it would go back to; never overwrite them with an
# unproven one's.
KEEP_PREV=''
if [[ -n $TRIAL_SHA ]]; then
  [[ -d $PREV_MODULES ]] || KEEP_PREV=$PREV_MODULES
else
  rm -rf "$PREV_MODULES"
  KEEP_PREV=$PREV_MODULES
fi
if (( NEED_DEPS )) && ! swap_modules "$STAGE_DIR/node_modules" "$KEEP_PREV"; then
  # The new code without its dependencies is worse than the old code with
  # its own, so go back.
  git reset --quiet --keep "$OLD" 2>/dev/null
  finish failed "could not move the new node_modules into place - went back to $SHORT_OLD" "$OLD" "$NEW" "$COUNT"
fi

# On trial until it survives: rollback goes to the last commit that did.
[[ -n $TRIAL_SHA ]] || TRIAL_PREV=$OLD
TRIAL_SHA=$NEW TRIAL_QUICK=0
save_state

say "pulled $COUNT commit(s) from $UPSTREAM, $SHORT_OLD -> $SHORT_NEW:"
git log --no-merges --format='[auto-update]   %h %s' -n 20 "$OLD..$NEW"
(( COUNT > 20 )) && say "  ... and $((COUNT - 20)) more"
if ! git diff --quiet "$OLD" "$NEW" -- whatsapp-bot.service; then
  # The installed unit is a rendered copy in /etc/systemd/system, which this
  # user cannot write. Say so, rather than let the two drift apart silently.
  say "whatsapp-bot.service changed in this update; the installed copy does not follow it. Re-render it with sudo: docs/operations.md, \"When the unit itself changes\""
fi
finish updated "updated $SHORT_OLD -> $SHORT_NEW ($COUNT commit(s) from $UPSTREAM)" "$OLD" "$NEW" "$COUNT"
