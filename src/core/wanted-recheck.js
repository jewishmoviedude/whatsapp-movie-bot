/**
 * The wanted list, checked against the library.
 *
 * An entry left the wanted list (wanted.js) only when somebody asked for the
 * film again and the library lookup found it (clearWanted, in the movie
 * plugin's answerArrived). Nothing else ever looked again. So a film added to
 * the server after it was asked for, and a film the lookup had wrongly missed,
 * stayed listed as missing for good. On 2026-10-11 the panel's "Wanted - asked
 * for, not on the server" held eleven films, and seven of them were on the
 * server, as this recheck found when run against it (read-only, on a copy of
 * the list, last at 08:15 UTC; three stayed wanted, and the eleventh was the
 * 2 Broke Girls season below):
 *
 *  - "X2: X-Men United" (2003), asked for twice by one member on 2026-10-07,
 *    held as "X2". The lookup was fixed that day (bf22f1c, e55f92a), but the
 *    entry stayed, because nobody asked a third time.
 *  - "Harry Potter and the Sorcerer's Stone" (2001), held under the same IMDb
 *    id - as "...the Philosopher's Stone" when the list was first checked,
 *    and by 08:15 under the American title, the British one kept as its
 *    original title - and "Avatar Aang: The Last Airbender" (2026), held as
 *    "The Legend of Aang: The Last Airbender" under the same IMDb id as the
 *    entry, which the lookup did not match on until then.
 *  - "Guardians of the Galaxy: Vol. 2", queued by hand from the panel on
 *    2026-09-10, which clears nothing, and held as "Guardians of the Galaxy
 *    Vol. 2"; "Star Wars: Episode IV - A New Hope", held under that very
 *    name, which the server's own search cannot find (the colon; see
 *    findInLibrary), its original title there being "Star Wars"; "Dune: Part
 *    One", held as "Dune" (2021); and "My Suicide" (2009), listed while it
 *    was in cinemas.
 *
 * Every open entry is looked up with the lookup a request uses
 * (findInLibrary), with its title, year and IMDb id and the words its
 * requesters typed (`requests`, kept since this was added; for an older entry,
 * the request its not-in-library row kept), one at a time and paced. One the
 * library has is marked resolved by the bot - 'the bot (found on the server
 * as "X2")' - and its not-in-library row is marked answered as a request's
 * arrival marks it, and the caller is handed what was found, to log and to
 * show. Resolved, not deleted: the operator asked on 2026-10-11 for a "mark
 * as resolved so other admins ... know", and a line that vanishes from the
 * Wanted card tells an admin nothing, where "resolved by the bot (found on
 * the server as "X2")" tells them it was looked at, and what the library
 * calls it. An entry already resolved, by an admin or an earlier run, is not
 * looked up again; and an open entry is never resolved with a library copy
 * already ruled out for it (`rejected` in wanted.js): one an admin reopened
 * the bot's resolution over, or one a request's file check found to be
 * another film. This lookup runs no file check, so it must not overrule one.
 *
 * An entry whose request asked for a season of a show is taken off too,
 * without a lookup: it is not a film, and a request is no longer recorded so
 * (tvShapeOf). The one on the list on 2026-10-11 was "2 Broke Girls: Season 2
 * - 2 Broke Girls at PaleyFest 2013", a DVD extra OMDb answered "2 broke
 * girls season 2" with.
 *
 * It runs inside the bot (the 'wanted-recheck' routine in routines.js): a few
 * minutes after start, every 30 minutes, and on demand from the panel (POST
 * /api/wanted/recheck). It never throws: a lookup that fails is logged and the
 * entry stays. It ran every six hours until 2026-10-11, when "A Snapshot of
 * Forever" reached the server at 03:14 UTC and the next run was hours away.
 * A run is one paced lookup per open entry - a handful of films.
 *
 * What it finds is the trigger for telling the members who asked (agreed
 * with the operator, 2026-10-11): an entry it resolves is marked arrived
 * (markFound), and the pass that runs after it (wanted-arrival.js, told
 * through `onRun`) re-runs the requests that were answered "not in the
 * library". Nothing else starts one by itself; nothing of it depends on
 * Discord.
 */
import log from '../util/logger.js';
import {
  clearWanted, resolveWanted, pruneWanted, rejectedCopy, beginArrivals, describeArrivalsBegan, noteArrival, BOT,
} from './wanted.js';
import { resolveMiss, missKey } from './library-misses.js';
import { findInLibrary, createProvider, normImdb } from '../plugins/movie-requests/library.js';
import { tvShapeOf } from '../plugins/movie-requests/tv-shape.js';
import { typedYearOf, yearsApart, idYearsAgree } from '../util/fuzzy.js';

const logger = log.scope('wanted');

/** The movie plugin's store, where the wanted list lives. */
export const NAMESPACE = 'movie-requests';
/** Every 30 minutes (six hours until 2026-10-11; see the header). */
export const EVERY_MS = 30 * 60_000;
/**
 * The first run, this long after start: after the plugins' own recovery has
 * had the library to itself, and never in the middle of a restart loop.
 */
export const FIRST_AFTER_MS = 3 * 60_000;
/** Between two lookups: the list is a few dozen films at most, and is no hurry. */
export const PACE_MS = 2000;

const label = (w) => `${w.title}${w.year ? ` (${w.year})` : ''}`;
const EMPTY = () => ({ checked: 0, found: [], notFilms: [], errors: [] });
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Why the copy the lookup returned is not the film on the list, or null when
 * it is. The lookup judges candidates by title and year (whyOtherFilm), but a
 * bare title is answered with the one copy the server holds, whatever its
 * year - right for a member who never said which, wrong for a list of films
 * to add: Dune (2021) on the server does not make Dune (1984) arrive. And a
 * copy that carries another IMDb id than the entry is another film, however
 * close its title. A shopping list that keeps an entry it could have dropped
 * costs an admin a look; one that drops a film nobody has added loses it.
 */
export function notTheFilm(entry, hit) {
  const want = normImdb(entry?.imdbId);
  const got = normImdb(hit?.imdbId);
  if (want && got && want !== got) return `it is ${got}, not ${want}`;
  // The same id is the same film a few years either way of where each side
  // files it: A Snapshot of Forever, tt14074586, is 2025 to OMDb and 2022 on
  // the server, and stayed on the list for that (2026-10-11). Decades off,
  // the id is the library's mistake (SAME_ID_MAX_YEAR_GAP, util/fuzzy.js): a
  // 1990 "Total Recall" tagged with the 2012 film's id does not make the
  // 2012 film arrive, and its re-run would only be refused again.
  if (want && got && idYearsAgree(entry?.year, hit?.year)) return null;
  if (yearsApart(entry?.year, hit?.year)) return `it is from ${hit.year}, not ${entry.year}`;
  return null;
}

/**
 * "X2: X-Men United (2003) is on the server now (as "X2") - marked resolved
 * on the wanted list": one found entry, as the log and the audit say it.
 */
export function describeFound(f) {
  const as = f.as?.title && f.as.title !== f.title
    ? ` (as "${f.as.title}"${f.as.year && f.as.year !== f.year ? `, ${f.as.year}` : ''})`
    : '';
  return `${label(f)} is on the server now${as} - marked resolved on the wanted list`;
}

/**
 * Who resolved an entry the bot found, as the Wanted card shows it: 'the bot
 * (found on the server as "X2")'. The library's own title even when it is the
 * entry's, so an admin reads what to look for on the server.
 */
export function foundBy(hit) {
  return hit?.title ? `${BOT} (found on the server as "${hit.title}")` : `${BOT} (found on the server)`;
}

/**
 * '2 Broke Girls: Season 2 - ... (2013) was asked for as "2 broke girls
 * season 2": season 2 of a show, not a film - off the wanted list'.
 */
export function describeNotFilm(f) {
  return `${label(f)} was asked for as "${f.request}": ${f.season ? `season ${f.season} of ` : ''}a show, not a film`
    + ' - off the wanted list';
}

/**
 * What the members typed for an entry: its own `requests`, or for one
 * recorded before it kept them, the request its not-in-library row kept.
 */
function requestsOf(store, w) {
  const own = Array.isArray(w.requests) ? w.requests.filter(Boolean) : [];
  if (own.length) return own;
  const key = missKey({ kind: 'movie', title: w.title, year: w.year ?? null });
  const miss = (store.get('library-misses', []) ?? []).find((m) => m?.key === key);
  return miss?.request ? [String(miss.request)] : [];
}

/**
 * Look every open entry on the wanted list up in the library, one at a time,
 * mark the ones it has resolved by the bot, and take off any that asked for a
 * show.
 *
 * Returns { checked, found: [{ key, title, year, imdbId, count, requesters,
 * as: { title, year, imdbId } }], notFilms: [{ key, title, year, imdbId,
 * count, requesters, request, show, season }], errors: [{ key, title, error }] }.
 * `find` and `wait` are the lookup and the pause between lookups, and `now`
 * the clock a resolution is stamped with, for tests.
 */
export async function recheckWanted(store, {
  libraryCfg, find = findInLibrary, onTokenRefreshed = null, paceMs = PACE_MS, wait = sleep, log: lg = logger,
  now = Date.now,
} = {}) {
  // A copy, so an entry recorded or cleared while this runs is left to the
  // request that did it. Only the open ones: a resolved entry was settled,
  // by an admin or by an earlier run, and is kept only to be seen.
  const entries = (store.get('wanted', []) ?? []).filter((w) => !w?.resolved);
  const result = { checked: 0, found: [], notFilms: [], errors: [] };
  const who = (w) => ({
    key: w.key, title: w.title, year: w.year ?? null, imdbId: w.imdbId ?? null, reason: w.reason ?? null,
    count: w.count ?? 1, requesters: w.requesters ?? [],
  });
  let looked = 0;
  for (const w of entries) {
    if (!w?.title) continue;
    result.checked += 1;
    // What the members typed: a season of a show comes off without a lookup,
    // and the lookup (lookUpWanted) searches with their words too.
    const requests = requestsOf(store, w);
    const tv = requests.map((t) => ({ t, shape: tvShapeOf(t, w) })).find((x) => x.shape);
    if (tv) {
      if (clearWanted(store, w)) {
        result.notFilms.push({ ...who(w), request: tv.t, show: tv.shape.show, season: tv.shape.season ?? null });
      }
      continue;
    }
    if (looked++ && paceMs) await wait(paceMs);
    let seen;
    try {
      seen = await lookUpWanted(store, w, { libraryCfg, find, onTokenRefreshed, log: lg });
    } catch (err) {
      result.errors.push({ key: w.key, title: w.title, error: err.message });
      lg.warn(`wanted recheck: looking up ${label(w)} failed - it stays on the list: ${err.message}`);
      continue;
    }
    if (!seen.hit) continue;
    const as = markFound(store, w, seen.hit, { now: now(), log: lg });
    if (!as) continue;     // an admin, or a request, settled it meanwhile
    result.found.push({ ...who(w), as });
  }
  return result;
}

/**
 * Look one entry up in the library as a request would - its title, year and
 * IMDb id, the words its requesters typed and the year one of them wrote -
 * and judge what came back. Resolves to { hit } for a copy that is the film,
 * { refused, why } for one that is not (logged), or {} for nothing; throws
 * when the lookup itself fails. The recheck above and the arrival re-runs
 * (wanted-arrival.js) both look a film up here, so they cannot disagree
 * about what is on the server.
 */
export async function lookUpWanted(store, w, {
  libraryCfg, find = findInLibrary, onTokenRefreshed = null, log: lg = logger,
} = {}) {
  // The year one of them wrote holds a same-titled copy to it, as it did for
  // their request (typedYearOf: Dune 2021 is not "Dune 1984").
  const requests = requestsOf(store, w);
  const typedYear = requests.map((t) => typedYearOf(t, w)).filter(Boolean).at(-1) ?? null;
  const hit = await find(w.title, w.year ?? null, libraryCfg, {
    alsoTry: requests, imdbId: w.imdbId ?? null, typedYear, onTokenRefreshed,
  });
  if (!hit) return {};
  const why = notTheFilm(w, hit);
  if (why) {
    lg.info(`wanted recheck: the library's "${hit.title}"${hit.year ? ` (${hit.year})` : ''} is not ${label(w)} `
      + `- ${why}; it stays on the list`);
    return { refused: hit, why };
  }
  // A copy already ruled out for this film: an admin reopened the entry
  // after the bot resolved it with this copy, or a request's file check
  // found it to be another film. This lookup judges only titles, years and
  // IMDb ids, and resolving it again undid the admin's Reopen at the next
  // run (found in review, 2026-10-11), or opened and resolved it in turn
  // with every request. The admin's word, or the file check's, stands.
  const ruledOut = rejectedCopy(w, hit);
  if (ruledOut) {
    lg.info(`wanted recheck: the library's "${hit.title}"${hit.year ? ` (${hit.year})` : ''} is the copy `
      + (ruledOut.why === 'reopened'
        ? `${ruledOut.by} reopened ${label(w)} over`
        : `a request found to be another film than ${label(w)}`)
      + ' - it stays on the list');
    return { refused: hit, why: ruledOut.why };
  }
  return { hit };
}

/**
 * Mark an entry the library has resolved by the bot, as a request that finds
 * the film resolves it, and its not-in-library row answered, not deleted: a
 * film that was refused and is on the server now is the row that says either
 * somebody added it or the lookup was wrong. The copy's library id goes with
 * it, so an admin's Reopen rules out that copy and no other (reopenWanted).
 * Returns the copy as kept (`as`), or null when the entry had been settled
 * meanwhile, by an admin or by a request.
 *
 * And the entry is marked arrived (noteArrival), so the pass after this run
 * re-runs the requests that were refused for it (wanted-arrival.js): the
 * recheck finding the film is what starts them. Re-runs having begun on
 * this box is recorded first (beginArrivals), so that what is resolved here
 * is never taken for an entry resolved before they began.
 */
export function markFound(store, w, hit, { now = Date.now(), log: lg = logger } = {}) {
  const as = { id: hit.id ?? null, title: hit.title ?? null, year: hit.year ?? null, imdbId: hit.imdbId ?? null };
  const began = beginArrivals(store, { now });
  if (began.fresh) lg.info(describeArrivalsBegan(began));
  const done = resolveWanted(store, w.key, { by: foundBy(hit), at: now, auto: true, as });
  resolveMiss(store, { kind: 'movie', title: w.title, year: w.year ?? null });
  if (!done) return null;
  noteArrival(store, w.key, { at: now, as });
  return as;
}

/** Can the library be searched at all? createProvider throws for an unknown one. */
function libraryReady(libraryCfg) {
  try { return !!libraryCfg && createProvider(libraryCfg).configured; } catch { return false; }
}

/**
 * The recheck as the bot runs it: on a timer, and when the panel asks. One
 * run at a time - a second ask while one is running gets that run's answer -
 * and never an exception out of it.
 */
export class WantedRecheck {
  /**
   * @param onRun  told of each run's result once it is over: src/index.js
   *               runs the arrival re-runs' pass then (wanted-arrival.js),
   *               which re-runs the requests for what the run found. Not
   *               awaited, so the panel's Refresh answers when the lookups
   *               are done, not after the members' requests have been re-run
   *               one paced message at a time.
   * @param now    the clock, for tests: what a run resolves, and prunes, is
   *               by it.
   */
  constructor({
    configStore, stateStore, log: lg = logger, everyMs = EVERY_MS, firstAfterMs = FIRST_AFTER_MS,
    paceMs = PACE_MS, find = findInLibrary, wait = sleep, onRun = null, now = Date.now,
  }) {
    this.configStore = configStore;
    this.stateStore = stateStore;
    this.log = lg;
    this.everyMs = everyMs;
    this.firstAfterMs = firstAfterMs;
    this.paceMs = paceMs;
    this.find = find;
    this.wait = wait;
    this.onRun = onRun;
    this.now = now;
    this._timer = null;
    this._first = null;
    this._running = null;
    this.last = null;
  }

  start() {
    if (this._timer) return;
    this._first = setTimeout(() => { this.run('after start'); }, this.firstAfterMs);
    this._first.unref?.();
    this._timer = setInterval(() => { this.run('every 30 minutes'); }, this.everyMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._first) { clearTimeout(this._first); this._first = null; }
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  get running() { return !!this._running; }

  /** Run now, or join the run in hand. Resolves to what it found; never rejects. */
  run(why = 'on demand') {
    if (!this._running) {
      this._running = this._run(why).finally(() => { this._running = null; });
      this._running.then((r) => {
        try { this.onRun?.(r); } catch (err) { this.log.warn(`after the wanted recheck: ${err.message}`); }
      });
    }
    return this._running;
  }

  async _run(why) {
    const at = this.now();
    try {
      const cfg = this.configStore.get();
      if (!libraryReady(cfg?.library)) {
        this.log.debug?.(`wanted recheck (${why}): skipped - the library is not configured`);
        return { why, at, skipped: 'The library is not configured (Settings -> Library).', ...EMPTY() };
      }
      const store = this.stateStore.namespace(NAMESPACE);
      // What was resolved over a month ago goes now. This is the bot's one
      // timer on the list; a resolved entry is only kept to be seen a while.
      const pruned = pruneWanted(store, { now: at });
      if (pruned) this.log.info(`wanted recheck (${why}): ${pruned} entr${pruned === 1 ? 'y' : 'ies'} resolved over 30 days ago dropped`);
      const open = (store.get('wanted', []) ?? []).filter((w) => !w?.resolved).length;
      if (!open) return { why, at, ...EMPTY() };
      this.log.info(`wanted recheck (${why}): looking up the ${open} film(s) on the wanted list in the library`);
      const r = await recheckWanted(store, {
        libraryCfg: cfg.library, find: this.find, paceMs: this.paceMs, wait: this.wait, log: this.log, now: this.now,
        // Password auth renews its own token; kept, as a request keeps it.
        onTokenRefreshed: (auth) => this.configStore.update?.({
          library: { jellyfin: { accessToken: auth.accessToken, userId: auth.userId ?? '', userName: auth.userName ?? '' } },
        }),
      });
      for (const f of r.found) this.log.info(describeFound(f));
      for (const f of r.notFilms) this.log.info(describeNotFilm(f));
      this.log.info(`wanted recheck (${why}): ${r.found.length} of ${r.checked} on the server now`
        + `${r.notFilms.length ? `, ${r.notFilms.length} asked for a show` : ''}`
        + `${r.errors.length ? `; ${r.errors.length} lookup(s) failed and stay on the list` : ''}`);
      this.last = { why, at, ...r };
      return this.last;
    } catch (err) {
      this.log.error(`wanted recheck (${why}) failed: ${err.message}`);
      return { why, at, error: err.message, ...EMPTY() };
    }
  }
}
