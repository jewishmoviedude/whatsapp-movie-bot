/* Finding a series Jellyfin's own search will not find.
   Run: node test/series-lookup.test.mjs

   findSeries is the ONLY function in the codebase that can find a TV show, so
   every "not in the library" answer about a show is its verdict - for the TV
   plugin and for the movie plugin's "actually, that is a series" escape hatch
   alike. It used to be one /Items?searchTerm= query, which is weaker than it
   looks: an un-tokenised filter over the stored name, scoped to whatever
   libraries the bot's Jellyfin account may see, and blind to OriginalTitle.

   The Jellyfin WEB UI does not use that endpoint - it uses /Search/Hints. That
   is why a show can be plainly visible to a human and invisible to the bot,
   which is exactly what happened with Kitchen Nightmares. */
import { findSeries, resolveEpisodes } from '../src/plugins/tv-requests/jellyfin-tv.js';
import { bestMatch } from '../src/util/fuzzy.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const OPTS = { base: 'http://jf:8096', token: 'TOK', userId: 'U1', bestMatch };

/**
 * A Jellyfin that behaves like the real one: /Items?searchTerm is a plain
 * substring test over Name, /Search/Hints is word-aware and also sees
 * OriginalTitle, and a UserId scopes results to that account's libraries.
 */
function jellyfin({ library = [], visibleToUser = null, hints = true } = {}) {
  const seen = [];
  const visible = (i) => (visibleToUser ? visibleToUser.includes(i.Name) : true);

  const fetchImpl = async (raw) => {
    const url = new URL(String(raw));
    seen.push(url.pathname + url.search);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });

    if (url.pathname.endsWith('/Search/Hints')) {
      if (!hints) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
      const term = (url.searchParams.get('searchTerm') ?? '').toLowerCase();
      const scoped = url.searchParams.get('userId') ? library.filter(visible) : library;
      // Word-aware: every word of the term must appear somewhere in a name.
      const words = term.split(/\s+/).filter(Boolean);
      const SearchHints = scoped
        .filter((i) => words.every((w) => [i.Name, i.OriginalTitle].filter(Boolean)
          .some((n) => n.toLowerCase().includes(w))))
        .map((i) => ({ ItemId: i.Id, Name: i.Name, ProductionYear: i.ProductionYear }));
      return json({ SearchHints });
    }

    if (url.pathname.endsWith('/Items')) {
      const term = url.searchParams.get('searchTerm');
      const scoped = url.searchParams.get('UserId') ? library.filter(visible) : library;
      const Items = term
        ? scoped.filter((i) => i.Name.toLowerCase().includes(term.toLowerCase()))
        : scoped;
      return json({ Items, TotalRecordCount: Items.length });
    }
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
  };
  return { fetchImpl, seen };
}

const KN_UK = { Id: 'UK', Name: "Ramsay's Kitchen Nightmares", ProductionYear: 2004 };
const KN_US = { Id: 'US', Name: 'Kitchen Nightmares', ProductionYear: 2007 };
const BOYS = { Id: 'B', Name: 'The Boys', ProductionYear: 2019 };

console.log('=== the ordinary case still costs one request ===');
{
  const { fetchImpl, seen } = jellyfin({ library: [KN_US, BOYS] });
  const s = await findSeries('Kitchen Nightmares', { ...OPTS, fetchImpl });
  ok(s?.id === 'US', 'found');
  ok(s.via === 'search', 'via the plain search');
  ok(seen.length === 1, 'and only one request was made - the fallbacks cost nothing when unused');
}

console.log('=== a possessive in the stored name no longer hides the show ===');
{
  // This is the Kitchen Nightmares report. Jellyfin stores the UK run as
  // "Ramsay's Kitchen Nightmares"; searchTerm="Kitchen Nightmares" is not a
  // substring of nothing - it IS a substring here - so use a name where the
  // asked-for words are split, which searchTerm genuinely cannot match.
  const SPLIT = { Id: 'X', Name: 'Kitchen: Nightmares Uncut', ProductionYear: 2007 };
  const { fetchImpl } = jellyfin({ library: [SPLIT, BOYS] });
  const s = await findSeries('Kitchen Nightmares', { ...OPTS, fetchImpl });
  ok(s?.id === 'X', 'found anyway');
  ok(s.via === 'hints' || s.via === 'enumerated', `via a fallback (${s.via}), not the plain search`);
}

console.log('=== a library the bot cannot see is reported as such ===');
{
  // The bot's Jellyfin account has the Movies library but not TV. The human
  // browsing as themselves sees the show; the bot's scoped query sees nothing.
  const notes = [];
  const { fetchImpl } = jellyfin({ library: [KN_US], visibleToUser: [] });
  const s = await findSeries('Kitchen Nightmares', {
    ...OPTS, fetchImpl, onDiagnostic: (m) => notes.push(m),
  });
  ok(s?.id === 'US', 'the show is still found');
  ok(s.via === 'unscoped', 'by retrying without the UserId');
  ok(notes.some((n) => /INVISIBLE to the bot/.test(n)),
    'and it says so, naming the real problem instead of answering "not in the library"');
}

console.log('=== a show stored under a different name is found by OriginalTitle ===');
{
  const ALT = { Id: 'A', Name: 'Pesadelo na Cozinha', OriginalTitle: 'Kitchen Nightmares', ProductionYear: 2007 };
  const { fetchImpl } = jellyfin({ library: [ALT], hints: false });
  const s = await findSeries('Kitchen Nightmares', { ...OPTS, fetchImpl });
  ok(s?.id === 'A', 'matched on OriginalTitle after listing the library');
  ok(s.via === 'enumerated', 'via the local match over every series');
}

console.log('=== searching one word alone finds what the phrase cannot ===');
{
  // Measured against the real server: searchTerm="Ramsay Kitchen Nightmares"
  // returns nothing, because the stored name has a possessive the phrase does
  // not. Searching "Nightmares" alone returns it, and the fuzzy matcher then
  // picks it out at 0.963.
  const { fetchImpl, seen } = jellyfin({ library: [KN_UK, BOYS], hints: false });
  const s = await findSeries('Ramsay Kitchen Nightmares', { ...OPTS, fetchImpl });
  ok(s?.id === 'UK', 'found via a single word');
  ok(s.via === 'word', `reported as via:word (got ${s.via})`);
  ok(seen.some((u) => /searchTerm=Nightmares/i.test(u)), 'the longest word was searched on its own');
  ok(!seen.some((u) => /StartIndex/.test(u)), 'and the library was never listed - the word search is cheaper');
}

console.log('=== listing the library pages through it, and stops early ===');
{
  // This fallback shipped as a single 500-item request, on the assumption that
  // a TV library is hundreds of shows. The real one holds 8,506 - so it
  // covered six per cent and then reported a confident miss.
  const big = [];
  for (let i = 0; i < 2500; i++) big.push({ Id: `X${i}`, Name: `Filler Show ${i}`, ProductionYear: 2000 });
  big.push({ Id: 'DEEP', Name: 'Kitchen: Nightmares Uncut', ProductionYear: 2007 });

  const pages = [];
  const fetchImpl = async (raw) => {
    const url = new URL(String(raw));
    pages.push(url.searchParams.get('StartIndex') ?? '0');
    const json = (b) => ({ ok: true, status: 200, json: async () => b });
    if (url.pathname.endsWith('/Search/Hints')) return { ok: false, status: 404, statusText: 'x', json: async () => ({}) };
    const term = url.searchParams.get('searchTerm');
    if (term) return json({ Items: [], TotalRecordCount: 0 });      // server search finds nothing
    const start = Number(url.searchParams.get('StartIndex') ?? 0);
    const limit = Number(url.searchParams.get('Limit') ?? 25);
    return json({ Items: big.slice(start, start + limit), TotalRecordCount: big.length });
  };

  const s = await findSeries('Kitchen Nightmares', { ...OPTS, fetchImpl });
  ok(s?.id === 'DEEP', 'a show past the first page is still found');
  ok(s.via === 'enumerated', 'via the paged listing');
  ok(pages.filter((p) => p !== '0').length > 0, 'it actually paged rather than giving up after one request');
  // The match is on the third page; there must be no fourth.
  ok(!pages.includes('3000'), 'and it stopped as soon as it matched, rather than reading the whole library');
}

console.log('=== a bounded search says what it did NOT cover ===');
{
  // A cap that silently truncates reads as "we looked everywhere".
  const notes = [];
  const fetchImpl = async (raw) => {
    const url = new URL(String(raw));
    const json = (b) => ({ ok: true, status: 200, json: async () => b });
    if (url.pathname.endsWith('/Search/Hints')) return { ok: false, status: 404, statusText: 'x', json: async () => ({}) };
    if (url.searchParams.get('searchTerm')) return json({ Items: [], TotalRecordCount: 0 });
    return json({ Items: [], TotalRecordCount: 8506 });    // server says 8506, hands back none
  };
  ok(await findSeries('Nothing At All', { ...OPTS, fetchImpl, onDiagnostic: (m) => notes.push(m) }) === null,
    'still a miss');
  ok(notes.some((n) => /8506/.test(n)), 'and the note names the real size of the library it searched');
}

console.log('=== a near-miss is NOT good enough for a wide-net search ===');
{
  /* Real incident: somebody asked for "Crew girl". No such show is on the
     server, but the word search looked for "girl" alone, found "The Crow Girl"
     at 0.889, and sent six episodes of it. One letter, in the middle of a short
     word, between two real and different shows.

     The direct search may stay generous - the server vouched that its rows
     relate to the phrase the person typed. The word search and the full
     listing may not: they look for something nobody typed. */
  const CROW = { Id: 'CROW', Name: 'The Crow Girl', ProductionYear: 2025 };
  const { fetchImpl } = jellyfin({ library: [CROW, BOYS], hints: false });
  const notes = [];
  const s = await findSeries('Crew girl', { ...OPTS, fetchImpl, onDiagnostic: (m) => notes.push(m) });
  ok(s === null, 'a 0.889 near-miss found by searching one word is refused');

  // ...while the show it actually names is still found, on the direct search.
  const { fetchImpl: f2 } = jellyfin({ library: [CROW, BOYS] });
  const exact = await findSeries('The Crow Girl', { ...OPTS, fetchImpl: f2 });
  ok(exact?.id === 'CROW' && exact.via === 'search', 'and asking for it by name still works');

  // The bar only rises for the speculative steps; the earlier ones keep 0.72.
  const src = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../src/plugins/tv-requests/jellyfin-tv.js', import.meta.url), 'utf8'));
  ok(/const DIRECT_THRESHOLD = 0\.72;/.test(src), 'the direct search stays generous');
  ok(/const FALLBACK_THRESHOLD = 0\.9;/.test(src), 'the wide-net steps do not');
  ok((src.match(/FALLBACK_THRESHOLD\)/g) ?? []).length === 2,
    'applied to both the word search and the listing');
}

console.log('=== the year survives the noise stripper ===');
{
  // cleanRequestText removes four-digit years along with "please" and "thanks",
  // which threw away the one thing that separates two shows sharing a name -
  // on the very path that had just been given a year tiebreaker.
  const tv = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../src/plugins/tv-requests/index.js', import.meta.url), 'utf8'));
  ok(/const year = extractYear\(parsed\.show\)/.test(tv), 'the year is read before cleaning');
  ok(/if \(year && !extractYear\(cleanedShow\)\) cleanedShow = /.test(tv), 'and put back after');
}

console.log('=== a show that genuinely is not there is still a miss ===');
{
  const notes = [];
  const { fetchImpl } = jellyfin({ library: [BOYS] });
  const s = await findSeries('Kitchen Nightmares', {
    ...OPTS, fetchImpl, onDiagnostic: (m) => notes.push(m),
  });
  ok(s === null, 'null - the fallbacks do not invent a match');
  ok(notes.some((n) => /no series matched/.test(n)), 'and the reason is recorded');
}

console.log('=== the fallbacks cannot be tricked into a bad match ===');
{
  // "Hell's Kitchen" shares a word. Enumerating the whole library must not
  // relax the threshold that keeps it out.
  const HK = { Id: 'H', Name: "Hell's Kitchen", ProductionYear: 2005 };
  const { fetchImpl } = jellyfin({ library: [HK], hints: false });
  ok(await findSeries('Kitchen Nightmares', { ...OPTS, fetchImpl }) === null,
    'a shared word is not a match');
}

console.log('=== the year separates two shows with the same name ===');
{
  // The 2004 UK run and the 2007 US run. Without the year the matcher picks
  // whichever the server listed first, and a request for season 5 - which only
  // the US run has - then comes back as an empty season.
  const { fetchImpl } = jellyfin({ library: [KN_UK, KN_US] });
  const s = await findSeries('Kitchen Nightmares', { ...OPTS, fetchImpl, year: 2007 });
  ok(s?.id === 'US', 'the year picks the right one');

  const older = await findSeries('Kitchen Nightmares', { ...OPTS, fetchImpl, year: 2004 });
  ok(older?.id === 'UK', 'and the other year picks the other one');
}

console.log('=== resolveEpisodes passes the year through ===');
{
  // stripTrailingYear pulled the year off the request and then dropped it,
  // so the one tiebreaker that could tell the two shows apart was dead code.
  const { fetchImpl, seen } = jellyfin({ library: [KN_UK, KN_US] });
  const withSeasons = async (raw) => {
    const url = new URL(String(raw));
    if (url.pathname.includes('/Seasons')) {
      return { ok: true, status: 200, json: async () => ({ Items: [{ Id: 's', IndexNumber: 1 }] }) };
    }
    if (url.pathname.includes('/Episodes')) {
      return { ok: true, status: 200, json: async () => ({ Items: [] }) };
    }
    return fetchImpl(raw);
  };
  const r = await resolveEpisodes(
    { show: 'Kitchen Nightmares 2007', season: 1, episode: null },
    { ...OPTS, fetchImpl: withSeasons },
  );
  ok(r.series?.id === 'US', 'the trailing year in the request reaches the matcher');
  ok(seen.length > 0, 'and the lookup actually ran');
}

console.log('=== "we have the show but not that season" is its own answer ===');
{
  // It used to share the not-in-library reaction with a show the server has
  // never heard of, so a requester could not tell "ask for season 2 instead"
  // from "we do not have this at all".
  const fetchImpl = async (raw) => {
    const url = new URL(String(raw));
    const json = (b) => ({ ok: true, status: 200, json: async () => b });
    if (url.pathname.endsWith('/Items')) return json({ Items: [BOYS] });
    if (url.pathname.includes('/Seasons')) return json({ Items: [{ Id: 's1', IndexNumber: 1 }, { Id: 's2', IndexNumber: 2 }] });
    if (url.pathname.includes('/Episodes')) return json({ Items: [] });
    return { ok: false, status: 404, statusText: 'x', json: async () => ({}) };
  };

  const r = await resolveEpisodes({ show: 'The Boys', season: 9, episode: null }, { ...OPTS, fetchImpl });
  ok(r.error === 'empty-season', 'season 9 is an empty season, not a missing show');
  ok(Array.isArray(r.seasons) && r.seasons.join(',') === '1,2',
    'and it reports which seasons DO exist, so the reply can say so');

  const e = await resolveEpisodes({ show: 'The Boys', season: 1, episode: 99 }, { ...OPTS, fetchImpl });
  ok(e.error === 'no-such-episode', 'a missing episode is distinct again');
  ok(Array.isArray(e.seasons), 'and it too knows what exists');
}

/* ---------------- same-named entries: empty leftovers and split shows ---------------- */

/**
 * A library with several entries per title, answering like the real server:
 * /Items is a substring filter on Name, and RecursiveItemCount and ProviderIds
 * come back only when Fields asks for them - so a fix that stops asking fails.
 * `shows` maps id -> { entry, seasons: { n: episodeCount } }.
 */
function twinLibrary(shows) {
  const seen = [];
  const fetchImpl = async (raw) => {
    const url = new URL(String(raw));
    seen.push(url.pathname + url.search);
    const json = (b) => ({ ok: true, status: 200, json: async () => b });
    const fields = (url.searchParams.get('Fields') ?? '').split(',');
    const id = url.pathname.match(/\/Shows\/([^/]+)\//)?.[1];
    if (url.pathname.endsWith('/Seasons')) {
      return json({ Items: Object.entries(shows[id].seasons).map(([n, c]) => ({ Id: `${id}-${n}`, IndexNumber: Number(n),
        ...(fields.includes('ChildCount') ? { ChildCount: c } : {}) })) });
    }
    if (url.pathname.endsWith('/Episodes')) {
      const n = Number(url.searchParams.get('season'));
      const count = shows[id].seasons[n] ?? 0;
      return json({ Items: Array.from({ length: count }, (_, i) => ({ Id: `${id}-${n}-${i + 1}`, SeriesName: shows[id].entry.Name,
        ParentIndexNumber: n, IndexNumber: i + 1, MediaSources: [{ Path: `/${id}/${n}/${i + 1}.mkv` }] })) });
    }
    if (url.pathname.endsWith('/Items')) {
      const term = (url.searchParams.get('searchTerm') ?? '').toLowerCase();
      const Items = Object.values(shows).map((x) => x.entry).filter((e) => e.Name.toLowerCase().includes(term)).map((e) => {
        const { RecursiveItemCount, ProviderIds, ...rest } = e;
        return { ...rest, ...(fields.includes('RecursiveItemCount') ? { RecursiveItemCount } : {}),
          ...(fields.includes('ProviderIds') && ProviderIds ? { ProviderIds } : {}) };
      });
      return json({ Items });
    }
    return { ok: false, status: 404, statusText: 'x', json: async () => ({}) };
  };
  return { fetchImpl, seen };
}
const ids = (tmdb) => ({ Tmdb: String(tmdb), Tvdb: String(tmdb * 7), Imdb: `tt${tmdb}` });
const count = (seasons) => Object.values(seasons).reduce((a, b) => a + b, 0);
const show = (Id, Name, ProductionYear, seasons, extra = {}) =>
  ({ [Id]: { entry: { Id, Name, ProductionYear, RecursiveItemCount: count(seasons), ...extra }, seasons } });

console.log('=== an empty copy of a show loses to the same show with episodes ===');
{
  // bot-box: two "American Dad!" (2005), same TMDB/TVDB/IMDb ids -
  // `tv/American Dad!`, 22 empty season folders, listed FIRST by Jellyfin, and
  // `tv/American Dad! (2005) [tmdbid-1433]` with 471 episodes. The matcher kept
  // the first of two equal scores; members were told "we don't have season 5 -
  // on the server: seasons 1 to 22". Fourteen shows had such a twin.
  const empty22 = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [i + 1, 0]));
  const full22 = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [i + 1, 3]));
  const AD = { ...show('shell', 'American Dad!', 2005, empty22, { ProviderIds: ids(1433) }),
    ...show('full', 'American Dad!', 2005, full22, { ProviderIds: ids(1433) }) };

  const { fetchImpl, seen } = twinLibrary(AD);
  const s = await findSeries('American Dad', { ...OPTS, fetchImpl });
  ok(s?.id === 'full', `the entry with the episodes wins, though Jellyfin lists the empty one first (${s?.id})`);
  ok(seen.length === 1, 'still in one request');
  const r = await resolveEpisodes({ show: 'American dad', season: 5, episode: null }, { ...OPTS, fetchImpl });
  ok(!r.error && r.series.id === 'full' && r.episodes.length === 3 && r.episodes.every((e) => e.season === 5),
    `season 5 resolves (${r.error ?? `${r.episodes.length} episodes`})`);

  // An empty exact match must not lose to a merely similar show with files -
  // one with different ids, found by the same substring search.
  const look = twinLibrary({ ...show('shell', 'American Dad!', 2005, empty22, { ProviderIds: ids(1433) }),
    ...show('look', 'American Dads', 2005, { 1: 40 }, { ProviderIds: ids(9999) }) });
  const kept = await findSeries('American Dad', { ...OPTS, fetchImpl: look.fetchImpl });
  ok(kept?.id === 'shell', `a lookalike with files never replaces an empty exact match (${kept?.id})`);

  // Non-Latin names, and no ids to go by: 進撃の巨人 once reduced to "" and
  // matched every other "", swapping an empty show for another one.
  // (The same year on purpose: only the titles can tell these two apart.)
  const aot = twinLibrary({ ...show('aot', 'Attack on Titan', 2013, { 1: 0 }, { OriginalTitle: '進撃の巨人' }),
    ...show('jh', 'Attack on Titan: Junior High', 2013, { 1: 12 }, { OriginalTitle: '進撃！巨人中学校' }) });
  const a = await findSeries('Attack on Titan', { ...OPTS, fetchImpl: aot.fetchImpl });
  ok(a?.id === 'aot', `two different non-Latin OriginalTitles are not "the same title" (${a?.id})`);
  const ar = await resolveEpisodes({ show: 'Attack on Titan', season: 1, episode: null }, { ...OPTS, fetchImpl: aot.fetchImpl });
  ok(ar.error === 'empty-season', 'and Junior High is never sent for it');

  // And the other way: with no ids, a non-Latin name two entries share is
  // what makes them one show - so it has to survive the comparison.
  const klk = twinLibrary({ ...show('k0', 'Kill la Kill', 2013, { 1: 0 }, { OriginalTitle: 'キルラキル' }),
    ...show('k1', 'Kill la Kill (2013)', 2013, { 1: 24 }, { OriginalTitle: 'キルラキル' }) });
  const k = await findSeries('Kill la Kill', { ...OPTS, fetchImpl: klk.fetchImpl });
  ok(k?.id === 'k1', `an empty entry is swapped for one sharing its Japanese title (${k?.id})`);

  // A name of symbols alone reduces to nothing, and nothing is no title.
  const sym = twinLibrary({ ...show('s0', 'Starlight', 2020, { 1: 0 }, { OriginalTitle: '★★★' }),
    ...show('s1', 'Starlight Kids', 2020, { 1: 9 }, { OriginalTitle: '★★★' }) });
  const st = await findSeries('Starlight', { ...OPTS, fetchImpl: sym.fetchImpl });
  ok(st?.id === 's0', `two names that are only symbols do not make two shows one (${st?.id})`);
}

console.log('=== a season held only in the show\'s other entry is found there ===');
{
  // Split shows: bot-box has "Blue Exorcist" as 73 + 14 episodes in two
  // entries with the same ids. A season held only in the second was "not in
  // the library" whenever the first was picked.
  const BE = { ...show('a', 'Blue Exorcist', 2011, { 1: 5, 2: 5 }, { ProviderIds: ids(38464), OfficialRating: 'TV-MA' }),
    ...show('b', 'Blue Exorcist', 2011, { 3: 5 }, { ProviderIds: ids(38464) }) };
  const notes = [];
  const { fetchImpl } = twinLibrary(BE);
  const r = await resolveEpisodes({ show: 'Blue Exorcist', season: 3, episode: null },
    { ...OPTS, fetchImpl, onDiagnostic: (m) => notes.push(m) });
  ok(!r.error && r.series.id === 'b' && r.episodes.every((e) => e.season === 3), `season 3 comes from the entry that has it (${r.error ?? r.series.id})`);
  ok(notes.some((n) => /its same-named entry b does/.test(n)), 'and the log says the other entry was used');
  ok(r.series.rating === 'TV-MA', 'the rating gate still sees the rating, though only the first entry carried it');
  const e = await resolveEpisodes({ show: 'Blue Exorcist', season: 3, episode: 2 }, { ...OPTS, fetchImpl });
  ok(!e.error && e.series.id === 'b' && e.episodes[0].episode === 2, 'the same for one episode');
  const none = await resolveEpisodes({ show: 'Blue Exorcist', season: 7, episode: null }, { ...OPTS, fetchImpl });
  ok(none.error === 'empty-season' && none.seasons.join(',') === '1,2,3',
    `a season neither has is an honest "we don't have it", naming both entries' seasons (${none.seasons})`);
  const ask = await resolveEpisodes({ show: 'Blue Exorcist', season: null, episode: null }, { ...OPTS, fetchImpl });
  ok(ask.error === 'need-season' && ask.seasons.join(',') === '1,2,3', '"which season?" offers both entries\' seasons');
  const ep = await resolveEpisodes({ show: 'Blue Exorcist', season: null, episode: 2 }, { ...OPTS, fetchImpl });
  ok(ep.error === 'need-season', '"episode 2" with no season asks, rather than guessing from one entry');
}

console.log('=== a same-named DIFFERENT show is never taken instead ===');
{
  // Same title, different ids: another show. Each of these was served in
  // review before the ids were compared.
  const SH = { ...show('us', 'Shameless', 2011, { 1: 4, 2: 4, 4: 4 }, { ProviderIds: ids(34307) }),
    ...show('uk', 'Shameless', 2004, { 1: 4, 2: 4, 3: 4, 4: 4 }, { ProviderIds: ids(1906) }) };
  const sh = await resolveEpisodes({ show: 'Shameless', season: 3, episode: null }, { ...OPTS, fetchImpl: twinLibrary(SH).fetchImpl });
  ok(sh.error === 'empty-season' && sh.series.id === 'us', `no year asked: the US Shameless lacking season 3 does not become the UK one (${sh.series?.id})`);

  const CH = { ...show('c1998', 'Charmed', 1998, { 8: 22 }, { ProviderIds: ids(1981) }),
    ...show('c2018', 'Charmed', 2018, { 1: 22, 2: 19 }, { ProviderIds: ids(79611) }) };
  const ch = await resolveEpisodes({ show: 'Charmed 2018', season: 8, episode: null }, { ...OPTS, fetchImpl: twinLibrary(CH).fetchImpl });
  ok(ch.error === 'empty-season' && ch.series.id === 'c2018', '"Charmed 2018 season 8" is not the 1998 show\'s season 8');

  const LO = { ...show('lo', 'Law & Order', 1990, { 1: 5, 2: 5 }, { ProviderIds: ids(549) }),
    ...show('svu', 'Law & Order: Special Victims Unit', 1999, { 22: 16 }, { ProviderIds: ids(2734) }) };
  const lo = await resolveEpisodes({ show: 'Law & Order', season: 22, episode: null }, { ...OPTS, fetchImpl: twinLibrary(LO).fetchImpl });
  ok(lo.error === 'empty-season' && lo.series.id === 'lo', 'nor does a longer title the search also returns (SVU) stand in');
}

console.log('=== a season the picked entry has is used as it is ===');
{
  // Only a miss looks at twins, and a twin's season is taken whole - never
  // merged with the picked entry's.
  const BB = { ...show('main', 'Big Brother', 2000, { 3: 10 }, { ProviderIds: ids(10160) }),
    ...show('extra', 'Big Brother', 2000, { 3: 40 }, { ProviderIds: ids(10160) }) };
  const { fetchImpl, seen } = twinLibrary(BB);
  const r = await resolveEpisodes({ show: 'Big Brother', season: 3, episode: null }, { ...OPTS, fetchImpl });
  ok(r.series.id === 'main' && r.episodes.length === 10 && r.episodes.every((e) => e.id.startsWith('main-')),
    `the picked entry's own 10 episodes, nothing from the other (${r.series.id}, ${r.episodes.length})`);
  ok(seen.filter((u) => u.startsWith('/Items')).length === 1, 'and no twin search was made for it');
}

console.log('=== "what we have" never offers an empty season folder ===');
{
  const SN = show('s', 'Supernatural', 2005, { 1: 22, 2: 0, 3: 22 }, { ProviderIds: ids(1622) });
  const { fetchImpl } = twinLibrary(SN);
  const r = await resolveEpisodes({ show: 'Supernatural', season: 2, episode: null }, { ...OPTS, fetchImpl });
  ok(r.error === 'empty-season' && r.seasons.join(',') === '1,3', `the reply lists only seasons with episodes (${r.seasons})`);
  const ask = await resolveEpisodes({ show: 'Supernatural', season: null, episode: null }, { ...OPTS, fetchImpl });
  ok(ask.error === 'need-season' && ask.seasons.join(',') === '1,3', 'and so does "which season?"');

  const CN = show('c', 'Chernobyl', 2019, { 1: 5, 2: 0 }, { ProviderIds: ids(87108) });
  const one = await resolveEpisodes({ show: 'Chernobyl', season: null, episode: 5 }, { ...OPTS, fetchImpl: twinLibrary(CN).fetchImpl });
  ok(!one.error && one.episodes[0]?.season === 1 && one.episodes[0].episode === 5, '"episode 5" of a one-season show (plus an empty folder) is season 1');

  const EMPTY = show('e', 'The Civil War', 1990, { 1: 0, 2: 0 }, { ProviderIds: ids(3500) });
  const nothing = await resolveEpisodes({ show: 'The Civil War', season: null, episode: null }, { ...OPTS, fetchImpl: twinLibrary(EMPTY).fetchImpl });
  ok(nothing.error === 'not-found', `a show with nothing in any season is not in the library, not a "which season?" with none to offer (${nothing.error})`);
}

console.log('=== a season named by its subtitle still finds the show ===');
{
  // 2026-10-07 19:00Z: "avatar the last Airbender book 1: water S01" was
  // answered "no series matching" though "Avatar the Last Airbender" is in
  // the library; the subtitle sank the match.
  const { fetchImpl } = twinLibrary(show('A', 'Avatar the Last Airbender', 2024, { 1: 3 }));
  const r = await resolveEpisodes({ show: 'avatar the last Airbender book 1: water', season: 1, episode: null }, { ...OPTS, fetchImpl });
  ok(r.error !== 'not-found' && r.series?.id === 'A', `the part before the colon finds the show (${r.error})`);
  const none = await resolveEpisodes({ show: 'nothing like it book 1: water', season: 1, episode: null }, { ...OPTS, fetchImpl });
  ok(none.error === 'not-found', 'and a show that is not there is still not found');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
