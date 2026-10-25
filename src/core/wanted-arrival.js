/**
 * A wanted film the bot finds on the server, re-run for the members who were
 * told "not in the library".
 *
 * The operator, 2026-10-11, of what they do when a request comes back not in
 * the library: they ask the Jellyfin host for the film, and once it is
 * available the bot is to put it in the queue and react on the member's
 * message. Agreed with the operator the same day: what says it is available
 * is the bot's own library. The wanted recheck (wanted-recheck.js, every 30
 * minutes) looks every open film on the wanted list up as a request would -
 * by its IMDb id across a year gap too - and an entry it finds there it marks
 * resolved and arrived (markFound, noteArrival); the pass that runs after
 * each recheck (src/index.js) re-runs that film's requests. Nothing here
 * depends on Discord: the first cut started from the host's request bot's
 * post, read by the Discord reader, so a film the recheck found without one
 * was only marked resolved, and a box without the operator's Discord account
 * connected re-ran nothing.
 *
 * Both of the real cases of 2026-10-11 went wrong without it:
 *  - "My Suicide" (2009), asked for by Noah Fields on 2026-09-14: on the
 *    server from 03:17 UTC on 2026-10-09, marked resolved by the wanted
 *    recheck at 08:57 on 2026-10-11, and nothing queued for him.
 *  - "A Snapshot of Forever", asked for by Mia on 2026-10-08 as "a
 *    snapshot of forever 2025": on the server from 03:14 UTC on 2026-10-11,
 *    and refused by the 12:40 recheck because OMDb files it under 2025 and
 *    the server under 2022 - the same IMDb id, tt14074586 (fixed in
 *    findInLibrary, yearRuleYields, and the recheck's notTheFilm, within
 *    three years: a 1990 copy tagged with a 2012 film's id is not that film).
 *
 * What a pass does with each entry the recheck has marked arrived:
 *  1. If its resolution has been undone since - an admin reopened it, or a
 *     request asked for it again and did not find it - nothing: settled
 *     'reopened'. With `wanted.rerunOnArrival` off (on by default, on the
 *     Wanted card), nothing either: settled 'switched off', the film only
 *     marked resolved, as before.
 *  2. Every request that was answered "not in the library", "not found" or
 *     "still in cinemas" for that film in the last 60 days is run again AS
 *     THAT REQUEST (rerunCandidates): the movie plugin's own pipeline
 *     (rerunArrived), on the member's original message rebuilt from its
 *     History row and the msg-index - the rating gate, the AI check, the
 *     duplicate check, the queue, the route it had, and the reactions on
 *     what they sent. A member asked twice is answered once, on the later
 *     message; a member who has had the film queued or sent since is
 *     skipped; one whose film has been POSTED since, with another member's
 *     request, is not queued again but answered as a follower of that
 *     request is - the done reaction on their message (postedSince,
 *     answerArrivedPosted); and nothing is re-run twice, ever: a ledger
 *     keyed by the History row's id (LEDGER_KEY) is written before each one
 *     is handed over. One at a time, each after _bulkPace (CLAUDE.md rule 1),
 *     so a morning on which several films arrive is paced, never a burst; and
 *     not while WhatsApp is down, requests are paused or the groups are
 *     locked for Shabbos - the arrival waits for the pass after the next
 *     recheck, and each member a stopped batch left is recorded as waiting.
 *
 * Each re-run is said in the log, in an audit row, in its History row (as
 * a re-run: "it arrived on the server"), and on its wanted entry (`reruns`),
 * from which the hourly check's report says who was queued and who still
 * needs telling (incident-scan.js).
 *
 * Not on deploy: an entry resolved before re-runs began on this box is
 * never re-run by itself - the eight the recheck resolved on the morning of
 * 2026-10-11 among them. "Before" is recorded, not worked out from times:
 * re-runs begin (begin(), beginArrivals in wanted.js) by marking every
 * entry resolved at that moment as handled - src/index.js does it at start,
 * before the recheck's first run, and every pass and the recheck's first
 * find do it too if it has not been done, so whichever comes first draws
 * the line. An admin re-runs those with
 * "Re-run requests" on its card (POST /api/wanted/:key/rerun, rerun()
 * below), which holds to the same rules. An admin's re-run is kept on its
 * entry (`rerunPending`) until every request has been handed over, so one
 * stopped part-way is finished by the next pass, as an arrival is.
 *
 * Only the recheck's finds start a re-run by themselves. A film a member's
 * new request finds first is resolved by that request (the movie plugin's
 * answerArrived), and the members refused earlier are re-run from its card.
 */
import log from '../util/logger.js';
import {
  findWanted, settleArrival, recordRerun, markRerunPending, clearRerunPending, beginArrivals, describeArrivalsBegan, BOT,
} from './wanted.js';
import { NAMESPACE } from './wanted-recheck.js';
import { normImdb } from '../plugins/movie-requests/library.js';
import { normalizeTitle, cleanRequestText, yearsApart } from '../util/fuzzy.js';
import { isBetaGroup } from './beta.js';
import { formatPhone, phoneOut } from './members.js';

const logger = log.scope('wanted');

const DAY = 86_400_000;
/** Where the ledger of re-runs lives, in the movie plugin's store: { [History row id]: { at, key, ... } }. */
export const LEDGER_KEY = 'arrival-reruns';
/** A request older than this is not re-run: the member has moved on, and may not remember asking. */
export const MAX_ROW_AGE_MS = 60 * DAY;
/** A ledger row is kept this long after its re-run: longer than any History row can be re-run for. */
export const LEDGER_KEEP_MS = 120 * DAY;
/** What a re-run is for: the answers that said the film was not there. */
export const RERUNNABLE = Object.freeze(['not-in-library', 'not-found', 'not-yet-theatrical']);
/** A member with a later row like this for the film has had it, or has it coming. */
export const HAD_IT = Object.freeze(['queued', 'working', 'sent', 'duplicate']);
/**
 * What a re-run came to when the film had been posted since, with another
 * member's request: not queued again, the member's message marked done
 * (answerArrivedPosted in the movie plugin).
 */
export const ALREADY_POSTED = 'already-posted';
/** What a re-run came to that means the film is on its way to the member, or there already. */
export const ON_ITS_WAY = Object.freeze(['queued', 'working', 'sent', 'duplicate', ALREADY_POSTED]);
/** What is recorded for a member whose re-run a stopped batch left for the next pass. */
export const WAITING = 'waiting';
/** The skip that means the member needs nothing more. */
export const HAD_IT_WHY = 'had it queued or sent since';
/** The trigger of a re-run the recheck's find started, as History, the ledger and the entry keep it. */
export const ARRIVAL = 'arrival';
const PLUGIN = 'movie-requests';

const label = (w) => `${w?.title ?? '?'}${w?.year ? ` (${w.year})` : ''}`;
const norm = (t) => normalizeTitle(String(t ?? ''));

/** The names an entry goes by: its own title, the library's for the copy it was resolved with, and what was typed. */
function namesOf(w) {
  return [w.title, w.resolved?.as?.title, ...(Array.isArray(w.requests) ? w.requests : []).map((t) => cleanRequestText(t))]
    .filter(Boolean).map(norm).filter(Boolean);
}

/**
 * Is the resolution an arrival was recorded with still the entry's? The
 * recheck stamps both with one time (markFound). Reopened by an admin, or
 * opened by a request that asked again and did not find it, the entry has
 * none, or another; and an admin's "Mark resolved" says nothing about the
 * server.
 */
export function arrivalStands(w) {
  return !!w?.arrival && !!w.resolved?.auto && Number(w.resolved.at) === Number(w.arrival.at);
}

/* ------------------------------ the requests ------------------------------ */

/** Who a History row is from: their number when known, else their jid. */
const memberOf = (r) => String(r?.requesterNumber ?? '').replace(/\D/g, '') || r?.requesterJid || null;
const askedAt = (r) => Number(r?.requestedAt) || Number(r?.at) || 0;

/**
 * Is this History row about the entry's film? By IMDb id when the row has
 * one (rows kept it from 2026-10-11); else by title and year - OMDb's title,
 * as the entry has it, or the library copy's; and for a "not found" row,
 * which has no title (OMDb did not know the words), by what was typed, as a
 * whole, against the entry's names.
 */
export function rowIsFilm(r, w) {
  if (!r || !w) return false;
  const want = normImdb(w.imdbId);
  const got = normImdb(r.imdbId);
  if (want && got) return want === got;
  const as = w.resolved?.as ?? null;
  if (as?.id && r.request === `jellyfin:${as.id}`) return true;
  const t = norm(r.title);
  if (t) {
    if (t === norm(w.title) && !yearsApart(r.year, w.year)) return true;
    return !!as?.title && t === norm(as.title) && !yearsApart(r.year, as.year);
  }
  const typed = norm(cleanRequestText(r.typed ?? r.request ?? ''));
  return !!typed && namesOf(w).includes(typed);
}

/**
 * Which History rows to re-run for entry `w`, and which not, and why:
 * { run: [row], skip: [{ row, why }], posted: [{ row, sent }] }. `run` is
 * oldest first - the member who has waited longest goes first. `posted` are
 * the requests whose film has been posted since with another member's
 * request (`sent`, its row): they are answered, not re-run (postedSince).
 * Rows already re-run (in `ledger`) are none of these. See the header for
 * the rules.
 */
export function rerunCandidates(history, w, {
  ledger = {}, now = Date.now(), requestGroups = null, isBeta = () => false,
} = {}) {
  const rows = (Array.isArray(history) ? history : []).filter((r) => r && typeof r === 'object');
  const asked = rows.filter((r) => RERUNNABLE.includes(r.status) && rowIsFilm(r, w))
    .sort((a, b) => askedAt(b) - askedAt(a));
  // A member any of whose requests for this film has been re-run already is
  // answered: their earlier ones are not run after it, at the next pass.
  const answered = new Set(rows.filter((r) => ledger[r.id] && rowIsFilm(r, w)).map(memberOf).filter(Boolean));
  // And from the ledger itself, for a row History has since dropped (it keeps 200).
  for (const l of Object.values(ledger)) if (l?.key === w.key && l.member) answered.add(l.member);
  const run = [];
  const skip = [];
  const posted = [];
  // What was decided for each member's latest request: 'run', or why not.
  // Their earlier requests for the film go with it, and say so.
  const decided = new Map();
  for (const r of asked) {
    if (ledger[r.id]) continue;
    // A beta test is never a member waiting for a film, and a test's row
    // never put anything on the wanted list.
    if (r.beta || r.route || r.test) continue;
    const who = memberOf(r);
    if (!r.id || !r.groupJid || !who || /^(manual|panel)-/.test(String(r.id))) {
      skip.push({ row: r, why: 'no WhatsApp message to answer' });
      continue;
    }
    if (answered.has(who)) {
      skip.push({ row: r, why: 'their request for it was re-run already' });
      continue;
    }
    if (decided.has(who)) {
      const first = decided.get(who);
      skip.push({ row: r, why: first === 'run' ? 'their later request for it is the one re-run' : first });
      continue;
    }
    const why = whyNot(r, rows, w, { who, now, requestGroups, isBeta });
    decided.set(who, why ?? 'run');
    if (why) {
      skip.push({ row: r, why });
      continue;
    }
    const sent = postedSince(r, rows, w);
    if (sent) posted.push({ row: r, sent });
    else run.push(r);
  }
  return { run: run.reverse(), skip, posted: posted.reverse() };
}

/**
 * The request with which the film was posted since member's request `r`
 * was refused, by anyone, or null: its History row, 'sent' since then, to
 * the posts group every main group delivers to (a beta or test row went
 * elsewhere). Re-running `r` would post the film there a second time with
 * nobody asking again - review reproduced it (2026-10-11) with Hannah's "a
 * snapshot of forever 2022" sent at 10:00 and Mia's older "not in the
 * library" re-run after it. A re-run can wait hours for WhatsApp, a pause
 * or the Shabbos lockdown, and an admin's for days, and members ask for a
 * film that has just arrived. One still WAITING to be posted is not this:
 * the pipeline's twin check (_filmWaiting) answers that one as a duplicate
 * and has the member told when it is posted.
 */
export function postedSince(r, rows, w) {
  const since = askedAt(r);
  const at = (x) => Number(x?.finishedAt) || Number(x?.at) || 0;
  const sent = (Array.isArray(rows) ? rows : []).filter((x) => x && x !== r && x.status === 'sent'
    && !x.beta && !x.route && !x.test && at(x) > since && rowIsFilm(x, w));
  sent.sort((a, b) => at(b) - at(a));
  return sent[0] ?? null;
}

/** Why a member's latest request for the film is not re-run, or null when it is. */
function whyNot(r, rows, w, { who, now, requestGroups, isBeta }) {
  if (now - askedAt(r) > MAX_ROW_AGE_MS) return `asked more than ${Math.round(MAX_ROW_AGE_MS / DAY)} days ago`;
  const since = askedAt(r);
  const had = rows.some((x) => x !== r && memberOf(x) === who && HAD_IT.includes(x.status)
    && (Number(x.at) || 0) > since && rowIsFilm(x, w));
  if (had) return HAD_IT_WHY;
  if (Array.isArray(requestGroups) && !requestGroups.includes(r.groupJid)) return 'its group no longer takes requests';
  if (isBeta(r.groupJid)) return 'its group is a beta group now';
  return null;
}

/**
 * The member's original message, rebuilt from its History row, in the shape
 * request-pause.js journals a held one (slimMessage), so the plugin runs it
 * as it runs a held request (heldMessage). The key is what a reaction lands
 * on: the group, the message id, and the sender's participant id - from the
 * msg-index while it still has the message (two days), else the row's
 * requesterJid, which is the same key.participant (bot.js normalize).
 */
export function messageFor(row, { indexed = null, prefix = '' } = {}) {
  const typed = row.typed ?? row.request ?? '';
  const participant = indexed?.p ?? row.requesterJid ?? null;
  return {
    id: row.id,
    key: { remoteJid: row.groupJid, fromMe: false, id: row.id, ...(participant ? { participant } : {}) },
    chatJid: row.groupJid, isGroup: true, fromMe: false,
    senderJid: participant, senderNumber: row.requesterNumber ?? null,
    senderNumberDisplay: row.requesterNumberDisplay ?? null, pushName: row.requester ?? null,
    timestamp: Number(row.requestedAt) || Number(indexed?.t) || null,
    messageType: indexed?.y ?? 'conversation',
    text: `${prefix ? `${prefix} ` : ''}${typed}`.trim(),
  };
}

/* ------------------------------ the runner ------------------------------ */

export class ArrivalReruns {
  /**
   * @param bot            _bulkPace, isConnected
   * @param pluginManager  the movie plugin, whose rerunArrived runs a request
   * @param requestPause   re-runs wait while requests are paused
   * @param isLocked       re-runs wait while the groups are locked (Shabbos)
   * @param now            the clock; for tests
   */
  constructor({
    configStore, stateStore, bot = null, pluginManager = null, requestPause = null, isLocked = () => false,
    now = Date.now, log: lg = logger,
  }) {
    this.configStore = configStore;
    this.stateStore = stateStore;
    this.bot = bot;
    this.pluginManager = pluginManager;
    this.requestPause = requestPause;
    this.isLocked = isLocked;
    this.now = now;
    this.log = lg;
    this._chain = Promise.resolve();
  }

  store() { return this.stateStore.namespace(NAMESPACE); }

  /** One thing at a time: a pass, or an admin's re-run. Never rejects. */
  _serial(fn) {
    const p = this._chain.then(fn, fn).catch((err) => {
      this.log.error(`arrival re-runs: ${err.message}`);
      return { error: err.message };
    });
    this._chain = p;
    return p;
  }

  /**
   * Record that re-runs begin on this box, if they had not (beginArrivals,
   * wanted.js): what is resolved now is never re-run by itself. src/index.js
   * calls it at start, before the recheck can resolve anything; every pass
   * calls it too. Returns { at, handled, fresh }.
   */
  begin() {
    const b = beginArrivals(this.store(), { now: this.now() });
    if (b.fresh) this.log.info(describeArrivalsBegan(b));
    return b;
  }

  _ledger(store) {
    const l = store.get(LEDGER_KEY, {});
    return l && typeof l === 'object' && !Array.isArray(l) ? { ...l } : {};
  }

  _saveLedger(store, ledger) {
    const cutoff = this.now() - LEDGER_KEEP_MS;
    for (const [id, l] of Object.entries(ledger)) if (!(Number(l?.at) >= cutoff)) delete ledger[id];
    store.set(LEDGER_KEY, ledger);
    // On the disk before the request is handed over: a restart in the
    // store's debounce must not forget that it was re-run (never twice).
    try { store.flush?.(); } catch { /* the next save writes it */ }
  }

  /** Why no re-run can start now, or null: said to an admin, and the reason a pass leaves the rest for later. */
  cannotRunNow() {
    const entry = this.pluginManager?.plugins?.get?.(PLUGIN);
    if (!entry?.plugin?.rerunArrived) return 'the movie requests plugin is not loaded';
    if (this.bot?.isConnected?.() === false) return 'WhatsApp is not connected';
    if (this.requestPause?.isPaused?.()) return 'requests are paused';
    let locked = false;
    try { locked = !!this.isLocked(); } catch { locked = false; }
    if (locked) return 'the groups are locked (lockdown)';
    return null;
  }

  /**
   * Re-run the requests for every film the wanted recheck has found since
   * the last pass, and finish what a pass or an admin left part-way. Run
   * after each run of the recheck (src/index.js). Resolves to what it did:
   * { why, reran, waiting, settled }; never rejects.
   */
  process(why = 'on demand') {
    return this._serial(() => this._process(why));
  }

  async _process(why) {
    const out = { why, reran: [], waiting: [], settled: [] };
    const cfg = this.configStore.get() ?? {};
    const store = this.store();
    this.begin();
    for (const w of (store.get('wanted', []) ?? []).filter((x) => x?.arrival && !x.arrival.settled)) {
      await this._settle(store, cfg, w, out);
    }
    // An admin's "Re-run requests" that stopped part-way (rerun, below).
    for (const w of (store.get('wanted', []) ?? []).filter((x) => x?.rerunPending)) {
      await this._resumeManual(store, cfg, w, out);
    }
    return out;
  }

  /** A film the recheck found: its requests re-run, and the arrival settled - or left for the next pass. */
  async _settle(store, cfg, entry, out) {
    const w = findWanted(store, entry.key);
    if (!w?.arrival || w.arrival.settled) return;
    if (!arrivalStands(w)) {
      settleArrival(store, w.key, {
        outcome: 'reopened', now: this.now(),
        detail: 'open again, or resolved otherwise, before its requests were re-run - the server may not have it after all',
      });
      this.log.info(`arrival: ${label(w)} was ${w.resolved ? 'resolved again by an admin' : 'opened again'} before its requests were `
        + 're-run - nothing is re-run for it');
      out.settled.push({ key: w.key, outcome: 'reopened' });
      return;
    }
    if (cfg.wanted?.rerunOnArrival === false) {
      settleArrival(store, w.key, { outcome: 'switched off', now: this.now(), detail: 'wanted.rerunOnArrival is off: the film is only marked resolved' });
      out.settled.push({ key: w.key, outcome: 'switched off' });
      return;
    }
    const why = this.cannotRunNow();
    if (why) {
      this.log.info(`arrival: ${label(w)} is on the server; its requests are re-run after the next recheck - ${why}`);
      out.waiting.push({ key: w.key, title: w.title, why });
      return;
    }
    const r = await this._rerunEntry(store, cfg, w, { trigger: ARRIVAL, by: BOT });
    out.reran.push(...r.results);
    if (r.stopped) return;      // the rest go at the next pass
    settleArrival(store, w.key, {
      outcome: 're-run', now: this.now(),
      detail: `${r.results.filter((x) => x.ran).length} re-run, ${r.results.filter((x) => !x.ran).length} not`,
    });
    out.settled.push({ key: w.key, outcome: 're-run' });
  }

  /** What would be re-run for an entry, now: { entry, run, skip, posted } (rerunCandidates). */
  plan(key) {
    const store = this.store();
    const w = findWanted(store, key);
    if (!w) return { entry: null, run: [], skip: [], posted: [] };
    const cfg = this.configStore.get() ?? {};
    return {
      entry: w,
      ...rerunCandidates(store.get('history', []), w, {
        ledger: this._ledger(store), now: this.now(),
        requestGroups: cfg.movieRequests?.requestGroups ?? null,
        isBeta: (jid) => isBetaGroup(cfg, jid),
      }),
    };
  }

  /**
   * An admin's "Re-run requests" on a resolved entry (POST
   * /api/wanted/:key/rerun): the same candidates, ledger and pacing as an
   * arrival. Resolves when every one has been handed over, or the batch
   * stopped; the route does not wait for it. Kept on the entry
   * (`rerunPending`) until every request has been handed over, so a batch
   * stopped part-way is finished by the next pass (_resumeManual) rather
   * than dropped: the first cut dropped the rest, logged "the rest go at
   * the next pass" though nothing would run them, and left the hourly
   * report saying a member had no request left in History (review,
   * 2026-10-11).
   */
  rerun(key, { by = 'an admin' } = {}) {
    return this._serial(async () => {
      const store = this.store();
      const w = findWanted(store, key);
      if (!w) return { results: [], stopped: false };
      markRerunPending(store, w.key, { by, at: this.now() });
      return this._manual(store, this.configStore.get() ?? {}, findWanted(store, w.key) ?? w, by);
    });
  }

  /** An admin's re-run, run (again): the pending mark is cleared only once nothing was left. */
  async _manual(store, cfg, w, by) {
    const r = await this._rerunEntry(store, cfg, w, { trigger: 'manual', by });
    if (r.stopped) return r;
    clearRerunPending(store, w.key);
    // An arrival this answers is settled by it.
    const cur = findWanted(store, w.key) ?? w;
    if (cur.arrival && !cur.arrival.settled) {
      settleArrival(store, w.key, { outcome: 're-run', now: this.now(), detail: `re-run by hand by ${by}` });
    }
    return r;
  }

  /**
   * An admin's re-run that a pass finds still pending: finished now, when
   * it can run. Not when the entry was reopened meanwhile - the admin who
   * reopened it says the server does not have the film - and whatever
   * wanted.rerunOnArrival says, since an admin asked for this one.
   */
  async _resumeManual(store, cfg, w, out) {
    const by = w.rerunPending?.by ?? 'an admin';
    if (!w.resolved) {
      clearRerunPending(store, w.key);
      this.log.info(`re-runs for ${label(w)}: ${by}'s re-run is dropped - the film was reopened on the wanted list meanwhile`);
      return;
    }
    const why = this.cannotRunNow();
    if (why) {
      out.waiting.push({ key: w.key, title: w.title, why, manual: true });
      return;
    }
    this.log.info(`re-runs for ${label(w)}: finishing ${by}'s re-run, stopped part-way earlier`);
    const r = await this._manual(store, cfg, w, by);
    out.reran.push(...r.results);
  }

  /**
   * Re-run the requests for one entry, paced, one at a time. Resolves to
   * { results: [{ rowId, requester, ran, outcome, why, queued }], stopped }:
   * `stopped` when WhatsApp went, requests were paused or the groups locked
   * part-way, and the rest wait for the next pass.
   */
  async _rerunEntry(store, cfg, w, { trigger, by }) {
    const entry = this.pluginManager?.plugins?.get?.(PLUGIN);
    const ledger = this._ledger(store);
    const { run, skip, posted } = rerunCandidates(store.get('history', []), w, {
      ledger, now: this.now(), requestGroups: cfg.movieRequests?.requestGroups ?? null,
      isBeta: (jid) => isBetaGroup(cfg, jid),
    });
    const results = [];
    const numberOf = (row) => phoneOut(row.requesterNumberDisplay ?? row.requesterNumber ?? null);
    for (const s of skip) {
      const res = { rowId: s.row.id ?? null, requester: s.row.requester ?? null, number: numberOf(s.row),
        ran: false, outcome: 'skipped', why: s.why };
      results.push(res);
      recordRerun(store, w.key, { at: this.now(), ...res, trigger, by });
    }
    if (skip.length) {
      this.log.info(`re-runs for ${label(w)}: not re-run - ${skip.map((s) => `${who(s.row)} (${s.why})`).join('; ')}`);
    }
    // The member who has waited longest goes first, re-run or answered.
    const todo = [...run.map((row) => ({ row, sent: null })), ...posted.map((p) => ({ row: p.row, sent: p.sent }))]
      .sort((a, b) => askedAt(a.row) - askedAt(b.row));
    if (!todo.length) {
      if (!skip.length) this.log.info(`re-runs for ${label(w)}: no request answered "not in the library" for it to re-run`);
      return { results, stopped: false };
    }
    const prefix = cfg.movieRequests?.requirePrefix ? String(cfg.movieRequests.prefix ?? '').trim() : '';
    const index = this.stateStore.namespace('msg-index').get('entries', []) ?? [];
    let stopped = false;
    for (let i = 0; i < todo.length; i += 1) {
      const { row, sent } = todo[i];
      let why = this.cannotRunNow();
      if (!why) {
        // CLAUDE.md rule 1: every re-run reacts, and may post a line, so
        // each waits its turn - a morning of several films is paced, not a
        // burst. So does a member answered that the film is posted already.
        await this.bot?._bulkPace?.();
        why = this.cannotRunNow();
      }
      if (why) {
        this._stopped(store, w, todo.slice(i).map((t) => t.row), why, { trigger, by, numberOf });
        stopped = true;
        break;
      }
      const member = memberOf(row);
      const was = { status: row.status, detail: row.detail ?? null, at: Number(row.at) || null };
      // In the ledger before it is handed over: a crash part-way through
      // leaves it re-run once, never twice.
      ledger[row.id] = { at: this.now(), key: w.key, title: w.title, member, requester: row.requester ?? null, trigger, by, outcome: 'started' };
      this._saveLedger(store, ledger);
      const indexed = index.find((e) => e?.i === row.id && e?.g === row.groupJid) ?? null;
      const item = {
        msg: messageFor(row, { indexed, prefix }), text: row.request, typed: row.typed ?? null,
        rerun: { trigger, by, was },
      };
      let res;
      try {
        res = sent
          ? await entry.plugin.answerArrivedPosted({
            ...item, posted: { id: sent.id ?? null, requester: sent.requester ?? null, at: Number(sent.finishedAt) || Number(sent.at) || null },
          }, entry.ctx)
          : await entry.plugin.rerunArrived(item, entry.ctx);
      } catch (err) {
        res = { status: 'error', detail: err.message, queued: false };
        this.log.error(`re-run of ${who(row)}'s "${row.typed ?? row.request}" failed: ${err.message}`);
        // The pipeline reacts on every answer it gives; one that threw gave
        // none, so the member's message says it, as a held request that
        // cannot run does (request-pause.js).
        try { await this.bot?.react?.(item.msg, cfg.movieRequests?.reactions?.failed ?? '⚠️', { kind: 'critical' }); }
        catch (e) { this.log.warn(`could not react to the failed re-run: ${e.message}`); }
      }
      const outcome = res.posted ? ALREADY_POSTED : res.status;
      ledger[row.id] = { ...ledger[row.id], outcome, detail: res.detail ?? null };
      this._saveLedger(store, ledger);
      const result = {
        rowId: row.id, requester: row.requester ?? null, number: numberOf(row),
        ran: true, outcome, detail: res.detail ?? null, queued: !!res.queued,
      };
      results.push(result);
      recordRerun(store, w.key, { at: this.now(), ...result, trigger, by });
      const said = `re-ran ${who(row)}'s request "${row.typed ?? row.request}" - ${label(w)} arrived on the server`
        + `${trigger === 'manual' ? ` (by hand, ${by})` : ''}: ${outcome}${res.detail ? ` (${res.detail})` : ''}`;
      this.log.info(said);
      this._audit(trigger, by, `re-ran ${who(row)}'s request "${String(row.typed ?? row.request ?? '').slice(0, 120)}" - ${label(w)} arrived on the server`,
        `${outcome}${res.detail ? `: ${res.detail}` : ''}${trigger === ARRIVAL ? ' (the wanted recheck found it on the server)' : ''}`);
    }
    return { results, stopped };
  }

  /**
   * A batch stopped part-way: each member it did not reach is recorded on
   * the entry as waiting, with why, and the log and the audit log name them
   * - for an arrival and an admin's re-run alike, each of which the next
   * pass finishes (the unsettled `arrival`, the `rerunPending` mark).
   */
  _stopped(store, w, rows, why, { trigger, by, numberOf }) {
    const at = this.now();
    for (const row of rows) {
      recordRerun(store, w.key, {
        at, rowId: row.id ?? null, requester: row.requester ?? null, number: numberOf(row),
        ran: false, outcome: WAITING, why: `stopped: ${why} - re-run at the next pass`, trigger, by,
      });
    }
    const names = rows.map(who).join(', ');
    this.log.info(`re-runs for ${label(w)}: stopped - ${why}; ${names} wait${rows.length === 1 ? 's' : ''} for the next pass`);
    this._audit(trigger, by, `stopped re-running the requests for ${label(w)} - ${why}`,
      `${rows.length} left for the next pass: ${names}`.slice(0, 500));
  }

  /** An audit row for a re-run: the admin's for one by hand, the bot's for an arrival. Never throws. */
  _audit(trigger, by, action, detail) {
    try {
      this.stateStore.namespace('audit').push('events', {
        ts: this.now(), user: trigger === 'manual' ? by : 'arrival re-run', role: trigger === 'manual' ? 'admin' : 'system', ip: 'local',
        action, detail,
      }, 2000);
    } catch { /* the audit log must never stop a re-run */ }
  }
}

/** A member as the log says them: their name and number. */
function who(r) {
  const name = String(r?.requester ?? '').trim();
  const num = formatPhone(r?.requesterNumber) ?? phoneOut(r?.requesterNumberDisplay ?? null);
  return [name && !/@/.test(name) ? name : null, num].filter(Boolean).join(' ') || r?.requesterJid || 'a member';
}
