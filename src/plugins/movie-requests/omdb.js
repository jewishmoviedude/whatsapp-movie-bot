import log from '../../util/logger.js';
import {
  similarity, extractYear, cleanRequestText, normalizeTitle, sameTitleWords, sequelNumber, carriesNumber,
} from '../../util/fuzzy.js';

const logger = log.scope('omdb');
const BASE = 'https://www.omdbapi.com/';

/*
 * A failure of the moment at OMDb is waited out, not handed to the member.
 *
 * 2026-10-12, 01:46:14Z: "First daughter 2004" failed with "OMDb HTTP 525",
 * a Cloudflare error in front of OMDb, and the member got ⚠️. OMDb answered
 * the next lookup at 01:47:37 - it was gone for under 90 seconds - and an
 * admin queued the film by hand after Head Admin's #issue. At 03:06:50Z "My
 * Fault London 2025" failed the same way with "OMDb HTTP 403", and the
 * lookups after it worked. omdbFetch gave up at the first bad answer.
 *
 * So a try that meets one of these is made again:
 *   - a network error (undici's own ten-second connect timeout among them).
 *     An abort by the caller's signal ends the call at once, mid-wait
 *     included, and is never tried again;
 *   - HTTP 5xx (Cloudflare's 52x among them), 429, and 403, which is how
 *     Cloudflare turns a request away in front of OMDb.
 * OMDb's own refusals, "Invalid API key!" and "Request limit reached!", come
 * as 401 and are not tried again: no wait mends a key, and a used-up daily
 * quota is not given back within a minute. Nor is anything OMDb answered,
 * "Movie not found!" included.
 *
 * The tries are made RETRY_AT_MS after the first (5, 30 and 90 seconds), or
 * as soon as the try before has failed when that is later. The last comes 90
 * seconds after the first, past the whole of an outage like that one. The
 * final error is the last try's, worded as before ("OMDb HTTP 525"):
 * History's detail and the hourly check's scanner (incident-scan.js, which
 * offers a failed film request for a re-run whatever its detail) read it as
 * they always have.
 *
 * How long a try may take. A call ends OMDB_RETRY_SPAN_MS (two minutes) after
 * its first try, and each try is given whatever is left of that, not a limit
 * of its own. The first version gave each try 20 seconds, and review found
 * (2026-10-12) that an OMDb answering in 25 seconds - slow, but answering,
 * and taken as an answer before - then became four timed-out tries and ⚠️,
 * and noted OMDb as down for every request after it. Cloudflare waits 100
 * seconds for OMDb before it answers 524 itself, so an answer that comes at
 * all comes within the call; only a connection that hangs past that is given
 * up on, at the call's end, where fetch would have waited undici's five
 * minutes. A retry that would be left less than MIN_TRY_MS is not made: its
 * timeout would say less than the error the try before it had.
 *
 * Who waits behind it. bot.js hands each message on as an event, and
 * src/index.js does not await dispatchMessage, so a member's request waiting
 * here holds up no other member's message. What does wait is the member's
 * own next film request, by design (request-cooldown.js, rule 2;
 * FILM_LOOKUP_WAIT_MS allows for this span), and the work that runs requests
 * one after another: the paused requests' replay, the wanted list's re-runs,
 * the panel's bulk re-run, the direct-links queue, which looks up one link at
 * a time, and the bot's local command channel (data/bot-cmd.json), which
 * src/index.js runs one command at a time (cmdBusy). The hourly check re-runs
 * a failed request through that channel (`requeue`) and waits for its answer
 * REQUEUE_WAIT_MS (tools/hourly-debug.mjs), which allows for this span: at
 * the 60 seconds it waited before, a re-run still waiting out OMDb was
 * reported as unanswered, and its late answer was read as the answer to the
 * check's next re-run (found in review, 2026-10-12). The outage note below is
 * what keeps that work from waiting a full span per request; direct-links,
 * whose OMDb lookup is only a nicety, does not wait at all (`retry: false`),
 * nor does the panel's key test, which reports what OMDb says now, nor the
 * pick list's plots (listPlots).
 *
 * The outage note. One lookupMovie() may ask OMDb half a dozen times, and the
 * work above asks for request after request, so while OMDb is down for
 * longer, a full span per call would add up to many minutes. Once a call has
 * used up its tries, OMDb is noted as down for DOWN_WINDOW_MS, and a call in
 * that time is tried once, without waiting. Once rather than not at all: a
 * failed try costs a second (a 52x comes back at once), and one that succeeds
 * means OMDb is back - the note is dropped there and then, so the first
 * member to ask after the outage is answered rather than refused on a note
 * about the past. A failed try in the window renews it, so a long outage
 * costs one full span, then a try per call; a call after a quiet minute
 * waits out a new blip in full. That one try is given the span like any
 * other, not a shorter limit: a slow OMDb is not noted as down (its calls
 * are answered), but one that comes back slowly from an outage would
 * otherwise have each try cut short, each failure renewing the note, and
 * every request ⚠️ for as long as members kept asking.
 */
const RETRY_AT_MS = [5_000, 30_000, 90_000];
const MIN_TRY_MS = 5_000;
const DOWN_WINDOW_MS = 60_000;

/** The longest one call to OMDb can take, its tries and the waits between them included. */
export const OMDB_RETRY_SPAN_MS = 120_000;

// Seams for tests (setOmdbClock): the wait between tries, the clock it is
// timed by, and how long one call may take.
const clock = { sleep: sleepFor, now: () => Date.now(), spanMs: OMDB_RETRY_SPAN_MS };

/**
 * For tests: replace the wait between tries (`sleep(ms, signal)`), the clock
 * (`now()`) or how long one call may take (`spanMs`). Returns a function that
 * puts them back.
 */
export function setOmdbClock({ sleep, now, spanMs } = {}) {
  const was = { ...clock };
  if (sleep) clock.sleep = sleep;
  if (now) clock.now = now;
  if (spanMs) clock.spanMs = spanMs;
  return () => Object.assign(clock, was);
}

// OMDb noted as down: { since, until } - failing since `since`, and tried
// once per call until `until` - or null.
let outage = null;

/** For tests: forget that OMDb was noted as down. */
export function forgetOmdbOutage() { outage = null; }

// A note whose minute has passed with no failed try in it is forgotten:
// whatever OMDb did since, nobody saw it fail, and "failing for 4h" would be
// a guess.
function outageNoted() {
  if (outage && clock.now() >= outage.until) outage = null;
  return !!outage;
}
const seconds = (ms) => `${Math.round(ms / 1000)}s`;
// What a call asked for, as the log names it: "First daughter 2004".
const asked = (params) => [params.t ?? params.s ?? params.i, params.y].filter((v) => v != null && v !== '').join(' ');

// Ends early on the caller's abort, so that no timer is left running for a
// call that has already given up.
function sleepFor(ms, signal) {
  return new Promise((resolve) => {
    let timer = null;
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** The wait before the next try, ended by the caller's abort, which it then throws. */
async function waitToRetry(ms, signal) {
  signal?.throwIfAborted();
  if (!signal) return clock.sleep(ms);
  let onAbort;
  const aborted = new Promise((resolve) => { onAbort = resolve; signal.addEventListener('abort', onAbort, { once: true }); });
  try {
    await Promise.race([clock.sleep(ms, signal), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  signal.throwIfAborted();
}

/**
 * One try, given `limitMs`: OMDb's answer, or what went wrong, marked
 * `transient` when it is a failure of the moment (above) and `status` when
 * OMDb's server answered.
 */
async function askOnce(url, signal, limitMs) {
  signal?.throwIfAborted();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), limitMs);
  const onAbort = () => ctl.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  let res;
  let data;
  try {
    res = await fetch(url, { signal: ctl.signal });
    if (res.ok) data = await res.json();
  } catch (err) {
    if (signal?.aborted) throw err;
    if (ctl.signal.aborted) {
      throw Object.assign(new Error(`OMDb timed out after ${seconds(limitMs)}`), { transient: true });
    }
    // fetch's "fetch failed", or "terminated" part-way through the answer:
    // the connection failed, not OMDb. A body that is not JSON is OMDb's
    // answer, and stays an error of its own.
    if (err instanceof TypeError) err.transient = true;
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    const transient = res.status >= 500 || res.status === 429 || res.status === 403;
    throw Object.assign(new Error(`OMDb HTTP ${res.status}`), { status: res.status, transient });
  }
  return data;
}

function omdbAnswered() {
  if (!outageNoted()) return;
  logger.info(`OMDb is answering again, after failing for ${seconds(clock.now() - outage.since)}`);
  outage = null;
}

/** A call that ends on a failure of the moment: note OMDb as down, or keep it noted, when that is what it says. */
function noteOutage(err, params, { first, tries, usedUp }) {
  const noted = outageNoted();
  // One try, by a caller that asked for no more, while OMDb is not noted as
  // down: it says nothing about how long OMDb has been failing.
  if (!usedUp && !noted) return;
  const now = clock.now();
  const since = noted ? outage.since : first;
  if (usedUp) {
    logger.warn(`${err.message} for "${asked(params)}" - giving up after ${tries} ${tries === 1 ? 'try' : 'tries'} over ${seconds(now - first)}; `
      + `OMDb is taken as down, and each lookup in the next ${seconds(DOWN_WINDOW_MS)} tries it once without waiting`);
  } else {
    logger.info(`${err.message} for "${asked(params)}" - not trying again: OMDb has been failing for `
      + `${seconds(now - since)}, and a lookup used up its tries`);
  }
  outage = { since, until: now + DOWN_WINDOW_MS };
}

/*
 * `retry: false` makes one try, as before 2026-10-12 - for a caller nobody's
 * request is waiting on (see above). Without it, a failure of the moment is
 * tried again on RETRY_AT_MS, unless OMDb is noted as down. Either way the
 * call ends OMDB_RETRY_SPAN_MS after it began.
 */
async function omdbFetch(params, apiKey, signal, { retry = true } = {}) {
  if (!apiKey) throw new Error('No OMDb API key configured (Settings -> API keys & logins)');
  const url = new URL(BASE);
  url.searchParams.set('apikey', apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  const first = clock.now();
  const end = first + clock.spanMs;
  const plan = retry && !outageNoted() ? RETRY_AT_MS : [];
  let data;
  for (let n = 0; ; n++) {
    try {
      data = await askOnce(url, signal, Math.max(0, end - clock.now()));
      break;
    } catch (err) {
      if (!err.transient) {
        // A 401: OMDb is up, whatever it thinks of the key.
        if (err.status) omdbAnswered();
        throw err;
      }
      // Another call may have used up its tries while this one waited: then
      // OMDb is down, and this one stops too. A try that took the time the
      // rest were due in (a slow 524, a hang) leaves no room for them: then
      // this call has used them up.
      const othersNoted = outageNoted();
      const wait = n < plan.length ? Math.max(0, first + plan[n] - clock.now()) : Infinity;
      if (!othersNoted && end - (clock.now() + wait) >= MIN_TRY_MS) {
        logger.info(`${err.message} for "${asked(params)}" - trying again in ${seconds(wait)} (${n + 2}/${plan.length + 1})`);
        await waitToRetry(wait, signal);
        continue;
      }
      noteOutage(err, params, { first, tries: n + 1, usedUp: plan.length > 0 && !othersNoted });
      throw err;
    }
  }
  omdbAnswered();
  if (data.Response === 'False') {
    const err = new Error(data.Error ?? 'not found');
    err.code = /not found/i.test(data.Error ?? '') ? 'NOT_FOUND' : 'OMDB_ERROR';
    throw err;
  }
  return data;
}

/**
 * One line of plot for a film on the "which one?" list, or null.
 *
 * OMDb's short plot is one or two sentences; a list of a whole franchise is
 * read on a phone, so it is cut to the first sentence and to about a line.
 * A first "sentence" that is really an abbreviation ("Dr.") is not taken as
 * one.
 */
export function shortenPlot(plot, max = 120) {
  const p = String(plot ?? '').replace(/\s+/g, ' ').trim();
  if (!p || p === 'N/A') return null;
  const first = p.match(/^.*?[.!?](?=\s+[A-Z"'(]|$)/)?.[0]?.trim();
  const text = first && first.length >= 25 ? first : p;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.\u2013\u2014-]+$/, '')}…`;
}

// Plots do not change, and the same franchise is asked for again and again,
// so each film's plot is fetched once per process. Only answers are kept - a
// timeout or an outage says nothing about the film and is tried again.
const PLOT_CACHE = new Map();
const PLOT_CACHE_MAX = 500;

/** For tests: forget every cached plot. */
export function clearPlotCache() { PLOT_CACHE.clear(); }

/**
 * The plots for a list's films, in the same order, null where there is none.
 *
 * Asked all at once, and given `timeoutMs` in all: the list is a member
 * waiting for an answer to their request, so a slow OMDb costs lines their
 * plot, never the list its turn. The answer must be the same film - the
 * same title, give or take punctuation, within a year - or it is not used:
 * a plot of the wrong film would be worse than none.
 *
 * One try each (`retry: false`): a failure of the moment costs a line its
 * plot at once. omdbFetch's first retry is due 5 seconds after the first try,
 * after the 4 seconds the list allows, so with the retries the list was held
 * until its abort for a retry that could never be made (found in review,
 * 2026-10-12: a "which one?" list for "venom" waited 4 s during a 525, for
 * no plot at all).
 */
export async function listPlots(items, { apiKey, timeoutMs = 4000 } = {}) {
  if (!apiKey || !items?.length) return (items ?? []).map(() => null);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await Promise.all(items.map(async (it) => {
      const key = `${normalizeTitle(it.title)}|${it.year}`;
      if (PLOT_CACHE.has(key)) return PLOT_CACHE.get(key);
      let plot = null;
      try {
        const data = await omdbFetch({ t: it.title, y: it.year, type: 'movie', plot: 'short' }, apiKey, ctl.signal, { retry: false });
        const year = Number(data.Year?.match(/\d{4}/)?.[0]) || null;
        if (normalizeTitle(data.Title) === normalizeTitle(it.title) && year && Math.abs(year - it.year) <= 1) {
          plot = shortenPlot(data.Plot);
        }
      } catch (err) {
        if (err.code !== 'NOT_FOUND') return null;
      }
      if (PLOT_CACHE.size >= PLOT_CACHE_MAX) PLOT_CACHE.delete(PLOT_CACHE.keys().next().value);
      PLOT_CACHE.set(key, plot);
      return plot;
    }));
  } finally {
    clearTimeout(timer);
  }
}

/** OMDb's "Too many results." - the search term matched more than it will list. */
export function isTooBroad(err) {
  return /too many results/i.test(err?.message ?? '');
}

function val(v) {
  return (!v || v === 'N/A') ? null : v;
}

function parseDate(s) {
  const d = val(s);
  if (!d) return null;
  const t = Date.parse(d);
  return Number.isNaN(t) ? null : new Date(t);
}

function shape(data) {
  return {
    imdbId: data.imdbID,
    title: data.Title,
    year: Number(data.Year?.match(/\d{4}/)?.[0]) || null,
    rated: val(data.Rated),               // G / PG / PG-13 / R / NC-17 / Not Rated ...
    released: parseDate(data.Released),   // theatrical release
    dvd: parseDate(data.DVD),             // home release, when OMDb knows it
    runtime: val(data.Runtime),
    genre: val(data.Genre),
    plot: val(data.Plot),
    poster: val(data.Poster),
    type: data.Type,
    boxOffice: val(data.BoxOffice),
    imdbRating: val(data.imdbRating),
    raw: data,
  };
}

/**
 * Resolve a free-text request into a single movie.
 * Tries an exact title lookup first (OMDb does light fuzzy matching there),
 * then falls back to search + best-match scoring.
 */
/** Score a candidate list against the request and return the winner, if any. */
/**
 * Is `got` the asked-for title plus a chunk of something else?
 *
 * A sequel or a re-release is a normal, close title. A making-of, a featurette
 * or a "Part 3" companion keeps the whole title and appends to it, so the
 * giveaway is extra words rather than different ones.
 */
export function looksPadded(asked, got) {
  const words = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  const a = words(asked);
  const g = words(got);
  if (!a.length || !g.length) return false;
  const askedSet = new Set(a);
  const extra = g.filter((w) => !askedSet.has(w)).length;
  // Half again as many words, most of them new, is a different work.
  return g.length >= a.length + 3 && extra / g.length >= 0.3;
}

/*
 * Search results are scored by titleFit, not by similarity alone, so that a
 * numbered title is read the way people say it. On 2026-10-11 the search for
 * "star wars the empire strikes back" listed Star Wars: Episode V - The
 * Empire Strikes Back (1980, 1.5 million votes) first, and similarity still
 * chose "Mynocks from Space: A Live Staged Reading of Star Wars - The Empire
 * Strikes Back" (2025, 34 votes) at 0.914 against the film's 0.9; read
 * without "Episode V", the film is the request exactly. "star wars iv" went
 * the same way, to an 8-minute fan short called Tantive IV. titleFit is never
 * below similarity, and scores higher only where a title read without its
 * numbering, by its name and number, or by its whole subtitle answers the
 * request better.
 */
function pickBest(title, year, results, threshold) {
  let best = null;
  for (const r of results) {
    const rYear = Number(r.Year?.match(/\d{4}/)?.[0]) || null;
    let score = titleFit(title, r.Title).fit;
    if (year && rYear) score += Math.abs(year - rYear) === 0 ? 0.08 : -0.08;
    score = Math.max(0, Math.min(1, score));
    if (!best || score > best.score) best = { r, score };
  }
  return best && best.score >= threshold ? best : null;
}

/*
 * OMDb files audiobooks, novelizations read aloud, commentary and riff tracks
 * and shorts as "movie", and its `t=` answers with whichever one carries the
 * typed words most exactly. On 2026-10-11, checked against live OMDb, "star
 * wars a new hope" resolved to an audiobook of that name (1994, 102 votes),
 * "star wars episode 4" to an audiobook of the Revenge of the Sith
 * novelization (13 votes), "star wars episode iv a new hope" to a RiffTrax
 * track and "a new hope" to a 2021 short, while only "star wars" reached
 * Star Wars: Episode IV - A New Hope (1977, 1.59 million votes), which the
 * library holds as "Star Wars" (1977). A member asking the natural way was
 * told the film was not in the library, and the Wanted list got a title
 * nobody can add. A library keeper had just asked the host to rename the file
 * to the full OMDb title; the lookup must not need that. So a hit that looks
 * like one of these is checked against search, and a film people have
 * actually watched whose title names the request at least as well is taken
 * instead.
 */

// A film this many people have rated on IMDb is one people watch, whatever
// else its record says. It is never second-guessed, so the requests that
// resolved cleanly before spend no more calls than they did.
const KNOWN_VOTES = 1000;

// What OMDb files as a film but is not one, by its title: "...- Audio
// Commentary with...", "The Making of 'Star Wars'", "...- Deleted Scenes", and
// the stage readings of the scripts, "Mynocks from Space: A Live Staged
// Reading of Star Wars - The Empire Strikes Back" (2025), which live OMDb gave
// for "star wars the empire strikes back" on 2026-10-11.
const NOT_THE_FILM_TITLE = /\b(audio\s?books?|unabridged|noveli[sz]ations?|rifftrax|commentary|deleted scenes|making of|(?:staged|live) reading)\b/i;
// By its plot, only words no film's own plot uses. "Commentary" and "the
// making of" are ordinary there ("a pointed commentary on empire", "during
// the making of a film"), and read as markers in review they turned a new
// film nobody had rated yet into a suspect, so that a famous film sharing its
// name as a subtitle was sent instead.
const NOT_THE_FILM_PLOT = /\b(audio\s?books?|unabridged|noveli[sz]ations?|rifftrax|audio commentary|commentary track|deleted scenes)\b/i;

/**
 * How many people have rated `movie` on IMDb: a number, 0 for OMDb's "N/A",
 * or null when the record does not say. OMDb always sends the field, so a
 * record without it (the suites' fakes build them for films they mean as
 * real) is taken as it comes rather than read as nobody's.
 */
function imdbVotes(movie) {
  const v = movie?.raw?.imdbVotes;
  if (v === undefined || v === null) return null;
  return Number(String(v).replace(/[^0-9]/g, '')) || 0;
}

/**
 * Why `movie` looks like something other than the film a member would ask
 * for - an audiobook, a commentary or riff track, a short, a TV play nobody
 * has rated - or null when it does not.
 *
 * Only a record with fewer than KNOWN_VOTES votes is judged at all. A film
 * from this year or last with few votes is new rather than obscure (its
 * votes have not come in yet), unless its record says outright that it is
 * not a film: an audiobook, an extra or a stage reading by its title, an
 * audiobook or a riff track by its plot, or a short by its genre. What only
 * hints at it - writers who are the whole cast, no rating and no runtime -
 * is weighed after that exemption, because a new stand-up special or a film
 * not rated yet looks just the same (found in review: a new special whose
 * writer was its star cost two more calls for the same answer).
 */
export function obscureReason(movie, { now = new Date() } = {}) {
  const votes = imdbVotes(movie);
  if (votes === null || votes >= KNOWN_VOTES) return null;
  const raw = movie.raw ?? {};
  if (NOT_THE_FILM_TITLE.test(movie.title ?? '') || NOT_THE_FILM_PLOT.test(val(raw.Plot) ?? '')) {
    return 'an audiobook, a commentary, a reading or an extra, by its title or plot';
  }
  if (/\bshort\b/i.test(val(raw.Genre) ?? '')) return 'a short';
  if (movie.year && movie.year >= now.getUTCFullYear() - 1) return null;
  // A riff track's writers are the people heard on it; a film's rarely are,
  // and never all of them.
  const people = (s) => (val(s) ?? '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean).sort().join('|');
  if (people(raw.Writer) && people(raw.Writer) === people(raw.Actors)) {
    return 'a riff or commentary track (its writers are its cast)';
  }
  const rated = votes ? `only ${votes} IMDb votes` : 'no IMDb votes';
  if (!val(raw.Rated) && !val(raw.Runtime)) return `an unrated record with no runtime and ${rated}`;
  return `a film with ${rated}`;
}

// "Episode IV", "Part 2", "Chapter III" or "Vol. 1" standing between a
// franchise's name and a subtitle, as in "Star Wars: Episode IV - A New
// Hope". Numbering at the END of a title is left alone: "The Godfather Part
// II" without it is another film.
const MID_NUMBERING = /\s*[:\-–—]?\s*\b(?:episode|part|chapter|volume|vol\.?)\s+(?:\d{1,2}|[ivx]{1,4})\s*[:\-–—]\s*/i;
const SEGMENTS = /\s*:\s*|\s+[-–—]\s+/;

// The name, the numbering word and the number of a numbered title, wherever
// the numbering stands, as long as the number ends a segment: "Star Wars:
// Episode IV - A New Hope", "John Wick: Chapter 4", "The Godfather Part II".
// "Episode IV.V - The Unknown Discovery" and "Episode IV in 120 Seconds" are
// not numbered IV.
const NUMBERED = /^(.*?\S)\s*[:\-–—]?\s*\b(episode|part|chapter|volume|vol\.?)\s+(\d{1,2}|[ivx]{1,4})(?=\s*(?:[:\-–—(]|$))/i;

// A whole subtitle typed alone ("a new hope") names the film nearly as well
// as its full title, but not quite: a short or a TV play may be called just
// that, and one that people have rated keeps the name (see rankOf).
const SUBTITLE_FIT = 0.95;

/**
 * How well `title`, a catalogue title, answers `typed`: `fit`, 0..1, the best
 * of these readings, and `names`, whether one of them is the typed words
 * exactly.
 *
 *   - the title as it stands (similarity);
 *   - the title without numbering between its name and its subtitle, which
 *     is what people leave out: "Star Wars: A New Hope";
 *   - its name and number, with or without the numbering word, when the
 *     typed words are exactly that: "Star Wars Episode IV", "Star Wars IV"
 *     (or 4). On 2026-10-11 "star wars 4" and "star wars iv" still went to
 *     a 16-minute Annual #4 and an 8-minute fan short, Tantive IV: read as it
 *     stands, "Star Wars: Episode IV - A New Hope" fitted those requests at
 *     0.8 against the shorts' 0.95. Only an exact match counts, never a near
 *     one, so "star wars" alone does not favour one episode over another;
 *   - its last subtitle alone, when the typed words are exactly that and it
 *     is at least two words long: "A New Hope" (SUBTITLE_FIT).
 */
export function titleFit(typed, title) {
  const full = String(title ?? '');
  let fit = similarity(typed, full);
  let names = sameTitleWords(typed, full);
  const unnumbered = full.replace(MID_NUMBERING, ': ');
  if (unnumbered !== full) {
    fit = Math.max(fit, similarity(typed, unnumbered));
    names = names || sameTitleWords(typed, unnumbered);
  }
  const numbered = full.match(NUMBERED);
  if (numbered) {
    const [, name, word, n] = numbered;
    if (sameTitleWords(typed, `${name} ${word} ${n}`) || sameTitleWords(typed, `${name} ${n}`)) {
      fit = 1;
      names = true;
    }
  }
  const parts = full.split(SEGMENTS).filter(Boolean);
  const subtitle = parts.length > 1 ? parts[parts.length - 1] : '';
  if (normalizeTitle(subtitle).split(' ').length >= 2 && sameTitleWords(typed, subtitle)) {
    fit = Math.max(fit, SUBTITLE_FIT);
    names = true;
  }
  return { fit, names };
}

// Title fit and popularity, blended: each tenfold of IMDb votes is worth a
// hundredth of fit. That settles a tie between two titles that match equally
// (Star Wars and its RiffTrax track are both "Star Wars Episode IV: A New
// Hope"), and lets a whole-subtitle match (0.95) past an exact title only
// when the exact one has next to no votes: 1.59 million against none is
// 0.062. It is never what lets a worse-matching title in; that takes the
// gate in preferKnownFilm.
const VOTE_WEIGHT = 0.01;
const rankOf = (fit, votes) => fit + VOTE_WEIGHT * Math.log10(1 + (votes ?? 0));
// The most votes any film has (The Shawshank Redemption, about 3 million),
// with room to spare: what a candidate could at best add to its fit.
const MOST_VOTE_EDGE = rankOf(0, 4_000_000);
// No film is taken over the one OMDb gave unless its title answers the
// request at least this well.
const STRONG_FIT = 0.9;

const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];
function swapNumeral(n) {
  if (/^\d+$/.test(n)) return ROMAN[Number(n) - 1] ?? null;
  const i = ROMAN.indexOf(n.toLowerCase());
  return i >= 0 ? String(i + 1) : null;
}

/**
 * Other ways to search for what was typed, for when the first search found
 * nothing better than an obscure hit. At most two:
 *
 *   - the numbering the other way round. OMDb's search is literal, so "star
 *     wars episode 4" finds only the audiobook whose title ends "Book 4",
 *     never "Episode IV". A numeral after episode/part/chapter/volume, or one
 *     ending the title (two letters or more, so "Malcolm X" stays), 1 to 10.
 *   - the obscure hit's own subtitle, when the request ends with it: the
 *     audiobook "Star Wars: A New Hope" says the film is searched for as "A
 *     New Hope", without the franchise.
 */
export function searchVariants(title, suspectTitle) {
  const out = [];
  let swapped = title.replace(/\b(episode|part|chapter|volume|vol\.?)\s+(\d{1,2}|[ivx]{1,4})\b/i,
    (m, word, n) => (swapNumeral(n) ? `${word} ${swapNumeral(n)}` : m));
  if (swapped === title) {
    swapped = title.replace(/\s(\d{1,2}|[ivx]{2,4})$/i, (m, n) => (swapNumeral(n) ? ` ${swapNumeral(n)}` : m));
  }
  if (swapped !== title) out.push(swapped);
  const parts = String(suspectTitle ?? '').split(SEGMENTS).filter(Boolean);
  const subtitle = parts.length > 1 ? parts[parts.length - 1] : '';
  const sub = normalizeTitle(subtitle);
  const typed = normalizeTitle(title);
  if (sub.split(' ').length >= 2 && typed !== sub && typed.endsWith(` ${sub}`)) out.push(subtitle);
  return out;
}

/**
 * Drop candidates that lack the sequel number the request ends with
 * (sequelNumber, carriesNumber in util/fuzzy.js). relaxedSearch never
 * searches one-character words, so "fast and furios 6" (2026-10-11) was
 * searched as "fast and", "fast furios" and so on, and the winner, Fast and
 * Furious (1939), had no 6: the library's "Fast & Furious" (2009) was then
 * sent for it, though the library holds Fast & Furious 6. A request ending in
 * a number names that numbered film or none; an honest miss lets the library
 * search find it by its own title. "Ocean's 11" is "Ocean's Eleven" in the
 * catalogue, so a number spelled out counts as the digits.
 *
 * Every way lookupMovie finds a film is held to it - the direct hit, the
 * search, the relaxed search and the well-known film it may prefer to an
 * obscure one - not only the relaxed search, where the hourly check first
 * put it: a `t=` that answers a numbered request with the unnumbered film is
 * the same wrong film by a shorter road.
 */
export function keepsSequelNumber(title, results) {
  const n = sequelNumber(title);
  if (n === null) return results;
  return (results ?? []).filter((r) => carriesNumber(r.Title, n, { typed: title }));
}

const yearOf = (y) => Number(String(y ?? '').match(/\d{4}/)?.[0]) || null;

/**
 * A well-known film to take instead of `suspect`, an obscure hit for the
 * request `title`, or null.
 *
 * Candidates come from `pool`, the search already made, and only when that
 * holds none from searchVariants. A candidate must:
 *   - be from the typed `year`, when one was typed: a typed year is a hard
 *     constraint here as everywhere;
 *   - carry the number the request ends with, when it ends with one
 *     (keepsSequelNumber), which is a hard constraint too;
 *   - answer the request strongly (STRONG_FIT), and at least as well as the
 *     suspect does - or name it exactly, by its title, its title without
 *     numbering, or its whole subtitle. A famous film whose title only
 *     starts with, or contains, the words typed never replaces an obscure
 *     film called exactly that ("Dune: Part Two" is not "dune");
 *   - have at least KNOWN_VOTES votes, and outrank the suspect on rankOf.
 *
 * Search results carry no votes, so a candidate's record is fetched to know
 * them. They are fetched in OMDb's order, which lists the most popular first,
 * and one that fits no better than the film already in hand is skipped. At
 * most `maxCalls` OMDb calls are made in all.
 */
async function preferKnownFilm(title, year, suspect, pool, { apiKey, signal, maxCalls = 3, retry = true } = {}) {
  const own = titleFit(title, suspect.title);
  const base = rankOf(own.fit, imdbVotes(suspect));
  const seen = new Set([suspect.imdbId]);
  const candidates = [];
  // A typed sequel number holds here as everywhere (keepsSequelNumber): a
  // famous film without it is not a better answer, only a better-known
  // wrong one.
  const number = sequelNumber(title);
  const consider = (results) => {
    for (const r of results ?? []) {
      if (!r?.imdbID || seen.has(r.imdbID)) continue;
      seen.add(r.imdbID);
      if (year && yearOf(r.Year) !== year) continue;
      if (!carriesNumber(r.Title, number, { typed: title })) continue;
      const { fit, names } = titleFit(title, r.Title);
      if (fit >= STRONG_FIT && (names || fit >= own.fit) && fit + MOST_VOTE_EDGE > base) {
        candidates.push({ r, fit });
      }
    }
  };
  consider(pool);

  let calls = 0;
  for (const q of searchVariants(title, suspect.title)) {
    // Keep one call back for the record a found candidate needs.
    if (candidates.length || calls >= maxCalls - 1) break;
    calls++;
    try {
      consider((await omdbFetch({ s: q, y: year, type: 'movie' }, apiKey, signal, { retry })).Search);
    } catch (err) {
      if (err.code !== 'NOT_FOUND' && !isTooBroad(err)) throw err;
    }
  }

  let best = null;
  for (const c of candidates) {
    if (calls >= maxCalls) break;
    if (best && c.fit <= best.fit) continue;
    calls++;
    let movie;
    try {
      movie = shape(await omdbFetch({ i: c.r.imdbID, plot: 'short' }, apiKey, signal, { retry }));
    } catch (err) {
      // A film already found is not lost to a failure on the way to a
      // second one that might have outranked it.
      if (!best || signal?.aborted) throw err;
      logger.warn(`could not fetch ${c.r.Title} (${c.r.Year}) to compare: ${err.message}`);
      break;
    }
    const votes = imdbVotes(movie);
    if (votes === null || votes < KNOWN_VOTES) continue;
    const rank = rankOf(c.fit, votes);
    if (rank > base && (!best || rank > best.rank)) best = { movie, fit: c.fit, rank, votes };
  }
  return best;
}

/**
 * The Nth well-known film of a franchise, for a request that counts them
 * ("die hard 3") when the franchise's third film has a title of its own.
 *
 * 2026-10-18, 00:54Z: "die hard 3" resolved to "Die Hard 3: Bruce Willis
 * Interview" (1995), a short, and was answered "not in the library" while the
 * library holds Die Hard: With a Vengeance (1995). The typed number is a hard
 * constraint (keepsSequelNumber), so no film without a 3 in its title could
 * replace the short. Only used once the hit is already doubted. The franchise
 * is searched by its name, the films that begin with it are fetched for their
 * votes, and the Nth by year of those people have rated is the film - but
 * only when the franchise's first film (the bare name) is among them, since
 * counting from the second would name the wrong one.
 */
async function franchiseSequel(title, year, { apiKey, signal, maxCalls = 8, retry = true } = {}) {
  const n = sequelNumber(title);
  const words = normalizeTitle(cleanRequestText(title)).split(' ').filter(Boolean);
  if (!n || n < 2 || year || !/^\d{1,2}$/.test(words[words.length - 1])) return null;
  const name = words.slice(0, -1).join(' ');
  if (name.length < 3) return null;
  let results;
  try {
    results = (await omdbFetch({ s: name, type: 'movie' }, apiKey, signal, { retry })).Search;
  } catch (err) {
    if (err.code !== 'NOT_FOUND' && !isTooBroad(err)) throw err;
    return null;
  }
  const mine = (results ?? []).filter((r) => r?.imdbID && yearOf(r.Year)
    && !NOT_THE_FILM_TITLE.test(r.Title ?? '')
    && (` ${normalizeTitle(r.Title)} `).startsWith(` ${name} `));
  const known = [];
  for (const r of mine.slice(0, maxCalls - 1)) {
    let movie;
    try {
      movie = shape(await omdbFetch({ i: r.imdbID, plot: 'short' }, apiKey, signal, { retry }));
    } catch (err) {
      if (signal?.aborted) throw err;
      return null;
    }
    const votes = imdbVotes(movie);
    if (votes !== null && votes >= KNOWN_VOTES && !obscureReason(movie)) known.push({ movie, votes });
  }
  known.sort((a, b) => a.movie.year - b.movie.year);
  if (!known.length || normalizeTitle(known[0].movie.title) !== name) return null;
  const pick = known[n - 1];
  return pick ?? null;
}

// The little words a member writes between the words of a title.
const SMALL_WORDS = new Set(['and', 'the', 'of', 'an']);

/**
 * Gather candidates by searching with one word removed at a time.
 *
 * Only runs when the direct lookups have already failed, so it costs nothing
 * on the common path. Results are pooled and de-duplicated by IMDb id; the
 * caller scores them against the complete request, so a sub-query matching
 * loosely cannot by itself win.
 *
 * And once with every little word removed. OMDb's search wants each word it
 * is given in the title, and an "&" there is not an "and": measured on
 * 2026-10-11, "fast and furious 6" and "fast and 6" found nothing, and "fast
 * furious" found Fast & Furious 6 (2013). "fast and furious 6" reached it
 * only because dropping "and" is one of its sub-queries; "the fast and the
 * furious 6" has to lose "and" and "the" both, which no sub-query of one
 * word less does, and it was a miss.
 *
 * That search leaves out the number the request ends with, too. A "6" is
 * never searched (one character), but "six" was, and live OMDb found
 * nothing for "fast furious six" (2026-10-11): "fast and furious six" was a
 * miss here, and only the library's research, which can find nothing the
 * server lacks, found Fast & Furious 6 for it. The number is not lost by
 * leaving it out: the caller keeps only the films that carry it
 * (keepsSequelNumber).
 */
async function relaxedSearch(title, apiKey, signal, { maxQueries = 4, year = null, retry = true } = {}) {
  const tokens = normalizeTitle(title).split(' ').filter((t) => t.length > 1);

  // One-word requests have no word to drop. Prefix-searching OMDb for them
  // was tried and removed: a short prefix pulls in obscure same-length
  // titles ("Matir Phul" for "matirx") that score deceptively well, and a
  // confidently wrong film is worse than an honest miss. Single-word typos
  // are handled instead by searching the library, which is a bounded set of
  // titles the requester could actually receive - see researchLibrary().
  if (tokens.length < 2) return [];

  // Drop the longest words first: they carry the most meaning, so removing
  // one is the most likely way to clear a typo while leaving enough to search.
  const order = tokens
    .map((t, i) => ({ i, len: t.length }))
    .sort((a, b) => b.len - a.len)
    .slice(0, maxQueries);
  const words = normalizeTitle(title).split(' ').filter(Boolean);
  const number = sequelNumber(title) !== null ? words[words.length - 1] : null;
  const plain = tokens.filter((t, i) => !SMALL_WORDS.has(t) && !(i === tokens.length - 1 && t === number));
  const plainQuery = plain.length >= 2 && plain.length < tokens.length ? plain.join(' ') : null;
  const queries = [plainQuery, ...order.map(({ i }) => tokens.filter((_, j) => j !== i).join(' '))]
    .filter((q, k, all) => q && all.indexOf(q) === k);

  const seen = new Map();
  for (const sub of queries) {
    try {
      const data = await omdbFetch({ s: sub, y: year, type: 'movie' }, apiKey, signal, { retry });
      for (const r of data.Search ?? []) {
        if (!seen.has(r.imdbID)) seen.set(r.imdbID, r);
      }
    } catch (err) {
      // With a year, a sub-query that is itself too broad ("11") is just one
      // unhelpful word; the others can still find the film. So is the search
      // without the little words, which is the broadest by design: its
      // "Too many results" says nothing about the request.
      if (err.code !== 'NOT_FOUND' && !((year || sub === plainQuery) && isTooBroad(err))) throw err;
    }
  }
  logger.debug(`relaxed search over ${queries.length} sub-queries produced ${seen.size} candidate(s)`);
  return [...seen.values()];
}

/**
 * Find films sharing essentially the same title - the remake problem.
 * "Dune" is both 1984 and 2021; "The Lion King" is 1994 and 2019. Sequels
 * ("Toy Story 2") are NOT ambiguous, because their titles genuinely differ,
 * so this compares normalized titles rather than just prefix-matching.
 */
async function findSameTitled(title, apiKey, signal, { retry = true } = {}) {
  let results;
  try {
    const data = await omdbFetch({ s: title, type: 'movie' }, apiKey, signal, { retry });
    results = data.Search ?? [];
  } catch (err) {
    if (err.code === 'NOT_FOUND') return [];
    throw err;
  }

  const wanted = normalizeTitle(title);
  const matches = results
    .filter((r) => normalizeTitle(r.Title) === wanted)
    .map((r) => ({
      title: r.Title,
      year: Number(r.Year?.match(/\d{4}/)?.[0]) || null,
      imdbId: r.imdbID,
    }))
    .filter((r) => r.year);

  // De-duplicate by year: OMDb occasionally lists the same film twice.
  const byYear = new Map();
  for (const m of matches) if (!byYear.has(m.year)) byYear.set(m.year, m);
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

/**
 * `detectAmbiguous` is off by default. Whether a year is needed is decided
 * from the library's own holdings, not OMDb's catalogue - plenty of obscure
 * films share a title with a famous one, and prompting about a film nobody
 * has is just noise. Leaving this off also saves an OMDb call on every
 * request that omits a year, which matters on the free tier's daily quota.
 */
export async function lookupMovie(requestText, { apiKey, signal, threshold = 0.72, detectAmbiguous = false, retry = true } = {}) {
  const year = extractYear(requestText);
  const title = cleanRequestText(requestText);
  if (!title) return null;

  // When no year was given, check whether the title alone is enough to
  // identify a film. If several share it, the requester has to say which.
  let ambiguous = null;
  if (!year && detectAmbiguous) {
    try {
      const sameTitled = await findSameTitled(title, apiKey, signal, { retry });
      if (sameTitled.length > 1) {
        logger.info(`"${title}" is ambiguous: ${sameTitled.map((m) => m.year).join(', ')}`);
        ambiguous = sameTitled;
      }
    } catch (err) {
      // Not being able to check is no reason to fail the request.
      logger.warn(`ambiguity check failed: ${err.message}`);
    }
  }

  // Direct title hit.
  //
  // OMDb's `t=` returns exactly one best guess and will happily hand back a
  // companion piece for a slightly-off query: "The Hobbit: The battle Of Five
  // Armies" (one word short) returned the making-of documentary "…- New
  // Zealand: Home of Middle-Earth - Part 3", which is not in the library, so
  // the requester was told the film was missing when it was there and simply
  // rated R. Similarity does not catch this on its own - the impostor opens
  // with the asked title verbatim and scored 0.94 against the real film's
  // 0.95 - so a hit carrying a lot of EXTRA title is verified by search
  // before it is trusted.
  //
  // So is a hit that carries the title exactly but looks like something no
  // member means - an audiobook, a riff track, a short (obscureReason, and
  // the Star Wars requests of 2026-10-11 told above it). Search then has to
  // turn up a well-known film that names the request at least as well, or
  // the hit stands as before.
  //
  // A hit without the number the request ends with is not the film asked
  // for at all, and is not kept even as a last resort (keepsSequelNumber):
  // "fast and furios 6" is no request for Fast and Furious (1939), the film
  // the relaxed search made of it on 2026-10-11.
  const number = sequelNumber(title);
  let direct = null;
  let obscure = null;
  try {
    const data = await omdbFetch({ t: title, y: year, type: 'movie', plot: 'short' }, apiKey, signal, { retry });
    direct = shape(data);
    if (!carriesNumber(direct.title, number, { typed: title })) {
      logger.info(`"${direct.title}" (${direct.year}) has no ${number}, the number "${requestText}" ends with`
        + ' - not the film asked for');
      direct = null;
    } else if (!looksPadded(title, direct.title)) {
      obscure = obscureReason(direct);
      if (!obscure) {
        logger.info(`resolved "${requestText}" -> ${direct.title} (${direct.year}) [direct]`);
        return { movie: direct, confidence: similarity(title, direct.title), method: 'direct', ambiguous };
      }
      logger.info(`"${direct.title}" (${direct.year}) looks like ${obscure} - checking search before trusting it`);
    } else {
      logger.info(`"${direct.title}" carries more title than was asked for - checking search before trusting it`);
    }
  } catch (err) {
    if (err.code !== 'NOT_FOUND') throw err;
  }

  // Looking past an obscure hit is a second opinion. It never fails a request
  // the hit would have answered on its own: an OMDb error on the way (its
  // daily limit, a timeout) keeps the hit, as before.
  const lookPast = async (hit, why, pool, maxCalls) => {
    try {
      const known = await preferKnownFilm(title, year, hit, pool, { apiKey, signal, maxCalls, retry });
      if (known) {
        logger.info(`resolved "${requestText}" -> ${known.movie.title} (${known.movie.year}) [known film, `
          + `${known.votes} votes, fit ${known.fit.toFixed(2)}] rather than ${hit.title} (${hit.year}), ${why}`);
        return { movie: known.movie, confidence: Math.min(1, known.fit), method: 'known-film', ambiguous };
      }
      const nth = await franchiseSequel(title, year, { apiKey, signal, retry });
      if (nth) {
        logger.info(`resolved "${requestText}" -> ${nth.movie.title} (${nth.movie.year}) [film number ${sequelNumber(title)} `
          + `of its franchise, ${nth.votes} votes] rather than ${hit.title} (${hit.year}), ${why}`);
        return { movie: nth.movie, confidence: 0.9, method: 'franchise-number', ambiguous };
      }
      logger.info(`no well-known film answers "${requestText}" as well as ${hit.title} (${hit.year}) - keeping it`);
    } catch (err) {
      if (signal?.aborted) throw err;
      logger.warn(`could not look past ${hit.title} (${hit.year}) for "${requestText}": ${err.message}`);
    }
    return null;
  };

  // Search fallback
  let results = [];
  // "ocean's 11 (2001)", 2026-09-22 06:34: OMDb answered the search with "Too
  // many results." although the request carried a year, and that error went
  // straight back to the requester as "add a year" - to a request that had
  // one. A year is exactly what narrows a broad title, so with one the search
  // carries on below, restricted to that year, instead of giving up here.
  let tooBroad = null;
  try {
    const data = await omdbFetch({ s: title, y: year, type: 'movie' }, apiKey, signal, { retry });
    results = keepsSequelNumber(title, data.Search ?? []);
  } catch (err) {
    if (year && isTooBroad(err)) tooBroad = err;
    else if (obscure && !signal?.aborted) {
      if (err.code !== 'NOT_FOUND') logger.warn(`search past ${direct.title} for "${requestText}" failed: ${err.message}`);
    } else if (err.code !== 'NOT_FOUND') throw err;
  }

  // The direct hit matched the words; only a better-known film can displace
  // it, never pickBest's choice among the search results, which would trade
  // one obscure exact title for another.
  if (obscure) {
    return await lookPast(direct, obscure, results, 3)
      ?? { movie: direct, confidence: similarity(title, direct.title), method: 'direct', ambiguous };
  }

  let best = pickBest(title, year, results, threshold);
  let searched = results;
  let relaxedUsed = false;

  // Nothing yet - the request is probably misspelled. OMDb does no fuzzy
  // matching at all ("the dark night rises" returns nothing), so instead of
  // giving up, drop one word at a time and search the remainder. Whichever
  // word carries the typo, one of those sub-queries is spelled correctly
  // and surfaces the real film, which is then scored against the FULL
  // original request rather than the sub-query.
  //
  // When the whole title was too broad, the sub-queries are searched in the
  // requested year and only a film FROM that year may win. Without that,
  // "ocean" pulls in "Ocean's 11" (1960), which outscores "Ocean's Eleven"
  // (2001) on the title alone and would send the other film.
  if (!best) {
    const relaxed = await relaxedSearch(title, apiKey, signal, { retry, ...(tooBroad ? { year } : {}) });
    const inYear = tooBroad
      ? relaxed.filter((r) => Number(r.Year?.match(/\d{4}/)?.[0]) === year)
      : relaxed;
    const pool = keepsSequelNumber(title, inYear);
    relaxedUsed = true;
    searched = [...results, ...pool];
    if (pool.length) {
      best = pickBest(title, year, pool, threshold);
      if (best) {
        logger.info(`recovered "${requestText}" -> ${best.r.Title} via relaxed search`
          + `${tooBroad ? ` in ${year} (the whole title was too broad for OMDb)` : ''}`);
      }
    }
  }

  if (!best) {
    // A padded direct hit is still better than nothing - it is what OMDb
    // thought, and refusing outright would turn a slightly-off request into
    // "couldn't match that title" when we do have a candidate.
    if (direct) {
      logger.info(`falling back to the direct hit "${direct.title}" - search found nothing better`);
      return { movie: direct, confidence: similarity(title, direct.title), method: 'direct-padded', ambiguous };
    }
    // Still too broad even within the year: say so, as before, and let the
    // caller decide - the request plugin then searches the library.
    if (tooBroad) {
      logger.info(`"${requestText}" is too broad for OMDb even within ${year}`);
      throw tooBroad;
    }
    logger.info(`no confident match for "${requestText}" after relaxed search`);
    return null;
  }

  // Re-fetch by IMDb id to get the full record (search results are sparse).
  const full = await omdbFetch({ i: best.r.imdbID, plot: 'short' }, apiKey, signal, { retry });
  const movie = shape(full);

  // Search's own winner can be just as obscure: "star wars episode 4" found
  // nothing by `t=`, and its search held one result, an audiobook of the
  // Revenge of the Sith novelization whose title ends "Book 4". After the
  // relaxed search has already spent its calls, only the record of the best
  // candidate already in hand is fetched.
  const doubt = obscureReason(movie);
  if (doubt) {
    logger.info(`"${movie.title}" (${movie.year}) looks like ${doubt} - checking for a better-known film`);
    const known = await lookPast(movie, doubt, searched, relaxedUsed ? 1 : 3);
    if (known) return known;
  }
  logger.info(`resolved "${requestText}" -> ${movie.title} (${movie.year}) [search ${best.score.toFixed(2)}]`);
  return { movie, confidence: best.score, method: 'search', ambiguous };
}

/**
 * The film called exactly `title` that OMDb files one year either side of
 * `year`, or null.
 *
 * For a version the bot itself offered from the library ("2. Venom (2011)").
 * Jellyfin's ProductionYear and OMDb's year disagree by one often enough that
 * verifyFileRating already tolerates it - a festival year against a release
 * year - and the `y=` filter in lookupMovie does not, so a listed version
 * came back ❓ "couldn't find that title" moments after the bot said it had
 * it (found in review, 2026-09-22). Only the exact title is accepted, so this
 * cannot wander to a different film; the rating it returns is gated as any
 * other. Two `t=` calls at most, and only after the exact year found nothing.
 */
export async function lookupNearYear(title, year, { apiKey, signal, retry = true } = {}) {
  const wanted = normalizeTitle(title);
  if (!wanted || !year) return null;
  for (const y of [year - 1, year + 1]) {
    let data;
    try {
      data = await omdbFetch({ t: title, y, type: 'movie', plot: 'short' }, apiKey, signal, { retry });
    } catch (err) {
      if (err.code === 'NOT_FOUND') continue;
      throw err;
    }
    const movie = shape(data);
    if (normalizeTitle(movie.title) === wanted && movie.year && Math.abs(movie.year - year) <= 1) {
      logger.info(`"${title}" is not in OMDb for ${year}, but is for ${movie.year} - taking that as the same film`);
      return { movie, confidence: 1, method: 'near-year' };
    }
  }
  return null;
}

/**
 * The panel's "Test key": one try, never tried again (omdbFetch). Its answer
 * is a diagnosis of OMDb as it is now - "OMDb is failing on its side — OMDb
 * HTTP 525" - and a retry 5 s on would only have turned that into the key
 * test's own 12 s timeout (key-test-routes.js).
 */
export async function testApiKey(apiKey, signal) {
  try {
    await omdbFetch({ t: 'The Matrix', y: 1999, type: 'movie' }, apiKey, signal, { retry: false });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
