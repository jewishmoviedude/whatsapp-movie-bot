#!/usr/bin/env bash
# What cron runs every minute, as deploy/install-hourly-debug.sh installs it:
#   * * * * * mkdir -p <state> && /bin/bash <app>/deploy/hourly-debug/tick.sh >> <state>/cron.log 2>&1
#
# It is run.sh --tick, which says the rest: on the hour the hourly check, and
# between the hours the check only when the bot has asked for it at once,
# for a library keeper's #issue - the operator's request (2026-10-12):
# "Needless to say #issue tickets submitted by head admin 5558100180 get top
# priority" and "Meaning it should activate bot to send yo a notification to
# check right away" - and otherwise nothing, not even a line in cron.log.
#
# Why a file of its own, and not `run.sh --tick` in cron's line: a checkout
# from before the tick existed - a revert, or auto-update taking a commit
# back out - has a run.sh that passes every argument on to the check, and a
# check that ignores one it does not know, so there `run.sh --tick` is a
# whole run every minute, around the clock (found in review, 2026-10-12).
# Such a checkout has no tick.sh: the line then fails with "No such file or
# directory" and runs nothing, and that checkout's own routines check, which
# looks for run.sh in the line, reports it as running another checkout, and
# its --fix puts the on-the-hour line back.
here=${BASH_SOURCE[0]%/*}
[[ $here == "${BASH_SOURCE[0]}" ]] && here=.
exec /bin/bash "$here/run.sh" --tick "$@"
