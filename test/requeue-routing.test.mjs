/* The portal queue box must accept TV as well as movies.
   Run: node test/requeue-routing.test.mjs

   Regression: typing "rick and Morty season 4" answered 'No match' — /requeue
   only ever called the movie plugin, so a season request was sent to OMDb. */
import { parseTvRequest } from '../src/plugins/tv-requests/parse.js';
import tvPlugin from '../src/plugins/tv-requests/index.js';
import { parseMediaUrl, urlToRequestText } from '../src/util/media-url.js';
import express from 'express';
import http from 'node:http';
import { JobQueue } from '../src/core/queue.js';
import { createApiRouter } from '../src/web/api.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

console.log('=== what counts as a TV request in the queue box ===');
{
  const isTv = (t) => { const p = parseTvRequest(t); return p.season != null || p.episode != null; };
  for (const t of ['rick and Morty season 4', 'Rick and Morty S04E01', 'The Boys season 1',
                   'Breaking Bad S05E14', 'The Office 2x05', 'Rick and Morty season 4 episode 2']) {
    ok(isTv(t), `"${t}" routes to TV`);
  }
  for (const t of ['The Truman Show 1998', 'Dune 2021', 'Rick and Morty', 'Interstellar', '24']) {
    ok(!isTv(t), `"${t}" routes to movies (a bare name is indistinguishable from a film)`);
  }
}

/* ------------------------- the TV requeue itself ------------------------ */
const SERIES = { Items: [{ Id: 'S1', Name: 'Rick and Morty', ProductionYear: 2013, OfficialRating: 'TV-14' }] };
const SEASONS = { Items: [{ Id: 'X', IndexNumber: 4 }] };
const EPISODES = {
  Items: [
    { Id: 'E2', SeriesName: 'Rick and Morty', ParentIndexNumber: 4, IndexNumber: 2, Name: 'B', MediaSources: [{ Path: '/b.mkv' }] },
    { Id: 'E1', SeriesName: 'Rick and Morty', ParentIndexNumber: 4, IndexNumber: 1, Name: 'A', MediaSources: [{ Path: '/a.mkv' }] },
  ],
};

function ctxFor(routes, tv = {}) {
  const queued = [];
  globalThis.fetch = async (url) => {
    for (const [k, v] of Object.entries(routes)) {
      if (String(url).includes(k)) return { ok: true, status: 200, json: async () => v };
    }
    return { ok: false, status: 404, statusText: 'NF', json: async () => ({}) };
  };
  return {
    queued,
    ctx: {
      config: {
        tvRequests: { enabled: true, postsGroups: ['posts@g.us'], blockedRatings: ['TV-MA'], ...tv },
        movieRequests: { reactions: {} },
        library: { jellyfin: { baseUrl: 'http://jf:8096', accessToken: 'T', userId: 'U' } },
        media: { workDir: '/tmp/x' },
      },
      queue: { add: (j) => queued.push(j) },
      log: { info() {}, warn() {}, error() {}, debug() {} },
      bot: { isConnected: () => true, sendText: async () => ({}) },
      // Every plugin ctx carries one (plugin-manager.js namespaces the state
      // store per plugin); a queued season is journalled through it so a
      // restart can replay it.
      store: (() => { const m = {}; return { get: (k, d) => (k in m ? m[k] : d), set: (k, v) => { m[k] = v; } }; })(),
    },
  };
}

console.log('=== a season queues every episode from the portal ===');
{
  const { ctx, queued } = ctxFor({ '/Items': SERIES, '/Seasons': SEASONS, '/Episodes': EPISODES });
  const r = await tvPlugin.requeue('rick and Morty season 4', ctx);
  ok(r.kind === 'tv', 'reports itself as a TV result');
  ok(r.series === 'Rick and Morty' && r.season === 4, 'resolved the show and season');
  ok(r.queued === 2 && queued.length === 2, 'queued both episodes');
  ok(queued[0].label === 'Rick and Morty S04E01', 'in broadcast order');
  ok(queued.every((j) => j.kind === 'tv'), 'marked kind:tv so movies keep priority');
  ok(queued[0].meta.requester === 'manual (admin)', 'attributed to the admin');
}

console.log('=== errors an admin can act on ===');
{
  const { ctx } = ctxFor({ '/Items': { Items: [] } });
  let err = null;
  try { await tvPlugin.requeue('Nonexistent season 1', ctx); } catch (e) { err = e; }
  ok(/No show matching/i.test(err?.message ?? ''), `unknown show: "${err?.message}"`);
}
{
  const { ctx } = ctxFor({ '/Items': SERIES, '/Seasons': { Items: [{ Id: 'a', IndexNumber: 1 }, { Id: 'b', IndexNumber: 2 }] }, '/Episodes': EPISODES });
  let err = null;
  try { await tvPlugin.requeue('Rick and Morty', ctx); } catch (e) { err = e; }
  ok(/Which season/i.test(err?.message ?? ''), 'a bare show name asks which season');
  ok(/1, 2/.test(err?.message ?? ''), 'and lists them');
}
{
  const blocked = { Items: [{ Id: 'S1', Name: 'Rick and Morty', OfficialRating: 'TV-MA' }] };
  const { ctx } = ctxFor({ '/Items': blocked, '/Seasons': SEASONS, '/Episodes': EPISODES });
  let err = null;
  try { await tvPlugin.requeue('Rick and Morty season 4', ctx); } catch (e) { err = e; }
  ok(/TV-MA/.test(err?.message ?? ''), 'a blocked rating is refused, with the reason');
}
{
  const { ctx } = ctxFor({ '/Items': SERIES, '/Seasons': SEASONS, '/Episodes': EPISODES }, { postsGroups: [] });
  let err = null;
  try { await tvPlugin.requeue('Rick and Morty season 4', ctx); } catch (e) { err = e; }
  ok(/posts group/i.test(err?.message ?? ''), 'missing posts group is named, not a generic failure');
}

console.log('=== a year in the name still resolves (the 📅 trap) ===');
{
  const { ctx, queued } = ctxFor({ '/Items': SERIES, '/Seasons': SEASONS, '/Episodes': EPISODES });
  const r = await tvPlugin.requeue('Rick and Morty 2013 season 4', ctx);
  ok(r.queued === 2, '"Rick and Morty 2013 season 4" still finds the show');
}

console.log('=== the API reports both reasons when neither section matches ===');
{
  const api = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8'));
  const block = api.match(/router\.post\('\/requeue'[\s\S]*?\n  \}\);/)[0];
  ok(/looksLikeTv/.test(block), 'the route detects a TV-shaped request');
  ok(/TV section is off/.test(block), 'explains when TV is disabled rather than saying "no match"');
  ok(/· TV: \$\{tvErr\.message\}/.test(block), 'a double failure reports the TV reason too');
  ok(block.indexOf('looksLikeTv') < block.indexOf('tryMovie()'), 'an explicit season/episode goes straight to TV');
}

console.log('=== pasted links (the box used to answer "No match") ===');
{
  const cases = [
    ['https://www.themoviedb.org/tv/60625-rick-and-morty/season/4', 'Rick and Morty season 4'],
    ['https://www.themoviedb.org/tv/60625-rick-and-morty/season/4/episode/2', 'Rick and Morty S04E02'],
    ['https://www.themoviedb.org/tv/60625-rick-and-morty', 'Rick and Morty'],
    ['https://www.themoviedb.org/movie/693134-dune-part-two', 'Dune Part Two'],
    ['https://trakt.tv/shows/the-boys/seasons/1', 'The Boys season 1'],
    ['https://www.themoviedb.org/tv/1396-breaking-bad/season/5/episode/14', 'Breaking Bad S05E14'],
  ];
  for (const [url, want] of cases) {
    ok(urlToRequestText(url) === want, `${url.replace('https://www.', '').slice(0, 44)} -> "${want}"`);
  }
  // and the rewritten text routes correctly afterwards
  const t = parseTvRequest(urlToRequestText(cases[0][0]));
  ok(t.show === 'Rick and Morty' && t.season === 4, 'the rewritten text parses back to show + season');
}

console.log('=== links that carry no title ===');
{
  const imdb = parseMediaUrl('https://www.imdb.com/title/tt2861424/');
  ok(imdb?.imdbId === 'tt2861424', 'an IMDb id is extracted for OMDb to resolve');
  ok(imdb.season === null, 'no bogus "season 0" when the URL has no season');
  ok(imdb.kind === null, 'IMDb URLs do not claim to be TV without evidence');
  const withSeason = parseMediaUrl('https://www.imdb.com/title/tt2861424/episodes?season=4');
  ok(withSeason.kind === 'tv' && withSeason.season === 4, 'an explicit ?season is honoured');
}

console.log('=== non-URLs and junk are left alone ===');
{
  ok(parseMediaUrl('rick and Morty season 4') === null, 'plain text is not a URL');
  ok(parseMediaUrl('') === null, 'empty is safe');
  ok(parseMediaUrl(null) === null, 'null is safe');
  ok(parseMediaUrl('https://example.com/whatever') === null, 'an unrelated site is not a media link');
  ok(parseMediaUrl('not a url at all') === null, 'garbage is safe');
  ok(parseMediaUrl('https://') === null, 'a malformed URL does not throw');
}

console.log('=== the route uses the rewritten text, not the raw URL ===');
{
  const api = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8'));
  const block = api.match(/router\.post\('\/requeue'[\s\S]*?\n  \}\);/)[0];
  ok(/parseMediaUrl\(text\)/.test(block), 'the route parses a pasted link');
  ok(/requeue\(query,/.test(block), 'plugins receive the resolved query');
  ok(!/requeue\(text,/.test(block), 'the raw URL is never passed through to a lookup');
  ok(/link\.imdbId/.test(block), 'an IMDb id is forwarded for OMDb to resolve');
}

console.log('=== the queue limit brakes the groups, not an admin adding one by hand ===');
{
  const q = new JobQueue({ concurrency: 1, maxLength: 2 });
  q.pause();
  q.add({ label: 'a', run: async () => {} });
  q.add({ label: 'b', run: async () => {} });
  ok(!q.hasRoom(1) && q.hasRoom(0), 'two waiting on a limit of two: no room');
  let err = null;
  try { q.add({ label: 'c', run: async () => {} }); } catch (e) { err = e; }
  ok(err?.code === 'QUEUE_FULL' && err.message === 'Queue is full (2 waiting)', 'a third is refused as before');
  ok(!!q.add({ label: 'c', run: async () => {} }, { overLimit: true }) && q.pending.length === 3, 'unless it is an admin\'s own add');
}

console.log('=== a season that does not fit is refused whole, before History or the journal ===');
{
  // A season is one request in the queue, however many episodes it holds
  // (test/queue-requests.test.mjs), so "does not fit" means no place at all.
  const { ctx, queued } = ctxFor({ '/Items?': SERIES, '/Shows/S1/Seasons': SEASONS, '/Shows/S1/Episodes': EPISODES });
  const asked = [];
  ctx.queue.hasRoom = (n) => { asked.push(n); return false; };
  ctx.queue.fullError = () => Object.assign(new Error('Queue is full (50 waiting)'), { code: 'QUEUE_FULL' });
  let err = null;
  try { await tvPlugin.requeue('Rick and Morty season 4', ctx); } catch (e) { err = e; }
  ok(err?.code === 'QUEUE_FULL' && queued.length === 0, `no place left: refused, none queued (${err?.message})`);
  ok(asked.join() === '1', `it asked for ONE place for two episodes (${asked.join()})`);
  ok(!ctx.store.get('pending', []).length && !ctx.store.get('history', []).length,
    'and neither a journal entry nor a History row claims the season');
  const r = await tvPlugin.requeue('Rick and Morty season 4', ctx, { overLimit: true });
  ok(r.queued === 2 && queued.length === 2, 'from the panel it goes in whole');
  ok(queued.every((j) => j.group && j.group === queued[0].group), 'as one request: both episodes carry the same group');
}
{
  const { ctx, queued } = ctxFor({ '/Items?': SERIES, '/Shows/S1/Seasons': SEASONS, '/Shows/S1/Episodes': EPISODES });
  ctx.queue.hasRoom = (n) => n <= 1;
  const r = await tvPlugin.requeue('Rick and Morty season 4', ctx);
  ok(r.queued === 2 && queued.length === 2, 'one place free is enough for the whole season');
}

console.log('=== the panel box asks TV only when the movie lookup found nothing ===');
{
  // "ready player one" was refused as "Queue is full (50 waiting) · TV: No show
  // matching "ready player one" in the library": every movie failure was
  // retried as TV, which read as the bot taking a film for a show.
  const calls = [];
  const plugins = new Map();
  let movieResult = null;
  plugins.set('movie-requests', { ctx: {}, plugin: { requeue: async (t, c, o) => { calls.push(['movie', o]); return movieResult(); } } });
  plugins.set('tv-requests', { ctx: {}, plugin: { requeue: async (t, c, o) => { calls.push(['tv', o]); throw new Error(`No show matching "${t}" in the library`); } } });
  const cfg = {
    web: { adminPasswordHash: 'x', users: [{ username: 'mommy', role: 'superadmin', passwordHash: 'x' }] },
    movieRequests: { requestGroups: [], maxQueueLength: 50, reactions: {} }, media: {}, tvRequests: { enabled: true },
    whatsapp: { accounts: [], failover: { enabled: false, order: [] } }, directLinks: {}, queue: {}, lockdown: {},
  };
  const queue = new JobQueue({ concurrency: 1, maxLength: 1 });
  queue.pause();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { username: 'mommy', role: 'superadmin' } }; next(); });
  app.use('/api', createApiRouter({
    configStore: { get: () => cfg, update: () => cfg, redacted: () => ({}), onChange: () => {} },
    bot: { groupCache: new Map(), groups: () => [], on: () => {}, state: 'connected' },
    queue, linkQueue: new JobQueue({ concurrency: 1 }),
    pluginManager: { plugins, notifyConfigChange: async () => {} },
    stateStore: { namespace: () => ({ get: (k, d) => d, set() {}, push() {} }) },
    fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {},
  }));
  const server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  const post = (text) => new Promise((resolve, reject) => {
    const data = JSON.stringify({ text });
    const rq = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/api/requeue',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
    });
    rq.on('error', reject); rq.end(data);
  });
  const coded = (msg, code) => () => { throw Object.assign(new Error(msg), code ? { code } : {}); };

  movieResult = coded('Queue is full (50 waiting)', 'QUEUE_FULL');
  calls.length = 0;
  let r = await post('ready player one');
  ok(r.body.error === 'Queue is full (50 waiting)' && !calls.some(([k]) => k === 'tv'), `a full queue is the answer, TV is not asked: "${r.body.error}"`);
  ok(calls[0]?.[1]?.overLimit === true, 'and the panel asks for its add to go past the limit');

  movieResult = coded('Ready Player One is rated R (blocked)');
  calls.length = 0;
  r = await post('ready player one');
  ok(r.body.error === 'Ready Player One is rated R (blocked)' && !calls.some(([k]) => k === 'tv'), 'nor for a film found and refused');

  for (const code of ['NO_MATCH', 'NOT_IN_LIBRARY']) {
    movieResult = coded('No match for "rick and morty"', code);
    calls.length = 0;
    r = await post('rick and morty');
    ok(calls.map(([k]) => k).join() === 'movie,tv' && / · TV: No show matching/.test(r.body.error), `${code}: TV is asked, and both reasons are shown`);
  }

  // Episodes with no season, listed one after another, are a run once lists
  // are read: "The Office episode 3 and 4" was one episode to the box before
  // that, and went to TV; as a run it went to the film lookup first, and a
  // film of the same name would have been queued instead - Fullmetal
  // Alchemist (2017) for "Fullmetal alchemist E14, E15" (found in review,
  // 2026-10-12). History's Re-run posts here too.
  movieResult = () => ({ title: 'Fullmetal Alchemist', year: 2017 });
  for (const text of ['The Office episode 3 and 4', 'The Office ep 3, 4', 'Fullmetal alchemist E14 E15',
    'Fullmetal alchemist E14, E15', 'The Office episodes 3-6', 'Fullmetal alchemist E14, E16']) {
    calls.length = 0;
    await post(text);
    ok(calls.map(([k]) => k).join() === 'tv', `"${text}" goes to TV, and never to the film lookup (${calls.map(([k]) => k).join()})`);
  }

  queue.add({ label: 'x', run: async () => {} });
  queue.add({ label: 'y', run: async () => {} }, { overLimit: true });
  movieResult = () => ({ title: 'Ready Player One', year: 2018 });
  r = await post('ready player one');
  ok(r.body.ok && r.body.overLimit === true && r.body.limit === 1, 'a queue past its limit is reported, so the toast can say so');
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
