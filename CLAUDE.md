# Working on this repo

Orientation for a session that has just opened this directory. Read this
before changing anything.

## What this is

A WhatsApp bot that takes movie and TV requests in group chats, finds the file
in Jellyfin, re-encodes it under WhatsApp's 2 GB cap, and posts it. Node 20+,
ESM, no framework. Baileys for WhatsApp, Express for the control panel.

It runs on somebody's real WhatsApp number, in real group chats, for real
people. It is not a toy, and the failure modes are expensive: a mistake here
can get a phone number permanently banned, or post a film to a group that
should not have received it.

## Routines every box runs

Before anything else in a session, on any machine:

```bash
node tools/routines.mjs          # every routine this box should run: in place, missing, or needing the user
node tools/routines.mjs --fix    # then activate everything that needs no person
```

It works out whether this box runs the bot (the service is active here) or
stands by, and checks accordingly. It never starts, stops, restarts or enables
the bot, so it is safe on a standby laptop (rule 3 below); `--fix` runs only
from the checkout the service runs. For a routine marked `needs-user` - a
password, a browser login, a passphrase - give the user the exact command it
prints after `->` and ask them to run it; do not improvise another. On a
development clone it only lists the routines. (The hourly check's research
session is the exception: it works in a sandboxed clone and leaves the box
alone.)

The routines, all in `src/core/routines.js`, with why each exists:

| Routine | Where | What |
|---|---|---|
| `sudo` | every bot box | passwordless sudo for the bot's user ([server-setup.md, "Give Claude Code sudo"](docs/server-setup.md#give-claude-code-sudo)), the operator's permanent choice on a bot box (2026-09-30: nothing is ever to suggest narrowing or removing it); a box already narrowed to the hourly check's restart rule by an older `deploy/install-hourly-debug.sh` is still accepted, and anything else that takes sudo there waits for the user |
| `gh-auth` | every bot box | `gh` logged in, git using its login, and a git identity to commit with (the repository owner's) |
| `packages` | every bot box | Node 20+, ffmpeg/ffprobe, the npm dependencies, python3, cron running |
| `claude-code` | every bot box | Claude Code at `~/.local/bin/claude` |
| `yt-dlp` | every bot box | yt-dlp (the official zipapp, `~/.local/bin/yt-dlp`, run by python3) and deno (`~/.deno/bin/deno`, its JavaScript runtime for YouTube: yt-dlp takes node only from 22), for YouTube links on "Queue a public link" (`node tools/install-yt-dlp.mjs`, no root); flagged when its last update check is 3 days old or its release 120 days |
| `tailscale-ssh` | every bot box | Tailscale SSH on, operator set, auto-update on; on WSL instead sshd on port 2222 (`deploy/wsl-setup.sh ssh`), the Windows Tailscale client being the tailnet node |
| `service-unit` | every bot box | `whatsapp-bot.service` rendered from the repo, with `deploy/auto-update.sh` before every start |
| `grow-root-disk` | every bot box but WSL | `/` grows into free disk space at every boot |
| `nic-offload` | Hyper-V boxes, WSL included | segmentation offload off now and at every boot on the default-route NIC (uploads 1.5 → 86 Mbit/s on the VM; 162 KB/s → 5 MB/s on WSL's eth1) |
| `start-at-boot` | the box that runs the bot | enabled at boot there - and on no other box |
| `hourly-check` | the box that runs the bot | the hourly check in cron, with a Claude token (`claude setup-token`, then `deploy/install-hourly-debug.sh --set-token`); the cron line is a tick every minute (`deploy/hourly-debug/tick.sh`, which is `run.sh --tick` in a file no older checkout has, so an older `run.sh` can never take the tick for a whole run): on the hour the hourly run, and at any other minute the check only when the bot asked for it at once - a library keeper's #issue, which the bot answers by writing `data/check-now.json` (`src/core/check-now.js`), since it cannot start the check itself - and nothing otherwise, not even a line in `cron.log`. The operator, 2026-10-12: "Needless to say #issue tickets submitted by head admin 5558100180 get top priority" and "Meaning it should activate bot to send yo a notification to check right away"; the scan puts that #issue first, as TOP PRIORITY |
| `sealed-backup` | the box that runs the bot | the nightly sealed backup in cron, `BACKUP_PASSPHRASE` in `.env` |
| `cloudflare-tunnel` | the box that runs the bot | the Cloudflare tunnel to the panel as `cloudflared.service`, its token in `/etc/cloudflared/tunnel-token` (root, 0600) and as `CLOUDFLARE_TUNNEL_TOKEN` in `.env`, so the sealed backup carries it (`deploy/install-cloudflared.sh`; never the dashboard's `docker run`, whose `localhost` is the container; a token that was on a command line is rotated, then `--new-token`); on any other box, a running connector is flagged: it would take half the visits |
| `claude-session` | the box that runs the bot | the Claude Code session back after every reboot: linger on, a user unit running `claude --continue` (or `--resume` a pinned id) in the checkout in a detached tmux session `claude`, enabled at boot but never started by the installer or `--fix`, and a `~/.bashrc` hook that tells an interactive SSH login the session is running, with `claude-attach` to open it (an SSH login is a plain shell: the operator, 2026-10-07; `CLAUDE_ATTACH=1` attaches at login as before) (`deploy/install-claude-session.sh`); it refuses to start while an interactive claude already runs on the checkout, since two processes on one conversation interleave it |
| `temp-sweeps` | inside the bot | leftover upload and work files cleared at start and hourly; a job's files stay until it is sent (or cancelled, or failed for good) |
| `daily-digest` | inside the bot | the daily summary email |
| `drive-links` | inside the bot | the Google Drive Links group's document: every Drive link posted there is kept (`driveLinks.enabled`, `driveLinks.group`), the past from the group's Export chat (`node tools/import-whatsapp-export.mjs "<the .txt>"`, the bot kept only message ids there, never their text), and with `driveLinks.post` an organized docx is posted at 00:00 New York time every night and, tagging them, after members join; skipped while the groups are locked for Shabbos or yom tov (`src/core/drive-links-job.js`; the operator, 2026-10-23) |
| `activity-backup` | inside the bot | the nightly activity record, committed to git |
| `lockdown-schedule` | inside the bot | the Shabbos and yom tov lockdown |
| `failover` | inside the bot | moving to a linked spare number when the main one dies |
| `bot-cmd` | inside the bot | the local command channel, `data/bot-cmd.json`; `requeue` re-runs a failed request once, and with `"repost": true` sends again one that was sent but that WhatsApp would not open ("unusual format" - the hourly check may, for an #issue quoting it) |
| `log-rotation` | inside the bot | the debug log split and pruned |
| `decrypt-watch` | inside the bot | whose messages this number cannot decrypt, named in the log every ten minutes at most (Baileys' logger was silent), for the hourly check's report and `{"op":"decrypt-failures"}` |
| `discord-reader` | inside the bot | the operator's support tickets with the Jellyfin host, read from their own Discord account, read-only, every 30 minutes and once at start, into `data/discord-tickets.jsonl` for the hourly check (`src/core/discord-watch.js`; the operator, 2026-10-11); connected by the super-admin in Settings → Connection → Discord (read-only), the token encrypted with the other secrets |
| `yt-dlp-update` | inside the bot | yt-dlp updated once a day (`-U` on a copy, swapped in whole), never while one of its downloads runs: YouTube breaks an old yt-dlp within weeks |
| `beta-transcript` | inside the bot | every beta group's conversation, edits included, in `data/beta-transcript/`, pruned with the logs |
| `wanted-recheck` | inside the bot | every open film on the wanted list looked up in the library as a request would, three minutes after start, every 30 minutes (six hours until 2026-10-11) and on `POST /api/wanted/recheck` (the Wanted card's Refresh); one the server has is marked resolved by the bot, logged as "… is on the server now (as "…") - marked resolved on the wanted list", and an entry resolved over 30 days ago is pruned. What a run finds is the trigger for telling the members who asked (agreed with the operator, 2026-10-11): after each run, a film it has just found - by its IMDb id across a year gap too ("A Snapshot of Forever", 2025 to OMDb, 2022 on the server) - is re-run for every member answered "not in the library" for it in the last 60 days, as their original request, on their own message, once (a ledger by History row), paced with `_bulkPace`, and held while WhatsApp is down, requests are paused or the lockdown is on (`src/core/wanted-arrival.js`); a member whose film was posted since with another request is marked done instead of being sent it twice. Nothing of it depends on Discord. A film resolved before this began on the box (recorded at the first start, `arrival-reruns-began`), or by an admin or a new request, is never re-run by itself: "Re-run requests" (`POST /api/wanted/:key/rerun`) re-runs it by hand, kept pending until every request is handed over, so a batch stopped part-way is finished by the next pass; `wanted.rerunOnArrival` on the card switches the re-runs off |
| `wsl-systemd` | WSL boxes | `/etc/wsl.conf` asks for systemd, and it runs (`deploy/wsl-setup.sh systemd`, then `wsl.exe --shutdown` from Windows) |
| `wsl-config` | WSL boxes | `%UserProfile%\.wslconfig`: `networkingMode=mirrored`, `vmIdleTimeout=-1` (`deploy/wsl-setup.sh wslconfig`) |
| `wsl-vm-units` | WSL boxes | the units a clone of the Hyper-V VM brings - systemd-networkd, networkd-dispatcher, grow-root-disk, eth0-no-offload, open-vm-tools, tailscaled - disabled (`deploy/wsl-setup.sh vm-units`) |
| `wsl-autostart` | WSL boxes | a Windows scheduled task starts the distro with Windows: the user runs the PowerShell `node tools/wsl-config.mjs --autostart` prints, as administrator |
| `lan-address` | optional | a static LAN address (`deploy/pin-lan-address.sh --static`, the operator's choice: 192.168.20.45 on the bot box, reserved on the router too), or asking the router to keep it |

**A new routine, or any change meant to outlast the session, goes into the
registry, `tools/bootstrap.sh` and this list, in the same commit.** A routine is
anything a box must have for longer than one session: a cron line, a systemd
unit, a token or settings file, a sudo rule, a login, a job the bot runs on a
timer. `test/routines.test.mjs` fails when one is wired into only some of those
places. The owner's test for every change that is not temporary: "If I point a
brand new claude session at the GitHub repo will it know to activate these
routine workflows?"

**Every bug fix and every permanent change lands as code in this repo, with a
test.** The owner's rule: "any bugs that are fixed or requests I make for
permanent changes need to reflect in the repo coding". A fix made by hand on
one box, or a step written down only in a chat, is gone at the next rebuild;
a report is never the deliverable.

## Which machine is this?

The bot gets rebuilt on new Ubuntu servers fairly often, so a clone tells you
nothing on its own. `node tools/routines.mjs` says whether this box runs the
bot; the rest, by hand:

```bash
hostname && pwd
[ -f .env ] && echo "HAS .env — this is a live install" || echo "no .env — bare clone"
ls data/session/creds.json 2>/dev/null && echo "LINKED to WhatsApp" || echo "not linked"
systemctl is-active whatsapp-bot 2>/dev/null
systemctl is-enabled whatsapp-bot 2>/dev/null   # enabled / disabled / masked (an empty unit file)
sudo -n true 2>/dev/null && echo "passwordless sudo" || echo "no sudo without a password"
git config user.email >/dev/null && echo "git identity set" || echo "no git identity: commits fail"
uname -r | grep -qi microsoft && echo "WSL: see below" || echo "a machine or VM of its own"
```

Without passwordless sudo you cannot restart the service, install packages or
change the unit, and a `sudo` call will hang waiting for a password nobody can
type. Do not try: ask the user to run the one command in
[docs/server-setup.md, "Give Claude Code sudo"](docs/server-setup.md#give-claude-code-sudo),
once, over SSH.

**WSL.** Since 2026-09-29 the bot can run in WSL2 on the operator's Windows
laptop rather than in a Hyper-V VM, for the GPU: Hyper-V GPU partitioning
refused CUDA and NVENC to the VM, and WSL runs NVENC. `uname -r` ending in
`microsoft-standard-WSL2` (or `WSL_DISTRO_NAME` set) means this is one, and
then: systemd runs only if `/etc/wsl.conf` asks for it, the network is the
laptop's own (mirrored), sshd is on port 2222, `wsl.exe --shutdown` from
Windows stops the bot, and WSL comes back after a Windows reboot only through
a scheduled task. The hourly check's usual sandbox cannot start on WSL (WSL's
init holds the one seccomp listener a process may have), so there
`sandbox.py` runs the research session in user, PID and mount namespaces of
its own instead, with `/mnt` (the Windows drives) hidden; `sandbox.py --mode`
says which one a box gets. `node tools/routines.mjs` checks all of it;
[docs/server-setup.md, "Running on WSL (for the GPU)"](docs/server-setup.md#running-on-wsl-for-the-gpu)
has the setup, and the move from a Hyper-V VM.

- **Bare clone** (no `.env`, no `data/`): a development box. Safe to edit and
  run tests. Do not `npm start` casually — first boot mints a `MASTER_KEY` and
  writes `.env`.
- **Live install**: the bot is serving real groups. Everything below applies
  with force. Read [docs/operations.md](docs/operations.md) before starting,
  stopping or restarting anything.

**A new VM is built with one paste:**
[docs/server-setup.md, "One paste: a new VM in one go"](docs/server-setup.md#one-paste-a-new-vm-in-one-go),
the operator's request (2026-09-29). One block, pasted over SSH, installs
`gh`, clones the repository and runs `tools/bootstrap.sh`, which restores
every setting, login and key from the encrypted `sealed-backup` branch
(`src/core/sealed-backup.js`) and sets up every routine above. Only the
GitHub, Claude and Tailscale sign-ins need a person; bootstrap's questions
all come first, and `BACKUP_PASSPHRASE`, `OLD_BOT_STOPPED`, `LAN_ADDRESS`,
`PASSWORDLESS_SUDO`, `REMOVE_INSTALLER_SNAPS` and `TS_AUTHKEY` answer them in
advance (`tools/bootstrap.sh --help`). When installing Ubuntu, leave every
"featured server snap" unticked; bootstrap offers to remove them if not
(`tools/remove-installer-snaps.sh`). The same guide's "Fast path" is those
steps by hand, and the rest of it is the long way round. The Cloudflare
tunnel comes back too, from `CLOUDFLARE_TUNNEL_TOKEN` in the restored `.env`
(`deploy/install-cloudflared.sh --from-env`, once the bot runs on the box);
the first time, it is set up with `deploy/install-cloudflared.sh`, never with
the `docker run` command the Cloudflare dashboard offers (its section 7 says
why). Nothing secret is ever committed in the clear; keep it that way.

## Rules that are not style preferences

These come from things that already went wrong. `docs/whatsapp-ban-risk.md` has
the counts from real logs.

1. **Never add a loop that calls WhatsApp without `_bulkPace()`.** `npm test`
   fails if you do.
2. **Never shorten the reconnect ceiling** (`whatsapp.maxReconnectDelayMs`,
   default 15 min) to make recovery feel snappier. A flat 60-second retry
   produced 1,057 connection attempts in one day and is the likeliest cause of
   the six real logouts. If reconnecting feels too slow for a *human* waiting
   on a QR, fix the linking path — see `_linking` in `src/core/bot.js` — not
   the ceiling.
3. **Never let two processes hold the same WhatsApp session.** Two live sockets
   on one number is `connectionReplaced`, which is the single most
   account-flagging thing this project can do.
4. **If WhatsApp rate-limits something, back off.** Retrying harder is what
   earns escalating penalties.
5. **Never delete outside the work directory.** `isSafeToDelete()` guards this
   because when Jellyfin's storage is mounted here, the "local copy" and the
   user's original are the same inode.

## Running it

```bash
npm test          # no network, no WhatsApp. Run it before and after every change.
npm start         # ./start.sh — bundles certs/ into NODE_EXTRA_CA_CERTS, then node src/index.js
```

Which suites are *expected* to fail depends on how the box was installed, so
check this before chasing a regression:

| Install | Expected failures |
|---|---|
| `npm install` (dev) | `content-export`, `rules-freshness` — both read gitignored files under `data/` |
| `npm install --omit=dev` (production) | those two, **plus** `ai-key-test-panel`, `api-keys-section`, `beta-panel`, `connection-select`, `csv-export`, `fresh-install-checklist`, `hourly-checks-panel`, `login-autofill`, `portal-search`, `queue-panel-requests`, `settings-group-pickers`, `settings-reach`, `wanted-panel` — all thirteen stub a DOM with `linkedom`, which is a devDependency and is therefore absent |

Everything else must pass. To run the full suite on a production box, install
the dev dependencies there: `npm install --include=dev`.

If `node` is missing, it is either at `/usr/bin/node` (NodeSource) or
`~/.local/node/bin/node` (tarball). `start.sh` finds the second one; systemd
needs an absolute path in the unit.

## Layout

```
src/
  index.js              entry, wiring, MASTER_KEY bootstrap, shutdown
  core/
    bot.js              Baileys connection, reconnect/link lifecycle, pacing, budget
    failover.js         switching between numbers when one dies
    accounts.js         several numbers, one per session directory
    queue.js            serial job queue
    request-pause.js    requests paused from the panel: ⏸️, held, run in order on resume
    state.js            persistent key/value  ->  data/state.json
    wanted.js           films people asked for that we do not have (a shopping list), resolved and noted by admins
    wanted-recheck.js   that list looked up in the library again, so what has arrived is resolved
    wanted-arrival.js   what the recheck finds, re-run for the members who were told "not in the library"
    library-misses.js   requests refused ONLY for not being found (a fault log)
    discord-reader.js   the operator's Discord account, read-only by construction (GET, allowlisted paths)
    discord-watch.js    their support tickets with the Jellyfin host, read every 30 min for the hourly check
    audit-filter.js     bucketing for the portal audit log
    beta.js             feature flags + the beta test group (see "beta first" below)
  media/                ffmpeg probe/convert, download, broadcast
  plugins/
    movie-requests/     OMDb -> rating gate -> Jellyfin -> queue
    tv-requests/        parse -> Jellyfin series/season/episode -> queue
      jellyfin-tv.js    findSeries() — the ONLY thing that can find a show
    direct-links/  echo/
  web/                  Express API + the single-page panel in public/
  config/               schema.js (defaults) + store.js (encrypted at rest)
data/                   ALL runtime state. gitignored. see docs/server-setup.md
```

## Things that are easy to get wrong here

**`findSeries()` is a chokepoint.** It is the only function in the codebase
that can find a TV series — for the TV plugin *and* for the movie plugin's
"actually, that is a series" escape hatch. Every "not in the library" answer
about a show is its verdict. It is deliberately layered (plain search →
`/Search/Hints` → unscoped → enumerate-and-match-locally) because Jellyfin's
`/Items?searchTerm=` is a weak, un-tokenised filter, scoped to the bot's
Jellyfin account, and is **not** the endpoint the Jellyfin web UI uses. That
mismatch is why a show can be plainly visible to a human and invisible to the
bot.

**A library can hold the same show twice.** An empty leftover folder next to
the real one (bot-box had fourteen, American Dad! and Supernatural among them),
or one show split across two folders, each with some seasons. `findSeries()`
swaps an empty winner for a same-titled entry with episodes, and
`resolveEpisodes()` takes a season the picked entry lacks from a same-titled
entry that has it — whole, never merged, since two entries sharing a title can
be two different shows.

**The bot searches Jellyfin as its own account.** If that account cannot see a
library, the bot reports "not in the library" and is, from where it sits,
telling the truth. Check library access and Max Parental Rating on the bot's
Jellyfin user before assuming a code bug.

**Secrets are encrypted with `MASTER_KEY` from `.env`, and a wrong key fails
silently** — `decrypt()` returns `''` rather than throwing. A panel where every
API key looks blank and your password is rejected means the key does not match
the data, not that the settings were lost.

**The movie and TV plugins keep separate stores.** Anything that reports across
both — history, the daily digest, the not-in-library list — has to read both
namespaces and merge. Forgetting the TV half is a recurring bug.

**The panel is push-only over SSE.** It does not poll for status. Anything that
must update while nothing is changing needs its own local timer.

**The AI content check only ever helps a request through** - it may clear a
rated title, never deny one, and a bypass-list title is sent without it
(operator, 2026-09-29): see `src/plugins/movie-requests/content-check.js`.

## Shipping a group-facing feature: beta first

The main posts group has hundreds of members, and some mistakes there cannot
be taken back. So anything a group member would notice — a new reply, a
reaction, a notification, a moderation rule — goes through the beta group
first. `src/core/beta.js` is the whole mechanism.

**The operator decides what goes through beta, not the session.** A feature the
operator asks for directly ships On, with no flag, unless they ask for beta.
Bringing behaviour one group already has to another group never needs beta.
TV place in line, the movie group's number reactions brought to the TV group,
was put on Beta without being asked for. The operator (2026-09-29): "if it's
always worked in the movie group why would it need to go to beta? I didn't
instruct you to make that a beta". Beta is for a change nobody has seen work
yet that the operator has not already signed off on. When in doubt, ask.

- **Register it.** Add `{ key, code, label, description, howTo, scope }` to
  `FEATURES`, with the next unused betaNNN code. It
  then appears on Settings → Beta 🧪 with an Off / Beta / On control, starting
  at Off.
- **Ask at the decision point.** While the message is being handled, that is
  `isEnabled(ctx.config, key, msg.chatJid)`, with the chat the request *came
  from*. Anything decided after the job is queued — in `deliver()`, a caption,
  a post format — is `isEnabledForJob(ctx.config, key, route)` with the job's
  stored route: which groups are beta can change while a job waits, and `msg`
  is null for a TV job queued from the panel. Keep the old behaviour as the
  other branch, untouched.
- **A beta group takes tests only, and a test delivers nothing** (the
  operator, 2026-09-29). A message there counts only when it starts with the
  code of a feature on Beta or On - `$beta004 #request minority report
  2002`, or the explicit `#request-movie` / `#request-tv` forms - and
  anything else is ignored with one log line: "if someone requests a regular
  movie like captain Phillips it should be ignored because it's not the
  beta". An unknown, retired or Off code gets ❓ and the tests running now (a
  retired one is also pointed at `$stamtest`); the other
  kind than the code's feature gets one line saying so (`readBetaTest`). A
  test runs every check a real request would, and where it would be queued
  it answers ✅ "Test passed" with what it would have sent - nothing is
  downloaded, queued or journalled, a History row says `test-passed`, and
  nothing a test does touches the wanted or not-in-library lists. Duplicate
  tests are judged against the real queue. So when you add a feature, make
  its test answer say what the feature does (see `_testPassed` and
  `_testPassedTv`); test-mode cases are in `test/beta-test-mode.test.mjs`.
  Every beta-group conversation is transcribed word for word, each edit of a
  bot message included (`src/core/beta-transcript.js`), and the hourly check
  reviews it (`src/core/beta-scan.js`) - the operator should never have to
  report a test by hand.
- **`$stamtest` tries any request as a main group would judge it** (the
  operator, 2026-09-30). `$stamtest #request-tv friends s03 e06, e08` in a
  beta group runs as a test of no feature: only features that are On apply
  (`featureGroup`), nothing is sent, and while the plugins run, bot.js
  gathers every reaction, reply and deletion instead of sending it
  (`src/core/stam-test.js`). The plugin manager then sends ONE message that
  quotes the request and says what the bot would have done, to be pasted
  outside the group with its context. A new way of sending, reacting or
  editing in bot.js must call `stamIntercept()` too, or it leaks from a
  `$stamtest`; `test/stam-test.test.mjs` covers it.
- **Anything still sent from a beta route stays isolated.** A request from a
  beta group carries a route, fixed when it arrives, whose `notifyGroup` is
  where its refusals and questions are said. Its delivery half (the beta
  posts group) is only for jobs an older bot journalled, and recovery drops
  those rather than download a test. Read a route through `safeRoute()` at
  the moment of sending, which withholds anything whose destination has since
  become a main group.
- **Promote Off → Beta → On.** Beta means the test groups only; On means every
  group. Leave a feature on Beta until it has been watched working on the real
  flow.
- **Then delete the flag.** Once a feature has been On for a while, remove its
  registry entry and the dead branch. A flag nobody will turn off again is a
  second code path that still has to work. Never reuse a retired key: its old
  mode can still be in `config.json`, and a new feature would inherit it, so
  its code goes into `RETIRED_CODES`, and its default, if it has one, leaves
  `DEFAULT_CONFIG.beta.features` (the three features there now are On by
  default on a new install, the operator's live modes of 2026-10-12; a
  `config.json` saved before then keeps every one it never named Off,
  `keepSavedChoices` in `src/config/store.js`). Do it as soon as the
  operator says a feature is out of beta: a mode is a setting, and a setting
  is lost with a rebuilt box or a restored config. beta001, the "which one?"
  list, was out of beta by the operator's word while the live `config.json`
  held `beta.features: {}`, and on 2026-10-10 Heat, Insomnia and Venom were
  asked "which year?" instead of being listed ("we already moved that ... out
  of beta, so why didn't it work for those?"). It has had no flag since.

An empty beta config must behave exactly like a bot without one; the
regression cases in `test/beta.test.mjs` pin that.

## House style

Match what is already there rather than importing habits from elsewhere.

- Comments explain **why**, especially when the code looks odd. Most odd-looking
  code here is odd because of a specific incident; say which. Do not narrate
  what the next line does.
- Prose in comments and docs, not fragments. Full sentences.
- Tests are plain `.mjs` files with a hand-rolled `ok()` — no framework.
  `tools/run-tests.mjs` picks up anything in `test/`. Every bug fix gets a test
  whose name states the behaviour, and whose header comment states the incident.
- Errors on a user-facing path get a reaction or a reply, a log line, and a
  durable record. A silent `return` is how a bug stays invisible for months.
- No dependencies without a reason. The list in `package.json` is short
  deliberately.
- Every time the bot or the panel shows is on the 24-hour clock — the
  operator's rule. Format with `hourCycle: 'h23'` (in the panel,
  `fmtDateTime` / `fmtClock`), never `hour12: false`, which writes the hour
  after midnight as 24. `test/clock-24h.test.mjs` fails on anything else.

## Pushing to `main` deploys it

Every installed box runs `deploy/auto-update.sh` before each start and
fast-forwards to `origin/main`. A commit on `main` is therefore live on every
box the next time it restarts — a reboot, a crash, anybody's `systemctl
restart` — with nobody watching. The updater refuses code that does not parse
and takes back out a commit that crash-loops (3 systemd restarts within 10
minutes), but it cannot catch a commit that runs and misbehaves. Work that is
not ready goes on a branch. Details: [docs/operations.md](docs/operations.md#upgrading).

`main` also moves by itself. An hourly cron job, the hourly check
(`tools/hourly-debug.mjs`), researches failed and unanswered requests with
headless Claude Code, pushes fixes that pass the suite, and restarts the bot
into them; its commits end with `Hourly-Check: <run id>`. Pull before you
branch, and see [docs/operations.md](docs/operations.md#the-hourly-check).

## Before you finish

```bash
npm test
```

And if you touched the WhatsApp path, re-read rule 1 and rule 2 above. If
you added anything a box has to keep running - a cron line, a unit, a token
file, a timer in the bot - it is in `src/core/routines.js`, `tools/bootstrap.sh`
and the routines table at the top, and `node tools/routines.mjs` knows it.
