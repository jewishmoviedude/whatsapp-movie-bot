# Running the bot: starting, stopping, and moving it between machines

The day-to-day operational manual. Building a box from scratch is
[server-setup.md](server-setup.md); what could get the number banned is
[whatsapp-ban-risk.md](whatsapp-ban-risk.md).

---

## The one rule

**Only one machine may hold a given WhatsApp session at a time.**

Two processes linked as the same number produce `connectionReplaced` — each
socket displaces the other, and each displacement is a fresh link event on an
account WhatsApp is already watching. The logs from this project contain 168
overlapping-socket warnings and six real logouts; that pattern is what earns
them.

So:

- Two machines, **two different numbers** — fine, and covered
  [below](#two-machines-two-numbers).
- Two machines, **the same number** — never, even for a minute. Stop one before
  starting the other.
- "I'll just leave the old one running as a backup" — this is the mistake. A
  stopped bot is a backup. A running one is a conflict.

Before starting the bot on any box, confirm nothing else is holding that
number:

```bash
systemctl is-active whatsapp-bot        # on every machine that has ever run it
```

---

## Which machine am I on?

A fresh session should establish this before touching anything.

```bash
hostname && whoami && pwd
ls -d ~/whatsapp-bot ~/whatsapp-bot 2>/dev/null   # where is the clone?
systemctl is-active whatsapp-bot cloudflared 2>/dev/null
[ -f ~/whatsapp-bot/.env ] && echo "HAS .env (this box has real state)" || echo "no .env (fresh clone)"
ls ~/whatsapp-bot/data/session/creds.json 2>/dev/null && echo "LINKED to WhatsApp" || echo "not linked"
```

A box with no `.env` and no `data/` is a bare clone — it has never run, and
starting it will mint a *new* `MASTER_KEY` and a blank config. That is fine for
development and wrong for production.

---

## Routines every box runs

Everything a bot box keeps running - the service and its updater, the disk
and NIC fixes, sudo, gh, Tailscale, Claude Code, the hourly check, the nightly
sealed backup, the Cloudflare tunnel, and the jobs the bot runs on a timer
inside itself - is one registry, `src/core/routines.js`, checked by one
command:

```bash
cd ~/whatsapp-bot
node tools/routines.mjs          # each routine: ok / missing / needs-user, with the next command
node tools/routines.mjs --fix    # activate everything that needs no person, then check again
```

It exits 0 only when every routine that applies to this box is in place. A
new Claude session runs it first (CLAUDE.md, "Routines every box runs");
`tools/bootstrap.sh` installs every routine and runs it as its last step.

It is safe on any box, including one that does not run the bot. The box whose
`whatsapp-bot.service` is active is the one that runs it; there the hourly
check, the nightly backup, the Cloudflare tunnel and starting at boot are
checked and installed. On any other box they are reported as belonging to the
box that runs the bot - and an enabled-at-boot unit there is flagged, because
its next reboot would start a second bot on the number
([the one rule](#the-one-rule)), as is a tunnel connector running there,
because Cloudflare would send it half the panel's visits. Nothing in
it starts, stops, restarts or enables the bot. `--fix` runs only from the
checkout the service runs, and never as root.

What `--fix` cannot do, it prints for you to run. The one-time steps:

- **Passwordless sudo**, once, with your password:
  [server-setup.md, "Give Claude Code sudo"](server-setup.md#give-claude-code-sudo).
  Every root-level fix (units, packages, Tailscale settings) needs it; without
  it they are printed as commands instead.
- **The hourly check's Claude token**, once, on the box that runs the bot:
  `~/.local/bin/claude setup-token` (a browser login, on any computer), then
  `deploy/install-hourly-debug.sh --set-token` and paste it (read without
  being shown, saved mode 600, tested with one tiny call). See
  [server-setup.md, "The hourly check's token"](server-setup.md#the-hourly-checks-token).
- **The backup passphrase**, once, on the box that runs the bot:
  `node tools/backup-secrets.mjs --set-passphrase --install-cron`.
- **The Cloudflare tunnel's token**, the first time only, on the box that
  runs the bot: `deploy/install-cloudflared.sh`, and paste it (read without
  being shown). It keeps a copy in `.env`, so every box after that gets it
  from the sealed backup. Never the dashboard's `docker run` command:
  [server-setup.md, section 7](server-setup.md#the-permanent-one-cloudflare-tunnel)
  says why. A token that was on a command line (that `docker run`, or
  `cloudflared service install <token>`) is in sudo's log: rotate it in the
  dashboard, then `deploy/install-cloudflared.sh --new-token`.
- **Logins**: `gh auth login`, and `sudo tailscale up --ssh --operator=$USER`.

A routine this box does without on purpose is recorded, and then reported as
skipped rather than missing:

```bash
node tools/routines.mjs --skip sealed-backup --reason "runs a second number; the branch is bot-box's"
node tools/routines.mjs --unskip sealed-backup
```

`tools/bootstrap.sh --new-number` records that one itself, and a "no" to its
passwordless-sudo question is recorded the same way. `node tools/routines.mjs
--list` prints every routine with why it exists, how it is checked and how it
is installed.

---

## Starting and stopping

There are five levels, from least to most disruptive. Picking a heavier one
than you need throws away work: a film mid-encode is a multi-gigabyte download
and twenty-odd minutes of CPU that nothing recovers.

### Ask first: is it safe?

The bot reads its own queues and answers. This matters because the media queue
and the direct-links queue share a log scope, so reading the log by eye has
given the wrong answer more than once.

```bash
echo '{"op":"queue-status"}' > ~/whatsapp-bot/data/bot-cmd.json \
  && sleep 5 && cat ~/whatsapp-bot/data/bot-cmd.result.json
```

`"safeToRestart": true` means nothing is running, waiting, or waiting to be
retried. If false, `running` names what is in flight and `retryingNow` what
lost its send and is about to go again (a restart replays those from the
journal, later). The Queue card lists the retrying ones too, with a Cancel.

### 0. Pause requests — no restart

Dashboard → **⏸️ Pause requests**, in the Queue card (the operator's request,
2026-10-01: for "testing something" without closing the bot or locking the
groups). From then on:

- Every request from a movie or TV request group gets ⏸️ and waits - a typed
  request, and a number answering a "which one?" list. A number given by
  reacting to the list waits the same way, with its ⏸️ on the request the
  list answers (the bot never reacts to a reaction); when it runs, that ⏸️
  goes back to 🔍 and then to the usual reactions. A pick that waits past the
  list's ten minutes is still that list's pick: the same number sent again is
  ignored, not deleted or taken for a new request. Chatter is moderated as
  ever and never gets ⏸️. The cooldown applies when a request arrives (🚫 if
  the member's clock is running), and again when it runs on resume, as if it
  had just arrived: a held request has queued nothing, so it starts no clock,
  and when the first of a member's held requests queues on resume, their
  next one gets 🚫 in place of its ⏸️ rather than queueing beside it. At most
  five of one member's requests are held in each section (the flood
  backstop counts them as answers to come); the sixth gets 🚫 as it arrives.
- The queue is paused with them: nothing new starts, and whatever is
  downloading, converting or uploading finishes.
- Not paused: the beta groups (tests, `$stamtest`, `$betaNNN` - the pause is
  for while something is being tested there), the direct-links groups, and
  anything queued from this panel or the box, which waits in the paused queue.

A banner at the top of the dashboard says "Requests paused since 14:02 by
<admin> · N held", with whose they are. **▶️ Resume requests (runs N held)**
resumes the queue too if this pause paused it (one already paused by hand
stays paused), then runs the held requests, in the order they came, paced
like any bulk work: each is handled as if it had just arrived, and its ⏸️
gives way to the usual reactions. Nobody has to send anything again.

The pause and the held requests are kept in `data/state.json` and survive a
restart. A restart while paused comes back paused; a restart part-way through
the held requests runs the rest once WhatsApp is up.

From the box, with the bot running, the same two buttons are ops of the
command channel (audited like the panel's):

```bash
echo '{"op":"pause-requests","by":"your name"}' > ~/whatsapp-bot/data/bot-cmd.json
echo '{"op":"resume-requests","by":"your name"}' > ~/whatsapp-bot/data/bot-cmd.json
```

`health` and `queue-status` say `"requests": { "paused", "since", "by",
"held", "replaying", ... }`. Held requests waiting do not make
`safeToRestart` false: they are on the disk. Held requests being run do
(`"replaying": true`): each is taken off the disk as it is handed over, and a
film request still being looked up has nothing else on the disk yet, so a
restart then would lose it. A replay takes a few seconds a request; wait for
it.

**Restarting with no moment in which a request runs.** A pause made while the
bot is stopped is in force from the first message it handles. Ask first
whether it is safe (above), then, as one line:

```bash
cd ~/whatsapp-bot && sudo systemctl stop whatsapp-bot \
  && node tools/pause-requests.mjs on --by "your name" \
  && sudo systemctl start whatsapp-bot   # every request now gets ⏸️ until Resume
node tools/pause-requests.mjs status     # what the file says, any time
```

Chained with `&&`, so that when `on` refuses (the stop had not finished, or
`state.json` is not where it looks) the bot stays stopped rather than starting
unpaused - the very moment this is meant to avoid. Read why it refused, fix
that, and run it again before starting. Started, the journal says
`⏸️ requests are PAUSED (since …)` before WhatsApp connects.

The queue is paused with the requests, and a restart puts the jobs it
interrupted - a film that was converting or uploading - back in that paused
queue, so they wait too rather than finish: until **▶️ Resume requests**, or
until the queue's own **Resume**, which lets them go on while requests stay
paused. `on` says so as it finishes.

`tools/pause-requests.mjs on|off|status` refuses `on` and `off` while
`whatsapp-bot.service` is active or a `node src/index.js` runs on this
checkout: a running bot keeps `state.json` in memory and writes it back within
half a second, so an edit made under it is lost. It finds the data directory
as the bot does - `DATA_DIR` from the environment, then from the checkout's
`.env`, then `data/` - and refuses `on` and `off` when that has no
`state.json` on a checkout with a `.env`, which means it is not the file the
bot reads. `on` writes, in `data/state.json` (`$DATA_DIR/state.json` where
that is set):

```json
"request-pause": { "state": { "paused": true, "since": 1790000000000, "by": "your name", "pausedQueue": true } },
"queue-pause":   { "state": { "paused": true, "since": 1790000000000, "by": "your name" } }
```

`pausedQueue` is whether the request pause paused the queue (false when the
queue was already paused, which `on` then leaves as it was); `off` clears the
request pause, and the queue's too when `pausedQueue` says so. The held
requests, `"request-pause"."held"`, are never touched by the tool: after an
`off` they run, in order, when the bot next connects.

### 1. Pause the queue — no restart

Dashboard → **Pause**. New jobs stop starting; anything already downloading or
encoding finishes. WhatsApp stays connected, so requests still arrive and
queue. This is usually what you actually want.

The queue's Pause is kept across a restart (`"queue-pause"` in
`data/state.json`): it used to live in memory only, so a restart quietly
undid it and the queue started again. The Queue card says since when and by
whom it is paused. Pausing or resuming the queue by hand while requests are
paused takes it over from the request pause: Resume requests then leaves it as
you set it.

### 2. Disconnect WhatsApp — the panel keeps running

Dashboard → **Disconnect**. Ends the WhatsApp connection; the panel stays up.
The saved session is **not** wiped, so reconnecting needs no re-linking.
Anything mid-upload dies with the socket.

This is the "deactivate" step. Use it before starting the bot elsewhere on the
same number.

Do not confuse it with **Unlink & wipe session**, which erases the session and
forces a full re-link from the phone.

### 3. Restart the process

```bash
sudo systemctl restart whatsapp-bot
journalctl -u whatsapp-bot -f
```

Without the service installed, kill by pid — `pkill -f 'node src/index.js'`
also matches the shell you typed it in, which kills the restart along with the
bot:

```bash
kill $(pgrep -x node | while read p; do tr '\0' ' ' < /proc/$p/cmdline | grep -q 'src/index.js' && echo $p; done)
cd ~/whatsapp-bot && setsid nohup ./start.sh > /tmp/bot.log 2>&1 < /dev/null &
```

Interrupted jobs are journalled and re-queued on the next start, and a
restart resumes each job from the furthest step it finished: a download from
the byte it reached (asked for with Range and If-Range, so a library file
replaced meanwhile is fetched whole instead), a download that finished is
converted without being fetched again, a conversion from its last finished
5-minute piece, a finished file is sent as it is, and a file already posted
is not posted again - to any group it reached. A TV
episode that gives the download slot to a film goes on from where it stopped
too. A download that ends short of the length the library gave is an error
(`download ended early`), retried from where it stopped, never a finished
file. Each job keeps its files in a directory of its own,
`data/media/job-*/`, with a `manifest.json` saying what they are, which
library file they came from and how far the job got; the start-up and hourly
sweeps leave alone every directory a journal still holds. Before building on
kept files a resumed job asks the library whether its file is still the same
one (its length and Last-Modified, or for a file read in place, the file on
the disk), and starts again if it is not; if the library does not answer, the
job waits and asks again, keeping its files. (The Parent Trap, 2026-09-29,
was downloaded and 23 minutes into its encode when a restart made it start
over from the first byte - twice.)

**Nothing in a job's directory is deleted until WhatsApp has taken the
file.** The download stays beside the converted file through the upload,
and the whole directory goes once the send has resolved - or once the job is
cancelled or skipped by an admin, or fails for good after its retries. The
operator, 2026-09-30, after the restart that brought these directories in
deleted three fully converted films the older build had made (La La Land's
upload was running, and it began again from the download): "in the future
files should remain in their folders until fully sent on whatsapp to avoid
this". So a restart at any step goes on from that step and sends once:
after the download it converts, mid-encode it goes on from its pieces, with
the file made (the upload cut off part way included) it sends it, and after
the send it does not send again. Nothing is deleted to make room on the disk
either (see [When the disk fills](#when-the-disk-fills)). The only files that
go early are ones nothing can be built on: an encode ffmpeg was killed in the
middle of, a segmented encode's pieces once the file joined from them is
recorded, and work whose library file has been replaced since.

What a job has done is kept however it is interrupted, not only by a
restart:

- A restart during recovery loses nothing: films stay in the journal while
  they are looked up again, each stamped with the starts that tried to put
  it back. One that no start manages to put back three times running (its
  recovery is what stops the bot) is given up with ⚠️ and a History row.
- A film whose three retries in the running process are spent keeps its
  work for the next start (`… will retry on next start, going on from what
  it had done`), which the hourly check's restart then goes on from. It holds
  no room in the meantime, but it is never given up for another job: a job
  that cannot fit beside it waits for it to be sent (see below). Asking for
  the film again hands the work to the new request.
- A piece, the sound pass or the join whose ffmpeg is killed or cannot start
  is made again from the pieces already made (`… could not be made this
  time`); only the same step failing twice sends the film to one pass.
- A film read in place from a mounted library is read from one open file
  for each run, and checked before every step: a library file replaced
  during the encode resets the work and starts again from the new file,
  rather than joining pieces of two different files.
- Whether a film or episode was posted is read first, from its work and
  from its journal entry, and the journal's removal is on the disk before
  the work is deleted: a film posted just before a restart is never posted
  again, whatever the library says by then.

A re-encode is made in pieces of `media.segmentSec` (300 s), each begun
`media.segmentWarmupSec` (5 s) early so the picture after a join is as good
as one pass's, joined by stream copy, with the sound encoded whole in a pass
of its own (`src/media/segmented.js`). Each piece is checked before it is
recorded - its frame count, a keyframe first, its first and last times, the
same codec parameters as the first piece - and so is the joined file. A
source that cannot be cut exactly (a variable frame rate, under two pieces
long, more than one video stream, a CPU encoder other than libx264, ffmpeg
older than 5.1), or a piece that fails its check, is encoded in one pass as
before, and the log says why: `encoding … in one pass: …`. A restart mid-encode
logs `converting … from piece N of M`. `media.segmentedEncode: false` in
`data/config.json` turns it off: every encode is one pass.

On the GPU (`media.videoEncoder`, h264_nvenc) the pieces are made the same
way, every one at the same bitrate: NVENC writes the bitrate into the SPS, and
pieces with different SPS cannot be joined. A piece NVENC fails or makes
unlike the first, or pieces that would not fit under the cap, send the job
back to its first piece on libx264 (`making its pieces again with libx264`),
counted towards the three failures that leave the GPU alone (an overshoot is
not), and noted on the job, so a restart goes on with the CPU pieces. GPU
and CPU pieces are never joined into one film.

### 4. Deactivate the machine entirely

Stops it now and stops it coming back after a reboot:

```bash
sudo systemctl disable --now whatsapp-bot
systemctl is-enabled whatsapp-bot     # -> disabled
sudo systemctl disable --now cloudflared   # if it runs the tunnel, and the bot is moving elsewhere
```

A tunnel connector left running on a box whose bot is off keeps taking visits
(half of them, once another box runs the tunnel too) and answers each with an
error. Reactivate:

```bash
sudo systemctl enable --now whatsapp-bot
sudo systemctl enable --now cloudflared    # if it ran the tunnel (or: node tools/routines.mjs --fix)
```

`stop` alone leaves the unit enabled, so the next reboot brings the bot back —
and if you have meanwhile started it on another machine with the same number,
that reboot creates exactly the conflict this document opens with. **To take a
machine out of service, `disable`, not just `stop`.**

### Rebooting

With the service enabled the bot comes back on its own. Without it, nothing
starts it and it will sit down until someone runs the command by hand. That is
the single best reason to install the unit.

### Getting back into the Claude session after a reboot

The operator asked (2026-09-30): "How do I set in the vm that this session
... should automatically resume after a reboot?" A Claude Code session typed
into a plain SSH login ends with the login, and a reboot ends every login.
`deploy/install-claude-session.sh` (the `claude-session` routine, which
`node tools/routines.mjs --fix` and bootstrap set up on the box that runs the
bot) makes it come back:

- linger is turned on for your user, so your user units start at boot with
  nobody logged in;
- `~/.config/systemd/user/claude-session.service` runs, at boot, `claude
  --continue` in the checkout inside a detached tmux session called `claude`.
  `--continue` is the most recent conversation in that folder, permission mode
  included. It waits up to two minutes for the network first;
- a hook in `~/.bashrc` attaches an interactive SSH login to that tmux
  session, with one line saying so. `scp`, `rsync`, `ssh host cmd` and the
  hourly check's commands are never touched.

To get back in: **just SSH in**, or run `tmux attach -t claude`. **Ctrl-b d**
detaches and leaves the session running; you are back at an ordinary shell.
To SSH in without attaching: `ssh -t <host> CLAUDE_NO_ATTACH=1 bash -l`
(or attach, then Ctrl-b d).

**Never run `claude --resume` or `claude --continue` on the same conversation
while the tmux one runs.** Two processes on one conversation write into one
transcript with no lock, and their messages interleave. Attach instead. For
the same reason the unit refuses to start while an interactive claude already
runs in the checkout (the log says which one), and the installer and `--fix`
only *enable* it: it starts at the next boot. To start it without a reboot,
once you have exited every other claude in the checkout:
`deploy/install-claude-session.sh --start-now`. A session you end with `/exit`
stays ended until the next boot.

To resume one particular conversation instead of the most recent one:
`deploy/install-claude-session.sh --pin <session id>` (it goes into
`~/.config/whatsapp-bot/claude-session.env` as `CLAUDE_SESSION_ID`, and the
unit then runs `claude --resume <id>`); `--unpin` goes back.

What it is doing: `deploy/install-claude-session.sh --status`, and the unit's
log, `journalctl --user -u claude-session` (also
`~/.local/state/whatsapp-bot/claude-session.log`). To turn it off:
`deploy/install-claude-session.sh --remove` (the unit and the hook go; a
session running now keeps running until `tmux kill-session -t claude`, and
linger stays, harmless on its own, until `sudo loginctl disable-linger $USER`).

---

## Handing the bot over to another machine

The safe order. Do not overlap the two halves.

If the machine giving it up keeps the [sealed backup](#backups), the new one
needs no copying at all. On the old one: wait for `safeToRestart` and stop and
disable its bot, exactly as below, and only THEN run
`node tools/backup-secrets.mjs`, so the backup is the bot's final state and
says the bot was stopped - and before that backup, if this box runs the
Cloudflare tunnel, `deploy/install-cloudflared.sh --record-env`, so `.env`
holds its token (below). The other way round, the new machine restores a
copy that is missing whatever the old bot wrote after it (the state flushed
at shutdown, the outbound budget, session and pre-key updates), and re-queues
jobs the old bot had already finished; `tools/bootstrap.sh` asks before it
restores a backup taken with the bot running. Then build the new one with the
[fast path](server-setup.md#fast-path-rebuild-from-the-sealed-backup), and on
the old one, `node tools/backup-secrets.mjs --remove-cron`.

**The Cloudflare tunnel moves with the bot.** Its token is in `.env` as
`CLOUDFLARE_TUNNEL_TOKEN` wherever `deploy/install-cloudflared.sh` recorded
it - but not on a box whose tunnel was set up before the script kept it
there (bot-box2's, on 2026-09-30), which is why `--record-env` comes before
the last backup: it copies the token in from `/etc/cloudflared/tunnel-token`
and says so when it is there already (`node tools/routines.mjs` exiting 0
says the same). Then the new box gets it with the restore, and
bootstrap (or `node tools/routines.mjs --fix`) starts `cloudflared.service`
there once the bot runs. Stop it on the old box, in the same breath as the
bot: two connectors on one token are replicas, and Cloudflare sends each visit
to either, so half would reach a box whose bot is off. The routines check on
the old box flags it until it is stopped.

The rest of this section is the manual way.

**On the machine giving it up:**

```bash
cd ~/whatsapp-bot
echo '{"op":"queue-status"}' > data/bot-cmd.json && sleep 5 && cat data/bot-cmd.result.json
# wait for safeToRestart: true, or accept losing what is in flight

sudo systemctl disable --now whatsapp-bot
systemctl is-active whatsapp-bot        # -> inactive
deploy/install-cloudflared.sh --record-env   # if it runs the tunnel: its token into .env, which goes across below
sudo systemctl disable --now cloudflared     # if it runs the tunnel

tar czf /tmp/bot-state.tgz .env data/config.json data/state.json \
        data/session data/sessions data/outbound-budget.json 2>/dev/null
```

Move `/tmp/bot-state.tgz` across — `scp`, or through the tunnel, but not
through anywhere it will sit around. It contains the WhatsApp session and the
key to every stored secret.

**On the machine taking it over** (already built per
[server-setup.md](server-setup.md) through step 4):

```bash
cd ~/whatsapp-bot
tar xzf /tmp/bot-state.tgz
chmod 600 .env && chmod 700 data
sudo systemctl enable --now whatsapp-bot
deploy/install-cloudflared.sh --from-env   # the tunnel, if .env came with CLOUDFLARE_TUNNEL_TOKEN
journalctl -u whatsapp-bot -f
```

Then, in the panel, confirm three things before you call it done:

1. Dashboard shows **Connected** and the right number — no re-link needed, the
   session came across.
2. Your existing admin password is accepted — the `MASTER_KEY` came across.
3. Settings → Library → **Test connection** passes — the Jellyfin token
   decrypted.

If (2) fails and the API keys look blank, `.env` did not make it. Stop, fix
that, and do not re-enter the secrets by hand: a fresh `MASTER_KEY` will
re-encrypt everything and permanently orphan the old `config.json`.

Finally, shred the copy:

```bash
shred -u /tmp/bot-state.tgz     # on both machines
```

---

## Two machines, two numbers

Running a second bot on its own number is fine and needs no coordination with
the first. Each box gets its own everything:

| | Machine A | Machine B |
|---|---|---|
| clone | `~/whatsapp-bot` | `~/whatsapp-bot` |
| `.env` / `MASTER_KEY` | its own | **its own — do not share** |
| `data/` | its own | its own |
| WhatsApp number | number 1 | number 2 |
| Jellyfin | may be the same server | may be the same server |
| tunnel hostname | `bot-a.example.com` | `bot-b.example.com` |

Two things to get right:

- **Distinct tunnel names and hostnames.** Naming both tunnels `whatsapp-bot`
  is how you end up staring at the wrong panel.
- **Distinct request/posts groups**, or both bots answer the same message and
  post the film twice.

They may share a Jellyfin server freely — the bot only ever reads.

The panel supports several numbers on *one* machine too (Settings → WhatsApp
account), with failover between them. That is a different feature from two
machines, and it is the right one if all you want is a spare number: sessions
live side by side in `data/sessions/<id>/` and only one is ever connected.
Failover is on by default since 2026-10-12, the operator's setting; with only
one number set up it stands aside, as if off, until a spare is added
(`_hasSpare` in `src/core/failover.js`).

---

## Linking and relinking a number

Settings → WhatsApp account → the number in full international form, digits
only (`15551234567`, no `+`). Then Dashboard → **Link / Connect**.

**Pairing code** (the default) is easier on a headless box: the panel shows an
8-character code, and on the phone it is WhatsApp → Settings → Linked devices →
Link a device → *Link with phone number instead*.

**QR** renders a code in the panel to scan instead.

The session is saved in `data/session/` and survives restarts — you link once.

### When the QR is slow to appear, or never appears

This is a known rough edge, and it is worth understanding rather than
re-clicking.

A QR from WhatsApp is only valid for about a minute. If nobody scans it in
time, Baileys closes the socket, and the bot then schedules its next attempt on
the **reconnect backoff** — which doubles every attempt up to
`whatsapp.maxReconnectDelayMs`, 15 minutes by default. That ceiling exists for
a good reason (a flat 60-second retry once produced 1,057 connection attempts
in a day, which is exactly what gets a number flagged), but it means a few
missed QR windows in a row can leave you looking at "Connecting…" with no QR
for a quarter of an hour.

`reconnectAttempts` is only reset by a **successful connection**. It is not
reset by wiping the session, by Disconnect, or by pressing Link / Connect — so
a box that has been failing to connect for a while starts its next QR attempt
already deep into the backoff.

What to do:

1. **Have the phone open and ready before you click Link / Connect** —
   WhatsApp → Settings → Linked devices → Link a device, camera up. Then click.
2. **Prefer the pairing code** over the QR. The code is longer-lived and does
   not need the phone next to the screen.
3. **If it says "Connecting…" with no QR**, look at the log for the countdown
   rather than clicking again:

   ```bash
   journalctl -u whatsapp-bot -n 50 | grep -i 'reconnecting in'
   ```

   `reconnecting in 900s (attempt 11)` tells you exactly how long you are
   waiting.
4. **To clear the backoff immediately**, restart the process. A fresh process
   starts at `reconnectAttempts = 0`, so the first QR comes in seconds:

   ```bash
   sudo systemctl restart whatsapp-bot
   ```

   Then click Link / Connect with the phone already open.

That restart is the reliable workaround. Do **not** lower
`maxReconnectDelayMs` to make this feel snappier — that is the change that
caused the reconnect storms in
[whatsapp-ban-risk.md](whatsapp-ban-risk.md).

### If it comes back up disconnected

Check which number it is set to use — the panel shows *"will link as …"* when
disconnected. A number logged out on the phone needs re-linking from the phone;
the bot cannot fix that itself and will not keep retrying a wiped session.

---

## Watching it

```bash
journalctl -u whatsapp-bot -f                    # live
journalctl -u whatsapp-bot --since '1 hour ago'
tail -f ~/whatsapp-bot/data/logs/debug-$(date +%F).log
```

The file log is **always at debug level** regardless of the console setting
(which is debug too by default since 2026-10-12, the operator's setting),
rotates daily and again at 32 MB, gzips yesterday, and is pruned after 14 days.
Writes are synchronous, so the last lines before a crash are on disk.

In the panel, the **Logs** tab has the live view, the saved files, and the
portal audit log.

Useful greps:

```bash
cd ~/whatsapp-bot/data/logs
grep -c 'state -> connecting' debug-$(date +%F).log     # socket opens; high is bad
grep 'reconnecting in' debug-$(date +%F).log | tail
grep -iE 'rate-overlimit|rate-limited' debug-$(date +%F).log
grep -i 'not in library' debug-$(date +%F).log
grep 'content check' debug-$(date +%F).log                # every nudity check, and why one did not run
```

### When the disk fills

The work directory (`data/media`), the temp directory Baileys writes each
upload's encrypted copy to, the logs and the state share one disk, and on
bot-box it is 29 GB. On 2026-09-28 it reached 0 bytes free and three films
failed for good in half an hour. What the bot does about it now:

- **Nothing is deleted to make room.** A job's download stays until its file
  has been sent (see [Restart the process](#3-restart-the-process) above), work kept for a retry or
  for the next start is kept however full the disk is, and no job's work is
  given up for another's. It used to be: the original went the moment the
  file was made, a lost send on a nearly full disk threw its work away, and
  work parked for the next start was given up for a job that did not fit.
- **A job asks for room before it starts**: the most it holds at once - its
  download (Jellyfin's size, or 6 GB for a film and 2 GB for an episode when
  Jellyfin gives none), the converted file at its largest
  (`media.maxOutputBytes`) and the upload's copy, all three together since
  the download is kept until the send - and 512 MB spare, less what the jobs
  already running have still to write.
  Without room it waits, holding the download slot, and says so once:
  `💾 waiting for disk space for …`; the queue and its History row say
  *waiting for disk space*. It goes on when a job ahead frees its files.
- **Kept work counts as held.** A job that fails transiently keeps what it
  has done for its retry (a finished file after a lost upload, a download),
  and a job waiting for a restart's recovery keeps its too, in its
  `data/media/job-*/` directory. The room each will still need is held for
  it until it runs again: a job that does not fit meanwhile gives up its
  place in the queue, shows the stage it had reached (🎬 with nothing done)
  and *waiting for disk space*, and comes back
  by itself once that work has finished. A resumed job asks only for the room
  it still has to write.
- **Other work on the disk makes a new job wait, not fail.** When nothing is
  running and the room is held by work kept for other jobs - a film parked
  for the next start, a job resumed after a restart that has not run yet -
  the new job does not start its download. It logs an error for the
  operator, `not enough disk space for … yet: … held by the work of N other
  job(s), kept until each is sent - it waits, and nothing is deleted to make
  room`, which the hourly check reports as the disk filling up; its History
  row reads *waiting for disk space* and the requester sees 🎬. It goes back
  in the queue once that work has been sent and its directory is gone (a
  restart sends parked films first). To hurry it, free space by hand, or
  cancel the film whose work is holding it.
- **If the disk could not hold it even with everything else gone**, it fails
  at once with the numbers: `not enough disk space for …: it needs … and only
  … is free, with nothing else in progress that will free more`. Something
  other than the bot is filling the disk; free some space and re-run it.
- **A job the disk fills under anyway** (ENOSPC in a download, ffmpeg exiting
  228, an upload whose copy was cut short) is not failed: its History row
  reads *interrupted - waiting for disk space*, the requester sees the stage
  it had reached, and it
  is retried once there is room, up to three times in the process. The
  hourly check's disk finding names such a job as waiting, not failed: a
  re-run from History as well would make and post it twice.

```bash
grep -E 'waiting for disk space|room on the disk|not enough disk space|of work for .* journalled job' debug-$(date +%F).log
df -h / && du -sh ~/whatsapp-bot/data/media ~/whatsapp-bot/data/media/job-* 2>/dev/null
```

### When the nudity check stops running

A content check that cannot reach an answer falls back to the rating. That is
deliberate, since an outage must never open a gate, but it is also silent. On
2026-09-22 the check did not run all morning, for three different reasons in
turn, and films were judged on their rating alone. Since 29 September 2026 the
check is asked only to clear a film or episode its rating blocks (see *The
safety policy* below), so an outage sends nothing it would have stopped - it
refuses, on their rating, titles it would have cleared.

So now three failures in a row, or five inside half an hour, raise one alert:
an email (Settings → Email alerts → *the nudity check keeps failing*, off by
default since 2026-10-12, the operator's setting), an audit entry, a warn
line, and an amber **Nudity check not running** card at the top of the
dashboard. Each gives the reason and what to do about it:

| Reason | What it means | What to do |
|---|---|---|
| daily quota used up (HTTP 429) | the free tier allows 20 requests a day per model, shared with the film lookup | wait for midnight Pacific, or enable billing on the key's project |
| rate-limiting the check (HTTP 429) | a short-term, per-minute limit | usually nothing; it clears in a minute or two |
| no model called "…" (HTTP 404) | the model was retired | Settings → API keys & logins 🔑 → Gemini → Model |
| answers incomplete (finishReason) | `MAX_TOKENS` means the model ran out of room thinking | see `GEMINI_MAX_OUTPUT_TOKENS` in `gemini.js` |
| refused the API key / no key | wrong key, or `MASTER_KEY` does not match `config.json` | re-enter the key |
| did not answer / cannot reach Gemini | a timeout or a network fault | Dashboard → Outbound connectivity |
| no AI provider could run the check (`all-failed`) | Gemini and every fallback failed; each reason is listed | fix whichever the email names; see *Fallback AI providers* below |
| every AI provider with a key is switched off (`no-provider`) | keys are saved, but every *Ask …* switch in the AI providers card is off | tick one in Settings → API keys & logins 🔑 → AI providers |

The check, the film lookup and every provider are on by default since
2026-10-12 (the operator's settings). With no key saved for *any* provider -
a new install, or every key blank because `MASTER_KEY` does not match - none
of it is asked (`anyAiKey`): a rated film is refused on its rating, as with
the check off, and no alert is raised. A key on any one provider is a chain
being set up, and from then on a missing one is reported as above.

A different reason inside the same outage gets its own email; the same reason
does not repeat until the check has worked again. The first success clears the
card and, if you were emailed, sends one "working again" note listing every film
that was decided on its rating alone. A dry run on the Test tab counts, so it is
the quickest way to confirm a fix. If it breaks again after that note, you are
emailed again straight away, so the last email is always the true one.

One exception: if the check has been failing **on and off** (a success already
came between the failures), one more success proves nothing. The card then says
the latest check worked and when it will clear, and it clears by itself once
the failures are half an hour old, if nothing has failed since.

Each affected request is also marked *Not checked for nudity* on the History
tab (the `contentCheckSkipped` field on its history row, with the reason); one
that matters can be asked for again once the check works. The thresholds live
under `gemini.contentCheckAlert` in `config.json`.

### Fallback AI providers: Groq, Cerebras, Mistral, OpenRouter

Gemini's free tier allows 20 requests a day per model, reset at midnight
Pacific. The bot makes about 30 in its first hour, so on 2026-09-22 the quota
was gone by mid-morning and every film after that was judged on its rating
alone. The nudity check and the film lookup now fall back to Groq, Cerebras,
Mistral and OpenRouter, whose free tiers are far larger. All four speak
OpenAI's Chat Completions format; the code is `src/core/ai-providers.js`.

OpenRouter (added at the operator's request) fronts many hosted models behind
one key, most of them paid per token. On its free tier only the models whose id
ends in `:free` cost nothing, and without credit it allows about 50 of those
requests a day, so it is last in the default order and *Automatic* picks a free
model before it will consider a paid one. Its keys look like `sk-or-v1-…`, and
like the others they are scrubbed from every log, error and report by shape as
well as by value. Its model list is public, so the key test and the chain ask
its `GET /key` first to prove the key.

**Setting it up.** Settings → Movies → **AI providers**. For each provider
(every one is ticked on by default since 2026-10-12): paste the key (from
console.groq.com, cloud.cerebras.ai, console.mistral.ai,
openrouter.ai/settings/keys), and press **Save AI providers**. Keys are encrypted at rest
like every other secret (`ai.<provider>.apiKey` in `SECRET_PATHS`) and never sent
back to the browser; a blank key box keeps the saved key. **Load models** fetches
the provider's model list on the server with the saved key, so save a new key
before loading. The switches in Movies → Movie data (*Use Gemini…*, *Ask AI about films and
episodes their rating blocks*, *Also send rated films and episodes with no nudity*)
still turn each feature on and off; this card only chooses who answers.

**Testing a key.** Each row has a **Test** button. It tests the key typed in
that row's box if there is one — without saving it — and otherwise the saved
key, with the model chosen in the row (Gemini's key and model are the ones in
Movie data). The steps, each shown under the row: the key is accepted (the
provider's model list, which is free); the model is on that list (*Automatic* is
checked as the chain would choose it); and for Groq, Cerebras, Mistral and
OpenRouter one tiny JSON-mode request, with its time. Gemini is never sent a generation request
by a test, because its 20 a day are the bot's: its key and model are checked by
the model list alone, so a model on that list that cannot give a JSON text
answer (a speech, image-generation or Gemma model) fails the test by name, and a
name written as Google lists it, `models/gemini-2.5-flash`, is checked and sent
without the `models/`. If *Automatic* is still using a model the key no longer
lists, the test says so rather than passing: the chain's next request to that
provider will fail once before it picks again, and choosing the model the test
names and saving switches at once. A model list that is not JSON at all (a
captive portal or proxy page answering instead of the provider) is reported as
that, not as a problem with the model. A test changes nothing the chain uses —
no provider is held back or put back, no status line or alert, no cached
automatic model — and one provider can be tested once every 5 s. The audit trail
records "tested the Groq key: ok / bad key / …" and whether it was the typed or
the saved key; the key itself is never logged or returned.

**The order.** Default: Gemini, Groq, Cerebras, Mistral, OpenRouter, using only those that
are ticked and have a key. The first provider that gives a usable answer
decides, and every answer records which provider gave it. A well-formed "I do
not know this film" is an answer, so a less knowledgeable model is not then
asked to guess. Each attempt has its own timeout (20 s for the nudity check,
15 s for the lookup) and the whole chain is capped at 45 s (30 s for the
lookup), because a requester is waiting.

**Models.** A model left on *Automatic* is chosen once a day from the
provider's own `/models` list, taking the first available from a preference list
in `MODEL_PREFERENCES` (large general-knowledge instruct models first, because
knowing what is in a film is recall, not speed; on OpenRouter, free `:free`
models before any paid one), else the first chat model. The
choice is logged (`grep 'no model set' debug-*.log`). If the chosen model is
retired, it is chosen again.

Gemini's *Automatic* takes the newest stable Flash on the key. When that model
answers HTTP 503, *"This model is currently experiencing high demand"*, the same
question goes once to the next Flash on the key's list, and the busy model is
passed over for 30 minutes, per key, so the checks after it go straight to the
one that answered; then the newest is tried again. Never more than two Gemini
requests per check, since the free tier allows 20 a day, and a model typed into
the Model box is never swapped. On 29 September 2026 gemini-3.8-flash answered
503 all afternoon, every check fell through to Groq, and Groq's "nudity" kept
*The Last Samurai* back - a film the operator had put on the rating-override
list, which since that day is sent with no AI check at all; gemini-3.6-flash on
the same key answered at once. The log says which model answered
(`grep 'is overloaded' debug-*.log`).

The model asked in the busy one's place fails on its own account: Gemini's
free-tier quotas are per model, so a stand-in running out of its 20 a day, or
one Google has retired, is passed over by itself (until midnight Pacific, or 15
minutes) and the next Flash stands in; Gemini is not held back, and is back on
its own model as soon as the overload passes (`grep 'asked in place of'
debug-*.log`). A refused key still holds all of Gemini. The second request
only goes out within what is left of Gemini's own turn (20 seconds for the
nudity check), and only if at least a quarter of it is left, so the providers
after Gemini keep the time they had.

**Reasoning and cut-off replies.** Some hosted models think out loud before
answering, and that reasoning often contains the very JSON being asked for
("maybe `{"nudity": false}`… but I recall a scene…"). Reasoning is taken out
wherever its edges can be found (`<think>`, Kimi's and Magistral's markers,
gpt-oss's harmony channels). A reply the provider cut off at its token cap
(`finish_reason: length`) is used only if what is left is exactly one complete
JSON object; anything else is *incomplete* and the next provider is asked, so a
half-finished guess never becomes the verdict.

**The safety policy: the AI only helps.** The operator's rule, 29 September
2026: "The AI check is so the request can go through without getting denied if
possible", and, asked whether it should still block an unrated or PG-13 film it
says has nudity - the case it was first written for, *Nymphomaniac: Vol. I*
sent as "Not Rated" - "No, AI only helps". So no answer from any provider
refuses anything; only the rating does, and a title on the rating-override
list is sent with no AI check at all (*Rating overrides*, below).

| Film or episode | What happens |
|---|---|
| on the rating-override (bypass) list | **sent**, nothing asked, whatever its rating |
| its rating lets it through (an unrated one too, with *Block films with no rating at all* off) | **sent**, nothing asked |
| its rating blocks it, *Also send rated films and episodes with no nudity* off | **blocked** on its rating, nothing asked |
| its rating blocks it, that setting on, no key saved for any AI provider | **blocked** on its rating, nothing asked |
| its rating blocks it, that setting on | asked: a sure "no nudity" **sends** it; "nudity", unsure, or no answer leaves it **blocked** on its rating |

The fallbacks run open models that recall particular films less reliably than
Gemini, so a "no nudity" clears a rated title only from a provider you tick
*May clear rated films* for, which asks for confirmation. Gemini's, Groq's,
Cerebras's and OpenRouter's flags are on by default since 2026-10-12, the
operator's settings; Mistral's is off. A provider without the tick is not
asked the nudity question at all, since its answer could change nothing (it still answers the film
lookup). The history row of every checked film says who judged it
(`contentCheck.by` and the model), and one that was not cleared says why.

**The circuit breaker.** A provider that answers "quota used up" is asked *last*
until it will take requests again, so a request is not first spent on a
refusal:

| Failure | Asked last for |
|---|---|
| Gemini daily quota (HTTP 429, `…PerDay…` quota id) | until midnight Pacific |
| any other 429 | the provider's `Retry-After` or `x-ratelimit-reset-*` time (OpenRouter's `x-ratelimit-reset` instant); one minute if it gives none, an hour for a daily limit with no time |
| bad key (401/403) or unknown model (404, Mistral's `invalid_model`) | 15 minutes |
| timeout, network, 5xx, incomplete or unreadable answer | not held; the next film asks it as usual |

It is demoted, not dropped: if nothing else answers, the held provider is still
tried last, so a Gemini configured on its own behaves exactly as before, and a
key that has just had billing switched on is noticed the same day. Changing a
key or model clears what was learned about it, and the dashboard card has a
button to put a held provider back in its place at once. The breaker lives in
memory: after a restart the first film asks Gemini again and re-learns it.

**What you see.** Gemini running dry while Groq answers is routine and sends no
email. The dashboard shows a *Nudity check on a fallback provider* card —
"Gemini's daily quota is used up — using Groq until 03:00 (07:00 UTC)" — and
the AI providers card shows each provider's last status (answered, daily quota
used up until…, bad key, unknown model). The *Nudity check not running* alert
above fires only when **every** provider fails; its reason is then `all-failed`,
and the email lists each provider's own reason and fix. A provider failing for a
reason not yet mailed during the same outage (Groq's key fixed, then Groq out of
quota) sends another email; the same set of reasons does not. A provider that is
being held back and was not reached before the time ran out is reported with the
reason it is held for, not as "not reached in time".

---

## The hourly check

Every hour on the hour, a cron job goes through what the bot recorded — both
request histories, the TV not-in-library list, the message index, the debug
log, systemd and the auto-updater — for any request that failed or went
unanswered because something went wrong. When it finds something, Claude Code
researches it and fixes the code if it is a bug; the check tests the fix,
pushes it to `main`, restarts the bot so the fix is live, and emails you a
report. The operator asked for exactly that, "and of course reboot the bot
right away". A library keeper's `#issue` does not wait for the hour: it
starts the check at once, and is researched first (below).

The pieces: [`tools/hourly-debug.mjs`](../tools/hourly-debug.mjs) (the run),
[`src/core/incident-scan.js`](../src/core/incident-scan.js) (what counts as a
finding), [`deploy/hourly-debug/prompt.md`](../deploy/hourly-debug/prompt.md)
(what Claude is told), [`deploy/hourly-debug/run.sh`](../deploy/hourly-debug/run.sh)
(what cron runs), [`deploy/hourly-debug/sandbox.py`](../deploy/hourly-debug/sandbox.py)
(what the research session runs in) and [`deploy/install-hourly-debug.sh`](../deploy/install-hourly-debug.sh).

### What a run does

1. **Scans.** Plain reads, no AI, a second or two. **Nothing new is "all
   clear"**: a row on the panel and nothing else — no Claude, no email, and no
   restart, which would throw away every encode in progress for nothing.
2. **Restarts right away when the bot is unhealthy** in a way a restart
   cures (see below) — before any research, not forty minutes later — and
   waits to see it running and connected.
3. **Researches**, when there are findings: headless Claude Code (`claude
   -p`, at most 40 minutes, under `nice`), in a clone at
   `~/.local/share/whatsapp-bot-debug/repo` made afresh from `origin/main`
   for the run — never in the live checkout, which the auto-updater would
   then refuse to update. The session runs **sandboxed**
   ([`deploy/hourly-debug/sandbox.py`](../deploy/hourly-debug/sandbox.py)):
   the kernel's `no_new_privs` (sudo, su and every setuid program refuse to
   work for it and everything it starts) and Landlock (it writes only its
   clone and the run's folder; it cannot open anything else in the home
   directory), with no git or GitHub credentials. What it cannot do itself —
   ship a fix, re-run a request, ask the bot anything — it asks the check
   for, through files in the run's folder.
4. **Ships a fix when the session asks for one.** The session commits, marks
   each commit `Hourly-Check: <run id>`, and hands the commit over; the check
   — outside the sandbox — takes it into a repository of its own
   (`trusted.git`, which the session can only read; git run in the session's
   clone would run that clone's hooks), refuses it if any commit lacks the
   mark or it touches what a fix may not (below), runs the **whole test suite
   itself** — each suite sandboxed too, on a read-only worktree — on `main`
   and on the fix, and pushes only when no suite fails that passes on
   `main`. If `main` moved meanwhile it puts the fix on top and tests again;
   a push refused because `main` moved is tried once more. Then it
   **restarts into the fix at once** and checks it came back on the new
   commit, connected — or reports a rollback.
5. **Reports**: a row on the panel (**Logs → Hourly checks**), the full report
   linked from it, and the same report by email (Settings → Email alerts: on
   by default, and sent once it has an address and an app password). Phone
   numbers and keys are scrubbed from both.

### A library keeper's #issue: at once, and first

The operator (2026-10-12): "Needless to say #issue tickets submitted by head
admin 5558100180 get top priority" and "Meaning it should activate bot to send
yo a notification to check right away". Head Admin looks after the Jellyfin
library, and is the library keeper in Settings → Library & files → Library
updates (`libraryNews.senders`). When she writes a message starting `#issue`
in the watched discussions group:

1. **The bot asks for a check.** Its row in `data/library-news.jsonl` is
   marked `keeper: true`, and it writes `data/check-now.json` - who, when,
   the first 300 characters - and logs
   "🚩 top-priority #issue from Head Admin - the hourly check is asked to run now"
   ([`src/core/check-now.js`](../src/core/check-now.js)). It cannot start the
   check itself: its unit has `NoNewPrivileges`, which breaks the sudo the
   check restarts it with, and a child of the bot's service is killed with
   the bot when the check restarts it. An #issue from anyone else, and
   anything she says without `#issue`, asks for nothing. A message she
   edits into an #issue counts as one sent so, and an edit adding details
   to an #issue is kept and asked for like it (a row of its own, `edits`
   naming the message).
2. **cron runs it.** The cron line is a tick every minute
   (`deploy/hourly-debug/tick.sh`, which is `run.sh --tick`; a file of its
   own because an older checkout's `run.sh` would take `--tick` for a whole
   run, every minute, and an older checkout has no `tick.sh`). At minute 00
   it is the hourly run, as always - and at 01 to 04 when cron, woken late,
   runs the 00 tick late, as it ran the old `0 * * * *` line late; at any
   other minute it runs `tools/hourly-debug.mjs run --asked` only when the
   file is there, and with no file it ends at once and prints nothing. The
   run waits two minutes after her latest #issue, so a ticket written over
   two or three messages is read whole - but never more than ten minutes
   after the first, however many follow - and then runs exactly as on the
   hour: same environment, same token, same sandbox, same email. An asked
   run that fails is not tried every minute: the request waits for the bot
   to ask again - an #issue it asked for while that run went on included -
   or for the hour (`asked-failed` in the state folder says it failed). The
   hours are told apart by the count since 1970, not by the clock's name
   for them, so the night the clocks go back the hour that comes twice is
   run at each 00 and no more.
3. **The scan puts it first.** Her #issue is `priority`, its title starts
   "TOP PRIORITY:", it sorts before everything else (it is never in the
   overflow), and the research session is told to research and fix it
   first and to the end, and to put it first in the report. The panel's row
   for such a run starts "asked: Head Admin's #issue"; the email's subject is
   the usual one.

Every run, on the hour or asked, takes the requests its scan covered - those
whose #issue it read and reported, and no other - so nothing is checked
twice for nothing: one written while a run was already reading stays for
the next minute, and a tick that finds a run going leaves it for a later
minute without a word. A request is never lost to a race with the bot - an
extra run is the worst case. The news is read a day back, and further back
for a waiting request's own #issue, so one that reached the bot a day late
(a phone offline) is still reported, first; and a keeper's #issue is read a
day back by the scan in any case, so even one the bot could not ask for is
researched on the hour.

The request file is only the bot's word. A run between the hours starts
only for a request the check itself finds behind a keeper's #issue in
`data/library-news.jsonl` (from a number in `libraryNews.senders`); anything
else in the file - one that does not parse, or names nobody's #issue - is
dropped with one line in `cron.log`, and no run.

What counts as a finding:

| Finding | From | Researched? |
|---|---|---|
| a request that failed or was lost to a restart | the movie and TV history | yes |
| a film interrupted in this process, its in-process retries spent, waiting for the next start | the history, the journal, the log | yes, and restarted for — up to twice per film |
| "not found", "not in the library", "wrong film", "a series" | the history, the TV not-in-library list | yes, once a day per title |
| a `#request` that got no reaction, reply or deletion at all | the message index against the history and the log | yes, every new one |
| a TV request ignored inside the per-user cooldown | the same | yes, as one list at most once a day |
| requests refused because the queue was full | the history, the log | once every six hours |
| a job that has stopped moving, WhatsApp down for 20 minutes, a crash, a rolled-back deploy | the bot's own `health`, the log, systemd, `auto-update.json` | yes |
| an error line in the log | the log, grouped by message | yes, once a day per message |
| the same member asking for the same film, season or episode again within three days — after a failure, while the first was still being made, after it was posted | the history, read as each member's requests in order | yes; listed only when the first failed and the second was posted |
| a member asking again for what the rating or content rules refused or withheld, and refused again | the same, with the rows' `withheld` field | yes — the rule is working; what is unfulfilled is the member, usually never told why |
| the same film or episodes waiting in the queue twice | both plugins' journals of accepted work | yes, one list; cancel the copy in the panel |
| the disk filled (`ENOSPC`, "no space left", ffmpeg exit 228, an upload copy cut short), less than 4 GB free where the bot works, Baileys upload copies in `/tmp` nothing uses | the log; free space and `/tmp`, measured by the check | yes, each with what to free or delete, and which jobs it failed apart from those waiting for room or the next start, which come back by themselves and must not be re-run as well; under 10 GB free is listed only |
| what the rating and content rules refused or withheld | the history | one digest line, listed only — the policy working |
| no queue notifications group; a notifications or posts group the bot is not in; a beta feature on Beta for a week | the settings, the bot's own group list, the audit log | once a day, listed only |
| "which year?" or "which one?" left unanswered; several films asked for in one request (`one-at-a-time`); WhatsApp stopped from the panel | the history; `health` | listed only |
| a beta test that went wrong (below) | the beta groups' transcript | yes, under its own heading |
| a note an admin wrote on a film on the Wanted card (History tab) | the wanted list in `state.json` | yes, each note once: the session reads it as the operator's instruction about that film, acts on it within its rules, and answers it in the report under "Notes from the Wanted list" (the operator, 2026-10-11: "a box to add notes for you to review on the hour") |
| a film an admin marked resolved on the Wanted card | the same | yes, once: the session checks the server has it and says which requesters to tell (an incident, so it runs even in an hour with nothing else); what the bot resolved itself, having found it on the server, is not |
| a member's `#issue` in the discussions group | `data/library-news.jsonl` | yes, each one |
| a library keeper's `#issue` (Head Admin's) | the same | yes, **first**, as TOP PRIORITY - and the check runs for it at once, not on the hour (above) |

#### The beta groups

The history findings skip every beta row: a test refused is not a member
let down. The tests are read instead from their own record, the operator's
request (2026-09-30): "the bot likes to edit it's messages on the test group
but I need it all logged somewhere for you to check on the hourly debug so I
don't have to manually report to you".

The bot writes every beta group's conversation to
`data/beta-transcript/YYYY-MM-DD.jsonl` (UTC days, pruned after the log
retention, 14 days) as it happens, at the layer every send passes through
([`src/core/beta-transcript.js`](../src/core/beta-transcript.js)): each
tester message (their display name and a short keyed hash of their number,
never the number; the text; the message id; how the beta group read it - a
test and its code, or not), each message the bot sent there with the message
it answered and that request's test code and feature, **every edit** of a
bot message with its full new text, every reaction the bot put on a message,
every reaction a tester put on one (`in-react`: the emoji and the message it
is on, so a number reacted on a list is there as the pick it was),
a message it deleted, a send that failed, and two things only the plugin
knows: "ignored: no test code", and what the pick list's library search
found. Main groups are never written there.

Each hour [`src/core/beta-scan.js`](../src/core/beta-scan.js) reads the
transcript since the last run (with the day before it for context) and
reports, as `beta-test` findings:

| Rule | What it means |
|---|---|
| `unanswered` | a coded test got no reply and no reaction at all within ten minutes |
| `pick-none-sendable` | the pick list listed none of the films the server holds ("john wick", 02:17 UTC on 2026-09-30: four held, none listed, then a single film's "Test passed") |
| `pick-empty` | the list's search matched nothing, yet the request went on to find a film ("Mission Impossible", 00:08 UTC: 0 matched, then a real download); or a list went out with nothing to pick |
| `wrong-film` | "Test passed" for a film other than the one named, or the one picked from the list - for a pick made by reacting, the one the bot took: the tester's first number on that list's own message that is on it and not struck through, unless a typed number won before it |
| `bot-error` | ⚠️ in a reply or reaction, or a send or edit that failed |
| `test-downloaded` | a queue or download reaction, "on its way", or a file sent: a test must never download |
| `repeat` | the same tester sent the same request again within ten minutes - the first answer was wrong or unclear |
| `many-edits` | one bot message edited four times or more |
| `long-reply` | a reply over 1,500 characters with a paragraph over 400, a line over 250, or four or more films on one line (the paragraphed pick list, one film to a block, is the layout the operator asked for and is not flagged however long) |
| `code-questioned` | a coded message answered ❓ |

Each finding carries the conversation around it exactly as the testers saw
it, every edit included; the research session is told these are tests of
features under development and that fixing them is in scope, and the report
and email list them under **Beta tests in the testing group**, apart from the
members' incidents.

Each finding is handled once; one that grows (a member asking a third time)
is reported again with the new count. A question the member answered
("newsies", then "newsies 1992") is not "left unanswered". The first run
looks back one day. What an hour only listed shows under the run on the
panel, all-clear hours included.

### When it restarts, and when it does not

It restarts after shipping a fix; for a job that has not moved in 45 minutes
(3 hours if the bot cannot be asked); for WhatsApp down 20 minutes or more;
and for a film interrupted in the running process once its in-process retries
are spent, which leaves it journalled to retry "on the next start" - with its
work kept, so the restart goes on from where it stopped. It does
**not** restart:

- on an all-clear hour;
- for a film the running process is retrying by itself (logged "retrying once
  WhatsApp is connected"): it goes back in the queue within minutes, often
  with its finished file, and a restart would throw that away;
- for a job waiting in line for the download, encode or upload slot while the
  line moves — it reports no progress until the slot frees, which behind two
  encodes can be the best part of an hour;
- for an interrupted film the running process has already taken back (its
  History row says "interrupted" until the retry ends), or one interrupted a
  third time — that is for a person;
- while WhatsApp is **stopped** (the panel's Stop, an account switch, or a
  drop with auto-reconnect off): the bot connects again on boot, so any
  restart, even one to deploy a fix, would overrule the stop;
- for a crash loop (systemd is already restarting it, and the updater rolls a
  bad commit back); for a stopped service (somebody stopped it — it is never
  started from here); for a logged-out number or a `connectionReplaced` (a
  restart is one more login that cannot succeed, rule 3);
- for a full disk, a duplicate in the queue, a member asking again, a rating
  refusal or a setting: a restart cures none of them, and throws away the
  encodes in progress;
- more than once for the bot's health in a run or within three hours, or more
  than twice to deploy in one run.

It restarts with `sudo -n systemctl restart whatsapp-bot`, never by making the
process exit, which the updater would count as a crash.

### What a fix may not change

A fix that changes any of these is refused however green its tests, and the
session is told why: `deploy/` (the updater runs before every start; the
check lives there), `tools/hourly-debug.mjs`, `tools/run-tests.mjs`,
`tools/bootstrap.sh`, the secrets backup tools, `src/core/hourly-checks.js`,
the routines registry and its check (`src/core/routines.js`,
`tools/routines.mjs`, which a new session runs `--fix` from with sudo),
`whatsapp-bot.service`, `install.sh`, `start.sh`, `package.json` and
`package-lock.json` (no new dependencies), `CLAUDE.md` (every future session
starts from it), `.gitignore` and `.github/`; the check's own policy - when it
restarts the bot and what it may re-run (`src/core/hourly-policy.js`) - the
bot commands it drives (`src/core/admin-commands.js`), and when it runs
between the hours (`src/core/check-now.js`); the suites that
make `npm test` enforce the ban-risk rules and the check's guards (`pacing`,
`reconnect-loop`, `outbound-budget`, `always-locked-sync`, `routines`,
`hourly-checks`, `hourly-ship-git`, `incident-scan`, `beta`,
`bot-cmd-health-requeue`); and project settings every later Claude Code
session or npm install in the live checkout reads (`.claude/`, `.mcp.json`,
`.npmrc`). So is a fix that deletes a test suite. Changes to those are for a
person. A fix to the scanner's own false alarms (`src/core/incident-scan.js`)
is ordinary code and allowed: it changes what the check finds, and the
check then asks its policy what to do about it.

### Setting it up (once)

On the box, as the bot's user, from the live checkout:

```bash
cd ~/whatsapp-bot
deploy/install-hourly-debug.sh      # or: node tools/routines.mjs --fix, which runs it
```

`tools/bootstrap.sh` does this on the box where it starts the bot, and asks
for the token (step 1 below) with no echo.

It adds a tick every minute to your crontab, `* * * * * ... tick.sh` - the
hourly run on the hour, and a run at once for a library keeper's #issue
(above); installing again replaces an older `0 * * * *` line, and
`node tools/routines.mjs` flags one as "the cron line runs on the hour only"
(cron needs no root; a systemd timer would). It creates
`~/.config/whatsapp-bot/hourly-debug.env` (mode 600), and then checks and
explains what only you can do:

1. **A Claude login for cron.** Run `~/.local/bin/claude setup-token` — it
   opens a browser login and prints a long-lived token — then
   `deploy/install-hourly-debug.sh --set-token` and paste it. It is read
   without being shown, saved to the settings file as
   `CLAUDE_CODE_OAUTH_TOKEN` (mode 600, folder 700), and tested with one tiny
   call (one word back, no tools) to prove it works headless. Do not `echo` it
   into the file: that leaves it in your shell history. Without a token, runs
   still scan, restart, report and email — just without the research and
   fixes.
2. **sudo for the restart.** Just this one command, which the installer
   prints ready to paste:

   ```bash
   T=$(mktemp) && echo "$USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart whatsapp-bot" > "$T" && sudo visudo -cf "$T" \
     && sudo install -m 0440 -o root -g root "$T" /etc/sudoers.d/91-whatsapp-bot-restart && rm -f "$T"
   ```

   The full passwordless sudo in
   [server-setup.md, "Give Claude Code sudo"](server-setup.md#give-claude-code-sudo)
   covers it too. Without either, a needed restart is reported, not made.
3. **The sandbox**: `python3` and Landlock in the kernel (both on every
   current Ubuntu; `--status` says). The research session is never started
   without it. On a kernel without Landlock, `HOURLY_DEBUG_FS_SANDBOX=0` in the
   settings file runs it with `no_new_privs` only — your call, and see below
   for what that gives up.

`gh` must be logged in (it is on every box set up from server-setup.md): the
check pushes fixes with it. The session itself cannot read that login.

Installing checks the token with one tiny headless call (one word back, no
tools) made through `run.sh verify-token` — the same sandbox a run uses, so
it also proves Claude Code starts inside it.

```bash
deploy/install-hourly-debug.sh --status     # what is in place, what is missing, what to consider
deploy/install-hourly-debug.sh --set-token  # save (or replace) the Claude token, then test it
deploy/hourly-debug/run.sh --dry-run        # scan now and say what it would do; changes nothing
deploy/install-hourly-debug.sh --remove     # out of cron; keeps the token and the reports
```

### How far the sandbox goes

The session runs with `--permission-mode bypassPermissions` over text that
members of public groups wrote, as the bot's own user. Its rules are
enforced outside it, not only in the prompt:

| Rule | Enforced by |
|---|---|
| no sudo | `no_new_privs`: sudo, su and every setuid program refuse to run, for the session and everything it starts, and for the suites the check runs on a fix |
| nothing to WhatsApp | Landlock: it cannot write `data/bot-cmd.json`, where the bot takes ops that post to groups. Its bot requests go through the check, which passes on only `health`, `queue-status` and a `requeue` of a request the findings mark re-runnable, five at most |
| never change the data, the settings or the live checkout | Landlock: all read-only to it |
| no push without a clean suite | the check pushes, after its own test run; the session cannot read the GitHub login, and a commit of the run's on `main` that the check did not push is an **alert** (panel, report, email subject) — nothing more is shipped in that run and nothing restarted into |
| never change the check itself | the check refuses such a fix; the session cannot write the check's files, its settings file, or a shell profile |
| never leave the sandbox through another process | seccomp (`sandbox.py`): no UNIX socket can be opened, so neither the user's systemd manager (`systemd-run --user` started a unit outside the sandbox, with no `no_new_privs` and the GitHub login readable - with `NOPASSWD` sudo, root), nor the `lxd` or any other socket; io_uring is refused too |
| never stop or signal the bot | seccomp: every signal call is put to `sandbox.py`, which stays alive beside the session and lets through only signals to the session's own processes. On WSL, where that cannot be had, a PID namespace (below) |

What is left: the session can read what the check hands it and the bot's
own files — logs, `state.json`, and `config.json` with `.env`, which
`tools/diagnose-library.mjs` needs to look things up the way the bot does;
not the WhatsApp sessions (`data/session*`), the panel's login sessions or
the activity backup's clone — and it has the network, so a session talked
into it could send an API key somewhere. Landlock on bot-box's kernel (6.8,
ABI 4) controls neither UNIX sockets nor signals - scoping them needs ABI 6 -
and Ubuntu 24.04 does not let this user make the namespaces bubblewrap would
use, so the seccomp filter and its supervisor are what close those doors.
Every run tries them from inside the sandbox first (`sandbox.py --probe`) and
starts no session unless both are shut; `--status` and `node
tools/routines.mjs` show the same probe. **Membership of the `lxd` group is
root without sudo** for anything outside the sandbox (bot-box's user is in
it), and full passwordless sudo is the same; `--status` warns about both,
with the command to close each. The complete separation is a user of its
own for the check, with no sudo, no `lxd` and no access to the bot's
secrets.

**On WSL** the seccomp supervisor cannot be had: WSL's init (PID 1) holds a
seccomp listener every process inherits, and the kernel allows one per
process, so installing the filter answers EBUSY. There - and only where the
listener answers exactly that - `sandbox.py` runs the session in user, PID and
mount namespaces of its own (`run_confined_ns`), which WSL lets the bot's user
make:

| Door | Shut on WSL by |
|---|---|
| signalling the bot, cron, systemd | the PID namespace: nothing outside it has a number it could name (`kill` answers ESRCH) |
| `/proc/<pid>/root`, `/mem`, `/environ` of a process outside it | a `/proc` of its own, showing its namespace alone |
| ptrace | the same, and its namespace's init is non-dumpable and alone holds capabilities there |
| unmounting what hides the secrets | its uid is mapped to itself, not root, so it has no capabilities after `exec`; the mounts are locked to any namespace it makes |
| writing outside its clone and scratch space | every mount read-only but those, as well as Landlock - so `data/bot-cmd.json` stays shut with `HOURLY_DEBUG_FS_SANDBOX=0` too |
| the WhatsApp session, the GitHub login, the check's settings, the operator's Claude login, SSH keys | empty mounts over them, as well as Landlock |
| the Windows drives (`/mnt/c`), and running a Windows program through interop | `/mnt` hidden (only `/mnt/wsl/resolv.conf` comes back, read-only, for DNS); vsock refused as well as UNIX sockets, so interop cannot reach Windows even for a program the session wrote itself |

UNIX sockets, io_uring, `no_new_privs` and Landlock are as everywhere else.
The probe every run makes checks the namespace doors too, and a box where
neither sandbox can start - WSL with user namespaces refused - still fails
closed: scan and report only. `python3 deploy/hourly-debug/sandbox.py --mode`
says which sandbox a box gets; `--status` and `node tools/routines.mjs` say
it too. The session keeps the network in both (it needs Claude's API), and so
the bot's panel on localhost; that is the same in both sandboxes.

With `HOURLY_DEBUG_FS_SANDBOX=0` only `no_new_privs` remains: the session
could then write anything the bot's user can. The check still looks, before
and after each session, at the live checkout and at the files that run
outside the sandbox later (its settings file, the Claude binary, shell
start-up files, user units), alerts on any change, and does not restart into
a live checkout that changed.

### Settings

In `~/.config/whatsapp-bot/hourly-debug.env`, read as `KEY=value` lines and
never executed:

| Setting | Default | |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | - | from `claude setup-token` |
| `HOURLY_DEBUG_CLAUDE` | `1` | `0`: scan and report only |
| `HOURLY_DEBUG_PUSH` | `1` | `0`: ship each run's fixes to a branch `hourly-check/<run id>` for you to merge, instead of `main` (and so no deploy restart) |
| `HOURLY_DEBUG_RESTART` | `1` | `0`: never restart; report a restart as needed |
| `HOURLY_DEBUG_EMAIL` | `1` | `0`: panel only |
| `HOURLY_DEBUG_CLAUDE_TIMEOUT_MIN` | `40` | how long research may take (5-55) |
| `HOURLY_DEBUG_MODEL` | Claude Code's default | a model name or alias |
| `HOURLY_DEBUG_FS_SANDBOX` | `1` | `0`: no Landlock, `no_new_privs` only (a kernel without Landlock) |

Nothing in the file can name a program the check runs — node, python,
Claude Code, the directories: those come from cron's line or the defaults,
so that editing the file cannot swap in something that then runs outside
the sandbox.

### Re-running a request

After fixing what broke a request, the check may queue it again — once per
request, only one its findings mark re-runnable, at most five a run — by
passing the session's request on to the bot through the local command file,
as `{"op":"requeue","plugin":"movie","id":"<history id>"}`. The bot refuses a
beta test (a re-run from the box has
no origin group and would go to the main posts group, which is also why the
panel has no Re-run on a beta row), a request re-run before, one the member
has asked for again since, an interrupted one (it retries by itself), a TV
season that partly posted (it would post those episodes twice), and anything
more than a week old. Every re-run is in the portal audit log. Anything not
re-run is in the report as advice, with how.

A film request that ends ⚠️ with "metadata lookup failed: OMDb HTTP 5xx" (or
429, 403, a network error or a timeout) has already been tried again by the
bot. Since 2026-10-12, when "First daughter 2004" got ⚠️ for an OMDb outage of
under 90 seconds, an OMDb call that meets one of those tries again 5, 30 and
90 seconds after its first try, and once one call has used up its tries,
OMDb is noted as down and every call in the next minute is tried once
(`src/plugins/movie-requests/omdb.js`). So such a row means OMDb had been
failing for a minute and a half, for this lookup or one just before it, and
the log shows each try ("OMDb HTTP 525 for "First daughter 2004" - trying
again in 5s (2/4)"); re-running it once OMDb answers is still right.

A re-run or a `queue` through `data/bot-cmd.json` does the same lookup, so
while OMDb is failing it can take up to two minutes, and the bot takes the
next command only once it has answered. The hourly check waits three
minutes for a re-run's answer, and each answer carries the `ref` of the
command it answers, so a late one is never read as another's. By hand,
`cat data/bot-cmd.result.json` again until its `at` is after you asked.

### Queueing a request from the box

An operator on the box can queue anything a member could ask for, exactly as
the panel's queue box does, when there is no History row to re-run:

```bash
cd ~/whatsapp-bot
echo '{"op":"queue","plugin":"tv","text":"fullmetal alchemist brotherhood S01E14","by":"owner"}' > data/bot-cmd.json && sleep 5 && cat data/bot-cmd.result.json
```

`plugin` is `movie` or `tv`. Every check the panel gets still applies — what
is already queued, room, the rating, the bypass list and the AI check — and
it goes to the main posts group. It is audited as a change. The hourly check
never uses it: its research session cannot write `data/bot-cmd.json`.

### Trimming queued TV requests to the episode limit

`tvRequests.maxEpisodesPerRequest` applies as a request is made, so setting
or lowering it leaves the requests already queued as big as they were
(2026-10-12: Arrow season 1 waited with 23 episodes, Hunter x Hunter with
148, after the limit became 10). This keeps every queued TV request to
at most `max` episodes — by default the limit in the config — without
cancelling any: what a request posted, failed, has running or waiting counts,
in episode order; what runs is never stopped; the waiting episodes past the
limit come off the queue and the journal, and the request ends on ✅ once
what it kept is posted. An episode its member was sent already by an
earlier request of theirs for the season comes off too, and keeps no place
(Hunter x Hunter season 1 keeps E11-E20 for Ari, who had E1-E10). Each
member gets one reply, quoted to their request, saying what is still coming
and the exact message for the next part; a member following it whose every
episode came off is told so and let go. The request is then named, in the
queue, History and its finished notice, as one the limit cut when it was
made ("Arrow S01E01–E10 — 10 of season 1"), and its notice names the next
part. It refuses to apply while a restart is still putting requests back
into the queue: run it again a minute later.

```bash
cd ~/whatsapp-bot
# A dry run: changes nothing, and says per request what it would do and the words its member would get.
echo '{"op":"trim-tv-requests","by":"owner"}' > data/bot-cmd.json && sleep 5 && cat data/bot-cmd.result.json
# Then do it.
echo '{"op":"trim-tv-requests","apply":true,"by":"owner"}' > data/bot-cmd.json && sleep 5 && cat data/bot-cmd.result.json
```

`"max": 10` sets the limit to trim to (needed when the config's is 0, no
limit); `"tell": false` trims without replying. The replies are paced, so
with many requests the answer can take a minute: `cat` it again until its
`at` is after you asked. Running it twice does nothing the second time. It
is audited as a change, naming what was trimmed.

### Where to look

- **Logs → Hourly checks** in the panel: every run, and the **↓ CSV** in its
  heading downloads every run kept, one row each.
- `~/whatsapp-bot/data/hourly-debug/`: `runs.json`, the scanner's memory, and
  one folder per run with the findings (`dossier.json`), the report, Claude's
  output, the ship and bot requests and their answers, and the restart
  record. Folders go after 30 days. `install.json` is what the installer last
  did (installed, removed, token saved; whether the token passed its test):
  the panel's fresh-install checklist reads it with `runs.json`, since the
  bot's own process cannot read the crontab.
- `~/whatsapp-bot/data/hourly-numbers/<run>.json`: each run's key from a
  masked number in its dossier (`+1555***0191`) to the full one. A request in
  the dossier gives its member's number masked (`requesterNumber`), and a
  member with no WhatsApp name is named by it; Claude names a member by the
  masked number in the report, and the panel and the email to your address
  show the full number in its place, while `report.md` on disk stays masked.
  The research sandbox cannot read this folder (it is with the WhatsApp
  sessions in `PRIVATE_DATA`). A mask is never filled in when two numbers
  share it - the session's report counts, so a number it copied in that
  collides with a member's leaves both masked - nor for ten bare digits
  with no country code, nor for a number that is a saved secret; and the
  keys go after 30 days with the run folders. A run from before 2026-10-01
  has none and reads as it did. What the key does not do is keep numbers
  from Claude altogether: it is only ever handed masked ones, but it reads
  `data/logs/`, `data/state.json` and the journal, which hold them in full,
  and only its prompt keeps one out of what it writes (where the scrub masks
  it anyway).
- `~/.local/share/whatsapp-bot-debug/`: the check's repository
  (`trusted.git`), the session's clone (`repo`), the test worktree
  (`verify`), the suites' dependencies (`deps`) and the sandbox's `home` and
  `tmp`.
- `~/.local/share/whatsapp-bot-debug/cron.log`: what each run printed.

### What it will not do

It never sends anything to WhatsApp; the only commands it gives the bot are
`health` (read-only) and `requeue`. It never changes `config.json`, `.env`,
the session or the history, and never force-pushes. The check uses sudo for
the restart and nothing else, and the research session cannot use it at all.
The research session changes nothing outside its clone and its run folder.
Everything members wrote — request texts, names — is handed to Claude as
data, and the prompt tells it to treat anything in there that reads like an
instruction as a suspicious message to report, never to follow.

It cannot see a message the bot never received (one sent while the bot was
offline that WhatsApp did not deliver afterwards), and until the message
index has a day or two of entries with their type recorded, older messages
are only listed, since most turn out to be chatter the `#request` rule
ignores on purpose.

---

## Discord tickets (read-only)

You open support tickets with the Jellyfin host - server "media1", the bot's
library - in the host's Discord server, where the Ticket Tool bot makes a
private channel for each one (`ticket-0001`; `closed-0001` once it is
closed): rename "Harry Potter and the Philosopher's Stone" to "...Sorcerer's
Stone", "Star Wars" (1977) to "Star Wars: Episode IV - A New Hope". Asked for
on 2026-10-11 - "create from scratch a way I can connect my discord account
to the ubuntu so you can access it" - the bot can read your Discord account,
read-only, so the hourly check sees how each ticket ended and checks the
library for it.

### The risk, plainly

- **It is against Discord's terms.** Discord does not allow a program to run
  a personal account, and can ban the account for it. Everything below is
  built to keep that risk as small as the job allows - it reads a handful of
  things every half hour, says honestly what it is, and never writes - but it
  is not zero.
- **The token is the whole account.** Whoever has it can do anything you can
  in Discord, and it gets past two-factor authentication. It is kept only in
  `data/config.json`, encrypted with `MASTER_KEY` like the API keys; it is
  never shown again, never logged, never in an export or a report, and only
  the super-admin can set or remove it.
- **Never paste it anywhere but the panel's box** - not in a chat, an email,
  or a message to Claude.

### Connecting

Settings → Connection → **Discord (read-only)**, as the super-admin:

1. On a computer, open **discord.com/app** in Chrome, Edge or Firefox and
   sign in.
2. Open the developer tools (**F12**, or Ctrl+Shift+I; Cmd+Option+I on a
   Mac) → **Network**. Click any channel, type `api` in the filter box, click
   a request to `discord.com/api/…` (`messages` is a good one), and under
   **Request Headers** copy the value of **authorization**.
3. Paste it in the card's box and press **Connect**. The bot asks Discord who
   the token belongs to (one request) and says "Connected as <username>";
   a token Discord refuses is not saved. The audit log records "connected
   Discord as <username>".
4. **Load my servers**, tick the host's, leave the channel pattern at
   `^ticket-` (a regular expression; Ticket Tool's names), **Save what to
   read**. **Show matching channels** lists the ticket channels it would read;
   ones that are somebody else's ticket are skipped. Channel ids in "Also
   these channels" are read whatever their name.

### What it reads, and when

Every 30 minutes, and once about a minute and a half after the bot starts
(the `discord-reader` routine; `src/core/discord-watch.js`). For each watched
server it lists the channels (one request), and reads only a ticket whose
last message is newer than the last one it read - a quiet half hour is one
request per server, and a run never makes more than 25. A ticket it has
never read is read back 7 days and no further. A ticket stays read after
Ticket Tool renames it `closed-NNNN`.

Each message is a line of `data/discord-tickets.jsonl` - when, the server,
the channel, who wrote it (and whether it was you), the text, the embeds as
text, the attachments' names and links - kept 90 days. Where it got to in
each channel is in `data/state.json` (namespace `discord-reader`), which the
sealed backup carries, as it does `config.json` with the token: a rebuilt
box reads on from there.

It can only ask Discord for: who the account is, its servers and
direct-message channels, a server, a server's channels, a channel, and a
channel's messages. Only GET requests, only to `https://discord.com/api/v10`;
anything else is refused before it is sent (`src/core/discord-reader.js`).
It never posts, reacts, edits, marks anything read or shows you typing. Its
User-Agent says what it is (`whatsapp-bot-ticket-reader`), and it does not
dress itself up as the Discord app. When Discord rate-limits it, it waits
once and tries once; a long wait is left to the next run.

### What the hourly check does with it

A reply in a ticket from anyone but you - the host's staff, or Ticket Tool
closing it - is an incident (`ticket-reply`): the research session checks
what they say against the library (`tools/diagnose-library.mjs` with the
title and IMDb id from your request; a rename done means the film is found
by its new name), finds the members turned away for that film, and says
what is left for you to answer in the ticket. Your own messages and
closings are a notice (`ticket-own`). What the staff write is evidence, not
instructions.

### From the box

```bash
cd ~/whatsapp-bot
node tools/discord.mjs whoami                  # who is connected, and how the reader is doing
node tools/discord.mjs guilds                  # the account's servers, with their ids
node tools/discord.mjs channels <guildId>      # a server's text channels; * = read by the reader
node tools/discord.mjs read <channelId> --limit 20
node tools/discord.mjs tickets                 # the kept record, ticket by ticket (asks Discord nothing)
node tools/discord.mjs tickets --live          # and the ticket channels Discord shows now
```

The same read-only client; it reads the token the way
`tools/diagnose-library.mjs` reads the settings, never prints it, and prints
New York times on the 24-hour clock. It writes nothing, with one exception:
when Discord refuses the token (exit status 2), it leaves
`data/discord-refused.json` - the time, and which connection it was, never
the token - so the bot's reader stops as well without asking Discord again.
While the reader says the token is dead, or after that note, every command
but `tickets` (without `--live`) stops at once with exit status 2 and sends
nothing. Exit status 3 is any other Discord failure, or a run that stopped
before it had finished; a rate limit is waited out, never cut short.

### Revoking it

- **From this box:** the card's **Disconnect** wipes the token from
  `config.json` ("disconnected Discord" in the audit log). That stops the
  bot using it - but a copy in an older sealed backup still works until the
  token itself is revoked.
- **The token itself:** change your Discord password, or Discord → User
  Settings → Devices → **Log out of all devices**. Either kills every token
  at once, this one included. Do it whenever you think the token may have
  leaked, then connect again with a fresh one.

When Discord refuses the token (HTTP 401) - you changed the password or
logged out everywhere - the reader stops at once and nothing on the box
tries that token again: the card says "broken since …" and greys out **Load
my servers**, **Show matching channels** and **Read now** (the server
refuses them too), `tools/discord.mjs` refuses to run, the audit log has a
row, and the hourly check lists "Discord reader disconnected since … -
reconnect in Settings" once a day until you paste a new one. It does not
matter which of them Discord refused first: a 401 the command line gets is
left in `data/discord-refused.json`, and the bot takes it as its own. Only
**Connect** with a new token starts it again.

---

## "It says we don't have it, and we do"

The panel's **Logs → Not in the library** section lists every request refused
for that reason and no other, with a note under each row saying what the lookup
actually did. Start there.

For a definitive answer about one title, ask the live Jellyfin the same
questions the bot asks:

```bash
cd ~/whatsapp-bot
node tools/diagnose-library.mjs "Kitchen Nightmares"
node tools/diagnose-library.mjs --movie "Dune"
```

It runs all four lookup layers side by side, scores the closest titles the way
the bot does, shows the library access of the Jellyfin account the bot searches
as, and ends with a verdict. It reads the bot's own configuration, sends nothing
to WhatsApp, changes nothing, and never prints the token.

The single most common cause is the last one you would guess from the panel:
**the bot searches Jellyfin as its own account**, and if that account has not
been granted the TV library, every show in it is invisible to the bot while
being perfectly visible to you. Jellyfin → Dashboard → Users → *the bot's user*
→ Access.

## One film per request

A movie request that asks for several films at once is refused before
anything is looked up: ☝️ on the request (`movieRequests.reactions.oneAtATime`),
a History row `one-at-a-time`, and a line in the notifications group saying
what to send instead, with the group's real prefix:

> ☝️ "the equalizer 1 & 2" — one film per request. Send each on its own: "#request the equalizer", then "#request the equalizer 2"

With **Also send a text reply when blocking** on, the same advice is a quoted
reply in the request group. The operator's rule (2026-10-11), about "the
equalizer 1 & 2", "the extraction 1 & 2" and "rocky 1 2 3 4 5 and 6", which
had all been asked for a year: "these dont need year, they should get denied
because they didnt ask for 1 movie at a time". It applies in every group, beta
tests and `$stamtest` included, with no beta flag.

What counts, in `src/plugins/movie-requests/several-films.js`: a title
followed by two or more film numbers joined by `&`, `and`, `+`, commas,
slashes or spaces, or a range (`1-8`, `1 to 3`, `1 thru 6`), with or without
`part` / `vol` / `chapter` (`kill bill vol 1 and 2`), roman numerals joined by
a word (`rocky ii and iii`), the same title twice with two numbers (`ocean's
11 & ocean's 12`), and a series in words (`all the harry potter movies`,
`harry potter all`, `the matrix trilogy`). A single film whose title holds
numbers - `2 fast 2 furious`, `ocean's 11`, `9 to 5`, `fahrenheit 9/11`,
`harry potter 7 part 2` - goes through untouched; every title in
`library/clean-titles.json` is checked against it in
`test/one-film-per-request.test.mjs`. A title that ends in "all" or "both"
after a pronoun, a contraction or a word like "for" or "takes" - `kill 'em
all`, `free for all`, `winner takes all`, `gave it my all` - goes through
too: it is not a request for every film of a series called "kill 'em". The
lines it suggests are the title as the member typed it. Anything it is
unsure of is let through, since a missed refusal is only the old behaviour
and a wrong one denies a member their film. Nothing it refuses reaches the
wanted or not-in-library lists, and the hourly check lists such rows as
notices only.

## Who goes first: the cooldown and the fair queue

Films and TV share one queue. With **Movies always before TV** (Settings →
TV, on by default) every waiting film starts before any episode; otherwise
the queue runs in arrival order. Each section's **per-user cooldown** refuses
a member's next request inside the window with 🚫, so one person cannot
fill the queue; group admins are not held to it, and requests an admin
queues from the panel never meet it. `0` switches it off, with everything
below.

**The clock starts only when a request puts something in the queue** - a
film, a TV request with at least one episode queued, or a pick from a "which
one?" list that queues its film. The operator's rule of 2026-10-01, after
Ben Lewis's "shaft 2019" was refused as rated R and the hour's film
cooldown it had started gave his next three requests 🚫: "if the 1st item
is denied to rated r or not in library etc cooldown should not apply" ...
"cooldown is only if the members first request actually puts an item in
queue, otherwise why we cooling him down???" A request that queues nothing -
refused on its rating, not in the library, not found, a year or a season
asked for, a pick list shown, a duplicate, still in cinemas, a beta test or
`$stamtest`, an error - leaves the clock exactly as it was. Each section has
its own clock, and a beta group its own again. The code is
`src/core/request-cooldown.js`, and both plugins' `_cooldownGate`.

Two more rules come with it:

- **A request sent while the member's previous one is still being looked
  up waits for it** (in the same section), and is then judged by what that
  one came to: queued, and the new one gets 🚫; not, and it runs. A lookup
  with the AI check can take twenty seconds and more, and deciding before it
  settled would mean refusing blind - the incident again - or running both
  and queueing both. The wait lasts until that one settles, or at most as
  long as its section's lookup can take: 4 min 45 s for films
  (the AI check's chain and the library search's ceiling), six for TV (the
  AI checks' five-minute budget for one message, and a minute more). It was
  a minute at first, and a TV lookup took 72 s the same day; a request let
  go before the earlier one settles runs beside it, and both can queue. A
  request still being looked up past that is taken as not queued, with a
  log line. A TV message of several seasons lets the next request go as soon
  as its first season is queued, rather than after its last.
- **The flood backstop.** Five requests of a member's in a section answered
  without queueing within ten minutes, and their next ones get 🚫 until the
  oldest of those five is ten minutes old. Each answer costs the number a
  reaction and most cost a line in the notifications group or a quoted reply
  ([whatsapp-ban-risk.md](whatsapp-ban-risk.md)), and until this rule the
  clock was what limited them. Every answer counts - refusals, lists,
  "which season?", "add a word", a duplicate, a passed beta test (towards the
  beta group's own count), and the bot's own failures too: a lookup that
  failed, a full queue, Jellyfin not set up. Those never start the clock,
  but each is still a ⚠️ and a full queue a notifications line, and left
  uncounted nothing limited them (found in review, 2026-10-01: ten requests
  into a full TV queue drew ten lines). Not counted: a 🚫 itself, a request
  that threw before it was answered, and a pick from a "which one?" list,
  which the list invites; a list is bounded by its own length and its ten
  minutes, as a refused version is struck out. While requests are paused,
  the member's requests already held count as well, since each is answered
  on resume: at most five of one member's are held in a section, counting
  their answers of the last ten minutes, and the next gets 🚫 as it arrives.
  It logs a line when it trips (`films: <who> has had 5 requests answered
  without queueing in 10 min ...`), and its 🚫 lines read `ignoring <who>:
  cooling down (...) - ... (the flood backstop)`, which the hourly check
  reads as it reads the cooldown's. The numbers are `COOLDOWN_LIMITS` in that
  file, the waits `FILM_LOOKUP_WAIT_MS` and `TV_LOOKUP_WAIT_MS` in the
  plugins. Clocks of the old kind (a bare timestamp, from before the rule)
  are not honoured and are cleared at start-up, with answers long out of the
  window.

A pick from a "which one?" list is not a new request and meets neither, and
the one answer to "which season?" - naming a season of the same show - goes
through whatever would refuse it, as the question asks for it.

Two options, both on by default and each switched off by unticking it, were
added at the operator's request (2026-09-30: "By default on of course but
yeh should be options"). **Skip the cooldown while nobody else is waiting** (Settings →
Movies → Request rules, and its own box on Settings → TV) lets a request
inside the cooldown through when no other member has anything waiting or
running in the queue, films and TV together; the member's own requests do
not count, and the clock starts again if it queues. "If queue is completely
empty then obviously theres no issue with someone doing multiple requests."
Anything queued from the panel counts as somebody else's, so the cooldown
holds while it waits. It never waives the flood backstop: a request that
queues nothing leaves the queue as empty as it was, and the review of
2026-09-30 found one member's ten "#request The Boys" drawing twenty messages
when the option let them all through. (Until 2026-10-01 it asked the queue
whether the request that started the clock had queued anything,
`queuedSince`; now every running clock was started by one that did.)

**Fair queue** (Settings → TV, under Movies always before TV) takes turns
between members: everyone's first request goes before anyone's second, every
second before any third, and among equals the one asked for first goes
first. A request's number is fixed when it is queued - one more than the
member's requests then waiting or running - so a member's extra request stays
behind each new member who asks for one thing, however many come, and never
jumps back ahead when their first one finishes. A TV season is one request.
With Movies always before TV on, a member's extra film also waits behind the
TV until the film cooldown has passed since it was first queued - a restart
does not start the wait again, as it did until 2026-10-12, a fresh hour behind
the TV each time - and then goes
ahead of the TV again; the queue wakes itself at that moment, so the panel
and the number reactions move without anyone sending anything. It wakes
too when a cancel turns a held film into its member's first request. Anything
queued from the panel counts as a first request, and so does a retry: they
are never bumped back, and go ahead of extra requests already waiting. Once
an admin moves a request with the arrows, the waiting line keeps the order it
is left in: every request then waiting keeps its rank, so a later cancel
cannot reorder it, and new requests are placed among them by the fair order.
Only a held film whose hold runs out changes lanes. The Queue card marks an
extra request *extra*, and a held film *after TV until 16:05*. A request that
had started before a restart is still running after it: recovery puts it back
ahead of everything waiting, whatever its rank, in the order the interrupted
requests had started, never held behind the TV and with no place number - its
message shows 🔄, and the Queue card lists it under running until a slot is
free. The rest go back in the fair order. On 2026-10-11 Thor: The Dark World,
started at 14:54 UTC and downloaded by 14:56, came back from the 15:22 restart
as its member's second request, and Ocean's Eleven, queued at 15:18, took the
slot. The plugins journal when each request first starts, and 0 until then; a
journal written before that was recorded is read from the work on disk (never
work begun before the request was made, which a request takes over from a
parked one) and for TV from the episodes that had ended. Before anything goes
back, both plugins tell the queue what will (`expectBack`): each request is
ranked among its member's by when it was asked for, those still to come back
included, so a season that goes back after the films still counts against its
member's waiting film; and a slot is kept for every request that had started
until it is back, so a film whose lookup fails at boot and is put back by its
retry a minute later finds its slot free. A slot is kept for ten minutes at
most, and the log says which request it was kept for. The code is
`src/core/queue.js` (`fairShare`, `hasOthers`, `startedBefore`, `expectBack`).

**A request asked for inside the cooldown is an extra** too, whatever the
count says. The operator (2026-10-12): "if any user did a request within the
3600 seconds/1 hour cooldown period it should go to bottom as extra". By the
count alone a member whose previous request had left the queue - finished,
or forgotten by a restart - was back to a first request a minute later. Now
a request the cooldown lets through inside the member's clock of that kind
(TV's for TV, the films' for a film) - because nobody else was waiting
(cooldownOnlyWhenOthersWait), or as the one answer to "which season?", or a
pick from a "which one?" list - goes in at rank 2 at least, decided by the
cooldown's own clock as it judged the request, and is journalled so, so a
restart keeps it. Never an admin's request, one queued from the panel, a
retry, or anything while that cooldown is 0; with the fair order off it
changes nothing. The log says "… was asked for inside …'s cooldown, 1m after
their "…" was queued - an extra in the fair order". What was waiting before
this is marked once from the box, from the plugins' History - the member's
previous request of the same kind that queued something, if it was asked for
less than the cooldown before. Queued something means what starts the
clock: a TV row whose episodes went in, a film that went into the queue
(lost to a restart since, too); never a request sent again while it waited,
one posted with somebody else's, or a season a restart left unadded.
Without `apply` it only says what it would do; run again, it changes
nothing:

```bash
echo '{"op":"mark-extras"}' > data/bot-cmd.json && sleep 5 && cat data/bot-cmd.result.json
echo '{"op":"mark-extras","apply":true,"by":"your name"}' > data/bot-cmd.json && sleep 5 && cat data/bot-cmd.result.json
```

It leaves an admin's moves alone: a request left where it stood when an
admin moved something else goes behind the first requests like any extra,
and one an admin moved by hand stays where they put it (it is an extra from
the next restart, which forgets every move anyway). It refuses to apply
while a restart is still putting requests back. `src/core/mark-extras.js`.

## Queueing a film from a public link

A film that is free to download from a public site does not need to be in
Jellyfin. The operator (2026-09-30): "For a movie like plandemic being that
it's free there's a public download link for it, so there should be a box on
the panel where an admin can manually enter any public mp4 download link and
it'll queue and process, why should it need to be jellyfin if it's public
anyway".

On the Dashboard, **Queue a public link** takes the direct download link of
the video file, the title it is posted under, and a year (optional). Queue
answers *Queued: Plandemic (2020) - 1.2 GB*, or says why not. The film then
goes through the normal pipeline: its own work directory, the download (going
on from the byte it reached after a restart or a dropped connection when the
server serves ranges and says Last-Modified or an ETag, from the start when
not), the conversion (GPU or CPU, in pieces where it can be), the upload to
the movie posts group as `Title (Year).mp4`, and a History row. It is resumed
after a restart from its link, not looked for in the library.

**No rating gate and no AI check.** An admin queueing a link by hand, and
naming the film, is the operator's approval, as an entry on the bypass list is.
The AI check only ever helps a request through, and there is no rating here for
it to help past.

What is checked is the link, because the bot fetches it from the home LAN,
next to the router, Jellyfin and the tailnet:

- Only `http://` and `https://`; `file://`, `ftp://` and the rest are refused,
  and so is a link with a user name or password in it.
- Every address the host resolves to must be public. Refused: loopback
  (127/8, `::1`), RFC 1918 (10/8, 172.16/12, 192.168/16), link-local
  (169.254/16, `fe80::/10`), CGNAT 100.64/10 (Tailscale's addresses),
  multicast and reserved space, unique-local `fc00::/7`, IPv4-mapped and NAT64
  IPv6, 6to4 and Teredo. The check is made in the connection's own DNS lookup,
  so the address checked is the address connected to.
- Every redirect is checked the same way, and at most five are followed. A
  public host that redirects to a private one is refused.
- Any port, since the address is public by then.
- A link whose server says the file is over **Largest public link**
  (Settings → File handling, `media.maxDownloadBytes`, 20 GiB by default) is
  refused before anything is queued; one that says nothing is stopped while
  downloading once it passes the limit, and its History row says so.
- The link must be a video: a `video/*` content type, or, when the server says
  only `application/octet-stream`, first bytes that are a video container or
  that ffprobe finds a video stream in. A web page or anything else is refused
  with *That link gives a web page (text/html), not a video*.
- Thirty seconds for the server to answer, and two minutes of silence in the
  middle of a download, count as the connection dropping.

The same link, or the same title and year, already waiting is refused as a
duplicate. The link's query string can hold a token: the full link is kept only
in the job's journal entry under `data/`, which the download needs; the log,
History, the audit log and the panel show the host and path alone. The hourly
check does not re-run such a film by title - queue the link again.

### YouTube links: yt-dlp

On 2026-10-11 a YouTube link pasted into the card was refused as *a web page
(text/html)*, and the operator asked to "add ytdlp and whatever else needed to
the bot system". So a link to a video page goes through
[yt-dlp](https://github.com/yt-dlp/yt-dlp) (`src/media/yt-dlp.js`) and from
there down the same pipeline as a file: its own work directory, the
conversion, the post, History and the audit log.

- **As it is pasted**, the card asks the server about the link and says what
  it is under it: *from YouTube via yt-dlp - 1 h 32 min · about 1.4 GB*. The
  page's title fills the name when none was typed; Queue with no name only
  fills it in, for you to check, and Queue again queues it.
- **Which links:** YouTube (`youtube.com`, `youtu.be`), Vimeo and Dailymotion
  go to yt-dlp at once. Any other link is asked for as a file first, exactly as
  before, and goes to yt-dlp only when it answers with a web page; a page yt-dlp
  knows nothing about is refused with the old sentence and *yt-dlp has no
  extractor for that site either*. A playlist, a live stream and a premiere
  not yet shown are refused before anything is queued.
- **What is fetched:** H.264 video and AAC audio up to 1080p, merged into an
  mp4 - which the converter sends as it is, or only repackages, when it fits
  under 2 GB - or, failing that, the best of any codec up to 1080p. Never 4K to
  be shrunk to 720p.
- **The same rules as a file link**, kept from outside yt-dlp, which makes its
  own connections: the link's host must resolve to public addresses only,
  checked before yt-dlp starts; yt-dlp runs only its site extractors
  (`--use-extractors default,-generic`, never the generic one, which would
  fetch any page); `--ignore-config`, `--no-plugin-dirs`, no `--exec`, the
  link after `--`, no shell. **Largest public link** caps it too: refused up
  front when yt-dlp's estimate is over it, and stopped while downloading when
  it passes it.
- **History and the audit log** show a YouTube link with its video
  (`https://www.youtube.com/watch?v=...`), and never the share button's `si=`
  or any other part of its query; every other site's query is never shown, as
  before.
- **A restart** converts a finished yt-dlp download without running yt-dlp
  again; one cut off in the middle goes on from the streams it had (yt-dlp's
  `--continue`, in the job's `yt-dlp/` folder).

**On the box** (the `yt-dlp` routine, every bot box): the official yt-dlp
zipapp at `~/.local/bin/yt-dlp`, run by python3, and deno at
`~/.deno/bin/deno`, both installed without root by `node tools/install-yt-dlp.mjs`
(bootstrap and `node tools/routines.mjs --fix` run it), each checked against
the SHA-256 its release publishes. Deno is yt-dlp's JavaScript runtime for
YouTube's player code: yt-dlp takes node only from version 22, and the bot
runs on 20 - tried on the bot box on 2026-10-11, node 20.18 was "unsupported",
and without a runtime yt-dlp warns that some formats may be missing.
`node tools/install-yt-dlp.mjs --check` says what is installed.

**The daily update** (the `yt-dlp-update` routine, inside the bot): YouTube
breaks an old yt-dlp within weeks, so every hour the bot looks at
`~/.local/state/whatsapp-bot/yt-dlp.json`, and once the last good check is a
day old (six hours after a failed one) it runs `yt-dlp -U` - on a copy, which
it renames over the original when it took a new release. Never while a yt-dlp
of its own is running: the zipapp's own `-U` writes over the file a running
yt-dlp is still reading its code from. The `yt-dlp` routine flags a box whose
last check is three days old (a bot that is not running, or one whose updates
keep failing - the record says why), or whose release is 120 days old; its
`--fix` runs `node tools/install-yt-dlp.mjs --update`, which refuses while any
yt-dlp process runs on the box.

**Cookies** (Settings → Library & files → File handling → *Cookies for
yt-dlp*): yt-dlp fetches as a visitor unless it has some. In a private
window, sign in to YouTube with a **secondary Google account, never your main
one** - yt-dlp's own documentation warns that YouTube can ban an account used
this way - open `https://www.youtube.com/robots.txt` in that same tab, export
youtube.com's cookies with the *Get cookies.txt LOCALLY* extension (the
Netscape cookies.txt format), close the window so the browser never rotates
them, and upload the file. It is kept at `data/yt-dlp-cookies.txt`, mode
0600, and carried by the sealed backup; no page or route ever sends it back -
Settings shows only that it is set, when and by whom it was uploaded, how many
cookies, whether youtube.com is among them and signed in, and when they
expire. yt-dlp is given a copy for each run, deleted after (it rewrites the
file it is given). Every upload, refusal and removal is in the audit log,
under Settings. **Remove** forgets them.

**When YouTube asks for sign-in.** The card, or the film's History row, says
*YouTube asked this server to sign in before it would hand over the video
("Sign in to confirm you're not a bot")*, or *The video is age-restricted*.
Neither is retried on its own.

1. Upload cookies as above, then queue the link again.
2. Cookies uploaded and it still asks: Settings says whether they have
   expired, or are not signed in. Export them again (a new private window) -
   YouTube invalidates cookies that were also used in a browser - and upload
   them.
3. Still: `node tools/install-yt-dlp.mjs --update` (or wait for the daily
   update), since YouTube's changes are often what an older yt-dlp trips on;
   and `node tools/routines.mjs` shows whether yt-dlp and deno are in place.

From the bot box on 2026-10-11, without cookies, yt-dlp read YouTube videos
with no sign-in wall; a datacenter address meets it far more often than a
home one. *HTTP 429* (asking too often) is retried later; cookies usually make
it go away. A private, members-only or region-blocked video says so, and
cookies do not help with those unless the account itself can watch it.

---

## Trying a feature in the beta group

New group-facing features are tried in a test group before the main groups see
them. Set it up once, in **Settings → Beta 🧪**:

1. Tick the test group (e.g. *Testing things*) under **Beta groups**. A group
   the main service already uses cannot be ticked, and the server refuses it
   if a stale page tries. It works the other way round too: the Settings, TV
   and direct-links saves refuse to make a beta group a main one — take it off
   the beta list first.
2. Pick a **Beta posts group** (e.g. *#test movie posts*), or leave it on
   *back into the beta group* to have films posted where they were asked for.
3. Set the feature to **Beta**. **On** means every group, the main ones
   included, and asks for confirmation.

The three features in the registry - TV episodes withheld on rating, a film
asked for twice and TV asked for twice, each described below - are **On** by
default on a new install since 2026-10-12, the operator's live modes; a mode
saved in the panel, Off included, is kept. An install upgraded from before
then keeps every feature it never switched on **Off**: its `config.json`
names no mode for them unless the Beta tab was saved, and the first start on
the new code writes them Off (`keepSavedChoices` in `src/config/store.js`,
said once in the log as *kept what this install chose*), so an upgrade - of
the second bot as much as this one - changes nothing its groups are told. A
feature retired from the registry leaves `DEFAULT_CONFIG.beta.features` in
the same commit, or its default would bring its old mode back.

Then ask in the beta group exactly as members would. It takes movies and TV: a
message naming a season (*The Boys season 1*, *The Boys S01E02*) is TV, and
anything else is a movie — including *Ocean's 12* and *Star Wars Episode 4*,
and a show asked for by episode alone, which gets the "name a season" answer.
Each group's own prefix still applies when one is required.

**Who is testing matters.** If the beta group is on *Always locked* (as
*Testing things* is), only admins can post in it — and admins skip the
cooldown and are exempt from moderation by default. A feature that changes
what *members* see (cooldowns, moderation, a member-facing reply) is then not
exercised at all. Take the group off *Always locked* for the test, or have a
non-admin member ask. The file, the live updates and every tag stay in the beta groups —
the main notifications group hears nothing — and History marks the row
🧪 beta, with no Re-run button (a re-run from the panel would go to the *main*
posts group; ask again in the beta group instead).

Beta jobs share the one queue with real requests, so a long test encode does
delay members. Test with short films at a quiet hour. Taking the group off the
list does not reroute anything already queued: each job keeps the destination
it was given when it arrived, including across a restart. The one exception is
a destination that has since become a *main* group: the file then goes back
into the beta group it was asked in, and if that has become a main group as
well the job fails with the reason in History rather than post a test to real
members.

### The "which one?" list

Every request group has it, and there is no setting for it. It was the beta
feature **beta001 — movies with series** (`movie-pick-list`) until
2026-10-11. The operator had taken it out of beta, but its mode lived in
`config.json`, and on 2026-10-10 the live one held `beta.features: {}` - what
a rebuilt box or a restored config has - so Heat, Insomnia, Casino Royale,
The Girl Next Door and Venom were each asked "which year?" instead of being
listed: "we already moved that the bot should respond listing all out of
beta, so why didn't it work for those?" The flag was then deleted; `beta001`
is a retired code (a tester who sends it is pointed at `$stamtest`), and a
`movie-pick-list` mode left in `config.json` does nothing and is cleared by the
next save of the beta card. The one switch is Settings → Movies → **Ask which
one when several films share a title** (`movieRequests.requireYearWhenAmbiguous`),
which decides whether the question is asked at all.

A request with no year gets one quoted reply in the group it was asked in,
listing every *sendable* film on the server whose title **starts with the
words typed** — the whole series — each with a line of plot, and the requester
answers with its number:

```
🔍 *Search results for "john wick"*

*1.* John Wick (2014)
_An ex-hit-man comes out of retirement to track down the gangsters that killed his dog._

*2.* John Wick: Chapter 2 (2017)
_After returning to the criminal underworld to repay a debt, John Wick discovers…_

Reply with a number (1–2), or react with it, to get it. This list expires in 10 minutes.
```

It is laid out in WhatsApp paragraphs - a bold header quoting the words
typed, one numbered block per film with its plot in italics, and the reply
line apart - because the operator found the one-line-per-film version "in
messy format" (2026-09-30). A version refused after it was picked is edited
to `~2. Title (Year)~ — can't be sent`, and a test in the beta group says
"to test it. Nothing is downloaded." instead of "to get it". Asterisks,
underscores and tildes are taken out of titles and plots, so OMDb's text can
never break the italics. A test that passes is answered the same way:

```
✅ *Test passed* ($beta004)

The bot would send *Mission: Impossible - Ghost Protocol* (2011), 1.40 GB.
Nothing was downloaded.
```

The plot is OMDb's short plot, cut to its first sentence and about a line; it
is fetched only once a list is certain to be posted (one lookup per film,
cached, four seconds in all), and a film OMDb has none for — or is too slow
about — is listed without one. Movies only: a TV show is still asked for with
its season. That covers the
remakes of one title (Venom 1981/2005/2011/2018) and the franchise around it:
`harry potter` lists the nine Harry Potter films on the server, oldest first,
a block each ("*3.* Harry Potter and the Prisoner of Azkaban (2004)", its plot under it), and
`cars` lists Cars, Cars 2 and Cars 3 — the film called exactly that is not the
only one offered. Matching is by whole words, ignoring case, punctuation,
"&"/"and", roman numerals and a leading *The/A/An*, so `hobbit` and `the
hobbit` get the same list and `cars` never offers *Carson City*. "Movie" and
"film" are kept, because films are called *The Muppet Movie* and *Scary
Movie*: the search drops them, the matching does not, so `the garfield movie`
is the 2024 film and not everything called Garfield. They are also just how
people talk, so when nothing at all starts with the words as typed, the
shorter words get a second look — `harry potter movie` gets the Harry Potter
list — but that second look may only ask a question, never queue a film. A
title needs at least one word of three letters or more that is not a filler
word: `#request the` never lists, and a title made only of short words (*It*,
*Up*) is offered only its same-title remakes, as before.

Only the requester's digit counts, only in that group, only for 10 minutes
(`movieRequests.pickList.expiryMinutes`); the first right number wins. The
pick then runs as if they had sent `#request Venom 2011`, and every reaction
lands on their original request. A film rated on the blocked list is
offered only when the bypass list covers it (by title and year, or a
Jellyfin link to every blocked copy) or the AI check could clear it
(`aiCanClear`: the check on, with leave to clear a rated film). The AI is
not asked while the list is made - Gemini allows twenty checks a day - but
only about the film picked, through the same gates as any request; if it
does not clear it, the request gets ⛔, the film is struck through on the
list, and the list stays open for another number. This came from "$beta001
john wick" on 2026-09-30, whose four R films were listed as none and then
cleared one at a time as single requests. A film with no rating at all in
Jellyfin is never offered, nor a series; two copies of one film are one
line. A request that names a year never gets a list.

**Or they react with it.** A number emoji put on the list - 1️⃣ to 9️⃣, or
🔟 - is the same pick as the number typed (the operator, 2026-10-01: "for
beta001 users should be able to react with a number emoji instead of
replying"): first pick wins, a number not on the list or already struck
through gets ❓ from the bot on the list itself, beside the member's number
(a reaction cannot be reacted to, and ❓ on the request would say "couldn't
match that title"), taken off again once they pick one that is on it; and
History and the log say `reaction` where a typed one says `digit`. Only
the requester's reaction counts, and only on the list's own message; any
other emoji, anyone else's reaction, and a reaction on any other message are
ignored without a word. The keycaps stop at 🔟, so on a list longer than ten
the rest are typed, and the list's last line says so ("… or react 1️⃣–🔟
for one of the first ten"). Changing the reaction afterwards changes nothing:
the first pick won. A reaction taken off is ignored. In the beta group it
works the same, for the list a film test opens (`$beta004 #request venom`)
and for the one inside a `$stamtest`'s answer (react on that answer). While
requests are paused it is held like a typed number, with its ⏸️ on the
request, and run on resume.

How it reaches the plugin: [`src/core/bot.js`](../src/core/bot.js) hands a
member's reaction on as a message with `msg.reaction = { emoji, targetId,
targetFromMe }` and no text, from `messages.upsert` only (Baileys sends each
reaction a second time as `messages.reaction`, which is not listened to, so
nothing is handled twice), and refuses to react to one. Only the movie
plugin's lists act on it; reading a reaction sends nothing.

The whole decision is made from one Jellyfin search (it asks for 60 results
rather than the pipeline's 25, so a franchise is seen whole) before OMDb or
Gemini is asked anything:

| Sendable films starting with the words | What happens |
|---|---|
| none | the request carries on exactly as before, to the answer it always got |
| one | it is requested by title and year (`harry potter and the prisoner` → *…Prisoner of Azkaban 2004*), beta001's rule as the operator approved it, now in every group: a bare `barefoot` with only *Barefoot Gen* on the server sends *Barefoot Gen*, and `cars` with only *Cars 3* sends *Cars 3* (a year typed, as in Mia's `Barefoot 2014`, never reaches step 0, and is still "not in library"). When OMDb does not know the library's title (*Mission: Impossible - Dead Reckoning Part One*), the request is looked up by the words typed instead, as it was before the list. A film held once under exactly the name typed, with nothing else starting with it (*Inception*), runs exactly as before; so does a title held exactly but not sendable when the one sendable match is another film (*Alien*, R, is refused rather than *Alien Xmas* sent) |
| 2 to 20 | the list — the whole series, answered with one or two digits (`pickList.maxOptions`, default 20; a saved 5 or 9 was only ever a default written back, and reads as 20) |
| more than 20 | the films called exactly that, when there are 2 to 20 and they are at least a quarter of the matches; otherwise one quoted reply instead of a list, no OMDb call: *36 films start with "batman" — add a word or the year, e.g. #request Batman: Hush*, and 📅 on the request |

**When "which year?" is still asked.** The older answer - 📅 on the request,
*📅 Venom — we have 2005, 2011, 2018. Send #request Venom 2018* in the
notifications group, and *There is more than one "Venom" on the server (…).
Which year?* in the request group when *Also send a text reply when blocking*
is on - is now only the fallback, for a title the server holds in several
copies that the list could not offer: its library search failed or timed out
(60 seconds), the library is not Jellyfin, no copy can be sent on the
library's rating, or the words typed are not how the library titles the film
and only OMDb matched them to it (a misspelling). A History row that says
`need-year` with "N copies: …" comes from that fallback; one that says "asked
for another word or the year" is the list's own "too many" reply.

**The Test tab answers the same way.** Its dry run takes step 0 through the
request's own code (`src/plugins/movie-requests/step-zero.js`): *Asks which
one — a list of N to pick from* where a request posts the list, *Too many
films start with that — the requester is asked for another word or the year*
for that reply, and for the one film a request goes ahead with, a *which one*
step naming it before the rest of the checks. Until 2026-10-11 it had only the
year question, and said *Ambiguous — needs a year* for Heat while members
were shown the list.

**When too many start with it, the films called exactly that are listed
anyway.** Matching on the start of a title counts a remake set together with
everything built on its name, which can push a set past the limit (20 since
beta001; it was nine). So a franchise past the limit falls back to the films
titled *exactly* what was typed, when there are 2 to 20 of them AND they are at
least a quarter of the matches — the case a bare title usually means. The list
then ends with a line saying how many other titles start with the words, and
a full name sent instead is still taken as a pick.

- *Cinderella*: 14 sendable, 5 of them called *Cinderella*. Under the old
  limit of nine the five were listed, with "(9 other films start with that
  too…)"; at 20 all fourteen are listed.
- *Godzilla* (27 sendable, 3 remakes) and *Batman* (36, 3 counting *The
  Batman*): the remakes are too small a share, so these still get the "add a
  word or the year" reply, which points at the film the member probably wants
  rather than three old ones.

Those counts come from `library/clean-titles.json`; check what the server
actually replies before trusting them for a title it does not cover.

The limit is `movieRequests.pickList.maxOptions`, default 9 — a reply is one
digit. It used to be 5, and every settings save wrote that 5 into
`config.json`, so a saved 5 is read as 9; any other value from 2 to 9 is
used as it stands. If the one search comes back with all 60 results, there
may be matches it did not see, so it never lists or picks from them: it asks
to narrow down ("At least 12 films start with …") or, with a single match,
leaves the request alone. The "add a word" reply, like a list, queues
nothing, so since 2026-10-01 it does not start the member's cooldown and the
follow-up it asks for runs; it counts towards the flood backstop instead
(five answers without queueing in ten minutes, then 🚫), which is what stops
one member triggering it over and over - each costs the group a message.
"Skip the cooldown while nobody else is waiting" never waives the backstop.

The list is built on Jellyfin's ratings and the request is still gated on
OMDb's, so the two can disagree (Carrie 1976: PG in Jellyfin, R in OMDb).
Such a pick is refused with ⛔ as usual, and the list is then edited to strike
that line through and stays open for the rest of its time, so another number
still works. With under a minute left it closes instead ("1 · Carrie (1976) —
can't be sent"). A failure that is not about the version — OMDb down, say —
strikes nothing, and the same number can be sent again.

**Test it with members, not admins.** *Testing things* is on *Always locked*,
so only admins can post there, and admins skip the cooldown and moderation —
which are exactly what a pick has to get past. Before trusting a result, either
add two or three non-admin testers to the group, or take it off *Always
locked* (Groups → Group lockdown 🔒 → Always-locked groups) for the test and
put it back afterwards. While a list is open, a number from anyone other
than its owner (`2`, or `#request 2`) is ignored — not acted on, and not
deleted either, even with moderation on: a member who answers a numbered list
they saw has done what the bot appeared to ask, and a deletion counts towards
the two strikes. Any other message from them is moderated as usual, and so is
a bare digit when no list is open.

Things to try, as a non-admin, each followed by the digit it asks for:

| Send | Expect |
|---|---|
| `#request harry potter` | a list of nine: the eight films, oldest first, and *Harry Potter 20th Anniversary: Return to Hogwarts (2022)* as 9. `3` queues *Harry Potter and the Prisoner of Azkaban (2004)*, and the list is edited to "✔ 3 · Harry Potter and the Prisoner of Azkaban (2004) — on its way". `#request harry potter 2004` picks the same film. Nine is the cap, so one more sendable *Harry Potter…* on the server turns this into the "add a word" reply |
| `#request cars`, `#request toy story`, `#request the hobbit` (or `hobbit`) | a list: the film of that name and its sequels |
| `#request Dune`, `#request A Christmas Carol`, `#request Venom` | a list; a digit queues that version, and the list is edited to "✔ 2 · Venom (2005) — on its way". *Dune: Part Two* is on the Dune list now |
| `#request the garfield movie` | *The Garfield Movie (2024)*, straight to the queue with no list — the one film held under exactly those words. Before franchise lists this queued *Garfield (2004)* |
| `#request harry potter movie` | the same nine-film list: nothing on the server starts with those words, so the shorter ones get a second look. `#request the muppet movie` is the other half of that rule — *The Muppet Movie* is not on the server and *The Muppet Christmas Carol* is never queued in its place |
| `#request batman` (36), `#request Godzilla` (27) — more than nine start with it, and few are called exactly that | no list: one reply naming the count and an example to send instead, and 📅 |
| `#request cinderella` (14 start with it, 5 called *Cinderella*) | the five remakes are listed, with "(9 other films start with that too — send its full name for one of those.)" |
| `#request Dune 2021` | no list — it has a year — sent as today |
| `#request 9` | with your own nine-item list open, a pick of the 9th. Otherwise not a pick, and not looked up as the film *9* either: a one-character title is ignored as it always has been (deleted as an empty request with moderation on). `#request 9 2009` asks for the film. `#request 21` is looked up as the film *21* |
| `#request John Wick` | with the AI check off, no list — every chapter is R, so there is nothing sendable to offer — the ⛔ it always got. With the AI check able to clear a rated film, all four chapters are listed and only the one picked is put to it; a chapter it does not clear is struck through and the list stays open |
| `#request the` | no list, no reply — handled exactly as before |
| a `7` on a 4-item list | one ❓ on the 7; the list stays open |
| react 2️⃣ on your own list | the same as typing `2`: the film is picked, its reactions land on your request, and the list is edited to "✔ 2 · …" |
| react 7️⃣ on a 4-item list, or 0️⃣ | the bot reacts ❓ on the list, beside your 7️⃣; the list stays open, and the ❓ comes off when you pick one that is on it |
| react 3️⃣ on someone else's list, 👍 on your own, or a number on any other message | nothing at all |
| react 3️⃣ after picking 2 (or change your 2️⃣ to 3️⃣) | nothing — the first pick won |
| nothing, for 10 minutes | 📅 on the request, and the list edited to "expired — send …" |
| another tester's digit while your list is open | nothing at all — not acted on, not deleted |
| a second number after your pick (`3`, or `#request 3`) | nothing — the first pick won |
| a pick the bot refuses (a version Jellyfin and OMDb rate differently) | ⛔ on the request; the list is edited with that line struck through and still takes another number |

The numbers are on the daily digest ("Pick lists: … shown, … picked, …
expired, … wrong numbers, median …s to pick, … too broad for a list") and in
`GET /api/beta` under `pickList` (`narrowed` counts the "add a word" replies;
how often that happens says whether nine is the right size). History shows
each list as `pick-list`, then the request's real progress once picked, or
`pick-expired` / `pick-replaced`; an "add a word" reply is `need-year`. A
franchise list is named in History as it was typed ("harry potter") and its
detail names every film offered. A picked row keeps what the member typed
("Venom") beside what was looked up ("Venom 2011"), and Re-run sends the
latter.

Everything pending is journalled in the movie plugin's state (`pickLists`)
and finished after a restart: an open list is re-armed with the time it has
left, one that ran out meanwhile gets its 📅, and a pick that was still being
looked up is run again, once. A list's 📅 that could not be sent because
WhatsApp was down is tried again a few minutes later; History says it expired
from the start. A list journalled before the flag went (2026-10-11) is
answered and closed the same way: nothing about an open list depends on a
beta mode any more, and one a `$beta001` test opened suggests `$stamtest` in
its "expired — send …" line, since its own code is retired.

**The group rules.** The list is a text the bot posts in a main request
group; with `replyOnBlock` off it is the only one, and the bot otherwise only
reacts there (it is on by default since the operator's request-rules
defaults of 2026-10-12, and then refusals are said in words too). The request
group's rules say "no replying to messages … only actual requests" and "two
strikes and you're removed" — and answering the bot's list with a bare `2` is
a reply that is not a request. The bot itself never deletes or counts that
number (a pick is taken before moderation), but the rules members read
should say that answering the bot's "Which one?" with its number is allowed
(Settings → Rules, and `rules.md` / `default-rules.txt` to match), and the
admins who enforce the two strikes by hand should know it.

### TV episodes withheld on rating (`tv-rating-notice`)

An episode can be rated harder than its show, and `tvRequests.blockedRatings`
filters each one. *Fullmetal Alchemist: Brotherhood* is TV-14, but episodes
14, 19 and 26 of season 1 are TV-MA, so the season goes out as 61 of 64. A
member read the three as "did not go through", then asked for S01E14 on its
own and got a bare ⛔. Which episodes are withheld is unchanged by this
feature; it only says so.

- **On** (or **Beta**, in the beta group): the "added to the queue" line names
  them — *61 of 64 episodes added to the queue. Episodes 14, 19 and 26 are
  rated TV-MA, which can't be posted, so they were left out.* A request with
  nothing left to send (one TV-MA episode, or a show rated as a whole) keeps
  its ⛔ and also gets *⛔ … rated TV-MA, can't be posted*, exactly as a film
  refused on rating does, and it obeys the same *blocked* step switch. With
  *Also send a text reply when blocking* on, both are also quoted replies in
  the request group.
- **Off**: the bare line, which names only the episodes queued (*S01E01–E13,
  E15–E18, E20–E25, E27–E64 — 61 of season 1 — added to the queue*), and a
  bare ⛔.
- **Every mode**: History names what was withheld (*S01E01–E13, E15–E18,
  E20–E25, E27–E64 — 61 of season 1 · 3 withheld (TV-MA): E14, E19, E26*),
  and a refusal writes a *Blocked: rating* row, where it used to write
  nothing. So does a request queued by hand from the panel, whose
  confirmation names the episodes.

A request that queued only part of what it asked for - episodes withheld on
rating, waiting already from another request, past the episode limit, or
missing from the library inside a run - is named by the episodes queued, in
the "added" line, the queue, History, the journal and the finished notice:
*Outer Banks S05E08–E09 — 2 of E04–E10*, a dash for every episode between
its ends and a comma for a gap (*S05E04, E10*). It used to keep the span
asked for, *Outer Banks S05E04–E10 — 2 episode(s)*, which the operator read
as E04 and E10 (2026-10-12). A request that queued all it asked for is named
as it always was.

The lines go to the queue notifications group. With that set to *none* and
*Also send a text reply when blocking* off, a member in a main group still
sees only the reactions, whatever the mode.

### A film asked for twice (`movie-duplicate-notice`)

"minority report 2002" was asked for three times on 2026-09-28 while the
first copy was still being made, and each request was queued: two copies ran
side by side and the film was posted twice. In **every mode** a film already
waiting or in progress for the same group (the main posts group, or one beta
group) is no longer queued again: the requester gets 🎬, and History records
the request as *duplicate*. When the film is posted, fails or is cancelled,
the duplicate's message gets the same final reaction as the first request
(✅, ⚠️ or ❌) and its History row that outcome (*posted, with an earlier
request for it*). A restart that finds a film journalled twice runs it once,
and the second request is told as a duplicate is. A film whose three retries in the process ran out is queued again
when asked for, and its old job is let go.

- **On** (or **Beta**, in the beta group): the notifications group is told
  *🎬 Minority Report (2002) — already in the queue, not added again*.
- **Off**: it is told *🎬 Minority Report (2002) — added to the queue*, the
  line such a request always got.

### TV asked for twice (`tv-duplicate-notice`)

"Loki season 1" was queued at 15:31 UTC on 2026-09-28 and again at 19:06
while its six episodes still waited, and "the mentalist S03E05" twice. In
**every mode** episodes already waiting or in progress for the same
destination are not queued again: a request with nothing new gets 🎬 and a
*duplicate* History row, and one that overlaps queues only the episodes that
are not waiting. A panel Re-run and the hourly check's requeue leave them out
too. A duplicate follows the request that holds its episodes: when that
request ends, its message gets the same final reaction and its History row
the same outcome (for a whole season, so one episode asked for inside a
season that partly posted hears *partial*).

- **On** (or **Beta**, in the beta group): the notifications group is told
  *🎬 Loki season 1 — already in the queue, not added again*, and for a
  request partly waiting *🎬 The Mentalist S03E01–E04, E06–E24 — 23 of season 3
  — added to the queue (1 more already waiting)*.
- **Off**: it is told the line the whole request always got, *🎬 Loki season 1
  — 6 episode(s) — added to the queue*.

### A member sending their own request again

On 2026-10-11 a restart put 🔄 - then the reaction for a request picked back
up after a restart - on Ethan Adams's "Iron Man 3 2013". He read it as
"send it again", did, and was answered 🤥. The operator: "Bot asked Ethan to
redo the iron man request and then reacted with 🤥 when he did". Since then:

- **No request is shown 🔄.** A request picked back up after a restart, or
  retried after a failure, shows where it is: its place in line while it
  waits, otherwise the stage it is at - ⬇️, ⚙️ or ⬆️ - or 🎬 when nothing of
  it has started (`src/media/stage-reaction.js`). The *Redo / resumed*
  reaction is gone from the settings, and an old `config.json`'s is dropped
  when the bot loads it.
- **A member's own request, sent again while it is waiting or in progress
  for them** - the same film, or the same episodes in one request of theirs,
  posted already or still to come - gets no 🤥 and queues nothing. Their new
  message shows what their first was shown: 🎬 and then its place, kept
  current as the line moves, or the stage it is at once it runs, and ends on
  the same ✅, ⚠️ or ❌. Its History row reads *resent*, pointing at the
  first (`resendOf`); it is not a duplicate, and the hourly check never
  counts it as the member asking twice or offers it for a re-run. The
  notifications group is told what a duplicate's line tells it, under 🎬
  rather than 🤥 (for a season the rating filter cut, that line names the
  episodes left out - what a member asking again usually wants to know).
- **Only the member who asked for it.** Somebody else asking for it is a
  duplicate and gets 🤥, every time they ask - having been given 🤥 once does
  not make it theirs.
- **The first resend is free; the rest are not.** The cooldown's flood
  backstop does not count the first message sending a request again, and
  counts every one after it, so a member sending the same request over and
  over still meets 🚫, as the duplicates they used to be did. The
  notifications group hears it once, and only the latest such message
  follows the place in line, so each one more costs its own reactions and
  nothing on every move of the line. A resend inside the member's cooldown
  still meets the cooldown (🚫) before it is looked up.
- An episode asked for on its own once it has been posted is a new request,
  and is queued as asked.

### Rating overrides for films and TV

**Settings → Movies → Request rules → Rated-R override** - the operator's
"rated R bypass" - is one list for films and TV, with nothing to choose: type
a title, or paste a Jellyfin link.

**Everything an entry covers is sent, with no AI check** - whatever its
rating, whatever a model would say, and whether the check is on or not. On
29 September 2026 Gemini answered 503 all afternoon, Groq said *The Last
Samurai* had nudity (IMDb says it has none), and the film, listed by hand, was
held back: "Why ask Gemini if I already added it to rated R bypass manually
in panel?" Asked what adding a title should do, the operator chose: "Send it,
no AI check". Until then an entry only put a title in front of the check,
which had to confirm no nudity. The same holds on every path: a request from
a group, a film asked for by name whose entry was added by Jellyfin link, the
library's copy of a film under another year, a panel Re-run or the hourly
check's requeue, **Queue link**, a TV season or episode, and the panel's
manual queue. History and the log say *sent: on the bypass list (rating
override for "The Last Samurai" (2003) by mommy)*; a TV row says *3 sent: on
the bypass list (…): E14, E19, E26*.

- **A title** covers the film or show whose name, with case, spaces and
  punctuation ignored, *is* it - that exact title and nothing longer: *Heat*
  covers *Heat*, not *Heat and Dust* and not *Heathers*; *KILL-ME three
  times* covers *Kill Me Three Times*. The owner's entry of 28 September
  2026, *full metal alchemist*, covers *Fullmetal Alchemist* (2003) and not
  *Fullmetal Alchemist: Brotherhood* (2009); Brotherhood is covered by an
  entry typed with its full name, as the live list's *Fullmetal Alchemist:
  Brotherhood season 1* is. A library name with its year in brackets,
  *Fruits Basket (2019)*, is that title from that year, so *Fruits Basket*
  covers it. A year narrows an entry to that year (*Kitchen Nightmares
  2007*). A name can end in a number that reads as a year (*Blade Runner
  2049*, *Space: 1999*, *Class of 1984*), so an entry with a year also covers
  the name with that number, from any year: typed as the library names it,
  it covers its item. *season 1* or *S01E14* on the end narrows it to that
  season or episode of a show, and then it covers no film. No part of a
  name covers it: *Brotherhood* does not cover *Fullmetal Alchemist:
  Brotherhood*, and *Thing* does not cover *The Thing*. A name in any script
  is matched: *שטיסל*, *Шерлок*.
- **A link** covers exactly its film, series, season or episode. A series
  link also covers the show's other library entry when the show is split over
  two folders. A film its rating blocks, asked for by name, is not refused
  until the library has named its copy, so an entry added by link covers it.

**Matching is exact, because that is what it sends.** Until 29 September
2026 a title also covered every name that started with it, word for word:
*Heat* covered *Heat and Dust*, and every TV-MA episode of a show of that
name. That only put more titles to the AI check while an entry did that;
once an entry meant *Send it, no AI check* it sent them unchecked. Asked
whether *Heat* should also send *Heat and Dust*, the operator chose "Exact
title only". Beside each entry the panel shows what it matches in the
library right now (*Matches now: 📺 Fullmetal Alchemist (2003)*, or
*Matches nothing in the library right now*), and it says the same when an
entry is added - read it, since that is what the entry sends. An entry that
matches nothing is usually typed differently from the library's name: type
it as the library has it, or use a link. The panel never
refuses a title; only input with no letter or digit in it at all (*!!!*) is
refused. The line is read from Jellyfin's lists of shows and films, kept ten
minutes; films are not listed where the film library is not Jellyfin, and the
line then says *Matches no show in the library right now (films not listed:
…)* rather than that the entry matches nothing. An entry narrowed to a season
or an episode is kept apart (`rating-overrides-tv` in state.json), so a build
from before TV, after a rollback, cannot read *Fargo season 2* as the film
*Fargo*; so is a name such a build reads as something else - it keeps a-z and
0-9 only, so *שטיסל* would be nothing to it, and nothing matches every other
name with no a-z in it. The rest stay under `rating-overrides`, where every
build reads the list.

**Titles not on the list: the AI check only helps.** A film or episode its
rating blocks, and no entry covers, is refused on its rating - unless *Also
send rated films and episodes with no nudity* is on, when it is asked about
and a sure "no nudity" sends it (*The safety policy*, above). "Nudity", an
unsure answer or no answer leaves it refused on its rating, in the words a
rated title always got; the History row says what the check made of it
(*rated R — the AI check did not clear it (Groq said nudity)*, or for TV *1 not
cleared by the AI check (Gemini said nudity), withheld on its rating: E19*).
A title its rating lets through is never asked about. Nor is a film request
whose answer the check cannot change: "which year?" (the server holds several
copies and none was named), a film already waiting (a duplicate) and a full
queue are all answered first, as the Test tab answers them. A film the check
cleared is put back after a restart or a retry without asking again. The
library's copy of a film, when it turns out to be another year's film of that
title, is judged on its own: on its own rating, and on an entry that covers
*it* - an entry for *Scarface 1932* never sends the 1983 film. Each TV episode is
asked about on its own, through the same providers as films. Answers are kept
per episode, so asking for a season again does not spend the providers' quota
again: a "no nudity" that sent an episode for six months, every other answer
a day. A message asks about at most 10 episodes, across all its seasons,
two seconds apart and in five minutes at most - half of Gemini's free day,
since films are asked about from the same allowance. It stops at the first
check that cannot run, for its later seasons too, and does not ask about
episodes the episode cap or a full queue would cut anyway; what it did not
get to stays withheld on its rating, and asking again later picks up where
it stopped. Nor does it ask about an episode an earlier request already has
in the queue: that one is not queued twice (*TV asked for twice*, above),
counts as *already waiting*, and was checked for the request that holds it.
Every other episode is judged waiting or not on what is in the queue once
the checks are done, so one whose earlier request was cancelled while they
ran is queued, not left with nobody to post it. A retry or a restart puts
back what was queued, without asking again. History and the group name as
sent on the list, or cleared, only the episodes that went into the queue:
with the episode cap at 20, a listed E26 of a 64-episode season is not
named. A content-check confidence box left empty saves as 0; for a "no
nudity" that would send a rated title, a bar of 0 is read as the default
0.7, so an answer with no confidence never counts. What the requester is
told about any of it follows the `tv-rating-notice` flag above; with it Off,
the group sees what it always saw.

**The Test tab says what a request would do.** A dry run of a listed title
goes past its rating (*rated R — on the bypass list (…), so it is sent without
the AI check*) and on to the library, through the same code as a request
(`src/plugins/movie-requests/film-gate.js`), and ends *Would send — on the
bypass list - sent without the AI check*, with no AI call. One not listed ends
*Passes every check* when the check clears it, or *Blocked: rated R — the AI
check did not clear it (…)*. **Check a Jellyfin link** answers *send* for a
listed item, and in amber (*check*) for one its rating blocks that the AI
check could clear. It judges an episode, season or series on the TV ratings
and on the series' rating, as a TV request does, and an unrated film as
`blockUnrated` says. Until 29 September 2026 both refused a listed title on
its rating alone, so the list looked ignored.

**Queue link** on the Dashboard takes films only. It judges what it queues on
the film rules and posts it as a film, so a pasted series, season or episode
is refused with *This is a TV episode. Queue link only takes films*; ask for
it by name in the TV group, or type it into the queue box (*Show season 1*),
and the TV rules decide. The link check says so for every TV item. An item
with no rating in Jellyfin counts as blocked there whatever `blockUnrated`
says, unless it is on the list or the AI check clears it. When Jellyfin will
not give up an episode's series (an error, or a series the bot's account
cannot see), the link check does not guess: it says it cannot judge the
episode, and logs why (`grep 'link check: could not read the series'`).

A request looks the library's file up again when it does not look like the
film asked for (another year, or the title worded differently), and judges the
file's own rating. A listed film is sent from there too, so *The Last Samurai*
held in Jellyfin as 2006 is sent rather than refused *rated R (library file)*;
a film no entry covers is still refused unless the AI check clears it, and so
is a file that turns out to be a different film (*wrong film*), listed or not.
A file under another title than the one asked for is looked up again whenever
an entry covers the film asked for and not the file, however alike the two
names look: the server holding *Saw II* and not *Saw*, a request for *Saw* on
the entry *Saw 2004* finds *Saw II*, which is judged as itself - put to the AI
check, or refused on its rating - and never sent on the entry for *Saw*.
The dry run shows this as its *library file* step.

---

## Shabbos and yom tov lockdown

With **Groups → Group lockdown 🔒 → Enable automatic lockdown** on, the bot
makes every group admins-only at candle-lighting and opens them again at
havdalah, skipping the groups ticked as *Always-locked*. Yom tov runs into
Shabbos without a havdalah in between, so a run of days is one lock.

It is on by default since 2026-10-12, the operator's setting. Because
havdalah opens every group that is not always-locked, on a new install the
schedule locks nothing until somebody has looked at that list - otherwise it
would open the posts group to every member on the first Motzei Shabbos. It
says so once a window in the log (*not locking the groups for this window*)
and on the card, and starts with the first Shabbos after **Sync from
WhatsApp** (or a tick) has named a group to keep shut, or after the card is
saved as it is, which says none of the groups is admins-only for good
(`lockdown.alwaysLockedReviewed`; `scheduleHeld` in `src/core/lockdown.js`).
An install that switched the lockdown on itself before it was the default
is not held: its `config.json` counts as looked at when it is loaded
(`keepSavedChoices` in `src/config/store.js`), and it locks and opens every
group as it always did, always-locked list or none. Lock and unlock by hand
are not held.

**Each end is measured in its own city.** As set on 22 September 2026:

| End | City | Time | Calendar |
|---|---|---|---|
| Lock (candle-lighting) | New York | 18 min before New York sunset | diaspora, two days of yom tov |
| Unlock (havdalah) | Jerusalem | 20 min after Jerusalem sunset | Israeli: one day of yom tov, but two of Rosh Hashana |

This is the operator's decision, made after being shown the times it
produces, and it has consequences that are intended, not bugs:

- **The groups reopen on Saturday late morning in New York** — about 10:00 in
  midwinter, 11:30–12:00 around the autumn holidays, and just after 13:00 in
  midsummer, with Shabbos in New York still running for roughly seven more
  hours. The New York time jumps by an hour when the US changes its clocks:
  from 11:11 on 31 October 2026 to 10:05 on 7 November, and from
  11:05 on 13 March 2027 to 12:10 on 20 March. In the weeks when only
  one country has changed (31 October 2026, 20 March 2027), nothing unusual
  happens to the New York time; only the gap between the two cities changes,
  to six hours instead of seven.
- **New York's second day of yom tov is open.** The unlock follows Jerusalem's
  single day, so Shabbos + Sukkos 2026 locks Fri 25 Sep 18:30 and opens Sat
  26 Sep 11:51 New York time (18:51 in Jerusalem); Sunday, Sukkos II in
  New York, is open. Pesach 2027 is two locks (Wed evening → Thu midday, and
  Fri evening → Sat midday) where New York alone would be one four-day block,
  and Shavuos 2027 is one (Thu evening → Sat midday). Rosh Hashana is the
  exception: it is two days in Jerusalem too.
- **Every lock opens in the middle of the day in New York, not only
  Shabbos.** Yom Kippur 5788 opens Mon 11 Oct 2027 at 11:32 New York, with
  New York's fast running until 18:42; Rosh Hashana 5788 opens on its second
  day, Sun 3 Oct 2027, at 11:42; and a first day of yom tov opens at
  midday too (Pesach I, Thu 22 Apr 2027, 12:33), leaving the rest of it
  and New York's second day open.
- **Pesach 2027 is the sharpest case.** The groups are open from Thu 22 Apr
  12:33 to Fri 23 Apr 19:25 New York — the rest of New York's first day
  and all of its second — and from 11:55 that Friday Jerusalem's Shabbos
  has begun as well. That afternoon is the only time in the year when both
  cities are in Shabbos or yom tov and the groups are open. Friday then locks
  at New York candle-lighting, as every Friday does, until Jerusalem's
  havdalah on Saturday.

The card's hint shows the next lock and unlock in New York and Jerusalem time,
and notes when the groups would reopen while it is still Shabbos or yom tov in
New York. While that is actually happening — Saturday midday to New York's
havdalah — the hint says so on its own line ("The groups reopened … while it
is still Shabbos there, until …"), above next week's times. The *Coming up*
list shows the next few.

This window was used once before, and replaced on 10 September 2026 (commit
a1255f2) with New York at both ends, as "the intersection, not the union" of
the two communities. That description is still accurate. The operator chose
the intersection anyway on 22 September; **do not change it back without
asking him.**

**To change it:** pick the cities under *Candle-lighting (lock) in* and
*Havdalah (unlock) in* and press **Save lockdown settings**. The hint shows the
times for the choice on screen before you save it ("If saved: …"). No restart
is needed — the schedule reads the setting every minute. The combinations:

| Candle-lighting | Havdalah | Window |
|---|---|---|
| New York | Jerusalem | the default above: Friday evening to Saturday late morning, New York time |
| New York | New York | all of Shabbos and both days of yom tov in New York (the pre-22-September behaviour) |
| Jerusalem | New York | the union: Friday late morning to Saturday night, New York time, all days of yom tov |
| Jerusalem | Jerusalem | Shabbos and yom tov as kept in Jerusalem |

The minutes are the ones on the card in either city. hebcal's own Jerusalem
candle-lighting is 40 minutes before sunset, and it quietly switches to that
when it is given 18; the bot does not, so "18" means 18 in Jerusalem too. They
must be whole numbers, 0–120 for candle-lighting and 1–120 for havdalah; an
empty box or anything else is refused on Save, and in the preview, with the
reason. (A havdalah of 0 is not "at sunset" to hebcal — it means no havdalah at
all, and nothing would ever lock.)

If the unlock city has no havdalah within 84 hours of a lock — which should
never happen — that block unlocks at the lock city's own havdalah instead, the
log says `lockdown block …: … unlocking at New York's own havdalah instead`,
and the hint shows the reason.

Manual lock and unlock override the schedule for the window they are pressed
in, and only that one. An unlock pressed while a window is running keeps the
groups open for the rest of that window. An unlock pressed between windows —
say after locking by hand for the rest of New York's Shabbos, then unlocking
after its havdalah — touches no window at all: next Friday still locks. (Until
22 September 2026 that second case silently cancelled the next lock.) A manual
lock between windows stays until someone unlocks it; the schedule only undoes
its own locks.

---

## Upgrading

Every box updates itself. `whatsapp-bot.service` runs
[`deploy/auto-update.sh`](../deploy/auto-update.sh) before every start — a
boot, a crash restart, a `systemctl restart` — and it fast-forwards the checkout
to `origin/main` before node is launched. So **a push to `main` reaches every
box the next time it starts**, with nobody logged in to pull. Nothing restarts
the bot to apply an update: it waits for the next start, because every start is
another WhatsApp login (see [the ban-risk report](whatsapp-ban-risk.md)).

To take an update now, restart once, the usual way:

```bash
echo '{"op":"queue-status"}' > data/bot-cmd.json && sleep 5 && cat data/bot-cmd.result.json
sudo systemctl restart whatsapp-bot
journalctl -u whatsapp-bot -b | grep auto-update     # what it did
cat data/auto-update.json                            # the same, for the last start
```

What it does, in order, and what makes it stop and start the old code instead:

1. **Takes a commit back out if it crash-loops.** After an update, if systemd
   has to restart the bot 3 times within 10 minutes of a start, it goes back to
   the last commit that ran — with that commit's `node_modules` — and will not
   take the bad one again until something newer is pushed. Without this, a
   commit that dies after connecting would reconnect every ~10 seconds, on every
   box that happened to restart. `systemctl restart` by a person does not count;
   only restarts systemd makes by itself (its `NRestarts`).
2. **Leaves deliberate state alone.** Local edits to tracked files, local
   commits, a detached HEAD, a branch with no upstream, a merge in progress: it
   says so in the journal and skips. It never stashes, resets over, cleans or
   checks anything out. The catalogue copy the panel writes into `library/` is
   the exception — it is the app's output, not somebody's edit — so it does not
   block updates, and when a pushed commit changes it too, the pushed copy wins
   and this box's copy is kept in `data/auto-update-replaced/`.
3. **Fetches only `main`**, with gh's login even where `gh auth setup-git` was
   never run, retrying four times over about a minute (at boot the network can
   lag behind `network-online.target`), then gives up and starts what is here.
4. **Installs new dependencies before switching**, when `package.json` or
   `package-lock.json` changed: `npm ci` into `.auto-update-staging/`, swapped
   in only when it succeeds, so a failure leaves the old code *and* the old
   `node_modules`. A box with the dev dependencies keeps them.
5. **Fast-forwards**, then **parses every changed `.js`** with `node --check`,
   and goes back if one does not parse — a syntax error on `main` would
   otherwise take every box down at once.

It always exits 0, and the unit runs it as `ExecStartPre=-…`, so no failure of
the update — or of the script itself — stops the bot starting.

**Turning it off on one box**: `AUTO_UPDATE=0` in `.env`. The crash-loop
rollback still runs, since a bad commit already in place is still a bad commit.
Pinning a box to one commit also works: `git checkout --detach <commit>`.

**Where a box stands**: `data/auto-update.json` holds the last outcome —
`updated`, `up-to-date`, `skipped`, `failed` or `rolled-back`, with the reason,
the commit it is on, and any commit on trial or rejected. Nothing else in
`data/` is touched, and `data/` and `.env` are gitignored.

**A box that fell behind**, because it had local edits or its unit predates
auto-update, is brought up to date by hand the same way as before:

```bash
cd ~/whatsapp-bot
echo '{"op":"queue-status"}' > data/bot-cmd.json && sleep 5 && cat data/bot-cmd.result.json
git status                     # local edits? commit them to a branch first
git pull --ff-only
npm ci --omit=dev              # only if package-lock.json changed
sudo systemctl restart whatsapp-bot
```

`npm test` on a production box will not go fully green, and that is expected
rather than a regression: `content-export` and `rules-freshness` fail only if
the files they read under `data/` are absent, and the twelve suites that stub
a DOM with `linkedom` (CLAUDE.md, "Running it", lists them) always fail after
`npm install --omit=dev`, because `linkedom` is a devDependency. Run
`npm install --include=dev` first if you want the whole suite; a box built by
`tools/bootstrap.sh` has them already, and `deploy/auto-update.sh` keeps them.

### When the unit itself changes

An update never changes the *installed* unit: `/etc/systemd/system/whatsapp-bot.service`
is a rendered copy, and the service cannot write there. When a pulled commit
changes `whatsapp-bot.service`, the journal says so, and the unit has to be
re-rendered by hand:

```bash
deploy/install-units.sh whatsapp-bot       # re-renders it for this machine, and reloads systemd
sudo systemctl restart whatsapp-bot        # at a quiet moment
```

(Not `render-whatsapp-bot-unit.sh ... | sudo tee` the unit file: when the
renderer fails, tee still empties the file, and systemd reads an empty unit
as masked - how bot-box2's ended up on 2026-09-29.)

That is also the one-time step for a box installed **before** auto-update
existed: its unit has no `ExecStartPre=` line, so it never updates itself until
it is re-rendered. Check with:

```bash
systemctl cat whatsapp-bot | grep -q auto-update.sh && echo "updates itself" || echo "re-render the unit"
```

Local tuning a box needs — a memory cap on a small VM, say — belongs in a
drop-in (`sudo systemctl edit whatsapp-bot`), not in the rendered file, so a
re-render never loses it.

---

## Backups

### The sealed backup (what a new machine restores from)

Everything this machine has that is not in git - settings, logins, keys, the
linked WhatsApp session, and the machine-level bits of `~` - goes to the
repository's `sealed-backup` branch every night, encrypted. Set it up once, on
the machine that is running the bot:

```bash
cd ~/whatsapp-bot && node tools/backup-secrets.mjs --set-passphrase --install-cron
```

That asks for a passphrase twice (hidden, 12 characters or more), keeps it in
`.env` beside `MASTER_KEY`, installs one crontab line (05:17 UTC, about 01:17
in New York), and makes the first backup straight away, so a mistake shows up
now rather than at five in the morning. **Keep the passphrase in your password
manager too**: it is the only thing that opens the backup, and a new machine
cannot be restored without it.

| Bundle | From | What |
|---|---|---|
| `app.tar.gz.enc` | `~/whatsapp-bot` | `.env` (with the Cloudflare tunnel's token, `CLOUDFLARE_TUNNEL_TOKEN`, where the box runs one), `data/config.json`, `data/session/`, `data/sessions/`, `data/state.json`, `data/outbound-budget.json`, `data/backups/`, `data/yt-dlp-cookies.txt` (the YouTube cookies yt-dlp signs in with, restored 0600), `certs/*.crt`/`*.pem` |
| `home.tar.gz.enc` | `~` | `.claude/settings.json`, `.claude/CLAUDE.md`, `.claude/keybindings.json`, `.claude/agents/`, `.claude/commands/`, `.claude/skills/`, `.claude/projects/*/memory/`, `.gitconfig`, `.ssh/` |

Never in it, even when present: the gh token (`~/.config/gh/hosts.yml`),
`~/.claude.json`, Claude Code transcripts and caches, Tailscale node state,
`data/sessions.json`, logs, media. `npm test` checks that.

How it behaves, and why:

- **Nothing secret is in git in the clear.** Both bundles are AES-256-GCM
  under a key derived (scrypt) from the passphrase. The only plaintext on the
  branch is `manifest.json` - when, which host, which paths, a digest - and a
  README. Git history is permanent; a secret committed once is in every clone
  forever.
- **The branch is always exactly one commit.** A night with changes makes a
  fresh parentless commit and force-pushes it; a night without changes does
  nothing. The push can only ever name `refs/heads/sealed-backup`, and its
  lease is pinned to what was fetched at the start, so a push that lands in
  between is never overwritten.
- **The top of the branch is the current backup; `archive/` keeps the rest.**
  The four files at the top (`manifest.json`, `README.md`, `app.tar.gz.enc`,
  `home.tar.gz.enc`) are the backup of the box that runs the bot, and are
  what bootstrap and `--from-branch` restore. When another box takes the
  branch over, the backup that was at the top is moved, byte for byte, to
  `archive/<host>-<machine>/` - one folder per machine, replaced by that
  machine's newer copy if it is ever archived again, and removed when that
  machine's backup of the same bot is back at the top (a folder holding a
  different bot stays). So nothing piles up night after night, and nothing is
  lost at a hand-over. Archived folders are carried from commit to commit
  untouched and never opened: one may be sealed under the old machine's own
  passphrase.
- **A run that cannot see the whole branch changes nothing.** Every read of
  it fails the run when git cannot answer - a missing object, a git killed by
  the timeout - instead of counting what it could not read as absent, and the
  tree about to be committed is read back and checked: `archive/` exactly as
  it was, or, on a take-over, every folder kept and the old top in its folder
  as the very same files. The review of the archive (2026-09-29) found one
  failed read enough to push the top without `archive/`, or to archive the old
  top as an empty folder while the log said "unchanged".
- **It is made in `data/sealed-backup/`**, a repository of its own, never in the
  live checkout.
- **Each copy is opened and listed before it is committed.** A backup that has
  never been opened is a hope, not a backup. A `*.json` file caught mid-write
  (the session files are rewritten in place) is re-read, and if it will not
  parse the run fails naming it rather than sealing a torn copy.
- **The box that runs the bot owns the top of the branch.** Each backup
  records which machine wrote it and, as a one-way hash of `MASTER_KEY`, which
  bot. (That hash is the one plaintext value derived from a secret. The bot
  mints `MASTER_KEY` as 32 random bytes, which no hash gives away; one typed
  by hand at first start should be as strong as the passphrase.) A box
  takes the top over from another machine - moving that one's backup to
  `archive/` - by itself only when all of this holds: a
  `node src/index.js` from its checkout is running, `whatsapp-bot.service` is
  active **and** enabled at boot, the service runs that checkout, and the
  backup at the top is the same bot's (same `MASTER_KEY`, which a hand-over
  carries across). A backup written before backups named their bot counts
  once it is 36 hours old, which a machine still backing up a live bot never
  lets it get. Anything else is refused, and nothing on the branch changes:
  a standby or a retired box whose cron line is still there (it must never
  displace the live bot's backup, and it does not refresh a folder of its own
  in `archive/` either - every box's line fires at 05:17, so its push would
  race the live box's), and a second bot on its own number (different
  `MASTER_KEY`), whose box is built with `tools/bootstrap.sh --new-number`
  and skips this routine. The same goes for this machine's own backup when
  it is of a different bot (another checkout on the box, or a reinstall that
  minted a new `MASTER_KEY`), and for a top whose `manifest.json` is missing
  or unreadable, which nobody can say is whose.
  `node tools/backup-secrets.mjs --take-over` does it by hand, archiving just
  the same, for the cases the box cannot tell;
  bootstrap runs it on a box where it restored the app bundle from the branch
  and you then started the bot.
- **It records whether the bot was running.** A backup taken while the bot
  runs is a snapshot of a moving target, so the manifest says which it was,
  and bootstrap asks before restoring one that was taken with the bot up.

What the last run did - including what it archived, or why it was refused -
is in `data/sealed-backup-status.json`, and `node tools/routines.mjs` reports
it, with the archived machines.

Day to day:

```bash
node tools/backup-secrets.mjs                   # back up now
node tools/backup-secrets.mjs --set-passphrase  # change the passphrase; the next backup is resealed (see below)
cat data/sealed-backup-status.json              # how the last run went, cron or not, failures included
tail data/logs/backup-secrets.log               # the nightly job's output
crontab -l | grep sealed-backup                 # the line itself
node tools/backup-secrets.mjs --remove-cron     # on a machine being retired
```

**Changing the passphrase does not revoke the old one.** The branch is kept
at one commit, but a force-pushed commit stays on GitHub, fetchable by its sha,
until GitHub support purges it, and every clone that fetched it keeps it for
90 days. The older copies still open with the old passphrase. So if the
passphrase, or a copy of the backup, has leaked, a new passphrase is not the
fix: rotate what is inside - `MASTER_KEY` (then re-enter the secrets), the API
keys, the admin passwords - and re-link the number.

Restoring is [server-setup.md → Fast path](server-setup.md#fast-path-rebuild-from-the-sealed-backup):
`tools/bootstrap.sh` on the new box does the machine setup and the restore,
asking for the passphrase once. Just the files, without the machine setup:
`node tools/restore-secrets.mjs --from-branch` (it refuses to overwrite a
checkout that already has `.env` or `data/`).

An archived backup restores the same way, from its folder. It is what that
machine had when another took the branch over, so restore one only to bring
that machine's bot back:

```bash
node tools/restore-secrets.mjs --list-archive                    # the current backup and every archived one; opens nothing
node tools/restore-secrets.mjs --from-archive bot-box4-00000000   # that one (--only home for just ~)
```

It opens with the passphrase of the machine that wrote it, which may not be
this one's.

### By hand

Worth having off the machine, in this order of importance:

| | Why |
|---|---|
| `.env` | without it, `config.json` is unreadable — permanently |
| `data/config.json` | every setting, all the API keys |
| `data/session/`, `data/sessions/` | avoids re-linking the number from the phone |
| `data/state.json` | request history, wanted list, portal audit log |
| `data/outbound-budget.json` | the rolling WhatsApp volume counter |

```bash
cd ~/whatsapp-bot
tar czf ~/bot-backup-$(date +%F).tgz .env data/config.json data/state.json \
        data/session data/sessions data/outbound-budget.json 2>/dev/null
```

Treat the archive as a credential: it contains a live WhatsApp session and the
key to every stored secret.

`data/logs/` and `data/media/` are not worth backing up.
