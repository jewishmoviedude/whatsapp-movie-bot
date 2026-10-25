/* The audit log, exercised over real HTTP against the real router.
   Run: node test/audit-live.test.mjs

   The companion suite checks the pieces. This one mounts the actual API and
   makes actual requests, because the claims that matter are behavioural: one
   click writes one row, a cancellation names its title, and a secret never
   reaches the log no matter which route touched it. */
import express from 'express';
import http from 'node:http';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

/* ------------------------------------------------------------ harness --- */

function makeStateStore() {
  const spaces = new Map();
  return {
    _spaces: spaces,
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

function makeConfigStore(initial) {
  let cfg = JSON.parse(JSON.stringify(initial));
  return {
    get: () => cfg,
    update: (patch) => {
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
  };
}

const BASE_CONFIG = {
  web: { adminPasswordHash: 'x', users: [{ username: 'admin', role: 'superadmin', passwordHash: 'x' }] },
  movieRequests: { requestGroups: ['g@g.us'], enforcement: { enabled: true }, maxQueueLength: 50, reactions: {} },
  media: { concurrency: 2 },
  omdb: { apiKey: 'SECRET-BEFORE' },
  whatsapp: {
    activeAccount: 'main',
    accounts: [
      { id: 'main', label: 'Main', phoneNumber: '15558060189' },
      { id: 'rachel', label: 'Rachel', phoneNumber: '15558110179' },
    ],
    failover: { enabled: false, order: [] },
  },
  tvRequests: {}, directLinks: {}, queue: {}, lockdown: {},
};

async function boot() {
  const stateStore = makeStateStore();
  const configStore = makeConfigStore(BASE_CONFIG);
  const queue = new JobQueue({ concurrency: 1 });
  queue.pause();
  const linkQueue = new JobQueue({ concurrency: 1 });
  linkQueue.pause();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { username: 'mommy', role: 'superadmin' } }; next(); });
  app.use('/api', createApiRouter({
    configStore,
    bot: { groupCache: new Map(), groups: () => [], on: () => {}, state: 'connected' },
    queue,
    linkQueue,
    pluginManager: { plugins: new Map(), notifyConfigChange: async () => {} },
    stateStore,
    fileLogger: { tail: () => [] },
    alerts: {},
    lockScheduler: {},
  }));

  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  const events = () => stateStore.namespace('audit').get('events', []);
  return { server, port, queue, linkQueue, events, configStore };
}

function req(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/* -------------------------------------------------------------- tests --- */

const t = await boot();
const { port } = t;

console.log('=== cancelling a job records its TITLE, not just its id ===');
{
  const id = t.queue.add({ label: 'Predator: Badlands (2025)', meta: { requester: '+15558090186' }, run: async () => {} });
  const res = await req(port, 'DELETE', `/api/queue/${id}`);
  ok(res.status === 200, 'the cancel succeeds');

  const ev = t.events();
  const row = ev.find((e) => /cancelled/.test(e.action));
  ok(!!row, 'an audit row was written');
  ok(row.action.includes('Predator: Badlands (2025)'), `it names the title: "${row.action}"`);
  ok(!row.action.includes(id), 'and not the opaque id');
  ok(/\+15558090186/.test(row.detail), `the detail says who requested it: "${row.detail}"`);
  ok(row.user === 'mommy', 'attributed to the acting admin');

  // The whole point of the change: exactly ONE row for one click.
  ok(ev.length === 1, `one click wrote one row, not two (${ev.length})`);
  ok(!ev.some((e) => e.action === 'DELETE /api/queue/' + id), 'no generic path-only duplicate');
}

console.log('=== a config change names the setting that moved ===');
{
  const before = t.events().length;
  const res = await req(port, 'PUT', '/api/config', { movieRequests: { enforcement: { enabled: false } } });
  ok(res.status === 200, 'the update succeeds');
  const row = t.events()[0];
  ok(t.events().length === before + 1, 'exactly one new row');
  ok(row.action === 'changed settings', 'labelled as a settings change');
  ok(/movieRequests\.enforcement\.enabled/.test(row.detail), `naming the path: "${row.detail}"`);
  ok(/true → false/.test(row.detail), 'and the before → after');
}

console.log('=== a settings save that changes NOTHING writes nothing ===');
{
  const before = t.events().length;
  const res = await req(port, 'PUT', '/api/config', { movieRequests: { enforcement: { enabled: false } } });
  ok(res.status === 200, 'the request still succeeds');
  ok(t.events().length === before, 'but no audit row is manufactured');
}

console.log('=== a secret NEVER reaches the log, over the wire ===');
{
  const res = await req(port, 'PUT', '/api/config', { omdb: { apiKey: 'SECRET-AFTER-abc123' } });
  ok(res.status === 200, 'the key updates');
  const all = JSON.stringify(t.events());
  ok(/omdb\.apiKey: changed/.test(all), 'the change is recorded');
  ok(!all.includes('SECRET-AFTER-abc123'), 'the new value never appears in the log');
  ok(!all.includes('SECRET-BEFORE'), 'nor the old one');
}

console.log('=== clearing the queue records what was thrown away ===');
{
  t.queue.add({ label: 'A (2001)', run: async () => {} });
  t.queue.add({ label: 'B (2002)', run: async () => {} });
  await req(port, 'POST', '/api/queue/clear');
  const row = t.events()[0];
  ok(/cleared 2 waiting job\(s\)/.test(row.action), `says how many: "${row.action}"`);
  ok(row.detail.includes('A (2001)') && row.detail.includes('B (2002)'), 'and names them all');
}

console.log('=== pause / resume are distinguishable ===');
{
  await req(port, 'POST', '/api/queue/resume');
  ok(/resumed the queue/.test(t.events()[0].action), 'resume is named');
  await req(port, 'POST', '/api/queue/pause');
  ok(/paused the queue/.test(t.events()[0].action), 'pause is named');
}

console.log('=== a FAILED action writes no audit row ===');
{
  const before = t.events().length;
  const res = await req(port, 'DELETE', '/api/queue/does-not-exist');
  ok(res.status === 404, 'cancelling an unknown id 404s');
  ok(t.events().length === before, 'and nothing is logged — the log records what happened, not what was attempted');
}

console.log('=== reordering is recorded with direction ===');
{
  const a = t.queue.add({ label: 'First (2001)', run: async () => {} });
  const b = t.queue.add({ label: 'Second (2002)', run: async () => {} });
  await req(port, 'POST', `/api/queue/${b}/move`, { dir: 'top' });
  const row = t.events()[0];
  ok(/moved "Second \(2002\)" to the front/.test(row.action), `"${row.action}"`);
  await req(port, 'POST', `/api/queue/${a}/skip`);
  ok(/skipped "First \(2001\)"/.test(t.events()[0].action), 'and skip names its title too');
}

console.log('=== the failover order can be changed from the portal ===');
{
  const res = await req(port, 'PUT', '/api/wa/failover', { order: ['rachel', 'main', 'nope'] });
  ok(res.status === 200, 'the order saves');
  const saved = t.configStore.get().whatsapp.failover.order;
  ok(!saved.includes('nope'),
    'an id that is not a real account is dropped — a stale page cannot write a broken order');
  ok(saved[0] === 'rachel', `the order is kept: ${saved.join(' > ')}`);

  const row = t.events()[0];
  ok(/changed the failover order/.test(row.action), 'and the change is audited');
  ok(/rachel > main/.test(row.detail), `with the new order: "${row.detail}"`);
}

console.log('=== failover cannot be switched on with nowhere to go ===');
{
  const res = await req(port, 'PUT', '/api/wa/failover', { enabled: true });
  ok(res.status === 400, 'enabling with no linked spare is refused');
  ok(/link at least one other number/i.test(res.body),
    'and it says why, rather than giving a false sense of safety');
  ok(t.configStore.get().whatsapp.failover.enabled !== true, 'and it stays off');
}

t.server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
