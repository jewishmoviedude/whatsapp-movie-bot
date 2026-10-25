import { EventEmitter } from 'node:events';
import { randomToken } from '../util/crypto.js';
import log from '../util/logger.js';

const logger = log.scope('queue');

const isTv = (x) => x?.kind === 'tv';

/** The longest delay setTimeout honours (2^31-1 ms); see _armHold. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The longest the waiting line is kept out of the slots of requests that had
 * started before a restart and are not back yet (_slotsKept). Each comes back
 * within seconds, or a few minutes when its lookup has to be tried again (30
 * s, 1 min and 2 min apart, media/resume.js); a request its plugin somehow
 * never put back or let go must not stop the queue for good.
 */
const KEEP_SLOT_MS = 10 * 60_000;

/** Requests of each kind in a list of them. */
function tally(list) {
  const o = { movie: 0, tv: 0 };
  for (const it of list) o[isTv(it) ? 'tv' : 'movie']++;
  return o;
}

/**
 * Was this job queued from the panel (or the box) rather than asked for in a
 * group? The plugins mark such a job with its requester - "manual (admin)",
 * "panel (<admin>)" - or, assigned to a member, with `assigned`. It is the
 * admin's own exception, so the fair order never moves it (see _fairFor).
 */
function fromPanel(meta) {
  if (!meta) return false;
  if (meta.assigned) return true;
  const who = String(meta.requester ?? '').trim().toLowerCase();
  return who.startsWith('manual') || who.startsWith('panel');
}

/**
 * Serial job queue. The movie pipeline runs one job at a time by design:
 * downloading and re-encoding a feature film is heavy, and sending several
 * large documents at once is a good way to get a connection dropped.
 *
 * JOBS AND REQUESTS. A job is one file: a film, or one TV episode. A request is
 * what somebody asked for: a film, one episode, or a whole season. A season
 * runs as one job per episode - that is what lets a movie overtake the rest of
 * it, and what the stage locks, the TV journal and the per-request notifier
 * are built on - but it is ONE item everywhere the queue is counted or shown:
 * the length limit, a requester's place in line, the panel's lists and arrows,
 * cancel. Counting episodes let one 50-episode season take half of bot-box's
 * 104 places on its own, and the panel listed it as fifty separate rows.
 *
 * A job joins a request by carrying `group` (the TV plugin passes its request
 * key). A job with no group is a request of its own. Once any job of a request
 * has started, the request is running until its last job is done - between
 * two episodes too, and while a movie that arrived mid-season goes first - so
 * it never drops back into the waiting line and takes a place number again.
 *
 * FAIR ORDER (queue.fairShare, off by default). The operator (2026-09-30): "if
 * another user requests something; the additional items of the person who did
 * multiple should get bumped to bottom of queue so the other person can get
 * the 1 item they need, if more people request 1 item then the items of person
 * with additional should keep getting bumped". With it on, the waiting line
 * goes round the members: everyone's first request before anyone's second,
 * every second before any third, and so on, and among equals in the order
 * they came. A request's number (its rank) is fixed when it is queued: one
 * more than the member's requests then in the queue, waiting or running (see
 * _fairFor). Counting only what is in the queue at the moment of the pick
 * would undo the whole thing at concurrency 1: the member's running film
 * finishes, their second is suddenly their "first", came before the other
 * member's, and runs next. The member is the request's `memberKey` (the
 * plugins set it from the sender); one with none, a job queued from the panel
 * and a retry are never moved (rank 1). _items() is the order, and the pick
 * (_nextEligibleIndex) follows it, so a number on a requester's message is
 * the place the request really has.
 *
 * INSIDE THE COOLDOWN. The count alone made a member's request a first one
 * whenever their previous one had left the queue - finished, or forgotten
 * by a restart - however soon after it they asked. The operator
 * (2026-10-12), looking at "11. Arrow season 1 / waiting extra / 23
 * episodes" on the panel: "if any user did a request within the 3600
 * seconds/1 hour cooldown period it should go to bottom as extra". Eli
 * Miller had asked for Better Call Saul season 2 two minutes after
 * season 1 and S01E07-E09 a minute and a half after that, Ari for Hunter x
 * Hunter season 1 a minute after Arrow season 1, shua for Marvel's
 * Daredevil S02E05-E09 a minute after Daredevil: Born Again S02E05-E08 -
 * each past the cooldown of the time, 30 seconds, and a first request again
 * once the earlier one had gone. A cooldown of an hour lets such a request
 * through too when nobody else is waiting (cooldownOnlyWhenOthersWait). So
 * a request the plugins queue inside its member's cooldown of the kind -
 * the cooldown's own clock, read when the cooldown judged it
 * (request-cooldown.js insideCooldown) - carries `insideCooldown` and is an
 * extra whatever the count: rank 2 at least, never lower than the count
 * makes it (_baseRank). Journalled with it and told to expectBack, so a
 * request put back after a restart is still one. Never for a request the
 * cooldown does not hold, so never for one the fair order does not move
 * either (_fairFor). The 'mark-extras' admin command marks what was already
 * waiting (src/core/mark-extras.js, markInsideCooldown).
 *
 * ACROSS A RESTART. The queue lives in memory, and the plugins put their
 * journalled jobs back after a restart one add() at a time. A request that
 * had started before the bot stopped is still running: it comes back marked
 * `startedBefore` (see add()) and is running again from the moment it is
 * queued, ahead of everything waiting, whatever its rank. On 2026-10-11
 * Thor: The Dark World had started at 14:54 UTC and was downloaded by 14:56
 * when the hourly check restarted the bot at 15:22. Put back as one more
 * waiting request, it was its member's second - ranked behind every first
 * request and held behind the TV for the film cooldown - and it sat at 1️⃣
 * while Ocean's Eleven, queued at 15:18, started in the free slot.
 *
 * Put back one at a time, the requests would be ranked in the order they
 * come back, not the order they were asked for in, and whatever is back
 * first could start in a slot that is someone else's. So before any is
 * back, each plugin says what it will put back (expectBack): who asked, when,
 * and whether it had started. A request is then ranked among its member's
 * by when each was asked for, those still to come back included (_fairFor),
 * and a slot is kept for each request that had started until it is back
 * (_slotsKept): nothing waiting starts in it. Found in review of the Thor
 * change, 2026-10-11: TV goes back after the films (media/resume.js
 * holdTvRecovery), and Ethan's waiting film, ranked before his running
 * season was back, came back as his first and started in the free slot; and
 * a started film whose library lookup failed once at boot, put back by a
 * retry a minute later (_retryLater in the movie plugin), found its slot
 * taken by a film that had been waiting.
 */
export class JobQueue extends EventEmitter {
  constructor({
    concurrency = 1, maxLength = 50, strictMoviePriority = true, reserveSlotForMovies = true,
    fairShare = false, extraFilmHoldMs = 0, clock = null,
  } = {}) {
    super();
    // Movies always go first: no TV episode starts while any movie is waiting
    // OR still running. Admins can turn this off to let the queue run in plain
    // arrival order.
    this.strictMoviePriority = strictMoviePriority;
    this.reserveSlotForMovies = reserveSlotForMovies;
    // The fair order (see the class comment). `extraFilmHoldMs` is the film
    // cooldown (movieRequests.cooldownSecondsPerUser): a member's extra film
    // waits behind the TV for that long after it was queued - the operator's
    // "those additional items should not go ahead of tv episodes until the
    // cooldown timer ends, once timer ends they can jump the tv episodes".
    this.fairShare = !!fairShare;
    this.extraFilmHoldMs = Math.max(0, Number(extraFilmHoldMs) || 0);
    // The clock, which a test replaces to move time on without waiting. A
    // hold ends with no event of its own, so the queue sets a timer for it
    // (_armHold); the timer functions are the clock's for the same reason.
    this._clock = {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t),
      ...(clock ?? {}),
    };
    this._holdTimer = null;
    this._holdAt = null;
    // The films held behind the TV when the order was last worked out, and
    // whether a wake-up is on its way (see _noticeReleased).
    this._held = null;
    this._wakeQueued = false;
    this._waking = false;
    this._closed = false;
    this.concurrency = Math.max(1, concurrency);
    this.maxLength = maxLength;
    this.pending = [];
    this.active = new Map();
    this.history = [];
    // Requests made of several jobs, by the key their jobs carry, and that key
    // by the id the panel is given for it (see add()).
    this.groups = new Map();
    this.groupIds = new Map();
    this.paused = false;
    this.draining = false;
    // Jobs waiting to be retried, which are in no queue until the retry
    // fires (media/resume.js RetryBook `show`): key -> row. Shown and
    // counted, and cancelled like any other; never started from here.
    this.retrying = new Map();
    // Requests a restart left, which the plugins are putting back (see the
    // class comment and expectBack): key -> { member, at, started, label,
    // token }. Since when a slot has been kept for those that had started,
    // and the wake-up for when that runs out (_slotsKept).
    this._expected = new Map();
    this._keptSince = null;
    this._keptTimer = null;
    this._keptAt = null;
  }

  /**
   * What a restart left, said by a plugin before it puts any of it back:
   * `{ key, meta, at, started, label }` for each journalled request - the
   * key its jobs will carry as `rankKey` (see add()), the meta its request
   * will carry (whose it is, whether it came from the panel, and whether it
   * was asked for inside its member's cooldown), when it was asked for, and
   * whether it had started. Each has a place in the fair
   * order from now (_fairFor), and one that had started has a slot kept for
   * it (_slotsKept), until it is back or the plugin lets it go
   * (forgetExpected).
   */
  expectBack(list) {
    const now = this._clock.now();
    for (const x of list ?? []) {
      if (x?.key == null || x.key === '') continue;
      // Counted against its member's requests as it will be once it is
      // back: never one the fair order does not move (_fairFor).
      const raw = x.meta?.memberKey;
      const exempt = raw == null || raw === '' || fromPanel(x.meta);
      const at = Number(x.at);
      this._expected.set(String(x.key), {
        member: exempt ? null : String(raw),
        at: at > 0 ? Math.min(at, now) : now,
        started: !!x.started,
        label: x.label ?? String(x.key),
        token: { dropped: false },
        // Asked for inside its member's cooldown (see the class comment):
        // still an extra once it is back, whatever the job it comes back as
        // carries.
        insideCooldown: !exempt && !!x.meta?.insideCooldown,
      });
    }
    this._drain();
  }

  /**
   * A request the queue was told to expect back (expectBack) will not come
   * back: given up, cancelled, posted already, handed to another request, or
   * left for the next start. Its slot is no longer kept. Like a request that
   * leaves the queue, it stops counting against its member's requests unless
   * it ran (see _fairFor) - `ran` says so when the caller knows better than
   * the journal did.
   */
  forgetExpected(key, { ran = null } = {}) {
    const k = key == null ? null : String(key);
    const x = k == null ? null : this._expected.get(k);
    if (!x) return false;
    this._expected.delete(k);
    if (!(ran ?? x.started)) x.token.dropped = true;
    this._drain();
    return true;
  }

  /**
   * Show a job waiting for its retry, or update it: `waitingFor` is 'delay',
   * 'room' (disk space) or 'connection'. `cancel(state)` is the plugin's, and
   * does what cancelling it means - forget the retry, take it out of the
   * journal, tell the requester. The key is the caller's and never leaves
   * this object: the panel is given `id`.
   */
  holdRetry({ key, label, kind = 'movie', meta = {}, attempt = 1, max = null, waitingFor = 'delay', cancel = null }) {
    const old = this.retrying.get(key);
    this.retrying.set(key, {
      id: old?.id ?? randomToken(6), key, label: label ?? 'job', kind: kind === 'tv' ? 'tv' : 'movie', meta: meta ?? {},
      attempt, max, waitingFor, since: old?.since ?? Date.now(), cancel,
    });
    this.emit('state', this.snapshot());
  }

  /** The job left its wait: back in the queue, finished with, or cancelled. */
  releaseRetry(key) {
    if (this.retrying.delete(key)) this.emit('state', this.snapshot());
  }

  _retryingById(id) {
    for (const r of this.retrying.values()) if (r.id === id) return r;
    return null;
  }

  _retryView(r) {
    return {
      id: r.id, label: r.label, kind: r.kind, meta: r.meta, state: 'retrying',
      attempt: r.attempt, max: r.max, waitingFor: r.waitingFor, since: r.since,
    };
  }

  /** Jobs, not requests: "is there anything left at all". */
  get size() {
    return this.pending.length + this.active.size;
  }

  /**
   * How many requests may wait: maxLength, or no limit at 0, as every other
   * limit in the panel reads 0. It used to read as no room at all: the
   * operator set Max queue length to 0 on 2026-10-12 (21:00 UTC), and every
   * member's request from then on was refused "Queue is full (0 waiting)".
   */
  _waitLimit() {
    const n = Number(this.maxLength);
    return n > 0 ? n : Infinity;
  }

  /** Is there room for `n` more waiting requests under maxLength? */
  hasRoom(n = 1) { return this.waitingCount() + n <= this._waitLimit(); }

  /** The error a full queue answers with, for callers that check first. */
  fullError() {
    const err = new Error(`Queue is full (${this.maxLength} waiting)`);
    err.code = 'QUEUE_FULL';
    return err;
  }

  /**
   * @param {{label:string, meta?:object, run:(ctx)=>Promise<any>, kind?:string,
   *          group?:string, groupLabel?:string, groupMeta?:object,
   *          onDiscard?:(state:string)=>void}} job
   *
   * `group` makes the job part of a request (see the class comment); the
   * first job of a group names it with `groupLabel` and `groupMeta`. Only the
   * first job of a request can be refused as over the limit: the rest join an
   * item that has already been counted, so a season goes in whole.
   *
   * `onDiscard` is called if the job is thrown away before it ever ran -
   * cancelled or cleared while waiting. `run` never sees that job, so without
   * this whoever queued it would wait for an outcome that never comes.
   *
   * `retry` marks a job as another attempt at one of its request's jobs - a
   * TV episode retried once WhatsApp is back - rather than one more: the
   * request keeps its count, and the lost attempt comes off it. Its value is
   * how that attempt ended, 'failed' or 'cancelled' (the failover's
   * 'interrupted' ends a job as cancelled). Joining a request that is already
   * running, it goes with the running requests' remaining jobs, ahead of
   * everything waiting (see below). A job of no request marked `retry` - a
   * film whose send was lost - goes first of all: it was running, often has
   * its finished file in hand, and was ahead of whatever started after it.
   * At the back of the waiting line, with strict movie priority off, it sat
   * behind a whole running season's remaining episodes: E01 … E20, then the
   * film, then E21 (the film was asked for first).
   *
   * `overLimit` lets an admin's own add from the panel past maxLength. The
   * limit is movieRequests.maxQueueLength, a brake on what the request groups
   * can pile up; a bulk re-run had filled it, and "ready player one", typed
   * into the panel by hand, was refused with "Queue is full (50 waiting)".
   *
   * `meta.memberKey` (or `groupMeta.memberKey`) says whose request it is, for
   * the fair order - see the class comment and _fairFor.
   *
   * `startedBefore` is for a restart's recovery: the time a journalled
   * request had first started in the process that stopped (the plugins
   * journal it as their jobs start). Its request is running again at once -
   * a season by its first job, which names the group - so it never takes a
   * place in the waiting line, and nothing gives it a place number again. It
   * goes ahead of everything waiting, whatever its rank in the fair order and
   * however late recovery gets to it, among the other requests put back this
   * way in the order they had started (_resumedSlot), and a film is never
   * held behind the TV. Thor: The Dark World, 2026-10-11 (see the class
   * comment), lost its turn to a request queued four minutes before the
   * restart for want of this.
   *
   * `rankKey` is the key a plugin gave expectBack for the request a restart
   * left: the job takes the place in the fair order that request has held
   * since then (_fairFor), and its slot is no longer kept (_slotsKept).
   */
  add(job, { overLimit = false } = {}) {
    const group = job.group == null || job.group === '' ? null : String(job.group);
    const joining = group != null && this.groups.has(group);
    if (!overLimit && !joining && this.waitingCount() >= this._waitLimit()) throw this.fullError();
    // Never later than now: a start stamped by a clock that has been set back
    // since would read as running for a negative time, and sort after
    // everything started in this process. A retry has a place of its own
    // (see above), and keeps it.
    const began = Number(job.startedBefore);
    const startedBefore = job.startedBefore != null && began > 0 && !job.retry ? Math.min(began, this._clock.now()) : null;
    const entry = {
      id: randomToken(6),
      label: job.label ?? 'job',
      meta: job.meta ?? {},
      run: job.run,
      kind: job.kind === 'tv' ? 'tv' : 'movie',
      group,
      onDiscard: typeof job.onDiscard === 'function' ? job.onDiscard : null,
      state: 'pending',
      progress: null,
      addedAt: this._clock.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
      cancelled: false,
      // Running since before a restart (see above); a season's is its group's.
      startedBefore: group ? null : startedBefore,
    };
    if (group) {
      let g = this.groups.get(group);
      if (!g) {
        g = {
          key: group,
          // The panel is handed this, never the key: the key is the caller's
          // (the TV plugin builds it from a WhatsApp message id, which the
          // sender's client chooses) and it would land inside an onclick.
          id: randomToken(6),
          label: job.groupLabel ?? entry.label,
          kind: entry.kind,
          meta: job.groupMeta ?? entry.meta,
          addedAt: entry.addedAt,
          // A season resumed after a restart had started already: it is
          // running, between two episodes, from now on.
          startedAt: startedBefore,
          startedBefore,
          total: 0, done: 0, failed: 0, cancelled: 0,
          // A season is one request, so its rank is the group's.
          fair: this._fairFor(job),
        };
        this.groups.set(group, g);
        this.groupIds.set(g.id, group);
      }
      const lost = job.retry === 'cancelled' ? 'cancelled' : 'failed';
      if (joining && job.retry && g[lost] > 0) g[lost] -= 1;
      else g.total += 1;
      entry.groupLabel = g.label;
      // A request stays in one piece in the line, so moving it moves all of it
      // and nothing can wedge itself between two of its episodes.
      let last = -1;
      for (let i = this.pending.length - 1; i >= 0; i--) {
        if (this.pending[i].group === group) { last = i; break; }
      }
      if (last >= 0) {
        this.pending.splice(last + 1, 0, entry);
      } else if (g.startedBefore != null) {
        // Put back as running after a restart: its place among those, by
        // when it had started - as its next episode's is once one has
        // started again and left nothing of it waiting.
        this.pending.splice(this._resumedSlot(g.startedBefore), 0, entry);
      } else if (g.startedAt) {
        // Nothing of a running request is waiting, but a job joins it: an
        // episode retried after its send was lost, with the rest of the
        // season in hand or done. Pushed to the back, it waited behind every
        // request that had not even started yet. It goes where the running
        // requests' remaining jobs go instead, ahead of the waiting line.
        const at = this.pending.findIndex((e) => !(e.group && this.groups.get(e.group)?.startedAt)
          && !(!e.group && e.startedBefore != null));
        if (at >= 0) this.pending.splice(at, 0, entry);
        else this.pending.push(entry);
      } else {
        this.pending.push(entry);
      }
    } else {
      entry.fair = this._fairFor(job);
      if (startedBefore != null) this.pending.splice(this._resumedSlot(startedBefore), 0, entry);
      else if (job.retry) this.pending.unshift(entry);
      else this.pending.push(entry);
    }
    this.emit('added', this.publicView(entry));
    this._drain();
    return entry.id;
  }

  /**
   * A new request's place in the fair order, decided as it is queued.
   *
   * `before` holds a token for each of the member's requests in the queue
   * now, waiting or running: its rank is one more than those still counting.
   * One thrown away without ever starting stops counting (`dropped`, see
   * _discard and _retire) - cancelled while it waited, it was never the
   * member's first - while one that ran counts on after it finishes, which
   * is what keeps a second request behind other members' first requests
   * once the member's first is done (see the class comment).
   *
   * Never moved, and never counted against the member's own requests: a job
   * queued from the panel (an admin's exception, "assign to someone"), a
   * retry (it was running, and goes back where it was), and one with no
   * member - a job journalled before members were recorded. `pin` is set by
   * an admin's move (_keepLine, _pin), so the order keeps it where they put it.
   *
   * `at` is when the request was asked for, and only the member's requests
   * asked for no later count: a request a restart left (`rankKey`, see
   * expectBack) comes back with the time and the token it was given then,
   * so it is ranked as it was before, whatever came back ahead of it, and
   * those of the member's still to come back count already for one asked
   * for after them. Any other request is asked for now.
   *
   * `insideCooldown` on the request's meta (or on what expectBack was told
   * of it) makes it an extra whatever the count (see the class comment) -
   * never for one the fair order does not move, which the cooldown does not
   * hold either.
   */
  _fairFor(job) {
    const raw = job.groupMeta?.memberKey ?? job.meta?.memberKey ?? null;
    const member = raw == null || raw === '' ? null : String(raw);
    const exempt = !member || !!job.retry || fromPanel(job.groupMeta) || fromPanel(job.meta);
    const key = job.rankKey == null || job.rankKey === '' ? null : String(job.rankKey);
    const back = key == null ? null : this._expected.get(key);
    if (back) this._expected.delete(key);
    const at = back?.at ?? this._clock.now();
    const cooled = !exempt && !!(back?.insideCooldown || job.groupMeta?.insideCooldown || job.meta?.insideCooldown);
    return {
      member, exempt, retry: !!job.retry, pin: null, at, token: back?.token ?? { dropped: false },
      before: exempt ? [] : this._tokensOf(member, at),
      ...(cooled ? { insideCooldown: true } : {}),
    };
  }

  /** The request a job belongs to: its group, or the job itself. */
  _recOf(e) {
    return e.group ? (this.groups.get(e.group) ?? e) : e;
  }

  /** The request behind one of _items()'s items. */
  _recOfItem(it) {
    return it.group ?? it.pending[0] ?? it.active[0] ?? null;
  }

  /**
   * A token for each of `member`'s own requests in the queue now, and still
   * to come back after a restart (expectBack), asked for no later than `at`
   * (see _fairFor).
   */
  _tokensOf(member, at = Infinity) {
    const seen = new Set();
    const out = [];
    const take = (e) => {
      const rec = this._recOf(e);
      if (seen.has(rec)) return;
      seen.add(rec);
      if (rec.fair && !rec.fair.exempt && rec.fair.member === member && !(rec.fair.at > at)) out.push(rec.fair.token);
    };
    for (const e of this.pending) take(e);
    for (const e of this.active.values()) take(e);
    for (const x of this._expected.values()) if (x.member === member && x.at < at) out.push(x.token);
    return out;
  }

  /**
   * A request's rank as it was queued: 1 for a member's first, and 2 at
   * least for one asked for inside its member's cooldown (`insideCooldown`,
   * see the class comment). One that was waiting when an admin moved
   * something keeps the rank it had then (`frozen`, see _keepLine).
   */
  _baseRank(rec) {
    const f = rec?.fair;
    if (!f || f.exempt || !f.member) return 1;
    if (f.frozen != null) return f.frozen;
    let n = 1;
    for (const t of f.before) if (!t.dropped) n += 1;
    return f.insideCooldown ? Math.max(2, n) : n;
  }

  /** Where the fair order puts a request: its rank, or the one an admin's move gave it. */
  _rank(rec) {
    return rec?.fair?.pin ?? this._baseRank(rec);
  }

  /**
   * Before an admin's move, with the fair order on: keep the waiting line
   * exactly as it is shown. Its requests are laid out in `pending` in that
   * order, and each keeps the rank it has now, for good (`pin`), and its
   * standing as an extra request (`frozen`, which decides whether a film is
   * held behind the TV). From then on the fair order only places new
   * requests among them; nothing already there changes places unless an
   * admin moves it, or a held film's hold runs out.
   *
   * A rank is otherwise worked out afresh every time, and it drops when an
   * earlier request of the same member is cancelled before it starts. With
   * only the moved request pinned, a request it had been put above could
   * then outrank it and the fair order undid the move with no admin touching
   * anything (found in review, 2026-09-30: A3 moved above B2, B1 cancelled,
   * and B2 was back above A3; likewise a request sent to the top was passed
   * by one whose rank dropped, and a held film whose hold a cancel lifted
   * jumped a film moved above it).
   */
  _keepLine(order) {
    if (!this.fairShare) return;
    this.pending.splice(0, this.pending.length, ...this._inTurn(order));
    for (const it of order) {
      const rec = this._recOfItem(it);
      if (!rec?.fair) continue;
      rec.fair.frozen ??= this._baseRank(rec);
      rec.fair.pin ??= rec.fair.frozen;
    }
  }

  /**
   * Keep a request an admin moved where they moved it (after _keepLine). It
   * takes the rank of the request it was put next to; with that and its new
   * place in `pending` (the tie-break), the fair order puts it exactly there
   * - after the request it went below, before the one it went above - and
   * keeps it there as other requests come. `moved` says an admin put this
   * one there by hand, not merely left it where it stood (markInsideCooldown).
   */
  _pin(it, beside) {
    if (!this.fairShare) return;
    const rec = this._recOfItem(it);
    if (!rec?.fair) return;
    rec.fair.pin = this._rank(this._recOfItem(beside));
    rec.fair.moved = true;
  }

  /**
   * The waiting line as the fair order sees it, in the order it will start,
   * for the 'mark-extras' admin command (src/core/mark-extras.js): each
   * request's key (its group's, or its job id), whose it is, its rank and
   * what an admin's move made of it. `comingBack` is how many requests a
   * restart left that are not back yet (expectBack). Reads only.
   */
  fairLine() {
    const { waiting } = this._items();
    return {
      comingBack: this._expected.size,
      requests: waiting.map((it, i) => {
        const rec = this._recOfItem(it);
        const f = rec?.fair ?? null;
        const job = it.pending[0] ?? null;
        return {
          key: it.key,
          kind: it.kind,
          label: it.group?.label ?? job?.label ?? 'job',
          meta: (it.group ? it.group.meta : job?.meta) ?? {},
          place: i + 1,
          member: f && !f.exempt ? f.member : null,
          rank: this._baseRank(rec),
          pin: f?.pin ?? null,
          frozen: f?.frozen ?? null,
          moved: !!f?.moved,
          insideCooldown: !!f?.insideCooldown,
        };
      }),
    };
  }

  /**
   * Make waiting requests extras, as asked for inside their members'
   * cooldown: the 'mark-extras' admin command, once, for what was waiting
   * before the queue marked such requests itself (src/core/mark-extras.js).
   * `marks` is [{ key, mark }], `key` as fairLine() gives it and `mark` what
   * the request's meta carries from now on. Answers each with { before,
   * after } - its rank - and `already` or `moved`, or null for a key that
   * is not a waiting request the fair order moves.
   *
   * An admin's moves (_keepLine, _pin) are kept. A request left where it
   * stood when an admin moved something else holds that rank for good
   * (`frozen`) and that place (`pin`); both go up to 2 at least, which is
   * what makes it an extra, and nothing else in the line changes. A request
   * an admin moved by hand keeps the place, rank and lane they gave it,
   * as it keeps them whatever the count does: it is marked, so it is an extra
   * from the next start on, when the queue has forgotten every move anyway.
   * The panel and every place-in-line reaction are told once, at the end.
   */
  markInsideCooldown(marks) {
    const waiting = new Set(this._items().waiting.map((it) => it.key));
    let changed = false;
    const out = (marks ?? []).map(({ key, mark = true } = {}) => {
      const k = key == null ? null : String(key);
      if (k == null || !waiting.has(k)) return null;
      const rec = this.groups.get(k) ?? this.pending.find((e) => !e.group && e.id === k) ?? null;
      const f = rec?.fair;
      if (!f || f.exempt || !f.member) return null;
      const before = this._baseRank(rec);
      if (f.insideCooldown) return { before, after: before, already: true, moved: !!f.moved };
      f.insideCooldown = true;
      if (mark && typeof mark === 'object') rec.meta = { ...(rec.meta ?? {}), insideCooldown: mark };
      if (!f.moved) {
        if (f.frozen != null) f.frozen = Math.max(2, f.frozen);
        if (f.pin != null) f.pin = Math.max(2, f.pin);
      }
      changed = true;
      return { before, after: this._baseRank(rec), already: false, moved: !!f.moved };
    });
    if (changed) this._wake();
    return out;
  }

  /**
   * When a waiting film's hold behind the TV ends, or null when it has none.
   * Only a member's extra film (rank 2 or more as queued, or as it stood
   * when an admin moved something - _keepLine - whatever the move made of
   * its place) is held, only with strict movie priority - with
   * it off, films never go ahead of TV anyway - and only while the film
   * cooldown has not passed since it was queued (the operator's rule, see
   * the constructor).
   *
   * Since it was first queued, that is: the time its request has in the
   * fair order (`fair.at`), which a restart gives back from the journal
   * (expectBack), not when this process put it back. Held from `addedAt`,
   * a film got a fresh full hour behind the TV at every restart, past the
   * end of its member's cooldown: Avi's Dune, queued at 10:00 inside his
   * cooldown and held to 11:00, would have been held to 11:50 by a restart
   * at 10:50 - and the live log had three restarts on 2026-10-12 alone
   * (found in review, 2026-10-12). Films that were extras by count were
   * held the same way.
   */
  _holdEnd(it) {
    if (!this.fairShare || !this.strictMoviePriority || !(this.extraFilmHoldMs > 0) || isTv(it)) return null;
    const rec = this._recOfItem(it);
    if (this._baseRank(rec) < 2) return null;
    return (rec.fair?.at ?? rec.addedAt ?? 0) + this.extraFilmHoldMs;
  }

  /**
   * Wake up when the next hold ends: the order changes then with no event,
   * and the panel and every number on a requester's message would otherwise
   * show the old one until something else happened. The panel is push-only,
   * so nothing else would ask. Rescheduled whenever the order is worked out
   * (_items), which every change leads to; unref'd, so it never keeps the
   * process up; stopped by close().
   */
  _armHold(at) {
    if (at === this._holdAt) return;
    if (this._holdTimer) this._clock.clearTimeout(this._holdTimer);
    this._holdTimer = null;
    this._holdAt = at ?? null;
    if (at == null || this._closed) return;
    // Node waits at most 2^31-1 ms (about 24.8 days) and fires anything
    // longer after 1 ms, with a TimeoutOverflowWarning. The hold is the film
    // cooldown, which the panel lets an operator set as high as they like: a
    // 30-day cooldown fired this timer every millisecond, each time a state
    // event, an SSE snapshot to every open panel and a warning in the
    // journal, for as long as the hold lasted (found in review, 2026-09-30).
    // A wake-up that comes early just sets the next one (_holdDue).
    const wait = Math.min(MAX_TIMER_MS, Math.max(0, at - this._clock.now()) + 1);
    const t = this._clock.setTimeout(() => this._holdDue(at), wait);
    t?.unref?.();
    this._holdTimer = t;
  }

  /** The hold timer fired: a hold has ended, unless the wait was cut short by the ceiling (_armHold). */
  _holdDue(at) {
    this._holdTimer = null;
    this._holdAt = null;
    if (this._clock.now() < at) { this._armHold(at); return; }
    this._wake();
  }

  /**
   * Tell everyone the order has changed, and start whatever now may: the
   * same event a move sends, which the panel and the place-in-line reactions
   * listen for. The snapshot arms the timer for the next hold, if any. It is
   * this wake-up's own, so a film it finds released needs no other
   * (_noticeReleased).
   */
  _wake() {
    this._waking = true;
    try { this.emit('state', this.snapshot()); } finally { this._waking = false; }
    this._drain();
  }

  /**
   * A film has left the held lane while it still waits - its hold ran out,
   * or a cancel made it its member's first request - so the order has
   * changed with no event of its own, and the film may be able to start in a
   * slot that is free now. Wake the queue once, just after whatever is
   * working the order out has finished.
   *
   * Two ways this was missed (found in review, 2026-09-30). A cancel lifted
   * the hold of the member's extra film and only said so: the film showed as
   * waiting #1 beside a free slot, and waited there for an unrelated event.
   * And the hold timer, due 1 ms after the hold ends, was replaced by the
   * next hold's whenever the panel read the queue in between - which it does
   * at every progress tick of the episode the film was held behind - so the
   * wake-up never came. Noticing it wherever the order is worked out covers
   * both, and anything else that ever lifts a hold.
   */
  _noticeReleased(waiting, held) {
    const was = this._held;
    this._held = held;
    if (!was?.size || this._waking) return;
    const still = new Set(waiting.map((it) => it.key));
    for (const key of was) {
      if (!held.has(key) && still.has(key)) { this._wakeSoon(); return; }
    }
  }

  _wakeSoon() {
    if (this._wakeQueued || this._closed) return;
    this._wakeQueued = true;
    queueMicrotask(() => {
      this._wakeQueued = false;
      if (!this._closed) this._wake();
    });
  }

  /** Change the fair-order settings (src/index.js, when the config changes). */
  setFairShare({ fairShare = this.fairShare, extraFilmHoldMs = this.extraFilmHoldMs } = {}) {
    const on = !!fairShare;
    const ms = Math.max(0, Number(extraFilmHoldMs) || 0);
    if (on === this.fairShare && ms === this.extraFilmHoldMs) return false;
    this.fairShare = on;
    this.extraFilmHoldMs = ms;
    // It reorders the waiting line, so the panel and every place-in-line
    // reaction are told now; and a film whose hold is lifted may start.
    this._wake();
    return true;
  }

  /** Stop the hold timer, for good: the process is shutting down. */
  close() {
    this._closed = true;
    this._armHold(null);
    this._armKept(null);
  }

  /**
   * Is anyone but `member` in the queue - a request waiting, running or
   * waiting for its retry? The cooldown's "nobody else is waiting"
   * (cooldownOnlyWhenOthersWait) asks. Anything with no member - queued from
   * the panel, or journalled before members were recorded - is somebody
   * else's: the queue is not empty of others while it is there.
   */
  hasOthers(member) {
    const m = member == null || member === '' ? null : String(member);
    const theirs = (key) => m == null || key !== m;
    const memberOf = (e) => this._recOf(e).fair?.member ?? e.meta?.memberKey ?? null;
    for (const e of this.pending) if (theirs(memberOf(e))) return true;
    for (const e of this.active.values()) if (theirs(memberOf(e))) return true;
    for (const r of this.retrying.values()) if (theirs(r.meta?.memberKey ?? null)) return true;
    return false;
  }

  /**
   * Cancel a job, or a whole request by its id or group key: everything of it
   * still waiting is thrown away and whatever is running is stopped.
   */
  cancel(id, reason = 'cancelled') {
    const state = reason === 'skipped' ? 'skipped' : 'cancelled';
    const retry = this._retryingById(id);
    if (retry) {
      this.retrying.delete(retry.key);
      try { retry.cancel?.(state); } catch (err) {
        logger.warn(`${retry.label}: could not cancel its retry: ${err.message}`);
      }
      this.emit('state', this.snapshot());
      return true;
    }
    const idx = this.pending.findIndex((e) => e.id === id);
    if (idx !== -1) {
      const [entry] = this.pending.splice(idx, 1);
      this._discard(entry, state);
      this._retire(entry.group);
      this.emit('updated', this.publicView(entry));
      this._rearm();
      return true;
    }
    const running = this.active.get(id);
    if (running) {
      this._abort(running, reason);
      return true;
    }
    const key = this._groupKey(id);
    if (!key) return false;

    let hit = false;
    for (const e of this.active.values()) {
      if (e.group === key) { this._abort(e, reason); hit = true; }
    }
    const mine = this._takeWhere((e) => e.group === key);
    for (const e of mine) this._discard(e, state);
    hit = hit || mine.length > 0;
    this._retire(key);
    if (hit) this.emit('state', this.snapshot());
    return hit;
  }

  _abort(entry, reason) {
    entry.cancelled = true;
    entry.cancelReason = reason;
    entry.abort?.abort();
  }

  /** A waiting job thrown away without running. The caller removed it from `pending`. */
  _discard(entry, state) {
    entry.state = state;
    entry.finishedAt = Date.now();
    this._archive(entry);
    const g = entry.group ? this.groups.get(entry.group) : null;
    if (g) g.cancelled += 1;
    // Never ran, so it no longer counts as one of its member's requests (a
    // season's is decided when its last job goes, in _retire). One put back
    // as running after a restart did run, before it.
    else if (entry.fair && entry.startedBefore == null) entry.fair.token.dropped = true;
    try { entry.onDiscard?.(state); } catch (err) {
      logger.warn(`${entry.label}: could not report it ${state}: ${err.message}`);
    }
  }

  /** Remove and return every waiting job matching `pred`, keeping the array itself. */
  _takeWhere(pred) {
    const taken = [];
    const kept = [];
    for (const e of this.pending) (pred(e) ? taken : kept).push(e);
    if (taken.length) this.pending.splice(0, this.pending.length, ...kept);
    return taken;
  }

  /** Forget a request once the last of its jobs is gone. */
  _retire(group) {
    if (!group || !this.groups.has(group)) return;
    if (this.pending.some((e) => e.group === group)) return;
    for (const e of this.active.values()) if (e.group === group) return;
    const g = this.groups.get(group);
    // A request that goes without ever starting was never its member's
    // first (see _fairFor).
    if (!g.startedAt && g.fair) g.fair.token.dropped = true;
    this.groupIds.delete(g.id);
    this.groups.delete(group);
  }

  /** A request's key, given its key or the id the panel knows it by; else null. */
  _groupKey(id) {
    if (id == null) return null;
    if (this.groups.has(id)) return id;
    return this.groupIds.get(id) ?? null;
  }

  /** The request a job id (or a request's key or id) belongs to, or null. */
  _keyOf(id) {
    const key = this._groupKey(id);
    if (key) return key;
    const e = this.pending.find((x) => x.id === id) ?? this.active.get(id);
    return e ? (e.group ?? e.id) : null;
  }

  /**
   * What a job or request is, without touching it. The audit log needs the
   * title BEFORE a cancel removes the entry - afterwards there is only an
   * opaque id, which is exactly what made "DELETE /queue/478b53eb4285" useless
   * after the fact. Returns null for an unknown id.
   */
  describe(id) {
    const retry = this._retryingById(id);
    if (retry) return this._retryView(retry);
    const g = this.groups.get(this._groupKey(id));
    if (g) {
      const it = this._items().all.get(g.key);
      return {
        id: g.id, label: g.label, kind: g.kind, meta: g.meta ?? {},
        state: it && (it.active.length || g.startedAt) ? 'running' : 'pending',
        jobs: this._jobCounts(g, it),
      };
    }
    const e = this.pending.find((x) => x.id === id)
      ?? this.active.get(id)
      ?? this.history.find((x) => x.id === id);
    if (!e) return null;
    return { id: e.id, label: e.label ?? 'job', kind: e.kind ?? 'movie', state: e.state, meta: e.meta ?? {} };
  }

  /** Titles of every request waiting to start, in the order they will. */
  pendingLabels() {
    return this._items().waiting.map((it) => it.group?.label ?? it.pending[0]?.label ?? 'job');
  }

  /**
   * Skip = abandon this job and move to the next. Distinct from cancel so
   * the requester can be told it was skipped, not silently dropped.
   *
   * For a request that is running, that is ONE episode and the rest of the
   * season carries on; Cancel is what stops all of it. The panel names the
   * episode. Given the request itself, it is the episode furthest along - the
   * one stuck sending, usually. Not every episode in hand: with two TV slots
   * (bot-box's concurrency 3, one kept for films) a season has two at once,
   * one sending and the next downloading, and stopping both to get past the
   * one too big to send throws a healthy download away and tells the
   * requester two were skipped.
   *
   * A running request with nothing in hand - between episodes, or held while
   * a film goes first - has nothing to skip, and answers false rather than
   * falling through to cancel, which would throw the rest of the season
   * away: a click on a card drawn while an episode was in hand can land
   * after that episode has finished.
   */
  skip(id) {
    if (this._retryingById(id)) return this.cancel(id, 'skipped');
    const key = this._groupKey(id);
    if (key) {
      // `active` is a Map, so the first of the request's jobs in it is the
      // one that started first.
      const lead = [...this.active.values()].find((e) => e.group === key);
      if (lead) {
        this._abort(lead, 'skipped');
        return true;
      }
      if (this.groups.get(key)?.startedAt) return false;
    }
    return this.cancel(id, 'skipped');
  }

  /**
   * Reorder a waiting request. dir is 'up' (sooner) or 'down' (later).
   *
   * Moves are made in the order things will actually start (see _items), so
   * one step up passes the request shown above it. With strict movie priority
   * every movie starts before any TV, so a TV request cannot be moved above a
   * movie, nor a movie below TV - the arrow would move nothing. A film held
   * behind the TV by the fair order (_holdEnd) is in a lane of its own after
   * the TV until its hold ends, for the same reason.
   *
   * With the fair order on, the moved request keeps the place it was given
   * (_pin), and the rest of the line the places it had (_keepLine): the
   * order would otherwise put it straight back, or let a request whose rank
   * later drops pass it.
   */
  move(id, dir) {
    const key = this._keyOf(id);
    const { waiting: order, held } = this._items();
    const i = order.findIndex((it) => it.key === key);
    if (i === -1) return false;
    const j = dir === 'down' ? i + 1 : i - 1;
    if (j < 0 || j >= order.length) return false;
    if (this.strictMoviePriority && this._lane(order[i], held) !== this._lane(order[j], held)) return false;

    this._keepLine(order);
    const mine = (e) => (e.group ?? e.id) === key;
    const theirs = (e) => (e.group ?? e.id) === order[j].key;
    const block = this._takeWhere(mine);
    let at;
    if (dir === 'down') {
      at = this.pending.length;
      for (let k = this.pending.length - 1; k >= 0; k--) if (theirs(this.pending[k])) { at = k + 1; break; }
    } else {
      at = Math.max(0, this.pending.findIndex(theirs));
    }
    this.pending.splice(at, 0, ...block);
    this._pin(order[i], order[j]);
    this.emit('state', this.snapshot());
    return true;
  }

  /** Which lane of the waiting line a request is in, for the arrows: films, TV, or films held behind the TV. */
  _lane(it, held) {
    if (held?.has(it.key)) return 'held';
    return isTv(it) ? 'tv' : 'movie';
  }

  /**
   * Send a waiting request to the front of the waiting line, next to run -
   * or, for TV with strict movie priority on, next after the movies.
   *
   * That is just ahead of the first waiting request in its lane, which is
   * where repeated ▲ would take it too. It is NOT the head of `pending`: a
   * running season's remaining episodes sit there, and they are not in the
   * waiting line the admin is looking at. Put in front of them, the moved
   * request would run all of its episodes while the running season stopped
   * half way, with nothing in hand and its requester's message stuck on its
   * last stage reaction - and the Waiting list would look no different.
   */
  moveTop(id) {
    const key = this._keyOf(id);
    const { waiting: order, held } = this._items();
    const i = order.findIndex((it) => it.key === key);
    if (i === -1) return false;
    const lane = this._lane(order[i], held);
    const first = order.findIndex((it) => !this.strictMoviePriority || this._lane(it, held) === lane);
    if (i === first) return true;             // already next in its lane
    const ahead = order[first].key;
    this._keepLine(order);
    const block = this._takeWhere((e) => (e.group ?? e.id) === key);
    const at = this.pending.findIndex((e) => (e.group ?? e.id) === ahead);
    this.pending.splice(Math.max(0, at), 0, ...block);
    this._pin(order[i], order[first]);
    this.emit('state', this.snapshot());
    return true;
  }

  pause() { this.paused = true; this.emit('state', this.snapshot()); }
  resume() { this.paused = false; this.emit('state', this.snapshot()); this._drain(); }

  /**
   * Throw away every request that is still waiting to start. A request
   * already running keeps the rest of its episodes: they are not on the
   * waiting list the admin cleared, and cutting a season short is Cancel.
   * Returns how many requests were cleared.
   */
  clearPending() {
    const waiting = new Set(this._items().waiting.map((it) => it.key));
    const removed = this._takeWhere((e) => waiting.has(e.group ?? e.id));
    for (const e of removed) this._discard(e, 'cancelled');
    for (const key of waiting) this._retire(key);
    this.emit('state', this.snapshot());
    return waiting.size;
  }

  /**
   * Make a request smaller: take off its waiting jobs that `keep(job)` - each
   * given as the panel sees it - answers false for, and leave the rest of it
   * as it was, in its place. Nothing running is touched, nor a job waiting
   * for its retry (in no queue, see holdRetry). The request holds fewer jobs
   * from then on (`total`), so the panel says what is coming, and each job
   * taken off hears 'trimmed' (onDiscard): not a cancel or a skip, nothing
   * failed, and kept out of the recently finished list - a season of 148
   * would push everything else out of it. Answers how many went.
   *
   * Cancel was the only way to make a request smaller, and it ends a request
   * whole: The Flash season 2, cancelled from the panel at 20:24 UTC on
   * 2026-10-12, the evening a request became ten episodes at most, ended
   * with 14 episodes posted on ❌ "An admin cancelled it — it isn't coming".
   * The TV plugin decides what a request keeps (trimQueued); the queue only
   * takes the rest off.
   */
  trim(id, keep) {
    const key = this._groupKey(id);
    if (!key || typeof keep !== 'function') return 0;
    const g = this.groups.get(key);
    const off = this._takeWhere((e) => e.group === key && !keep(this.publicView(e)));
    if (!off.length) return 0;
    for (const e of off) {
      g.total -= 1;
      e.state = 'trimmed';
      e.finishedAt = Date.now();
      try { e.onDiscard?.('trimmed'); } catch (err) {
        logger.warn(`${e.label}: could not report it trimmed: ${err.message}`);
      }
    }
    this._retire(key);
    this.emit('state', this.snapshot());
    this._drain();
    return off.length;
  }

  async _drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.paused && this.active.size < this.concurrency && this.pending.length) {
        const idx = this._nextEligibleIndex();
        if (idx < 0) break;                       // nothing may start right now
        // Not in a slot kept for a request that had started before a restart
        // and is not back yet (see the class comment). Only what is waiting
        // is kept out; what is running goes on in any slot. The pick is
        // otherwise unchanged, so with movie priority no TV starts either
        // while the film it picked waits, as with no slot free.
        if (this._waitingJob(this.pending[idx]) && this.active.size + this._slotsKept() >= this.concurrency) break;
        const [entry] = this.pending.splice(idx, 1);
        this._start(entry);
      }
    } finally {
      this.draining = false;
      this._rearm();
    }
  }

  /** Set the hold timer for the order as it now stands (see _armHold). */
  _rearm() {
    if (this.fairShare || this._holdAt != null) this._items();
  }

  /**
   * Which waiting job may start next.
   *
   * With strict movie priority: a movie always wins, and TV is held back until
   * the movie side is completely clear - nothing pending AND nothing running.
   * Holding on "running" too is what stops a TV episode grabbing the encoder
   * the moment the last movie starts downloading.
   *
   * With the fair order on, the same rules over the jobs in the order
   * _items() shows them (_nextFair).
   *
   * @returns index into `pending`, or -1 when nothing may start yet.
   */
  _nextEligibleIndex() {
    if (!this.pending.length) return -1;
    if (this.fairShare) return this._nextFair();
    if (!this.strictMoviePriority) return 0;

    const firstMovie = this.pending.findIndex((e) => e.kind !== 'tv');
    if (firstMovie >= 0) return firstMovie;              // a movie is waiting - it goes first

    const movieRunning = [...this.active.values()].some((e) => e.kind !== 'tv');
    if (movieRunning) return -1;                          // hold TV until movies finish

    // Keep one slot clear of TV. A season fills every slot in one go, and a
    // movie requested a second later then waits for a whole episode to finish
    // before it can even start - which is not "movies first" in any sense the
    // person waiting would recognise. With a slot held back, a movie starts
    // within seconds. Pointless at concurrency 1, where it would just stop TV.
    if (this.reserveSlotForMovies && this.concurrency > 1
        && this.active.size >= this.concurrency - 1) {
      return -1;
    }

    return 0;                                             // movies all clear - TV may run
  }

  /**
   * _nextEligibleIndex for the fair order: the rules above, applied to the
   * waiting jobs in the order they will start (_inTurn) rather than to the
   * array. A film held behind the TV (_holdEnd) is TV for this: it starts
   * only when no episode is waiting, and never in the slot kept for films.
   */
  _nextFair() {
    const { waiting, held } = this._items();
    const seq = this._inTurn(waiting);
    const at = (e) => (e ? this.pending.indexOf(e) : -1);
    if (!this.strictMoviePriority) return at(seq[0]);
    const film = seq.find((e) => e.kind !== 'tv' && !held.has(e.group ?? e.id));
    if (film) return at(film);
    if ([...this.active.values()].some((e) => e.kind !== 'tv')) return -1;
    if (this.reserveSlotForMovies && this.concurrency > 1 && this.active.size >= this.concurrency - 1) return -1;
    return at(seq.find((e) => e.kind === 'tv') ?? seq[0]);
  }

  /**
   * A request that has just started, from wherever the fair order took it,
   * brings the rest of its jobs to where a running request's remaining jobs
   * are kept: after the other running requests' (and a retried film at the
   * very front, see add()), ahead of everything waiting. The arrival order
   * always started a request from there, so its episodes were there already;
   * the fair order can start one from the middle, and left behind a waiting
   * request, the rest of a season started second would wait behind a season
   * that has not started at all (_inTurn hands the waiting places out again,
   * and the running one is not among them).
   */
  _keepRunningAhead(key) {
    const rest = this._takeWhere((e) => e.group === key);
    if (!rest.length) return;
    const at = this.pending.findIndex((e) => this._waitingJob(e));
    this.pending.splice(at < 0 ? this.pending.length : at, 0, ...rest);
  }

  /**
   * Is this job in `pending` part of a request that is waiting - not one
   * that is running (a season between two episodes, a film put back as
   * running after a restart) and not a retried film, which was running?
   */
  _waitingJob(e) {
    if (!e) return false;
    if (e.group) return !this.groups.get(e.group)?.startedAt;
    return !(e.fair?.retry || e.startedBefore != null);
  }

  /**
   * How many slots are kept for requests that had started before a restart
   * and are not back yet (expectBack), which nothing waiting may start in
   * (_drain). Thor: The Dark World, one "fetch failed" from its slot on
   * 2026-10-11 in review (see the class comment).
   *
   * Never for longer than KEEP_SLOT_MS from when they were first kept: one
   * still not back then is let go, with a warning that names it, so a
   * request its plugin never put back or forgot cannot stop the queue. A
   * wake-up is set for that moment, since nothing else may happen then.
   */
  _slotsKept() {
    const kept = [...this._expected.values()].filter((x) => x.started);
    if (!kept.length) {
      this._keptSince = null;
      this._armKept(null);
      return 0;
    }
    const now = this._clock.now();
    this._keptSince ??= now;
    if (now - this._keptSince < KEEP_SLOT_MS) {
      this._armKept(this._keptSince + KEEP_SLOT_MS);
      return kept.length;
    }
    logger.warn(`a slot was kept for ${kept.map((x) => x.label).join(', ')} for ${Math.round(KEEP_SLOT_MS / 60_000)} `
      + 'minutes after a restart and it is not back - the waiting line may have it');
    // Still counted against its member's requests: it ran, before the restart.
    for (const x of kept) x.started = false;
    this._keptSince = null;
    this._armKept(null);
    return 0;
  }

  /** The wake-up for when the slots kept after a restart are let go (_slotsKept). */
  _armKept(at) {
    if (at != null && at === this._keptAt && this._keptTimer) return;
    if (this._keptTimer) this._clock.clearTimeout(this._keptTimer);
    this._keptTimer = null;
    this._keptAt = at ?? null;
    if (at == null || this._closed) return;
    const t = this._clock.setTimeout(() => {
      this._keptTimer = null;
      this._drain();
    }, Math.min(MAX_TIMER_MS, Math.max(0, at - this._clock.now()) + 1));
    t?.unref?.();
    this._keptTimer = t;
  }

  /** When a job's request first started, if it was put back after a restart as running (add()); else null. */
  _startedBefore(e) {
    return (e.group ? this.groups.get(e.group)?.startedBefore : e.startedBefore) ?? null;
  }

  /**
   * Where in `pending` a request put back after a restart as running goes
   * (add(), `startedBefore`): behind a retried film, which goes first of all
   * (see add()), and behind the other requests put back this way that had
   * started no later than it; ahead of everything else - the waiting line,
   * and the remaining jobs of requests that started in this process, which
   * started after it. The pick takes films and TV from there, as for any
   * running request (_nextEligibleIndex), so the interrupted requests start
   * again in the order they had started, before anything that was waiting
   * - which is where the restart found them.
   */
  _resumedSlot(since) {
    const at = this.pending.findIndex((e) => {
      if (!e.group && e.fair?.retry) return false;
      const s = this._startedBefore(e);
      return s == null || s > since;
    });
    return at < 0 ? this.pending.length : at;
  }

  /**
   * Every job in `pending`, in the order it will be picked: the waiting
   * requests in `order` (_items), and the rest of the running requests'
   * jobs where they stand. Each waiting request's jobs sit together in the
   * array (add() keeps a season in one piece), so the places they take up
   * are handed out again, one request at a time, in the fair order: a
   * running season's remaining episodes stay where they were, ahead of the
   * waiting line, as they do with the fair order off.
   */
  _inTurn(order) {
    const waitingKeys = new Set(order.map((it) => it.key));
    const seq = [];
    const met = new Set();
    let k = 0;
    for (const e of this.pending) {
      const key = e.group ?? e.id;
      if (!waitingKeys.has(key)) { seq.push(e); continue; }
      if (met.has(key)) continue;
      met.add(key);
      seq.push(...order[k++].pending);
    }
    return seq;
  }

  /**
   * Every request in the queue, each once: `running` in the order they
   * started, `waiting` in the order they WILL start.
   *
   * That order is what _nextEligibleIndex does, not the order of the array:
   * with strict movie priority every waiting movie starts before any TV,
   * whatever order they arrived in; without it, plain arrival order. A place
   * in line shown to anyone - a requester's number reaction, the panel's list
   * - is an index into this, so it is the real one. (Concurrency and the slot
   * kept for movies decide WHEN the next one starts, never which.)
   *
   * With the fair order on (see the class comment), the waiting line is
   * sorted by rank first - a stable sort, so equal ranks keep the order of
   * the array, which is arrival order and an admin's moves - and then split
   * into films and TV as above, with the films held behind the TV
   * (_holdEnd, keyed in `held`) after the TV.
   */
  _items() {
    const all = new Map();
    const touch = (e) => {
      const key = e.group ?? e.id;
      let it = all.get(key);
      if (!it) {
        it = { key, kind: e.kind ?? 'movie', group: e.group ? (this.groups.get(e.group) ?? null) : null, pending: [], active: [] };
        all.set(key, it);
      }
      return it;
    };
    for (const e of this.pending) touch(e).pending.push(e);
    for (const e of this.active.values()) touch(e).active.push(e);

    const running = [];
    const waiting = [];
    // A film put back as running after a restart (add(), startedBefore) is
    // running while it waits for a slot, as a season between two episodes
    // is: never in the waiting line, so never given a place number.
    const resumed = (it) => (it.group ? null : (it.active[0] ?? it.pending[0])?.startedBefore ?? null);
    for (const it of all.values()) {
      if (it.active.length || it.group?.startedAt || resumed(it) != null) running.push(it);
      else waiting.push(it);
    }
    const began = (it) => it.group?.startedAt ?? resumed(it) ?? it.active[0]?.startedAt ?? 0;
    running.sort((a, b) => began(a) - began(b));
    if (this.fairShare) return { all, running, ...this._fairOrder(waiting) };
    this._armHold(null);
    this._held = null;
    const order = this.strictMoviePriority
      ? [...waiting.filter((it) => !isTv(it)), ...waiting.filter(isTv)]
      : waiting;
    return { all, running, waiting: order, held: new Set() };
  }

  /** The waiting line in the fair order, and which films are held behind the TV (see _items). */
  _fairOrder(waiting) {
    const ranked = waiting.map((it) => ({ it, rank: this._rank(this._recOfItem(it)) }));
    ranked.sort((a, b) => a.rank - b.rank);
    const sorted = ranked.map((x) => x.it);
    const held = new Set();
    let next = null;
    const now = this._clock.now();
    for (const it of sorted) {
      const end = this._holdEnd(it);
      if (end == null || end <= now) continue;
      held.add(it.key);
      if (next == null || end < next) next = end;
    }
    this._noticeReleased(sorted, held);
    this._armHold(next);
    if (!this.strictMoviePriority) return { waiting: sorted, held };
    return {
      waiting: [
        ...sorted.filter((it) => !isTv(it) && !held.has(it.key)),
        ...sorted.filter(isTv),
        ...sorted.filter((it) => held.has(it.key)),
      ],
      held,
    };
  }

  /** How many requests are waiting to start - what maxLength limits. */
  waitingCount() {
    return this._items().waiting.length;
  }

  /** Requests running and waiting, for the dashboard, the digest and the logs. */
  requestCounts() {
    const { running, waiting } = this._items();
    return { active: running.length, waiting: waiting.length };
  }

  /** How many requests of each kind are waiting/running - for the UI and for logs. */
  counts() {
    const { running, waiting } = this._items();
    return { pending: tally(waiting), active: tally(running) };
  }

  _start(entry) {
    entry.state = 'running';
    entry.startedAt = Date.now();
    entry.abort = new AbortController();
    this.active.set(entry.id, entry);
    const g = entry.group ? this.groups.get(entry.group) : null;
    if (g && !g.startedAt) {
      g.startedAt = entry.startedAt;
      if (this.fairShare) this._keepRunningAhead(g.key);
    }

    // Concurrency is load-bearing here: two simultaneous jobs mean two
    // multi-gigabyte transfers and two ffmpeg encodes on a 909 MB box.
    // Log it so a breach is visible rather than silently thrashing.
    logger.info(`▶ start ${entry.label} (${this.active.size}/${this.concurrency} active, ${this.pending.length} waiting)`);
    if (this.active.size > this.concurrency) {
      logger.error(`concurrency breached: ${this.active.size} jobs running with a limit of ${this.concurrency}`);
    }
    this.emit('updated', this.publicView(entry));

    const ctx = {
      id: entry.id,
      signal: entry.abort.signal,
      isCancelled: () => entry.cancelled,
      cancelReason: () => entry.cancelReason ?? null,
      /**
       * `info` may be a plain string or a structured object carrying stage,
       * transfer rate and ETA. Keeping the structure lets the UI render a
       * real progress panel rather than re-parsing a sentence.
       */
      progress: (info, pct) => {
        const o = typeof info === 'string' ? { text: info } : (info ?? {});
        entry.progress = {
          ...o,
          text: o.text ?? '',
          stage: o.stage ?? entry.progress?.stage ?? null,
          pct: pct ?? o.pct ?? null,
          at: Date.now(),
        };
        this.emit('progress', this.publicView(entry));
      },
    };

    Promise.resolve()
      .then(() => entry.run(ctx))
      .then((result) => {
        entry.state = entry.cancelled ? 'cancelled' : 'done';
        entry.result = result;
      })
      .catch((err) => {
        entry.state = entry.cancelled ? 'cancelled' : 'failed';
        entry.error = err?.message ?? String(err);
        logger.error(`job ${entry.label} failed: ${entry.error}`);
      })
      .finally(() => {
        entry.finishedAt = Date.now();
        this.active.delete(entry.id);
        if (g) {
          if (entry.state === 'done') g.done += 1;
          else if (entry.state === 'failed') g.failed += 1;
          else g.cancelled += 1;
        }
        const secs = Math.round((entry.finishedAt - entry.startedAt) / 1000);
        logger.info(`■ end   ${entry.label} → ${entry.state} after ${secs}s (${this.active.size} still active)`);
        this._archive(entry);
        this._retire(entry.group);
        this.emit('updated', this.publicView(entry));
        this._drain();
      });
  }

  _archive(entry) {
    this.history.unshift(this.publicView(entry));
    if (this.history.length > 100) this.history.pop();
  }

  /**
   * Running jobs can be waiting too: for the one download, encoder or upload
   * slot the stages share (src/media/stages.js). `hooks` answers where a job
   * stands in that line and moves it up; src/index.js installs it, so this
   * file does not have to know about the stages.
   */
  setStageWaits(hooks) { this.stageWaits = hooks; }

  /** The running jobs of a job id or request key. */
  _runningJobs(id) {
    if (this.active.has(id)) return [this.active.get(id)];
    const key = this._groupKey(id);
    return key ? [...this.active.values()].filter((e) => e.group === key) : [];
  }

  /**
   * Is this job, or this request, running? A request is from its first
   * episode's start to its last one's end, gaps included - see the class
   * comment.
   */
  isRunning(id) {
    if (this.active.has(id)) return true;
    const g = this.groups.get(this._groupKey(id));
    return !!g && (!!g.startedAt || this._runningJobs(id).length > 0);
  }

  /**
   * Where a running job - or the best-placed of a request's running episodes
   * - stands in line for a stage slot. Null when none is waiting.
   */
  stageLine(id) {
    if (!this.stageWaits) return null;
    let best = null;
    for (const e of this._runningJobs(id)) {
      const w = this.stageWaits.where(e.id);
      if (w && (!best || w.position < best.position)) best = w;
    }
    return best;
  }

  /**
   * Move a RUNNING job up the line for the stage slot it is waiting on -
   * 'up' one place, or 'top' to be next. move() and moveTop() are for jobs
   * that have not started. The job holding the slot is never interrupted.
   *
   * Given a request, every episode of it that is in a line moves, keeping
   * their order: promoted one at a time, the last would otherwise overtake
   * the first.
   */
  moveRunning(id, dir = 'top') {
    if (!this.stageWaits) return false;
    const d = dir === 'up' ? 'up' : 'top';
    const inLine = this._runningJobs(id)
      .map((e) => ({ e, w: this.stageWaits.where(e.id) }))
      .filter((x) => x.w)
      .sort((a, b) => (d === 'top' ? b.w.position - a.w.position : a.w.position - b.w.position));
    let ok = false;
    for (const { e } of inLine) ok = !!this.stageWaits.promote(e.id, d) || ok;
    if (ok) this.emit('state', this.snapshot());
    return ok;
  }

  publicView(e) {
    const waiting = e.state === 'running' && this.stageWaits ? this.stageWaits.where(e.id) : null;
    return {
      id: e.id,
      label: e.label,
      kind: e.kind ?? 'movie',
      meta: e.meta,
      state: e.state,
      progress: e.progress,
      addedAt: e.addedAt,
      startedAt: e.startedAt,
      finishedAt: e.finishedAt,
      error: e.error,
      ...(e.group ? { group: e.group, groupLabel: e.groupLabel ?? null } : {}),
      ...(waiting ? { waiting } : {}),
    };
  }

  _jobCounts(g, it) {
    return {
      total: g.total, done: g.done, failed: g.failed, cancelled: g.cancelled,
      running: it?.active.length ?? 0, waiting: it?.pending.length ?? 0,
    };
  }

  /**
   * One request as the panel shows it. A single job looks exactly as it
   * always has. A request of several is one row: its own id and title, the
   * progress of the episode in hand (`current` has each running one, with the
   * job id that Skip takes), how far through it is, and `line`, its best place
   * in a stage line. `group` is the caller's key for it, as on each of its
   * jobs; `id` is what the panel acts on.
   */
  _itemView(it) {
    if (!it.group) {
      const e = it.active[0] ?? it.pending[0];
      const view = this.publicView(e);
      // A film put back as running after a restart, with no slot yet: on the
      // panel's running list, which would otherwise say "starting…" of a film
      // that is not.
      if (!it.active.length && e.startedBefore != null && !view.progress) {
        view.progress = { stage: 'wait', text: 'picked back up after a restart - it starts before anything waiting', pct: null };
      }
      return view;
    }
    const g = it.group;
    const views = it.active.map((e) => this.publicView(e));
    // The one to show: the episode doing something, before one in line for a
    // slot, before one further back in a line; among equals, the first to start.
    views.sort((a, b) => (a.waiting ? 1 : 0) - (b.waiting ? 1 : 0)
      || (a.waiting && b.waiting ? a.waiting.position - b.waiting.position : 0)
      || (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const lead = views[0] ?? null;
    // Where the best-placed of its episodes stands in a stage line - what
    // stageLine() answers and moveRunning() moves - even while another
    // episode is working. That is a season's usual state with two TV slots,
    // E1 converting while E2 waits for the encoder, and read from the lead
    // alone the card would offer no ▲/⤒ just when E2 needs moving up.
    const inLine = views.filter((v) => v.waiting)
      .sort((a, b) => a.waiting.position - b.waiting.position)[0] ?? null;
    return {
      id: g.id,
      group: g.key,
      label: g.label,
      kind: g.kind,
      meta: g.meta ?? {},
      state: it.active.length || g.startedAt ? 'running' : 'pending',
      progress: lead?.progress ?? null,
      addedAt: g.addedAt,
      startedAt: lead?.startedAt ?? g.startedAt,
      finishedAt: null,
      error: null,
      ...(lead?.waiting ? { waiting: lead.waiting } : {}),
      ...(inLine ? { line: { ...inLine.waiting, label: inLine.label } } : {}),
      jobs: this._jobCounts(g, it),
      current: views,
      next: it.pending[0]?.label ?? null,
    };
  }

  /**
   * What the panel shows of a waiting request's place in the fair order: that
   * it is an extra one (its member had another in the queue when it was
   * asked for, or asked for it inside their cooldown), and until when a held
   * film waits behind the TV. Nothing for
   * a first request, or with the fair order off.
   */
  _fairView(it, held) {
    if (!this.fairShare) return {};
    const rec = this._recOfItem(it);
    const rank = this._baseRank(rec);
    if (rank < 2) return {};
    return { fair: { extra: true, rank, ...(held.has(it.key) ? { heldUntil: this._holdEnd(it) } : {}) } };
  }

  snapshot() {
    const { running, waiting, held } = this._items();
    return {
      paused: this.paused,
      concurrency: this.concurrency,
      strictMoviePriority: this.strictMoviePriority,
      fairShare: this.fairShare,
      maxLength: this.maxLength,
      counts: { pending: tally(waiting), active: tally(running), retrying: this.retrying.size },
      active: running.map((it) => this._itemView(it)),
      pending: waiting.map((it, i) => ({ ...this._itemView(it), place: i + 1, ...this._fairView(it, held) })),
      retrying: [...this.retrying.values()].map((r) => this._retryView(r)),
      history: this.history.slice(0, 25),
    };
  }
}
