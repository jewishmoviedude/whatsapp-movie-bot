/**
 * The gates a film passes on its way out - its rating, the bypass list, and
 * what the AI content check can do for it - as one piece of code that the
 * request path, the panel's Re-run and queue-from-a-link, and the panel's dry
 * run all call.
 *
 * The dry run kept its own copy of the rating step, and the copy had never
 * heard of the override list. On 2026-09-29 the operator put The Last Samurai
 * (2003), Collateral (2004) and Fullmetal Alchemist: Brotherhood season 1 on
 * the list, dry-ran The Last Samurai at 16:23 UTC, and was told "Blocked:
 * rating". "Items I added to rated r bypass still showing as bot will
 * block." With one gate for both, a dry run says what a request does.
 *
 * The rule the gates apply is the operator's, of 2026-09-29 (content-check.js
 * has the whole of it): a title on the bypass list is sent with no AI check -
 * "Send it, no AI check"; a title its rating lets through is sent, and no
 * model is asked; and a title its rating blocks is sent only when the AI
 * check clears it, where the operator allows that - "The AI check is so the
 * request can go through without getting denied if possible". The AI never
 * refuses anything: "No, AI only helps".
 *
 * The rating is asked about in three places, because the library lookup sits
 * between them:
 *
 *  - ratingGate(), before the library: the letter grade, and the entry that
 *    covers the film by its requested title. A film its letter blocks is
 *    refused here only when nothing later could send it: no entry could
 *    cover the library's copy, and the AI check cannot clear it.
 *  - fileGate(), once the library has answered: when the library's file does
 *    not look like the film that was vetted, the file's own rating, and
 *    whether it is the same film at all (verifyFileRating).
 *  - contentGate(), once the library's film is known: the entry is looked for
 *    again with the library's title and id (an entry added by Jellyfin link),
 *    an unrated film is judged as the operator set blockUnrated, and the AI
 *    check is asked only when its answer could send a title the rating
 *    blocks (aiCanClear).
 */
import { isBlockedRating } from './theatrical.js';
import { checkNudity, decide, aiCanClear } from './content-check.js';
import { lookupMovie } from './omdb.js';
import { similarity, differentFilm, whyOtherFilm, idYearsAgree } from '../../util/fuzzy.js';
import {
  isOverridden, mayCoverFilms, bypassNote, entryCoversName, sameTitle,
} from '../../core/rating-overrides.js';

/**
 * The letter-grade step.
 *
 * A film its letter blocks, and that no entry covers by the title asked for,
 * used to be refused here, before the library was asked anything. Two things
 * can still send such a film, and both need the library's answer first: an
 * entry added by Jellyfin link, which matches the library's item and nothing
 * else - so a free-text request for a listed film was refused, the list
 * looking ignored again - and the AI check, which is asked about the film the
 * library holds. So the refusal waits (`deferred`) whenever either could
 * apply, and the request refuses the film on its rating once the library has
 * answered, exactly as it would have here, when neither does.
 *
 * @param store  the override list's store (the movie plugin's namespace)
 * @param movie  the film as the metadata resolved it: { title, year, rated }
 * @param cfg    the movieRequests config section
 * @param opts.gemini, opts.ai  the gemini and ai config sections, for aiCanClear
 * @returns {{ blocked, override, refused, deferred }}
 *   blocked   its rating is on the blocked list
 *   override  the entry covering it by title, or null
 *   refused   refuse it here: blocked, no entry covers it, and nothing that
 *             needs the library could send it
 *   deferred  blocked and not covered, but an entry could still cover the
 *             library's copy or the AI check could clear it: decided once the
 *             library has answered
 */
export function ratingGate(store, movie, cfg = {}, { gemini = null, ai = null } = {}) {
  const blocked = isBlockedRating(movie?.rated, cfg.blockedRatings ?? []);
  const override = store ? isOverridden(store, movie) : null;
  const open = blocked && !override;
  const later = open && ((!!store && mayCoverFilms(store)) || aiCanClear(gemini, ai));
  return { blocked, override, refused: open && !later, deferred: later };
}

/**
 * Is `found` (what the library holds) a different film from `wanted`?
 *
 * Title similarity alone missed a prefix: "Barefoot" (2014) scores 0.985
 * against "Barefoot Gen" (1983) because the matcher forgives a subtitle the
 * requester left off. Mia asked for Barefoot 2014 twice and was sent the
 * 1983 anime both times. A forgiven subtitle is only believable when the years
 * agree, so a title that is not identical and a year more than one apart is
 * another film - differentFilm(), the same rule findInLibrary now applies
 * before a file is ever called a hit. Here it is the last line of defence,
 * for a file whose own metadata re-resolved to something else.
 *
 * So is a film more than a year from the one the member typed (`typedYear`,
 * see typedYearOf), whatever its title: the operator's "Not in library" for
 * Dune (2021) asked for as "Dune 1984".
 */
export function isOtherFilm(wanted, found, { typedYear = null } = {}) {
  return !!otherFilmReason(wanted, found, { typedYear });
}

/** isOtherFilm's answer with its reason, 'film' or 'year' (see whyOtherFilm), or null. */
function otherFilmReason(wanted, found, { typedYear = null } = {}) {
  // A year in brackets after a title is the catalogue's label, not part of
  // the name: OMDb resolved "avengers: endgame encore" to an entry titled
  // "Avengers: Endgame (2019)" (2026-10-04), which scored 0.79 against the
  // library's "Avengers: Endgame", so the real file was refused as a
  // different film. Only the two film records are cleaned, never what a
  // member typed ("ocean's 11 (1999)" must stay a request for 1999).
  const bare = (f) => ({ ...f, title: String(f.title).replace(/^(.*\S)\s*\((?:19|20)\d{2}\)\s*$/, '$1') });
  wanted = bare(wanted); found = bare(found);
  // OMDb sometimes resolves a film to a listing for an event around it:
  // "The Hunger Games: The Ballad of Songbirds and Snakes - The IMAX Live
  // World Premiere Red Carpet, Lionsgate" (2023-10-22, Zoe), with an IMDb id
  // of its own. The library's real film, "...Songbirds & Snakes", was refused
  // as a different film and she was told it was not there. A title that is the
  // library's title plus a " - " tail, in the same year, is that film.
  const core = (t) => String(t).toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ').trim();
  const head = core(wanted.title).split(/\s+-\s+/)[0];
  if (head !== core(wanted.title) && head === core(found.title)
    && Number(wanted.year) && Number(wanted.year) === Number(found.year)) return null;
  // One IMDb id is one film, however its two names differ (a British and an
  // American title, as with the Philosopher's and the Sorcerer's Stone).
  if (wanted.imdbId && found.imdbId && String(wanted.imdbId).toLowerCase() === String(found.imdbId).toLowerCase()) return null;
  if (similarity(String(wanted.title), String(found.title)) < 0.9) return 'film';
  return whyOtherFilm(wanted, found, { typedYear });
}

/**
 * Is `sent` - the film 4b settled on for the library's file `hit` - the film
 * that was asked for, `requested`?
 *
 * The wanted list and the not-in-library list are answered for the film that
 * arrived, and only that one. On review of the Barefoot fix (2026-09-29), a
 * request for Dune (1984) with only Dune (2021) on the server sent the 2021
 * film - the same title, so not refused as another film - and took Dune (1984)
 * off the wanted list and marked its miss "turned up later", though the server
 * still did not have it. "Dune 1984" typed so is now not in the library at
 * all (typedYearOf); a bare "dune" that OMDb resolves to one Dune, with only
 * the other on the server, is still sent that one, and is why this is asked.
 *
 * When 4b kept the requested film as it was, the file either needed no
 * re-check or the re-check could not name it; then only the file's own year
 * can say it is another film.
 */
export function isRequestedFilm(requested, sent, hit = null) {
  if (!requested || !sent) return false;
  const apart = (a, b) => !!Number(a) && !!Number(b) && Math.abs(Number(a) - Number(b)) > 1;
  // The file carries the requested film's IMDb id: it is that film, a few
  // years either way of where the library files it (A Snapshot of Forever,
  // 2025 to OMDb, 2022 on the server - see verifyFileRating), but not decades
  // off (SAME_ID_MAX_YEAR_GAP: a remake carrying the other film's id).
  const sameId = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
  if (sent === requested) {
    return (sameId(requested.imdbId, hit?.imdbId) && idYearsAgree(requested.year, hit?.year)) || !apart(requested.year, hit?.year);
  }
  if (requested.imdbId && sent.imdbId === requested.imdbId) return true;
  return !differentFilm(requested, sent) && !apart(requested.year, sent.year);
}

/**
 * Re-verify a film's rating against the file the library actually returned.
 *
 * The library can fuzzy-match a different film than the metadata resolved -
 * "beekeeper" resolves to Beekeeper (1991, unrated) while the server holds
 * The Beekeeper (2024, R). The rating gate vets the metadata film, so when the
 * library match's year differs materially we must re-check against what will
 * really be sent, or the rating filter is bypassable by requesting loosely.
 *
 * Returns { blocked, mismatch, rechecked?, rated?, movie, found? }:
 * `rechecked` when the file was looked up again, and `rated` its rating then.
 * `movie` becomes the
 * library film when it could be identified and is the same film, so records
 * and downstream checks reflect reality; `found` is the film the file really
 * is when it is not (`mismatch`). The two are worked out separately: the
 * override list can take the rating out of the refusal (fileGate), but never
 * a file that is a different film. A file that is another film carries
 * `why`, 'film' or 'year', as isOtherFilm judged it with `typedYear`, the
 * year the member typed (typedYearOf).
 *
 * @param opts.omdbKey  the OMDb key the re-check looks the file up with
 * @param opts.log      where a re-check that could not run is reported
 * @param opts.force    look the file up again even though it looks like the
 *                      film asked for (fileGate, for a listed film)
 * @param opts.typedYear the year the member typed, when it names the film
 *                      asked for (typedYearOf), or null: a file of the title
 *                      asked for from far off it is another film too
 */
export async function verifyFileRating(hit, movie, cfg = {}, {
  omdbKey = '', log = null, force = false, typedYear = null,
} = {}) {
  // Re-check when the library's file does not look like the film that was
  // vetted - by YEAR, as before, but also by TITLE. Matching on year alone let
  // a fuzzy library hit with a plausible year through untouched: a different
  // film was downloaded, encoded, and posted under the requested film's name,
  // with the record, the queue label, the history row and the .mp4 filename
  // all still saying what was asked for. Nothing downstream could tell.
  const titleDrift = hit?.title && movie?.title
    && similarity(String(movie.title), String(hit.title)) < 0.9;
  const yearDrift = hit?.title && hit.year && movie?.year && Math.abs(hit.year - movie.year) > 1;
  // A copy that carries the IMDb id of the film that was vetted IS that film,
  // whatever the library calls it: "Harry Potter and the Philosopher's Stone"
  // for OMDb's "...Sorcerer's Stone", both tt0241527 (2026-10-11). Its
  // rating is the one already judged, so there is nothing to look up again -
  // unless the year says otherwise, which no library match by id allows.
  const sameId = !!hit?.imdbId && !!movie?.imdbId
    && String(hit.imdbId).toLowerCase() === String(movie.imdbId).toLowerCase();
  // And a copy with the film's title and IMDb id is that film though the
  // library files it a few years off: "A Snapshot of Forever", tt14074586, is
  // 2025 to OMDb and 2022 on the server (2026-10-11, findInLibrary's
  // yearRuleYields). Looked up again as "A Snapshot of Forever 2022", OMDb
  // could answer with another film and refuse the right file as the wrong
  // one. A copy whose title AND year both drift is looked up again, id or
  // not: that is a file tagged with the wrong id. So is one further than
  // SAME_ID_MAX_YEAR_GAP from the vetted film's year, title or not: the
  // first cut skipped the look whatever the gap, and in review (2026-10-11)
  // a "Total Recall" (1990), rated R, carrying the PG-13 2012 film's
  // tt1386703 passed here unlooked-at, where main had looked it up and
  // refused it on its rating. Its rating is the one this re-check exists for.
  const sameFilmById = sameId && !titleDrift && idYearsAgree(movie?.year, hit?.year);
  if (!hit?.title || (!force && (sameFilmById || (!yearDrift && (!titleDrift || sameId))))) {
    return { blocked: false, mismatch: false, movie };
  }
  try {
    // A file with no year is looked up by its title alone, not as "Saw II
    // undefined", which OMDb has never heard of.
    const recheck = await lookupMovie([hit.title, hit.year].filter(Boolean).join(' '), { apiKey: omdbKey });
    if (recheck?.movie) {
      const blocked = isBlockedRating(recheck.movie.rated, cfg.blockedRatings ?? []);
      // The file really is a different film. Adopting it silently is what sent
      // people something they never asked for; say so instead of delivering it.
      // A file of the requested title from far off the year the member typed
      // is one too - findInLibrary refuses such a copy before it gets here,
      // and this holds the file's own metadata to the same rule.
      const why = otherFilmReason(movie, recheck.movie, { typedYear });
      if (why) {
        return { blocked, mismatch: true, rechecked: true, rated: recheck.movie.rated, movie, found: recheck.movie, why };
      }
      return { blocked, mismatch: false, rechecked: true, rated: recheck.movie.rated, movie: recheck.movie };
    }
  } catch (err) {
    log?.warn?.(`rating re-check failed for "${hit.title}": ${err.message}`);
  }
  return { blocked: false, mismatch: false, movie };
}

/**
 * Step 4b of a request, for the request path, a panel Re-run and the dry run
 * alike: the library's file, when it does not look like the film that was
 * vetted, judged by its own rating (verifyFileRating).
 *
 * A file its rating blocks used to be refused here without a look at the
 * override list. So a listed film whose Jellyfin copy carried another year
 * (The Last Samurai as 2006, not 2003) or another wording of the title was
 * refused "rated R (library file)" - the operator's complaint of 2026-09-29,
 * "Items I added to rated r bypass still showing as bot will block", by
 * another road - while the dry run, which had no such step, said it would be
 * sent. Now an entry that covers the file's film takes it past here as at
 * step 2, and so does a rating the AI check may yet clear (`aiMayClear`):
 * contentGate then decides, as it does for the film asked for.
 *
 * The entry is looked for on the film the file is, not on the one asked for:
 * an entry narrowed to a year ("Scarface 1932") must not cover the 1983 film
 * that a loose match turned up. Once the file has been looked up again, the
 * entry for the file's own film is the only one that may send it, whatever
 * the file's rating - so the entry step 2 found for the film asked for is
 * never handed on past a file that is another year's film. The first cut
 * of the operator's change of 2026-09-29 did hand it on, and review caught
 * it before it shipped: once the AI check could take a rated file past this
 * step (`aiMayClear`), the callers fell back to step 2's entry for "Scarface
 * 1932", and contentGate, told the film was listed, sent the R 1983 film the
 * server held with no check at all. The same went for an unrated file with
 * blockUnrated on, which this step does not count as blocked.
 *
 * Nor is it handed on past a file the entry does not cover whose title is
 * not the title asked for, even when the file was not looked up again. The
 * re-check is skipped for a file that looks like the film asked for, and the
 * fuzzy matcher forgives a sequel's number: "Saw" scores 0.985 against "Saw
 * II", as "Scream" does against "Scream 2", and the library gives no
 * penalty for one year. So with Saw (2004) not on the server, a request for
 * it found Saw II (2005), and step 2's entry "Saw 2004" sent Saw II, as
 * "Saw", with no AI check - found in review of the operator's "Exact title
 * only" (2026-09-29), which an entry sending the next film in a series
 * breaks as surely as "Heat" sending "Heat and Dust". Such a file is looked
 * up again (`force`), and the entry for the film it turns out to be decides:
 * Saw II has none, and goes to the AI check as Saw II. An entry typed as
 * OMDb words a title ("F1: The Movie", held in Jellyfin as "F1") still sends
 * its film, once OMDb says the file is that film. When the file cannot be
 * looked up again, nothing is handed on, and contentGate matches the list on
 * the file alone.
 *
 * @param opts.override    the entry ratingGate() found for the film asked for,
 *                         if any: a listed film whose file is a different one
 *                         is refused as 'wrong-film', not on the rating; and it
 *                         is handed on when the file was not looked up again,
 *                         the file then being the film asked for - so long as
 *                         the entry covers the file, or the file has the title
 *                         asked for (see above)
 * @param opts.typedYear   the year the member typed (typedYearOf), handed to
 *                         verifyFileRating
 * @param opts.aiMayClear  whether the AI check could clear a rating that
 *                         blocks (aiCanClear): the file is then not refused on
 *                         its rating here, but put to contentGate
 * @returns {{ refused, movie, override, rc }}
 *   refused   null, 'blocked-rating' (the file's rating blocks it, no entry
 *             covers the file's film, and the AI check cannot clear it) or
 *             'wrong-film' (the file is a different film)
 *   movie     the film to go on with: the file's, once identified
 *   override  the entry for contentGate: once the file was looked up again,
 *             the one that covers the file's film, or null; otherwise
 *             `opts.override`. Callers pass this alone to contentGate.
 *   rc        verifyFileRating()'s answer
 */
export async function fileGate({
  store = null, movie, hit, cfg = {}, override = null, aiMayClear = false, omdbKey = '', log = null, typedYear = null,
} = {}) {
  // Step 2's entry, and a file it does not cover under another title: which
  // film the file is has to be known before the entry can send it.
  const unsure = !!override && !!hit?.title && !coversFile(override, hit) && !sameTitle(hit.title, movie?.title);
  const rc = await verifyFileRating(hit, movie, cfg, { omdbKey, log, force: unsure, typedYear });
  const entry = rc.rechecked && store ? isOverridden(store, rc.found ?? rc.movie, hit) : null;
  let refused = null;
  if (rc.mismatch) refused = rc.blocked && !entry && !override ? 'blocked-rating' : 'wrong-film';
  else if (rc.blocked && !entry && !aiMayClear) refused = 'blocked-rating';
  const handOn = rc.rechecked ? entry : (unsure ? null : override);
  return { refused, movie: refused ? movie : rc.movie, override: refused ? null : handOn, rc };
}

/** Does entry `e` cover the library's file itself: by its id, or by its own name and year? */
function coversFile(e, hit) {
  if (e?.jellyfinId && hit?.id && e.jellyfinId === String(hit.id).toLowerCase()) return true;
  return entryCoversName(e, { name: hit?.title, year: hit?.year ?? null });
}

/**
 * The last step, for the film that will actually be sent.
 *
 * In order: a title its rating lets through is sent, and nothing is asked; a
 * title the bypass list covers is sent, and nothing is asked; a title its
 * rating blocks is refused on its rating unless the AI check could clear it
 * (aiCanClear), and is then asked about - a sure "no nudity" from a provider
 * allowed to clear rated titles sends it, and anything else leaves it refused
 * on its rating (decide()).
 *
 * @param opts.store        the override list's store
 * @param opts.movie        { title, year, rated }: the film as vetted
 * @param opts.hit          the library's match, when there is one: its title
 *                          and year are what the check is asked about, and
 *                          its id and title what the list is matched on again
 *                          - its alone when its title is not `movie`'s
 *                          (listedFile)
 * @param opts.override     the entry an earlier step found for THIS film, if
 *                          any (fileGate's `override`); it is trusted as it
 *                          is, and the list is only searched again when there
 *                          is none. Never step 2's entry for a film the
 *                          library swapped for another (see fileGate).
 * @param opts.ratedBlocked whether the rating blocks it, when the caller has
 *                          already settled that (the letter grade at step 2,
 *                          while the film is still the one asked for; Queue
 *                          link's own rule); worked out from `cfg`,
 *                          blockUnrated included, otherwise
 * @param opts.cfg          the movieRequests config section
 * @param opts.gemini       the gemini config section (the switches, the key)
 * @param opts.ai           the ai config section (the fallback providers)
 * @param opts.onResult     told how each check went, as checkNudity's is
 * @returns {Promise<{ ratedBlocked, override, bypass, checked, verdict, failed, call }>}
 *   `bypass` when the list sent it, with `call.reason` bypassNote(entry);
 *   `checked` when the AI was asked; `call` is decide()'s answer, or the
 *   rating's own when nothing was asked; `failed` is the check's structured
 *   failure when it could not run.
 */
export async function contentGate({
  store = null, movie = {}, hit = null, override = null, ratedBlocked = null,
  cfg = {}, gemini = {}, ai = null, onResult = null,
} = {}) {
  const plan = contentPlan({ store, movie, hit, override, ratedBlocked, cfg, gemini, ai });
  const none = { verdict: null, failed: null, checked: false, bypass: false };
  if (plan.step === 'allowed') {
    return { ...none, ratedBlocked: false, override: null, call: { blocked: false, reason: 'allowed', basis: null } };
  }
  if (plan.step === 'bypass') {
    return {
      ...none, ratedBlocked: true, override: plan.entry, bypass: true,
      call: { blocked: false, reason: bypassNote(plan.entry), basis: null },
    };
  }
  if (plan.step === 'refuse') {
    return { ...none, ratedBlocked: true, override: null, call: { blocked: true, reason: 'blocked by rating', basis: null } };
  }

  const g = gemini ?? {};
  let failed = null;
  const verdict = await checkNudity(hit?.title ?? movie?.title, hit?.year ?? movie?.year, g, {
    ai,
    onlyClearing: true,
    onResult: (r) => {
      if (!r.ok) failed = r.failure;
      onResult?.(r);
    },
  });
  const call = decide(verdict, true, {
    minConfidence: Number(g.minContentConfidence ?? 0.7),
    allowCleanRatedFilms: true,
  });
  return { ratedBlocked: true, override: null, bypass: false, checked: true, verdict, failed, call };
}

/**
 * What contentGate() will do with these options, without doing it: 'allowed'
 * (the rating lets it through), 'bypass' (an entry covers it, `entry`),
 * 'refuse' (the rating blocks it and the AI check cannot clear it) or 'ask'
 * (the AI check will be asked). contentGate goes by this, so the two cannot
 * disagree.
 */
function contentPlan({ store = null, movie = {}, hit = null, override = null, ratedBlocked = null, cfg = {}, gemini = {}, ai = null } = {}) {
  const blocked = ratedBlocked ?? isBlockedRating(movie?.rated, cfg.blockedRatings ?? [], {
    blockUnrated: cfg.blockUnrated === true,
  });
  if (!blocked) return { step: 'allowed' };
  const entry = override ?? (store ? listedFile(store, movie, hit) : null);
  if (entry) return { step: 'bypass', entry };
  const g = gemini ?? {};
  return { step: aiCanClear(g, ai) ? 'ask' : 'refuse' };
}

/**
 * The entry that covers the film about to be sent, when no earlier step
 * handed one on. The list is matched on the film asked for and the library's
 * file together, which is right while the two are the same title: the file's
 * id finds a link, and either wording finds a title. When the file has
 * another title ("Saw II" for a request for "Saw"), and fileGate handed
 * nothing on, the name asked for is left out: an entry for it would
 * otherwise send the other film unchecked, as "Saw 2004" sent Saw II
 * (fileGate). The file's own name, year and id are matched.
 */
function listedFile(store, movie = {}, hit = null) {
  if (hit?.title && !sameTitle(hit.title, movie?.title)) {
    return isOverridden(store, { title: hit.title, year: hit.year ?? null }, hit);
  }
  return isOverridden(store, movie, hit);
}

/**
 * Whether contentGate(), given the same options, would ask the AI check.
 *
 * A request asks it only when the answer can change the outcome, and so
 * answers what needs no answer from it first: a full queue refuses the film
 * whatever the check says, and a check spent on it is one of Gemini's twenty
 * a day for nothing (the operator's rule of 2026-09-29, film-gate.js header).
 * A film the check will not be asked about keeps the answer it always got -
 * a rated one is refused on its rating, not for a full queue.
 */
export function contentGateAsks(opts = {}) {
  return contentPlan(opts).step === 'ask';
}
