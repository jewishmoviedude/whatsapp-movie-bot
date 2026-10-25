/**
 * A catalogue of everything on the server that this bot is allowed to send.
 *
 * The bot only ever answers one title at a time, so nobody - including the
 * admins - has a view of what the library actually holds within the rating
 * policy. This walks the whole Jellyfin library once and writes the clean
 * titles out, so the list can be read, searched and kept in the repo.
 *
 * Deliberately contains TITLES ONLY: no paths, no item ids, no server URL and
 * no token. The file is committed, so it must carry nothing that would be a
 * problem outside this machine.
 */
import log from '../util/logger.js';

const logger = log.scope('catalogue');

const PAGE = 200;          // Jellyfin is happy with this; 10k titles is 50 calls
const PAGE_DELAY_MS = 150; // one request at a time, with a breath between them
// Re-read this many items at each window seam. Jellyfin orders by a collation
// that ignores spaces ("Junglee" sorts before "Jungle Fever") while the cursor
// filter may compare differently, so a small overlap - deduplicated by item id
// - keeps an item near the seam from falling between two windows.
const SEAM_OVERLAP = 25;
// A stop, in case a server paginates forever or ignores the cursor. Relative to
// the size the server reports and the page size in use, so a large library is
// never cut short by it.
const MAX_REQUESTS = (total, pageSize) => 50 + 3 * Math.ceil((total ?? 40_000) / pageSize);
// A walk is ~110 sequential requests; one dropped connection should cost a
// retry, not the whole walk.
const RETRY_DELAYS_MS = [2000, 5000];

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is this rating one the bot is allowed to send? */
export function isClean(rating, blocked = [], isUnrated = (r) => !r) {
  const r = String(rating ?? '').trim().toUpperCase();
  // No rating at all is NOT treated as clean. An unrated file is exactly the
  // case where nobody has checked, and this list is used to decide what may
  // go out - so it has to be the cautious way round.
  if (!r || isUnrated(rating)) return false;
  return !blocked.some((b) => String(b).trim().toUpperCase() === r);
}

/**
 * A readable title from a library name that is really a folder name.
 *
 * Items Jellyfin never matched to metadata keep their folder's name, so the
 * 2026-09-09 list carried "Good Grief (2024) [tmdbid-1504265]" and "Fantastic
 * Beasts The Crimes of Grindelwald (2018)". The trailing id tag goes, and a
 * trailing "(YYYY)" becomes the year. That year wins over ProductionYear: the
 * folder was named by a person, while Jellyfin guessed "Cherry 2000 (1987)"
 * was from 2000 by reading the number in the title. Dotted names such as
 * "D.A.R.Y.L." and "4.3.2.1" are real titles and are left alone.
 */
export function cleanTitle(name, productionYear = null) {
  const original = String(name ?? '').trim();
  let title = original
    .replace(/\s*[[{](?:tmdb|imdb|tvdb)(?:id)?[-=][^\]}]*[\]}]\s*$/i, '')
    .trim();
  let year = productionYear ?? null;
  const m = title.match(/^(.*\S)\s*\((\d{4})\)$/);
  if (m && +m[2] >= 1870 && +m[2] <= 2100) {
    title = m[1];
    year = +m[2];
  }
  return { title: title || original || '(untitled)', year, cleaned: title !== original };
}

/**
 * Walk the whole Jellyfin movie library.
 *
 * Jellyfin will not serve past its 10,000th result: on this server a request at
 * StartIndex 9990 returned 10 items, and one at 10000 returned none, while
 * TotalRecordCount said 20,796. The old walk took that empty page for the end
 * and wrote a list that stopped at "The Jurassic Games" - every film from K to
 * Z missing, including Venom, Knives Out and Ocean's Eleven, delivered the same
 * week - and nothing said so. So when a window runs dry before the server's
 * count, the walk starts a new window from the sort name it reached
 * (NameStartsWithOrGreater), with a small overlap, and at the end it compares
 * the distinct films read against the count. A walk that falls short says so in
 * `complete: false`, and the caller must not publish it.
 *
 * @param fetchPage (startIndex, limit, { nameStartsWithOrGreater }) => { items, total }
 *   Items should carry Id and SortName; without an Id every row counts as its own film.
 */
export async function scanLibrary(fetchPage, {
  blocked = [], onProgress = null, pageSize = PAGE, delayMs = PAGE_DELAY_MS, sleep = sleepMs,
  retryDelaysMs = RETRY_DELAYS_MS,
  // What counts as "no classification". The caller passes the bot's own rule
  // (theatrical.js isUnrated: NR, Not Rated, Unrated...). The list said
  // "unrated titles are not listed" while carrying 1,490 of them, because only
  // an empty rating counted.
  isUnrated = (r) => !String(r ?? '').trim(),
} = {}) {
  const seen = new Map();          // one entry per film, however often it was read
  let cleanSoFar = 0;              // for progress only; the list itself is built once, below
  let total = null;                // the server's own count, from the first request
  let cursor = null;               // NameStartsWithOrGreater for the current window
  let windows = 0;
  let requests = 0;
  let stopped = null;              // why the walk ended, when it was not the natural end

  const page = async (start, limit, opts = {}) => {
    for (let attempt = 0; ; attempt += 1) {
      if (requests > 0) await sleep(delayMs);
      requests += 1;
      try {
        return await fetchPage(start, limit, opts);
      } catch (err) {
        if (attempt >= retryDelaysMs.length) throw err;
        logger.warn(`catalogue: a page failed (${err.message}) - retrying in ${retryDelaysMs[attempt] / 1000}s`);
        await sleep(retryDelaysMs[attempt]);
      }
    }
  };

  try {
    walk: for (;;) {
      windows += 1;
      let start = 0;
      let windowTotal = null;
      let fresh = 0;
      const tail = [];             // sort names of the last few items of this window

      for (;;) {
        if (requests >= MAX_REQUESTS(total, pageSize)) { stopped = 'request limit reached'; break walk; }
        const { items, total: t } = await page(start, pageSize,
          cursor === null ? {} : { nameStartsWithOrGreater: cursor });
        if (start === 0) windowTotal = t ?? null;
        if (total === null && windows === 1) total = t ?? null;
        if (!items?.length) break;

        for (const it of items) {
          // Jellyfin always sends an Id. Without one, name and year stand in:
          // a key that changed on every read would count the seam overlap
          // twice and could cover films a window really missed.
          const key = it.Id ?? `noid:${it.SortName ?? ''}|${it.Name ?? ''}|${it.ProductionYear ?? ''}`;
          if (!seen.has(key)) {
            seen.set(key, it);
            fresh += 1;
            if (isClean(it.OfficialRating, blocked, isUnrated)) cleanSoFar += 1;
          }
          tail.push(it.SortName ?? String(it.Name ?? '').toLowerCase());
          if (tail.length > SEAM_OVERLAP + 1) tail.shift();
        }
        start += items.length;
        onProgress?.({ scanned: seen.size, total, clean: cleanSoFar, windows });
        if (items.length < pageSize) break;                        // short page: this window is done
        if (windowTotal !== null && start >= windowTotal) break;   // read all it said it had
      }

      // The window ran dry. Either the library ended, or the server stopped
      // serving this window before its own count. Only the second needs another.
      if (windowTotal === null || start >= windowTotal) break;
      if (windows > 1 && fresh === 0) { stopped = 'a new window brought no new films'; break; }
      // SEAM_OVERLAP items back from the end; if that is where this window began
      // (a run of identical sort names longer than the overlap), step to the end.
      const next = tail[0] !== cursor ? tail[0] : tail.at(-1);
      if (next == null || next === cursor) { stopped = 'the walk could not move past a window'; break; }
      cursor = next;
    }

    // Ask for the count again. A library that changed during the walk can make
    // the numbers agree by accident (an added film covering a missed one) or
    // disagree for an innocent reason (a film deleted before the walk reached it).
    if (total !== null && !stopped) {
      const { total: after } = await page(0, 1);
      if ((after ?? null) !== total) {
        stopped = `the library changed during the walk (${total} -> ${after ?? '?'} films); run it again`;
      } else if (seen.size > total) {
        stopped = `the server served ${seen.size} films but reports ${total}`;
      } else if (seen.size < total) {
        // Every window ended normally yet films are missing: the server's name
        // filter must disagree with its own sort order somewhere, so those
        // films were never in any window.
        stopped = `${total - seen.size} film(s) were never served by any window`;
      }
    }
  } catch (err) {
    // Tell the caller how far it got, for the record of a failed rebuild.
    err.progress = { scanned: seen.size, total, requests };
    throw err;
  }

  const clean = [];
  const skipped = { blocked: 0, unrated: 0 };
  const renamed = [];
  for (const it of seen.values()) {
    const rating = it.OfficialRating ?? null;
    if (!String(rating ?? '').trim() || isUnrated(rating)) { skipped.unrated += 1; continue; }
    if (!isClean(rating, blocked, isUnrated)) { skipped.blocked += 1; continue; }
    const { title, year, cleaned } = cleanTitle(it.Name, it.ProductionYear ?? null);
    if (cleaned) renamed.push(it.Name);
    clean.push({ title, year, rated: String(rating).trim() });
  }
  clean.sort((a, b) => a.title.localeCompare(b.title) || (a.year ?? 0) - (b.year ?? 0));

  const scanned = seen.size;
  // true only when the server's count was known and matched; null when it gave
  // none (completeness cannot be checked); false on any evidence of a gap.
  const complete = stopped ? false : total === null ? null : scanned === total;
  const summary = `catalogue: ${clean.length} clean of ${scanned} read`
    + `${total !== null ? ` of ${total} on the server` : ''} in ${windows} window(s), ${requests} request(s) `
    + `(${skipped.blocked} blocked by rating, ${skipped.unrated} unrated`
    + `${renamed.length ? `, ${renamed.length} folder-style name(s) tidied` : ''})`;
  if (complete === false) logger.warn(`${summary} - INCOMPLETE: ${stopped}`);
  else if (complete === null) logger.warn(`${summary} - the server did not report its size, so coverage is unknown`);
  else logger.info(summary);
  return {
    clean, scanned, total, complete, windows, requests,
    stopped, skipped, renamed: renamed.length, at: Date.now(),
  };
}

/** The committed, human-readable version. */
export function formatCatalogue(result, { blocked = [], blockUnrated = null } = {}) {
  const when = new Date(result.at).toISOString().slice(0, 16).replace('T', ' ');
  const byLetter = new Map();
  for (const m of result.clean) {
    const k = /^[a-z]/i.test(m.title) ? m.title[0].toUpperCase() : '#';
    if (!byLetter.has(k)) byLetter.set(k, []);
    byLetter.get(k).push(m);
  }

  const out = [
    '# Clean titles on the server',
    '',
    `${result.clean.length} of ${result.scanned} films carry a rating this bot may send.`,
    // Printed so a short walk is visible in the file itself: the 2026-09-09
    // list said "of 10000" and nothing showed the server held 20,796.
    ...(result.total != null ? [`The walk read ${result.scanned} of the ${result.total} films the server reports.`] : []),
    '',
    `Excluded: ${blocked.join(', ') || '(nothing)'} — ${result.skipped.blocked} title(s).`,
    `Unrated and therefore not listed: ${result.skipped.unrated} title(s) - no rating, or NR / Not`,
    'Rated / Unrated. An unrated file is one nobody has checked, so it is left out rather',
    'than assumed safe.',
    // The list is the cautious view; the bot's own gate is a setting. Say so,
    // rather than let this list read as everything the bot will send.
    ...(blockUnrated === false ? [
      'Note: while "block unrated" is off in Settings, the bot itself still sends unrated films;',
      'they are just not listed here.',
    ] : []),
    '',
    `Generated ${when} UTC. Titles only — no paths, ids, server address or token.`,
    '',
  ];
  for (const k of [...byLetter.keys()].sort()) {
    out.push(`## ${k}`, '');
    for (const m of byLetter.get(k)) {
      out.push(`- ${m.title}${m.year ? ` (${m.year})` : ''} — ${m.rated}`);
    }
    out.push('');
  }
  return out.join('\n');
}
