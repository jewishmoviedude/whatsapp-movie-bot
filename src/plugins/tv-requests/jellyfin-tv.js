/**
 * Jellyfin TV enumeration: series -> seasons -> episodes.
 *
 * Jellyfin's "download whole season" is a client-side action - the server has
 * no single file for a season - so the bot enumerates the season's episodes
 * and fetches each one. Metadata (SeriesName / ParentIndexNumber / IndexNumber
 * / Name) is what the friendly filename is built from, never the messy path.
 *
 * The HTTP surface is injected so every function here is testable without a
 * server.
 */

import { stripTrailingYear, listCode } from './parse.js';

const DEFAULT_TIMEOUT = 60_000;

async function getJson(fetchImpl, url, headers, timeoutMs = DEFAULT_TIMEOUT, label = 'Jellyfin') {
  const t = AbortSignal.timeout ? { signal: AbortSignal.timeout(timeoutMs) } : {};
  const res = await fetchImpl(url, { headers, ...t });
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
  return res.json();
}

// OfficialRating is what the TV-MA / R gate checks - without it the gate is
// dead code and blocked shows would sail straight through. OriginalTitle and
// SortName are what a library stores for a show whose displayed Name does not
// match what people call it.
// RecursiveItemCount is how many episodes an entry really holds, and
// ProviderIds (TMDB, TVDB, IMDb) say whether two entries are one show: see
// preferStocked() and sameShow().
const SERIES_FIELDS = 'ProductionYear,OfficialRating,OriginalTitle,SortName,RecursiveItemCount,ProviderIds';

// Falling back to matching the library locally means paging through it.
//
// This was one request for the first 500 series, on the assumption that a TV
// library is hundreds of shows. Run against the real server it covered 500 of
// 8,506 - six per cent - so the fallback was decorative: it would have missed
// all but a handful of the shows it exists to catch, silently, and reported a
// confident "not in the library" either way.
//
// So page instead, and stop the moment something matches. The pages are only
// ever fetched on a miss, and the word-narrowing step before this one resolves
// most misses in one small request without reaching here at all.
const ENUMERATE_PAGE = 1_000;
const ENUMERATE_MAX = 20_000;

// Two thresholds, because the later steps are asking a different question.
//
// Steps 1-3 score rows the SERVER returned for the phrase the person actually
// typed, so a generous bar is right: the server has already vouched that the
// title is related to the request.
//
// Steps 4-5 do not have that. The word search deliberately looks for something
// the requester never typed - one word out of their title - and the listing
// looks at the whole library. Both are wide nets, and at 0.72 a wide net
// catches the wrong fish: a request for "Crew girl" searched "girl" alone,
// found "The Crow Girl" at 0.889, and sent six episodes of it. One letter, in
// the middle of a short word, between two real and different shows.
//
// So a match found by casting wider has to be much closer before it counts.
// Measured: crew/crow scores 0.889 and is now refused, while every title this
// fallback exists to recover still clears the bar - "kichen nightmares" 0.946,
// "Ramsay Kitchen Nightmares" 0.950, "Guardians of the Galaxy: Vol. 2" 1.000.
const DIRECT_THRESHOLD = 0.72;
const FALLBACK_THRESHOLD = 0.9;

const shape = (i, score, via) => ({
  id: i.Id ?? i.ItemId,
  name: i.Name,
  year: i.ProductionYear ?? null,
  rating: i.OfficialRating ?? null,
  ids: i.ProviderIds ?? null,
  score,
  via,
});

/** Every name a library entry might be known by, for local matching. */
const namesOf = (i) => [i.Name, i.OriginalTitle, i.SortName].filter(Boolean);

/**
 * A name reduced to its letters and digits, in any script, for "is this the
 * same title". It kept a-z only at first, which reduced 進撃の巨人 and every
 * other non-Latin OriginalTitle to "" - and "" equals "", so in review an
 * empty "Attack on Titan" was swapped for "Attack on Titan: Junior High".
 */
const plain = (n) => String(n ?? '').normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Do two library entries carry the same title under any of their names? */
const sameTitle = (a, b) => {
  const bs = new Set(namesOf(b).map(plain).filter(Boolean));
  return namesOf(a).map(plain).some((n) => n && bs.has(n));
};

const PROVIDERS = ['Tmdb', 'Tvdb', 'Imdb'];

/**
 * Are two library entries the same show? By their TMDB / TVDB / IMDb ids when
 * both carry one: on bot-box every real duplicate shares all three (American
 * Dad!, Supernatural, Blue Exorcist...) and every same-named different show
 * differs (Shameless 2004/2011, Charmed 1998/2018, Big Brother US/AU). Only
 * without ids to compare: the same title and the same year - never the title
 * alone, which put the UK Shameless's season 3 in for the US one's.
 */
function sameShow(a, b) {
  const ia = a.ProviderIds ?? {}, ib = b.ProviderIds ?? {};
  const shared = PROVIDERS.filter((k) => ia[k] && ib[k]);
  if (shared.length) return shared.some((k) => String(ia[k]) === String(ib[k]));
  return sameTitle(a, b) && !!a.ProductionYear && a.ProductionYear === b.ProductionYear;
}

/** Is `i` a year the request allows? No year asked, or none known, allows any. */
const yearFits = (i, year) => !year || !i.ProductionYear || Math.abs(i.ProductionYear - year) <= 1;

/**
 * The same show, in another entry that actually holds episodes.
 *
 * bot-box's library has two "American Dad!" (2005): `tv/American Dad!`, 22
 * empty season folders left behind when the files moved, and `tv/American
 * Dad! (2005) [tmdbid-1433]` with all 471 episodes. Jellyfin lists the empty
 * one first, the matcher keeps the first of two equal scores, and every season
 * came back "we don't have season 5 - on the server: seasons 1 to 22". Fourteen
 * shows on that server had such an empty twin, Supernatural among them.
 *
 * Only an entry with NO episodes is swapped, and only for one with the same
 * title (and a year the request allows): an empty exact match must never lose
 * to a merely similar show that happens to have files.
 */
function preferStocked(winner, items, year) {
  if (winner?.RecursiveItemCount !== 0) return winner;
  const twin = items
    .filter((i) => i !== winner && i.RecursiveItemCount > 0 && sameShow(i, winner) && yearFits(i, year))
    .sort((a, b) => b.RecursiveItemCount - a.RecursiveItemCount)[0];
  return twin ?? winner;
}

/** Best local match across all of an item's names, or null. */
function matchLocally(show, items, bestMatch, year = null, threshold = DIRECT_THRESHOLD) {
  if (!items.length) return null;
  if (bestMatch) {
    // Flatten to one candidate per (item, name) so a show found under its
    // OriginalTitle still scores, then keep the item behind the winner.
    const flat = [];
    for (const i of items) for (const n of namesOf(i)) flat.push({ item: i, name: n });
    const m = bestMatch(show, flat, {
      threshold,
      year,
      getTitle: (c) => c.name,
      getYear: (c) => c.item.ProductionYear,
    });
    return m ? { item: preferStocked(m.item.item, items, year), score: m.score } : null;
  }
  const lower = String(show).toLowerCase().trim();
  const exact = items.find((i) => namesOf(i).some((n) => String(n).toLowerCase().trim() === lower));
  return exact ? { item: preferStocked(exact, items, year), score: 1 } : null;
}

/**
 * Other entries with the same title as `series`, that hold episodes, most
 * episodes first. For a show split across two folders - each with some of
 * the seasons (bot-box has "The Biggest Loser" as 25 + 175 episodes, "Blue
 * Exorcist" as 14 + 73) - the season asked for may be in the one not picked.
 * A year in the request still has to fit, so "Charmed 2018 season 8" does not
 * turn into the 1998 show.
 */
export async function findTwins(series, { base, token, userId, fetchImpl = fetch, year = null } = {}) {
  if (!series?.name) return [];
  const url = new URL(`${base}/Items`);
  url.searchParams.set('searchTerm', series.name);
  url.searchParams.set('IncludeItemTypes', 'Series');
  url.searchParams.set('Recursive', 'true');
  url.searchParams.set('Limit', '25');
  url.searchParams.set('Fields', SERIES_FIELDS);
  if (userId) url.searchParams.set('UserId', userId);
  const data = await getJson(fetchImpl, url.toString(), { 'X-Emby-Token': token, Accept: 'application/json' });
  const me = { Name: series.name, ProductionYear: series.year, ProviderIds: series.ids };
  return (data.Items ?? [])
    .filter((i) => (i.Id ?? i.ItemId) !== series.id && i.RecursiveItemCount !== 0 && sameShow(i, me) && yearFits(i, year))
    .sort((a, b) => (b.RecursiveItemCount ?? 0) - (a.RecursiveItemCount ?? 0))
    .map((i) => shape(i, 1, 'twin'));
}

/**
 * Other SHOWS with the same title as `series` - a different show by their
 * provider ids, not a twin - that hold episodes, most episodes first, and
 * whose year the request allows.
 *
 * The library holds "Avatar the Last Airbender" (2024, the live action, two
 * seasons) and "Avatar: The Last Airbender" (2005, the cartoon, three). A
 * request with no year matched the live action, the closer spelling, so
 * "avatar the last airbender season 3" was answered "we don't have season 3"
 * (BATMAN, 2026-09-27), and Ari raised it as #issue #04 on 2026-10-11: "the
 * bot doesn't realize season three of avatar the last air bender. The
 * animated series from 2005 exists". The operator, 2026-10-13: "Avatar: The
 * Last Airbender is on server". resolveEpisodes asks these only for a season
 * or episodes the picked show does not have, never to replace one it has, and
 * a year in the request still has to fit, so "Charmed 2018 season 8" does not
 * become the 1998 show.
 */
export async function findNamesakes(series, { base, token, userId, fetchImpl = fetch, year = null } = {}) {
  if (!series?.name) return [];
  // searchTerm is one LIKE over the stored name, so "Avatar the Last
  // Airbender" never finds "Avatar: The Last Airbender" for the colon: the
  // title's longest word is asked too, and sameTitle below does the matching.
  const longest = plain(series.name).split(' ').sort((a, b) => b.length - a.length)[0] ?? '';
  const terms = [...new Set([series.name, ...(longest.length >= 4 ? [longest] : [])])];
  const items = new Map();
  for (const term of terms) {
    const url = new URL(`${base}/Items`);
    url.searchParams.set('searchTerm', term);
    url.searchParams.set('IncludeItemTypes', 'Series');
    url.searchParams.set('Recursive', 'true');
    url.searchParams.set('Limit', '50');
    url.searchParams.set('Fields', SERIES_FIELDS);
    if (userId) url.searchParams.set('UserId', userId);
    const data = await getJson(fetchImpl, url.toString(), { 'X-Emby-Token': token, Accept: 'application/json' });
    for (const i of data.Items ?? []) items.set(i.Id ?? i.ItemId, i);
  }
  const me = { Name: series.name, ProductionYear: series.year, ProviderIds: series.ids };
  return [...items.values()]
    .filter((i) => (i.Id ?? i.ItemId) !== series.id && i.RecursiveItemCount !== 0
      && sameTitle(i, me) && !sameShow(i, me) && yearFits(i, year))
    .sort((a, b) => (b.RecursiveItemCount ?? 0) - (a.RecursiveItemCount ?? 0))
    .map((i) => shape(i, 1, 'namesake'));
}

/**
 * Find a series by name. Returns null when nothing matches confidently.
 *
 * This is the ONLY function in the codebase that can find a TV series, so
 * every "not in the library" answer about a show is ultimately its verdict -
 * both for the TV plugin and for the movie plugin's "actually, that is a
 * series" escape hatch. It used to be one `/Items?searchTerm=` query, and a
 * show it could not see simply did not exist.
 *
 * That single query is weaker than it looks, in three separate ways:
 *
 *  - `searchTerm` on /Items is one LIKE filter over the stored name. It does
 *    not tokenise, so "Kitchen Nightmares" need not match a library entry
 *    called "Ramsay's Kitchen Nightmares". The Jellyfin web UI, where people
 *    check before reporting a bug, does NOT use this endpoint - it uses
 *    /Search/Hints, which matches quite differently. Hence "it is right there
 *    and the bot says you do not have it".
 *  - `UserId` scopes the query to the libraries THAT account may see. A bot
 *    user without access to the TV folder gets a clean, empty, 200 response.
 *  - A show may be stored under an OriginalTitle or SortName that the
 *    displayed Name does not contain.
 *
 * So: try the cheap query, then the endpoint the UI uses, then the same query
 * unscoped, and finally pull the series list and match locally with the fuzzy
 * matcher - which is far better than the server's filter and was previously
 * only ever shown rows the server had already chosen. Each step reports how it
 * found the show in `via`, so the log can say which one saved it and the
 * underlying misconfiguration can be fixed rather than papered over.
 */
async function findSeriesOnce(show, { base, token, userId, fetchImpl = fetch, bestMatch, year = null, onDiagnostic = null } = {}) {
  const headers = { 'X-Emby-Token': token, Accept: 'application/json' };
  const note = (msg) => { try { onDiagnostic?.(msg); } catch { /* diagnostics never break a lookup */ } };

  const itemsUrl = (term, { scoped = true, limit = 25, start = 0 } = {}) => {
    const url = new URL(`${base}/Items`);
    if (term) url.searchParams.set('searchTerm', term);
    url.searchParams.set('IncludeItemTypes', 'Series');
    url.searchParams.set('Recursive', 'true');
    url.searchParams.set('Limit', String(limit));
    if (start) url.searchParams.set('StartIndex', String(start));
    url.searchParams.set('Fields', SERIES_FIELDS);
    if (scoped && userId) url.searchParams.set('UserId', userId);
    return url.toString();
  };

  // One series by its id, with SERIES_FIELDS: what every layer below that
  // does not list series itself has to fetch before it can return one.
  const seriesById = async (id) => {
    const url = new URL(`${base}/Items`);
    url.searchParams.set('Ids', String(id));
    url.searchParams.set('Recursive', 'true');
    url.searchParams.set('Fields', SERIES_FIELDS);
    if (userId) url.searchParams.set('UserId', userId);
    const data = await getJson(fetchImpl, url.toString(), headers);
    return (data.Items ?? []).find((i) => String(i.Id ?? i.ItemId).toLowerCase() === String(id).toLowerCase()) ?? null;
  };

  // 1. The cheap, scoped query - what this used to do, and what still answers
  //    the overwhelming majority of requests in one round trip.
  const first = await getJson(fetchImpl, itemsUrl(show), headers);
  const items = first.Items ?? [];
  const hit = matchLocally(show, items, bestMatch, year);
  if (hit) return shape(hit.item, hit.score, 'search');

  if (items.length) {
    note(`Jellyfin returned ${items.length} series for "${show}" but none matched: `
      + `${items.slice(0, 5).map((i) => i.Name).join(', ')}`);
  }

  // 2. /Search/Hints - the endpoint the Jellyfin UI itself uses. Word-aware,
  //    and it searches OriginalTitle and SortName too.
  let hinted = null;
  try {
    const url = new URL(`${base}/Search/Hints`);
    url.searchParams.set('searchTerm', show);
    url.searchParams.set('includeItemTypes', 'Series');
    url.searchParams.set('limit', '25');
    if (userId) url.searchParams.set('userId', userId);
    const hints = await getJson(fetchImpl, url.toString(), headers, DEFAULT_TIMEOUT, 'Jellyfin search hints');
    const hintItems = (hints.SearchHints ?? []).map((h) => ({
      Id: h.Id ?? h.ItemId, Name: h.Name, ProductionYear: h.ProductionYear ?? null,
    }));
    hinted = matchLocally(show, hintItems, bestMatch, year);
  } catch (err) {
    note(`/Search/Hints unavailable (${err.message}) - falling through`);
  }
  if (hinted) {
    // A search hint is only a name, a year and an id - no OfficialRating. This
    // layer used to return the show with its rating null, and the TV plugin's
    // series-level gate reads that rating: a TV-MA show found only through
    // /Search/Hints went past the ⛔, and a season of it whose episodes carry
    // no rating of their own was queued whole. So the series itself is read
    // back with the same fields every other layer returns. If that read
    // fails, the lookup fails (the requester gets ⚠️ and can ask again): a
    // show whose rating could not be read must not be sent as though it had
    // none.
    const full = await seriesById(hinted.item.Id);
    if (full) {
      note(`"${show}" was invisible to /Items?searchTerm but found via /Search/Hints as "${full.Name}"`);
      return shape(full, hinted.score, 'hints');
    }
    note(`/Search/Hints named "${hinted.item.Name}" (${hinted.item.Id}), but the bot's Jellyfin user `
      + 'cannot read that series - falling through');
  }

  // 3. The same query with no UserId. If this finds it, the bot's Jellyfin
  //    account cannot see the library the show is in - a configuration problem
  //    the operator can actually fix, and one that would otherwise present as
  //    a plain "not in the library".
  if (userId) {
    try {
      const un = await getJson(fetchImpl, itemsUrl(show, { scoped: false }), headers);
      const m = matchLocally(show, un.Items ?? [], bestMatch, year);
      if (m) {
        note(`"${m.item.Name}" is on the server but INVISIBLE to the bot's Jellyfin user `
          + `(${userId}). Give that account access to the TV library, and check its `
          + 'Max Parental Rating.');
        return shape(m.item, m.score, 'unscoped');
      }
    } catch (err) {
      note(`unscoped retry failed (${err.message})`);
    }
  }

  // 4. Search for each significant WORD on its own.
  //
  //    This is the step that turns "Kitchen Nightmares" into "Ramsay's Kitchen
  //    Nightmares": the server cannot match the phrase, but it matches
  //    "Nightmares" happily, and the fuzzy matcher then picks the right row out
  //    of the handful that come back. Far cheaper than listing the library, and
  //    it resolves nearly every miss that gets this far. The same trick
  //    researchLibrary already uses on the movie side.
  const words = [...new Set(String(show).split(/\s+/).filter((w) => w.length >= 4))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  for (const word of words) {
    try {
      const r = await getJson(fetchImpl, itemsUrl(word), headers);
      const m = matchLocally(show, r.Items ?? [], bestMatch, year, FALLBACK_THRESHOLD);
      if (m) {
        note(`"${show}" matched "${m.item.Name}" only when searching for "${word}" alone - `
          + "Jellyfin's own search cannot connect the full phrase to that title");
        return shape(m.item, m.score, 'word');
      }
    } catch (err) {
      note(`word search for "${word}" failed (${err.message})`);
    }
  }

  // 5. Last resort: page the whole series list and match locally.
  //
  //    Bounded and early-exiting, because a real library is much bigger than
  //    this fallback originally assumed - the server this runs against holds
  //    8,506 series, so the single 500-item request it used to make covered six
  //    per cent of it and then reported a confident miss.
  try {
    let seen = 0;
    let total = null;
    for (let start = 0; start < ENUMERATE_MAX; start += ENUMERATE_PAGE) {
      const page = await getJson(fetchImpl, itemsUrl(null, { limit: ENUMERATE_PAGE, start }), headers);
      const list = page.Items ?? [];
      total ??= page.TotalRecordCount ?? null;
      seen += list.length;

      const m = matchLocally(show, list, bestMatch, year, FALLBACK_THRESHOLD);
      if (m) {
        note(`"${show}" matched "${m.item.Name}" only after listing the library - `
          + "Jellyfin's own search does not connect the two");
        return shape(m.item, m.score, 'enumerated');
      }
      if (list.length < ENUMERATE_PAGE) break;          // that was the last page
    }
    // Say what was actually covered. A cap that silently truncates reads as
    // "we looked everywhere" when it did not.
    note(`no series matched "${show}" in ${seen}`
      + `${total != null && total > seen ? ` of ${total}` : ''} series`
      + `${total != null && total > seen ? ' (search stopped at the page cap)' : ''}`);
  } catch (err) {
    note(`full series listing failed (${err.message})`);
  }

  return null;
}

/**
 * Seasons of a series, in order. `episodes` is how many each holds (null
 * when the server does not say): a season folder can be empty, and a list of
 * "what we have" must not offer one.
 */
export async function listSeasons(seriesId, { base, token, userId, fetchImpl = fetch } = {}) {
  const url = new URL(`${base}/Shows/${seriesId}/Seasons`);
  if (userId) url.searchParams.set('UserId', userId);
  url.searchParams.set('Fields', 'ChildCount');
  const data = await getJson(fetchImpl, url.toString(), { 'X-Emby-Token': token, Accept: 'application/json' });
  return (data.Items ?? [])
    .map((s) => ({ id: s.Id, season: s.IndexNumber ?? null, name: s.Name ?? null, episodes: s.ChildCount ?? null }))
    .filter((s) => s.season != null)
    .sort((a, b) => a.season - b.season);
}

/** The seasons that hold episodes; all of them when the server gives no counts. */
const stockedSeasons = (seasons) => seasons.filter((s) => s.episodes !== 0).map((s) => s.season);

/**
 * The episode number in a file name Jellyfin could not number: the last
 * stand-alone run of one to three digits ("Erai-raws.Sousou.no.Frieren-25.
 * 720p..." -> 25), or an explicit E25 / S01E25. Null when there is none. A
 * resolution (720p), a year-length or longer number (a release hash) and
 * digits inside a word are never it.
 */
export function episodeNumberFromName(name) {
  const base = String(name ?? '').split('/').pop().replace(/\.[a-z0-9]{2,4}$/i, '');
  const se = /\bS\d{1,2}\s?E(\d{1,4})\b/i.exec(base) ?? /(?:^|[\s._-])E(?:P|pisode)?\s?(\d{1,4})(?=$|[\s._-])/i.exec(base);
  if (se) return Number(se[1]);
  const runs = base.split(/[\s._\-\[\]()]+/).filter((t) => /^\d{1,3}(?:v\d)?$/i.test(t));
  return runs.length ? Number.parseInt(runs[runs.length - 1], 10) : null;
}

const RESOLUTION_NUMBERS = new Set([360, 480, 540, 576, 720, 1080, 1440, 2160]);

/** Only an explicit E25 / S01E25 / Episode 25 in a file name, never a bare number. */
export function explicitEpisodeFromName(name) {
  const base = String(name ?? '').split('/').pop().replace(/\.[a-z0-9]{2,4}$/i, '');
  const se = /\bS\d{1,2}\s?E(\d{1,4})\b/i.exec(base) ?? /(?:^|[\s._-])E(?:P|pisode)?\s?(\d{1,4})(?=$|[\s._-])/i.exec(base);
  return se ? Number(se[1]) : null;
}

/**
 * Episodes of a series, optionally limited to one season.
 * Everything needed for the filename and the download comes back here.
 *
 * A season Jellyfin could not fully number is fetched by its folder too. On
 * 2026-10-06 Ari (+1555***0178) asked for Frieren season 1 and was sent 3
 * episodes: 25 of the 28 files in the "Season 1" folder were named the way
 * fansub groups name anime ("Erai-raws.Sousou.no.Frieren-25.720p..."),
 * Jellyfin gave them no season or episode number, and `?season=1` filters on
 * that number. So when the season's folder holds more than `?season=` gave
 * back, the folder is asked for by its id, which returns every file; one
 * Jellyfin could not number takes the folder's season and the number in its
 * file name, and one whose number another episode in the season already has
 * is left out as a copy. A season that came back whole costs one more call.
 */
export async function listEpisodes(seriesId, { season = null, base, token, userId, fetchImpl = fetch } = {}) {
  const fetchList = async (params) => {
    const url = new URL(`${base}/Shows/${seriesId}/Episodes`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('Fields', 'Path,MediaSources,Overview,OfficialRating');
    if (userId) url.searchParams.set('UserId', userId);
    return (await getJson(fetchImpl, url.toString(), { 'X-Emby-Token': token, Accept: 'application/json' })).Items ?? [];
  };
  const map = (e, folder = null) => {
    const src = e.MediaSources?.[0];
    const localPath = src?.Path ?? e.Path ?? null;
    // Numbered by Jellyfin, or - only inside the season folder asked for -
    // from the file name.
    const guessed = folder && e.IndexNumber == null ? episodeNumberFromName(localPath ?? e.Name) : null;
    // Jellyfin sometimes reads the resolution in "gotei-cg-e01-720p" as the
    // episode: 13 files of Code Geass season 1 were all "episode 720", so Ari
    // (2026-10-18) asking for s1 e1 was told there was no episode 1. A
    // resolution-sized number is trusted only when the file name has no
    // explicit episode number of its own saying otherwise.
    const fixed = RESOLUTION_NUMBERS.has(e.IndexNumber) ? explicitEpisodeFromName(localPath ?? e.Name) : null;
    if (fixed != null && fixed !== e.IndexNumber) e = { ...e, IndexNumber: fixed, IndexNumberEnd: null };
    return {
      id: e.Id,
      series: e.SeriesName ?? null,
      season: e.ParentIndexNumber ?? (guessed != null ? folder.season : null),
      episode: e.IndexNumber ?? guessed,
      // A double-episode file (S02E21-E22) is one item whose IndexNumberEnd is
      // the last episode it holds.
      ...(e.IndexNumber != null && e.IndexNumberEnd > e.IndexNumber ? { episodeEnd: e.IndexNumberEnd } : {}),
      ...(guessed != null ? { numberedFromName: true } : {}),
      title: e.Name ?? null,
      rating: e.OfficialRating ?? null,
      localPath,
      size: Number(src?.Size ?? 0) || null,
      container: src?.Container ?? null,
      // Which season and series item this episode belongs to, so a rating
      // override pasted as a season or series link can match it exactly
      // (rating-overrides.js tvOverrideFor).
      seasonId: e.SeasonId ?? folder?.id ?? null,
      seriesId: e.SeriesId ?? null,
    };
  };

  const list = (await fetchList(season != null ? { season: String(season) } : {})).map((e) => map(e));
  if (season == null) return list;

  let folder = null;
  try {
    folder = (await listSeasons(seriesId, { base, token, userId, fetchImpl })).find((x) => x.season === Number(season)) ?? null;
  } catch { /* what ?season= gave is the answer, as before */ }
  if (!folder || !(folder.episodes > list.length)) return list;

  let more = [];
  try {
    const have = new Set(list.map((e) => e.id));
    more = (await fetchList({ seasonId: folder.id })).filter((e) => !have.has(e.Id)).map((e) => map(e, folder));
  } catch { return list; }
  // A number read from a file name never displaces one Jellyfin gave, or an
  // earlier copy: Frieren's season 1 folder held episode 8 twice.
  const taken = new Set(list.filter((e) => e.episode != null).map((e) => `${e.season}:${e.episode}`));
  return [...list, ...more.filter((e) => {
    if (!e.numberedFromName) return false;
    const k = `${e.season}:${e.episode}`;
    if (taken.has(k)) return false;
    taken.add(k);
    return true;
  })];
}

/**
 * What the content check is told about episodes beyond their name and number:
 * the synopsis, the provider ids and the air date. Fetched only for the few
 * episodes a rating override puts in front of the check, rather than carried
 * on every episode, because episodes are journalled whole in state.json and a
 * season of synopses would ride along with every one.
 *
 * Resolves to a Map of id -> { overview, ids, premiere }. A lookup that fails
 * resolves to what it has - the check still runs on the name and number.
 */
export async function episodeDetails(ids, { base, token, userId, fetchImpl = fetch } = {}) {
  const out = new Map();
  const list = [...new Set((ids ?? []).filter(Boolean))];
  for (let i = 0; i < list.length; i += 50) {
    const url = new URL(`${base}/Items`);
    url.searchParams.set('Ids', list.slice(i, i + 50).join(','));
    url.searchParams.set('Fields', 'Overview,ProviderIds,PremiereDate');
    if (userId) url.searchParams.set('UserId', userId);
    try {
      const data = await getJson(fetchImpl, url.toString(), { 'X-Emby-Token': token, Accept: 'application/json' }, 20_000);
      for (const it of data.Items ?? []) {
        if (!list.includes(it.Id)) continue;
        out.set(it.Id, { overview: it.Overview ?? null, ids: it.ProviderIds ?? null, premiere: it.PremiereDate ?? null });
      }
    } catch { /* the check runs on what it has */ }
  }
  return out;
}

/**
 * What a pasted Jellyfin link is, for the rating-override list: a film, a
 * series, a season or an episode, and of what. The entry matches on the id
 * alone whatever this says; it is looked up so the list can show an admin
 * what the entry covers.
 *
 * Resolves to { type, covers } or null when nothing has that id.
 */
export async function describeTvItem(id, { base, token, userId, fetchImpl = fetch } = {}) {
  const url = new URL(`${base}/Items`);
  url.searchParams.set('Ids', id);
  url.searchParams.set('Recursive', 'true');
  url.searchParams.set('Fields', 'ProductionYear,ProviderIds');
  if (userId) url.searchParams.set('UserId', userId);
  const data = await getJson(fetchImpl, url.toString(), { 'X-Emby-Token': token, Accept: 'application/json' }, 20_000);
  const it = (data.Items ?? []).find((x) => String(x.Id).toLowerCase() === String(id).toLowerCase());
  if (!it) return null;
  const p2 = (n) => String(n ?? 0).padStart(2, '0');
  const show = it.SeriesName ?? it.Name;
  const year = it.ProductionYear ? ` (${it.ProductionYear})` : '';
  switch (it.Type) {
    // The series itself too, shaped as findSeries shapes one, so its twins
    // (the same show's other library entries) can be looked up from it.
    case 'Series': return {
      type: 'series',
      covers: `${it.Name}${year} — whole series`,
      series: { id: it.Id, name: it.Name, year: it.ProductionYear ?? null, ids: it.ProviderIds ?? null },
    };
    case 'Season': return { type: 'season', covers: `${show} — ${it.Name ?? `season ${it.IndexNumber}`}` };
    case 'Episode': return {
      type: 'episode',
      covers: `${show} S${p2(it.ParentIndexNumber)}E${p2(it.IndexNumber)}${it.Name ? ` "${it.Name}"` : ''}`,
    };
    case 'Movie': return { type: 'movie', covers: `${it.Name}${year} — film` };
    default: return { type: String(it.Type ?? 'unknown').toLowerCase(), covers: null };
  }
}

/**
 * The name and year of every item of one type ('Series' or 'Movie') the bot's
 * Jellyfin user can see, paged as findSeries() pages its last resort. For the
 * rating-override list's "matches now" line, which matches names by their
 * start with case, spaces and punctuation ignored - something no Jellyfin
 * search does ("full metal alchemist" finds nothing there, while it covers
 * "Fullmetal Alchemist") - so the names are listed and matched here. Never
 * for finding a show to send, which is findSeries()'s job alone.
 */
export async function listItemNames(type, { base, token, userId, fetchImpl = fetch } = {}) {
  const out = [];
  for (let start = 0; start < ENUMERATE_MAX; start += ENUMERATE_PAGE) {
    const url = new URL(`${base}/Items`);
    url.searchParams.set('IncludeItemTypes', type);
    url.searchParams.set('Recursive', 'true');
    url.searchParams.set('Fields', 'ProductionYear');
    url.searchParams.set('EnableImages', 'false');
    url.searchParams.set('EnableUserData', 'false');
    url.searchParams.set('Limit', String(ENUMERATE_PAGE));
    if (start) url.searchParams.set('StartIndex', String(start));
    if (userId) url.searchParams.set('UserId', userId);
    const page = await getJson(fetchImpl, url.toString(), { 'X-Emby-Token': token, Accept: 'application/json' }, 30_000);
    const list = page.Items ?? [];
    for (const i of list) if (i?.Name) out.push({ id: i.Id ?? null, name: i.Name, year: i.ProductionYear ?? null });
    if (list.length < ENUMERATE_PAGE) break;
  }
  return out;
}

/**
 * One file per episode. The library can hold an episode twice under the
 * same numbers: American Dad!'s "Season 16" folder holds a second copy of
 * season 15 (American.Dad.S15E01.720p.WEBRip... beside "Season 15"'s
 * American.Dad!.-.S15E01.-.WEBDL...), Jellyfin numbers both S15E01, and
 * "american dad season 15" resolved to 35 files with every episode twice -
 * found 2026-10-13 checking the operator's "american dad s15 is on server".
 * The copy inside the folder named for its season is kept, else the first.
 */
export function oneCopyEach(episodes) {
  const inOwnFolder = (e) => {
    const dir = String(e.localPath ?? '').split(/[\\/]/).slice(-2, -1)[0] ?? '';
    const m = dir.match(/^(?:season|series|s)\s*0*(\d+)$/i);
    return !!m && Number(m[1]) === e.season;
  };
  const kept = new Map();
  for (const e of episodes) {
    if (!Number.isFinite(e.episode)) { kept.set(Symbol('unnumbered'), e); continue; }
    // Copies rated differently both stay: the TV plugin picks the copy its
    // rating rules allow (tv-rating-withheld, the TV-14 and TV-MA copies of
    // Fullmetal Alchemist's E14).
    const k = `${e.season}:${e.episode}:${e.episodeEnd ?? e.episode}:${e.rating ?? ''}`;
    const had = kept.get(k);
    if (!had || (!inOwnFolder(had) && inOwnFolder(e))) kept.set(k, e);
  }
  return [...kept.values()];
}

/**
 * Resolve a parsed request into the exact list of episodes to send.
 *
 * - "Show S01E01"     -> that one episode
 * - "Show S01E01-E05" -> those episodes of season 1 that the server has
 * - "Show S01E06, E09" -> those two, if the server has them; the ones it has
 *                         not are named in `missing`, with the season's
 *                         episodes in `episodesInSeason`
 * - "Show season 2"    -> every episode of season 2, in order
 * - "Show"             -> nothing; the caller must ask which season, because
 *                         dumping an entire series into a group is never intended
 *
 * `opts.knownSeries` is a series an earlier lookup for the same request found
 * (the TV plugin's several-seasons path): the search is not run again for
 * each season, which on a show found only by listing the library would page
 * through it once per season.
 */
export async function resolveEpisodes(parsed, opts = {}) {
  // "The Boys 2019" must still find "The Boys": a trailing year would drag the
  // title similarity below the match threshold. The year is not thrown away -
  // it is handed to the matcher as a tiebreaker, which is the only thing that
  // can separate two shows sharing a name (the 2004 UK "Kitchen Nightmares"
  // from the 2007 US one). Previously it was extracted and then dropped, so
  // the wrong show could win and the request came back as an empty season.
  const { show, year } = stripTrailingYear(parsed.show);
  const withYear = { ...opts, year };
  let series = opts.knownSeries ?? await findSeries(show, withYear)
    ?? (show !== parsed.show ? await findSeries(parsed.show, withYear) : null);
  // "avatar the last Airbender book 1: water" is how people name a season of
  // a show the library files as plain "Avatar the Last Airbender" (the
  // 2026-10-07 19:00Z miss): the subtitle drags the similarity under the
  // threshold. Only after every full-title lookup has failed is the part
  // before the colon tried, and "book N" with it, so a show that really has a
  // colon in its title is still found by its whole name first.
  if (!series && !opts.knownSeries) {
    const head = show.split(':')[0].replace(/\s+(book|part|volume|vol\.?)\s*\d+\s*$/i, '').trim();
    if (head && head !== show && head.length >= 3) series = await findSeries(head, withYear);
  }
  if (!series) return { error: 'not-found', series: null, episodes: [] };
  // A run of episodes ("S01E01-E05") is one request for exactly those, and a
  // list ("S01E06, E09") for exactly the episodes it names.
  const range = parsed.episodeRange ?? null;
  const named = parsed.episodeList?.length ? parsed.episodeList : null;
  // A double-episode file answers for every episode it holds: on 2026-10-10
  // Gil asked for Agents of S.H.I.E.L.D. S02E22 and was told there
  // is no episode 22, the library's only file being "S02E21-E22".
  const last = (e) => e.episodeEnd ?? e.episode;
  const holds = (e, n) => Number.isFinite(e.episode) && e.episode <= n && n <= last(e);
  const wanted = (e) => (parsed.episode != null ? e.episode <= parsed.episode && parsed.episode <= last(e)
    : range ? e.episode <= range.to && last(e) >= range.from
      : named ? named.some((n) => holds(e, n)) : true);
  const someEpisodes = parsed.episode != null || !!range || !!named;

  // The same show's other entries (sameShow: same provider ids), looked up
  // only when an answer needs them, and only once. A season they hold is used
  // whole; it is never merged episode by episode with the picked entry's.
  let twins = null;
  const twinsOf = async (of) => {
    if (twins) return twins;
    try { twins = await findTwins(of, withYear); } catch { twins = []; }
    return twins;
  };
  // The seasons that hold episodes, across the entry and its twins: a split
  // show's seasons are spread over both, and an empty leftover's own season
  // folders hold nothing at all.
  const seasonsHeld = async () => {
    const have = new Set();
    for (const id of [series.id, ...(await twinsOf(series)).map((t) => t.id)]) {
      try { for (const n of stockedSeasons(await listSeasons(id, opts))) have.add(n); } catch { /* one entry is enough */ }
    }
    return [...have].sort((a, b) => a - b);
  };

  if (parsed.season == null && !someEpisodes) {
    const seasons = await seasonsHeld();
    // Nothing held anywhere is not a "which season?" with no seasons to offer
    // - that read "Send e.g. ... season undefined" - it is not in the library.
    if (!seasons.length) return { error: 'not-found', series, episodes: [], seasons: [] };
    return { error: 'need-season', series, episodes: [], seasons };
  }

  // "Show episode 5" with no season - only safe if the show has exactly one,
  // counted across its entries: a split show's other seasons are in the twin.
  let season = parsed.season;
  if (season == null) {
    const seasons = await seasonsHeld();
    if (!seasons.length) return { error: 'not-found', series, episodes: [], seasons: [] };
    if (seasons.length === 1) season = seasons[0];
    else return { error: 'need-season', series, episodes: [], seasons };
  }

  const pick = (list) => list.filter((e) => e.season === season && wanted(e));
  let all = await listEpisodes(series.id, { ...opts, season });

  // Not in the entry that was picked: try the same show's other entries.
  if (!pick(all).length) {
    try {
      for (const twin of await twinsOf(series)) {
        const theirs = await listEpisodes(twin.id, { ...opts, season });
        if (pick(theirs).length) {
          try {
            const what = parsed.episode != null ? `S${season}E${parsed.episode}`
              : range ? `S${season}E${range.from}-E${range.to}`
                : named ? listCode(season, named) : `season ${season}`;
            opts.onDiagnostic?.(`"${series.name}" (${series.id}) has no ${what}; `
              + `its same-named entry ${twin.id} does, so that one is used`);
          } catch { /* diagnostics never break a lookup */ }
          series = { ...twin, rating: twin.rating ?? series.rating };
          all = theirs;
          break;
        }
      }
    } catch { /* the twins are a second chance, never a reason to fail */ }
  }
  // Nor in any entry of that show: another show of the same title may have
  // it - the 2005 cartoon's season 3, asked for as plain "avatar the last
  // airbender" (findNamesakes). Only for a request that named no year, or
  // one the other show's year fits, and only for a season past the last one
  // the picked show has: a season missing from the middle of a show's run
  // is a gap in THAT show - the US Shameless with seasons 1, 2 and 4 is
  // never sent the UK show's season 3 - while one past its end, as season 3
  // is past the live action's two, is most likely the other show's.
  const pastItsEnd = async () => {
    const have = await seasonsHeld();
    return have.length > 0 && season > Math.max(...have);
  };
  if (!pick(all).length && !opts.knownSeries && await pastItsEnd()) {
    try {
      for (const other of await findNamesakes(series, withYear)) {
        const theirs = await listEpisodes(other.id, { ...opts, season });
        if (pick(theirs).length) {
          try {
            opts.onDiagnostic?.(`"${series.name}" (${series.year ?? '?'}) has no season ${season} like that; `
              + `"${other.name}" (${other.year ?? '?'}), another show of the same title, does, so that one is used`);
          } catch { /* diagnostics never break a lookup */ }
          series = other;
          twins = null;
          all = theirs;
          break;
        }
      }
    } catch { /* a second chance, never a reason to fail */ }
  }
  let episodes = all.filter((e) => e.season === season);

  // The show WAS found - only the asked-for season or episode is missing. That
  // is a different answer from "we do not have this show", and telling the two
  // apart needs the list of what does exist. Fetched only on the miss path, so
  // the common case still costs one request.
  // "What we have" covers the show's other entries too, so a season held
  // only in one of them is not left off the list.
  const haveSeasons = seasonsHeld;

  const inSeason = () => all.filter((e) => e.season === season).flatMap((e) => (e.episode == null ? [] : Array.from({ length: last(e) - e.episode + 1 }, (_, i) => e.episode + i)));
  // The episodes of a list the season does not have, when it has some of
  // them: each was named, so each is answered (the TV plugin's
  // _answerMissing), where a range is the span the server holds.
  let missing = [];
  if (someEpisodes) {
    episodes = episodes.filter(wanted);
    if (!episodes.length) {
      return {
        error: 'no-such-episode', series, episodes: [], season,
        seasons: await haveSeasons(),
        episodesInSeason: inSeason(),
      };
    }
    if (named) missing = named.filter((n) => !episodes.some((e) => holds(e, n)));
  }
  if (!episodes.length) {
    return { error: 'empty-season', series, episodes: [], season, seasons: await haveSeasons() };
  }

  episodes = oneCopyEach(episodes);

  // Fill in the series name for filenames when Jellyfin omits it per-episode.
  episodes = episodes.map((e) => ({ ...e, series: e.series ?? series.name }));
  episodes.sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
  if (missing.length) return { error: null, series, season, episodes, missing, episodesInSeason: [...new Set(inSeason())].sort((a, b) => a - b) };
  return { error: null, series, season, episodes };
}

/** Direct download URL for one episode (same shape the movie path uses). */
export function episodeDownloadUrl(episodeId, { base, token } = {}) {
  const url = new URL(`${base}/Items/${episodeId}/Download`);
  url.searchParams.set('api_key', token);
  return { url: url.toString(), headers: { 'X-Emby-Token': token } };
}

/**
 * A title typed with its spaces run together: "TheResident season3 episode14"
 * was answered "no series matching" although "The Resident" (2018) is on the
 * server (hourly check 2026-10-13) - the search term and the fuzzy matcher
 * both see one word. Splits at a lower-to-upper change ("TheResident") and
 * after a leading "The" ("theresident"); null when the title has no such form.
 */
export function spacedVariant(show) {
  const s = String(show ?? '').trim();
  if (!s || /\s/.test(s)) return null;
  let v = s.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2');
  if (v === s && /^the[a-z]{4,}$/i.test(s)) v = `${s.slice(0, 3)} ${s.slice(3)}`;
  return v === s ? null : v;
}

/**
 * A doubled digit typed for a doubled number word: "Brooklyn 99 season 5" was
 * answered "couldn't find that title" although "Brooklyn Nine-Nine" (2013) is
 * on the server (hourly check 20261013T230001Z) - no search or fuzzy score
 * links "99" to "Nine-Nine". Only a standalone 22..99 of one repeated digit
 * is rewritten; null when the title has none.
 */
export function numberWordVariant(show) {
  const words = ['', '', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const s = String(show ?? '');
  const v = s.replace(/(?<![\w])([2-9])\1(?![\w])/g, (_, d) => `${words[d]}-${words[d]}`);
  return v === s ? null : v;
}

/**
 * A studio or service typed before the title: "marvel Moon Knight season 1"
 * was answered "no series matching" although "Moon Knight" (2022) is on the
 * server (hourly check 20261017T200001Z) - the extra word defeats the search
 * and the fuzzy score. Only tried after the title as typed finds nothing, so
 * a show that really starts with the word ("Marvel's Daredevil") still wins.
 * A colon or dash after the lead ("marvel: loki season 2", hourly check
 * 20261019T170002Z) counts as the gap; it was answered with the wrong show.
 * Null when the title has no such lead or nothing else after it.
 */
export function studioVariant(show) {
  const s = String(show ?? '').trim();
  const v = s.replace(/^(?:marvel'?s?|netflix'?s?|disney\+?|hbo|amazon|apple\s*tv\+?|dc'?s?)(?:\s*[:\-\u2013]\s*|\s+)(?=\S)/i, '');
  return v === s || !v ? null : v;
}

/**
 * A small number typed as a word where the library uses the digit: "two broke
 * girls season 5 episode 8-22" was answered "no series matching" although
 * "2 Broke Girls" (2011) is on the server (hourly check 20261018T050001Z) -
 * the reverse of numberWordVariant. Only a leading word two..nine followed by
 * more title is rewritten; null when the title has none.
 */
export function digitVariant(show) {
  const digits = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
  const s = String(show ?? '').trim();
  const v = s.replace(/^(two|three|four|five|six|seven|eight|nine)\s+(?=\S)/i, (_, w) => `${digits[w.toLowerCase()]} `);
  return v === s ? null : v;
}

/**
 * A language or edition note typed in brackets after the title: "friren:
 * beyond journey's end (In English) s1" was answered "no series matching"
 * (hourly check 20261018T050001Z) - the bracket defeats the search and drags
 * the fuzzy score under its bar. Null when the title has no trailing bracket
 * or nothing else.
 */
export function bracketVariant(show) {
  const s = String(show ?? '').trim();
  const v = s.replace(/\s*[([][^)\]]*[)\]]\s*$/, '').trim();
  return v === s || !v ? null : v;
}

/**
 * An apostrophe in the wrong place: "Friend's S01E11-E20" was answered "no
 * series matching" although "Friends" (1994) is on the server (hourly check
 * 20261020T210001Z) - the stray apostrophe defeats the search and the fuzzy
 * score. Tried last, after the title as typed, so "Grey's Anatomy" still wins
 * as written. Null when the title has no apostrophe or nothing else.
 */
export function apostropheVariant(show) {
  const s = String(show ?? '').trim();
  const v = s.replace(/['\u2018\u2019\u02BC]/g, '').replace(/\s+/g, ' ').trim();
  return v === s || !v ? null : v;
}

/**
 * A plural typed before "of": "legends of kora S01" was answered "no series
 * matching" although "The Legend of Korra" (2012) is on the server (hourly
 * check 20261021T040001Z) - the extra "s" plus the missing "r" put the score
 * (0.87) under the 0.9 bar of the library listing, and the search finds
 * nothing for either word. "legend of kora" scores 0.93. Tried after the title
 * as typed, so a show really called "Heroes of ..." still wins; null when no
 * word before "of" ends in s.
 */
export function pluralVariant(show) {
  const s = String(show ?? '').trim();
  const v = s.replace(/\b(\p{L}{3,})s(\s+of\s)/iu, '$1$2');
  return v === s ? null : v;
}

/**
 * A lone "n" typed for the library's "'N": "wild n out season 7" was answered
 * "no series matching" although "Nick Cannon Presents: Wild 'N Out" (2005) is
 * on the server (hourly check 20261022T230001Z) - Jellyfin's search finds
 * nothing for "wild n out" but finds the show for "wild 'n out". Also covers
 * "rock n roll" -> "rock 'n' roll". Null when the title has no standalone n.
 */
export function elisionVariant(show) {
  const s = String(show ?? '').trim();
  const v = s.replace(/(?<=\S)\s+n\s+(?=\S)/i, " 'n ");
  return v === s ? null : v;
}

/**
 * A compound typed as one word where the library has two: "kungfu panda" was
 * answered "no series matching" although "Kung Fu Panda: The Dragon Knight"
 * (2022) and "Kung Fu Panda: Legends of Awesomeness" (2011) are on the server
 * (hourly check 20261024T220001Z) - the search and the fuzzy score see "kungfu"
 * as a word that is in no title. Null when the title has no such compound.
 */
export function compoundVariant(show) {
  const s = String(show ?? '').trim();
  const v = s.replace(/\bkungfu\b/gi, (m) => `${m.slice(0, 4)} ${m.slice(4)}`);
  return v === s ? null : v;
}

/**
 * "live action" typed after a title that the library does not carry that way:
 * "one piece live action season one" was answered "no series matching" although
 * "ONE PIECE" (2023) is on the server next to the 1999 anime (hourly check
 * 20261025T040001Z). The words are a hint about which of two same-named shows
 * is meant, not part of the name. Null when the title does not end that way.
 */
export function liveActionVariant(show) {
  const s = String(show ?? '').trim();
  const v = s.replace(/\s+(?:the\s+)?live[\s-]?action(?:\s+(?:series|version|show))?$/i, '').trim();
  return v && v !== s ? v : null;
}

/**
 * A dangling "season" left in the title: "fallout season S2E1-8" was answered
 * "no series matching \"fallout season\"" although "Fallout" (2024) is on the
 * server (hourly check 20261025T110001Z) - the season was already read from
 * S2, and the word before it stayed on the name. Null when the title does not
 * end in "season"/"series" (a show really named that is tried as typed first).
 */
export function trailingSeasonVariant(show) {
  const s = String(show ?? '').trim();
  const v = s.replace(/\s+(?:season|seasons|series)$/i, '').trim();
  return v && v !== s ? v : null;
}

/**
 * Filler around the title: "all Ted episodes" was answered "no series matching"
 * although "ted" (2024) is on the server (hourly check 20261025T130001Z) - the
 * words that say how much is wanted stayed on the name. Drops a leading "all
 * (of)" / "every" and a trailing "(all) episodes/seasons/eps". Null when
 * neither is there (a show really named so is tried as typed first).
 */
export function fillerVariant(show) {
  const s = String(show ?? '').trim();
  const v = s
    .replace(/^(?:all(?:\s+of)?|every|all\s+the)\s+(?=\S)/i, '')
    .replace(/\s+(?:all\s+)?(?:episodes?|eps?|seasons?)$/i, '')
    .trim();
  return v && v !== s ? v : null;
}

/** Looks the show up as typed, then, only if that finds nothing, in its other spellings. */
export async function findSeries(show, opts = {}) {
  const found = await findSeriesOnce(show, opts);
  if (found) return found;
  const live = liveActionVariant(show);
  if (live) {
    const base = await findSeriesOnce(live, opts);
    if (base) {
      // Live action means the newer of the same-titled shows (the remake).
      const others = await findNamesakes(base, opts).catch(() => []);
      const newest = [base, ...others].filter((x) => x.year).sort((a, b) => b.year - a.year)[0];
      return newest ?? base;
    }
  }
  for (const alt of [spacedVariant(show), numberWordVariant(show), studioVariant(show), digitVariant(show), bracketVariant(show), apostropheVariant(show), pluralVariant(show), elisionVariant(show), compoundVariant(show), trailingSeasonVariant(show), fillerVariant(show)]) {
    if (!alt) continue;
    const again = await findSeriesOnce(alt, opts);
    if (again) return again;
  }
  return null;
}
