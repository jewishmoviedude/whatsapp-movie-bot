import fs from 'node:fs';
import path from 'node:path';
import log from '../../util/logger.js';
import {
  bestMatch, similarity, normalizeTitle, startsWithWords, cleanRequestText, extractYear, whyOtherFilm, idYearsAgree,
  sequelNumber, carriesNumber, firstFilmWords,
} from '../../util/fuzzy.js';
import { resolveToken } from './jellyfin-auth.js';

const logger = log.scope('library');

/**
 * A library provider answers two questions:
 *   find(title, year) -> a match, or null
 *   resolve(match)    -> either a local path we can read directly,
 *                        or a URL to stream down
 *
 * If the media server's storage is also mounted on this box, `localPath`
 * lets the pipeline skip the download entirely - which turns a 10GB transfer
 * into a no-op. That is checked first for every provider that reports a path.
 */

function normalizeBase(url) {
  return String(url || '').replace(/\/+$/, '');
}

const item0Name = (i) => i?.Name ?? '(unknown)';

/** An IMDb id as Jellyfin and OMDb both write it ("tt0241527"), or null. */
export function normImdb(id) {
  const t = String(id ?? '').trim().toLowerCase();
  return /^tt\d+$/.test(t) ? t : null;
}

/** The IMDb id a Jellyfin item carries in its ProviderIds, or null. */
function imdbOf(item) {
  const ids = item?.ProviderIds ?? {};
  return normImdb(ids.Imdb ?? ids.imdb ?? ids.IMDB);
}

/**
 * Does the year rule give way to the IMDb id? Only for `reason` 'year' (the
 * title is the film's, the year is not), and only when the copy carries the
 * IMDb id of the film asked for: one id is one film, whatever year the
 * library files it under. "A Snapshot of Forever" is 2025 to OMDb and 2022 to
 * Jellyfin, both tt14074586; Mia typed "a snapshot of forever 2025" on
 * 2026-10-08, and once the host had added it the 12:40 recheck of 2026-10-11
 * still refused the server's copy as "from another year than the 2025 asked
 * for". A copy with ANOTHER id, or none, is judged by its year as before
 * (Dune 2021 for "Dune 1984"), and a different title far from the year is
 * 'film', never excused here (a making-of mis-tagged with the film's id).
 *
 * Nor does it give way across more than SAME_ID_MAX_YEAR_GAP years
 * (`wantYear`, OMDb's year or else the one typed, against the copy's
 * `gotYear`; util/fuzzy.js). The first cut gave way at any distance, and in
 * review (2026-10-11) "total recall 2012" took a 1990 copy, rated R, that
 * carried the 2012 film's id - which the file re-check then passed unseen
 * (verifyFileRating). Main had refused it as another year's film, and so
 * does this again.
 */
export function yearRuleYields(reason, wantImdb, gotImdb, { wantYear = null, gotYear = null } = {}) {
  const want = normImdb(wantImdb);
  return reason === 'year' && !!want && normImdb(gotImdb) === want && idYearsAgree(wantYear, gotYear);
}

/** How many years apart two years are; an unknown one sorts last. */
const yearGap = (a, b) => (Number(a) && Number(b) ? Math.abs(Number(a) - Number(b)) : 99);

/**
 * Jellyfin servers whose /Items was found to ignore AnyProviderIdEquals, by
 * base URL, for the life of the process (see itemsByImdb).
 */
const IGNORES_PROVIDER_FILTER = new Set();

/** For tests: forget which servers were found to ignore AnyProviderIdEquals. */
export function forgetProviderFilterSupport() { IGNORES_PROVIDER_FILTER.clear(); }

/**
 * From a list of candidates, pull out every entry whose title is essentially
 * the one requested but whose year differs - i.e. the remakes we actually
 * hold. This is what decides whether asking for a year is worth doing: if
 * only one copy is on the server there is nothing to disambiguate, however
 * many same-titled films exist in the wider world.
 *
 * One entry per year, oldest first: `item` is the first copy seen for that
 * year and `copies` every copy of it. The copies are kept because two files of
 * one film can carry different ratings, and anything that offers a year to a
 * member has to know about all of them, not just the one that happened to
 * come first.
 */
function sameTitledMatches(query, candidates, { getTitle, getYear }) {
  const wanted = normalizeTitle(query);
  const seen = new Map();
  for (const c of candidates) {
    const t = getTitle(c);
    if (!t) continue;
    // Exact normalized equality only. A fuzzy threshold here would sweep in
    // sequels - "Toy Story 2" scores very highly against "Toy Story" - and
    // a sequel is a different film, not another edition of the same one.
    if (normalizeTitle(t) !== wanted) continue;
    const y = getYear(c) ?? null;
    if (!seen.has(y)) seen.set(y, []);
    seen.get(y).push(c);
  }
  return [...seen.entries()].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))
    .map(([, copies]) => ({ item: copies[0], copies }));
}

/**
 * Every film whose title is the one requested or begins with it, whole words
 * only - the remakes sameTitledMatches finds, and the franchise around them.
 *
 * On 2026-09-22 "#request harry potter" in the beta group got no list: no
 * film is called plain "Harry Potter", so the exact match above found
 * nothing, OMDb picked "...the Deathly Hallows: Part 2" as its best search
 * hit, and that was queued for someone who had not chosen it. What the
 * requester meant is every film on the server that starts with those words.
 *
 * One entry per FILM - normalised title and year - with every copy of it,
 * ordered by year and then title. Two files of one film are one choice; two
 * films of one year ("Batman" and "Batman: ..." in 1966, say) are two.
 */
function startsWithMatches(query, candidates, { getTitle, getYear }) {
  const seen = new Map();
  for (const c of candidates) {
    const t = getTitle(c);
    if (!t || !startsWithWords(t, query)) continue;
    const y = getYear(c) ?? null;
    const key = `${normalizeTitle(t)}|${y}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(c);
  }
  return [...seen.values()]
    .map((copies) => ({ item: copies[0], copies }))
    .sort((a, b) => ((getYear(a.item) ?? 0) - (getYear(b.item) ?? 0))
      || String(getTitle(a.item)).localeCompare(String(getTitle(b.item))));
}

/**
 * A search's results, less every one that cannot be `film` (the one
 * requested) - see whyOtherFilm in util/fuzzy.js.
 *
 * On 2026-09-29 "#request Barefoot 2014" resolved to Barefoot (2014), which
 * the library does not have. The search for "Barefoot" came back with
 * Barefoot Gen (1983), the matcher forgave the "Gen" as a subtitle left off
 * (0.985, and 0.885 after the year penalty, well over the 0.72 bar), and the
 * 1983 anime was posted to the posts group as the film Mia asked for. A film
 * the requester's year rules out is not a candidate at all, so it can neither
 * win nor stand in as a spare copy; and because it is removed BEFORE the best
 * match is picked, a right film further down the results still is.
 *
 * The same goes for an identical title, when the member typed a year
 * (`film.typedYear`) and the copy is more than one from it. Dune (2021) was
 * sent for "Dune 1984": identical titles were left to bestMatch, where a year
 * is only a tiebreaker, so the one Dune on the server won whatever year was
 * asked for. The operator's answer to that request: "Not in library". When
 * the server holds several (Venom 1981, 2005, 2011 and 2018), the typed
 * year's copy is the only one left to choose.
 *
 * `closest` is the refused film the matcher would otherwise have taken, or
 * null, with `reason` 'film' or 'year' as whyOtherFilm gave it: it is how the
 * not-in-library list says what the lookup saw (the operator wants a request
 * like Mia's on that list, and a bare "not in the library" beside a film
 * that plainly shares its title reads as a bug). `film` null, or with neither
 * year, leaves the results as they are.
 *
 * A copy that carries the IMDb id of the film asked for (`film.imdbId`,
 * `getImdb`) is not ruled out by its year alone, a few years off
 * (yearRuleYields).
 */
function refuseOtherFilms(film, query, items, { threshold, year, getTitle, getYear, getImdb = () => null }) {
  const typedYear = film?.typedYear ?? null;
  const typed = film?.typed ?? null;
  if (!film?.title || (!film?.year && !typedYear)) return { eligible: items, closest: () => null };
  const eligible = [];
  const others = [];
  const reasons = new Map();
  for (const i of items) {
    let reason = whyOtherFilm(film, { title: getTitle(i), year: getYear(i) }, { typedYear, typed });
    if (yearRuleYields(reason, film?.imdbId, getImdb(i), { wantYear: film?.year ?? typedYear, gotYear: getYear(i) })) reason = null;
    if (reason) { others.push(i); reasons.set(i, reason); } else eligible.push(i);
  }
  return {
    eligible,
    closest: () => {
      if (!others.length) return null;
      const m = bestMatch(query, others, { threshold, year, getTitle, getYear });
      return m ? { title: getTitle(m.item), year: getYear(m.item) ?? null, score: m.score, reason: reasons.get(m.item) } : null;
    },
  };
}

/**
 * What a not-in-library answer says about the film the library does hold
 * under a similar title, when findInLibrary refused it:
 * 'closest in the library: "Barefoot Gen" (1983), a different film', or, for
 * an identical title the typed year ruled out, '..."Dune" (2021), a different
 * year'. One wording for the request pipeline, a panel Re-run and the Test
 * tab.
 */
export function closestNote(other) {
  return `closest in the library: "${other.title}"${other.year ? ` (${other.year})` : ''}, `
    + `a different ${other.reason === 'year' ? 'year' : 'film'}`;
}

/**
 * The year a 'year' refusal was measured against: the one typedYearOf kept,
 * or the one the member wrote though OMDb's film is far from it ("fast and
 * furios 2013", resolved to Fast and Furious (1939); whyOtherFilm).
 */
const askedYearOf = (film) => film?.typedYear ?? extractYear(film?.typed) ?? null;

/** The log line for a film refused by refuseOtherFilms. */
function otherFilmLine(label, closest, film) {
  return `${label}: "${closest.title}" (${closest.year}) matched the search, but `
    + (closest.reason === 'year'
      ? `${askedYearOf(film)} is the year asked for`
      : `it is another film than ${film.title} (${film.year})`)
    + ' - not a hit';
}

/**
 * Give a slow media server room to answer without letting a hung one block
 * the queue indefinitely. Some Jellyfin installs take a minute or more on a
 * cold search.
 */
function withTimeout(signal, ms) {
  if (!ms) return { signal, done: () => {} };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    timedOut: () => ctrl.signal.aborted && !signal?.aborted,
    done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); },
  };
}

async function fetchWithTimeout(url, opts, timeoutMs, label) {
  const t = withTimeout(opts.signal, timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: t.signal });
  } catch (err) {
    if (t.timedOut()) {
      throw new Error(`${label} did not respond within ${Math.round(timeoutMs / 1000)}s`);
    }
    const cause = err.cause ?? err;
    let host = url;
    try { host = new URL(url).host; } catch { /* keep raw */ }
    if (cause.code === 'ECONNREFUSED') throw new Error(`Nothing is listening at ${host}`);
    if (cause.code === 'ENOTFOUND') throw new Error(`Could not resolve ${host}`);
    throw new Error(cause.message ? `${label} (${host}): ${cause.message}` : `Could not reach ${host}`);
  } finally {
    t.done();
  }
}

/* ------------------------------- Jellyfin -------------------------------- */

class JellyfinProvider {
  constructor(cfg, hooks = {}) {
    this.cfg = cfg;
    this.base = normalizeBase(cfg.baseUrl);
    this.userId = cfg.userId;
    this.onTokenRefreshed = hooks.onTokenRefreshed;
    this.token = null;
  }

  get configured() {
    if (!this.base) return false;
    const m = this.cfg.authMethod ?? 'apikey';
    if (m === 'apikey') return !!this.cfg.apiKey;
    if (m === 'password') return !!this.cfg.username;
    return !!this.cfg.accessToken;   // quickconnect: linked already
  }

  /** Lazily resolve a token; password auth renews itself if it goes stale. */
  async ensureToken(signal) {
    if (this.token) return this.token;
    this.token = await resolveToken(this.cfg, {
      signal,
      onTokenRefreshed: (auth) => {
        this.token = auth.accessToken;
        this.userId = auth.userId ?? this.userId;
        this.onTokenRefreshed?.(auth);
      },
    });
    return this.token;
  }

  headers() {
    return {
      'X-Emby-Token': this.token,
      Accept: 'application/json',
    };
  }

  /**
   * One page of the whole movie library, for the catalogue scan. Asks only for
   * what the catalogue keeps, so it does not drag paths and media detail back
   * for thousands of items it has no use for.
   */
  async page(startIndex, limit, { signal, timeoutMs = 120000, nameStartsWithOrGreater = null } = {}) {
    await this.ensureToken(signal);
    const url = new URL(`${this.base}/Items`);
    url.searchParams.set('IncludeItemTypes', 'Movie');
    url.searchParams.set('Recursive', 'true');
    url.searchParams.set('StartIndex', String(startIndex));
    url.searchParams.set('Limit', String(limit));
    // SortName is the cursor for the next window: Jellyfin serves no more than
    // 10,000 results per query (see scanLibrary), so a big library is walked in
    // windows that each start at the sort name the previous one reached.
    url.searchParams.set('Fields', 'ProductionYear,OfficialRating,SortName');
    url.searchParams.set('SortBy', 'SortName');
    url.searchParams.set('SortOrder', 'Ascending');
    if (nameStartsWithOrGreater) url.searchParams.set('NameStartsWithOrGreater', nameStartsWithOrGreater);
    if (this.userId) url.searchParams.set('UserId', this.userId);

    const res = await fetchWithTimeout(url, { headers: this.headers(), signal }, timeoutMs, 'Jellyfin');
    if (!res.ok) throw new Error(`Jellyfin HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    return { items: data.Items ?? [], total: data.TotalRecordCount ?? null };
  }

  /**
   * One item by its id. No matching involved - the id came from a human
   * looking at the film, so there is nothing to guess and nothing to get wrong.
   */
  async itemById(id, { signal, timeoutMs = 60000 } = {}) {
    await this.ensureToken(signal);
    const url = new URL(`${this.base}/Items`);
    url.searchParams.set('Ids', id);
    url.searchParams.set('Recursive', 'true');
    url.searchParams.set('Fields', 'Path,MediaSources,ProductionYear,OfficialRating');
    if (this.userId) url.searchParams.set('UserId', this.userId);

    const res = await fetchWithTimeout(url, { headers: this.headers(), signal }, timeoutMs, 'Jellyfin');
    if (!res.ok) throw new Error(`Jellyfin HTTP ${res.status} ${res.statusText}`);
    const item = (await res.json())?.Items?.[0];
    if (!item) return null;
    return {
      id: item.Id,
      title: item.Name,
      year: item.ProductionYear ?? null,
      rated: item.OfficialRating ?? null,
      localPath: item.Path ?? null,
      type: item.Type ?? null,
      // Which show, season and episode a TV item is, so the Test tab's link
      // check can find the override entry that covers it as the TV plugin
      // would (tvOverrideFor). Jellyfin sends these on every item it has
      // them for; a film has none of them.
      seriesId: item.SeriesId ?? null,
      seriesName: item.SeriesName ?? null,
      seasonId: item.SeasonId ?? null,
      season: item.Type === 'Season' ? (item.IndexNumber ?? null) : (item.ParentIndexNumber ?? null),
      episode: item.Type === 'Episode' ? (item.IndexNumber ?? null) : null,
      downloadUrl: `${this.base}/Items/${item.Id}/Download`,
      headers: this.headers(),
    };
  }

  /**
   * The title search every lookup starts with. `limit` is 25 for the request
   * pipeline, as it always was; the "which one?" list asks for more (see
   * libraryVersions), and only it does, so an ordinary request sees exactly
   * the candidates it always saw.
   */
  async searchItems(title, { limit = 25, signal, timeoutMs = 180000 } = {}) {
    await this.ensureToken(signal);
    const url = new URL(`${this.base}/Items`);
    url.searchParams.set('searchTerm', title);
    url.searchParams.set('IncludeItemTypes', 'Movie');
    url.searchParams.set('Recursive', 'true');
    url.searchParams.set('Limit', String(limit));
    // OfficialRating rides along so the versions of a title can be vetted
    // before any of them is offered to a member (the "which one?" list and the
    // "we have 1981, 2005..." note). It is the same field the catalogue scan
    // and queue-from-a-link already trust. ProviderIds carries the IMDb id
    // that find() matches the film asked for by when no title does.
    url.searchParams.set('Fields', 'Path,MediaSources,ProductionYear,OfficialRating,OriginalTitle,ProviderIds');
    if (this.userId) url.searchParams.set('UserId', this.userId);

    const res = await fetchWithTimeout(url, { headers: this.headers(), signal }, timeoutMs, 'Jellyfin');
    if (!res.ok) throw new Error(`Jellyfin HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    return data.Items ?? [];
  }

  /**
   * The films that carry this IMDb id, asked of Jellyfin directly with
   * AnyProviderIdEquals - or [] when the server cannot answer that.
   *
   * Measured on the live server (Jellyfin 10.11.10, 2026-10-11) the filter is
   * ignored: AnyProviderIdEquals=imdb.tt0290334 came back with all 20,869
   * films, the first of them "1, 2, 3, All Eyes On Me", with the bot's user
   * and without it, and in every spelling of the parameter. Trusted, that
   * would have sent a stranger's film for X2. So nothing comes back from here
   * that does not itself carry the id, and a server seen returning anything
   * else is not asked again while the process runs: one wasted request, then
   * the id is matched among the title searches' results instead (find,
   * discoverTitle). A server that does honour the filter finds a film here
   * whatever the library calls it.
   */
  async itemsByImdb(imdbId, { signal, timeoutMs = 60000 } = {}) {
    const want = normImdb(imdbId);
    if (!want || IGNORES_PROVIDER_FILTER.has(this.base)) return [];
    await this.ensureToken(signal);
    const url = new URL(`${this.base}/Items`);
    url.searchParams.set('AnyProviderIdEquals', `imdb.${want}`);
    url.searchParams.set('IncludeItemTypes', 'Movie');
    url.searchParams.set('Recursive', 'true');
    url.searchParams.set('Limit', '10');
    url.searchParams.set('Fields', 'ProductionYear,OfficialRating,ProviderIds');
    if (this.userId) url.searchParams.set('UserId', this.userId);

    const res = await fetchWithTimeout(url, { headers: this.headers(), signal }, timeoutMs, 'Jellyfin');
    if (!res.ok) throw new Error(`Jellyfin HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    const items = data.Items ?? [];
    const carrying = items.filter((i) => imdbOf(i) === want);
    if (carrying.length < items.length) {
      IGNORES_PROVIDER_FILTER.add(this.base);
      logger.info(`Jellyfin ignores AnyProviderIdEquals (asked for ${want}, it answered with `
        + `${data.TotalRecordCount ?? items.length} film(s), not all carrying it) - IMDb ids are matched among `
        + 'the title searches\' results instead');
    }
    return carrying;
  }

  /**
   * `searchAs`, when given, is what the server is searched for instead of
   * `title`, which every candidate is still judged against: the word that
   * found a title the server cannot find by its own name (findInLibrary).
   * It is searched as deep as that word search was, so the copy it found is
   * among the candidates.
   */
  async find(title, year, { threshold = 0.72, signal, timeoutMs = 180000, film = null, searchAs = null } = {}) {
    this.lastOtherFilm = null;
    const items = await this.searchItems(searchAs ?? title, { signal, timeoutMs, ...(searchAs ? { limit: 120 } : {}) });
    if (!items.length) return null;

    const accessors = { getTitle: (i) => i.Name, getYear: (i) => i.ProductionYear, getImdb: imdbOf };
    // Each copy's rating and type ride along for whatever offers these years
    // to a member (pick-list.js), which lists films only and only sendable
    // ones. The search already asks for movies, so for a real server `types`
    // is all 'Movie'; it is carried so a list never has to trust that.
    this.lastSameTitled = sameTitledMatches(title, items, accessors)
      .map(({ item: i, copies }) => ({
        id: i.Id,
        title: i.Name,
        year: i.ProductionYear ?? null,
        rated: i.OfficialRating ?? null,
        ratings: copies.map((c) => c.OfficialRating ?? null),
        types: copies.map((c) => c.Type ?? null),
      ids: copies.map((c) => c.Id ?? null),
      }));

    // sameTitled above is left as it was: it is what the "which year?" step
    // offers, it only ever holds titles identical to the search, and it is
    // read only once a hit has been found.
    let { eligible, closest } = refuseOtherFilms(film, title, items, { threshold, year, ...accessors });
    let match = bestMatch(title, eligible, { threshold, year, ...accessors });
    if (!match) {
      // The library names a foreign film in English and keeps the title it
      // was released under as OriginalTitle: "Le Dîner de cons (1998)" was
      // answered "not in the library" while it sat there as "The Dinner Game"
      // [orig: Le Dîner de cons] (2026-10-01). Judge the same candidates by
      // that second name, with the same year and other-film checks, and map a
      // hit back to the real row so the copy keeps its library name.
      const aliased = items
        .filter((i) => i.OriginalTitle && i.OriginalTitle !== i.Name)
        .map((i) => ({ ...i, Name: i.OriginalTitle, _row: i }));
      if (aliased.length) {
        const alt = refuseOtherFilms(film, title, aliased, { threshold, year, ...accessors });
        const altMatch = bestMatch(title, alt.eligible, { threshold, year, ...accessors });
        if (altMatch) {
          match = { ...altMatch, item: altMatch.item._row };
          eligible = [match.item];
        }
      }
    }
    // No title is close enough, but a candidate carries the IMDb id of the
    // film asked for: it is that film under the library's name for it.
    // "Harry Potter and the Sorcerer's Stone" (tt0241527) was on the wanted
    // list from 2026-10-06 while the server held it as "...the Philosopher's
    // Stone" with that very id. Only among the eligible candidates, so a copy
    // that refuseOtherFilms rules out stays ruled out (one carrying this id
    // is not ruled out by its year alone, a few years off, yearRuleYields),
    // and only
    // when no title matched, so a request the titles answer is answered as
    // it always was. Every copy carrying the id is the same release, and so
    // the alternates.
    let byImdb = false;
    const wantImdb = normImdb(film?.imdbId);
    if (!match && wantImdb) {
      const carrying = eligible.filter((i) => imdbOf(i) === wantImdb);
      if (carrying.length) {
        const sorted = [...carrying].sort((a, b) => yearGap(a.ProductionYear, film?.year) - yearGap(b.ProductionYear, film?.year));
        match = { item: sorted[0], score: 1 };
        eligible = sorted;
        byImdb = true;
        logger.info(`Jellyfin: no title matched "${title}", but "${item0Name(match.item)}" (${match.item.ProductionYear ?? '?'}) `
          + `carries ${wantImdb}, the IMDb id of the film asked for - a hit by id`);
      }
    }
    if (!match) {
      this.lastOtherFilm = closest();
      logger.info(this.lastOtherFilm
        ? otherFilmLine('Jellyfin', this.lastOtherFilm, film)
        : `Jellyfin: no confident match for "${title}" among ${items.length} result(s)`);
      return null;
    }

    // A library can hold the same film twice - and one copy's file may be gone
    // from disk while Jellyfin still lists it. Downloading that entry 404s even
    // though a working copy exists, so rank every acceptable candidate and hand
    // back the alternates for the caller to fall back to.
    //
    // An alternate has to be the same RELEASE as well as the same title: a
    // year either side of the chosen copy, and never an unknown year. Title
    // alone counted every remake as a spare copy, and the fallback downloads
    // an alternate without vetting it again - so when the file of a picked
    // Venom (2011, PG) was gone, the R-rated 1981 Venom was posted in its
    // place under its name (found in review, 2026-09-22; "#request Venom
    // 2011" did the same on origin/main). A remake is a different film.
    const matchYear = Number(match.item.ProductionYear) || null;
    const sameRelease = (i) => {
      const y = Number(i.ProductionYear) || null;
      return !!matchYear && !!y && Math.abs(y - matchYear) <= 1;
    };
    // Nor a sequel, which title and year alone let through: "Kill Bill: Vol.
    // 2" (2004) scores 0.97 against "Kill Bill: Vol. 1" (2003), a year
    // apart. Searched for by the shelf a word found (searchAs, which brings
    // back every film with "kill" in its name), Vol. 2 became Vol. 1's spare
    // copy, to be downloaded and sent under Vol. 1's name had Vol. 1's file
    // been gone - and so did Atlas Shrugged: Part II for Part I (found in
    // review, 2026-10-11; the live library holds that pair, Che: Part One
    // and Two, and The Dark Knight Returns, Part 1 and Part 2). The IMDb id
    // each copy carries says exactly which film it is,
    // so a copy carrying another id than the one chosen (or, when that one
    // carries none, than the film asked for) is another film. A copy with
    // no id is judged by its title and year, as before.
    const releaseImdb = imdbOf(match.item) ?? wantImdb;
    const sameFilm = (i) => {
      const id = imdbOf(i);
      return !releaseImdb || !id || id === releaseImdb;
    };
    const ranked = eligible
      .map((i) => ({ item: i, score: byImdb ? 1 : similarity(normalizeTitle(title), normalizeTitle(i.Name ?? '')) }))
      .filter((c) => c.item.Id !== match.item.Id && c.score >= threshold)
      .filter((c) => sameRelease(c.item) && sameFilm(c.item))
      .sort((a, b) => b.score - a.score);

    const shape = (item, score) => {
      const source = item.MediaSources?.[0];
      return {
        provider: 'jellyfin',
        id: item.Id,
        title: item.Name,
        year: item.ProductionYear ?? null,
        // The library's own IMDb id for the copy, so the file re-check can
        // tell it is the film that was vetted (verifyFileRating).
        imdbId: imdbOf(item),
        score,
        localPath: source?.Path ?? item.Path ?? null,
        size: Number(source?.Size ?? 0) || null,
        container: source?.Container ?? null,
      };
    };

    const primary = shape(match.item, match.score);
    primary.alternates = ranked.slice(0, 4).map((c) => shape(c.item, c.score));
    if (primary.alternates.length) {
      logger.debug(`Jellyfin: ${primary.alternates.length} alternate copy/copies of "${item0Name(match.item)}" available if the first fails`);
    }
    return primary;
  }

  /** Plain title search, used by researchLibrary() to gather candidates. */
  async rawSearch(term, { limit = 120, signal } = {}) {
    await this.ensureToken(signal);
    const url = new URL(`${this.base}/Items`);
    url.searchParams.set('searchTerm', term);
    url.searchParams.set('IncludeItemTypes', 'Movie');
    url.searchParams.set('Recursive', 'true');
    url.searchParams.set('Limit', String(limit));
    url.searchParams.set('Fields', 'ProductionYear,OfficialRating,ProviderIds');
    if (this.userId) url.searchParams.set('UserId', this.userId);

    const res = await fetchWithTimeout(url, { headers: this.headers(), signal }, 60000, 'Jellyfin');
    if (!res.ok) throw new Error(`Jellyfin HTTP ${res.status}`);
    const data = await res.json();
    return (data.Items ?? []).map((i) => ({ title: i.Name, year: i.ProductionYear ?? null, imdbId: imdbOf(i) }));
  }

  downloadUrl(match) {
    const url = new URL(`${this.base}/Items/${match.id}/Download`);
    // Token as a query param: the download is streamed by fetch, and this
    // keeps it working across the redirect Jellyfin sometimes issues.
    url.searchParams.set('api_key', this.token);
    return { url: url.toString(), headers: { 'X-Emby-Token': this.token } };
  }
}

/* --------------------------------- Plex ---------------------------------- */

class PlexProvider {
  constructor(cfg) {
    this.base = normalizeBase(cfg.baseUrl);
    this.token = cfg.token;
  }

  get configured() { return !!(this.base && this.token); }

  headers() {
    return { 'X-Plex-Token': this.token, Accept: 'application/json' };
  }

  async find(title, year, { threshold = 0.72, signal, timeoutMs = 180000, film = null } = {}) {
    this.lastOtherFilm = null;
    const url = new URL(`${this.base}/search`);
    url.searchParams.set('query', title);
    const res = await fetchWithTimeout(url, { headers: this.headers(), signal }, timeoutMs, 'Plex');
    if (!res.ok) throw new Error(`Plex HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();

    const items = (data.MediaContainer?.Metadata ?? []).filter((m) => m.type === 'movie');
    if (!items.length) return null;

    const accessors = { getTitle: (i) => i.title, getYear: (i) => i.year };
    const { eligible, closest } = refuseOtherFilms(film, title, items, { threshold, year, ...accessors });
    const match = bestMatch(title, eligible, { threshold, year, ...accessors });
    if (!match) {
      this.lastOtherFilm = closest();
      if (this.lastOtherFilm) logger.info(otherFilmLine('Plex', this.lastOtherFilm, film));
      return null;
    }

    const item = match.item;
    const part = item.Media?.[0]?.Part?.[0];
    return {
      provider: 'plex',
      id: item.ratingKey,
      title: item.title,
      year: item.year ?? null,
      score: match.score,
      localPath: part?.file ?? null,
      size: Number(part?.size ?? 0) || null,
      container: item.Media?.[0]?.container ?? null,
      partKey: part?.key ?? null,
    };
  }

  downloadUrl(match) {
    if (!match.partKey) throw new Error('Plex match has no downloadable part');
    const url = new URL(`${this.base}${match.partKey}`);
    url.searchParams.set('download', '1');
    url.searchParams.set('X-Plex-Token', this.token);
    return { url: url.toString(), headers: {} };
  }
}

/* ------------------------------ Generic HTTP ------------------------------ */

class HttpProvider {
  constructor(cfg) {
    this.searchUrl = cfg.searchUrl;
    this.authHeader = cfg.authHeader;
  }

  get configured() { return !!this.searchUrl; }

  async find(title, year, { threshold = 0.72, signal, timeoutMs = 180000, film = null } = {}) {
    this.lastOtherFilm = null;
    const url = new URL(this.searchUrl);
    url.searchParams.set('q', title);
    if (year) url.searchParams.set('year', String(year));

    const headers = { Accept: 'application/json' };
    if (this.authHeader) {
      const [k, ...rest] = this.authHeader.split(':');
      headers[k.trim()] = rest.join(':').trim();
    }

    const res = await fetchWithTimeout(url, { headers, signal }, timeoutMs, 'Library');
    if (!res.ok) throw new Error(`Library HTTP ${res.status}`);
    const data = await res.json();

    // Accept either a single object or a list.
    const list = Array.isArray(data) ? data : (data.results ?? (data.url ? [data] : []));
    if (!list.length) return null;

    const accessors = { getTitle: (i) => i.title ?? i.name, getYear: (i) => i.year };
    const { eligible, closest } = refuseOtherFilms(film, title, list, { threshold, year, ...accessors });
    const match = bestMatch(title, eligible, { threshold, year, ...accessors });
    if (!match) {
      this.lastOtherFilm = closest();
      if (this.lastOtherFilm) logger.info(otherFilmLine('Library', this.lastOtherFilm, film));
      return null;
    }

    return {
      provider: 'http',
      id: match.item.id ?? match.item.url,
      title: match.item.title ?? match.item.name,
      year: match.item.year ?? null,
      score: match.score,
      localPath: null,
      size: Number(match.item.size ?? 0) || null,
      url: match.item.url,
      headers,
    };
  }

  downloadUrl(match) {
    return { url: match.url, headers: match.headers ?? {} };
  }
}

/* ------------------------------ Local folders ----------------------------- */

class LocalProvider {
  constructor(cfg) {
    this.roots = cfg.roots ?? [];
    this.extensions = cfg.extensions ?? ['.mp4', '.mkv'];
  }

  get configured() { return this.roots.length > 0; }

  async find(title, year, { threshold = 0.72, film = null } = {}) {
    this.lastOtherFilm = null;
    const candidates = [];
    for (const root of this.roots) {
      if (!fs.existsSync(root)) {
        logger.warn(`library root does not exist: ${root}`);
        continue;
      }
      this._walk(root, candidates, 0);
    }
    if (!candidates.length) return null;

    const accessors = { getTitle: (c) => c.title, getYear: (c) => c.year };
    const { eligible, closest } = refuseOtherFilms(film, title, candidates, { threshold, year, ...accessors });
    const match = bestMatch(title, eligible, { threshold, year, ...accessors });
    if (!match) {
      this.lastOtherFilm = closest();
      if (this.lastOtherFilm) logger.info(otherFilmLine('Local library', this.lastOtherFilm, film));
      return null;
    }

    const st = fs.statSync(match.item.path);
    return {
      provider: 'local',
      id: match.item.path,
      title: match.item.title,
      year: match.item.year,
      score: match.score,
      localPath: match.item.path,
      size: st.size,
      container: path.extname(match.item.path).slice(1),
    };
  }

  _walk(dir, out, depth) {
    if (depth > 4) return;   // media libraries are shallow; avoid runaway recursion
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        this._walk(full, out, depth + 1);
      } else if (this.extensions.includes(path.extname(e.name).toLowerCase())) {
        const base = path.basename(e.name, path.extname(e.name));
        const ym = base.match(/\b(19[0-9]{2}|20[0-9]{2})\b/);
        out.push({
          path: full,
          title: base.replace(/\b(19[0-9]{2}|20[0-9]{2})\b.*$/, '').replace(/[._]/g, ' ').trim() || base,
          year: ym ? Number(ym[1]) : null,
        });
      }
    }
  }

  downloadUrl() {
    throw new Error('local provider always resolves to a path, never a URL');
  }
}

/* -------------------------------- Factory --------------------------------- */

export function createProvider(libraryCfg, hooks = {}) {
  switch (libraryCfg.provider) {
    case 'jellyfin': return new JellyfinProvider(libraryCfg.jellyfin ?? {}, hooks);
    case 'plex':     return new PlexProvider(libraryCfg.plex ?? {});
    case 'http':     return new HttpProvider(libraryCfg.http ?? {});
    case 'local':    return new LocalProvider(libraryCfg.local ?? {});
    default:
      throw new Error(`unknown library provider: ${libraryCfg.provider}`);
  }
}

/**
 * Find a title and work out how to get at the bytes.
 * Returns null when the library simply does not have it.
 */
/**
 * What does the library actually call this film?
 *
 * Searches one significant WORD at a time - the server can match a single word
 * where it cannot match the phrase - and scores everything that comes back
 * against the title we are really after. Longest words first, because they are
 * the most selective, then progressively shorter prefixes of them, since a typo
 * usually sits in the middle or the end and the opening letters survive.
 *
 * Returns { title, year } or null. The caller re-searches for that exact name
 * to get a full match, rather than this trying to reconstruct one from the
 * trimmed rows rawSearch returns.
 */
export async function discoverTitle(provider, wantTitle, {
  threshold = 0.9, limit = 120, signal, alsoTry = [], year = null, typedYear = null, imdbId = null, typed = null,
  onOtherFilm = null,
} = {}) {
  if (typeof provider.rawSearch !== 'function') return null;

  // What is scored is not just wantTitle (OMDb's canonical name) but also
  // what the requester actually typed, year and noise stripped as
  // cleanRequestText does for a search term. "the fantastic 4: first steps
  // 2025" -> OMDb's "The Fantastic Four: First Steps" scored the library's
  // "The Fantastic 4: First Steps" at 0.85, just under this function's 0.9
  // bar, and the film was reported not in the library while it sat there
  // under the requester's own spelling. Scoring the typed text too - once the
  // trailing year that was dragging its own score down is gone - catches it.
  // keepMediaWords: this feeds a MATCH, not a search term. Dropping "movie"/
  // "film" here would repeat the Deathly Hallows incident cleanRequestText's
  // own doc comment describes - "the muppet movie" scoring as "the muppet"
  // and matching The Muppet Christmas Carol instead of staying unmatched.
  const candidates = [wantTitle, ...alsoTry.map((t) => cleanRequestText(t, { keepMediaWords: true }))]
    .map((t) => String(t ?? '').trim())
    .filter((t, i, a) => t && a.indexOf(t) === i);
  if (!candidates.length) return null;

  const words = new Set();
  for (const source of candidates) {
    for (const w of normalizeTitle(source).split(' ')) if (w.length > 2) words.add(w);
  }
  if (!words.size) return null;

  const byLength = [...words].sort((a, b) => b.length - a.length);
  const attempts = [];
  // A title the requester typed as ONE short token ("X2", "It", "Up") is
  // dropped by the length filter above and never searched, however exact it
  // is. On 2026-10-07 "X2 2003" -> OMDb's "X2: X-Men United" found nothing:
  // the words searched were "united" and "men", and the library's "X2 (2003)"
  // was reported missing. The typed token goes first; the scoring below still
  // judges what comes back, so a short word cannot match on its own.
  for (const c of candidates.slice(1)) {
    const n = normalizeTitle(c);
    if (n && !n.includes(' ')) attempts.push(n);
  }
  // The part before a colon is a name the library may use on its own. The
  // same member at 09:59, after the fix above, typed the full "X2: X-Men
  // United 2003": not one token, so "X2" was again never searched, the full
  // title scored 0.23 against the library's "X2", and they were again told it
  // was missing. Such a head only counts for a film of exactly the requested
  // year (headMatch below): "Dune" from 2021 is not "Dune: Part Two", nor
  // 1979's "Alien" "Alien: Romulus".
  const heads = [wantTitle, ...alsoTry]
    .map((t) => String(t ?? ''))
    .filter((t) => t.includes(':'))
    .map((t) => normalizeTitle(t.slice(0, t.indexOf(':'))))
    .filter((h, i, a) => h && a.indexOf(h) === i);
  // Searched only as one token, the case the word list above drops ("x2");
  // a longer head's words are searched already, and a phrase is what the
  // server's filter cannot match (title-mismatch.test.mjs).
  attempts.push(...heads.filter((h) => !h.includes(' ')));
  const headMatch = (it) => Number(year) > 0 && Number(it.year) === Number(year)
    && heads.includes(normalizeTitle(it.title));
  // One word written two ways is one search, not two. "Harry Potter the
  // sorcerers stone" (2026-10-06) beside OMDb's "...the Sorcerer's Stone"
  // spent both searches on "sorcerers" and "sorcerer", whose prefixes are
  // searched anyway, and "potter", which finds the film, was never searched.
  const distinct = [];
  for (const w of byLength) if (!distinct.some((d) => d.startsWith(w))) distinct.push(w);
  for (const w of distinct.slice(0, 2)) {
    attempts.push(w);
    for (const cut of [1, 2, 3]) {
      const p = w.slice(0, w.length - cut);
      if (p.length >= 4) attempts.push(p);
    }
  }

  const seen = new Set();
  let best = null;
  // The film refused below that would otherwise have won, for the caller's
  // "closest in the library" (onOtherFilm).
  let refused = null;
  const scoreOf = (it) => Math.max(...candidates.map((c) => similarity(c, it.title)), headMatch(it) ? 0.95 : 0);
  const wantImdb = normImdb(imdbId);
  for (const term of attempts) {
    if (seen.has(term)) continue;
    seen.add(term);
    let items;
    try {
      items = await provider.rawSearch(term, { limit, signal });
    } catch (err) {
      logger.warn(`word search for "${term}" failed: ${err.message}`);
      continue;
    }
    for (const it of items) {
      // A title the requested year rules out is not what the library calls
      // this film, however well it scores (Barefoot Gen for Barefoot 2014,
      // Dune 2021 for "Dune 1984", Fast & Furious 2009 for the 1939 film
      // OMDb made of "fast and furios 6" - see refuseOtherFilms). Skipping
      // it here lets a real one win instead. Not when it carries the film's
      // IMDb id and only its year, a few years off, is against it
      // (yearRuleYields: A Snapshot of Forever, 2025 to OMDb, 2022 on the
      // server) - the 1939 and 2009 films have different ids.
      const reason = whyOtherFilm({ title: wantTitle, year }, it, { typedYear, typed });
      if (reason && !yearRuleYields(reason, wantImdb, it.imdbId, { wantYear: year ?? typedYear, gotYear: it.year })) {
        const score = scoreOf(it);
        if (!refused || score > refused.score) refused = { title: it.title, year: it.year ?? null, score, reason };
        continue;
      }
      // A film carrying the IMDb id of the one asked for is what the library
      // calls it, however unlike the titles are: "Harry Potter and the
      // Philosopher's Stone" scored under the bar for "...the Sorcerer's
      // Stone" (tt0241527, 2026-10-06), and the film was listed as wanted.
      if (wantImdb && normImdb(it.imdbId) === wantImdb) {
        best = { ...it, score: 1, via: term, byImdb: true };
        break;
      }
      // 0.95: over the 0.9 bar, under an exact match of the whole title.
      const score = scoreOf(it);
      if (!best || score > best.score) best = { ...it, score, via: term };
    }
    if (best && best.score >= 0.9) break;      // no point widening the net
  }
  if (best?.byImdb) {
    logger.info(`the library holds ${wantImdb} as "${best.title}" (${best.year ?? '?'}), found searching "${best.via}"`);
    return best;
  }

  if (best && best.score >= threshold) return best;
  logger.info(`no library title resembles "${wantTitle}"`
    + (best ? ` (closest "${best.title}" @ ${best.score.toFixed(2)})` : ''));
  // A film this search refused as another one, that would have passed the
  // bar, is the answer to "but it's right there" (closestNote): only the
  // server's own search for the title used to report one, and Jellyfin
  // cannot find "Fast & Furious" by "Fast and Furious", so the film this
  // search found by a word went unnamed.
  if (refused && refused.score >= threshold) {
    logger.info(otherFilmLine('word search', refused, { title: wantTitle, year, typedYear, typed }));
    try { onOtherFilm?.(refused); } catch (err) { logger.warn(`onOtherFilm: ${err.message}`); }
  }
  return null;
}

/**
 * @param alsoTry extra titles worth searching for - typically what the person
 *   actually typed. OMDb canonicalises, and the library often does not agree
 *   with it: "f1" resolves to "F1: The Movie" while Jellyfin holds it as "F1",
 *   and searching only OMDb's version reported a film as missing when it was
 *   sitting right there. Requesters were told "not in the library" for titles
 *   the server had.
 * @param typedYear the year the member typed, when it names the film asked
 *   for (typedYearOf in util/fuzzy.js), or null. A copy more than a year from
 *   it is not a hit, even under the identical title: Dune (2021) is not
 *   "Dune 1984". Null - a bare title, whose `year` is only OMDb's guess -
 *   leaves same-titled copies to the matcher, as before.
 * @param onOtherFilm called, when nothing is found, with the closest film the
 *   library does hold that was refused as another film than `title` (`year`)
 *   or another year than `typedYear` - { title, year, score, reason } - so a
 *   caller can say what the lookup saw. Every search here is judged against
 *   the film requested, whatever words it was made with (see
 *   refuseOtherFilms).
 * @param imdbId the IMDb id of the film asked for (OMDb's imdbID), when the
 *   caller has it. A Jellyfin copy carrying it is the film, whatever the
 *   library calls it - but only once no title has matched, and still judged
 *   by refuseOtherFilms like any other candidate. Without it the lookup is
 *   exactly what it was.
 * @param typed the member's own words, when the caller has them. A copy of
 *   the identical title from a year far from `year` is then a hit only when
 *   those words are that title: a bare "dune" is answered with the Dune the
 *   server holds, as before, but "fast and furios 6", which OMDb took for
 *   Fast and Furious (1939), is not answered with Fast & Furious (2009)
 *   (whyOtherFilm, 2026-10-11). Without them the lookup is what it was.
 */
export async function findInLibrary(title, year, libraryCfg, {
  signal, onTokenRefreshed, alsoTry = [], onOtherFilm = null, typedYear = null, imdbId = null, typed = null,
} = {}) {
  const provider = createProvider(libraryCfg, { onTokenRefreshed });
  if (!provider.configured) {
    throw new Error(`library provider "${libraryCfg.provider}" is not configured`);
  }

  const wantImdb = normImdb(imdbId);
  const opts = {
    threshold: libraryCfg.matchThreshold ?? 0.72,
    timeoutMs: libraryCfg.searchTimeoutMs ?? 180000,
    signal,
    film: { title, year, typedYear: typedYear ?? null, imdbId: wantImdb, typed: typed || null },
  };

  // The closest film refused as another one, across every search below.
  let otherFilm = null;
  const noteOtherFilm = () => {
    const o = provider.lastOtherFilm;
    if (o && (!otherFilm || o.score > otherFilm.score)) otherFilm = o;
  };

  // Try the canonical title first, then anything else worth a look. Distinct
  // and non-empty only, so a request that already matches costs one call.
  const attempts = [title, ...alsoTry]
    .map((t) => String(t ?? '').trim())
    .filter((t, i, a) => t && a.indexOf(t) === i);

  let match = null;
  for (const t of attempts) {
    match = await provider.find(t, year, opts);
    if (match) {
      if (t !== title) logger.info(`library hit on "${t}" rather than "${title}"`);
      break;
    }
    noteOtherFilm();
  }

  // Ask the server for the IMDb id itself, where it can answer that (see
  // itemsByImdb: the live Jellyfin 10.11 cannot, and is asked once). A copy
  // found so is searched for by the library's own name, so the hit is built,
  // vetted and shaped by find() exactly as a title hit is.
  if (!match && wantImdb && typeof provider.itemsByImdb === 'function') {
    let carrying = [];
    try {
      carrying = await provider.itemsByImdb(wantImdb, { signal });
    } catch (err) {
      logger.warn(`looking ${wantImdb} up by id failed: ${err.message}`);
    }
    const named = [...carrying].sort((a, b) => yearGap(a.ProductionYear, year) - yearGap(b.ProductionYear, year))[0];
    if (named?.Name) {
      logger.info(`the library holds ${wantImdb} as "${named.Name}" (${named.ProductionYear ?? '?'}); searching for that`);
      match = await provider.find(named.Name, year, opts);
      if (!match) noteOtherFilm();
    }
  }

  // Every exact-ish attempt missed. Before reporting a film absent, find out
  // what the library actually calls it.
  //
  // Jellyfin's searchTerm is one un-tokenised filter over the stored name, so
  // the term has to appear as a literal contiguous run. OMDb canonicalises
  // titles and the library often disagrees on exactly the characters that
  // filter cares about. Measured against the real server:
  //
  //   searchTerm "Guardians of the Galaxy: Vol. 2"  ->  0 results
  //   searchTerm "Guardians"                        ->  14, including
  //                                                     "Guardians of the Galaxy Vol. 2 (2017)"
  //
  // One colon. The film was on the server the whole time and the requester was
  // told it was not in the library. Searching a single word finds the shelf,
  // and the fuzzy matcher - which is far better than the server's filter -
  // then picks the right title off it.
  if (!match) {
    // A deliberately higher bar than the direct search above. That search
    // scored rows the SERVER matched against the requested title; this one
    // searches a single word the requester never typed, and a wide net at 0.72
    // catches the wrong fish - "Crew girl" found "The Crow Girl" at 0.889 on
    // the TV side and sent six episodes of it.
    const recovered = await discoverTitle(provider, title, {
      ...opts, threshold: 0.9, alsoTry: attempts, year, typedYear, imdbId: wantImdb, typed: typed || null,
      onOtherFilm: (o) => { if (!otherFilm || o.score > otherFilm.score) otherFilm = o; },
    });
    if (recovered) {
      logger.info(`the library calls "${title}" -> "${recovered.title}"; searching again for that`);
      match = await provider.find(recovered.title, year, opts);
      // The server cannot always find a title by its own name. The live
      // Jellyfin holds tt0076759 as "Star Wars: Episode IV - A New Hope", and
      // searchTerm "Star Wars: Episode IV - A New Hope" answers nothing
      // (2026-10-11): the word search found the film under "star", by its
      // IMDb id, and this search lost it again, so a member who asked with
      // the full title was told it was not in the library, and it sat on the
      // wanted list for a month. The shelf the word found is searched again
      // instead, and the library's own name picks the film off it, judged
      // exactly as the search by name would have judged it.
      if (!match && recovered.via && recovered.via !== recovered.title) {
        logger.info(`nothing found searching "${recovered.title}" itself; taking it from the search for "${recovered.via}"`);
        match = await provider.find(recovered.title, year, { ...opts, searchAs: recovered.via });
      }
      if (!match) noteOtherFilm();
    }
  }

  if (!match) {
    if (otherFilm) {
      logger.info(`"${title}" (${year}) is not in the library; the closest film there, `
        + `"${otherFilm.title}" (${otherFilm.year}), is `
        + `${otherFilm.reason === 'year' ? `from another year than the ${askedYearOf(opts.film)} asked for` : 'a different film'}`);
      try { onOtherFilm?.(otherFilm); } catch (err) { logger.warn(`onOtherFilm: ${err.message}`); }
    }
    return null;
  }

  // If the file is readable from this server, use it in place - no transfer.
  if (match.localPath && fs.existsSync(match.localPath)) {
    try {
      fs.accessSync(match.localPath, fs.constants.R_OK);
      logger.info(`library hit (direct read): ${match.title} -> ${match.localPath}`);
      return { ...match, access: 'local', sameTitled: provider.lastSameTitled ?? [] };
    } catch {
      logger.info(`path ${match.localPath} exists but is not readable; will download instead`);
    }
  }

  const { url, headers } = provider.downloadUrl(match);
  logger.info(`library hit (download): ${match.title}`);
  // Each alternate copy gets its own URL so a caller can retry when the
  // primary entry points at a file that is no longer on disk.
  const alternates = (match.alternates ?? []).map((alt) => {
    if (alt.localPath && fs.existsSync(alt.localPath)) {
      try {
        fs.accessSync(alt.localPath, fs.constants.R_OK);
        return { ...alt, access: 'local' };
      } catch { /* fall through to a download */ }
    }
    const d = provider.downloadUrl(alt);
    return { ...alt, access: 'download', downloadUrl: d.url, downloadHeaders: d.headers };
  });
  return {
    ...match,
    access: 'download',
    downloadUrl: url,
    downloadHeaders: headers,
    alternates,
    sameTitled: provider.lastSameTitled ?? [],
  };
}

/**
 * How many results the "which one?" search asks for. The pipeline's own
 * search stops at 25, which a franchise can nearly fill on its own (the
 * operator's example was 22 films starting "Batman"), and Jellyfin's
 * un-tokenised searchTerm also returns every title that merely CONTAINS the
 * words. 60 leaves room for both in one round trip; when even that comes back
 * full, the caller is told (`full`) rather than handed a partial set.
 */
export const VERSIONS_SEARCH_LIMIT = 60;

/**
 * Every film the library holds whose title is this one or begins with it
 * (whole words), oldest first, each with the library's own rating - or null
 * when the provider cannot say.
 *
 *   { versions, full }
 *
 * `versions` has one entry per film (title and year) with the rating and
 * type of every copy of it. `full` is true when the search came back with as
 * many results as it asked for: there may then be more matches it did not
 * see, and the caller must not treat the set as complete.
 *
 * This is the search findInLibrary starts with, and one more when it finds
 * nothing: no word-by-word recovery. It answers "which films could this
 * request mean?", which is only worth asking of the title as typed; a
 * misspelling that needs recovering is not a question about versions, and
 * the ordinary pipeline will recover it as it always has.
 *
 * The one more is for punctuation. Jellyfin's searchTerm is a literal,
 * un-tokenised filter over the stored name, so "mission impossible" finds
 * nothing called "Mission: Impossible". On 2026-09-30 at 00:08 UTC the
 * testing group's "Mission Impossible" was answered "matches 0 film(s) on
 * the server", no list was offered, and the ordinary pipeline - which also
 * searches OMDb's own title, colon and all - went on to queue Mission:
 * Impossible (1996), with the six others on the server never offered. The
 * words are matched with the punctuation folded away (startsWithWords); only
 * the server's filter needed them literal. So when the typed words find no
 * title starting with them, the first word is searched on its own - every
 * such title contains it - and then, for "oceans" typed for "Ocean's", that
 * word without its last "s".
 *
 * Jellyfin only, because the answer has to carry each version's rating: a
 * version is only ever offered to a member once the library says it is
 * sendable, and the other providers do not report one.
 */
export async function libraryVersions(title, libraryCfg, {
  signal, onTokenRefreshed, timeoutMs, limit = VERSIONS_SEARCH_LIMIT,
} = {}) {
  const provider = createProvider(libraryCfg, { onTokenRefreshed });
  if (!(provider instanceof JellyfinProvider) || !provider.configured) return null;
  const search = (term) => provider.searchItems(term, {
    limit,
    timeoutMs: timeoutMs ?? libraryCfg.searchTimeoutMs ?? 180000,
    signal,
  });
  const accessors = { getTitle: (i) => i.Name, getYear: (i) => i.ProductionYear };
  let items = await search(title);
  let matched = startsWithMatches(title, items, accessors);
  // Nothing starts with the words: search the first of them alone (see
  // above). Only then, so a title the literal search finds is answered from
  // it as before, and a common first word ("star") cannot fill a search a
  // narrower one would not have.
  for (const term of matched.length ? [] : widerTerms(title)) {
    const more = await search(term);
    const got = startsWithMatches(title, more, accessors);
    if (got.length) { items = more; matched = got; break; }
  }
  // Each copy's rating and type ride along for pick-list.js, which lists
  // films only and only sendable ones. The search already asks for movies,
  // so for a real server `types` is all 'Movie'; it is carried so a list
  // never has to trust that. Each copy's id rides along too, so a bypass
  // entry added by Jellyfin link is matched to the copy it names.
  const versions = matched
    .map(({ item: i, copies }) => ({
      id: i.Id,
      title: i.Name,
      year: i.ProductionYear ?? null,
      rated: i.OfficialRating ?? null,
      ratings: copies.map((c) => c.OfficialRating ?? null),
      types: copies.map((c) => c.Type ?? null),
      ids: copies.map((c) => c.Id ?? null),
    }));
  return { versions, full: items.length >= limit };
}

/**
 * The wider searches for libraryVersions: the first word of the title on its
 * own, when it is not the whole search already, and that word without a
 * last "s" (an apostrophe the member left out, "oceans" for "Ocean's").
 */
function widerTerms(title) {
  const words = normalizeTitle(title).split(' ').filter(Boolean);
  const first = words[0];
  if (!first) return [];
  const terms = [];
  if (words.length > 1 || first !== String(title).trim().toLowerCase()) terms.push(first);
  if (first.length > 3 && first.endsWith('s')) terms.push(first.slice(0, -1));
  return terms;
}

/**
 * Last-resort title recovery, used only when the metadata lookup has failed.
 *
 * Neither OMDb nor TMDB does any fuzzy matching - "the dark night rises" and
 * "intersteller" both return nothing at all. The library, though, is a
 * bounded set of titles the requester could actually be sent, which makes it
 * a far better place to correct a spelling: search it with progressively
 * shorter prefixes of the request, then score every result against the FULL
 * original text.
 *
 * Returns { title, year, score } or null.
 */
export async function researchLibrary(requestText, libraryCfg, { signal, threshold = 0.78, limit = 120 } = {}) {
  const provider = createProvider(libraryCfg);
  if (!provider.configured) return null;
  if (typeof provider.rawSearch !== 'function') return null;

  const tokens = normalizeTitle(requestText).split(' ').filter((t) => t.length > 2);
  if (!tokens.length) return null;

  // Longest words first: they are the most selective, so they keep the
  // candidate list small and relevant.
  const byLength = [...tokens].sort((a, b) => b.length - a.length);

  // Whole word first, then progressively shorter prefixes of it. A typo
  // usually sits in the middle or at the end, so the opening letters survive
  // - "intersteller" still begins "interstell", "avatr" still begins "avat".
  const attempts = [];
  for (const w of byLength.slice(0, 2)) {
    attempts.push(w);
    for (const cut of [1, 2, 3]) {
      const p = w.slice(0, w.length - cut);
      if (p.length >= 4) attempts.push(p);
    }
  }

  // The year a member types after a title is not part of the library's title,
  // and left in it costs the score a third: "Mr 365 2018" scored the library's
  // "Mr. 365" (2018) at 0.56 and was answered "not recognised" while the film
  // sat there (Mia, 2026-09-29, twice). So a candidate is also scored
  // against the request with its year removed - but only when the candidate's
  // year agrees (within one), so a year that contradicts the film still counts
  // against it as it always did.
  const wantYear = extractYear(requestText);
  const bare = wantYear ? cleanRequestText(requestText, { keepMediaWords: true }) : '';
  // The number a request ends with is part of the film asked for: a title
  // without it is another film of the series, however close the rest. Asked
  // for "the fast and the furious 6", the library's The Fast and the Furious
  // (2001) scores 0.91 against Fast & Furious 6's 0.84, and would be
  // "recovered" for it, as Fast & Furious (2009) was sent for "fast and
  // furios 6" on 2026-10-11 (sequelNumber in util/fuzzy.js).
  const number = sequelNumber(requestText);
  // And a request ending in 1 asks for the bare title, which is scored
  // against the words without the 1 - but only a title of as many words, so
  // that a subtitle is not forgiven: "pirates of the caribbean 1" must not
  // be answered with the shortest film of the series that happens to carry
  // no number (firstFilmWords).
  const firstFilm = firstFilmWords(requestText);
  const wordCount = (s) => normalizeTitle(s).split(' ').filter(Boolean).length;

  const seen = new Set();
  let best = null;
  for (const term of attempts) {
    if (seen.has(term)) continue;
    seen.add(term);
    let items;
    try {
      items = await provider.rawSearch(term, { limit, signal });
    } catch (err) {
      logger.warn(`research search for "${term}" failed: ${err.message}`);
      continue;
    }
    for (const it of items) {
      if (!carriesNumber(it.title, number, { typed: requestText })) continue;
      let score = similarity(requestText, it.title);
      if (bare && it.year && Math.abs(it.year - wantYear) <= 1) {
        score = Math.max(score, similarity(bare, it.title));
      }
      if (firstFilm && wordCount(it.title) === wordCount(firstFilm)) {
        score = Math.max(score, similarity(firstFilm, it.title));
      }
      if (!best || score > best.score) best = { ...it, score, via: term };
    }
    // A strong hit means there is no point widening the net further.
    if (best && best.score >= 0.9) break;
  }

  if (best && best.score >= threshold) {
    logger.info(`research recovered "${requestText}" -> "${best.title}" (${best.year}) ` +
                `score ${best.score.toFixed(2)} via "${best.via}"`);
    return best;
  }
  logger.info(`research found nothing convincing for "${requestText}"` +
              (best ? ` (best "${best.title}" @ ${best.score.toFixed(2)})` : ''));
  return null;
}

/**
 * Why Queue link will not take a library item, when it is a series, a season
 * or an episode; null for anything else.
 *
 * Queue link (queueLibraryItem) is film-shaped: the film ratings, the film
 * posts group, film naming. A TV item sent through it was judged on the film
 * list with its series' rating ignored and matched only against film-style
 * entries, so the two ways of asking disagreed both ways (review of
 * 2026-09-29): a TV-14 episode of a TV-MA series was queued, and FMA:B
 * S01E14, which the operator's "season 1" entry covers, was refused and
 * pointed at the list it was already on. A show goes through the TV plugin,
 * which judges it on the TV rules.
 */
export const TV_ITEM_TYPES = Object.freeze(['Series', 'Season', 'Episode']);

export function tvItemRefusal(item) {
  if (!TV_ITEM_TYPES.includes(item?.type)) return null;
  return `This is a TV ${String(item.type).toLowerCase()}. Queue link only takes films: ask for it by name in the TV `
    + 'group, or re-run it by title from the queue box.';
}

/** Look one item up by its Jellyfin id. No matching - the id is exact. */
export async function libraryItemById(id, libraryCfg, hooks = {}) {
  const provider = createProvider(libraryCfg, hooks);
  if (!(provider instanceof JellyfinProvider)) {
    throw new Error('Queuing from a URL needs Jellyfin.');
  }
  if (!provider.configured) throw new Error('Jellyfin is not configured (Settings -> Library).');
  return provider.itemById(id);
}

/**
 * Page through every movie on the server. Jellyfin only: the catalogue needs
 * each title's rating, which the other providers do not expose the same way.
 */
export function libraryPager(libraryCfg, hooks = {}) {
  const provider = createProvider(libraryCfg, hooks);
  if (!(provider instanceof JellyfinProvider)) {
    throw new Error("The catalogue scan needs Jellyfin (it reads each title's rating).");
  }
  if (!provider.configured) throw new Error('Jellyfin is not configured (Settings -> Library).');
  return (startIndex, limit, { nameStartsWithOrGreater = null } = {}) =>
    provider.page(startIndex, limit, { nameStartsWithOrGreater });
}

export async function testLibrary(libraryCfg, hooks = {}) {
  try {
    const provider = createProvider(libraryCfg, hooks);
    if (!provider.configured) return { ok: false, error: 'not configured' };
    // A common title exercises auth and search without depending on the result.
    await provider.find('the', null, { threshold: 2, timeoutMs: Math.min(libraryCfg.searchTimeoutMs ?? 180000, 60000) });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
