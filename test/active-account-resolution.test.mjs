/* "Which number is in use?" has one answer everywhere.
   Run: node test/active-account-resolution.test.mjs

   schema.js ships whatsapp.activeAccount as '' - present, not missing. Several
   places resolved it with `activeAccount ?? 'default'`, so on a new install the
   fallback never applied and they disagreed with listAccounts()/activeAccount()
   in src/core/accounts.js, which read a missing, blank or unknown value as the
   first account. What that did, site by site:
     - failover: the number actually connected ranked as its own spare, so an
       outage "failed over" to it, and its recovery never cleared its health;
     - PUT /wa/failover: the number in use counted as a linked spare, so
       failover could be switched on with nothing to fail over to;
     - the panel: no number was marked "in use", and choosing the connected one
       asked to switch to it;
     - startup: looked in data/session, which is only right while the first
       account happens to be called 'default'.
   updateAccount() had the same bug (fixed on the fresh-install-checklist
   branch). Nothing here needs linkedom, so it also runs on a production
   install. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import express from 'express';
import { FailoverSupervisor } from '../src/core/failover.js';
import { activeAccount, sessionDirFor } from '../src/core/accounts.js';
import { createApiRouter } from '../src/web/api.js';
import { JobQueue } from '../src/core/queue.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const ACCOUNTS = [
  { id: 'main', label: 'Main', phoneNumber: '15558060189' },
  { id: 'nolan', label: 'Christopher Nolan', phoneNumber: '15558020184' },
];

function makeConfigStore(whatsapp, extra = {}) {
  let cfg = { whatsapp: JSON.parse(JSON.stringify(whatsapp)), ...extra };
  const merge = (a, b) => {
    for (const [k, v] of Object.entries(b)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) merge(a[k] ??= {}, v);
      else a[k] = v;
    }
    return a;
  };
  return {
    get: () => cfg,
    update: (patch) => { cfg = merge(JSON.parse(JSON.stringify(cfg)), patch); return cfg; },
    redacted: () => ({ ok: true }),
    onChange: () => () => {},
  };
}

/* ------------------------------------------------------------ failover --- */

class FakeBot extends EventEmitter {
  constructor(configStore) {
    super();
    this.dataDir = '/tmp';
    this.state = 'connected';
    this.configStore = configStore;
    this.starts = [];
  }
  setState(state) { this.state = state; this.emit('state', { state, lastError: null, reconnectAttempts: 0 }); }
  async stop() { this.state = 'stopped'; }
  async start() {
    this.starts.push(this.configStore.get().whatsapp.activeAccount);
    setImmediate(() => this.setState('connected'));
  }
}

function supervisor(activeId) {
  const configStore = makeConfigStore({
    activeAccount: activeId,
    accounts: ACCOUNTS,
    failover: { enabled: true, probeTimeoutMs: 200, checkEveryMs: 999_999, holdDownMs: 0 },
  });
  const bot = new FakeBot(configStore);
  const sup = new FailoverSupervisor({ bot, configStore, queues: [{ active: new Map(), pending: [] }] });
  // listAccounts() looks for creds.json on disk; treat every number as linked.
  const realRanked = sup.ranked.bind(sup);
  sup.ranked = () => realRanked().map((a) => ({ ...a, linked: true }));
  sup.start();
  return { sup, bot, configStore };
}

console.log('=== failover knows which number is in use on a new install ===');
for (const [label, value] of [['a blank', ''], ['an unknown', 'deleted-number']]) {
  const { sup } = supervisor(value);
  ok(sup.activeId() === 'main', `${label} activeAccount resolves to the first number (got "${sup.activeId()}")`);
  ok(sup.status().active === 'main', `and the portal is told so (${label} one)`);
  sup.stop();
}

console.log('=== an outage never "fails over" to the number already connected ===');
{
  const { sup, configStore } = supervisor('');
  const moved = await sup.failover('test');
  ok(moved?.id === 'nolan', `it moves to the real spare (got ${moved?.id ?? 'nothing'})`);
  ok(configStore.get().whatsapp.activeAccount === 'nolan', 'and the config follows');
  sup.stop();
}

console.log('=== recovering clears the health of the number in use, not of "" ===');
{
  const { sup, bot } = supervisor('');
  sup.health.set('main', { reason: 'connection lost', cooldownUntil: Date.now() + 600_000 });
  bot.setState('connected');
  ok(!sup.health.has('main'), 'the connected number is marked healthy again');
  sup.stop();
}

/* ---------------------------------------------------- PUT /wa/failover --- */

async function withApi(dataDir, run) {
  const configStore = makeConfigStore(
    { activeAccount: '', accounts: ACCOUNTS, failover: { enabled: false, order: [] } },
    { web: { admins: [{ username: 'superadmin', role: 'superadmin', passwordHash: 'x' }] }, movieRequests: { requestGroups: [], reactions: {} }, media: {}, tvRequests: {}, directLinks: {}, queue: {}, lockdown: {} },
  );
  const stateStore = {
    namespace: () => ({ get: (_k, d) => d, set: () => {}, push: () => {} }),
  };
  const bot = { dataDir, state: 'connected', groupCache: new Map(), groups: () => [], on: () => {}, stop: async () => {}, start: async () => {} };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { username: 'superadmin', role: 'superadmin' } }; next(); });
  app.use('/api', createApiRouter({
    configStore, bot, queue: new JobQueue({ concurrency: 1 }), linkQueue: new JobQueue({ concurrency: 1 }),
    pluginManager: { plugins: new Map(), notifyConfigChange: async () => {} },
    stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {}, failover: null,
  }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const put = (body) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const rq = http.request({ host: '127.0.0.1', port: server.address().port, method: 'PUT', path: '/api/wa/failover',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }));
    });
    rq.on('error', reject);
    rq.end(data);
  });
  try { await run({ put, configStore }); } finally { server.close(); }
}

const link = (dataDir, id) => {
  const dir = sessionDirFor(dataDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'creds.json'), '{}');
};

console.log('=== failover cannot be switched on with only the number in use linked ===');
{
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'active-acct-'));
  try {
    link(dataDir, 'main');                          // the number in use, and nothing else
    await withApi(dataDir, async ({ put, configStore }) => {
      const r = await put({ enabled: true });
      ok(r.status === 400 && /No linked spare/.test(r.body.error ?? ''),
        `refused: the number in use is not its own spare (HTTP ${r.status})`);
      ok(configStore.get().whatsapp.failover.enabled === false, 'and failover stays off');

      link(dataDir, 'nolan');                       // now there is somewhere to go
      const r2 = await put({ enabled: true });
      ok(r2.status === 200 && configStore.get().whatsapp.failover.enabled === true,
        `allowed once a real spare is linked (HTTP ${r2.status})`);
    });
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
}

/* ------------------------------------------------------------- startup --- */

console.log('=== startup looks in the folder of the number in use ===');
{
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'active-acct-'));
  try {
    // A new install whose only number was added as "nolan": activeAccount ''.
    const cfg = { whatsapp: { activeAccount: '', accounts: [ACCOUNTS[1], ACCOUNTS[0]] } };
    const dir = sessionDirFor(dataDir, activeAccount(cfg, dataDir).id);
    ok(dir === path.join(dataDir, 'sessions', 'nolan'),
      'the first account\'s own folder, not data/session');
    ok(dir !== sessionDirFor(dataDir, cfg.whatsapp.activeAccount ?? 'default'),
      'which is exactly where the old expression went wrong');

    const idx = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    ok(!/whatsapp\?\.activeAccount \?\? 'default'/.test(idx), 'index.js no longer uses the `??` fallback');
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
}

/* --------------------------------------------------------------- panel --- */

const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
const helperSrc = app.match(/function accountInUseId[\s\S]*?\n\}/)[0];
// eslint-disable-next-line no-new-func
const accountInUseId = new Function(`${helperSrc}; return accountInUseId;`)();

console.log('=== the panel resolves "in use" exactly as the server does ===');
{
  const cases = [
    [{ activeAccount: '', accounts: ACCOUNTS }, 'blank'],
    [{ activeAccount: 'deleted-number', accounts: ACCOUNTS }, 'unknown'],
    [{ activeAccount: 'nolan', accounts: ACCOUNTS }, 'explicit'],
    [{ activeAccount: '', accounts: [] }, 'no accounts'],
    [{}, 'nothing configured'],
  ];
  for (const [wa, label] of cases) {
    const server = activeAccount({ whatsapp: wa }).id;
    ok(accountInUseId(wa) === server, `${label}: panel "${accountInUseId(wa)}" = server "${server}"`);
  }
  ok(!/wa\.activeAccount \?\? 'default'/.test(app), 'app.js no longer uses the `??` fallback anywhere');
}

console.log('=== choosing the number already connected does not offer to switch to it ===');
{
  const handlerSrc = app.match(/\$\('f-phone'\)\?\.addEventListener\('change', (async \(e\) => \{[\s\S]*?\n\})\);/)[1];
  const run = async (chosenId) => {
    const calls = { confirm: 0, switched: null };
    const CONFIG = { whatsapp: { activeAccount: '', accounts: ACCOUNTS, phoneNumber: '15558060189' } };
    const window = { switchAccount: async (id) => { calls.switched = id; } };
    const confirm = () => { calls.confirm += 1; return true; };
    const $ = () => ({ value: '' });
    // eslint-disable-next-line no-new-func
    const handler = new Function('$', 'CONFIG', 'confirm', 'window', 'loadConfig', 'accountInUseId',
      `return (${handlerSrc});`)($, CONFIG, confirm, window, async () => {}, accountInUseId);
    await handler({ target: { selectedOptions: [{ dataset: { id: chosenId }, textContent: chosenId }] } });
    return calls;
  };

  const same = await run('main');
  ok(same.confirm === 0 && same.switched === null, 'the connected number: no prompt, no switch');
  const other = await run('nolan');
  ok(other.confirm === 1 && other.switched === 'nolan', 'another number: asks, then switches');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
