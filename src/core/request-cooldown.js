/**
 * The per-member request cooldown, for the film and the TV sections alike.
 *
 * THE RULE (the operator, 2026-10-01). Ben Lewis asked for "shaft 2019" at
 * 19:24:14. Shaft (2019) is rated R, the AI check found nudity, and it was
 * refused ⛔. He asked for something else at 19:25:35, and twice more by
 * 19:35:42, and each got 🚫 - "cooling down (3518s / 2955s / 2911s left)":
 * the film cooldown on that box is an hour, and it had started at the request
 * that was refused. The operator: "if the 1st item is denied to rated r or
 * not in library etc cooldown should not apply" ... "cooldown is only if the
 * members first request actually puts an item in queue, otherwise why we
 * cooling him down???" So:
 *
 * 1. A member's clock starts only when a request of theirs puts something in
 *    the queue: a film, a TV request with at least one episode, a pick from a
 *    "which one?" list that queues its film. A request that queues nothing -
 *    refused on its rating, not in the library, not found, a year or a season
 *    asked for, a list shown, a duplicate, not out yet, a test, an error -
 *    leaves the clock exactly as it was. Each section keeps its own clock, and
 *    a beta group its own again (cooldownKeys).
 *
 * 2. A request that arrives while the member's previous one in the same
 *    section is still being looked up - which takes 20 seconds and more with
 *    the AI check - waits for it (turn), and is then judged by what
 *    that one came to: queued, and the new one meets the cooldown; not, and
 *    the new one runs. Deciding before the first had settled would mean
 *    either refusing blind, which is the incident again, or running both side
 *    by side and queueing both. A request in flight for longer than
 *    inFlightWaitMs is taken as not queued, with a log line, and nobody waits
 *    for it any longer.
 *
 * 3. A backstop, for the number's sake (docs/whatsapp-ban-risk.md). Every
 *    refusal is a reaction, and most are a line in the notifications group or
 *    a quoted reply as well. Until this rule the clock was what limited them -
 *    one refusal per cooldown - and with nothing in its place one member could
 *    draw a ⛔ and a notifications line every few seconds for as long as they
 *    liked. So once a member's requests in a section have been answered
 *    without queueing floodAnswers times within floodWindowMs, their next ones
 *    get 🚫, as the cooldown's are, until the oldest of those answers leaves
 *    the window. A 🚫 is not counted itself, or the window would never pass
 *    for a member who kept asking. Every other answer is, the bot's own
 *    failures included (a lookup that failed, a full queue): each is still a
 *    reaction on the number, a full queue a notifications line as well, and
 *    before this rule the clock limited them to one per cooldown - with them
 *    uncounted, ten requests into a full TV queue drew ten notifications
 *    lines (found in review, 2026-10-01). They never start the clock, which
 *    is what the operator's "why we cooling him down" is about. Requests held
 *    while requests are paused are answered when they run, so they count as
 *    answers already given when the member asks again while paused
 *    (`pending`): eight held from one member were eight answers on resume.
 *
 * Group admins are exempt from all of it, as they always were from the
 * cooldown, and a section whose cooldown is 0 has switched per-member
 * throttling off: the wait and the backstop go with it. Both are the
 * plugins' to decide (movie-requests and tv-requests, _cooldownGate); this
 * module only keeps the clock, the count and the requests in flight.
 */

/*
 * Why these numbers. Five answers in ten minutes is more than anyone asking
 * in good faith draws: a refusal or two, a list, a "which season?" and its
 * answer. Past that it is somebody trying title after title, or a loop, and
 * at five it has already cost the group five reactions and up to five
 * notifications lines.
 *
 * inFlightWaitMs is only the default. Each plugin passes the longest its own
 * lookup can take (movie-requests and tv-requests, _cool), since a wait that
 * gives up before the lookup settles lets the next request run beside it and
 * both queue - the double queue rule 2 is there to prevent. A minute was the
 * first figure, and "vinland saga season 1" on 2026-10-01 took 72 s from 🔍
 * to 🎬 (ten AI checks through Gemini 503s); the TV AI checks alone may take
 * five minutes for one message (override-check.js LIMITS.budgetMs). The wait
 * ends the moment the earlier request settles, which is seconds as a rule,
 * so a long ceiling costs nothing until a lookup really is that slow - and
 * then the member's next request waits for it, as rule 2 says.
 */
export const COOLDOWN_LIMITS = Object.freeze({
  floodAnswers: 5,
  floodWindowMs: 10 * 60_000,
  inFlightWaitMs: 60_000,
});

/**
 * The store keys of a member's clock and of their answers, in the plugin's
 * own namespace. A beta group's are separate: on a shared clock an admin
 * testing in the beta group would meet 🚫 on their next real request in a
 * main group - a beta request reacting in a main group, which the beta group
 * promises never to do. Tests never queue, so a beta clock never starts now;
 * the beta backstop does count them.
 */
export function cooldownKeys(senderJid, { beta = false } = {}) {
  const who = beta ? `beta:${senderJid}` : String(senderJid);
  return { clock: `cooldown:${who}`, answers: `cooldown-answers:${who}` };
}

/**
 * When the member's clock last started, and on what: { at, what }, or null.
 *
 * Only a clock written by a queued request counts, which is the object this
 * module writes. Before 2026-10-01 the clock was a bare timestamp, set as
 * every request arrived whatever came of it - Ben's was one, started by a
 * rated-R refusal - and nothing in it can say whether its request queued, so
 * it is not honoured. The first queued request writes over it.
 */
export function readClock(store, key) {
  const v = store.get(key, null);
  return v && typeof v === 'object' && Number.isFinite(v.at) ? v : null;
}

/**
 * Frees the member's clock when the request that started it is cancelled by
 * an admin: the operator, 2026-10-23, "cancelled request should free the
 * member's hour". Only the clock of THAT film is cleared (`what` is what the
 * clock recorded, "Title (Year)"), so a later request queued in the meantime is
 * not freed by an earlier one's cancellation. Returns true when a clock was cleared.
 */
export function releaseClock(store, keys, what) {
  const clock = readClock(store, keys.clock);
  if (!clock) return false;
  const want = String(what ?? '').slice(0, 80);
  if (want && clock.what !== want) return false;
  forget(store, keys.clock);
  return true;
}

/** Rule 1's test: is this clock (readClock) running at `now`, started less than `cooldownMs` before it? */
function running(clock, cooldownMs, now) {
  return !!clock && cooldownMs > 0 && now - clock.at < cooldownMs;
}

/**
 * Is a request judged at `now` inside the member's cooldown - did a request
 * of theirs in this section queue something less than `cooldownMs` before?
 * { what, at, gapMs } of that request's clock if so, else null.
 *
 * The fair order's question (src/core/queue.js, "inside the cooldown"):
 * the operator, 2026-10-12, "if any user did a request within the 3600
 * seconds/1 hour cooldown period it should go to bottom as extra". A request
 * the cooldown lets through all the same - nobody else was waiting
 * (cooldownOnlyWhenOthersWait), or it was the one answer to "which season?"
 * - goes into the queue as an extra. Asked with the clock and the moment the
 * cooldown judges the request by (the plugins' _cooldownGate pass refusal()
 * the same `now`), so the two can never disagree.
 */
export function insideCooldown(store, keys, { cooldownMs, now = Date.now() }) {
  const clock = readClock(store, keys.clock);
  if (!running(clock, cooldownMs, now)) return null;
  return { what: String(clock.what ?? '').slice(0, 80) || null, at: clock.at, gapMs: Math.max(0, now - clock.at) };
}

/** The member's answers without queueing still inside the window, oldest first. */
export function recentAnswers(store, key, { floodWindowMs }, now = Date.now()) {
  const v = store.get(key, null);
  if (!Array.isArray(v)) return [];
  return v.filter((t) => Number.isFinite(t) && t > now - floodWindowMs && t <= now).sort((a, b) => a - b);
}

function forget(store, key) {
  if (typeof store.delete === 'function') store.delete(key);
  else store.set(key, null);
}

/**
 * Clear what can never matter again from a plugin's store: a clock from
 * before 2026-10-01 (a bare timestamp, which readClock does not honour) and
 * a member's answers once none is inside the window. Neither is read for
 * anything else, and both used to stay in state.json for good - the live
 * box had 42 film and 26 TV clocks of the old kind on the day the rule
 * changed (found in review). Run at start-up; refusal() clears a member's
 * own as it reads them. Returns how many keys it cleared.
 */
export function sweepCooldownKeys(store, { floodWindowMs = COOLDOWN_LIMITS.floodWindowMs, now = Date.now() } = {}) {
  const all = typeof store?.all === 'function' ? store.all() : null;
  if (!all) return 0;
  let cleared = 0;
  for (const [key, v] of Object.entries(all)) {
    const stale = (key.startsWith('cooldown:') && typeof v === 'number')
      || (key.startsWith('cooldown-answers:')
        && !(Array.isArray(v) && v.some((t) => Number.isFinite(t) && t > now - floodWindowMs)));
    if (stale) { forget(store, key); cleared += 1; }
  }
  return cleared;
}

/** "40 s", "9 min": how long, roughly, for a log line. */
function roughly(ms) {
  const s = Math.max(1, Math.ceil(ms / 1000));
  return s < 120 ? `${s} s` : `${Math.ceil(s / 60)} min`;
}

export class MemberCooldown {
  /**
   * @param section  'films' or 'TV', for the log lines
   * @param limits   COOLDOWN_LIMITS; a test passes shorter ones
   */
  constructor({ section, limits = COOLDOWN_LIMITS } = {}) {
    this.section = section ?? 'requests';
    this.limits = limits;
    // Clock key -> the member's requests being looked up now. In memory
    // only: a restart ends every lookup, and with it the wait.
    this.inFlight = new Map();
  }

  /**
   * Rule 2, and the decision after it: wait until none of the member's
   * requests in this section is still being looked up, then ask `judge`
   * whether this one may run, and if it may, register it as being looked up
   * (begin) - all in the one step after the last wait, so that of several
   * waiting at once only the first gets through before the next looks
   * again, and that one then waits for it too, and is judged by it. Each
   * request in flight is waited for until it settles or has been looked up
   * for inFlightWaitMs.
   *
   * `judge` runs synchronously and returns { go: true, ... } or
   * { go: false, ... }; whatever it returns comes back, with `lookup` - the
   * handle from begin() - when it may go.
   */
  async turn(keys, { what = null, log = null, who = '?', judge }) {
    const started = Date.now();
    const limit = this.limits.inFlightWaitMs;
    let said = false;
    for (;;) {
      const now = Date.now();
      const all = [...(this.inFlight.get(keys.clock) ?? [])];
      const live = all.filter((e) => now - e.since < limit);
      for (const e of all) {
        if (live.includes(e) || e.givenUp) continue;
        e.givenUp = true;
        log?.warn?.(`${this.section}: ${who}'s request "${e.what}" has been looked up for over ${roughly(limit)} - `
          + 'taken as not queued, and their next request is no longer held behind it');
      }
      if (!live.length) break;
      if (!said) {
        said = true;
        log?.info?.(`${this.section}: ${who} asked again while "${live[0].what}" is still being looked up - `
          + 'waiting for it before deciding the cooldown');
      }
      const until = Math.max(...live.map((e) => e.since)) + limit;
      let timer = null;
      await Promise.race([
        Promise.all(live.map((e) => e.done)),
        new Promise((r) => { timer = setTimeout(r, Math.max(0, until - now)); }),
      ]);
      clearTimeout(timer);
    }
    // Nothing may be awaited from the look above to begin() below.
    if (said) log?.info?.(`${this.section}: ${who}'s earlier request has settled after ${roughly(Date.now() - started)} - deciding the cooldown now`);
    const verdict = judge() ?? { go: true };
    return verdict.go ? { ...verdict, lookup: this.begin(keys, what) } : { ...verdict, lookup: null };
  }

  /**
   * Why the member's request would be refused now, or null. 'clock': a
   * request of theirs queued less than `cooldownMs` ago (rule 1). 'flood':
   * the backstop (rule 3). The backstop is asked first, so a plugin that
   * waives the clock (cooldownOnlyWhenOthersWait) can never waive it.
   *
   * `pending` is how many of the member's requests in the section are held
   * while requests are paused, given only for a request that would be held
   * too: each will be answered when requests resume, so they count as
   * answers already. Without it one member's eight held requests were eight
   * lookups and refusals in the replay (found in review, 2026-10-01), where
   * the clock used to let one through.
   */
  refusal(store, keys, { cooldownMs, now = Date.now(), pending = 0 }) {
    const { floodAnswers, floodWindowMs } = this.limits;
    if (Array.isArray(store.get(keys.answers, null)) && !recentAnswers(store, keys.answers, this.limits, now).length) {
      forget(store, keys.answers);
    }
    if (typeof store.get(keys.clock, null) === 'number') forget(store, keys.clock);
    const recent = recentAnswers(store, keys.answers, this.limits, now);
    const held = Math.max(0, Number(pending) || 0);
    if (floodAnswers > 0 && recent.length + held >= floodAnswers) {
      return {
        why: 'flood', count: recent.length, held,
        // Answered ones leave the window one by one; held ones are not
        // answered until requests resume, so with any of them in the count
        // the window is the honest wait.
        leftMs: recent.length >= floodAnswers
          ? Math.max(1000, recent[recent.length - floodAnswers] + floodWindowMs - now)
          : floodWindowMs,
      };
    }
    const clock = readClock(store, keys.clock);
    if (running(clock, cooldownMs, now)) {
      return { why: 'clock', leftMs: cooldownMs - (now - clock.at), clock };
    }
    return null;
  }

  /**
   * A request of the member's is being looked up from now: the next one waits
   * for it (rule 2). turn() calls it for a request that has met the cooldown;
   * a pick, which meets none, calls it itself. Returns its handle: settle()
   * once it has run, drop() if it is not run now after all (held by the
   * request pause, to be judged again when it is), and queued() the moment
   * it puts something in the queue, if that can come well before it settles.
   */
  begin(keys, what) {
    let resolve;
    const entry = { since: Date.now(), what: String(what ?? '').slice(0, 80), done: new Promise((r) => { resolve = r; }) };
    const set = this.inFlight.get(keys.clock) ?? new Set();
    set.add(entry);
    this.inFlight.set(keys.clock, set);
    let over = false;
    const end = () => {
      if (over) return false;
      over = true;
      const s = this.inFlight.get(keys.clock);
      s?.delete(entry);
      if (s && !s.size) this.inFlight.delete(keys.clock);
      resolve();
      return true;
    };
    return {
      drop: () => { end(); },
      /**
       * It has put something in the queue, though it is not done: the clock
       * starts now and the member's next request is let go to meet it. A TV
       * message asking for several seasons settles only once the last of them
       * has been looked up, minutes after its first was queued with the AI
       * checks, and a restart part-way through would never settle it at all
       * (found in review, 2026-10-01). Its settle() then records nothing more.
       */
      queued: (store, { what = null, log = null, who = '?' } = {}) => {
        if (over) return null;
        let result = null;
        try {
          result = this._record(store, keys, { queued: true, counts: false, what: what ?? entry.what, log, who });
        } finally {
          end();
        }
        return result;
      },
      /**
       * What it came to. `queued`: it put something in the queue, which
       * starts the clock. Otherwise `counts` says whether it was an answer
       * the backstop counts. Written before the waiters are let go, so they
       * read it.
       */
      settle: (store, { queued = false, counts = false, what = null, log = null, who = '?' } = {}) => {
        if (over) return null;
        let result = null;
        try {
          result = this._record(store, keys, { queued, counts, what: what ?? entry.what, log, who });
        } finally {
          end();
        }
        return result;
      },
    };
  }

  _record(store, keys, { queued, counts, what, log, who }) {
    const now = Date.now();
    if (queued) {
      store.set(keys.clock, { at: now, what: String(what ?? '').slice(0, 80) });
      return 'clock';
    }
    if (!counts) return null;
    const recent = recentAnswers(store, keys.answers, this.limits, now);
    recent.push(now);
    store.set(keys.answers, recent);
    const { floodAnswers, floodWindowMs } = this.limits;
    if (floodAnswers > 0 && recent.length === floodAnswers) {
      log?.warn?.(`${this.section}: ${who} has had ${recent.length} requests answered without queueing in `
        + `${roughly(floodWindowMs)} - their next ones get 🚫 for ${roughly(recent[0] + floodWindowMs - now)}, `
        + 'until the oldest leaves the window (the flood backstop, src/core/request-cooldown.js)');
      return 'tripped';
    }
    return 'counted';
  }
}
