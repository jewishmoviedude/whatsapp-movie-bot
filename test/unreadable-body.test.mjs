/* A request body the server cannot read is refused without quoting it.
   Run: node test/unreadable-body.test.mjs

   Found reviewing the Test button on Settings → AI providers (2026-09-22).
   That button sends an API key typed into the box and never saved. A body
   that was not valid JSON - the key pasted without its quotes, say - was
   refused by express.json() before the route ran, and the catch-all in
   src/web/server.js logged `unhandled: ${err.message}` at error level and
   answered 500 with the same message. On Node 20 that message quotes the
   start of the body, so the first characters of the typed key came back in
   the response and went into an error line, which the alert watcher emails.

   This drives the real server (createServer), because the leak was in its
   last error handler, not in any route. No network: fetch throws if called. */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import log from '../src/util/logger.js';
import { createServer } from '../src/web/server.js';
import { ConfigStore } from '../src/config/store.js';
import { JobQueue } from '../src/core/queue.js';
import { hashPassword } from '../src/util/crypto.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const lines = [];
log.on('line', (e) => lines.push({ level: e.level, msg: `${e.scope}: ${e.msg}` }));

let fetched = 0;
globalThis.fetch = async (url) => { fetched += 1; throw new Error(`test made an unexpected request to ${url}`); };

// The start of a Groq key is what the parser's message quoted. Any run of it
// long enough to identify the key is a leak, so the check is on a prefix.
const TYPED = 'gsk_PROBEtypedKEY0123456789abcdefghijklmnopqrstuvwxyzAB';
const leaks = (s) => String(s).includes(TYPED.slice(0, 9));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unreadable-body-'));
const cs = new ConfigStore({ dataDir: dir, masterKey: 'test-master-key-0123456789abcdef' });
cs.load();
cs.update({
  web: { admins: [{ username: 'mommy', role: 'superadmin', passwordHash: hashPassword('x-password-1'), createdAt: 1, lastLogin: null }] },
  media: { workDir: path.join(dir, 'media') },
});
const sp = new Map();
const stateStore = { namespace(n) {
  if (!sp.has(n)) sp.set(n, {});
  const d = sp.get(n);
  return { get: (k, v) => d[k] ?? v, set: (k, v) => { d[k] = v; }, push: (k, v) => { (d[k] ??= []).unshift(v); } };
} };
const bot = Object.assign(new EventEmitter(), {
  dataDir: dir, groupCache: new Map(), groups: () => [], state: 'connected',
  status: () => ({ state: 'connected' }), isConnected: () => true,
});
const app = createServer({
  configStore: cs, bot,
  queue: new JobQueue({ concurrency: 1 }), linkQueue: new JobQueue({ concurrency: 1 }),
  pluginManager: { plugins: new Map(), notifyConfigChange: async () => {} },
  stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {}, failover: null,
});
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const port = server.address().port;

/** Sends this exact text as the body; JSON.stringify could not write a broken one. */
const send = (method, p, raw) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, (res) => {
    let buf = '';
    res.on('data', (c) => { buf += c; });
    res.on('end', () => resolve({ status: res.statusCode, text: buf, json: (() => { try { return JSON.parse(buf); } catch { return null; } })() }));
  });
  r.on('error', reject);
  r.write(raw);
  r.end();
});

console.log('=== a typed key in a body that is not JSON is not quoted back ===');
for (const [method, p] of [['POST', '/api/ai/providers/groq/test'], ['PUT', '/api/ai/providers']]) {
  const from = lines.length;
  // The key without its quotes: exactly the mistake that produced the quote.
  const r = await send(method, p, `{"apiKey": ${TYPED}, "model": ""}`);
  const logged = lines.slice(from);
  ok(r.status === 400, `${method} ${p}: refused as the client's mistake (${r.status}), not a server error`);
  ok(r.json?.error === 'The request body was not valid JSON', `with a fixed message: "${r.json?.error}"`);
  ok(!leaks(r.text), 'the response carries none of the key');
  ok(!logged.some((l) => leaks(l.msg)), 'nor does any log line');
  ok(!logged.some((l) => l.level === 'error'), 'and nothing was logged at error level, which would email an alert');
  ok(logged.some((l) => l.level === 'warn' && /not valid JSON/.test(l.msg) && l.msg.includes(p)),
    `a warning names the request: "${logged.find((l) => l.level === 'warn')?.msg}"`);
}

console.log('=== a body over the size limit is refused the same way ===');
{
  const from = lines.length;
  const r = await send('POST', '/api/ai/providers/groq/test', JSON.stringify({ apiKey: TYPED, pad: 'x'.repeat(1_100_000) }));
  ok(r.status === 413 && r.json?.error === 'The request body is too large', `413, "${r.json?.error}"`);
  ok(!leaks(r.text) && !lines.slice(from).some((l) => leaks(l.msg) || l.level === 'error'), 'quoting nothing, and no error line');
}

ok(fetched === 0, 'no request left the machine');

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
