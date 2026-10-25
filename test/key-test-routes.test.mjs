/* Test key for OMDb, TMDB and the Jellyfin share key.
   Run: node test/key-test-routes.test.mjs

   Asked for while gathering every API key into one settings section: "a Test
   button ... same pattern and secrecy as the AI Test route". Only the AI keys
   had one. The other three could be proved right or wrong only by waiting for
   a real request to go wrong in a group, and an OMDb key copied one character
   short looks exactly like an empty library: every request comes back "not
   found".

   These routes run beside a live bot, so the AI route's rules apply here and
   are pinned below:

   - a key typed into the box is tested without being saved, and never appears
     in the response, a log line or the audit trail - not even when the
     service quotes it back inside its own error message;
   - an empty box, or the mask the panel shows in place of a saved key, tests
     the SAVED key;
   - a bad key, an unreachable service and a timeout each say which they were,
     because "it didn't work" sends somebody to re-paste a key that was fine;
   - one test per key every few seconds, and only for a signed-in admin;
   - nothing is written: not config.json, not the health status.

   It drives the real ConfigStore and the real router over HTTP. There is no
   network: fetch is stubbed with the shapes OMDb, TMDB and Jellyfin really
   answer with, and any request this suite did not expect fails it. */
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from '../src/util/logger.js';
import { ConfigStore, MASK } from '../src/config/store.js';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';
import { hashPassword } from '../src/util/crypto.js';
import { KEY_TEST } from '../src/core/ai-providers.js';
import { TESTABLE_KEYS, outcomeWord } from '../src/web/key-test-routes.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const lines = [];
log.on('line', (e) => lines.push(`${e.level} ${e.scope}: ${e.msg}`));

/* ------------------------------ fixtures ------------------------------ */

const OMDB_KEY = 'omdbSAVED1';
const TYPED_OMDB_KEY = 'omdbTYPED2';
const TMDB_KEY = 'tmdbSAVED0123456789abcdef01234567';
const TYPED_TMDB_KEY = 'tmdbTYPED0123456789abcdef01234567';
const SHARE_KEY = 'shareSAVED0123456789abcdef012345';
const TYPED_SHARE_KEY = 'shareTYPED0123456789abcdef012345';
const GEMINI_KEY = 'AIzaSyTESTgemini_0123456789-abcdefghij';
const KEYS = [OMDB_KEY, TYPED_OMDB_KEY, TMDB_KEY, TYPED_TMDB_KEY, SHARE_KEY, TYPED_SHARE_KEY, GEMINI_KEY];
const hasKey = (s) => KEYS.some((k) => String(s).includes(k));

const JELLYFIN = 'http://10.0.0.5:8096';

// The rate limit is a real few seconds. Rather than sleep, the clock moves on.
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew;
const later = () => { skew += KEY_TEST.gapMs + 1000; };

const json = (status, payload) => new Response(
  typeof payload === 'string' ? payload : JSON.stringify(payload),
  { status, headers: { 'content-type': 'application/json' } },
);

// OMDb answers a bad key with a 401 and Response:"False"; this stand-in also
// echoes the key back, which OMDb does not, to prove it is scrubbed anyway.
const OMDB_OK = { Response: 'True', Title: 'The Matrix', Year: '1999', Rated: 'R', imdbID: 'tt0133093', Type: 'movie' };
const OMDB_BAD = (key) => json(401, { Response: 'False', Error: `Invalid API key! (${key})` });
const TMDB_OK = { images: { base_url: 'http://image.tmdb.org/t/p/', secure_base_url: 'https://image.tmdb.org/t/p/' }, change_keys: ['budget'] };
const TMDB_BAD = { status_code: 7, status_message: 'Invalid API key: You must be granted a valid key.', success: false };
const JF_OK = { ServerName: 'media1', Version: '10.9.11', Id: 'a1b2', OperatingSystem: 'Linux' };

/**
 * Every outbound request is answered here and recorded with the key it
 * carried. Anything this suite did not expect fails it instead of reaching
 * the internet. `scene` lets one case make a service fail.
 */
const outbound = [];
const scene = { omdb: null, tmdb: null, jellyfin: null };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const key = u.searchParams.get('apikey') ?? u.searchParams.get('api_key')
    ?? (init.headers ?? {})['X-Emby-Token'] ?? null;
  const call = { url: u.toString(), key, signal: init.signal ?? null };
  outbound.push(call);

  if (u.host === 'www.omdbapi.com') {
    if (scene.omdb) return scene.omdb(call);
    return key === OMDB_KEY || key === TYPED_OMDB_KEY ? json(200, OMDB_OK) : OMDB_BAD(key);
  }
  if (u.host === 'api.themoviedb.org') {
    if (scene.tmdb) return scene.tmdb(call);
    if (u.pathname !== '/3/configuration') throw new Error(`unexpected TMDB path ${u.pathname}`);
    return key === TMDB_KEY || key === TYPED_TMDB_KEY ? json(200, TMDB_OK) : json(401, TMDB_BAD);
  }
  if (u.host === '10.0.0.5:8096') {
    if (scene.jellyfin) return scene.jellyfin(call);
    if (u.pathname !== '/System/Info') throw new Error(`unexpected Jellyfin path ${u.pathname}`);
    return key === SHARE_KEY || key === TYPED_SHARE_KEY ? json(200, JF_OK) : json(401, 'Unauthorized');
  }
  throw new Error(`test made an unexpected request to ${u}`);
};
const sent = (from) => outbound.slice(from);

/* ------------------------------ the server ------------------------------ */

function makeStateStore() {
  const spaces = new Map();
  return {
    namespace(name) {
      if (!spaces.has(name)) spaces.set(name, { data: {} });
      const sp = spaces.get(name);
      return {
        get: (k, d) => sp.data[k] ?? d,
        set: (k, v) => { sp.data[k] = v; },
        push: (k, v) => { (sp.data[k] ??= []).unshift(v); },
      };
    },
  };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-test-routes-'));
const configStore = new ConfigStore({ dataDir: dir, masterKey: 'test-master-key-for-the-key-routes' });
configStore.load();
configStore.update({
  web: { admins: [{ username: 'mommy', role: 'superadmin', passwordHash: hashPassword('x-password-1') }] },
  omdb: { apiKey: OMDB_KEY },
  gemini: { apiKey: GEMINI_KEY },
  movieRequests: { theatrical: { tmdbApiKey: TMDB_KEY } },
  directLinks: { apiKey: SHARE_KEY },
  library: { jellyfin: { baseUrl: JELLYFIN } },
});
const stateStore = makeStateStore();

let who = { username: 'mommy', role: 'superadmin' };
const queue = new JobQueue({ concurrency: 1 });
queue.pause();
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = who ? { user: who } : {}; next(); });
app.use('/api', createApiRouter({
  configStore,
  bot: { groupCache: new Map(), groups: () => [], on: () => {}, state: 'connected' },
  queue,
  linkQueue: queue,
  pluginManager: { plugins: new Map(), notifyConfigChange: async () => {}, list: () => [] },
  stateStore,
  fileLogger: { tail: () => [] },
  alerts: {},
  lockScheduler: {},
}));
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const port = server.address().port;
const events = () => stateStore.namespace('audit').get('events', []);
const configOnDisk = () => fs.readFileSync(path.join(dir, 'config.json'), 'utf8');

const everyResponse = [];
function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
    (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(buf); } catch { /* not JSON */ }
        everyResponse.push(buf);
        resolve({ status: res.statusCode, text: buf, json: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
/** One test, with the rate limit's window already past. */
const test = async (id, body) => { later(); return request('POST', `/api/keys/${id}/test`, body); };

/* ------------------------------ the tests ------------------------------ */

console.log('=== every key in the section has a route, and they are the non-AI ones ===');
{
  ok(Object.keys(TESTABLE_KEYS).join() === 'omdb,tmdb,direct-links', 'OMDb, TMDB and the share key');
  ok(Object.values(TESTABLE_KEYS).every((k) => typeof k.probe === 'function' && k.path.includes('.')),
    'each names the config path its saved key lives at');
  const r = await request('POST', '/api/keys/nonsense/test', {});
  ok(r.status === 404, 'an unknown key is a 404, not a test of nothing');
}

console.log('=== a key typed into the box is tested, and not saved ===');
{
  const disk = configOnDisk();
  const from = outbound.length;
  const r = await test('omdb', { apiKey: TYPED_OMDB_KEY });
  ok(r.status === 200 && r.json.ok === true, `the typed key works (${r.status}: ${r.json?.message})`);
  ok(sent(from).length === 1 && sent(from)[0].key === TYPED_OMDB_KEY,
    'the one request to OMDb carried the typed key, not the saved one');
  ok(sent(from)[0].url.startsWith('https://www.omdbapi.com/') && /t=The\+Matrix/.test(sent(from)[0].url),
    'as a lookup of the fixed title, which is what proves the key');
  ok(configStore.get().omdb.apiKey === OMDB_KEY, 'the saved key is still the saved key');
  ok(configOnDisk() === disk, 'and config.json was not written at all');
  ok(!hasKey(r.text), 'the response carries no key');
  const row = events()[0];
  ok(row?.action === 'tested the OMDb key: ok', `the audit row names the key and the outcome: "${row?.action}"`);
  ok(row?.detail === 'a key typed into the panel, not saved', `and says which key was tested: "${row?.detail}"`);
  ok(!hasKey(JSON.stringify(row)), 'with no key in it');
}

console.log('=== an empty box, and the mask, test the saved key ===');
{
  for (const [what, body] of [['an empty body', {}], ['a blank box', { apiKey: '' }], ['the mask', { apiKey: MASK }]]) {
    const from = outbound.length;
    const r = await test('tmdb', body);
    ok(r.status === 200 && r.json.ok === true && sent(from).every((c) => c.key === TMDB_KEY),
      `${what}: TMDB was asked with the saved key`);
  }
  const from = outbound.length;
  await test('tmdb', {});
  ok(sent(from)[0].url === `https://api.themoviedb.org/3/configuration?api_key=${TMDB_KEY}`,
    'through /3/configuration, which is free');
}

console.log('=== the share key is tried against the configured Jellyfin ===');
{
  const from = outbound.length;
  const r = await test('direct-links', { apiKey: TYPED_SHARE_KEY });
  ok(r.status === 200 && r.json.ok === true, `it works (${r.json?.message})`);
  ok(/media1/.test(r.json.message) && /10\.9\.11/.test(r.json.message),
    'and names the server it reached, so a key aimed at the wrong Jellyfin shows up');
  ok(sent(from)[0].url === `${JELLYFIN}/System/Info` && sent(from)[0].key === TYPED_SHARE_KEY,
    'GET /System/Info with that key, which costs nothing');
  ok(events()[0].action === 'tested the Jellyfin share key: ok', `audited as "${events()[0].action}"`);
}

console.log('=== a bad key says so, and the key never appears anywhere ===');
{
  const badOmdb = 'omdbWRONG9';
  const before = lines.length;
  const r = await test('omdb', { apiKey: badOmdb });
  ok(r.status === 200 && r.json.ok === false && r.json.reason === 'auth',
    `refused, and said why (${r.json?.reason}: ${r.json?.message})`);
  ok(r.json.message === '✗ OMDb rejected the key', `in plain words: "${r.json.message}"`);
  ok(!r.text.includes(badOmdb), 'the response does not quote the key back, although OMDb did');
  const said = lines.slice(before);
  ok(said.length > 0 && !said.some((l) => l.includes(badOmdb)), 'nor does any log line');
  ok(!said.some((l) => l.startsWith('error')), 'and nothing was logged at error level, which would email an alert');
  ok(events()[0].action === 'tested the OMDb key: bad key', `audited as "${events()[0].action}"`);

  const t = await test('tmdb', { apiKey: 'tmdbWRONG0123456789abcdef0123456' });
  ok(t.json.ok === false && t.json.message === '✗ TMDB rejected the key', `TMDB the same: "${t.json.message}"`);
  const j = await test('direct-links', { apiKey: 'shareWRONG0123456789abcdef01234' });
  ok(j.json.ok === false && j.json.message === '✗ Jellyfin rejected the key', `and Jellyfin: "${j.json.message}"`);
}

console.log('=== a service that cannot be reached is not reported as a bad key ===');
{
  scene.jellyfin = () => { throw new TypeError('fetch failed'); };
  const r = await test('direct-links', {});
  ok(r.json.ok === false && r.json.reason === 'network', `unreachable, not "bad key" (${r.json.reason})`);
  ok(/Could not reach Jellyfin/.test(r.json.message), `"${r.json.message}"`);
  ok(events()[0].action === 'tested the Jellyfin share key: unreachable', `audited as "${events()[0].action}"`);

  scene.jellyfin = () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };
  const t = await test('direct-links', {});
  ok(t.json.ok === false && t.json.reason === 'timeout' && /did not answer within/.test(t.json.message),
    `a timeout says so too: "${t.json.message}"`);

  scene.tmdb = () => json(503, 'upstream is down');
  const s = await test('tmdb', {});
  ok(s.json.ok === false && s.json.reason === 'server' && /HTTP 503/.test(s.json.message),
    `and a 5xx is the service failing, not the key: "${s.json.message}"`);

  // OMDb is the one that could not say. Its probe goes through testApiKey(),
  // which catches everything and hands back the message as a string, so the
  // route's own catch never fires and both of these arrived as an answer it
  // could not read: the pill said "odd answer" and the line said "OMDb did
  // not answer as expected - fetch failed", about a key that was fine.
  scene.omdb = () => { throw new TypeError('fetch failed'); };
  const o = await test('omdb', {});
  ok(o.json.ok === false && o.json.reason === 'network' && /Could not reach OMDb/.test(o.json.message),
    `OMDb unreachable reads as unreachable: "${o.json.message}"`);
  ok(events()[0].action === 'tested the OMDb key: unreachable', `audited as "${events()[0].action}"`);

  scene.omdb = () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; };
  const ot = await test('omdb', {});
  ok(ot.json.ok === false && ot.json.reason === 'timeout' && /did not answer within/.test(ot.json.message),
    `and an OMDb timeout as a timeout: "${ot.json.message}"`);

  // A genuinely odd answer must still be the last resort, or the two useful
  // words above would swallow the case they were carved out of.
  scene.omdb = () => json(200, { Response: 'False', Error: 'Something new happened' });
  const oo = await test('omdb', {});
  ok(oo.json.ok === false && oo.json.reason === 'unreadable' && /did not answer as expected/.test(oo.json.message),
    `while an answer nobody can read is still just that: "${oo.json.message}"`);

  scene.jellyfin = null;
  scene.tmdb = null;
  scene.omdb = null;
}

console.log('=== a test every few seconds, per key ===');
{
  const from = outbound.length;
  await test('omdb', {});
  const again = await request('POST', '/api/keys/omdb/test', {});
  ok(again.status === 429 && again.json.reason === 'rate-limited', `a second OMDb test straight away is refused (${again.status})`);
  ok(/wait \d+ s/.test(again.json.message), `and says how long to wait: "${again.json.message}"`);
  const other = await request('POST', '/api/keys/tmdb/test', {});
  ok(other.status === 200, 'but the limit is per key, so TMDB can still be tested');
  ok(sent(from).length === 2, 'the refused test made no request at all');
}

console.log('=== nothing to test, and nothing that is not a key ===');
{
  configStore.update({ movieRequests: { theatrical: { tmdbApiKey: '' } } });
  const r = await test('tmdb', {});
  ok(r.status === 400 && r.json.reason === 'no-key' && /paste one into the box/.test(r.json.message),
    `no key saved and none typed: "${r.json?.message}"`);
  configStore.update({ movieRequests: { theatrical: { tmdbApiKey: TMDB_KEY } } });

  const from = outbound.length;
  const junk = await test('omdb', { apiKey: 'Bearer omdbSAVED1\nand a note' });
  ok(junk.status === 400 && junk.json.reason === 'key-shape', 'a key with junk around it is refused before it is sent');
  ok(sent(from).length === 0 && !hasKey(junk.text) && !lines.at(-1).includes('omdbSAVED1'),
    'and neither the response nor the log repeats what was pasted');
  // "a OMDb key" and "a TMDB key" both read wrong, and this sentence is shown
  // under the Test button of whichever key was refused.
  ok(!/\ba (?:OMDb|TMDB)\b/.test(junk.json.message), `and it is a sentence: "${junk.json.message}"`);
  const jt = await test('tmdb', { apiKey: 'Bearer some thing with spaces' });
  ok(jt.status === 400 && !/\ba TMDB\b/.test(jt.json.message), `for TMDB too: "${jt.json.message}"`);
}

console.log('=== the share key test needs somewhere to send it ===');
{
  configStore.update({ library: { jellyfin: { baseUrl: '' } } });
  const r = await test('direct-links', {});
  ok(r.json.ok === false && r.json.reason === 'no-server' && /server URL in Library/.test(r.json.message),
    `it says what is missing: "${r.json.message}"`);
  configStore.update({ library: { jellyfin: { baseUrl: JELLYFIN } } });
}

console.log('=== only a signed-in admin may test a key ===');
{
  who = null;
  const from = outbound.length;
  const r = await test('omdb', { apiKey: TYPED_OMDB_KEY });
  ok(r.status === 401, `signed out: ${r.status}`);
  ok(sent(from).length === 0, 'and no request left the machine');
  who = { username: 'mommy', role: 'superadmin' };
}

console.log('=== the outcome words the audit trail uses ===');
{
  ok(outcomeWord({ ok: true }) === 'ok' && outcomeWord({ ok: false, reason: 'auth' }) === 'bad key',
    'ok / bad key, as the AI keys already say it');
  ok(outcomeWord({ ok: false, reason: 'something-new' }) === 'failed', 'and an unknown reason still reads as a failure');
}

console.log('=== no key, saved or typed, reached any response ===');
{
  ok(!everyResponse.some(hasKey), `none of the ${everyResponse.length} responses carried a key`);
  ok(!lines.some(hasKey), `nor any of the ${lines.length} log lines`);
  ok(!JSON.stringify(events()).includes(TYPED_OMDB_KEY) && !JSON.stringify(events()).includes(OMDB_KEY),
    'nor the audit trail');
}

server.close();
Date.now = realNow;
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
