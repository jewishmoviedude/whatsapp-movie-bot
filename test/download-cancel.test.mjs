/* A cancel that lands before the server answers is reported as a cancel.
   Run: node test/download-cancel.test.mjs

   The incident, 2026-09-28: after the 01:36 and 06:43 restarts resumed a
   pile of films, an admin cancelled them seconds in. Each one that was still
   waiting for Jellyfin to answer came back from fetch() as "This operation
   was aborted", which downloadToFile passed on unmapped, so deliver() logged
   "delivery failed for Ready Player One: This operation was aborted", reacted
   ⚠️ and wrote History "failed" - eight times - where a cancel says ❌ and
   "cancelled". Only an abort during the body transfer was mapped. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { downloadToFile } from '../src/media/download.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-cancel-'));
const dest = path.join(dir, 'source.mkv');

// A server that never answers, like a Jellyfin that is slow to start a 4 GB
// stream: the cancel arrives while fetch() is still waiting for headers.
const sockets = new Set();
const server = http.createServer(() => { /* never responds */ });
server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/Items/1/Download`;

console.log('=== cancelled while waiting for the server ===');
{
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  let err = null;
  try { await downloadToFile(url, dest, { signal: ac.signal }); } catch (e) { err = e; }
  ok(err?.code === 'CANCELLED', `downloadToFile reports a cancel (got ${err?.code ?? err?.message})`);
  ok(!fs.existsSync(dest), 'and leaves no file behind');
}

console.log('=== cancelled before it started ===');
{
  const ac = new AbortController();
  ac.abort();
  let err = null;
  try { await downloadToFile(url, dest, { signal: ac.signal }); } catch (e) { err = e; }
  ok(err?.code === 'CANCELLED', 'an already-cancelled job is a cancel too');
}

console.log('=== a network failure with no cancel behind it is left as it is ===');
{
  const prev = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  let err = null;
  try { await downloadToFile(url, dest, { signal: new AbortController().signal }); } catch (e) { err = e; }
  globalThis.fetch = prev;
  ok(err?.message === 'fetch failed' && err?.code !== 'CANCELLED',
    'it stays "fetch failed", which the pipelines treat as transient');
}

for (const s of sockets) s.destroy();
server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
