/**
 * The bypass list: titles an admin has decided may be sent despite their
 * rating - films and TV alike, on one list. The panel calls it the Rated-R
 * override; the operator calls it the "rated R bypass".
 *
 * The rating gate answers the wrong question, and everybody here already knows
 * it. An MPAA letter conflates violence, language and sex into one grade, so a
 * war film and a sex scene both come out "R" - and the groups only actually
 * care about one of those. A TV-MA on an episode is the same letter again:
 * Fullmetal Alchemist: Brotherhood is TV-14, and S01E14, S01E19 and S01E26 are
 * each TV-MA, for violence. Blocking the whole letter throws away a great deal
 * of perfectly sendable film and TV.
 *
 * WHAT AN ENTRY DOES
 *
 * It sends what it covers, with no AI check - the operator's decision of
 * 2026-09-29. Until then an entry only put a title in front of the AI
 * content check, which had to confirm no nudity; that afternoon Gemini
 * answered 503 for hours, Groq called The Last Samurai nude, and the film
 * the operator had listed by hand was held back: "Why ask Gemini if I
 * already added it to rated R bypass manually in panel?" Asked what adding a
 * title should do, the operator chose: "Send it, no AI check". So a title an
 * entry covers skips the rating gate and the nudity check on every path - a
 * request, a panel Re-run, Queue link, a TV season or episode, the Test tab
 * - and History and the log say "sent: on the bypass list (...)" (bypassNote).
 *
 * WHAT AN ENTRY COVERS
 *
 * A title. It covers the film or show whose name, with case, spaces and
 * punctuation ignored, is that title - that exact title and no other
 * (nameKey, titleCovers): "KILL-ME three times" covers "Kill Me Three
 * Times", "full metal alchemist" covers "Fullmetal Alchemist", and "Heat"
 * covers "Heat" and not "Heat and Dust". A library name that carries its
 * year in brackets, "Fruits Basket (2019)", is that title from that year
 * (coversName). There is no Film / TV choice to make. A year on the entry
 * narrows it to that year - and, since "Blade Runner 2049" and "Space: 1999"
 * end in a number that looks like one, it also covers the name with that
 * number, from any year (coversName). "season 2" or "S01E14" on the end
 * narrows it to that season or episode of a show (and then it covers no film,
 * since a film has neither). A name in any script is matched (titleKey).
 *
 * Or a Jellyfin link, pasted from the web UI. That is exact: the one film,
 * series, season or episode with that id - a series link also covering the
 * same show's other library entry when the show is split over two folders
 * (`twinIds`). A link keeps what it was found to be (`kind`), for the list;
 * it matches on the id alone either way, and ids are unique.
 *
 * WHY EXACT
 *
 * Until 2026-09-29 an entry also covered every name that started with it,
 * word for word, so "Heat" covered "Heat and Dust" and every TV-MA episode of
 * a show of that name. Matching was that wide because the owner's own entry,
 * "full metal alchemist", was meant to cover "Fullmetal Alchemist:
 * Brotherhood", and the strict match before it covered nothing. While the AI
 * check stood behind every entry, a loose match only widened what was
 * checked; once an entry meant "Send it, no AI check" it widened what was
 * sent. Asked whether "Heat" should also send "Heat and Dust", the operator
 * chose "Exact title only" (2026-09-29). So "full metal alchemist" now
 * covers the 2003 "Fullmetal Alchemist" and not "Fullmetal Alchemist:
 * Brotherhood"; an entry typed with the show's full name covers it, as the
 * one on the live list, "Fullmetal Alchemist: Brotherhood season 1", does.
 * What stays loose is only what never changes which title is meant: case,
 * spaces, punctuation and script. The panel shows what each entry matches in
 * the library right now, beside the entry and when it is added, so an admin
 * sees exactly what it sends.
 *
 * WHERE IT IS KEPT
 *
 * In the movie plugin's namespace (OVERRIDE_NAMESPACE), under
 * 'rating-overrides', where every build has read it; the TV plugin reads it
 * from there through ctx.overrideStore. One exception: an entry narrowed to a
 * season or an episode is kept under TV_KEY. A build from before TV reads
 * everything under 'rating-overrides' as a film entry with no idea of a
 * season, so "Fargo season 2" kept there would clear the film Fargo after a
 * rollback - and every box follows main, where a bad commit is taken back
 * out. The same goes for a name such a build reads differently (apart()):
 * it keeps a-z and 0-9 only, so "שטיסל" is nothing to it, and nothing equals
 * every other name with no a-z in it. A plain title in a-z or a link kept
 * there means the same to an old build, except that one from before "Exact
 * title only" (2026-09-29) also covers every name the title is the start
 * of - as those builds did when the entries on the live list were added.
 */
const MAX = 500;

/** Where entries live - the key every build has read. */
const FILM_KEY = 'rating-overrides';
/** Where an entry builds from before TV would misread lives, out of their sight (apart()). */
export const TV_KEY = 'rating-overrides-tv';

/**
 * The state namespace the list lives in. Films put it there first; the TV
 * plugin reads it from the same place (ctx.overrideStore) so there is one list,
 * not two that can disagree.
 */
export const OVERRIDE_NAMESPACE = 'movie-requests';

/** Narrowed to a season or an episode: TV's alone. */
const scoped = (e) => e?.season != null || e?.episode != null;

/**
 * Kept under TV_KEY, out of sight of builds from before TV (see the header):
 * narrowed to a season or an episode, or a name those builds would read as
 * something else - "שטיסל" as nothing at all, which in their match equals
 * every other name with no a-z in it.
 */
const apart = (e) => scoped(e) || (!!e?.title && legacyTitleKey(e.title) !== titleKey(e.title));

/**
 * An entry as it is used, whatever shape it was stored in.
 *
 *  - `addedBy` was once stored as the whole session user ({ username, role }),
 *    which the panel then printed as "added by [object Object]". Read as the
 *    name, and written back so the next time the list is saved.
 *  - A title entry has no kind; one saved by an earlier build of this list
 *    as 'film' or 'tv' is a title entry like any other.
 *  - A link keeps its kind when it has one ('film' or 'tv').
 */
function normalise(e) {
  if (!e || typeof e !== 'object' || !e.key) return null;
  const out = { ...e };
  if (out.addedBy && typeof out.addedBy === 'object') out.addedBy = out.addedBy.username ?? null;
  if (!out.jellyfinId) delete out.kind;
  else if (out.kind !== 'film' && out.kind !== 'tv') delete out.kind;
  return out;
}

/**
 * The list's identity for a title: case, accents, punctuation and spacing
 * folded, words kept. Used for keys, so an entry added here has the key a
 * build from before this one would give it - "t:heat|1995" - and either can
 * remove it. Deliberately NOT normalizeTitle(), which folds Roman numerals
 * ("X" would be "10") and drops leading articles ("The Thing" would be
 * "Thing").
 *
 * Letters and digits of every script are kept: "שטיסל", "Шерлок" and
 * "進撃の巨人" are names like any other. Builds before this one kept a-z and
 * 0-9 only (legacyTitleKey), so such a name came out empty, the panel
 * refused it, and nothing in the library written that way could be covered.
 * For a-z, accented or not, the two are the same; an entry they differ on is
 * kept where those builds do not read it (see save()).
 */
export function titleKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** titleKey as builds before this one computed it: a-z and 0-9 only. */
function legacyTitleKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * What a name is matched on: titleKey() with the spaces taken out as well, so
 * "full metal alchemist" and "Fullmetal Alchemist" are the same letters.
 */
export function nameKey(s) {
  return titleKey(s).replace(/ /g, '');
}

/**
 * Does an entry titled `title` cover a film or show called `name`? Only when
 * the two are the same letters: "Exact title only", the operator's answer
 * (2026-09-29) when asked whether "Heat" should also send "Heat and Dust".
 *
 * Spaces are ignored (nameKey), so "full metal alchemist" is "Fullmetal
 * Alchemist" and "KILL-ME three times" is "Kill Me Three Times" - typing a
 * name with a space more or less does not make it another film. Until that
 * day the entry also covered every name it was the start of, up to the end of
 * a word, which was harmless while an entry only put a title to the AI check
 * and sent titles nobody had listed once an entry meant "Send it, no AI
 * check" (see the header).
 */
export function titleCovers(title, name) {
  const k = nameKey(title);
  return !!k && k === nameKey(name);
}

/**
 * A library name with its year in brackets on the end, "Fruits Basket
 * (2019)", read as the title and that year - or null. A show is named that
 * way when two share a title (the live library has "Fruits Basket
 * (2019)"), and while an entry covered what a name starts with, "Fruits
 * Basket" covered it; an exact title must still, since the year is not part
 * of the title the admin typed. Brackets only: a bare number on the end is
 * part of the name ("Blade Runner 2049", "1883").
 */
function bracketYear(name) {
  const m = String(name ?? '').match(/^(.*\S)\s*\(((?:19|20)\d{2})\)\s*$/);
  return m ? { name: m[1], year: Number(m[2]) } : null;
}

/**
 * Are two names the same title, as the list reads names: exactly, with case,
 * spaces and punctuation ignored, and a year in brackets on either left off
 * ("Fruits Basket (2019)" is "Fruits Basket"). film-gate.js asks it of the
 * film asked for and the library's file: "Saw" and "Saw II" are not the same
 * title, however alike the fuzzy matcher finds them, so an entry for one is
 * not taken to cover the other.
 */
export function sameTitle(a, b) {
  const bare = (n) => bracketYear(n)?.name ?? n;
  return titleCovers(bare(a), bare(b));
}

/**
 * Does title entry `e` cover something called one of `names`, of one of
 * `years` (none known: any year)? Only the name and the year; the caller
 * deals with seasons and episodes. Names are compared exactly (titleCovers).
 *
 * A year typed on the end of a name is read both ways, because the entry
 * cannot tell which it is: "Dune 2021" is Dune from 2021, but "Blade Runner
 * 2049", "Space: 1999" and "Class of 1984" are whole names, and parseEntry
 * saved each as a shorter name and a year ("Blade Runner", 2049) that then
 * covered nothing - the film Blade Runner 2049 is from 2017. So an entry
 * with a year covers its name from that year, and also its name and that
 * number, from any year. The second reading of "Dune 2021" is a name nothing
 * has, and the panel shows what an entry matches (see the header).
 *
 * A name with its year in brackets (bracketYear) is also read as the title
 * from that year: "Fruits Basket" and "Fruits Basket 2019" cover "Fruits
 * Basket (2019)", and "Fruits Basket 2001" does not.
 */
function coversName(e, names, years) {
  if (!e?.title) return false;
  const yearAgrees = (ys) => e.year == null || !ys.length || ys.includes(Number(e.year));
  if (names.some((n) => titleCovers(e.title, n)) && yearAgrees(years)) return true;
  if (names.some((n) => {
    const b = bracketYear(n);
    return b && titleCovers(e.title, b.name) && yearAgrees([b.year]);
  })) return true;
  return e.year != null && names.some((n) => titleCovers(`${e.title} ${e.year}`, n));
}

/** Pull the item id out of a Jellyfin URL, or return null. */
export function jellyfinIdFrom(text) {
  const s = String(text ?? '').trim();
  // .../Items/<32-hex>/Download, .../web/index.html#!/details?id=<32-hex>, or
  // the bare id on its own.
  const m = s.match(/\b([0-9a-f]{32})\b/i);
  return m ? m[1].toLowerCase() : null;
}

/** Split "Some Film (2017)" or "Some Film 2017" into title and year. */
export function parseTitleYear(text) {
  const s = String(text ?? '').trim();
  const m = s.match(/^(.*\S)\s*[([]?\b((?:19|20)\d{2})\b[)\]]?$/);
  if (m) return { title: m[1].replace(/[([]$/, '').trim(), year: Number(m[2]) };
  return { title: s, year: null };
}

/**
 * The season and episode on the end of an entry, strictly: "S01E14", "1x14",
 * "season 1 episode 14", "season 1" or "S01", and nothing looser. The request
 * parser (tv-requests/parse.js) finds a marker anywhere in a sloppy sentence;
 * an entry is typed by an admin into a box, and a marker read in the wrong
 * place would move what the entry covers. A bare trailing number is part of
 * the name ("Stranger Things 4", "1883").
 */
const TV_MARKERS = [
  { re: /[\s\-–—:,.]*\bs\s*(\d{1,2})\s*[._-]?\s*e\s*(\d{1,3})$/i, episode: true },
  { re: /[\s\-–—:,.]*\b(\d{1,2})x(\d{1,3})$/i, episode: true },
  { re: /[\s\-–—:,.]*\bseason\s*(\d{1,2})\s*,?\s*(?:episode|ep)\s*(\d{1,3})$/i, episode: true },
  { re: /[\s\-–—:,.]*\bseason\s*(\d{1,2})$/i, episode: false },
  { re: /[\s\-–—:,.]*\bs(\d{1,2})$/i, episode: false },
];

/**
 * Split "Show (2009) S01E14" into the name, its year, and the season/episode.
 * "Show episode 14" names no season, and guessing one would narrow the entry
 * to an episode nobody chose, so it is read as a name like any other: it
 * covers a title of exactly those words, and the panel shows that is nothing.
 */
export function parseTvTitle(text) {
  let rest = String(text ?? '').trim();
  let season = null;
  let episode = null;
  for (const m of TV_MARKERS) {
    const hit = rest.match(m.re);
    if (!hit) continue;
    season = Number(hit[1]);
    episode = m.episode ? Number(hit[2]) : null;
    rest = rest.slice(0, hit.index);
    break;
  }
  rest = rest.replace(/[\s\-–—:,.]+$/, '').trim();
  const { title, year } = parseTitleYear(rest);
  return { title: title.trim(), year, season, episode };
}

/** What an entry's scope is, in words: "every season", "season 1", "S01E14". */
export function tvScope(e) {
  if (e?.episode != null) return `S${pad2(e.season)}E${pad2(e.episode)}`;
  if (e?.season != null) return `season ${e.season}`;
  return 'whole series';
}

const pad2 = (n) => String(n ?? 0).padStart(2, '0');

/**
 * Turn whatever the admin typed into an entry.
 *
 * A title is never refused for what it matches, or does not: the panel shows
 * that, beside the entry. Only input with no letter or digit in any script is
 * refused - there is nothing to match on.
 *
 * `resolved` is what the panel found out about a pasted link in Jellyfin
 * (describeLink in tv-requests/override-check.js):
 *   kind     'film' or 'tv', for the list
 *   covers   what the link is, in words, for the list and the audit log
 *   twinIds  for a series link, the same show's other library entries
 *            (findTwins: same provider ids). resolveEpisodes takes a season
 *            from such an entry when the linked one lacks it, and the link
 *            must still cover it there.
 * A link Jellyfin could not be asked about is saved as it is; it matches on
 * its id all the same.
 */
export function parseEntry(input, { addedBy = null, note = '', now = Date.now(), resolved = null } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Enter a title (a film or a show), or paste a Jellyfin link.');

  const jellyfinId = jellyfinIdFrom(raw);
  if (jellyfinId) {
    const kind = resolved?.kind === 'film' || resolved?.kind === 'tv' ? resolved.kind : null;
    const twins = kind === 'tv' && Array.isArray(resolved?.twinIds)
      ? [...new Set(resolved.twinIds.map((x) => jellyfinIdFrom(x)).filter((x) => x && x !== jellyfinId))].slice(0, 20)
      : [];
    return {
      key: `jf:${jellyfinId}`, jellyfinId, title: null, year: null,
      ...(kind ? { kind } : {}),
      ...(resolved?.covers ? { covers: String(resolved.covers).slice(0, 200) } : {}),
      ...(twins.length ? { twinIds: twins } : {}),
      addedBy, note, addedAt: now,
    };
  }

  const { title, year, season, episode } = parseTvTitle(raw);
  const norm = titleKey(title);
  if (!norm) throw new Error(`"${raw}" has no letters or numbers to match a title on. Paste the Jellyfin link instead.`);
  const narrowed = season != null || episode != null;
  return {
    // A plain title keeps the key every build has given it.
    key: narrowed ? `t:${norm}|${year ?? ''}|${season ?? ''}|${episode ?? ''}` : `t:${norm}|${year ?? ''}`,
    jellyfinId: null, title, year,
    ...(narrowed ? { season, episode } : {}),
    addedBy, note, addedAt: now,
  };
}

/** The same entry, however it was typed or stored: the same id, or the same letters, year and scope. */
function sameEntry(a, b) {
  if (a.jellyfinId || b.jellyfinId) return !!a.jellyfinId && a.jellyfinId === b.jellyfinId;
  return nameKey(a.title) === nameKey(b.title) && (a.year ?? null) === (b.year ?? null)
    && (a.season ?? null) === (b.season ?? null) && (a.episode ?? null) === (b.episode ?? null);
}

const readKey = (store, key) => (store.get(key, []) ?? []).map(normalise).filter(Boolean);

/** Every entry, newest first. Entries with no addedAt (the oldest) last. */
export function listOverrides(store) {
  const all = [...readKey(store, FILM_KEY), ...readKey(store, TV_KEY)];
  const seen = new Set();
  return all.filter((e) => (seen.has(e.key) ? false : seen.add(e.key)))
    .sort((a, b) => (Number(b.addedAt) || 0) - (Number(a.addedAt) || 0));
}

/** Write the list back, each entry where it belongs (see the header). */
function save(store, list) {
  store.set(FILM_KEY, list.filter((e) => !apart(e)));
  const tv = list.filter(apart);
  if (tv.length || store.get(TV_KEY, null) != null) store.set(TV_KEY, tv);
}

export function addOverride(store, input, opts = {}) {
  const entry = parseEntry(input, opts);
  const list = listOverrides(store);
  if (list.some((e) => e.key === entry.key || sameEntry(e, entry))) throw new Error('That is already on the list.');
  list.unshift(entry);
  if (list.length > MAX) list.length = MAX;
  save(store, list);
  return entry;
}

export function removeOverride(store, key) {
  const list = listOverrides(store);
  const kept = list.filter((e) => e.key !== key);
  if (kept.length === list.length) return false;
  save(store, kept);
  return true;
}

/**
 * The entry that covers this film, or null.
 *
 * `hit` is the library match when there is one, so an entry added by Jellyfin
 * link still applies to a request that arrived as free text; and the library's
 * title is matched as well as the requested one, since the two disagree often
 * enough that matching only one would make the list look unreliable ("I added
 * it and it still blocked"). An entry narrowed to a season or an episode is a
 * show's, and covers no film. Names and years are matched by coversName.
 */
export function isOverridden(store, movie = {}, hit = null) {
  const list = listOverrides(store);
  if (!list.length) return null;

  const id = String(hit?.id ?? movie.jellyfinId ?? '').toLowerCase();
  if (id) {
    const byId = list.find((e) => e.jellyfinId && e.jellyfinId === id);
    if (byId) return byId;
  }

  const names = [movie.title, hit?.title].filter(Boolean);
  const years = [movie.year, hit?.year].filter((y) => y != null).map(Number);
  // A year on the entry must agree with a year we know, so adding "Dune
  // 2021" does not also cover the 1984 one (coversName).
  return list.find((e) => e.title && !scoped(e) && coversName(e, names, years)) ?? null;
}

/**
 * The entry that covers this episode, or null.
 *
 * `series` is the show the episodes were resolved from (findSeries), `ep` one
 * of its episodes from listEpisodes. A link matches when its id is the
 * episode's, its season's or its series' - Jellyfin ids are unique, so that
 * is exact whichever of the three the admin pasted - or, for a series link,
 * when the episodes came from one of the show's other library entries that
 * were recorded with it (`twinIds`). A title matches the show's name as the
 * library has it (coversName: the exact title, with the year agreeing when
 * both sides have one), and then only the season and episode it names, if it
 * names them.
 */
export function tvOverrideFor(store, series = {}, ep = {}) {
  const list = listOverrides(store);
  if (!list.length) return null;

  const ids = [ep?.id, ep?.seasonId, ep?.seriesId, series?.id]
    .filter(Boolean).map((x) => String(x).toLowerCase());
  const byId = list.find((e) => e.jellyfinId && ids.includes(e.jellyfinId));
  if (byId) return byId;
  // A twin is another entry of the same SERIES, so it is compared with the
  // series ids only, never an episode's or a season's.
  const seriesIds = [ep?.seriesId, series?.id].filter(Boolean).map((x) => String(x).toLowerCase());
  const byTwin = list.find((e) => e.jellyfinId && Array.isArray(e.twinIds)
    && e.twinIds.some((t) => seriesIds.includes(String(t).toLowerCase())));
  if (byTwin) return byTwin;

  const names = [series?.name, ep?.series].filter(Boolean);
  const years = series?.year != null ? [Number(series.year)] : [];
  for (const e of list) {
    if (!coversName(e, names, years)) continue;
    if (e.season != null && (ep?.season == null || Number(e.season) !== Number(ep.season))) continue;
    if (e.episode != null && (ep?.episode == null || Number(e.episode) !== Number(ep.episode))) continue;
    return e;
  }
  return null;
}

/**
 * Does this entry cover a library item of this name and year? The panel's
 * "matches now" line, with the same rule the two functions above apply.
 * `type` is 'film' or 'tv'.
 */
export function entryCoversName(e, { name, year = null, type = 'film' } = {}) {
  if (type === 'film' && scoped(e)) return false;
  return coversName(e, [name].filter(Boolean), year != null ? [Number(year)] : []);
}

/** An entry in words, as the list, the audit log and the log name it. */
export function overrideLabel(e) {
  if (!e) return '';
  if (e.jellyfinId) {
    return e.covers ?? `Jellyfin item ${e.jellyfinId}${e.kind ? ` (${e.kind === 'tv' ? 'TV' : 'film'})` : ''}`;
  }
  return `"${e.title}"${e.year ? ` (${e.year})` : ''}${scoped(e) ? ` ${tvScope(e)}` : ''}`;
}

/**
 * Whether any entry could cover a film once the library has named it: a link
 * that is not a show's, or a title not narrowed to a season or an episode. A
 * request whose film its rating blocks, and that no entry covers by the name
 * asked for, is then not refused until the library has answered - an entry
 * added by Jellyfin link matches the library's item and nothing else, and
 * the library's title can be worded otherwise (film-gate.js ratingGate).
 */
export function mayCoverFilms(store) {
  return listOverrides(store).some((e) => (e.jellyfinId ? e.kind !== 'tv' : !scoped(e)));
}

/** What the Test tab says of a title the list sends. */
export const BYPASS_NOTE = 'on the bypass list - sent without the AI check';

/**
 * What History and the log say of a title the list sent: "sent: on the
 * bypass list (rating override for "The Last Samurai" (2003) by mommy)".
 */
export function bypassNote(e) {
  return `sent: on the bypass list (${describeOverride(e)})`;
}

/** One line for the log and the history detail. */
export function describeOverride(e) {
  if (!e) return '';
  const by = e.addedBy && typeof e.addedBy === 'object' ? e.addedBy.username : e.addedBy;
  const who = by ? ` by ${by}` : '';
  return e.jellyfinId
    ? `rating override (Jellyfin item ${e.jellyfinId.slice(0, 8)}…${e.covers ? `: ${e.covers}` : ''}${who})`
    : `rating override for ${overrideLabel(e)}${who}`;
}
