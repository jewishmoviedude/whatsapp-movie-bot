/* The wanted list is checked against the library, and what has arrived comes off it.
   Run: node test/wanted-recheck.test.mjs

   Incident: on 2026-10-11 the panel's "Wanted - asked for, not on the server"
   held eleven films, and seven were on the server. "X2: X-Men United" (2003),
   asked for twice on 2026-10-07, is held as "X2"; the lookup was fixed that
   day (bf22f1c, e55f92a), but an entry left the list only when somebody asked
   again and the film was found, and nobody did. "Harry Potter and the
   Sorcerer's Stone" is held as "...the Philosopher's Stone" under its IMDb id;
   "Guardians of the Galaxy: Vol. 2" had been queued by hand from the panel,
   which clears nothing. Nothing ever looked again. And "2 Broke Girls: Season
   2 - 2 Broke Girls at PaleyFest 2013", a DVD extra OMDb answered "2 broke
   girls season 2" with, sat on the list as a film.

   Pinned here (src/core/wanted-recheck.js):
   - every open entry is looked up with its title, year, IMDb id and the
     words its requesters typed (from the entry, or for an older one, from its
     not-in-library row), and the ones the library has are marked resolved by
     'the bot (found on the server as "X2")' - not deleted, so the admins see
     it (the operator, 2026-10-11: "mark as resolved so other admins and you
     know") - their not-in-library rows marked answered, each said as "X2:
     X-Men United (2003) is on the server now (as "X2") - marked resolved on
     the wanted list";
   - an entry already resolved, by an admin or an earlier run, is not looked
     up again, and one resolved over 30 days ago is pruned by the run;
   - an entry asked for as a season of a show comes off without a lookup;
   - a copy from another year, or with another IMDb id, leaves the entry on;
   - one lookup at a time, paced; a lookup that fails leaves its entry on and
     the rest go on; nothing throws, whatever breaks;
   - the timer runs it after start and then on its interval, one run at a time;
   - POST /api/wanted/recheck runs it, answers what changed and audits it;
   - with the real findInLibrary and a stubbed Jellyfin, the X2 entry is found
     as "X2";
   - it is registered as the in-process routine 'wanted-recheck'. */
import express from 'express';
import http from 'node:http';
import {
  recheckWanted, WantedRecheck, describeFound, describeNotFilm, notTheFilm, EVERY_MS,
} from '../src/core/wanted-recheck.js';
import { recordWanted, wantedKey } from '../src/core/wanted.js';
import { missKey } from '../src/core/library-misses.js';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import { byId } from '../src/core/routines.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const LIBRARY = mergeDefaults({ provider: 'jellyfin', jellyfin: { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'KEY', userId: 'U1' } }, DEFAULT_CONFIG.library);

/* ------------------------------ fixtures ------------------------------ */

const entry = (title, year, imdbId, extra = {}) => ({
  key: imdbId, title, year, imdbId, rated: 'PG', reason: 'not-in-library', count: 1,
  firstAt: 1789000000000, lastAt: 1789000000000, requesters: ['A member'], ...extra,
});
const miss = (title, year, request) => ({
  key: missKey({ kind: 'movie', title, year }), kind: 'movie', reason: 'not-in-library', request, title, year,
  season: null, episode: null, count: 1, requesters: ['A member'], resolved: false,
});
// The list as it stood on 2026-10-11, recorded before entries kept what was typed.
const LIST = () => [
  entry('Stars Fell on Alabama', 2021, 'tt10712928'),
  entry('X2: X-Men United', 2003, 'tt0290334', { count: 2 }),
  entry("Harry Potter and the Sorcerer's Stone", 2001, 'tt0241527'),
  entry('2 Broke Girls: Season 2 - 2 Broke Girls at PaleyFest 2013', 2013, 'tt8259160', { rated: null }),
  entry('Guardians of the Galaxy: Vol. 2', 2017, 'tt3896198'),
];
const MISSES = () => [
  miss('X2: X-Men United', 2003, 'X2 2003'),
  miss("Harry Potter and the Sorcerer's Stone", 2001, 'Harry Potter the sorcerers stone'),
  miss('2 Broke Girls: Season 2 - 2 Broke Girls at PaleyFest 2013', 2013, '2 broke girls season 2'),
  miss('Guardians of the Galaxy: Vol. 2', 2017, 'guardians of the galaxy volume 2'),
];
// What the library holds, by IMDb id, as findInLibrary would answer.
const HELD = {
  tt0290334: { title: 'X2', year: 2003, imdbId: 'tt0290334' },
  tt0241527: { title: "Harry Potter and the Philosopher's Stone", year: 2001, imdbId: 'tt0241527' },
  tt3896198: { title: 'Guardians of the Galaxy Vol. 2', year: 2017, imdbId: 'tt3896198' },
};

function store(data = {}) {
  return { data, get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; }, push: (k, v) => { (data[k] ??= []).unshift(v); } };
}
function fakeFind({ held = HELD, throwFor = null, delayMs = 0 } = {}) {
  const calls = [];
  let inFlight = 0;
  const f = async (title, year, cfg, opts) => {
    calls.push({ title, year, cfg, ...opts });
    inFlight += 1;
    f.maxInFlight = Math.max(f.maxInFlight, inFlight);
    try {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (throwFor && opts.imdbId === throwFor) throw new Error('Jellyfin HTTP 502 Bad Gateway');
      return held[opts.imdbId] ?? null;
    } finally { inFlight -= 1; }
  };
  f.calls = calls;
  f.maxInFlight = 0;
  return f;
}
// What is still wanted: the entries not marked resolved.
const open = (s) => (s.data.wanted ?? []).filter((w) => !w.resolved);
const quiet = () => {
  const lines = [];
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(`WARN ${m}`), error: (m) => lines.push(`ERROR ${m}`), debug() {} };
};

/* ------------------------------ the incident ------------------------------ */

console.log('=== the list of 2026-10-11: what is on the server comes off it ===');
{
  const s = store({ wanted: LIST(), 'library-misses': MISSES() });
  const find = fakeFind();
  const waits = [];
  const r = await recheckWanted(s, { libraryCfg: LIBRARY, find, paceMs: 2000, wait: async (ms) => { waits.push(ms); }, log: quiet() });

  ok(r.checked === 5 && r.errors.length === 0, `all five looked at, no errors (${r.checked})`);
  ok(r.found.map((f) => f.title).join(' | ') === "X2: X-Men United | Harry Potter and the Sorcerer's Stone | Guardians of the Galaxy: Vol. 2",
    `the three on the server are found (${r.found.map((f) => f.title).join(' | ')})`);
  const x2 = r.found.find((f) => f.imdbId === 'tt0290334');
  ok(describeFound(x2) === 'X2: X-Men United (2003) is on the server now (as "X2") - marked resolved on the wanted list',
    `said as the operator reads it: ${describeFound(x2)}`);
  ok(x2.count === 2 && x2.requesters[0] === 'A member', 'with who asked, and how often');
  const left = open(s).map((w) => w.title);
  ok(left.length === 1 && left[0] === 'Stars Fell on Alabama', `only the film the server lacks stays open (${left.join(' | ')})`);
  const x2entry = s.data.wanted.find((w) => w.imdbId === 'tt0290334');
  ok(x2entry?.resolved?.by === 'the bot (found on the server as "X2")' && x2entry.resolved.auto === true
    && x2entry.resolved.as?.title === 'X2' && Number.isFinite(x2entry.resolved.at),
    `X2 is kept, marked resolved by the bot with what the library calls it (${x2entry?.resolved?.by})`);
  ok(s.data.wanted.find((w) => w.imdbId === 'tt0241527')?.resolved?.by
    === 'the bot (found on the server as "Harry Potter and the Philosopher\'s Stone")', 'and the Sorcerer\'s Stone the same');
  ok(s.data.wanted.length === 4, `nothing found is deleted: four entries kept, the PaleyFest extra gone (${s.data.wanted.length})`);
  ok(r.notFilms.length === 1 && r.notFilms[0].imdbId === 'tt8259160', 'the PaleyFest extra comes off as not a film');
  ok(describeNotFilm(r.notFilms[0]) === '2 Broke Girls: Season 2 - 2 Broke Girls at PaleyFest 2013 (2013) was asked for as '
    + '"2 broke girls season 2": season 2 of a show, not a film - off the wanted list', describeNotFilm(r.notFilms[0]));
  ok(!find.calls.some((c) => c.imdbId === 'tt8259160'), 'without a library lookup');

  const x2call = find.calls.find((c) => c.imdbId === 'tt0290334');
  ok(x2call?.title === 'X2: X-Men United' && x2call?.year === 2003 && x2call?.cfg === LIBRARY,
    'each is looked up by its title and year in the configured library');
  ok(JSON.stringify(x2call?.alsoTry) === '["X2 2003"]', `with what was typed, from its not-in-library row (${JSON.stringify(x2call?.alsoTry)})`);
  ok(x2call?.typedYear === 2003, 'and the year typed, as the request had it');
  ok(find.calls.find((c) => c.imdbId === 'tt0241527')?.alsoTry?.[0] === 'Harry Potter the sorcerers stone', 'and the others the same');

  const misses = s.data['library-misses'];
  ok(misses.find((m) => m.title === 'X2: X-Men United')?.resolved === true, 'X2\'s not-in-library row is marked answered');
  ok(misses.find((m) => m.title.startsWith('2 Broke Girls'))?.resolved === false, 'the PaleyFest row stays open: it was a fault');
  ok(find.maxInFlight === 1, 'one lookup at a time');
  ok(waits.length === find.calls.length - 1 && waits.every((ms) => ms === 2000), `paced between lookups (${waits.length} pauses)`);
}

console.log('=== an entry keeps what was typed, and the recheck uses it first ===');
{
  const s = store({ 'library-misses': [miss('X2: X-Men United', 2003, 'X2 2003')] });
  recordWanted(s, { title: 'X2: X-Men United', year: 2003, imdbId: 'tt0290334' }, { requester: 'A member', request: 'X2: X-Men United 2003' });
  recordWanted(s, { title: 'X2: X-Men United', year: 2003, imdbId: 'tt0290334' }, { requester: 'A member', request: 'x2' });
  ok(JSON.stringify(s.data.wanted[0].requests) === '["X2: X-Men United 2003","x2"]', `both wordings kept (${JSON.stringify(s.data.wanted[0].requests)})`);
  const find = fakeFind();
  await recheckWanted(s, { libraryCfg: LIBRARY, find, paceMs: 0, log: quiet() });
  ok(JSON.stringify(find.calls[0].alsoTry) === '["X2: X-Men United 2003","x2"]', 'and the lookup is given them');
  ok(!open(s).length, 'and it is found');
}

console.log('=== a resolved entry is not looked up again; a month after resolving it is pruned ===');
{
  const DAY = 86_400_000;
  const s = store({
    wanted: [
      entry('X2: X-Men United', 2003, 'tt0290334', { resolved: { by: 'mommy', at: Date.now() - 2 * DAY } }),
      entry('Guardians of the Galaxy: Vol. 2', 2017, 'tt3896198', { resolved: { by: 'the bot (found on the server as "Guardians")', at: Date.now() - 31 * DAY, auto: true } }),
      entry('Stars Fell on Alabama', 2021, 'tt10712928'),
    ],
  });
  const find = fakeFind();
  const r = await recheckWanted(s, { libraryCfg: LIBRARY, find, paceMs: 0, log: quiet() });
  ok(r.checked === 1 && find.calls.length === 1 && find.calls[0].imdbId === 'tt10712928', `only the open entry is looked up (${find.calls.map((c) => c.imdbId)})`);
  ok(s.data.wanted.find((w) => w.imdbId === 'tt0290334')?.resolved?.by === 'mommy', 'an admin\'s resolution is left as it was');

  const lg = quiet();
  const rc = new WantedRecheck({
    configStore: { get: () => ({ library: LIBRARY }), update() {} }, stateStore: { namespace: () => s }, log: lg, find: fakeFind(), paceMs: 0,
  });
  await rc.run('every 6 hours');
  ok(!s.data.wanted.some((w) => w.imdbId === 'tt3896198'), 'the run prunes what was resolved over 30 days ago');
  ok(s.data.wanted.some((w) => w.imdbId === 'tt0290334'), 'and keeps what was resolved two days ago');
  ok(lg.lines.some((l) => /1 entry resolved over 30 days ago dropped/.test(l)), 'and says so in the log');
}

console.log('=== another year, or another IMDb id, is not the film on the list ===');
{
  ok(notTheFilm({ year: 1984, imdbId: 'tt0087182' }, { title: 'Dune', year: 2021 }) === 'it is from 2021, not 1984', 'Dune (2021) is not Dune (1984)');
  ok(notTheFilm({ year: 2021, imdbId: 'tt1160419' }, { title: 'Dune', year: 2021, imdbId: 'tt0087182' }) === 'it is tt0087182, not tt1160419',
    'nor a copy carrying another id');
  ok(notTheFilm({ year: 2021, imdbId: 'tt1160419' }, { title: 'Dune', year: 2022 }) === null, 'a year off, with no id to say otherwise, is the film');
  const s = store({ wanted: [entry('Dune', 1984, 'tt0087182', { requests: ['dune 1984'] })] });
  const find = fakeFind({ held: { tt0087182: { title: 'Dune', year: 2021, imdbId: 'tt1160419' } } });
  const lg = quiet();
  const r = await recheckWanted(s, { libraryCfg: LIBRARY, find, paceMs: 0, log: lg });
  ok(r.found.length === 0 && s.data.wanted.length === 1, 'Dune (1984) stays on the list');
  ok(find.calls[0].typedYear === 1984, 'the year typed went to the lookup');
  ok(lg.lines.some((l) => /"Dune" \(2021\) is not Dune \(1984\)/.test(l)), 'and the log says why it stays');
}

console.log('=== a lookup that fails leaves its entry, and the rest go on ===');
{
  const s = store({ wanted: LIST(), 'library-misses': MISSES() });
  const find = fakeFind({ throwFor: 'tt0290334' });
  const lg = quiet();
  let threw = null;
  let r = null;
  try { r = await recheckWanted(s, { libraryCfg: LIBRARY, find, paceMs: 0, log: lg }); } catch (err) { threw = err; }
  ok(!threw, 'it does not throw');
  ok(r?.errors.length === 1 && r.errors[0].title === 'X2: X-Men United' && /502/.test(r.errors[0].error), 'the failure is reported');
  ok(open(s).some((w) => w.imdbId === 'tt0290334'), 'X2 stays on the list, open');
  ok(r?.found.length === 2, 'the others are still found');
  ok(lg.lines.some((l) => /^WARN wanted recheck: looking up X2: X-Men United \(2003\) failed - it stays on the list/.test(l)), 'and it is logged');
}

console.log('=== the bot\'s recheck: on a timer, one run at a time, never an exception ===');
{
  const ss = (data) => ({ namespace: (n) => (n === 'movie-requests' ? data : store()) });
  const cs = (library = LIBRARY) => ({ get: () => ({ library }), update() {} });

  const s = store({ wanted: LIST(), 'library-misses': MISSES() });
  const find = fakeFind({ delayMs: 5 });
  const lg = quiet();
  const rc = new WantedRecheck({ configStore: cs(), stateStore: ss(s), log: lg, find, paceMs: 0 });
  const [a, b] = [rc.run('on demand'), rc.run('on demand')];
  ok(a === b, 'a second ask while one runs joins it');
  const r = await a;
  ok(find.calls.length === 4 && r.found.length === 3 && r.notFilms.length === 1, `one run: ${find.calls.length} lookups`);
  ok(lg.lines.includes('X2: X-Men United (2003) is on the server now (as "X2") - marked resolved on the wanted list'), 'each one found is logged');
  ok(lg.lines.some((l) => /^wanted recheck \(on demand\): 3 of 5 on the server now, 1 asked for a show$/.test(l)), 'and the run summed up');
  ok(!rc.running, 'and it is over');

  const broken = new WantedRecheck({ configStore: { get: () => { throw new Error('config unreadable'); } }, stateStore: ss(store()), log: quiet(), find });
  const br = await broken.run('every 6 hours');
  ok(br.error === 'config unreadable', 'a run that breaks resolves with the error, never rejects');

  const none = new WantedRecheck({ configStore: cs({ provider: 'jellyfin', jellyfin: {} }), stateStore: ss(store({ wanted: LIST() })), log: quiet(), find: fakeFind() });
  ok(/not configured/.test((await none.run()).skipped ?? ''), 'with no library set up it skips, and says why');

  const t = store({ wanted: LIST(), 'library-misses': MISSES() });
  const timed = fakeFind();
  const tick = new WantedRecheck({ configStore: cs(), stateStore: ss(t), log: quiet(), find: timed, paceMs: 0, firstAfterMs: 5, everyMs: 40 });
  // Waits for a condition rather than a fixed time, so a slow box does not fail it.
  const until = async (cond, ms = 3000) => {
    for (const end = Date.now() + ms; !cond() && Date.now() < end;) await new Promise((r2) => setTimeout(r2, 5));
    return cond();
  };
  // X2 on the list again, open: as if it had been cleared and asked for anew.
  const x2Again = () => { t.data.wanted = [...t.data.wanted.filter((w) => w.imdbId !== 'tt0290334'), entry('X2: X-Men United', 2003, 'tt0290334')]; };
  const x2Open = () => open(t).some((w) => w.imdbId === 'tt0290334');
  tick.start();
  tick.start();
  await until(() => open(t).length === 1 && !tick.running);
  ok(timed.calls.length >= 4 && open(t).length === 1, `it runs by itself shortly after start (${timed.calls.length} lookups)`);
  x2Again();
  await until(() => !x2Open());
  ok(!x2Open(), 'and again on its interval');
  tick.stop();
  x2Again();
  await new Promise((r2) => setTimeout(r2, 60));
  ok(x2Open(), 'and not once stopped');
  // Six hours until 2026-10-11: "A Snapshot of Forever" was on the server
  // from 03:14 UTC and the next run was hours away (wanted-arrival.js).
  ok(EVERY_MS === 30 * 60_000, 'the bot\'s interval is 30 minutes');

  // Told after each run, for the arrival re-runs; not awaited by the run.
  const told = [];
  const hooked = new WantedRecheck({
    configStore: cs(), stateStore: ss(store({ wanted: LIST(), 'library-misses': MISSES() })), log: quiet(), find: fakeFind(), paceMs: 0,
    onRun: (r) => { told.push(r); },
  });
  const done = await hooked.run('on demand');
  await new Promise((r2) => setTimeout(r2, 5));
  ok(told.length === 1 && told[0] === done && done.found.length === 3, 'onRun is told of each run, with what it found');
}

console.log('=== POST /api/wanted/recheck ===');
{
  const data = { wanted: LIST(), 'library-misses': MISSES() };
  const spaces = new Map([['movie-requests', store(data)]]);
  const stateStore = { namespace: (n) => { if (!spaces.has(n)) spaces.set(n, store()); return spaces.get(n); } };
  let library = LIBRARY;
  const configStore = {
    get: () => ({
      web: { adminPasswordHash: 'x', users: [{ username: 'admin', role: 'superadmin', passwordHash: 'x' }] },
      movieRequests: { requestGroups: [], reactions: {} }, media: { concurrency: 1 }, library,
      whatsapp: { accounts: [], failover: {} }, tvRequests: {}, directLinks: {}, queue: {}, lockdown: {},
    }),
    update() {}, redacted: () => ({}), onChange() {},
  };
  const recheck = new WantedRecheck({ configStore, stateStore, log: quiet(), find: fakeFind(), paceMs: 0 });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { username: 'mommy', role: 'superadmin' } }; next(); });
  const queue = new JobQueue({ concurrency: 1 });
  queue.pause();
  app.use('/api', createApiRouter({
    configStore, bot: { groupCache: new Map(), groups: () => [], on: () => {}, state: 'connected' }, queue, linkQueue: queue,
    pluginManager: { plugins: new Map(), notifyConfigChange: async () => {} }, stateStore, fileLogger: { tail: () => [] },
    alerts: {}, lockScheduler: {}, wantedRecheck: recheck,
  }));
  const server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  const call = (method, p) => new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    rq.on('error', reject);
    rq.end();
  });
  const audit = () => stateStore.namespace('audit').get('events', []);

  const res = await call('POST', '/api/wanted/recheck');
  ok(res.status === 200 && res.body.ok === true, `answered (${res.status})`);
  ok(res.body.found.length === 3 && res.body.found[0].as.title === 'X2', 'with what was found, and what the library calls it');
  ok(res.body.notFilms.length === 1 && res.body.checked === 5 && res.body.wanted === 1, 'and what else changed, and what is left');
  const list = await call('GET', '/api/wanted');
  ok(list.body.wanted.length === 1 && list.body.wanted[0].key === wantedKey({ imdbId: 'tt10712928' }), 'the panel\'s list now holds only the missing film');
  ok(list.body.resolved.length === 3 && list.body.resolved.every((w) => /^the bot \(found on the server as "/.test(w.resolved.by)),
    'and the three found are under Resolved, by the bot');
  const rows = audit();
  ok(rows.length === 1 && rows[0].action === 'rechecked the wanted list: 3 of 5 on the server now, 1 asked for a show' && rows[0].user === 'mommy',
    `one audit row, attributed (${rows[0]?.action})`);
  ok(/X2: X-Men United \(2003\) is on the server now \(as "X2"\)/.test(rows[0]?.detail ?? ''), 'naming what came off');

  library = { provider: 'jellyfin', jellyfin: {} };
  const skipped = await call('POST', '/api/wanted/recheck');
  ok(skipped.status === 409 && /not configured/.test(skipped.body.error), 'with no library: 409, and why');
  ok(audit()[0].action === 'rechecked the wanted list - it could not run', 'audited as such');
  server.close();
}

console.log('=== the real lookup finds X2 as "X2" ===');
{
  const { forgetProviderFilterSupport } = await import('../src/plugins/movie-requests/library.js');
  forgetProviderFilterSupport();
  const LIB = [
    { Id: 'a'.repeat(32), Name: 'F/X2', ProductionYear: 1991, OfficialRating: 'PG-13', Type: 'Movie', ProviderIds: { Imdb: 'tt0101846' } },
    { Id: 'b'.repeat(32), Name: 'X2', ProductionYear: 2003, OfficialRating: 'PG-13', Type: 'Movie', ProviderIds: { Imdb: 'tt0290334' } },
  ];
  const norm = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const prev = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    const term = u.searchParams.get('searchTerm');
    const items = u.pathname === '/Items' && u.searchParams.get('IncludeItemTypes') === 'Movie'
      ? (term ? LIB.filter((i) => norm(i.Name).includes(norm(term))) : (u.searchParams.has('AnyProviderIdEquals') ? LIB : []))
      : [];
    return new Response(JSON.stringify({ Items: items, TotalRecordCount: items.length }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const s = store({ wanted: [entry('X2: X-Men United', 2003, 'tt0290334', { count: 2 })] });
  const r = await recheckWanted(s, { libraryCfg: LIBRARY, paceMs: 0, log: quiet() });
  globalThis.fetch = prev;
  ok(r.found.length === 1 && r.found[0].as.title === 'X2' && r.found[0].as.year === 2003, `found as "X2" (${r.found[0]?.as?.title})`);
  ok(!open(s).length && s.data.wanted[0]?.resolved?.by === 'the bot (found on the server as "X2")', 'and marked resolved, off the open list');
}

console.log('=== a routine of the bot\'s own ===');
{
  const rt = byId('wanted-recheck');
  ok(rt?.scope === 'in-process' && rt.bootstrap === false, 'registered in routines.js, inside the bot');
  ok(rt?.code?.some((c) => c.file === 'src/index.js' && c.contains === 'wantedRecheck.start()'), 'started from src/index.js');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
