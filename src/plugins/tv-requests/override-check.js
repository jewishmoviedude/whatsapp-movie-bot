/**
 * The episodes of a TV request that the rating filter would withhold, and
 * which of them go out after all: those the bypass list covers, and those
 * the AI content check clears.
 *
 * The operator's rule, 2026-09-29, for TV as for films (content-check.js has
 * the whole of it):
 *
 *  - An episode an entry on the bypass list covers is sent, with no AI check
 *    and no kept answer consulted: "Send it, no AI check". Fullmetal
 *    Alchemist: Brotherhood (2009) is TV-14, and its S01E14, S01E19 and
 *    S01E26 are TV-MA - for violence; a member got 61 of 64 episodes and was
 *    refused E14 on its own twice on 2026-09-28. An entry covers a show by
 *    its exact name ("Exact title only", 2026-09-29): the one on the live
 *    list is "Fullmetal Alchemist: Brotherhood season 1" (rating-overrides.js).
 *  - Any other episode its rating blocks is asked about one by one, when the
 *    answer could send it: "The AI check is so the request can go through
 *    without getting denied if possible". A sure "no nudity" from a provider
 *    allowed to clear rated titles sends it; anything else leaves it
 *    withheld on its rating, as it always was (decide()). With the check
 *    off, allowCleanRatedFilms off, or no provider allowed to clear, nothing
 *    is asked (aiCanClear).
 *  - An episode the rating never blocked is sent and never asked about, and
 *    no answer about one episode holds back any other: "No, AI only helps".
 *
 * With nothing on the list covering a blocked episode and nothing to ask,
 * screenRated returns null and the plugin takes its old path word for word.
 *
 * Asking about episodes one by one could spend a provider's daily allowance
 * on a single request - Gemini's free tier is 20 a day, and films are asked
 * about from the same allowance. So an answer is kept per episode
 * (CACHE_KEY, in the TV plugin's store); one check runs at a time across the
 * whole process, spaced by LIMITS.paceMs; one message asks at most
 * LIMITS.maxChecks, in LIMITS.budgetMs, and stops asking at the first check
 * that could not run, rather than walking every remaining episode into the
 * same quota wall. What it did not get to stays withheld on its rating, and
 * asking again later picks up where it stopped.
 *
 * One message, not one season: a message asking for several seasons is one
 * request per season (tv-requests/index.js, _runSeasons), and they share one
 * `budget`. Each season used to start afresh, so "The Boys seasons 1-3", a
 * TV-MA show with Gemini out of quota, made three failing calls - one per
 * season - and three seasons of 22 episodes could make 90 checks and hold 🔍
 * for fifteen minutes, where one request was capped at 30 checks and five
 * minutes. Thirty was itself more than Gemini's day: one TV request left
 * every R film asked for afterwards "did not run: quota-daily" until
 * midnight Pacific, films the check would have sent (both found in review,
 * 2026-09-29). So a message now asks about ten episodes at most, across all
 * its seasons, and leaves the rest of the day's allowance to other requests.
 *
 * Nor does a request ask about an episode that could not be queued anyway:
 * episodes are taken in queue order, and once maxEpisodesPerRequest is
 * spoken for, or the queue has no place for the request (`limit`), the rest
 * are left unasked (`unreached`) - a request refused as "the queue is full"
 * used to spend its checks first. An episode already waiting in the queue is
 * not asked about either (`waiting`): it is not queued again, and was checked
 * for the request that holds it.
 */
import {
  listOverrides, tvOverrideFor, jellyfinIdFrom, entryCoversName, describeOverride,
} from '../../core/rating-overrides.js';
import {
  checkEpisodeNudity, decide, mayClearRated, clearingBar, aiCanClear, notClearedWhy,
} from '../movie-requests/content-check.js';
import { providerLabel, chainPlan } from '../../core/ai-providers.js';
import {
  episodeDetails, describeTvItem, findTwins, listItemNames,
} from './jellyfin-tv.js';
import { episodeOrder } from './naming.js';
import { compactRuns, listProse } from './withheld.js';

/** Where the per-episode answers are kept, in the TV plugin's store. */
export const CACHE_KEY = 'override-checks';

const DAY = 24 * 60 * 60 * 1000;

/**
 * How long an answer is trusted. A sure "no nudity" from a provider allowed
 * to clear rated titles sends the episode, describes an episode that does
 * not change, and is kept for months. Every other answer - "nudity", unsure,
 * or a "no nudity" from a provider the operator has not trusted - sends
 * nothing and is kept a day: not asked again on every request today, but
 * asked again tomorrow, when a provider that can clear it may answer.
 */
export const CACHE_TTL = Object.freeze({ sure: 180 * DAY, unsure: DAY });
// Only episodes put to the check are ever kept, so this is far more than a
// real library reaches; it only stops state.json growing without bound.
const CACHE_MAX = 1000;

/**
 * Pacing, adjustable by tests. Two seconds between checks keeps a burst of
 * episodes under every provider's per-minute limit that the breakers do not
 * already route around; ten checks a message is half of Gemini's free day
 * (see the header), enough for the few rated episodes of a show like FMA:B;
 * five minutes bounds how long a requester can be left looking at 🔍. Both
 * are for a whole message, however many seasons it asks for (`budget`).
 */
export const LIMITS = { paceMs: 2000, maxChecks: 10, budgetMs: 5 * 60 * 1000 };

// One check at a time across the process, whichever request asked, so two
// seasons requested together do not double the rate a provider sees.
let tail = Promise.resolve();
let lastCallAt = 0;
function serial(fn) {
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run;
}

/** Forget the pacing clock. Tests only. */
export function resetPacing() { lastCallAt = 0; tail = Promise.resolve(); }

/** The rating that withholds this episode, or null: the series', else its own. */
export function blockingRating(ep, { blocked = [], seriesRating = null } = {}) {
  if (seriesRating) return seriesRating;
  const r = String(ep?.rating ?? '').toUpperCase();
  return r && blocked.includes(r) ? r : null;
}

/**
 * A kept answer for this library item, or null.
 *
 * Only when it was given about the same episode (`subject`: series name and
 * SxxEyy). Jellyfin derives an item's id from its file path, so the id
 * survives a metadata fix or a change of episode order - common for anime
 * such as FMA:B, numbered differently by TVDB, TMDB and absolute order - and
 * an answer about "S01E14" must not be applied to the same file once it is
 * S01E19.
 *
 * Kept for months only when it sends the episode: a sure "no nudity" from a
 * provider that may clear a rated title as the operator has it now
 * (`clears`). Anything else is kept a day. A "nudity" used to be kept for
 * months, whoever said it, and held the episode back: on 2026-09-29
 * Gemini's model answered 503 all afternoon and Groq's gpt-oss-120b said
 * The Last Samurai had nudity, citing IMDb, which says it has none - an
 * FMA:B episode judged that way would have been withheld until 2027. Since
 * the AI only helps, a "nudity" holds back nothing the rating did not, and
 * is only a reason not to ask again today.
 */
function cached(cache, id, { minConfidence, now, subject, clears = mayClearRated }) {
  const hit = cache?.get?.(CACHE_KEY, {})?.[id];
  if (!hit?.verdict || !Number.isFinite(hit.at)) return null;
  if (subject && hit.subject !== subject) return null;
  const v = hit.verdict;
  // The same bar decide() holds a "no nudity" to, so an answer it will not
  // act on is not kept as if it would.
  const lasting = v.nudity === false && Number(v.confidence) >= clearingBar(minConfidence) && clears(v);
  return now - hit.at < (lasting ? CACHE_TTL.sure : CACHE_TTL.unsure) ? v : null;
}

function remember(cache, id, verdict, now, subject) {
  if (!cache?.set || !id || !verdict) return;
  try {
    const all = { ...(cache.get(CACHE_KEY, {}) ?? {}) };
    all[id] = { at: now, subject, verdict };
    const ids = Object.keys(all);
    if (ids.length > CACHE_MAX) {
      ids.sort((a, b) => (all[a].at ?? 0) - (all[b].at ?? 0));
      for (const old of ids.slice(0, ids.length - CACHE_MAX)) delete all[old];
    }
    cache.set(CACHE_KEY, all);
  } catch { /* an answer not kept is asked again next time */ }
}

/** Which episode an item is, so two library items of one episode count once (as in withheld.js). */
const keyOf = (ep) => (ep?.episode != null ? `${ep.season ?? ''}:${Number(ep.episode)}` : null);

const epCode = (ep) => `S${String(ep?.season ?? 0).padStart(2, '0')}E${String(ep?.episode ?? 0).padStart(2, '0')}`;

/**
 * Decide the rating-blocked episodes of one request: which the bypass list
 * sends, and which the AI check is asked about.
 *
 * `limit` is how many episodes this request can queue at most -
 * maxEpisodesPerRequest, or none when the queue has no place for it; a
 * function is called for it only when there is something to decide - and
 * `order` the order they are queued in. An episode that could not be queued
 * even if the check cleared it is not put to the check.
 *
 * `budget` is what the message this request belongs to has spent of
 * LIMITS.maxChecks and LIMITS.budgetMs, and whether a check of it could not
 * run: an object shared by every season of a message asking for several, and
 * written to here (`asked`, `started`, `stopped`). Without one, the request
 * is a message of its own.
 *
 * `waiting` is the ids of the episodes already waiting in the queue for this
 * destination (the TV plugin's duplicate check). An episode the check would
 * be asked about that is waiting already is not asked about - it was checked
 * for the request that holds it - and takes none of `limit`. It is returned
 * in `allowed` (it is in the queue, not withheld) and in `waiting`, and the
 * duplicate check then leaves it out as waiting. A listed episode needs no
 * check, and the duplicate check sorts it like any other.
 *
 * @returns null when the list covers no rating-blocked episode and the AI
 *   check has nothing to clear - the caller then behaves exactly as it did
 *   before - or
 *   {
 *     allowed:          the episodes to queue, in the order found: every one
 *                       the rating never blocked, every one the list covers,
 *                       every one the check cleared, and the waiting ones
 *     withheldOnRating: rating-blocked episodes not sent - none of the above,
 *                       and not unreached - each carrying the rating that
 *                       blocks it (the series' when that is what blocks it),
 *                       for describeWithheld
 *     bypassed:         [{ ep, rating, entry }], sent on the list
 *     cleared:          [{ ep, rating, verdict, call }], sent on the check
 *     notCleared:       [{ ep, rating, verdict, call, failure }], asked about
 *                       and not cleared (in withheldOnRating as well)
 *     unreached:        episodes the check would be asked about, past `limit`,
 *                       neither asked about nor queued; asking again later
 *                       reaches them
 *     waiting:          such episodes already in the queue (`waiting`), not
 *                       asked about
 *   }
 */
export async function screenRated({
  found, blocked = [], seriesRating = null, waiting = null,
  overrides = null, cache = null, gemini = {}, ai = null, jellyfin = null,
  minConfidence = 0.7,
  check = checkEpisodeNudity, details = episodeDetails,
  onResult = null, log = null,
  limit = Infinity, order = episodeOrder, budget = null,
  paceMs = LIMITS.paceMs, maxChecks = LIMITS.maxChecks, budgetMs = LIMITS.budgetMs,
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!found?.series || !Array.isArray(found.episodes)) return null;
  const listed = !!overrides && listOverrides(overrides).length > 0;
  const canClear = aiCanClear(gemini, ai);
  if (!listed && !canClear) return null;

  const rated = new Map();
  for (const ep of found.episodes) {
    const r = blockingRating(ep, { blocked, seriesRating });
    if (r) rated.set(ep, r);
  }
  if (!rated.size) return null;

  // In the order the caller queues them, so `limit` is spent the way the
  // queue spends it.
  const queued = order ? [...found.episodes].sort(order) : [...found.episodes];
  const isWaiting = (ep) => !!waiting?.has?.(String(ep?.id));
  const bypassed = [];
  const listedWaiting = [];       // on the list, and waiting in the queue already
  const toAsk = [];
  const inQueue = [];             // to be asked about, and waiting in the queue already
  let freeBefore = 0;             // episodes going out anyway, ahead of this one in the queue
  for (const ep of queued) {
    const rating = rated.get(ep);
    if (!rating) { if (!isWaiting(ep)) freeBefore += 1; continue; }
    const entry = listed ? tvOverrideFor(overrides, found.series, ep) : null;
    if (entry) {
      // One an earlier request already holds is that request's to report:
      // allowed here, for the duplicate check to sort, and not named as sent
      // by this one.
      if (isWaiting(ep)) listedWaiting.push({ ep });
      else { bypassed.push({ ep, rating, entry }); freeBefore += 1; }
      continue;
    }
    if (!canClear) continue;
    if (isWaiting(ep)) inQueue.push({ ep, rating });
    else toAsk.push({ ep, rating, freeBefore });
  }
  if (!bypassed.length && !listedWaiting.length && !toAsk.length && !inQueue.length) return null;
  // A function is asked here, once, so a request with nothing to decide
  // never asks the queue anything it did not ask before.
  const max = typeof limit === 'function' ? limit() : limit;

  // Whether each provider may clear a rated title, as the operator has it
  // NOW: a kept answer carries the trust its provider had when it answered,
  // and unticking a provider since must take its old "no nudity" with it.
  const trust = new Map(chainPlan({ gemini, ai: ai ?? {} }).map((p) => [p.id, p.canClearRated === true]));
  const current = (v) => (v?.provider && trust.has(v.provider) ? { ...v, canClearRated: trust.get(v.provider) } : v);
  const clears = (v) => mayClearRated(current(v));

  const cleared = [];
  const notCleared = [];
  const unreached = [];
  const judge = ({ ep, rating }, verdict, failure = null) => {
    const call = decide(current(verdict), true, { minConfidence, allowCleanRatedFilms: true });
    if (!call.blocked) cleared.push({ ep, rating, verdict, call });
    else notCleared.push({ ep, rating, verdict, call, failure });
  };
  // Could this episode still be queued, with what is already going ahead of
  // it? Episodes left out take no place, so a later one can still fit.
  const reachable = (c) => c.freeBefore + cleared.length < max;

  // The message's checks so far: this season's, and those of the seasons
  // before it (see the header).
  const b = budget ?? {};
  b.asked ??= 0;
  b.stopped ??= null;
  b.started ??= now();
  let info = null;              // episode details, fetched once, on the first real ask
  const sameEpisode = new Map(); // two library items of one episode get one answer
  const subjectOf = (ep) => `${found.series.name} ${epCode(ep)}`;
  const keptFor = (ep) => cached(cache, ep.id, { minConfidence, now: now(), subject: subjectOf(ep), clears });

  for (const c of toAsk) {
    const { ep } = c;
    if (!reachable(c)) { unreached.push(c); continue; }
    const subject = subjectOf(ep);
    const twin = keyOf(ep);
    const known = keptFor(ep) ?? (twin ? sameEpisode.get(twin) : null) ?? null;
    if (known) { judge(c, known); if (twin) sameEpisode.set(twin, known); continue; }

    const skip = b.stopped
      ?? (b.asked >= maxChecks ? { reason: 'too-many', summary: `more than ${maxChecks} episodes to check for one message` } : null)
      ?? (now() - b.started > budgetMs ? { reason: 'out-of-time', summary: 'the checks ran out of time' } : null);
    if (skip) { judge(c, null, skip); continue; }

    if (!info && jellyfin?.base && jellyfin?.token) {
      const ids = toAsk.filter((x) => !keptFor(x.ep)).map((x) => x.ep.id).slice(0, maxChecks - b.asked);
      try { info = await details(ids, jellyfin); } catch { info = new Map(); }
    }
    info ??= new Map();

    b.asked += 1;
    let failure = null;
    const verdict = await serial(async () => {
      // Another request may have asked about this episode while we waited.
      const meanwhile = keptFor(ep);
      if (meanwhile) return meanwhile;
      const wait = lastCallAt + paceMs - now();
      if (wait > 0) await sleep(wait);
      try {
        return await check(ep, found.series, gemini, {
          details: info.get(ep.id) ?? null,
          ai,
          onlyClearing: true,
          onResult: (r) => {
            if (!r.ok) failure = r.failure ?? { reason: 'unknown' };
            try { onResult?.(r, { ep, subject }); } catch { /* reporting only */ }
          },
        });
      } finally {
        lastCallAt = now();
      }
    });

    if (verdict) {
      remember(cache, ep.id, verdict, now(), subject);
      if (twin) sameEpisode.set(twin, verdict);
      judge(c, verdict);
    } else {
      // Could not run (or was cancelled). Everything after it would hit the
      // same wall, so it is not asked either; asking again later resumes.
      b.stopped = failure ?? { reason: 'no-answer' };
      judge(c, null, b.stopped);
    }
    log?.info?.(`TV AI check ${subject}: `
      + (verdict ? `nudity=${verdict.nudity} (${verdict.confidence}) by ${providerLabel(verdict.provider)}`
        : `did not run (${b.stopped?.reason ?? 'no answer'})`)
      + ` -> ${cleared.at(-1)?.ep === ep ? 'cleared' : 'not cleared, withheld on its rating'}`);
  }

  const sent = new Set([...bypassed, ...listedWaiting, ...cleared, ...inQueue].map((c) => c.ep));
  const unreachedSet = new Set(unreached.map((c) => c.ep));
  return {
    allowed: found.episodes.filter((ep) => !rated.has(ep) || sent.has(ep)),
    withheldOnRating: [...rated].filter(([ep]) => !sent.has(ep) && !unreachedSet.has(ep))
      .map(([ep, r]) => (String(ep.rating ?? '').toUpperCase() === r ? ep : { ...ep, rating: r })),
    bypassed,
    cleared,
    notCleared,
    unreached: unreached.map(({ ep, rating }) => ({ ep, rating })),
    waiting: inQueue,
  };
}

/** One per episode, and none that went out anyway as another copy of the same episode. */
function episodesOnce(rows, sent) {
  const seen = new Set();
  return rows.filter(({ ep }) => {
    const k = keyOf(ep);
    if (k == null) return true;
    if (sent.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function names(rows) {
  const nums = rows.map((r) => r.ep).filter((e) => e?.episode != null).map((e) => Number(e.episode));
  const others = rows.map((r) => r.ep).filter((e) => e?.episode == null).map((e) => (e?.title ? `"${e.title}"` : 'one without a number'));
  return { runs: [...compactRuns(nums), ...others], codes: [...compactRuns(nums).map((r) => `E${r.replace('–', '–E')}`), ...others].join(', ') };
}

const subjectOf = (rows) => (rows.length > 1 ? 'Episodes' : 'Episode');

/** Rows grouped by a key, in the order each key first appears. */
function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

/**
 * Everything History, the log and the requester are told about what the
 * bypass list and the AI check did to one request, or null when they did
 * nothing.
 *
 *   detail     "3 sent: on the bypass list (rating override for "full metal
 *               alchemist" by superadmin): E14, E19, E26 · 1 sent: rated,
 *               but no nudity (Gemini): E3 · 1 not cleared by the AI check
 *               (Groq said nudity), withheld on its rating: E7"
 *   sentences  what the requester is told, one per outcome that sent
 *              something (behind the tv-rating-notice flag, like the rest of
 *              the withheld notice). An episode the check did not clear is
 *              withheld on its rating, and the rating's own sentence
 *              (withheld.js) says so.
 *
 * `allowed` is what the request queues: an episode the check did not clear
 * whose other copy went out is not named as held.
 *
 * `queued`, once the caller knows it, is the episodes really going into the
 * queue, and only those are named as sent. screenRated lets through every
 * episode the list covers, and the request then queues the first
 * maxEpisodesPerRequest of them all: with the cap at 20, FMA:B season 1
 * queued E1-E20, and History and the group were told "E14, E19, E26" were
 * sent on the list - E26 never went (found in review, 2026-09-29).
 */
export function describeScreen(screen, allowed = [], { queued = null } = {}) {
  if (!screen) return null;
  const sent = new Set((allowed ?? []).map(keyOf).filter(Boolean));
  const going = queued ? new Set(queued.map((ep) => keyOf(ep) ?? `id:${ep?.id}`)) : null;
  const goes = (r) => !going || going.has(keyOf(r.ep) ?? `id:${r.ep?.id}`);
  const bypassed = episodesOnce((screen.bypassed ?? []).filter(goes), new Set());
  const cleared = episodesOnce((screen.cleared ?? []).filter(goes), new Set());
  const notCleared = episodesOnce(screen.notCleared ?? [], sent);
  if (!bypassed.length && !cleared.length && !notCleared.length) return null;

  const detail = [];
  const sentences = [];

  for (const rows of groupBy(bypassed, (b) => b.entry?.key).values()) {
    detail.push(`${rows.length} sent: on the bypass list (${describeOverride(rows[0].entry)}): ${names(rows).codes}`);
  }
  if (bypassed.length) {
    const many = bypassed.length > 1;
    sentences.push(`${subjectOf(bypassed)} ${listProse(names(bypassed).runs)} ${many ? 'are' : 'is'} on the bypass list, `
      + `so ${many ? 'they were' : 'it was'} included despite the rating.`);
  }

  if (cleared.length) {
    const by = [...new Set(cleared.map((c) => providerLabel(c.verdict?.provider)))].join(', ');
    detail.push(`${cleared.length} sent: rated, but no nudity (${by}): ${names(cleared).codes}`);
    const many = cleared.length > 1;
    const ratings = [...new Set(cleared.map((c) => c.rating))].join(' and ');
    sentences.push(`${subjectOf(cleared)} ${listProse(names(cleared).runs)} ${many ? 'are' : 'is'} rated ${ratings}, `
      + `but the content check found no nudity, so ${many ? 'they were' : 'it was'} included.`);
  }

  for (const [why, rows] of groupBy(notCleared, (h) => notClearedWhy(h))) {
    detail.push(`${rows.length} not cleared by the AI check (${why}), withheld on ${rows.length > 1 ? 'their' : 'its'} rating: `
      + names(rows).codes);
  }

  return {
    detail: detail.join(' · '),
    sentences,
    bypassedCount: bypassed.length,
    clearedCount: cleared.length,
    notClearedCount: notCleared.length,
  };
}

/**
 * What a pasted Jellyfin link is, for the entry the panel is adding: a film
 * ('film') or a series, season or episode ('tv'), and what it covers in
 * words. A series link also records the show's other library entries
 * (`twinIds`, findTwins), since the episodes of a split show can come from
 * either. The link matches on its id whatever this says - it is looked up so
 * the list can say what it is.
 *
 * Resolves to { kind, covers, twinIds? } for parseEntry's `resolved`, or
 * null when it is not a link, Jellyfin is not configured, cannot be reached,
 * or holds nothing with that id; the entry is then saved as typed, and the
 * panel's "matches now" line says what it matches. Never throws: nothing an
 * admin adds is refused here.
 */
export async function describeLink(input, { base, token, userId, fetchImpl = fetch } = {}) {
  const id = jellyfinIdFrom(input);
  if (!id || !base || !token) return null;
  const opts = { base, token, userId, fetchImpl };
  let item;
  try { item = await describeTvItem(id, opts); } catch { return null; }
  if (!item) return null;
  if (item.type === 'movie') return { kind: 'film', covers: item.covers };
  if (!['series', 'season', 'episode'].includes(item.type)) return item.covers ? { covers: item.covers } : null;
  if (item.type !== 'series' || !item.series) return { kind: 'tv', covers: item.covers };
  let twins = [];
  try { twins = await findTwins(item.series, opts); } catch { /* the link alone still covers its own entry */ }
  const twinIds = twins.map((t) => String(t.id).toLowerCase()).filter((t) => t && t !== id);
  return {
    kind: 'tv',
    covers: twinIds.length ? `${item.covers} (in ${twinIds.length + 1} library entries)` : item.covers,
    ...(twinIds.length ? { twinIds } : {}),
  };
}

/** How long a listing of the library's names is reused. */
export const NAMES_TTL_MS = 10 * 60 * 1000;
const namesCache = new Map();

/** Forget the listed names. Tests only. */
export function resetLibraryNames() { namesCache.clear(); }

async function namesOf(type, opts, now) {
  const key = `${opts.base}|${opts.userId ?? ''}|${type}`;
  const hit = namesCache.get(key);
  if (hit && now - hit.at < NAMES_TTL_MS) return hit.items;
  const items = await listItemNames(type, opts);
  namesCache.set(key, { at: now, items });
  return items;
}

/**
 * What each entry matches in the library right now, for the panel - as
 * information, never as a reason to refuse or to send anything: the request
 * paths match entries against the library item they are sending
 * (isOverridden, tvOverrideFor). Since an entry sends what it covers with no
 * AI check, this line is how an admin sees what that is.
 *
 * A title is matched against the name of every film and show the bot's
 * Jellyfin user can see, by the rule the request paths use: the exact title,
 * since the operator's "Exact title only" (2026-09-29), so the line lists
 * no name the entry is only the start of (entryCoversName).
 * A link is looked up by its id. `films` is false when the film library is
 * not Jellyfin (Plex, or a folder), and films are then not listed.
 *
 * Resolves to { checked: true, films, matches: { [key]: { count, items } } },
 * `items` the first `max` matches as { name, year, type }, or to
 * { checked: false, reason } when Jellyfin is not configured or cannot be
 * listed.
 */
export async function libraryMatches(entries, { base, token, userId, fetchImpl = fetch, films = true, max = 8, now = Date.now() } = {}) {
  if (!base || !token) return { checked: false, reason: 'Jellyfin is not configured' };
  const opts = { base, token, userId, fetchImpl };
  const list = entries ?? [];
  const matches = {};
  try {
    const titles = list.filter((e) => e.title);
    const [shows, movies] = titles.length
      ? await Promise.all([namesOf('Series', opts, now), films ? namesOf('Movie', opts, now) : []])
      : [[], []];
    for (const e of titles) {
      const found = [
        ...movies.filter((i) => entryCoversName(e, { ...i, type: 'film' })).map((i) => ({ ...i, type: 'film' })),
        ...shows.filter((i) => entryCoversName(e, { ...i, type: 'tv' })).map((i) => ({ ...i, type: 'tv' })),
      ].sort((a, b) => String(a.name).localeCompare(String(b.name)) || (a.year ?? 0) - (b.year ?? 0));
      matches[e.key] = { count: found.length, items: found.slice(0, max).map(({ name, year, type }) => ({ name, year, type })) };
    }
    for (const e of list.filter((x) => x.jellyfinId)) {
      let item = null;
      try { item = await describeTvItem(e.jellyfinId, opts); } catch { continue; }
      matches[e.key] = item
        ? { count: 1, items: [{ name: item.covers ?? `Jellyfin item ${e.jellyfinId}`, year: null, type: item.type === 'movie' ? 'film' : 'tv' }] }
        : { count: 0, items: [] };
    }
  } catch (err) {
    return { checked: false, reason: `the library could not be listed (${err.message})` };
  }
  return { checked: true, films, matches };
}
