/* Queue a film straight from a Jellyfin link.
   Run: node test/queue-from-url.test.mjs

   Why it exists: OMDb canonicalises "f1" to "F1: The Movie" while Jellyfin
   holds it as "F1", so the search never matched and the requester was told
   "not in your library" for a film sitting right there. The matcher is fuzzy
   and will keep being wrong sometimes; the item id is not. */
import './fixtures/roomy-disk.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJellyfinUrl, stripSecrets } from '../src/core/jellyfin-url.js';
import plugin from '../src/plugins/movie-requests/index.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const ID = '39b452edcb8e1db19bb78cf69764ab4b';

console.log('=== every shape of Jellyfin link an admin might paste ===');
{
  for (const [label, url] of [
    ['a Download link', `https://srv.example.org/Items/${ID}/Download?api_key=KEY`],
    ['a stream link', `https://srv.example.org/Videos/${ID}/stream?static=true`],
    ['the browser address', `https://srv.example.org/web/#/details?id=${ID}`],
    ['just the id', ID],
    ['the id in caps', ID.toUpperCase()],
  ]) {
    const p = parseJellyfinUrl(url);
    ok(p?.id === ID, `${label} → the right item id`);
  }
}

console.log('=== anything without an item id is refused ===');
{
  for (const bad of [
    'https://srv.example.org/web/#/search?query=f1',
    'https://example.com',
    'f1',
    '',
    null,
    'not a url at all',
    'https://srv.example.org/Items/tooshort/Download',
  ]) {
    ok(parseJellyfinUrl(bad) === null, `refused: ${JSON.stringify(bad)?.slice(0, 44)}`);
  }
}

console.log('=== the api key in a pasted URL is never echoed ===');
{
  const raw = `https://srv.example.org/Items/${ID}/Download?api_key=0123456789abcdef0123456789abcdef`;
  const safe = stripSecrets(raw);
  ok(!safe.includes('0123456789abcdef0123456789abcdef'), `the key is masked: ${safe.slice(-24)}`);
  ok(safe.includes('api_key=***'), 'and visibly so, rather than removed');
  ok(stripSecrets(`https://x/y?X-Emby-Token=abc`).includes('***'), 'the token form too');

  // The route must not put the raw URL into the audit detail either.
  const api = fs.readFileSync(new URL('../src/web/api.js', import.meta.url), 'utf8');
  const route = api.match(/router\.post\('\/queue\/from-url'[\s\S]*?\n  \}\);/)[0];
  ok(!/req\.body\?\.url/.test(route.split('audit(')[1] ?? ''), 'the audit line records the item id, not the URL');
  ok(/item \$\{parsed\.id\}/.test(route), 'which is the part worth keeping anyway');
}

console.log('=== the rating gate still applies ===');
{
  const ctx = {
    config: { movieRequests: { postsGroup: 'posts@g.us', blockedRatings: ['R', 'NC-17', 'X', 'TV-MA'] } },
    log: { info() {}, warn() {}, debug() {} },
    store: { get: (k, d) => d, set() {} },
    queue: { add() {} },
  };
  let threw = null;
  try {
    await plugin.queueLibraryItem({ id: ID, title: 'Some R Film', year: 2020, rated: 'R' }, ctx);
  } catch (e) { threw = e; }
  ok(!!threw && /blocked list/.test(threw.message),
    'a blocked rating is refused — pasting a link is not a way round the policy');
}

console.log('=== an unrated file is refused, not assumed sendable ===');
{
  // Jellyfin leaves OfficialRating empty on plenty of files. Unrated is the
  // case nobody has checked, and an admin pasting a link is MORE likely to
  // have skipped looking.
  const ctx = {
    config: { movieRequests: { postsGroup: 'posts@g.us', blockedRatings: ['R'] } },
    log: { info() {}, warn() {}, debug() {} },
    store: { get: (k, d) => d, set() {} },
    queue: { add() {} },
  };
  for (const rated of [null, '', '   ']) {
    let threw = null;
    try { await plugin.queueLibraryItem({ id: ID, title: 'Unrated', year: 2020, rated }, ctx); }
    catch (e) { threw = e; }
    ok(!!threw && /no rating set/.test(threw.message), `rated ${JSON.stringify(rated)} is refused`);
  }
}

console.log('=== a clean film is queued, with no title matching at all ===');
{
  const added = [];
  const ctx = {
    config: { movieRequests: { postsGroup: 'posts@g.us', blockedRatings: ['R'] } },
    log: { info() {}, warn() {}, debug() {} },
    store: { get: (k, d) => d, set() {} },
    queue: { add: (j) => added.push(j) },
  };
  const r = await plugin.queueLibraryItem(
    { id: ID, title: 'F1', year: 2025, rated: 'PG-13', localPath: '/mnt/f1.mkv',
      downloadUrl: 'https://srv/Items/x/Download', headers: {} },
    ctx, { requester: 'panel (mommy)' });

  ok(r.title === 'F1' && r.year === 2025, 'it reports what was queued');
  ok(added.length === 1, 'one job was added');
  ok(added[0].label === 'F1 (2025)', `labelled by the LIBRARY's title, not OMDb's: "${added[0].label}"`);
  ok(added[0].meta.requester === 'panel (mommy)', 'attributed to the admin who pasted it');
}

console.log('=== and the search itself now tries what was actually typed ===');
{
  const lib = fs.readFileSync(new URL('../src/plugins/movie-requests/library.js', import.meta.url), 'utf8');
  ok(/alsoTry = \[\]/.test(lib), 'findInLibrary accepts extra titles to try');
  ok(/library hit on "\$\{t\}" rather than "\$\{title\}"/.test(lib),
    'and says so when the fallback is what matched');
  const idx = fs.readFileSync(new URL('../src/plugins/movie-requests/index.js', import.meta.url), 'utf8');
  ok(/alsoTry: \[text, record\.request\]/.test(idx),
    'the request handler passes the raw request text — the fix for the whole class');
}

console.log('=== the download carries the Jellyfin token ===');
{
  // 2026-09-23 15:27: "Glass Onion" queued from a link failed 0.14s later with
  // "download failed: HTTP 401 Unauthorized", and the start line read "from
  // undefined". The job was built with `headers`, while the downloader reads
  // `copy.downloadHeaders` - so it asked Jellyfin for the file with no token.
  const added = [];
  const ctx = {
    config: {
      movieRequests: { postsGroup: 'posts@g.us', blockedRatings: ['R'], reactions: {}, notify: { steps: {} } },
      media: { workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'link-auth-')), maxOutputBytes: 2e9, concurrency: 1, pipeline: {} },
    },
    log: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), debug() {}, error: (m) => logs.push(String(m)) },
    store: { get: (k, d) => d, set() {}, push() {} },
    queue: { add: (j) => added.push(j) },
    bot: { isConnected: () => true, react: async () => {}, sendText: async () => ({}), sendDocument: async () => ({}), groups: () => [], on() {}, off() {} },
  };
  const logs = [];
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    asked.push({ url: String(url), headers: init.headers ?? null });
    return { ok: false, status: 401, statusText: 'Unauthorized', headers: new Map(), body: null,
             text: async () => '', json: async () => ({}) };
  };
  try {
    await plugin.queueLibraryItem(
      { id: ID, title: 'Glass Onion', year: 2022, rated: 'PG-13', localPath: '/mnt/stor01/glass onion.mp4',
        downloadUrl: 'https://srv/Items/x/Download', headers: { 'X-Emby-Token': 'THE-TOKEN', Accept: 'application/json' } },
      ctx, { requester: 'panel (mommy)' });
    // The queue passes the job in; run() stamps the work file with job.id.
    // The same job shape the queue passes in (see src/core/queue.js).
    const job = { id: 'test-job', progress() {}, isCancelled: () => false, cancelReason: () => null };
    await added[0].run(job).catch(() => {});   // the download is meant to fail; the request is the point
  } finally { globalThis.fetch = realFetch; }

  const dl = asked.find((a) => /\/Download$/.test(a.url));
  ok(!!dl, `the file was asked for (${asked.length} request(s) made)`);
  ok(dl?.headers?.['X-Emby-Token'] === 'THE-TOKEN',
    `with the Jellyfin token, so it is not a 401: ${JSON.stringify(dl?.headers ?? null)}`);
  ok(logs.some((l) => /download START/.test(l) && /from jellyfin/.test(l)),
    `and the start line names the provider: "${logs.find((l) => /download START/.test(l)) ?? '(none)'}"`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
