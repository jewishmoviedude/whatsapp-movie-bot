/* Jellyfin TV enumeration. Run: node test/tv-jellyfin.test.mjs */
import { findSeries, listSeasons, listEpisodes, resolveEpisodes, episodeDownloadUrl } from '../src/plugins/tv-requests/jellyfin-tv.js';
import { parseTvRequest } from '../src/plugins/tv-requests/parse.js';
import { episodeFileName } from '../src/plugins/tv-requests/naming.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const OPTS = { base: 'http://jf:8096', token: 'TOK', userId: 'U1' };

/** Fake Jellyfin: records the URLs asked for and answers from a fixture. */
function fakeServer(routes) {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    for (const [pattern, body] of Object.entries(routes)) {
      if (String(url).includes(pattern)) {
        return { ok: true, status: 200, json: async () => body };
      }
    }
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
  };
  return { fetchImpl, seen };
}

const SERIES = { Items: [{ Id: 'SER1', Name: 'The Boys', ProductionYear: 2019 }] };
const SEASONS = { Items: [{ Id: 'S1', IndexNumber: 1, Name: 'Season 1' }, { Id: 'S2', IndexNumber: 2, Name: 'Season 2' }] };
const EPISODES = {
  Items: [
    { Id: 'E2', SeriesName: 'The Boys', ParentIndexNumber: 1, IndexNumber: 2, Name: 'Cherry', MediaSources: [{ Path: '/tv/b.mkv', Size: 2000, Container: 'mkv' }] },
    { Id: 'E1', SeriesName: 'The Boys', ParentIndexNumber: 1, IndexNumber: 1, Name: 'Pilot', MediaSources: [{ Path: '/tv/a.mkv', Size: 1000, Container: 'mkv' }] },
  ],
};

console.log('=== findSeries ===');
{
  const { fetchImpl, seen } = fakeServer({ '/Items': SERIES });
  const s = await findSeries('The Boys', { ...OPTS, fetchImpl });
  ok(s?.id === 'SER1' && s.name === 'The Boys', 'finds the series');
  ok(seen[0].includes('IncludeItemTypes=Series'), 'asks for Series, not Movie');
  ok(seen[0].includes('UserId=U1'), 'scopes to the user');
}
{
  const { fetchImpl } = fakeServer({ '/Items': { Items: [] } });
  ok(await findSeries('Nope', { ...OPTS, fetchImpl }) === null, 'no match -> null');
}
{
  // the fuzzy matcher is used when supplied
  const { fetchImpl } = fakeServer({ '/Items': SERIES });
  let sawThreshold = null;
  const bestMatch = (q, items, o) => { sawThreshold = o.threshold; return { item: items[0], score: 0.9 }; };
  const s = await findSeries('the boyz', { ...OPTS, fetchImpl, bestMatch });
  ok(s?.name === 'The Boys', 'fuzzy match corrects a misspelling');
  ok(typeof sawThreshold === 'number', 'passes a threshold to the matcher');
}

console.log('=== listSeasons ===');
{
  const { fetchImpl, seen } = fakeServer({ '/Seasons': SEASONS });
  const s = await listSeasons('SER1', { ...OPTS, fetchImpl });
  ok(s.length === 2 && s[0].season === 1, 'lists seasons in order');
  ok(seen[0].includes('/Shows/SER1/Seasons'), 'uses the Shows/{id}/Seasons endpoint');
}
{
  // specials with no index number must not break ordering
  const { fetchImpl } = fakeServer({ '/Seasons': { Items: [{ Id: 'X', IndexNumber: null }, { Id: 'S1', IndexNumber: 1 }] } });
  const s = await listSeasons('SER1', { ...OPTS, fetchImpl });
  ok(s.length === 1 && s[0].season === 1, 'seasons without a number are skipped');
}

console.log('=== listEpisodes ===');
{
  const { fetchImpl, seen } = fakeServer({ '/Episodes': EPISODES });
  const eps = await listEpisodes('SER1', { ...OPTS, season: 1, fetchImpl });
  ok(eps.length === 2, 'returns the episodes');
  ok(seen[0].includes('season=1'), 'filters by season server-side');
  ok(seen[0].includes('Fields=Path%2CMediaSources%2COverview') || seen[0].includes('Fields=Path,MediaSources'), 'requests the fields needed for download + naming');
  const e = eps.find((x) => x.episode === 1);
  ok(e.series === 'The Boys' && e.season === 1 && e.title === 'Pilot', 'maps metadata for the filename');
  ok(e.localPath === '/tv/a.mkv' && e.size === 1000, 'maps the media source');
}

console.log('=== resolveEpisodes: one specific episode ===');
{
  const { fetchImpl } = fakeServer({ '/Items': SERIES, '/Seasons': SEASONS, '/Episodes': EPISODES });
  const r = await resolveEpisodes(parseTvRequest('The Boys S01E01'), { ...OPTS, fetchImpl });
  ok(r.error === null, 'resolves cleanly');
  ok(r.episodes.length === 1 && r.episodes[0].episode === 1, 'exactly the one episode asked for');
  ok(episodeFileName(r.episodes[0]) === 'The Boys S01E01 Pilot.mp4', 'produces the agreed filename');
}

console.log('=== resolveEpisodes: a whole season, in order ===');
{
  const { fetchImpl } = fakeServer({ '/Items': SERIES, '/Seasons': SEASONS, '/Episodes': EPISODES });
  const r = await resolveEpisodes(parseTvRequest('The Boys season 1'), { ...OPTS, fetchImpl });
  ok(r.episodes.length === 2, 'every episode of the season');
  ok(r.episodes[0].episode === 1 && r.episodes[1].episode === 2, 'sorted into broadcast order (the fixture was reversed)');
}

console.log('=== resolveEpisodes: the cases that must NOT dump a whole series ===');
{
  const { fetchImpl } = fakeServer({ '/Items': SERIES, '/Seasons': SEASONS, '/Episodes': EPISODES });
  const r = await resolveEpisodes(parseTvRequest('The Boys'), { ...OPTS, fetchImpl });
  ok(r.error === 'need-season', 'a bare show name asks which season instead of sending everything');
  ok(r.episodes.length === 0, 'nothing queued');
  ok(Array.isArray(r.seasons) && r.seasons.includes(2), 'reports the available seasons so the user can choose');
}
{
  const { fetchImpl } = fakeServer({ '/Items': { Items: [] } });
  const r = await resolveEpisodes(parseTvRequest('Nonexistent Show S01E01'), { ...OPTS, fetchImpl });
  ok(r.error === 'not-found', 'unknown series reported');
}
{
  const { fetchImpl } = fakeServer({ '/Items': SERIES, '/Seasons': SEASONS, '/Episodes': EPISODES });
  const r = await resolveEpisodes(parseTvRequest('The Boys S01E99'), { ...OPTS, fetchImpl });
  ok(r.error === 'no-such-episode', 'a missing episode is reported, not silently empty');
}

console.log('=== "episode 5" with no season ===');
{
  // one season -> safe to assume
  const one = fakeServer({ '/Items': SERIES, '/Seasons': { Items: [{ Id: 'S1', IndexNumber: 1 }] }, '/Episodes': EPISODES });
  const r = await resolveEpisodes(parseTvRequest('The Boys episode 2'), { ...OPTS, fetchImpl: one.fetchImpl });
  ok(r.error === null && r.episodes[0]?.episode === 2, 'single-season show: the season is inferred');

  // several seasons -> must ask
  const many = fakeServer({ '/Items': SERIES, '/Seasons': SEASONS, '/Episodes': EPISODES });
  const r2 = await resolveEpisodes(parseTvRequest('The Boys episode 2'), { ...OPTS, fetchImpl: many.fetchImpl });
  ok(r2.error === 'need-season', 'multi-season show: asks which season rather than guessing');
}

console.log('=== download url ===');
{
  const { url, headers } = episodeDownloadUrl('E1', OPTS);
  ok(url.includes('/Items/E1/Download'), 'per-episode download endpoint');
  ok(url.includes('api_key=TOK'), 'token in the query so it survives redirects');
  ok(headers['X-Emby-Token'] === 'TOK', 'and in the header');
}

console.log('=== server errors surface ===');
{
  const fetchImpl = async () => ({ ok: false, status: 500, statusText: 'Boom', json: async () => ({}) });
  let threw = null;
  try { await findSeries('X', { ...OPTS, fetchImpl }); } catch (e) { threw = e; }
  ok(!!threw && /500/.test(threw.message), 'HTTP failures throw with the status');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
