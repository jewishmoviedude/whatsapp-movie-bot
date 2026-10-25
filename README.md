# WhatsApp Bot Platform

> **About this copy.** This is a cleaned copy of a bot that runs for real
> groups. Phone numbers, group IDs, invite links, people's names, host names
> and private links have been replaced with placeholders:
> - numbers use the 555 area code, which no real phone has;
> - group IDs look like `120363900000000001@g.us`;
> - invite links look like `chat.whatsapp.com/ExampleInvite01…`;
> - the head admin is called "Head Admin".
>
> Comments still tell the stories of real incidents, with the people's names
> changed. Nothing here points at a live group, so set up your own from the
> web panel (see "Setup" below):
> - your groups;
> - your Jellyfin server and its key;
> - your AI keys;
> - your group descriptions (in `content/`; the files here are examples).
>
> The Shabbos/yom tov lockdown defaults to New York candle-lighting and
> Jerusalem havdalah; both cities are settings on the Groups tab.


A pluggable WhatsApp bot for Ubuntu with a web control panel. Ships with a
movie-request plugin, but the bot core is generic — anything else you want it
to do is a folder in `src/plugins/`.

---

## Read this first

**WhatsApp's Terms of Service prohibit automated use of a personal account.**
This connects as a linked device using the same multi-device protocol
WhatsApp Web uses. Accounts used this way do get banned, and a ban usually
takes the phone number with it permanently.

Mitigations that actually help:

- Use a spare number you can afford to lose, not your main one.
- Keep the pacing delays on (Settings → WhatsApp account).
- Do not add the bot to groups you do not own.
- Keep volume low and human-shaped.

If this becomes something you rely on, move to the **WhatsApp Business Cloud
API**, which is the sanctioned route. The plugin interface here is
transport-agnostic enough that swapping the connection layer is a contained
change.

---

## The other documents

| | |
|---|---|
| **[docs/server-setup.md](docs/server-setup.md)** | Building a new Ubuntu server from nothing. A new VM is [one paste](docs/server-setup.md#one-paste-a-new-vm-in-one-go) over SSH: `gh`, the clone, the packages, the systemd unit, Claude Code, Tailscale and the restore of every setting, with only the logins needing you. Read this when the bot needs to move or be rebuilt. |
| **[docs/operations.md](docs/operations.md)** | Starting, stopping, activating and deactivating on a given machine; handing the bot from one box to another; running two boxes at once. |
| **[docs/whatsapp-ban-risk.md](docs/whatsapp-ban-risk.md)** | Every behaviour that could get the number banned, with counts from real logs. |
| **[CLAUDE.md](CLAUDE.md)** | Orientation for a Claude Code session opening this repo. It starts with the routines every box runs: `node tools/routines.mjs` checks them all (the unit and its updater, the hourly check, the nightly backup, sudo, gh, Tailscale...), and `--fix` turns on what is missing. |

---

## Install

**A new VM: paste the one block in
[docs/server-setup.md, "One paste: a new VM in one go"](docs/server-setup.md#one-paste-a-new-vm-in-one-go)**
into an SSH session. It installs `gh`, clones this repository to
`~/whatsapp-bot` and runs `tools/bootstrap.sh`, which does everything below
and restores the settings, the WhatsApp link and the keys from the sealed
backup. Only the GitHub, Claude and Tailscale logins need you.

By hand, on a box that already has the clone:

```bash
cd ~/whatsapp-bot
./install.sh
```

This installs ffmpeg and Node 20, then `npm install`. Run it as your normal
user — it calls `sudo` where it needs to.

Then start it:

```bash
npm start
```

Or as a service that survives reboots. `deploy/install-units.sh` renders the
unit for this machine (your user, this directory, the node on your `PATH` -
the checked-in `whatsapp-bot.service` names `/usr/local/bin/node`, which a
NodeSource install does not have, so copied as it is it fails with 203/EXEC)
and installs it without starting it:

```bash
deploy/install-units.sh whatsapp-bot
```

Then enable and start it **only once no other machine runs this WhatsApp
number**: two machines on one session is `connectionReplaced`, the fastest
way to lose the number (CLAUDE.md, rule 3).

```bash
sudo systemctl enable --now whatsapp-bot
journalctl -u whatsapp-bot -f
```

Installed as a service, it **updates itself**: before every start the unit runs
`deploy/auto-update.sh`, which fast-forwards the checkout to `origin/main` using
the `gh auth login` the box was set up with. A push to `main` therefore reaches
every box the next time it starts. See [docs/operations.md](docs/operations.md#upgrading)
for what it refuses to do, the crash-loop rollback, and `AUTO_UPDATE=0`.

Open the panel from any device on the network: `http://<server-ip>:8080`

First load asks you to set an admin password.

---

## Not getting the number banned

A WhatsApp account running a bot is judged on how it behaves, not on what it is
for. **[docs/whatsapp-ban-risk.md](docs/whatsapp-ban-risk.md)** is the full
inventory: every behaviour that could look like abuse, what the code does about
each one, and what is still exposed — with the counts from real logs.

The short version, if you are changing anything that talks to WhatsApp:

- Never add a loop that calls WhatsApp without `_bulkPace()`. `npm test` fails
  if you do.
- Never shorten the reconnect ceiling to make recovery feel faster. A flat 60
  second retry produced 1,057 connection attempts in one day.
- If WhatsApp rate-limits something, back off. Retrying harder is what earns
  escalating penalties.

## Starting, stopping and rebooting

There are three levels, and picking the wrong one is how work gets thrown
away. A film mid-encode represents a multi-gigabyte download and twenty-odd
minutes of CPU that nothing recovers if the process dies underneath it.

### Ask before you restart

The bot will tell you whether it is safe. It reads the queues directly rather
than guessing, which matters: the media queue and the direct-links queue share
a log scope, so eyeballing the log has produced the wrong answer more than once.

```bash
echo '{"op":"queue-status"}' > ~/whatsapp-bot/data/bot-cmd.json && sleep 5 && cat ~/whatsapp-bot/data/bot-cmd.result.json
```

`"safeToRestart": true` means nothing is running or waiting. If it is false,
`running` names what is in flight.

### 1. Pause the queue — no restart at all

Dashboard → **Pause**. New jobs stop starting; anything mid-download or
mid-encode finishes. WhatsApp stays connected, so requests are still received
and queued, just not processed. This is usually what you want.

### 2. Disconnect WhatsApp — the portal keeps running

Dashboard → **Disconnect** / **Link / Connect**. Ends the WhatsApp connection
while the panel stays up. The saved session is *not* wiped, so reconnecting
needs no re-linking. Anything mid-upload dies with the socket.

Do not confuse this with **Unlink & wipe session**, which erases the session
and forces a full re-link from the phone.

### 3. Restart the process

With the service installed:

```bash
sudo systemctl restart whatsapp-bot
```

Without it, kill by pid rather than by pattern — `pkill -f 'node src/index.js'`
also matches the shell you are typing it in, which kills the restart along with
the bot:

```bash
kill $(pgrep -x node | while read p; do tr '\0' ' ' < /proc/$p/cmdline | grep -q 'src/index.js' && echo $p; done)
```

and start it again:

```bash
cd ~/whatsapp-bot && setsid nohup node src/index.js > /tmp/bot.log 2>&1 < /dev/null &
```

### Rebooting the machine

With the service enabled, the bot comes back on its own. **Without it, it does
not** — there is nothing to start it, and it will sit down until someone runs
the command by hand. That is the single best reason to install the unit.

Interrupted jobs are journalled and re-queued on the next start, so a reboot
costs the work in progress but never loses the request itself.

### If it comes back up disconnected

Check which number it is set to use. The panel shows *"will link as …"* when
disconnected. A number that was logged out on the phone needs re-linking from
the phone; the bot cannot fix that itself, and it will not keep retrying a
wiped session.

---

## Outbound network

The TLS-intercepting filter that used to sit in front of this box has been
bypassed. Verified genuine certificates on every endpoint the bot needs:

| Host | Issuer | Status |
|---|---|---|
| `registry.npmjs.org` | Google Trust Services | ok |
| `www.omdbapi.com` | Let's Encrypt | ok |
| `api.themoviedb.org` | Amazon | ok |
| `web.whatsapp.com` | DigiCert | ok |

If filtering is ever re-enabled you will see `unable to get local issuer
certificate` in the logs. The fix is to drop the filter's root CA into
`certs/` and restart — `start.sh` bundles anything in there and sets
`NODE_EXTRA_CA_CERTS` before Node boots (it has to happen there; Node reads
that variable once at startup). See `certs/README.txt`.

Dashboard → **Outbound connectivity** → *Run check* tests all three live.

---

## Linking your number

Settings → WhatsApp account → enter the number in full international form,
`+15551234567` (the bot keeps its digits, and shows every number this way),
then Dashboard → **Link / Connect**.

**Pairing code** (default): the panel shows an 8-character code. On the
phone: WhatsApp → Settings → Linked devices → Link a device → *Link with
phone number instead* → type the code. No QR scanning, which is what you
wanted for a headless server.

**QR**: the panel renders a QR to scan instead. Either works; pairing is
easier when the phone isn't next to the screen.

Have the phone open on WhatsApp → Settings → Linked devices → Link a device
*before* pressing Link / Connect. A code is only live for a couple of minutes;
when one expires the bot offers another by itself, and the panel says how long
that will be rather than sitting on a bare "Connecting…".
[docs/operations.md](docs/operations.md#when-the-qr-is-slow-to-appear-or-never-appears)
covers what to do when it still will not appear.

The session is saved in `data/session/`. It survives restarts — you only
link once. "Unlink & wipe session" clears it.

---

## How a request is handled

1. Someone posts a title in a **request group**.
2. OMDb resolves it to a real film, correcting the spelling.
3. **Rating gate** — if it is on the blocked list, react ⛔ and stop. This is
   the only real policy block.
4. **Library lookup** — search Jellyfin/Plex for the corrected title.
   - **Found** → react ⏳ and queue it. Release status is irrelevant at this
     point: if the file is there, it gets sent.
   - **Found several times over** (a remake: Venom 1981/2005/2011/2018, or a
     series: Harry Potter) and no year given → the requester gets a numbered
     "Which one?" list as a reply in the request group, in every group, and
     answers with its number. It is decided from the library alone, before
     step 2, so it costs no OMDb lookup — see
     [docs/operations.md](docs/operations.md#the-which-one-list). Only where
     no list could be shown (the library search failed, or no copy can be
     sent) → 📅, and the notification lists the years we could send with a
     line to copy.
   - **Not found** → work out *why*, and react accordingly:
     - still in cinemas → 🎪 (ask again later)
     - it is a TV series sitting in the library → say so, and point at the TV group
     - otherwise → 📭 (we simply do not have it), **and record it** — see below
5. One at a time: fetch → convert to mp4 → send to the **posts group** as a
   document → react ✅ → delete the working files.

The library is checked before the release window deliberately. Whether a film
is still in cinemas is not a policy question — it is just the usual reason a
title has not reached the server yet. So the theatrical check never blocks
anything; it only picks the right reaction for something that is missing.
That also means it costs nothing on the common path, since it only runs on a
miss.

Steps 2–4 run immediately so the reaction lands right away. Only the heavy
part is queued.

### What the reactions mean

The legend members are given in the request groups. The bot's own copy,
from which it builds the group descriptions, is in `tools/legends.mjs`.

```text
Movies
🔍 Researching · 🎬 Added to the queue
1️⃣2️⃣3️⃣…🔟 Your place in line (updates live) · 🔢 11th or further back
⬇️ Downloading · ⚙️ Converting · ⬆️ Sending · ✅ Done

If we can't do it:
⛔ Rated R / NC-17 / X / TV-MA — not allowed
🎪 Only in theaters — not on the server yet
📬 Not in the library — tell us here: https://forms.gle/ExampleForm01
❓ Not a movie we could find — check the spelling. An unofficial film? Request it in group 07
📅 More than one movie has that name — add the year
☝️ More than one movie in one message — send each on its own
✍️ Not written properly — write the season and episode like *#request The Office S01E05* (a zero, not the letter O)
❌ An admin cancelled it — it isn't coming
⏭️ An admin set it aside (usually a huge file)
⚠️ Something went wrong (the bot usually retries)
⏸️ On hold — requests are paused for a moment; it runs by itself when they resume, no need to ask again

Shows
🔍 Researching · 🎬 Added to the queue · 🤥 Already asked for — it's coming, not added twice
1️⃣2️⃣3️⃣…🔟 Your place in line (updates live; a whole season is one place, and films go first, so it can go up) · 🔢 11th or further back
⬇️ Downloading · ⚙️ Converting · ⬆️ Sending (repeats for each episode of a season) · ✅ Done

If we can't do it:
⛔ Rated TV-MA / R / NC-17 / X — not allowed (in a season, only those episodes are left out)
📺 Which season? — say the season, e.g. *#request The Office S01*
📬 Not in the library, or the name didn't match — check the spelling. Admin will review and advise on discussions group (link below)
✍️ Not written properly — write the season and episode like *#request The Office S01E05* (a zero, not the letter O)
❌ An admin cancelled it — it isn't coming
⏭️ An admin set it aside (usually a huge file)
⚠️ Something went wrong and the bot gave up — ask again later
🚫 Too soon — one request per person per hour; send it again once the hour is up
⏸️ On hold — requests are paused for a moment; it runs by itself when they resume, no need to ask again
```

### "Not in the library" — and how to tell when that is wrong

📭 is the answer this bot gets wrong most often, and it used to be the one it
recorded least: a TV miss left no history row, no wanted entry and not one log
line, so "it says you don't have Kitchen Nightmares and you plainly do" could
not be investigated after the fact.

So every request that dies **at the library lookup and nowhere else** — it
passed the rating gate, it is not still in cinemas, the title was recognised,
nothing errored — is now written down. **Logs tab → Not in the library.**

Each row carries what was typed next to what it was understood as (when those
two disagree, the disagreement is usually the bug), who asked, which group, and
a note saying what the lookup actually did:

```
· "Kitchen Nightmares" is on the server but INVISIBLE to the bot's Jellyfin
  user (U1). Give that account access to the TV library, and check its Max
  Parental Rating.
```

A title that later turns up is kept and marked *turned up later*, rather than
deleted — that row is the evidence that the bot was wrong at the time. The list
also goes out in the daily email, kept separate from the wanted list: that one
is a shopping list, this one is a fault log.

The shopping list is checked against the library too, so it does not go stale:
three minutes after start, every six hours, and when an admin asks (`POST
/api/wanted/recheck`, the Wanted card's Refresh), every open film on it is
looked up as a request would look it up, by its IMDb id as well as its title,
and the ones on the server are marked resolved by the bot, each logged as
`X2: X-Men United (2003) is on the server now (as "X2") - marked resolved on
the wanted list` and its row here marked *turned up later*. An entry that asked
for a season of a show ("2 broke girls season 2") is not a film and comes off
the list; such a request is no longer put on it at all.

On the Wanted card, an admin marks a film **resolved** once it is dealt with,
so the other admins know: it moves to a collapsed *Resolved* section under the
list, newest first, with who resolved it and when, and stays there 30 days
(Reopen puts it back). Reopening a film the bot resolved tells the bot the
copy it found is not the film: the recheck never resolves it with that copy
again, only with another one, and a note on the entry says so. A copy a
request's file check found to be another film is ruled out the same way.
Each entry also has a notes box: a note shows who wrote
it and when, its author can delete it (the super-admin any), and the hourly
check reads every new one on the hour as an instruction about that film and
answers it in its report. A resolved film somebody asks for again, still not
on the server, opens again by itself, with a note saying so. Every open
panel sees a change as it is made. The daily summary lists only the open
films, and says how many were resolved since the last one; the card's CSV
carries the resolutions and the notes.

When you want a definitive answer about one title, ask the live server the same
questions the bot asks, on the machine the bot runs on:

```bash
node tools/diagnose-library.mjs "Kitchen Nightmares"
node tools/diagnose-library.mjs --movie "Dune"
```

It runs all four lookup layers side by side, prints what each one returns and
how the fuzzy matcher scores the closest titles, shows the library access of the
Jellyfin account the bot searches as, and ends with a verdict naming the cause.
It sends nothing to WhatsApp, changes nothing, and never prints the token.

The usual causes, in order:

| | |
|---|---|
| The bot's Jellyfin account cannot see that library | it searches as itself, not as you. Fix it in Jellyfin → Users → Access |
| The show is stored under another name | "Ramsay's Kitchen Nightmares", or an `OriginalTitle` in another language |
| Jellyfin's own search cannot connect the two | `/Items?searchTerm=` is a plain filter and is *not* what the Jellyfin web UI uses. The bot now falls back to `/Search/Hints` and then to matching the whole series list locally |
| Two shows share a name | the 2004 UK *Kitchen Nightmares* and the 2007 US one. Add the year |
| It really is not there | then it is on the list for you to add |

### The 2 GB problem

WhatsApp rejects documents over 2 GB. Most movie files are much bigger, so
the bot re-encodes anything oversized down to fit — deliberately trading
quality for deliverability.

Target bitrate is derived from the runtime:

```
video_bps = (1.8GiB × 8 × 0.93 − audio_bits) / duration_seconds
```

A 2-hour film lands around 1.75 GB; a 3-hour film gets a lower bitrate to hit
the same ceiling. Output is capped at 480p by default: the *Fast* encode
profile (`ultrafast`), the operator's setting and the default since
2026-10-12; *Balanced* and *Best* cap it at 720p. The result is
re-measured after encoding, and the job fails loudly rather than sending
something WhatsApp will reject.

It skips the work when it can:

| Situation | What happens | Speed |
|---|---|---|
| Already mp4/h264/aac and under the cap | used as-is | instant |
| mkv, compatible codecs, under the cap | stream-copy repack | seconds |
| Over the cap, or odd codecs | full re-encode | 20–40 min |

On this box (10-core i9, 909 MB RAM) a re-encode is CPU-bound and runs at
roughly 3–6× realtime at `veryfast` (*Balanced*); *Fast* takes about half
the time. That is the real reason for one-job-at-a-time.

Measured against the live Jellyfin server (`jf.example-media.org`):

| Stage | Time |
|---|---|
| Library search | ~0.8 s |
| Download, sustained 11 MB/s (88 Mbit/s) | ~2 min per 1.5 GB |
| Convert, when the file is already a compatible mp4 under the cap | instant (hardlink) |

Most of that library is already 1.5–1.7 GB mp4, which is under the cap — so
the common case skips re-encoding entirely and the download dominates.

**If your Jellyfin storage is also mounted on this server**, the bot reads
the file straight off the mount and skips the download entirely — turning a
10 GB transfer into a no-op. It detects this automatically.

### Cleanup

`deleteAfterSend` (on by default) removes working files the moment the
upload finishes; off, a sent film's files stay in the work directory until
the hourly sweep clears them six hours later. Either way there is a hard
guard in `isSafeToDelete()`: it only ever deletes inside the work directory,
and never anything under a configured library root. This matters because
when reading directly off a mount, the "local copy" and your library original
can be the same inode.

---

## Configuration

Everything is in the web UI. Behind it, `data/config.json` holds the
settings, with API keys and the password hash encrypted at rest using
`MASTER_KEY` from `.env`.

**Save settings saves what you changed on the page, and nothing else.** It
used to send every box on the Settings tab, and on 2026-10-12 one save meant
for the film cooldown and the text reply also changed 20 other settings - the
film request groups, the posts and notifications groups, Gemini, email -
because the page showed them that way; an hour later a page left open since
then put nine of them back over a hand restore. A box you did not touch is
not sent, whatever it shows. The server refuses a film request group that is
also a posts group, the TV request group or the notifications group, and a
film section left with request groups and no posts group; a save that would
change settings in three sections or more, or ten settings or more, at once
shows you the list and asks first. A page loaded before this change cannot
ask, and is told to reload. Every change is named in full in the audit log
and the debug log.

**Back up `.env`.** Lose it and the saved secrets become unreadable. The
easy way is the sealed backup, which keeps `.env`, `config.json`, the
WhatsApp session and the rest in the repository, encrypted under a
passphrase, refreshed nightly:

```bash
cd ~/whatsapp-bot && node tools/backup-secrets.mjs --set-passphrase --install-cron
```

A new machine is then rebuilt with one paste and that passphrase, nothing
retyped and no re-link - see
[docs/server-setup.md → One paste](docs/server-setup.md#one-paste-a-new-vm-in-one-go)
and [docs/operations.md → Backups](docs/operations.md#backups).

Keys you need:

- **OMDb** — free at [omdbapi.com](https://www.omdbapi.com/apikey.aspx). Required.
- **TMDB** — free at [themoviedb.org](https://www.themoviedb.org/settings/api).
  Optional but recommended: it makes the theatrical check definitive instead
  of a guess (see below).
- **Gemini**, and optionally **Groq**, **Cerebras**, **Mistral** and
  **OpenRouter** — for the nudity check and for identifying a film from a
  description. Both, and every provider, are on by default; with no key saved
  for any of them nothing is asked, and a rated film is refused on its
  rating. Gemini's free tier (20 requests a day) runs out by mid-morning; the
  others are asked in turn when it does (Settings → Movies → AI providers).
  The nudity check only ever helps a film or episode its rating blocks through - it never
  refuses anything - and a "no nudity" from one of the fallbacks clears one
  only if you allow that for the provider. A title on the rating-override
  (bypass) list is sent with no AI check at all. See
  [docs/operations.md](docs/operations.md#fallback-ai-providers-groq-cerebras-mistral).

### Why the theatrical check wants TMDB

"In theaters only" isn't a field anywhere — it's the *absence* of a home
release. The bot answers it in descending order of reliability:

1. **TMDB release types** (needs the key) — records digital/physical release
   dates explicitly. Definitive.
2. **OMDb's `DVD` field** — frequently `N/A` or stale for recent films, so it
   can only ever prove a film *has* left theaters.
3. **Age heuristic** — anything released within `windowDays` (default 180) is
   assumed still theatrical.

Without TMDB you're relying on 2 and 3, which will occasionally be wrong in
both directions. With it, this check is essentially correct.

Because it never blocks a send — it only chooses between the 🎪 and 📭
reactions on a title you don't have — getting it wrong is cheap. A film you
own is always sent regardless.

---

## Connecting your library

Settings → **Library** → provider **Jellyfin**. Enter the server URL
(e.g. `http://192.168.1.50:8096`, no trailing slash), then choose how to
sign in:

| Method | What you enter | Notes |
|---|---|---|
| **Username & password** | your Jellyfin login | Simplest. The password is used once to obtain a token, then stored encrypted. The token renews itself if Jellyfin invalidates it, so a server restart does not log the bot out. |
| **Quick Connect PIN** | nothing | Jellyfin shows a 6-digit code; approve it from any device already signed in. No password ever reaches this server. Needs Quick Connect enabled in Jellyfin → Dashboard → Quick Connect. |
| **API key** | a key from Dashboard → API Keys | Never expires, but you have to go and create it. |

The status line underneath shows whether the bot is linked and as which
user. **Test connection** confirms search actually works.

Plex, a custom HTTP index, and plain local folders are also supported —
switch provider and the relevant fields appear.

### If your Jellyfin is slow

Searching through the Jellyfin *web UI* can take a while, because it renders
artwork for every result. The bot never uses that path — it queries
`/Items?searchTerm=` directly and pulls the file via `/Items/{id}/Download`,
which is exactly what the **⋯ → Download** button calls. That is normally
far quicker than the UI.

If your server is genuinely slow to answer, raise **Search timeout**
(default 180 s). The bot waits rather than failing the request, and **Test
connection** counts up the seconds so you can see it working.

Better still: if the Jellyfin storage is also mounted on this box, the bot
reads the file straight off the mount and skips both the search download and
the transfer. The Test tab tells you which is happening — "readable on this
server" versus "will download".

---

## Testing without spamming a group

Settings are easy to get subtly wrong. **Test** tab → type a title → it runs
the exact same checks against the real APIs and your real library, shows each
step and which emoji would be used, and touches WhatsApp not at all.

Use it after any settings change.

---

## Tests

```bash
npm test
```

Covers title matching (typos, omitted subtitles, false-positive guards,
candidate ranking) and the size-targeting maths that keeps files under
WhatsApp's 2 GB cap. 59 assertions, no network or WhatsApp needed.

---

## Debug log and email alerts

### The log

Everything is written to `data/logs/debug-YYYY-MM-DD.log`, **always at debug
level** regardless of what the console is set to. The console verbosity in
Settings only affects what you see live; the file always gets the full trace.
That is the point — you want the detail available after something has already
gone wrong, not to have to reproduce it with logging turned up.

- Rotates daily, and again at 32 MB within a day
- Yesterday's files are gzipped automatically
- Pruned after 14 days (both configurable in Settings)
- **Writes are synchronous**, so the last lines before a crash are on disk.
  A buffered log loses exactly the lines that matter most.

The **Logs** tab has two halves: a live view with level and text filters, and
the saved files, which you can view in-browser or download.

### Email

Settings → **Email alerts**. Gmail, Outlook and Yahoo are presets; anything
else is custom SMTP.

Gmail and Outlook need an **app password**, not your account password, and
two-factor must be on before you can create one:
`myaccount.google.com` → Security → App passwords.

Three buttons, in increasing order of commitment:

| Button | What it does |
|---|---|
| **Check credentials** | Opens an SMTP session and authenticates. Sends nothing. |
| **Send test email** | Sends a short message so you can confirm delivery. |
| **Email me the log now** | Sends today's log, gzipped, with an error/warning count. |

Email is on by default, with **Email me when an error is logged** and a daily
summary at midnight (the operator's settings, the defaults since
2026-10-12); until an address and an app password are saved nothing is sent,
tried or logged. A summary that fails to send is tried again every 30
minutes, or as soon as the email settings are changed, rather than on every
minute's check: an account that cannot send would otherwise be logged into
about 1,440 times a day. The error alert is throttled (30 minutes by
default) because a failing loop can log thousands of errors a minute; errors
during the quiet period are counted and summarised in the next message
rather than dropped. Alerts about the mailer itself are ignored, so a broken
SMTP config cannot start a loop.

The app password is encrypted at rest like every other secret, and the API
returns a mask rather than the value.

---

## Writing your own plugin

Copy `src/plugins/echo/` and add its folder name to Settings → Plugins.

```js
export default {
  name: 'my-plugin',
  description: 'what it does',

  async setup(ctx) {},

  async onMessage(msg, ctx) {
    if (msg.text === '!hello') {
      await ctx.bot.sendText(msg.chatJid, 'hi', { quoted: msg });
    }
  },

  async onConfigChange(config, ctx) {},
  async teardown() {},
};
```

`msg` is normalized: `{ id, chatJid, senderJid, isGroup, fromMe, text,
pushName, timestamp, messageType, key, raw }`.

`ctx` gives you:

| | |
|---|---|
| `ctx.bot` | `sendText`, `sendDocument`, `react`, `sendPresence`, `groups()` |
| `ctx.config` | live config — always current, never a stale copy |
| `ctx.queue` | the shared serial queue, for anything slow |
| `ctx.store` | persistent key/value scoped to your plugin |
| `ctx.log` | namespaced logger, streams to the Logs tab |

Long work goes through the queue so it stays serialized and cancellable:

```js
ctx.queue.add({
  label: 'something slow',
  run: async (job) => {
    job.progress('working', 50);
    if (job.isCancelled()) return;
  },
});
```

Plugin errors are caught per-plugin — one throwing never stops the others.

---

## Layout

```
src/
  index.js              entry point, wiring, shutdown
  core/
    bot.js              Baileys connection, reconnect, message normalizing
    plugin-manager.js   plugin loading and dispatch
    queue.js            serial job queue
    state.js            persistent key/value
  media/
    ffmpeg.js           probe, conversion planning, size-targeted encoding
    download.js         streaming download, cleanup
  plugins/
    movie-requests/     the movie pipeline
    echo/               template plugin
  web/
    server.js  api.js  auth.js  public/
  config/
    schema.js  store.js
data/                   config, session, state, media scratch  (gitignored)
certs/                  drop the filter's root CA here
```

---

## Security

The panel binds to `0.0.0.0:8080` so you can reach it at `IP:port` from
Windows. That means anyone on your LAN can reach it too — and it holds a
live WhatsApp session that can read and send as your number.

- Password login, scrypt-hashed, with rate limiting (8 tries / 15 min).
- Secrets encrypted at rest in `config.json`.
- `data/` is `0700`, `.env` is `0600`.
- The **↓ CSV** button on every card of the panel downloads that card's data
  (`src/web/public/csv-export.js`). No file ever holds a key, token or
  password: a key box is written as the same `••••••••` the panel shows,
  whether the key is saved or only typed, and a key inside a pasted link or a
  log line is masked too.
- **The CSV files contain personal data.** A file holds what its card shows,
  and many cards show people: the queue, Now running and the history carry
  the names and phone numbers of the people who asked; the member list, a
  member's page, a group's members, group activity and the banned list carry
  group members' names, phone numbers and WhatsApp ids; Wanted and Not in
  the library list who asked for each title. The numbers are kept on purpose
  — the files are made to be shared, deliberately, with someone who needs to
  know who asked — so treat every file as personal data: send it only to
  whoever needs it, and delete it once they are done with it.
- **A connected Discord account is the whole account.** The token pasted on
  Settings → Connection → Discord (read-only) gets past two-factor, and
  running a personal account from a program is against Discord's terms. It is
  encrypted like the other secrets, only the super-admin can set or remove
  it, and the reader can only read; changing the Discord password or "Log
  out of all devices" revokes it. See
  [docs/operations.md, "Discord tickets (read-only)"](docs/operations.md#discord-tickets-read-only).

**Do not port-forward this to the internet without HTTPS in front.** If you
need remote access, use an SSH tunnel:

```bash
ssh -L 8080:localhost:8080 mommy@<server-ip>
```

and set the bind address to `127.0.0.1`.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `unable to get local issuer certificate` | Filter CA missing — see the HTTPS section |
| `npm install` fails on certificates | Same; `npm config set cafile ...` |
| Pairing code never arrives | The number must have its country code: `+15551234567`, not `5551234567` |
| "Session taken over" | Another WhatsApp Web session displaced this one |
| Reactions don't appear | Bot must be a member; check the group JID in Settings |
| Jellyfin: "Nothing is listening at ..." | Wrong address or port in the server URL |
| Jellyfin: "did not respond within 180s" | Raise Search timeout in Settings → Library |
| Quick Connect button does nothing | Enable it in Jellyfin → Dashboard → Quick Connect |
| Jellyfin logs the bot out periodically | Use username/password rather than Quick Connect — it re-authenticates itself |
| Encode fails: still over limit | Lower `maxHeight` to 480 or `maxOutputBytes` |
| Everything stalls after one movie | Expected — jobs are serial by design |
| `group refresh failed: rate-overlimit` | WhatsApp throttles group listing after a reconnect. The bot retries with backoff; the list fills in shortly |
| Email: "Rejected the login" | Use an app password, not your account password, and enable two-factor first |
| Email: timeout | Ports 465/587 may be blocked outbound on this network |
| Out of memory during encode | `MemoryMax` in the unit file; 909 MB is tight |

Logs: the **Logs** tab, or `journalctl -u whatsapp-bot -f`.
