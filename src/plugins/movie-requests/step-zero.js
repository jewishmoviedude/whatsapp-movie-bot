/**
 * Step 0 of a movie request: what the library alone says about a title asked
 * for with no year, before OMDb or the AI check is asked anything. It lists
 * the sendable films whose titles start with the words typed, asks for
 * another word when there are too many, goes ahead with the one film that
 * can be sent, or stands aside (decidePickList in pick-list.js has the
 * rules). Since 2026-10-11 it does so in every request group, with no beta
 * flag.
 *
 * It lives outside the plugin because two callers must reach the same
 * answer: a request (_offerPickList in index.js) and the panel's Test tab
 * (POST /test/request in src/web/api.js). The dry run had only the year
 * question a request asks at step 4a, and once the list left beta it told
 * the operator "Ambiguous — needs a year" for Heat and Venom, which members
 * were shown the list for, and for the one Frozen that is not R, which a
 * request sent (review of that change). A dry run that says the opposite of
 * what a request does is what the Test tab is there to rule out.
 */
import { libraryVersions } from './library.js';
import { lookupMovie, lookupNearYear } from './omdb.js';
import { aiCanClear } from './content-check.js';
import { decidePickList, pickListSettings } from './pick-list.js';
import { cleanRequestText, extractYear } from '../../util/fuzzy.js';

/**
 * Whether step 0 runs for a request at all: only with no year typed (one
 * with a year has already answered the question), and only while the
 * operator wants the question asked (requireYearWhenAmbiguous).
 */
export function asksWhichOne(cfg, text) {
  return !!cfg?.requireYearWhenAmbiguous && !extractYear(text);
}

/**
 * The two strings step 0 works from, deliberately. `typed` is what the
 * member sent with only the year, the emoji and the politeness words taken
 * out; `searchTerm` also drops "movie" and "film". Dropping them is right
 * for a Jellyfin search and wrong for a match, because films are called The
 * Muppet Movie and Scary Movie: matching on the short one queued The Muppet
 * Christmas Carol for a member who typed "the muppet movie" (found in
 * review), which is the Deathly Hallows incident again. The search is still
 * made on the short one, which can only ever find more.
 */
export function pickTerms(text) {
  return {
    searchTerm: cleanRequestText(text) || text,
    typed: cleanRequestText(text, { keepMediaWords: true }) || text,
  };
}

/**
 * Search the library once and decide. Returns null when the library is not
 * Jellyfin, since nothing else reports the ratings a list is vetted on, and
 * throws when the search fails; a request then carries on without a list.
 *
 * Otherwise { decision, query, searchTerm, typed, widened }: `decision` is
 * decidePickList's, `query` the words it was made on, and `widened` says
 * those are the shorter words (below).
 */
export async function stepZero(text, config, { store = null, onTokenRefreshed } = {}) {
  const cfg = config.movieRequests;
  const { searchTerm, typed } = pickTerms(text);
  const found = await libraryVersions(searchTerm, config.library, {
    // Shorter than the pipeline's own search: if this one hangs, the
    // request still gets its ordinary answer rather than waiting twice.
    timeoutMs: Math.min(config.library?.searchTimeoutMs ?? 180000, 60000),
    onTokenRefreshed,
  });
  if (!found) return null;

  // A rated film the AI check could clear is listed too (listableVersions);
  // the check is asked only about the one that is picked.
  const opts = {
    store, maxOptions: pickListSettings(cfg).maxOptions, aiClears: aiCanClear(config.gemini, config.ai),
  };
  let query = typed;
  let decision = decidePickList(query, found, cfg, { ...opts, searchTerm });
  let widened = false;
  // Nothing on the server is called anything starting with what they typed,
  // and what they typed has "movie" or "film" in it. Those are title words
  // often enough to match on, but they are also just how people talk - "the
  // new spiderman movie" - and stopping here would hand that back to OMDb's
  // best guess, which is exactly how the Deathly Hallows got queued. So the
  // shorter words get a second look, and only a QUESTION may come of it: a
  // list, or "add a word or the year". Never a film queued unasked, which
  // is the mistake matching on the short words made in the first place.
  if (decision.kind === 'none' && !decision.versions.length && searchTerm !== typed) {
    const wider = decidePickList(searchTerm, found, cfg, opts);
    if (wider.kind === 'list' || wider.kind === 'narrow') {
      query = searchTerm;
      decision = wider;
      widened = true;
    }
  }
  return { decision, query, searchTerm, typed, widened };
}

/**
 * OMDb's film for a request made under a LIBRARY title and year - a pick
 * from a list, or the one film step 0 went ahead with - when OMDb has
 * nothing under exactly that title and year. Returns { found, how }, or null:
 *
 *   'near-year'  the same title a year either side. Jellyfin and OMDb often
 *                file a film a year apart (a festival year against a
 *                release year), and the member would get ❓ for something
 *                the bot had just offered them.
 *   'as-typed'   the words the member typed (`asTyped`), only for the one
 *                film step 0 went ahead with.
 *
 * The second is for a library that names a film its own way. "Mission:
 * Impossible - Dead Reckoning", held as "... Dead Reckoning Part One", is
 * the one film starting with those words, so step 0 goes ahead with it
 * under the library's title; an OMDb that knows the film only by the words
 * typed then found nothing, and a film the server holds ended ❓. While the
 * list was beta001 that could happen only in the beta group; once it went to
 * every group (2026-10-11) it would have in the main groups too, where the
 * words typed had always found it (test/near-title-other-year.test.mjs). So
 * the request is looked up as typed instead, and goes on from there as it
 * did before step 0 existed.
 *
 * `onError(how, err)` hears about a lookup that failed, for the log.
 */
export async function lookupHeldFilm(text, { apiKey, asTyped = null, onError = () => {} } = {}) {
  try {
    // `text` here is a LIBRARY title and year, so "movie" and "film" in it
    // are part of the name: stripping them asked OMDb about "The Garfield"
    // when the film offered was The Garfield Movie.
    const near = await lookupNearYear(cleanRequestText(text, { keepMediaWords: true }), extractYear(text), { apiKey });
    if (near) return { found: near, how: 'near-year' };
  } catch (err) {
    onError('near-year', err);
  }
  if (!asTyped) return null;
  try {
    const typed = await lookupMovie(asTyped, { apiKey });
    if (typed) return { found: typed, how: 'as-typed' };
  } catch (err) {
    onError('as-typed', err);
  }
  return null;
}
