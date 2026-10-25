# What could get this number banned

A WhatsApp account running a bot is judged on how it *behaves*, not on what it
is for. This is the inventory of everything in here that could look like abuse,
what the code does about each one, and what is still exposed.

It exists because six real logouts have already happened, and because the
numbers below show the bot was, at times, hammering WhatsApp far harder than
any person could.

All figures are counted from `data/logs/debug-2026-08-*.log`, 18-30 August 2026.
Re-run the commands in [Measuring it yourself](#measuring-it-yourself) to refresh
them.

> **Revised 31 August 2026.** The first version was written from the logs alone.
> A code audit afterwards found four further risks it had missed and **one claim
> it got wrong** - see the correction in §4. Two of the four are now fixed; the
> rest are listed in [What is still open](#what-is-still-open).

---

## The headline numbers

| Measure | Count | Notes |
|---|---:|---|
| Socket opens (`state -> connecting`) | **6,136** | the primary flag signal |
| Connection drops (`connectionLost`) | 1,878 | |
| **Genuine logouts on the phone** | **6** | the real events |
| Failover switches | **1,885** | 1,791 of them blamed on those 6 logouts |
| Overlapping-socket warnings | 168 | two sockets briefly live at once |
| Documents uploaded | 1,114 | peak 29 in one hour |
| Messages deleted for everyone | 101 | enforcement |
| **Times WhatsApp rate-limited us** | **26** | see below |

Worst single hour: **935 socket opens** (20 Aug, 11:00). Worst days: 1,064
(29 Aug) and 1,057 (30 Aug).

WhatsApp did not just tolerate this. It pushed back, with escalating penalties:

```
13x  group list rate-limited, retrying in 30s
 8x  ... 60s
 3x  ... 120s
 1x  ... 480s
```

That escalation is the account being progressively penalised. It is the
clearest evidence in these logs that the behaviour was noticed.

---

## Vectors

### 1. Reconnect storms — was the worst, now mitigated

**What.** The backoff doubled to 60 seconds and then stayed there for as long
as the outage lasted. A network problem therefore produced a fresh connection
attempt every minute, indefinitely — 1,057 in a single day.

**Evidence.** `src/core/bot.js`, previously
`Math.min(60_000, 2_000 * 2 ** Math.min(attempts, 5))`. 6,136 socket opens
across the period; 169 on 31 Aug before the fix.

**Mitigation (31 Aug).** The backoff now keeps doubling to a configurable
ceiling, `whatsapp.maxReconnectDelayMs`, default 15 minutes, with ±15% jitter.
A blip still recovers in 4 seconds and is under a minute by the fourth attempt.
A full day of outage is now roughly **96 attempts instead of 1,440**.

**Do not** lower that ceiling back toward 60s to make reconnects feel snappier.
That is the change that caused this.

---

### 2. Failover amplification — was catastrophic, now mitigated

**What.** Six genuine logouts produced **1,791 failover switches**. Each switch
tears down a session and starts another, which is the single most
account-flagging thing this bot can do. On 20 August, 929 of them happened
*inside one second*.

**Evidence.** `grep -c 'the number was logged out on the phone'` → 1,791
against 6 occurrences of `logged out on the phone - session wiped`.

**Cause.** Two bugs. `bot.stop()` did not clear `lastError`, so the deliberate
stop *inside* a switch still read as a fresh logout and drove the next one. And
the busy flag was assigned *after* `__switchTo` began, so the synchronous
`stop()` inside it re-entered the state handler before any guard existed.

**Mitigation.** `lastError` is cleared on a successful connect and on a
deliberate stop; the busy flag is set synchronously before the switch starts;
one failover per outage, cleared only by an actual connection; and a circuit
breaker that stands down after `failover.maxSwitchesPerWindow` (3) switches an
hour, because when the connection itself is unstable no number will help.

---

### 3. Group-list fetches — the one WhatsApp actually punished, now mitigated

**What.** `groupFetchAllParticipating()` is the only call WhatsApp is recorded
as rate-limiting here, 26 times, with escalating penalties up to 480 seconds.

**Status.** Partly mitigated, and the gap is precise.

`refreshGroups()` has a **5-minute debounce** — but only when `force` is false
(`src/core/bot.js:720`). Four call sites pass `force: true` and bypass it
entirely:

| Site | After |
|---|---|
| `bot.js:880` | any participant change in a group |
| `bot.js:1018` | banning a number from every group |
| `bot.js:1044` | adding/removing a number across groups |
| `api.js:481` | a manual refresh from the portal |

So a session of moderation — a ban, then some adds, then a promote — forces one
full group-list fetch *per operation*, straight past the debounce. That is what
earned the 26 rate-limits.

The retry itself is well behaved: it backs off 30s → 1m → 2m → 4m → 8m
(`bot.js:703`). The problem is upstream of it.

**Recommendation.** Make `force: true` mean "refresh soon" rather than "refresh
now": collapse forced refreshes into a single call on a short timer (10–30s) so
a burst of membership changes produces one fetch rather than one each. Keep the
portal's manual button immediate — that one is a person asking.

**Mitigation (31 Aug).** `groupFetchAllParticipating()` now has two gates, not
one. The 5-minute cache never covered the path that mattered: every bulk admin
operation ended with `refreshGroups({ force: true })`, so banning five people in
a row meant five full participant fetches back to back - precisely the burst
that earns the 480s penalty.

Forced fetches now get their own 1-minute floor, and a suppressed one is routed
into the existing backoff-aware scheduler rather than dropped. Delayed, not
discarded: the caller has just *changed* the membership, so the cache is known
to be wrong, and dropping the refresh leaves it wrong for five minutes.

The same change fixed a drop-if-busy flag. A forced refresh arriving while a
fetch was already running returned the stale list and abandoned the refresh
entirely. Concurrent callers now share the in-flight fetch and all see the
fetched data.

The `groups.update` event path stays unforced. Forcing there once produced a
permanent refresh -> rate-limit -> back off -> refresh cycle; `force` is opt-in
for the bulk-admin caller only.

---

### 4. Bulk group administration — mitigated

**What.** Descriptions, member add/remove, promote/demote, bans across every
group, lockdown, pinning. These are rate-limited hardest by WhatsApp, and the
bot does them across 15–25 groups in one go.

**Mitigation.** Every bulk loop goes through `_bulkPace()`:

| Bulk operation | Pace | A person doing it by hand |
|---|---:|---|
| Descriptions, member changes, bans | 4s | 15-30s |
| Ban wipe (revoking a banned member's backlog) | 2.5s | several seconds each |
| Same file to another posts group | 8s | - |
| Lockdown, per group | 5s | ~15s |

Revokes in the ban-wipe loop were once at **400ms** - roughly ten times faster
than a human could long-press, delete and confirm. Pacing also runs on the
*failure* path: a burst of rejected deletes is the surest sign of already being
throttled, and was the one case that ran at full speed.

> **Correction (31 Aug).** The first version of this document listed "message
> deletes (revokes) - 2.5s" as though it covered all deletes. It did not. That
> pace only ever applied to the **bulk ban-wipe loop**. The everyday
> enforcement path, `deleteMessage()`, went **straight to the socket with no
> pacing at all** - which is how 30 revokes landed inside one minute. Fixed in
> `9012f37`; `deleteMessage()` now paces like every other action, and
> `test/pacing.test.mjs` asserts that *no* send site is left unpaced.

**Do not** add a bulk loop that calls WhatsApp without `_bulkPace()`, or a
single action without `_pace()`. `test/pacing.test.mjs` fails if one appears.

---

### 4b. Per-action pacing was not actually serialising - **was severe, now fixed**

**What.** `whatsapp.minActionDelayMs` / `maxActionDelayMs` (1.2-3.5s) are meant
to put a randomised gap before every single action. The implementation did not
do that. It read `_lastActionAt`, awaited, and only *then* wrote it:

```js
const remaining = wait - (Date.now() - this._lastActionAt);   // read
if (remaining > 0) await sleep(remaining);                    // ...await...
this._lastActionAt = Date.now();                              // write, too late
```

Two callers arriving during that await both read the **same** timestamp, waited
the **same** amount, and fired **together**. Every action taken in parallel
therefore bypassed the pacing completely.

**Why that is the normal case, not an edge case.** Almost nothing here is
sequential. Three queue jobs run concurrently, each reacting and replying; a
queue advance re-reacts on up to ten waiting messages at once; enforcement runs
independently of all of it. Measured with five concurrent callers at a 100ms
pace:

```
before:  1ms, 1ms, 1ms, 1ms, 1ms      (one burst - pacing did nothing)
after:   1ms, 101ms, 201ms, 302ms, 402ms
```

**Mitigation.** `_pace()` is now a promise chain, so each call queues behind the
last instead of racing it. Fixed in `9012f37`.

**Lesson.** The setting existed, was configured sensibly, and read correctly in
every log. It was still doing nothing under concurrency. A rate limit that is
never tested under parallel load is a rate limit you do not have.

---

### 4c. Reaction churn - **open**, low severity

**What.** A single successful request collects roughly six lifecycle reactions
on the same message (researching, added, downloading, converting, sending,
done), plus a position reaction that changes each time the queue advances -
about **17 reactions on one message** for a job that starts tenth.

`_updatePositions()` does skip a re-react when the emoji has not changed, and
everything past position 10 shares one overflow emoji, so the waste is bounded.
But every job finishing still re-reacts on up to ten messages at once.

**Status.** Until today those ten fired simultaneously (§4b). They are now
spaced 1.2-3.5s apart, which is the bulk of the fix. Still worth considering:
coalescing a queue advance into one pass rather than ten separate reactions, or
dropping position reactions past the top three.

**TV requests show their place too** (2026-09-28; always on since
2026-09-29, when the operator took it off the beta flag `tv-queue-positions`
it had been parked behind). It adds up to ten more messages to each re-react -
a film joining the line moves every TV request back one - and a duplicate
request following a waiting season shows the season's number as well. Four
things keep that from being worse than the movie side. A season is one place
in line, not one per episode, so an episode finishing moves nobody's number. A
request has at most one number on its way through the pacer at a time
(`src/media/place-reaction.js`, shared with the movie side). A number is
dropped at its turn with the pacer if it has been superseded or its request
has started since (`bot.react`'s `unless`), so a burst of queue changes sends
the latest number, not every one in between. And both plugins recount places
at most once a tick (`_positionsSoon`, and its twin in the movie plugin): a
film that started the moment it was queued fired 'added' and 'updated' in one
breath, and every waiting TV request was asked for a number one place back and
then one forward again, each paced and counted against the budget before being
withdrawn. One pass after both sends nothing.

A message asking for several seasons ("The Office seasons 1-3", since
2026-09-29) is one request per season, but it carries one number, not one per
season: the message shows the first of its seasons that has not finished
(`src/plugins/tv-requests/shared-message.js`), and the other seasons' numbers
and stages are never sent to it. Each season still has its own "added" line
in the notifications group, so the seasons are looked up and answered one
after another with `_bulkPace()` between them, and the seasons the server
does not have are answered together, in one reply and one line. The message
meets the cooldown once, so it is held to `tvRequests.maxSeasonsPerRequest`
seasons (1 by default) and `maxEpisodesPerRequest` counts all of its seasons
together: before that, "seasons 1-30" sent thirty "added" lines for one
cooldown. The seasons past the limit are named in one reply and one line.

That one-at-a-time rule was missing on the movie side, and it showed once
films resumed after a restart got their numbers back: each film picked back up
fired a queue event while the earlier films' numbers still waited behind the
🔄s, and each re-asked for them. Four films sent sixteen numbers, the first
one seven times. They then sent four numbers - and four 🔄s before them,
since each resumed film still got its 🔄 as well, which the number replaced
seconds later: 2N reactions at every start (30 films, 60), repeated by a
crash loop at each start. A film or TV request waiting for a place now gets
the number instead of the 🔄 - one reaction per request at a start, as before
place numbers - and 🔄 only when it starts at once or shows no number.

Since 2026-10-11 there is no 🔄 at all: a member read the one a restart put
on "Iron Man 3 2013" as "send it again", did, and was answered 🤥. A request
that starts at once, or shows no number, gets the stage it is at instead
(⬇️ ⚙️ ⬆️, or 🎬 with nothing started; `src/media/stage-reaction.js`) - still
one reaction per request at a start - and its run does not send that stage
again when it reaches it, so a start sends no more than it did, and a film
resumed mid-encode one reaction fewer.

A member's own request sent again while it waits is no longer a duplicate
(🤥) either: its message is shown 🎬 and the place in line, as their first
message was - on TV one for one with the 🤥 and number a duplicate got, on
films one 'low' number more than the 🤥 alone, and that number moves with
the line. What keeps it bounded: only the latest such message per request
follows the line, so the second, third and eighth add nothing to a move of
it; the flood backstop counts every one
after the first, so eight in a row meet 🚫 as eight duplicates did; the
notifications group is told once, not once a message. At a start, a film's
such message is sent nothing while its place has not moved: the number it
last showed is journalled. Restored as showing nothing, four films each sent
again once were eight reactions at every start where they had been four
(found in review, 2026-10-11). A TV request's is sent its number at a start
as a TV duplicate's always was, one message per request where every
duplicate of it had one.

**Clear waiting sends one ❌ per request it clears.** A film or TV request
cancelled or cleared before it starts shows ❌ (⏭️ for a skip) on the message
that asked for it, as the group rules promise; before, a film kept its place
number for ever. The reaction is `critical`, so the budget never drops it: a
queue of 104 waiting is 104 reactions, paced one at a time (§4b). The panel's
*Clear waiting* asks first and says how many requesters will see ❌.

---

### 4d. No global outbound budget — **was the last high-severity gap, now closed**

**What.** Pacing controls the *gap between* actions. Nothing controlled the
*total* over an hour or a day. There was no counter, no ceiling, and no
back-pressure: at the 1.2-3.5s floor, sustained, roughly **1,000-3,000 actions
an hour** was reachable with nothing to stop it.

Every other mitigation in this document is a *shape* control — how fast, how
bunched. None was a *volume* control. The one thing WhatsApp measurably
punished was volume.

**Mitigation.** Two rolling windows, an hour (60 x 1min buckets) and a day
(96 x 15min), count everything sent. As they fill:

1. **Back-pressure.** Pacing stretches up to 4x, so the bot slows into its
   ceiling instead of sprinting at it and stopping dead. The stretch is capped:
   an unbounded one produces a queue that never drains, which reads as a fault.
2. **Shedding.** Past a threshold, work nobody is waiting on is dropped rather
   than delayed. Admission is decided *before* joining the pace queue, so a shed
   action costs no channel time and shedding shortens the backlog instead of
   lengthening it.

**What is never shed, at any utilisation:** replies, documents, and every
*terminal* reaction — the last thing a requester will ever see about their
request. A lifecycle reaction is replaced by the next stage a minute later; a
terminal one is not, so dropping it leaves someone with nothing, for ever.

**The limits are measured, not guessed** (18 Aug - 1 Sep; one unit is a
message-equivalent, a socket open costs 5, a full participant fetch 3):

| | Units | Against the ceiling |
|---|---:|---|
| Busiest ordinary hour | 132 | 11% of 1,200 — invisible |
| **Worst hour on record** (935 socket opens) | **4,675** | **390% — sheds, slows** |
| Busiest ordinary day | ~2,900 | 36% of 8,000 — invisible |
| Worst day on record | 5,599 | 69% — just under the soft threshold |

So it is inert on a normal night and bites on the pathology. That is the whole
design: a ceiling set too high does nothing, and one set too low brakes on an
ordinary night and teaches the operator to switch it off.

**Coverage.** Eleven methods reached WhatsApp with neither a gate nor a meter —
most of the bulk group administration WhatsApp punishes hardest — so the first
version of the ceiling was blind to exactly the traffic it existed to catch.
All are now counted, and a test walks `bot.js` and fails if a call reaching
WhatsApp is neither gated nor metered.

**Connects are counted but never refused.** 6,136 socket opens in twelve days
cannot be gated at `_requireSock()` — they happen before a socket exists — and
blocking one turns a rate problem into an outage. Counting them means a
reconnect storm visibly spends the budget and the message side slows in
response rather than piling on.

**Slots go by priority.** Presidential priority is enforced when jobs are
picked and was being quietly undone at the wire, where `_pace` released callers
in strict arrival order. Harmless at the base pace; not once the budget can
stretch a slot to 14s. Waiting raises standing, capped below `critical`, so low
work is late but never abandoned.

**Persisted**, so a restart — or a crash loop, which is when a ceiling matters
most — cannot wipe it.

**Visible** in the panel as `normal` / `slowing` / `over` with the live numbers,
so a deliberate slowdown reads as a slowdown rather than a fault.

---

### 4e. Answers that queue nothing — **limited by the flood backstop**

Until 2026-10-01 the per-user cooldown was also what limited the answers
that queue nothing - "which season?", "not in the library", a pick list, a
duplicate, a rating refusal - since every request started the clock as it
arrived. Most of those answers post: a quoted reply, a notifications line,
or both, besides the reactions. The first version of TV place in line
(2026-09-29, caught in review before it shipped) gave the clock back
whenever a request queued nothing, and ten "#request The Boys" in a row drew
twenty messages; so did the first version of "Skip the cooldown while nobody
else is waiting" (2026-09-30), which let every request through while the
queue was idle, and a request that queues nothing leaves it idle - ten films
not found drew ten OMDb calls and twenty reactions.

Then the operator's rule of 2026-10-01, after a member's rated-R refusal
started an hour's film cooldown that gave his next three requests 🚫:
"cooldown is only if the members first request actually puts an item in
queue, otherwise why we cooling him down???" The clock now starts only at a
request that queues something, and the cooldown no longer limits the
answers at all. What does is the **flood backstop**
(`src/core/request-cooldown.js`): five requests of a member's in a section
answered without queueing within ten minutes, and the next get 🚫 - one
reaction, no reply unless replies on blocking are on, no notifications line,
no lookup - until the oldest of the five is ten minutes old. A 🚫 does not
count itself, or a member who kept asking would never be let go. "Skip the
cooldown while nobody else is waiting" never waives it. The bot's own
failures count like any other answer (a failed lookup, a full queue): they
start no clock, but each is a ⚠️ and a full queue a notifications line, and
in the first version, which left them out, ten requests into a full TV queue
drew ten lines and twenty Jellyfin calls where the old clock allowed one
(found in review, 2026-10-01). Requests held while requests are paused count
as answers to come, so no member has more than five held in a section to be
answered in the paced replay on resume.

So the ceiling one member can draw from the number with new requests is five
answers per section in any ten minutes, each a reaction or two and at most a
reply and a notifications line, and one 🚫 per message after that - where the
old cooldown allowed one answer per window (30 seconds by default; an hour on
the film side of the live box). The one thing outside it is a pick from a
"which one?" list, which the list invites and is not counted: it is bounded by
the list instead - a version refused is struck out, a pick that failed for
the moment (OMDb down) may be tried again, and the list closes after its ten
minutes - as it was before the rule. Ten "#request The Boys" in a row now draw
ten messages and five 🚫, not two messages and nine 🚫 as under the kept
clock, nor twenty as with no limit (`test/tv-cooldown.test.mjs`,
`test/cooldown-nobody-waiting.test.mjs`). A request sent while the member's
previous one is still being looked up waits for it and is judged by what it
came to, so a member's requests are looked up one at a time, save one that
outlasts the wait: nothing doubles the rate. The wait covers the section's slowest lookup (4 min 45 s
for films, six for TV, where the AI checks may take five); a minute, the
first figure, was shorter than a real TV lookup. The member asked "which
season?" may answer once whatever would refuse it, with a season of the
same show.

---

### 5. Media uploads — low risk, watch the ceiling

**What.** 1,114 documents in the period, peaking at 29 in one hour — roughly
one every two minutes, sustained.

**Status.** Acceptable, because each upload is genuinely slow (a 1.7 GB file
takes 1–2 minutes) and the stage semaphores allow only one at a time. The same
file going to several posts groups is paced at 8 seconds.

**Watch.** `media.concurrency` is 3. Raising it, or raising the upload stage
semaphore above 1, would remove the natural spacing that makes this safe.

---

### 6. Looking automated — partly mitigated

**What.** Instant replies, perfectly regular timing, and 24/7 activity all read
as a bot rather than a person.

**Mitigation.** `whatsapp.minActionDelayMs` / `maxActionDelayMs` (1.2–3.5s)
randomise the gap before each action, so replies are not instant and not
evenly spaced.

**Still exposed, two things.**

*No quiet hours.* The bot runs around the clock. A real account has a sleep
pattern; this one posts at 04:00 as readily as at 20:00. Worth a configurable
overnight pause for non-urgent work - reactions and position updates especially,
which nobody is waiting on at 04:00.

*`markOnline` is on in production.* `data/config.json` sets
`whatsapp.markOnline: true`; the schema default is `false`. It becomes
`markOnlineOnConnect` on the socket, so every reconnect announces the account as
actively online. Against 6,136 socket opens that is 6,136 presence
announcements, and it tells WhatsApp a human is at the keyboard around the clock
- which, combined with 24/7 activity, is the exact pattern it is looking for.

The default is `false` for a reason. Turning it off costs nothing but a read
receipt; this is worth changing, and it is a config edit, not a code change.

---

### 7. Overlapping sockets — mitigated

**What.** 168 `start() called while a socket already exists` warnings. Two live
connections for the same account, however briefly, is exactly what
`connectionReplaced` is for.

**Mitigation.** Generation guards (`_gen`) orphan in-flight handlers, and
`stop()` ends the old socket before a new one opens.

**Still exposed.** The warning still fires, so the race is being hit rather
than prevented, and the reconnect backoff added in `dfe3c42` only governs *one*
of the callers. `start()` is reached from four places with no shared gate
between them:

| Caller | Backed off? |
|---|---|
| Reconnect loop (`bot.js`) | yes - exponential to 15 min |
| Auto-connect on boot (`index.js:248`) | no |
| Portal "connect" button (`api.js:452`) | no |
| Account switch (`api.js:438`, `failover.js:416`) | no - only the failover circuit breaker |

Three of those four can open a socket immediately, at any time, with no
awareness of how many just opened. That is the likely source of the 168
overlap warnings, and the reason the backoff fix alone did not remove them.

Worth doing: put the backoff in front of `start()` itself rather than in the
reconnect path, so every caller inherits it.

---

## What is still open

Ordered by how much I would worry about each.

| # | Risk | Where | Severity |
|---|---|---|---|
| 1 | **No quiet hours** - active 24/7, including reactions nobody is waiting on at 04:00. | §6 | medium |
| 2 | **Reaction churn** - ~17 reactions per request; a queue advance re-reacts on ten messages. Now paced, priority-ordered and sheddable, but not yet coalesced. | §4c | low |

Nothing high-severity remains open.

**Closed, in the order they were found:**

| Risk | Fix |
|---|---|
| Reconnect storms - 6,136 socket opens, worst hour 935 | exponential backoff to a 15-minute ceiling (`dfe3c42`) |
| Failover amplification - 929 switches in one second | `stop()` clears `lastError`; synchronous re-entry guard |
| Unpaced enforcement deletes - 30 revokes in a minute | `deleteMessage()` now paces (`9012f37`) |
| Per-action pacing not serialising under concurrency | `_pace()` serialises, and now hands slots out by priority (`9012f37`, `69c3fe6`) |
| **Group-list fetches - the only thing WhatsApp punished, 26 times** | forced fetches get a 1-minute floor; suppressed ones are delayed, not dropped (`c575ce2`) |
| `start()` races - 168 overlapping-socket warnings | `start()` serialises; all four callers inherit the gate (`bc8741c`) |
| `markOnline: true` in production | set to `false`, matching the schema default |
| **No volume ceiling at all** - the last high-severity gap | hourly + daily budget, measured limits, graduated back-pressure and shedding that never touches what a person is waiting on (`896d13c`, `1bbe892`, `7322121`, `69c3fe6`) |

**A note on how these were found.** The first version of this document was
written from the logs. Every item added since - including the correction in §4
to a claim it made confidently - came from reading the *code* instead. The logs
show what happened; they cannot show a control that silently does nothing. §4b
is the clearest case: correctly configured, correctly logged, and completely
ineffective under the concurrency it actually runs in.

---

## Rules of thumb

- **Never** add a loop that calls WhatsApp without pacing. Use `_bulkPace()`.
- **Never** add a call to `sock.sendMessage` without `_pace()` in front of it.
- Test a rate limit under **concurrent** load, not sequential. A limiter that
  passes a sequential test and collapses under parallel calls looks identical in
  the logs to one that works (§4b).
- **Never** shorten the reconnect ceiling to make recovery feel faster.
- Switching numbers is not free. Each switch is a new session, and repeated
  switching looks worse than the outage it is trying to escape.
- If WhatsApp rate-limits something, back **off**, do not retry harder. The
  escalating 30 → 60 → 120 → 480 second penalties above are what retrying
  harder earns.
- A number that was logged out on the phone cannot be fixed from the server.
  Retrying it only adds noise.

---

## Measuring it yourself

```bash
cd ~/whatsapp-bot
L="data/logs/debug-2026-*.log"

grep -hc 'state -> connecting'                   $L | paste -sd+ | bc   # socket opens
grep -hc 'connection closed (connectionLost)'    $L | paste -sd+ | bc
grep -hc 'logged out on the phone - session wiped' $L | paste -sd+ | bc # REAL logouts
grep -hc 'failing over to'                       $L | paste -sd+ | bc
grep -hc 'rate-limited'                          $L | paste -sd+ | bc   # WhatsApp pushing back
grep -hc 'socket already exists'                 $L | paste -sd+ | bc
```

Socket opens per hour, which is the number that matters most:

```bash
cat data/logs/debug-2026-*.log | grep 'state -> connecting' | cut -c1-13 | sort | uniq -c | sort -rn | head
```

Anything above roughly 20 in an hour, sustained, deserves investigation.
