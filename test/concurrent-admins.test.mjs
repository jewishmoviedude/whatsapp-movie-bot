/* Two admins using the portal at the same time.
   Run: node test/concurrent-admins.test.mjs

   Node is single-threaded, so simultaneous requests cannot tear in-memory
   state. What they CAN do is interleave multi-step operations - stop the bot,
   rewrite config, start it again - and leave the config naming one number
   while the socket connects as another. And a settings save is read-modify-
   write, so two admins editing different tabs can silently undo each other.

   This drives the real router over real HTTP with two distinct sessions. */
import express from 'express';
import http from 'node:http';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

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

const BASE = {
  web: { adminPasswordHash: 'x', users: [{ username: 'admin', role: 'superadmin', passwordHash: 'x' }] },
  movieRequests: { requestGroups: ['g@g.us'], enforcement: { enabled: true }, maxQueueLength: 50, reactions: {}, cooldownSecondsPerUser: 30 },
  media: { concurrency: 2 },
  omdb: { apiKey: 'k' },
  whatsapp: {
    activeAccount: 'main',
    accounts: [
      { id: 'main', label: 'Main', phoneNumber: '15558060189' },
      { id: 'spare', label: 'Spare', phoneNumber: '15558110179' },
    ],
    failover: { enabled: false, order: [] },
  },
  tvRequests: {}, directLinks: {}, queue: {}, lockdown: {},
};

function makeConfigStore() {
  let cfg = JSON.parse(JSON.stringify(BASE));
  let writes = 0;
  return {
    get: () => cfg,
    update: (patch) => {
      writes += 1;
      const merge = (a, b) => {
        for (const [k, v] of Object.entries(b)) {
          if (v && typeof v === 'object' && !Array.isArray(v)) merge(a[k] ??= {}, v);
          else a[k] = v;
        }
        return a;
      };
      cfg = merge(JSON.parse(JSON.stringify(cfg)), patch);
      return cfg;
    },
    redacted: () => ({ ok: true }),
    onChange: () => {},
    get writes() { return writes; },
  };
}

async function boot() {
  const stateStore = makeStateStore();
  const configStore = makeConfigStore();
  const queue = new JobQueue({ concurrency: 1 });
  queue.pause();

  // A bot whose stop/start take real time, which is what creates the interleave.
  let stops = 0, starts = 0;
  const bot = {
    dataDir: '/tmp', state: 'connected', groupCache: new Map(), groups: () => [], on: () => {},
    stop: async () => { stops += 1; await new Promise((r) => setTimeout(r, 40)); },
    start: async () => { starts += 1; await new Promise((r) => setTimeout(r, 40)); },
    get counts() { return { stops, starts }; },
  };

  const app = express();
  app.use(express.json());
  // Each request carries whichever admin the caller says it is.
  app.use((req, _res, next) => {
    req.session = { user: { username: req.headers['x-who'] || 'admin1', role: 'superadmin' } };
    next();
  });
  app.use('/api', createApiRouter({
    configStore, bot, queue, linkQueue: new JobQueue({ concurrency: 1 }),
    pluginManager: { plugins: new Map(), notifyConfigChange: async () => {} },
    stateStore, fileLogger: { tail: () => [] }, alerts: {},
    lockScheduler: {}, failover: null,
  }));

  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return { server, port: server.address().port, configStore, bot, queue,
           events: () => stateStore.namespace('audit').get('events', []) };
}

function req(port, method, path, body, who = 'admin1') {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { 'x-who': who };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const t = await boot();
const { port } = t;

console.log('=== two admins reading at once ===');
{
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    req(port, 'GET', '/api/config', undefined, i % 2 ? 'mommy' : 'other')));
  ok(rs.every((r) => r.status === 200), 'every concurrent read succeeds');
  ok(rs.length === 12, 'nothing is dropped');
}

console.log('=== two admins saving different settings at the same time ===');
{
  const [a, b] = await Promise.all([
    req(port, 'PUT', '/api/config', { movieRequests: { maxQueueLength: 99 } }, 'mommy'),
    req(port, 'PUT', '/api/config', { media: { concurrency: 5 } }, 'other'),
  ]);
  ok(a.status === 200 && b.status === 200, 'both saves succeed — neither errors out');
  const cfg = t.configStore.get();
  ok(cfg.movieRequests.maxQueueLength === 99, "the first admin's change survived");
  ok(cfg.media.concurrency === 5, "and so did the second's — a patch merges, it does not replace");
}

console.log('=== both saves are attributed, separately ===');
{
  const users = t.events().filter((e) => e.action === 'changed settings').map((e) => e.user);
  ok(users.includes('mommy') && users.includes('other'),
    `each admin's change is recorded against them: ${[...new Set(users)].join(', ')}`);
}

console.log('=== but editing the SAME field is last-write-wins ===');
{
  // Worth knowing rather than discovering: the API takes a patch, so two
  // admins on the same field silently overwrite, with no conflict reported.
  await Promise.all([
    req(port, 'PUT', '/api/config', { movieRequests: { maxQueueLength: 10 } }, 'mommy'),
    req(port, 'PUT', '/api/config', { movieRequests: { maxQueueLength: 20 } }, 'other'),
  ]);
  const v = t.configStore.get().movieRequests.maxQueueLength;
  ok(v === 10 || v === 20, `one of the two values wins cleanly (${v}) — no torn or merged nonsense`);
  const rows = t.events().filter((e) => e.action === 'changed settings');
  ok(rows.length >= 4, 'and the audit log shows both attempts, so the overwrite is traceable');
}

console.log('=== two admins switching numbers at once ===');
{
  const before = t.bot.counts.stops;
  const [a, b] = await Promise.all([
    req(port, 'POST', '/api/wa/accounts/spare/activate', undefined, 'mommy'),
    req(port, 'POST', '/api/wa/accounts/main/activate', undefined, 'other'),
  ]);
  const codes = [a.status, b.status].sort();
  ok(codes[0] === 200 && codes[1] === 409,
    `one switch runs and the other is refused (${codes.join(' and ')}) — not two interleaved stop/start cycles`);
  ok(t.bot.counts.stops === before + 1, 'the bot was stopped exactly once');
  ok(/already in progress/.test(a.status === 409 ? a.body : b.body), 'and the refusal explains itself');
}

console.log('=== a refused switch does not wedge the lock ===');
{
  const r = await req(port, 'POST', '/api/wa/accounts/main/activate');
  ok(r.status === 200, 'a later switch works normally once the first finished');
}

console.log('=== two admins cancelling the same job ===');
{
  const id = t.queue.add({ label: 'Contested (2020)', run: async () => {} });
  const [a, b] = await Promise.all([
    req(port, 'DELETE', `/api/queue/${id}`, undefined, 'mommy'),
    req(port, 'DELETE', `/api/queue/${id}`, undefined, 'other'),
  ]);
  const codes = [a.status, b.status].sort();
  ok(codes[0] === 200 && codes[1] === 404,
    `one cancels it, the other is told it is already gone (${codes.join(' and ')})`);
  const cancels = t.events().filter((e) => /cancelled "Contested/.test(e.action));
  ok(cancels.length === 1, 'and only ONE cancellation is recorded, not two');
}

console.log('=== a burst of mixed writes leaves the config coherent ===');
{
  await Promise.all([
    req(port, 'PUT', '/api/config', { movieRequests: { cooldownSecondsPerUser: 45 } }, 'mommy'),
    req(port, 'PUT', '/api/config', { media: { concurrency: 3 } }, 'other'),
    req(port, 'PUT', '/api/wa/failover', { order: ['spare', 'main'] }, 'mommy'),
    req(port, 'GET', '/api/queue', undefined, 'other'),
  ]);
  const cfg = t.configStore.get();
  ok(cfg.movieRequests.cooldownSecondsPerUser === 45, 'one setting landed');
  ok(cfg.media.concurrency === 3, 'the other landed');
  ok(cfg.whatsapp.failover.order[0] === 'spare', 'and so did the failover order');
  ok(cfg.movieRequests.requestGroups.length === 1, 'untouched settings are still intact');
  ok(typeof cfg.whatsapp.accounts[0].id === 'string', 'the config is structurally sound');
}

t.server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
