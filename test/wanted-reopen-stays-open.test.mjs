/* A film an admin reopens on the Wanted list stays open: the recheck never resolves it again with the copy they rejected.
   Run: node test/wanted-reopen-stays-open.test.mjs

   Found in review, 2026-10-11. The bot marks a wanted film resolved when the
   recheck (src/core/wanted-recheck.js) finds a copy on the server, and an
   admin can Reopen it - a wrong cut, a broken file, a bad match. Reopen only
   deleted the resolution, so the next recheck found the same copy and
   resolved the film again, without a word; the Wanted card's own Refresh
   starts a recheck, and the bot's resolutions are never reported to the
   hourly check, so nobody would have seen it happen. With a fake lookup that
   answered "X2" (tt0290334), the entry was resolved, reopened, and resolved
   again by the very next run.

   And the same two paths undid each other forever: a request whose file
   check (4b) found the library's copy to be another film records the film
   as wanted again, which opens a resolved entry; the recheck, which runs no
   file check, resolved it with that copy within six hours; the next request
   opened it again.

   Pinned here (src/core/wanted.js, src/core/wanted-recheck.js, the reopen
   route in src/web/api.js): an admin's Reopen of the bot's resolution
   remembers the copy (`rejected`), with who and when, and the bot's note on
   the entry says so; the recheck never resolves the entry with that copy
   again, run after run, but does with another copy; reopening an admin's own
   resolution rules out nothing; a copy a request's file check refused is
   remembered whether the entry was open or resolved, and the recheck leaves
   the entry open over it; a copy remembered before ids were kept is known
   by its title and year; an entry remembers at most five; and an admin's
   note about the film reaches the hourly check with the copies ruled out. */
import express from 'express';
import http from 'node:http';
import {
  recordWanted, resolveWanted, reopenWanted, addWantedNote, listWanted, findWanted, sameCopy, rejectedCopy, BOT,
} from '../src/core/wanted.js';
import { recheckWanted } from '../src/core/wanted-recheck.js';
import { scan } from '../src/core/incident-scan.js';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const LIBRARY = mergeDefaults({ provider: 'jellyfin', jellyfin: { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'KEY', userId: 'U1' } }, DEFAULT_CONFIG.library);
const T0 = Date.parse('2026-10-11T09:00:00Z');
const X2 = { title: 'X2: X-Men United', year: 2003, imdbId: 'tt0290334', rated: 'PG-13' };
const NIGHTWATCH = { title: 'Nightwatch', year: 1997, imdbId: 'tt0119791', rated: 'R' };

function memStore(data = {}) {
  return { data, get: (k, d = null) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; return v; } };
}
const lines = [];
const log = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m), debug() {} };
// The lookup, answering whichever copy the library holds now.
let HELD = null;
const find = async () => HELD;
const recheck = (s) => recheckWanted(s, { libraryCfg: LIBRARY, find, paceMs: 0, log });
const isOpen = (s, key) => listWanted(s).some((w) => w.key === key);

console.log('=== an admin\'s Reopen of the bot\'s resolution stays open ===');
{
  const s = memStore();
  recordWanted(s, X2, { requester: 'Mia', request: 'X2 2003', now: T0 });
  HELD = { id: 'J-X2', title: 'X2', year: 2003, imdbId: 'tt0290334' };
  const first = await recheck(s);
  ok(first.found.length === 1 && findWanted(s, 'tt0290334').resolved?.as?.id === 'J-X2',
    'the recheck resolves it, keeping the library\'s id for the copy it found');

  const w = reopenWanted(s, 'tt0290334', { by: 'mommy', at: T0 + 60_000 });
  ok(!!w && !w.resolved && isOpen(s, 'tt0290334'), 'mommy reopens it');
  const r0 = w?.rejected?.[0];
  ok(r0?.id === 'J-X2' && r0.title === 'X2' && r0.year === 2003 && r0.by === 'mommy' && r0.at === T0 + 60_000 && r0.why === 'reopened',
    `the copy is remembered as rejected, by mommy (${JSON.stringify(r0)})`);
  const note = w?.notes?.at(-1);
  ok(note?.by === BOT && note.auto === true
    && note.text === 'reopened by mommy after the bot found it on the server as "X2" (2003) - the bot will not mark it resolved with that copy again',
  `the bot's note tells the other admins (${note?.text})`);

  lines.length = 0;
  const second = await recheck(s);
  ok(second.found.length === 0 && isOpen(s, 'tt0290334'), 'the next recheck leaves it open');
  ok(lines.some((l) => l === 'wanted recheck: the library\'s "X2" (2003) is the copy mommy reopened X2: X-Men United (2003) over - it stays on the list'),
    `and says why (${lines.find((l) => /stays on the list/.test(l))})`);
  ok((await recheck(s)).found.length === 0 && isOpen(s, 'tt0290334'), 'and so does every run after it');

  HELD = { id: 'J-X2-NEW', title: 'X2', year: 2003, imdbId: 'tt0290334' };
  const third = await recheck(s);
  ok(third.found.length === 1 && findWanted(s, 'tt0290334').resolved?.as?.id === 'J-X2-NEW',
    'a copy the server gets later - another library item - is found and resolves it');
}

console.log('=== reopening an admin\'s resolution rules out nothing ===');
{
  const s = memStore();
  recordWanted(s, X2, { requester: 'Mia', now: T0 });
  resolveWanted(s, 'tt0290334', { by: 'david', at: T0 + 1000 });
  const w = reopenWanted(s, 'tt0290334', { by: 'mommy' });
  ok(!w?.rejected && !(w?.notes ?? []).length, 'no copy was found, so none is rejected, and no note');
  HELD = { id: 'J-X2', title: 'X2', year: 2003, imdbId: 'tt0290334' };
  ok((await recheck(s)).found.length === 1, 'and a copy the recheck finds resolves it');
}

console.log('=== a copy remembered before ids were kept is known by title and year ===');
{
  const s = memStore();
  recordWanted(s, X2, { now: T0 });
  resolveWanted(s, 'tt0290334', { by: 'the bot (found on the server as "X2")', auto: true, as: { title: 'X2', year: 2003, imdbId: 'tt0290334' } });
  reopenWanted(s, 'tt0290334', { by: 'mommy' });
  HELD = { id: 'J-X2', title: 'X2', year: 2003, imdbId: 'tt0290334' };
  ok((await recheck(s)).found.length === 0 && isOpen(s, 'tt0290334'), 'the same copy, now with an id, still stays open');
}

console.log('=== a copy a request\'s file check refused is never the film ===');
{
  // The ping-pong: resolved by the bot with a copy, a request's file check
  // finds that copy to be another film, the film is wanted again.
  const s = memStore();
  recordWanted(s, NIGHTWATCH, { requester: 'Mia', request: 'nightwatch', now: T0 });
  HELD = { id: 'J-NW', title: 'Nightwatch', year: 1997, imdbId: null };
  ok((await recheck(s)).found.length === 1, 'the recheck, which runs no file check, resolves it with the library\'s "Nightwatch"');
  const refused = { id: 'J-NW', title: 'Nightwatch', year: 1997, imdbId: null };
  recordWanted(s, NIGHTWATCH, { requester: 'Avi', request: 'nightwatch', refused, now: T0 + 3600_000 });
  const w = findWanted(s, 'tt0119791');
  ok(!w.resolved && w.count === 2, 'a request whose file check refused that copy opens it again');
  ok(w.rejected?.[0]?.id === 'J-NW' && w.rejected[0].by === BOT && w.rejected[0].why === 'another-film', 'and the copy is remembered');
  ok(w.notes?.at(-1)?.text === 'asked again after it was resolved by the bot (found on the server as "Nightwatch"); '
    + 'the request found "Nightwatch" (1997) on the server, and its file is another film', `the bot's note says why (${w.notes?.at(-1)?.text})`);
  lines.length = 0;
  ok((await recheck(s)).found.length === 0 && isOpen(s, 'tt0119791'), 'the recheck no longer resolves it');
  ok(lines.some((l) => /is the copy a request found to be another film than Nightwatch \(1997\) - it stays on the list/.test(l)), 'and says why');

  const fresh = memStore();
  recordWanted(fresh, NIGHTWATCH, { requester: 'Mia', request: 'nightwatch', refused, now: T0 });
  ok(rejectedCopy(findWanted(fresh, 'tt0119791'), HELD)?.why === 'another-film', 'an entry recorded open with a refused copy remembers it too');
  ok((await recheck(fresh)).found.length === 0 && isOpen(fresh, 'tt0119791'), 'and the recheck never resolves it with that copy');
  recordWanted(fresh, NIGHTWATCH, { requester: 'Avi', request: 'nightwatch', refused, now: T0 + 1000 });
  ok(findWanted(fresh, 'tt0119791').rejected.length === 1, 'the same copy refused twice is remembered once');
  ok(!(findWanted(fresh, 'tt0119791').notes ?? []).length, 'and an open entry gets no note for it');
}

console.log('=== which copies are the same ===');
{
  ok(sameCopy({ id: 'A', title: 'X2', year: 2003 }, { id: 'A', title: 'X2 (Extended)', year: 2003 }), 'one library id is one copy, whatever its name now');
  ok(!sameCopy({ id: 'A', title: 'X2', year: 2003 }, { id: 'B', title: 'X2', year: 2003 }), 'two ids are two copies');
  ok(sameCopy({ title: 'X2', year: 2003 }, { id: 'B', title: 'x2', year: 2003 }), 'without both ids, title and year decide');
  ok(!sameCopy({ title: 'X2', year: 2003, imdbId: 'tt0290334' }, { title: 'X2', year: 2003, imdbId: 'tt9999999' }), 'never across two IMDb ids');
  ok(!sameCopy({ title: 'X2', year: 2003 }, { title: 'X2', year: 2004 }) && !sameCopy(null, { title: 'X2' }), 'another year, or nothing, is not');

  const s = memStore();
  recordWanted(s, X2, { now: T0 });
  for (let i = 1; i <= 7; i++) recordWanted(s, X2, { refused: { id: `J${i}`, title: 'X2', year: 2003 }, now: T0 + i });
  const kept = findWanted(s, 'tt0290334').rejected.map((r) => r.id);
  ok(kept.join() === 'J3,J4,J5,J6,J7', `an entry remembers the last five (${kept.join()})`);
}

console.log('=== the hourly check is told which copies were ruled out ===');
{
  const s = memStore();
  recordWanted(s, X2, { requester: 'Mia', now: T0 });
  resolveWanted(s, 'tt0290334', { by: 'the bot (found on the server as "X2")', auto: true, at: T0 + 1000, as: { id: 'J-X2', title: 'X2', year: 2003 } });
  reopenWanted(s, 'tt0290334', { by: 'mommy', at: T0 + 2000 });
  addWantedNote(s, 'tt0290334', { by: 'mommy', text: 'The X2 on the server is the TV cut - find the theatrical one', at: T0 + 3000 });
  const r = scan({
    now: T0 + 3600_000, names: {}, unit: { ActiveState: 'active', NRestarts: '0' },
    config: { movieRequests: { requestGroups: [], requirePrefix: true, prefix: '#request', notify: {} }, tvRequests: { requestGroups: [] }, beta: { groups: [], features: {} }, media: {} },
    state: {
      'movie-requests': { history: [], pending: [], wanted: s.get('wanted', []) },
      'tv-requests': { history: [], pending: [], 'library-misses': [] }, 'msg-index': { entries: [] }, audit: { events: [] },
    },
    memory: { v: 1, lastScanAt: T0, seen: {}, configCheckedAt: T0 + 3600_000 },
  });
  const f = r.incidents.find((x) => x.kind === 'admin-note');
  ok(f?.wanted?.rejected?.length === 1 && f.wanted.rejected[0].title === 'X2' && f.wanted.rejected[0].by === 'mommy'
    && f.wanted.rejected[0].why === 'reopened', `the admin's note comes with the copy mommy ruled out (${JSON.stringify(f?.wanted?.rejected)})`);
}

console.log('=== the reopen route rules out the copy under the admin\'s name ===');
{
  const data = {};
  const movies = memStore(data);
  const audit = [];
  const stateStore = {
    namespace: (ns) => (ns === 'movie-requests' ? movies : {
      get: (k, d = null) => (k === 'events' ? audit : d), set() {}, push: (k, v) => { if (k === 'events') audit.unshift(v); },
    }),
  };
  const configStore = {
    get: () => ({
      web: { adminPasswordHash: 'x', users: [{ username: 'admin', role: 'superadmin', passwordHash: 'x' }] },
      movieRequests: { requestGroups: [], reactions: {} }, media: { concurrency: 1 }, library: LIBRARY,
      whatsapp: { accounts: [], failover: {} }, tvRequests: {}, directLinks: {}, queue: {}, lockdown: {},
    }),
    update() {}, redacted: () => ({}), onChange() {},
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { username: 'mommy', role: 'admin' } }; next(); });
  const queue = new JobQueue({ concurrency: 1 });
  queue.pause();
  app.use('/api', createApiRouter({
    configStore, bot: { groupCache: new Map(), groups: () => [], on: () => {}, state: 'connected' }, queue, linkQueue: queue,
    pluginManager: { plugins: new Map(), notifyConfigChange: async () => {} }, stateStore, fileLogger: { tail: () => [] },
    alerts: {}, lockScheduler: {},
  }));
  const server = await new Promise((r) => { const sv = app.listen(0, '127.0.0.1', () => r(sv)); });
  const call = (method, p) => new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port: server.address().port, method, path: p }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch { /* not JSON */ } resolve({ status: res.statusCode, json }); });
    });
    rq.on('error', reject);
    rq.end();
  });

  recordWanted(movies, X2, { requester: 'Mia', now: T0 });
  resolveWanted(movies, 'tt0290334', {
    by: 'the bot (found on the server as "X2")', auto: true, as: { id: 'J-X2', title: 'X2', year: 2003, imdbId: 'tt0290334' },
  });
  const res = await call('POST', '/api/wanted/tt0290334/reopen');
  ok(res.status === 200 && !res.json?.entry?.resolved, `reopened (${res.status})`);
  ok(res.json?.entry?.rejected?.[0]?.by === 'mommy' && res.json.entry.rejected[0].id === 'J-X2', 'the copy is ruled out under the admin\'s name');
  const row = audit.find((e) => /reopened/.test(e.action ?? ''));
  ok(row?.detail === 'it had been resolved by the bot (found on the server as "X2"); the bot will not resolve it with the library\'s "X2" again',
    `and the audit says so (${row?.detail})`);
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
