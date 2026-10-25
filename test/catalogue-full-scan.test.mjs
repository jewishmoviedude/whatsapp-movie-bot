/* The catalogue walks the WHOLE library, past Jellyfin's 10,000-result window.
   Run: node test/catalogue-full-scan.test.mjs

   The list committed on 2026-09-09 held 5,152 clean titles out of exactly
   10,000 scanned, and ended at "The Jurassic Games": nothing from K to Z, so
   Venom, Knives Out, Suicide Squad and Ocean's Eleven - all delivered that
   month - were missing, and nothing said so. The server reports 20,796 movies
   but serves no result past the 10,000th (StartIndex 9990 returned 10 items,
   10000 returned none); the walk took that empty page for the end.

   The emulated server below behaves the same way: an accurate
   TotalRecordCount, results cut off at index 10,000 of any one query, a sort
   order that ignores spaces, and NameStartsWithOrGreater to start a query
   part-way through. No real Jellyfin is contacted. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { scanLibrary, cleanTitle, formatCatalogue } from '../src/core/catalogue.js';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const BLOCKED = ['R', 'NC-17', 'X', 'TV-MA'];
const RATINGS = ['G', 'PG', 'PG-13', 'R', null];

/** A library of `n` films. Some names differ only by a space, as "Junglee" and "Jungle Fever" do. */
function makeLibrary(n) {
  return Array.from({ length: n }, (_, i) => {
    const word = `w${String(i).padStart(5, '0')}`;
    const name = i % 7 === 0 ? `${word.slice(0, 3)} ${word.slice(3)} fever` : `${word} film`;
    return { Id: `id${i}`, Name: name, SortName: name.toLowerCase(), ProductionYear: 1950 + (i % 70),
             OfficialRating: RATINGS[i % RATINGS.length] };
  });
}

/**
 * A Jellyfin that will not go past `cap` results in any one query.
 * @param filter 'same' - NameStartsWithOrGreater uses the sort order's own
 *   collation; 'binary' - it compares plain strings while the ORDER BY ignores
 *   spaces; 'ignored' - the parameter does nothing.
 */
function makeServer(items, { cap = 10_000, filter = 'same', reportTotal = (n) => n, onRequest = null } = {}) {
  const key = (s) => s.replace(/\s+/g, '');
  const order = (a, b) => key(a.SortName).localeCompare(key(b.SortName))
    || a.SortName.localeCompare(b.SortName) || String(a.Id).localeCompare(String(b.Id));
  let sorted = [...items].sort(order);
  const stats = { requests: 0, inFlight: 0, maxInFlight: 0 };
  const add = (more) => { sorted = [...sorted, ...more].sort(order); };
  async function query(start, limit, { nameStartsWithOrGreater: cursor = null } = {}) {
    stats.requests += 1;
    onRequest?.(stats.requests, { add });
    stats.inFlight += 1;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    await new Promise((r) => setImmediate(r));
    let rows = sorted;
    if (cursor !== null && filter === 'same') rows = rows.filter((it) => key(it.SortName).localeCompare(key(cursor)) >= 0);
    if (cursor !== null && filter === 'binary') rows = rows.filter((it) => it.SortName >= cursor);
    const end = Math.min(start + limit, cap);
    stats.inFlight -= 1;
    return { items: start < end ? rows.slice(start, end) : [], total: reportTotal(rows.length) };
  }
  return { query, stats, get sorted() { return sorted; } };
}

const quick = { blocked: BLOCKED, delayMs: 0 };
const expectedClean = (items) => items.filter((it) => it.OfficialRating && !BLOCKED.includes(it.OfficialRating)).length;

console.log('=== the server really does stop at 10,000 (the incident) ===');
{
  const lib = makeLibrary(20_796);
  const { query } = makeServer(lib);
  const edge = await query(9990, 20);
  const past = await query(10_000, 20);
  ok(edge.items.length === 10 && past.items.length === 0 && past.total === 20_796,
    'StartIndex 9990 gives 10 items, 10000 gives none, while the count says 20,796');
}

console.log('=== a 20,796-film library is read to the end ===');
{
  const lib = makeLibrary(20_796);
  const server = makeServer(lib);
  const res = await scanLibrary(server.query, quick);
  ok(res.scanned === 20_796, `every film read once (${res.scanned})`);
  ok(res.total === 20_796 && res.complete === true, 'and the walk knows it is complete');
  ok(res.windows >= 3, `it needed more than one window (${res.windows})`);
  ok(res.clean.length === expectedClean(lib), `the clean count is right (${res.clean.length})`);
  const last = server.sorted.filter((it) => it.OfficialRating === 'G').at(-1);
  ok(res.clean.some((m) => m.title === last.Name), `the last title in the library is in the list ("${last.Name}")`);
  ok(server.stats.maxInFlight === 1, 'one request at a time');
}

console.log('=== a name filter that disagrees with the sort order is caught ===');
{
  const lib = makeLibrary(20_796);
  const res = await scanLibrary(makeServer(lib, { filter: 'binary' }).query, quick);
  // A filter that disagrees with the order can drop films far from any seam,
  // which no overlap can catch. What matters is that the walk then says so.
  // (The real server's filter matches its order: a window started at "jungle
  // fever" began at Jungle Fever, left out "Junglee", and counted exactly the
  // 10,797 films remaining.)
  ok(res.complete === false || res.scanned === 20_796,
    'it is either complete with every film, or it says it is not - never "complete" with gaps');
  ok(res.complete === true || /never served/.test(res.stopped ?? ''),
    `and a shortfall names itself ("${res.stopped ?? 'complete'}", ${res.scanned} read)`);
}

console.log('=== a server that ignores the cursor is caught, not trusted ===');
{
  const lib = makeLibrary(20_796);
  const res = await scanLibrary(makeServer(lib, { filter: 'ignored' }).query, quick);
  ok(res.complete === false, 'the walk reports itself incomplete');
  ok(res.scanned === 10_000, `having read what it could (${res.scanned})`);
  ok(/no new films/.test(res.stopped ?? ''), `and says why ("${res.stopped}")`);
}

console.log('=== a library under the window is a single plain walk ===');
{
  const lib = makeLibrary(450);
  const server = makeServer(lib);
  const res = await scanLibrary(server.query, quick);
  ok(res.scanned === 450 && res.complete === true && res.windows === 1, 'one window, complete');
  ok(server.stats.requests === 4, `three pages of 200, then one recount (${server.stats.requests})`);
}

console.log('=== paging is polite ===');
{
  const server = makeServer(makeLibrary(1_000));
  const waits = [];
  await scanLibrary(server.query, { blocked: BLOCKED, delayMs: 150, sleep: async (ms) => { waits.push(ms); } });
  ok(waits.length === server.stats.requests - 1, `a pause before every request but the first (${waits.length} for ${server.stats.requests})`);
  ok(waits.every((ms) => ms === 150), 'of the configured length');
}

console.log('=== a server that never stops is stopped, and flagged ===');
{
  const endless = (total) => {
    let n = 0;
    return async (start, limit) => ({
      items: Array.from({ length: limit }, () => {
        n += 1;
        return { Id: `x${n}`, Name: `x${n}`, SortName: `x${String(n).padStart(9, '0')}`, OfficialRating: 'G' };
      }),
      total,
    });
  };
  const counted = await scanLibrary(endless(1_000), quick);
  ok(counted.scanned === 1_000 && counted.requests === 6, `with a count, it stops at the count: 5 pages and a recount (${counted.requests} requests)`);
  const uncounted = await scanLibrary(endless(null), quick);
  ok(uncounted.complete === false && /request limit/.test(uncounted.stopped ?? ''),
    `without one, the request limit stops it and says so ("${uncounted.stopped}")`);
  ok(uncounted.requests < 1_000, `bounded (${uncounted.requests} requests)`);
}

console.log('=== runs of identical sort names across the 10,000 seam ===');
{
  for (const run of [30, 2_000]) {
    const lib = makeLibrary(20_796);
    // Rename a stretch straddling index 10,000 to one sort name, as a
    // library with many copies of one film would have.
    const sorted = makeServer(lib).sorted;
    for (let i = 10_000 - Math.floor(run / 2); i < 10_000 + Math.ceil(run / 2); i++) {
      sorted[i].Name = 'Twin Film'; sorted[i].SortName = 'twin film';
    }
    const res = await scanLibrary(makeServer(lib).query, quick);
    ok(res.complete === true && res.scanned === 20_796, `a run of ${run} identical names is read completely (${res.scanned})`);
  }
}

console.log('=== a page size that does not divide the window ===');
{
  const res = await scanLibrary(makeServer(makeLibrary(20_796)).query, { ...quick, pageSize: 333 });
  ok(res.complete === true && res.scanned === 20_796, `pageSize 333 still reads everything (${res.requests} requests)`);
  const small = await scanLibrary(makeServer(makeLibrary(20_796)).query, { ...quick, pageSize: 50 });
  ok(small.complete === true, 'and a small page size is not cut off by the request limit');
}

console.log('=== a library that changes during the walk is not trusted ===');
{
  const lib = makeLibrary(20_796);
  const extra = makeLibrary(5).map((it, i) => ({ ...it, Id: `new${i}`, Name: `aaa new ${i}`, SortName: `aaa new ${i}` }));
  const server = makeServer(lib, { onRequest: (n, { add }) => { if (n === 30) add(extra); } });
  const res = await scanLibrary(server.query, quick);
  ok(res.complete === false && /changed during the walk \(20796 -> 20801/.test(res.stopped ?? ''),
    `five films added mid-walk are noticed ("${res.stopped}")`);
}

console.log('=== a server that serves more than it reports is not trusted ===');
{
  const res = await scanLibrary(makeServer(makeLibrary(500), { reportTotal: () => 0 }).query, quick);
  ok(res.complete === false && /served \d+ films but reports 0/.test(res.stopped ?? ''), `"${res.stopped}"`);
}

console.log('=== NR, Not Rated and Unrated count as unrated, as the bot says they are ===');
{
  const items = ['NR', 'Not Rated', 'Unrated', 'N/A', '', null, 'PG', 'R'].map((r, i) =>
    ({ Id: `u${i}`, Name: `U ${i}`, SortName: `u ${i}`, OfficialRating: r }));
  const { isUnrated } = await import('../src/plugins/movie-requests/theatrical.js');
  const res = await scanLibrary(async () => ({ items, total: items.length }), { ...quick, isUnrated });
  ok(res.clean.length === 1 && res.clean[0].rated === 'PG', `only the PG film is listed (${res.clean.map((c) => c.rated)})`);
  ok(res.skipped.unrated === 6 && res.skipped.blocked === 1, `6 unrated, 1 blocked (${JSON.stringify(res.skipped)})`);
  const md = formatCatalogue(res, { blocked: BLOCKED, blockUnrated: false });
  ok(/still sends unrated films/.test(md), 'and the file says the bot itself still sends them while "block unrated" is off');
}

console.log('=== items without an Id are not counted twice at a seam ===');
{
  // The emulator needs ids to order ties; the pager strips them before the walk sees the items.
  const server = makeServer(makeLibrary(20_796));
  const idless = async (s, l, o) => {
    const r = await server.query(s, l, o);
    return { ...r, items: r.items.map(({ Id, ...rest }) => rest) };
  };
  const res = await scanLibrary(idless, quick);
  ok(res.scanned === 20_796 && res.complete === true, `the overlap is recognised by name and year (${res.scanned})`);
}

console.log('=== a dropped connection costs a retry, not the walk ===');
{
  const server = makeServer(makeLibrary(1_000));
  let failures = 2;
  // The second page fails twice, then answers.
  let calls = 0;
  const flaky = async (...a) => {
    calls += 1;
    if (calls >= 2 && failures > 0) { failures -= 1; throw new Error('socket hang up'); }
    return server.query(...a);
  };
  const waits = [];
  const res = await scanLibrary(flaky, { ...quick, sleep: async (ms) => { waits.push(ms); } });
  ok(res.complete === true && res.scanned === 1_000, 'two failures on one page are retried through');
  ok(waits.includes(2000) && waits.includes(5000), `with a backoff (${waits.filter((w) => w >= 2000)})`);
  const dead = async () => { throw new Error('connection refused'); };
  let caught = null;
  try { await scanLibrary(dead, { ...quick, sleep: async () => {} }); } catch (err) { caught = err; }
  ok(caught && caught.progress && caught.progress.requests === 3, 'a page that keeps failing gives up after three tries, saying how far it got');
}

console.log('=== folder-style names become titles ===');
{
  const cases = [
    ['Descendants Wicked Wonderland (2026) [tmdbid-1318621]', 2026, 'Descendants Wicked Wonderland', 2026],
    ['Good Grief (2024) [tmdbid-1504265]', 2024, 'Good Grief', 2024],
    ['In & Out (1997) [tmdbid-10806]', 1997, 'In & Out', 1997],
    ['Eat Drink Man Woman (1994) [tmdbid-10451]', 1994, 'Eat Drink Man Woman', 1994],
    ['Fantastic Beasts The Crimes of Grindelwald (2018)', 2018, 'Fantastic Beasts The Crimes of Grindelwald', 2018],
    // Jellyfin read the 2000 in the title as the year; the folder knows better.
    ['Cherry 2000 (1987)', 2000, 'Cherry 2000', 1987],
  ];
  for (const [name, y, title, year] of cases) {
    const c = cleanTitle(name, y);
    ok(c.title === title && c.year === year && c.cleaned, `"${name}" -> "${c.title}" (${c.year})`);
  }
  for (const real of ['D.A.R.Y.L.', '4.3.2.1', 'F.I.S.T.', 'B.A.P.S', 'Cry_Wolf', '1984', '(500) Days of Summer']) {
    const c = cleanTitle(real, 1985);
    ok(c.title === real && !c.cleaned, `"${real}" is a real title and is left alone`);
  }
}

console.log('=== the file says how much of the library it covers ===');
{
  const res = await scanLibrary(makeServer(makeLibrary(450)).query, quick);
  const md = formatCatalogue(res, { blocked: BLOCKED });
  ok(/read 450 of the 450 films the server reports/.test(md), 'the header gives read vs reported');
}

/* ------------------------- the refresh route, end to end ---------------- */

/**
 * Drive the real router and the real Jellyfin client against the emulated
 * server. The rebuild runs in the background (a full walk is well over a
 * minute), so, like the panel, the test follows GET /catalogue until it ends.
 */
async function withRoute({ lib = makeLibrary(20_796), serverOpts = {}, previous = 5152 } = {}, run) {
  const server = makeServer(lib, serverOpts);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (!u.pathname.endsWith('/Items')) throw new Error(`unexpected request to ${u.pathname}`);
    const r = await server.query(+u.searchParams.get('StartIndex'), +u.searchParams.get('Limit'),
      { nameStartsWithOrGreater: u.searchParams.get('NameStartsWithOrGreater') });
    const body = { Items: r.items, TotalRecordCount: r.total };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };

  const state = new Map();
  const stateStore = { namespace: (ns) => ({
    get: (k, d) => (state.has(`${ns}.${k}`) ? state.get(`${ns}.${k}`) : d),
    set: (k, v) => { state.set(`${ns}.${k}`, v); },
    push: (k, v) => { const a = state.get(`${ns}.${k}`) ?? []; a.unshift(v); state.set(`${ns}.${k}`, a); },
  }) };
  const cfg = {
    web: { admins: [{ username: 'superadmin', role: 'superadmin', passwordHash: 'x' }] },
    // No pause in a test; the default is exercised by "paging is polite".
    library: { provider: 'jellyfin', catalogueDelayMs: 0,
               jellyfin: { baseUrl: 'http://jellyfin.invalid', authMethod: 'apikey', apiKey: 'k', userId: 'u' } },
    movieRequests: { blockedRatings: BLOCKED, blockUnrated: false, requestGroups: [], reactions: {} },
    whatsapp: { accounts: [] }, media: {}, tvRequests: {}, directLinks: {}, queue: {}, lockdown: {},
  };
  const configStore = { get: () => cfg, update: () => cfg, redacted: () => ({}), onChange: () => () => {} };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { username: 'superadmin', role: 'superadmin' } }; next(); });
  app.use('/api', createApiRouter({
    configStore, bot: { dataDir: '/tmp', state: 'connected', groupCache: new Map(), groups: () => [], on: () => {} },
    queue: new JobQueue({ concurrency: 1 }), linkQueue: new JobQueue({ concurrency: 1 }),
    pluginManager: { plugins: new Map(), notifyConfigChange: async () => {} },
    stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {}, failover: null,
  }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {};
    const rq = http.request({ host: '127.0.0.1', port: srv.address().port, method, path: p, headers }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }));
    });
    rq.on('error', reject); rq.end(data ?? undefined);
  });
  const rebuild = async (body) => {
    const started = await call('POST', '/api/catalogue/refresh', body);
    for (let i = 0; i < 2_000; i++) {
      const d = await call('GET', '/api/catalogue');
      if (!d.body.running) return { started, final: d.body };
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('rebuild never finished');
  };

  // The route writes library/ under the working directory; keep it off the repo.
  const cwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogue-'));
  fs.mkdirSync(path.join(tmp, 'library'));
  fs.writeFileSync(path.join(tmp, 'library', 'clean-titles.json'),
    JSON.stringify({ count: previous, titles: ['the good old list'] }));
  process.chdir(tmp);
  const file = () => fs.readFileSync(path.join(tmp, 'library', 'clean-titles.json'), 'utf8');
  const audit = () => JSON.stringify(state.get('audit.events') ?? []);
  try { await run({ rebuild, state, file, audit, lib }); } finally {
    process.chdir(cwd);
    srv.close();
    globalThis.fetch = realFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const cleanUnder = async () => (await import('../src/plugins/movie-requests/theatrical.js')).isUnrated;

console.log('=== rebuilding through the panel reads everything and publishes it ===');
await withRoute({}, async ({ rebuild, state, file, lib }) => {
  const { started, final } = await rebuild();
  ok(started.status === 202 && started.body.started === true, `the rebuild starts at once (HTTP ${started.status})`);
  ok(final.scanned === 20_796 && final.total === 20_796, 'through the real Jellyfin client, all 20,796 films');
  const isUnrated = await cleanUnder();
  const want = lib.filter((it) => it.OfficialRating && !isUnrated(it.OfficialRating) && !BLOCKED.includes(it.OfficialRating)).length;
  const published = JSON.parse(file());
  ok(published.count === want, `the published file has every clean film (${published.count})`);
  ok(published.scanned === 20_796 && published.total === 20_796 && published.complete === true,
    'and records its own coverage, so a short file is recognisable from the file alone');
  ok(state.get('catalogue.lastIncomplete') === null, 'no refusal on record');
});

console.log('=== an incomplete walk never replaces the published list ===');
await withRoute({ serverOpts: { filter: 'ignored' } }, async ({ rebuild, state, file, audit }) => {
  const { final } = await rebuild();
  ok(file().includes('the good old list'), 'the previous file is untouched');
  ok(!state.has('catalogue.clean'), 'the previous list in the panel is untouched');
  ok(/read 10000 of 20796/.test(final.lastIncomplete?.reason ?? ''), `the panel is told why ("${final.lastIncomplete?.reason}")`);
  ok(/NOT published/.test(audit()), 'and it is audited');
});

console.log('=== an empty library does not wipe the list, unless confirmed ===');
await withRoute({ lib: [] }, async ({ rebuild, file }) => {
  const { final } = await rebuild();
  ok(file().includes('the good old list'), 'a server reporting 0 films leaves the 5,152-title list alone');
  ok(final.lastIncomplete?.shrink === true && /0 titles, the published one 5152/.test(final.lastIncomplete.reason),
    `and says the new list would be shorter ("${final.lastIncomplete?.reason}")`);
  await rebuild({ allowShrink: true });
  ok(JSON.parse(file()).count === 0, 'publishing it anyway takes an explicit second rebuild');
});

console.log('=== a server that will not say its size is not published ===');
await withRoute({ serverOpts: { reportTotal: () => null } }, async ({ rebuild, file }) => {
  const { final } = await rebuild();
  ok(file().includes('the good old list'), 'a walk that cannot be checked is not published');
  ok(/did not report how many films/.test(final.lastIncomplete?.reason ?? ''), `"${final.lastIncomplete?.reason}"`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
