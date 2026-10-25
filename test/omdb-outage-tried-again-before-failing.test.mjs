/* A failure of the moment at OMDb is tried again before a request fails.
   Run: node test/omdb-outage-tried-again-before-failing.test.mjs

   The incident, 2026-10-12. At 01:46:14Z a member's "First daughter 2004"
   failed with "metadata lookup failed: OMDb HTTP 525" - a Cloudflare error
   in front of OMDb - and they got ⚠️. OMDb answered the next lookup at
   01:47:37: it was gone for under 90 seconds. Head Admin, who looks after the
   library, raised it as a top-priority #issue: '#issue #group02 on
   10-11-2025 1945 @... requested "First Daughter 2004" and got an ⚠️
   reaction, please queue once resolved', and an admin queued the film by
   hand. At 03:06:50Z "My Fault London 2025" failed the same way with "OMDb
   HTTP 403", and the next lookups worked. omdbFetch threw at the first bad
   answer, with no second try.

   Since (src/plugins/movie-requests/omdb.js): a network error, HTTP 5xx,
   429 and 403 are tried again 5, 30 and 90 s after the first try; OMDb's
   own 401s ("Invalid API key!", "Request limit reached!") and its answers
   ("Movie not found!") are not; a caller's abort ends the call at once; and
   once a call has used up its tries, OMDb is noted as down for a minute, in
   which a call is tried once, until one succeeds. The final error reads as
   before, "OMDb HTTP 525".

   Found in review of that change, the same day, and covered here too: a try
   is given the rest of its call's two minutes rather than 20 s of its own,
   so an OMDb that answers slowly is answered, as before, and not turned into
   four timeouts, ⚠️ and a note that OMDb is down; and the pick list's plots
   make one try, since their 4 s budget ends before the first retry is due,
   and the list was held those 4 s for nothing.

   OMDb and Jellyfin are answered by a stubbed fetch; the wait between tries
   runs on a fake clock (setOmdbClock), so nothing here really waits. */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from '../src/util/logger.js';
import {
  lookupMovie, listPlots, clearPlotCache, testApiKey, setOmdbClock, forgetOmdbOutage, OMDB_RETRY_SPAN_MS,
} from '../src/plugins/movie-requests/omdb.js';
import moviePlugin from '../src/plugins/movie-requests/index.js';
import { JobQueue } from '../src/core/queue.js';
import { DEFAULT_CONFIG, mergeDefaults } from '../src/config/schema.js';
import { MemberCooldown, COOLDOWN_LIMITS } from '../src/core/request-cooldown.js';
import { CHAIN_LIMITS } from '../src/core/ai-providers.js';
import { scan } from '../src/core/incident-scan.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };
const settle = (ms = 15) => new Promise((r) => setTimeout(r, ms));

/* ============================ the network ============================ */

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const OMDB = [
  { Title: 'First Daughter', Year: '2004', Rated: 'PG', imdbID: 'tt0361620' },
  { Title: 'My Fault: London', Year: '2025', Rated: 'TV-MA', imdbID: 'tt27678330' },
  { Title: 'Venom', Year: '2018', Rated: 'PG-13', imdbID: 'tt1270797', Plot: 'A failed reporter is bonded to an alien entity.' },
].map((m) => ({ ...m, Type: 'movie', Released: 'N/A', DVD: 'N/A', Response: 'True' }));
const LIBRARY = [{
  Id: 'jf1', Name: 'First Daughter', ProductionYear: 2004, OfficialRating: 'PG', Type: 'Movie',
  MediaSources: [{ Path: '/nowhere/First Daughter.mkv', Size: 17, Container: 'mp4' }],
}];

// What OMDb does on its next calls, in turn; once the script is empty it
// answers. A number is that HTTP status; 'network' is a connection that
// fails; 'hang' never answers until the request is aborted; a function is
// asked for the Response.
let script = [];
let omdbCalls = [];
const timeline = [];
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  if (u.hostname === 'www.omdbapi.com') {
    const p = u.searchParams;
    omdbCalls.push(['t', 's', 'i'].filter((k) => p.has(k)).map((k) => `${k}=${p.get(k)}${p.get('y') ? ` y=${p.get('y')}` : ''}`).join());
    timeline.push('omdb');
    const step = script.length ? script.shift() : 'ok';
    if (typeof step === 'number') return new Response('<html>error code: ' + step + '</html>', { status: step });
    if (step === 'network') throw new TypeError('fetch failed');
    if (step === 'hang') {
      return new Promise((resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
      });
    }
    if (typeof step === 'function') return step();
    const miss = () => json({ Response: 'False', Error: 'Movie not found!' });
    const y = p.get('y') ? Number(p.get('y')) : null;
    if (p.get('i')) return json(OMDB.find((m) => m.imdbID === p.get('i')) ?? miss());
    if (p.get('t')) {
      const hit = OMDB.find((m) => norm(m.Title) === norm(p.get('t')) && (!y || Number(m.Year) === y));
      return hit ? json(hit) : miss();
    }
    if (p.get('s')) {
      const hits = OMDB.filter((m) => norm(m.Title).includes(norm(p.get('s'))) && (!y || Number(m.Year) === y));
      return hits.length ? json({ Response: 'True', Search: hits.map(({ Title, Year, imdbID, Type }) => ({ Title, Year, imdbID, Type })) }) : miss();
    }
    return miss();
  }
  if (u.hostname === 'jf.test') {
    if (u.pathname === '/Items') {
      const term = u.searchParams.get('searchTerm');
      if (!term || u.searchParams.get('IncludeItemTypes') === 'Series') return json({ Items: [] });
      return json({ Items: LIBRARY.filter((f) => norm(f.Name).includes(norm(term))) });
    }
    return json({ Items: [] });
  }
  return new Response('{}', { status: 404, statusText: 'not stubbed' });
};

/* ============================ the clock ============================ */

// The waits between tries, on a clock that only they move.
let now = 1_800_000_000_000;
let waits = [];
setOmdbClock({ now: () => now, sleep: async (ms) => { waits.push(ms); timeline.push(`wait ${ms}`); now += ms; } });

const lines = [];
log.on('line', (e) => { if (e.scope === 'omdb') lines.push(`[${e.level}] ${e.msg}`); });

/** A fresh start: nothing scripted, nothing counted, OMDb not noted as down. */
function fresh(steps = []) {
  script = [...steps];
  omdbCalls = [];
  waits = [];
  lines.length = 0;
  timeline.length = 0;
  forgetOmdbOutage();
}
const tryLookup = async (text, opts = {}) => {
  try { return { found: await lookupMovie(text, { apiKey: 'k', ...opts }) }; } catch (err) { return { err }; }
};

console.log('=== the incident: OMDb HTTP 525, then OMDb answers - the film is found ===');
{
  fresh([525]);
  const { found, err } = await tryLookup('First daughter 2004');
  ok(!err && found?.movie?.title === 'First Daughter' && found.movie.year === 2004,
    `"First daughter 2004" resolves to First Daughter (2004) (${err?.message ?? found?.movie?.title})`);
  ok(omdbCalls.length === 2 && waits.join() === '5000', `after one wait of 5 s and a second try (${omdbCalls.length} calls, waits ${waits.join()})`);
  ok(lines.some((l) => l === '[info] OMDb HTTP 525 for "First daughter 2004" - trying again in 5s (2/4)'),
    `the retry is logged at info, naming the request and the try:\n      ${lines.join('\n      ')}`);
}

console.log('=== what is tried again: 5xx, 429, 403, a network error ===');
for (const status of [500, 502, 503, 504, 520, 525, 429, 403, 'network']) {
  fresh([status, status]);
  const { found, err } = await tryLookup('First daughter 2004');
  ok(!err && found?.movie?.imdbId === 'tt0361620' && omdbCalls.length === 3 && waits.join() === '5000,25000',
    `${status === 'network' ? 'a network error' : `HTTP ${status}`} twice, then an answer: found on the third try `
    + `(${err?.message ?? found?.movie?.title}; ${omdbCalls.length} calls; waits ${waits.join()})`);
}
{
  fresh(['network']);
  await tryLookup('First daughter 2004');
  ok(lines.some((l) => /^\[info\] fetch failed for "First daughter 2004" - trying again in 5s \(2\/4\)$/.test(l)),
    `a network error says what fetch said (${lines[0]})`);
}

console.log('=== a slow OMDb is waited for: a try has the rest of its call, not a limit of its own ===');
// What one call may take is made short here (spanMs, in real milliseconds
// for the try itself), and OMDb's slow answer shorter still.
const slowly = (ms) => () => new Promise((r) => setTimeout(r, ms)).then(() => json(OMDB[0]));
{
  // The review's case: OMDb answering in 25 s took 4 tries of 20 s, ⚠️, and
  // a note that OMDb was down. Answered slowly, it is an answer.
  fresh([slowly(80)]);
  const restore = setOmdbClock({ spanMs: 1000 });
  const { found, err } = await tryLookup('First daughter 2004');
  restore();
  ok(!err && found?.movie?.title === 'First Daughter' && omdbCalls.length === 1 && waits.length === 0,
    `an answer that is slow but comes is taken, on the first try (${err?.message ?? found?.movie?.title}, ${omdbCalls.length} call(s))`);
  ok(!lines.some((l) => /timed out|giving up|taken as down/.test(l)), 'and nothing is said about a timeout or an outage');
}
{
  // A connection that hangs is given up on at the call's end, where fetch
  // alone would have waited undici's five minutes - and that call has used
  // up its tries: no time is left in it for another.
  fresh(['hang']);
  const restore = setOmdbClock({ spanMs: 60 });
  const t0 = Date.now();
  const { err } = await tryLookup('First daughter 2004');
  restore();
  ok(/^OMDb timed out after/.test(err?.message ?? '') && omdbCalls.length === 1 && Date.now() - t0 < 1000,
    `a try that never answers ends with the call: "${err?.message}", ${omdbCalls.length} call, ${Date.now() - t0} ms`);
  ok(lines.some((l) => /^\[warn\] OMDb timed out after .* giving up after 1 try over/.test(l)), `and OMDb is noted as down (${lines.at(-1)})`);

  // The one try a call gets while OMDb is noted as down has the span too: a
  // slow OMDb back from an outage is answered, and the note dropped, rather
  // than every try cut short and every request ⚠️ while members kept asking.
  script = [slowly(80)];
  omdbCalls = []; waits = []; lines.length = 0;
  const restore2 = setOmdbClock({ spanMs: 1000 });
  const back = await tryLookup('First daughter 2004');
  restore2();
  ok(back.found?.movie?.title === 'First Daughter' && omdbCalls.length === 1 && lines.some((l) => /answering again/.test(l)),
    `noted as down, a slow answer is still taken, and ends the note (${back.err?.message ?? back.found?.movie?.title})`);
}
{
  // A try that fails slowly - Cloudflare's 524 after 100 s - takes the time
  // the retries were due in, and the call still ends within its two minutes.
  const slow524 = (s) => () => { now += s * 1000; return new Response('error code: 524', { status: 524 }); };
  fresh([slow524(100), slow524(18)]);
  const t = now;
  const { err } = await tryLookup('First daughter 2004');
  ok(err?.message === 'OMDb HTTP 524' && omdbCalls.length === 2 && waits.join() === '0',
    `a 524 at 100 s is tried again at once, and one at 118 s is the last: "${err?.message}", ${omdbCalls.length} tries, waits ${waits.join()}`);
  ok(now - t <= OMDB_RETRY_SPAN_MS && lines.some((l) => /giving up after 2 tries over 118s/.test(l)),
    `the call ended at ${(now - t) / 1000} s, within ${OMDB_RETRY_SPAN_MS / 1000}, and says so (${lines.at(-1)})`);
}

console.log('=== what is not: OMDb\'s 401s and its own answers ===');
for (const error of ['Invalid API key!', 'Request limit reached!']) {
  fresh([() => json({ Response: 'False', Error: error }, 401)]);
  const { err } = await tryLookup('First daughter 2004');
  ok(err?.message === 'OMDb HTTP 401' && omdbCalls.length === 1 && waits.length === 0,
    `401 "${error}": one try, no wait, "${err?.message}" (${omdbCalls.length} call(s))`);
}
{
  fresh();
  const { found, err } = await tryLookup('A Film Nobody Made 1999');
  ok(!err && found === null, `"Movie not found!" is an answer: nothing found, nothing thrown (${err?.message})`);
  ok(waits.length === 0 && new Set(omdbCalls).size === omdbCalls.length,
    `and no call was made twice, nor waited for (${omdbCalls.join(' | ')})`);
  ok(!lines.some((l) => /trying again/.test(l)), 'nothing said about trying again');
}
{
  // A body that is not JSON is OMDb answering oddly, not the connection
  // failing.
  fresh([() => new Response('<html>not json</html>', { status: 200 })]);
  const { err } = await tryLookup('First daughter 2004');
  ok(err && omdbCalls.length === 1 && waits.length === 0, `an answer that is not JSON is not tried again (${err?.name}, ${omdbCalls.length} call)`);
}

console.log('=== used up: four tries over 90 s, then the error as it always read ===');
{
  fresh([525, 525, 525, 525]);
  const { err } = await tryLookup('First daughter 2004');
  ok(err?.message === 'OMDb HTTP 525', `the final error is "OMDb HTTP 525" (${err?.message})`);
  ok(omdbCalls.length === 4 && waits.join() === '5000,25000,60000',
    `four tries, at 0, 5, 30 and 90 s (${omdbCalls.length} calls, waits ${waits.join()})`);
  ok(['(2/4)', '(3/4)', '(4/4)'].every((n) => lines.some((l) => l.includes(`trying again`) && l.includes(n))),
    'each retry logged with its number');
  ok(lines.some((l) => /^\[warn\] OMDb HTTP 525 for "First daughter 2004" - giving up after 4 tries over 90s/.test(l)),
    `giving up is a warning (${lines.at(-1)})`);
  ok(OMDB_RETRY_SPAN_MS >= 90_000 && OMDB_RETRY_SPAN_MS <= 120_000, `one call takes ${OMDB_RETRY_SPAN_MS / 1000} s at most`);
}

console.log('=== the outage note: after a call used up its tries, the next is tried once, until OMDb answers ===');
{
  fresh([525, 525, 525, 525]);
  await tryLookup('First daughter 2004');
  script = [525];
  omdbCalls = []; waits = []; lines.length = 0;
  const { err } = await tryLookup('My Fault London 2025');
  ok(err?.message === 'OMDb HTTP 525' && omdbCalls.length === 1 && waits.length === 0,
    `the next lookup fails fast: one try, no wait, "${err?.message}" (${omdbCalls.length} call)`);
  ok(lines.some((l) => /^\[info\] OMDb HTTP 525 for "My Fault London 2025" - not trying again: OMDb has been failing for 90s/.test(l)),
    `and says why (${lines[0]})`);

  // One try is still made: OMDb back in the window answers at once.
  omdbCalls = []; waits = [];
  const back = await tryLookup('My Fault London 2025');
  ok(back.found?.movie?.title === 'My Fault: London' && waits.length === 0,
    `OMDb back within the minute: the next lookup is answered, not refused on the note (${back.err?.message ?? back.found?.movie?.title})`);
  ok(lines.some((l) => /^\[info\] OMDb is answering again, after failing for 90s$/.test(l)), 'and the recovery is logged');
  script = [525];
  omdbCalls = []; waits = [];
  const blip = await tryLookup('First daughter 2004');
  ok(blip.found?.movie?.title === 'First Daughter' && waits.join() === '5000',
    `the note is gone with that answer: a new blip is tried again in full (${waits.join()})`);
}
{
  // Down for longer: every failed try renews the minute, and a call after a
  // quiet minute waits a new blip out in full.
  fresh([525, 525, 525, 525]);
  await tryLookup('First daughter 2004');
  now += 40_000;
  script = [525];
  omdbCalls = []; waits = [];
  await tryLookup('First daughter 2004');
  now += 40_000;                     // 80 s after the first note, 40 after the renewal
  script = [525];
  omdbCalls = []; waits = [];
  await tryLookup('First daughter 2004');
  ok(omdbCalls.length === 1 && waits.length === 0, `still down: each failed try renews the minute (${omdbCalls.length} call)`);
  now += 61_000;
  script = [525, 525];
  omdbCalls = []; waits = []; lines.length = 0;
  const later = await tryLookup('First daughter 2004');
  ok(later.found?.movie?.title === 'First Daughter' && omdbCalls.length === 3 && waits.join() === '5000,25000',
    `after a quiet minute, the next lookup waits it out again (${omdbCalls.length} calls, waits ${waits.join()})`);
  ok(!lines.some((l) => /answering again/.test(l)),
    'and the lapsed note is forgotten, not reported as an outage that lasted until now');
}
{
  // A call already waiting when another used up its tries stops at its next
  // failure, rather than going on to wait its own 90 s.
  fresh();
  script = [];
  const answers = new Map([['first daughter', [525, 525, 525, 525]], ['my fault', [525, 525, 525, 525]]]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const t = norm(new URL(String(url)).searchParams.get('t') ?? '');
    const list = [...answers.entries()].find(([k]) => t.startsWith(k))?.[1];
    if (list?.length) script.unshift(list.shift());
    return realFetch(url, opts);
  };
  let release = null;
  const restore = setOmdbClock({
    sleep: (ms) => {
      waits.push(ms); now += ms;
      if (!release) return new Promise((r) => { release = r; });
      return undefined;
    },
  });
  const waiting = tryLookup('My Fault London 2025');
  await settle();
  const first = await tryLookup('First daughter 2004');
  release();
  const second = await waiting;
  restore();
  globalThis.fetch = realFetch;
  const mine = omdbCalls.filter((c) => /my fault/i.test(c)).length;
  ok(first.err?.message === 'OMDb HTTP 525' && second.err?.message === 'OMDb HTTP 525' && mine === 2,
    `the lookup that was waiting tried once more and stopped: ${mine} tries, not 4`);
}

console.log('=== the caller\'s signal: an abort ends the call at once ===');
{
  fresh([525, 525, 525, 525]);
  // A wait that would never end by itself: only the abort can end it.
  const restore = setOmdbClock({ sleep: (ms) => { waits.push(ms); return new Promise(() => {}); } });
  const ctl = new AbortController();
  const p = tryLookup('First daughter 2004', { signal: ctl.signal });
  await settle();
  ok(omdbCalls.length === 1 && waits.length === 1, 'the first try failed, and the call is waiting to try again');
  const t0 = Date.now();
  ctl.abort();
  const { err } = await p;
  restore();
  ok(err?.name === 'AbortError' && Date.now() - t0 < 500, `the abort ends it at once, with the abort (${err?.name}, ${Date.now() - t0} ms)`);
  ok(omdbCalls.length === 1, 'and nothing more is asked of OMDb');
  script = [525];
  omdbCalls = []; waits = [];
  const after = await tryLookup('First daughter 2004');
  ok(after.found?.movie && waits.join() === '5000', 'an abort is not an outage: the next lookup is tried again in full');
}
{
  fresh(['hang']);
  const ctl = new AbortController();
  const p = tryLookup('First daughter 2004', { signal: ctl.signal });
  await settle();
  ctl.abort();
  const { err } = await p;
  ok(err?.name === 'AbortError' && omdbCalls.length === 1 && waits.length === 0,
    `aborted during a try: not taken as a timeout, and not tried again (${err?.name}, ${omdbCalls.length} call)`);
  fresh();
  const gone = new AbortController();
  gone.abort();
  const pre = await tryLookup('First daughter 2004', { signal: gone.signal });
  ok(pre.err?.name === 'AbortError' && omdbCalls.length === 0, 'a signal aborted already: OMDb is not asked at all');
}
{
  // The pick list's plots have 4 s in all, and the first retry is due at
  // 5 s: a retry could never be made, and waiting for one held the list
  // until its abort. Its plots make one try, and a 525 costs a plot, at once.
  fresh([525, 525, 525, 525]);
  clearPlotCache();
  const restore = setOmdbClock({ sleep: (ms) => { waits.push(ms); return new Promise(() => {}); } });
  const t0 = Date.now();
  const plots = await listPlots([{ title: 'Venom', year: 2018 }], { apiKey: 'k' });
  const took = Date.now() - t0;
  restore();
  ok(plots[0] === null && took < 1000, `a 525: no plot, at once, not at the list's 4 s (${took} ms)`);
  ok(omdbCalls.length === 1 && waits.length === 0 && !lines.some((l) => /trying again/.test(l)),
    `one try, and no wait for a retry that could not fit (${omdbCalls.length} call, ${waits.length} wait)`);

  // Its own budget still ends a try that hangs.
  fresh(['hang']);
  clearPlotCache();
  const t1 = Date.now();
  const hung = await listPlots([{ title: 'Venom', year: 2018 }], { apiKey: 'k', timeoutMs: 60 });
  ok(hung[0] === null && Date.now() - t1 < 1000, `a hang: no plot at the list's own ${60} ms (${Date.now() - t1} ms)`);

  fresh();
  clearPlotCache();
  const good = await listPlots([{ title: 'Venom', year: 2018 }], { apiKey: 'k' });
  ok(good[0] === 'A failed reporter is bonded to an alien entity.', `and with OMDb up the plot is there (${good[0]})`);
}

console.log('=== no retry where nobody\'s request waits on it ===');
{
  fresh([525, 525]);
  const { err } = await tryLookup('First daughter 2004', { retry: false });
  ok(err?.message === 'OMDb HTTP 525' && omdbCalls.length === 1 && waits.length === 0,
    `retry: false (direct-links, whose link queue runs one lookup at a time) makes one try (${omdbCalls.length})`);
  script = [525];
  omdbCalls = []; waits = [];
  const again = await tryLookup('First daughter 2004');
  ok(again.found?.movie && waits.join() === '5000', 'and its failure does not note OMDb as down');
  fresh([525]);
  const key = await testApiKey('k');
  ok(key.ok === false && key.error === 'OMDb HTTP 525' && omdbCalls.length === 1,
    `the panel's key test reports OMDb as it is now, after one try: "${key.error}"`);
}

/* ============================ the request ============================ */

const REQ = 'movie-requests@g.us';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'omdb-outage-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

function fakeStore() {
  const data = {};
  return {
    data,
    get: (k, d = null) => (k in data ? data[k] : d),
    set: (k, v) => { data[k] = v; },
    delete: (k) => { delete data[k]; },
    push: (k, v) => { (data[k] ??= []).unshift(v); },
  };
}

function harness() {
  const config = mergeDefaults({
    movieRequests: {
      requestGroups: [REQ], postsGroup: 'posts@g.us', requirePrefix: true, prefix: '#request',
      cooldownSecondsPerUser: 0, replyOnBlock: false, requireYearWhenAmbiguous: false,
    },
  }, DEFAULT_CONFIG);
  config.omdb.apiKey = 'test-key';
  config.library = mergeDefaults({
    provider: 'jellyfin',
    jellyfin: { baseUrl: 'http://jf.test', authMethod: 'apikey', apiKey: 'KEY', accessToken: 'TOK', userId: 'U1' },
  }, DEFAULT_CONFIG.library);
  config.media.workDir = path.join(TMP, 'work');
  const store = fakeStore();
  const queue = new JobQueue({ concurrency: 1, maxLength: 50 });
  queue.pause();
  const out = [];
  const logs = [];
  const h = {
    store, queue, out, logs,
    ctx: {
      config, store, queue, configStore: { update() {} },
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), debug() {} },
      bot: {
        isConnected: () => true,
        isGroupAdmin: () => false,
        react: async (msg, emoji) => { out.push({ on: msg.id, emoji }); timeline.push(`react ${emoji}`); return true; },
        sendText: async (jid, body, opts) => { out.push({ text: body, jid, quoted: opts?.quoted?.id ?? null }); return { key: { id: `BOT${out.length}`, remoteJid: jid } }; },
        editText: async () => true,
        deleteMessage: async () => {}, archiveChat: async () => {},
        groupMemberInfo: () => ({ isMember: false }), groups: () => [], groupCache: new Map(),
        sameCommunity: () => false, groupMentionToken: (j) => `@${j}`,
        async _bulkPace() {}, on() {}, off() {},
      },
    },
  };
  moviePlugin._reactors = new Map();
  moviePlugin._cooldown = new MemberCooldown({ section: 'films', limits: { ...COOLDOWN_LIMITS } });
  return h;
}

let seq = 0;
const MEMBER = { jid: '100000000000002@lid', number: '15550000001', name: 'Member' };
const ask = async (h, text) => {
  const id = `M${++seq}`;
  const m = {
    id, key: { id, remoteJid: REQ, participant: MEMBER.jid, fromMe: false }, text, chatJid: REQ,
    isGroup: true, fromMe: false, messageType: 'conversation', senderJid: MEMBER.jid, senderNumber: MEMBER.number,
    senderNumberDisplay: `+${MEMBER.number}`, pushName: MEMBER.name, timestamp: Date.now(),
  };
  await moviePlugin.onMessage(m, h.ctx);
  await settle();
  return m;
};
const PLACE = /^(?:\d️?⃣|🔟|🔢)$/u;
const on = (h, m) => h.out.filter((e) => e.on === m.id && !PLACE.test(e.emoji ?? '')).map((e) => e.emoji).join(' ');
const rowOf = (h, m) => (h.store.data.history ?? []).find((r) => r.id === m.id);

console.log('=== the request: a 525 waited out is a film queued, not ⚠️ ===');
{
  const h = harness();
  fresh([525]);
  const m = await ask(h, '#request First daughter 2004');
  ok(on(h, m) === '🔍 🎬', `"First daughter 2004" is queued as the member asked (${on(h, m)})`);
  ok(h.queue.snapshot().pending.map((e) => e.label).join() === 'First Daughter (2004)', 'First Daughter (2004) is in the queue');
  ok(!h.out.some((e) => e.text), 'and nothing else is said to the group');
  ok(rowOf(h, m)?.status === 'queued', `History says queued (${rowOf(h, m)?.status})`);
}

console.log('=== the request: ⚠️ only once the tries are used up, with the detail as before ===');
{
  const h = harness();
  fresh([525, 525, 525, 525]);
  const m = await ask(h, '#request First daughter 2004');
  ok(on(h, m) === '🔍 ⚠️', `the member gets ⚠️ (${on(h, m)})`);
  const fourth = timeline.lastIndexOf('omdb');
  ok(timeline.filter((e) => e === 'omdb').length === 4 && timeline.indexOf('react ⚠️') > fourth
    && timeline.filter((e) => e.startsWith('wait')).length === 3,
  `after the fourth try, and three waits, not before: ${timeline.join(' → ')}`);
  const row = rowOf(h, m);
  ok(row?.status === 'error' && row.detail === 'metadata lookup failed: OMDb HTTP 525',
    `History's row reads as it did on 2026-10-12: ${row?.status}, "${row?.detail}"`);
  ok(h.logs.includes('OMDb lookup failed for "First daughter 2004": OMDb HTTP 525'), 'and so does the plugin\'s log line');
  ok(!h.out.some((e) => e.text), 'no reply is added: the reaction is the whole answer, as before');

  // The hourly check's scanner offers it for a re-run, as it did the
  // incident's row.
  const at = Date.now();
  const r = scan({
    now: at + 60_000,
    config: { movieRequests: { requestGroups: [REQ], requirePrefix: true, prefix: '#request', notify: { group: 'n@g.us' } } },
    names: { [REQ]: 'MOVIE REQUESTS' },
    unit: { ActiveState: 'active', NRestarts: '0' },
    state: { 'movie-requests': { history: [row], pending: [] }, 'tv-requests': { history: [], pending: [] }, 'msg-index': { entries: [] } },
  });
  const found = r.incidents.find((f) => f.request?.id === row.id);
  ok(found?.kind === 'request-failed' && found.rerunnable, `the hourly check finds it, re-runnable (${found?.kind}, ${found?.rerunnable})`);

  // The member's next request: OMDb is noted as down, so it is tried once.
  script = [525];
  timeline.length = 0;
  const next = await ask(h, '#request First daughter 2004');
  ok(on(h, next) === '🔍 ⚠️' && timeline.filter((e) => e === 'omdb').length === 1 && !timeline.some((e) => e.startsWith('wait')),
    `within the minute, the next request is tried once and does not wait (${timeline.join(' → ')})`);
  const back = await ask(h, '#request First daughter 2004');
  ok(on(h, back) === '🔍 🎬', `and once OMDb answers, the request goes through (${on(h, back)})`);
}

console.log('=== a member\'s next request waits for one still being looked up, retries included ===');
{
  const saved = moviePlugin._cooldown;
  moviePlugin._cooldown = undefined;
  const wait = moviePlugin._cool().limits.inFlightWaitMs;
  moviePlugin._cooldown = saved;
  ok(wait >= CHAIN_LIMITS.totalMs + DEFAULT_CONFIG.library.searchTimeoutMs + OMDB_RETRY_SPAN_MS,
    `films wait ${wait / 1000} s: the AI chain, the library search and OMDb's tries together`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
