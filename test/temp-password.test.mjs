/* A password a super-admin sets for someone else is temporary: its holder
   must choose their own the first time they sign in with it.
   Run: node test/temp-password.test.mjs

   The operator, 2026-10-08: "when I assign an admin a temp password they
   should be prompted to change it on first login". Until then the server
   refuses everything but the change itself, so the panel cannot simply be
   used around the prompt, and an account that was never given a temporary
   password is untouched. */
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApiRouter } from '../src/web/api.js';
import { FileSessionStore } from '../src/web/session-store.js';
import { JobQueue } from '../src/core/queue.js';
import { hashPassword, verifyPassword } from '../src/util/crypto.js';
import { addAdmin, authenticate, resetPassword, mustChangePassword, listAdmins } from '../src/web/auth.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-pw-'));

const ADMINS = [
  { username: 'superadmin', role: 'superadmin', passwordHash: hashPassword('super-secret-1') },
  { username: 'mark', role: 'admin', passwordHash: hashPassword('mark-secret-1') },
];

function makeConfigStore() {
  let cfg = {
    web: { admins: JSON.parse(JSON.stringify(ADMINS)), sessionSecret: 'x' },
    movieRequests: { requestGroups: ['g@g.us'], reactions: {}, notify: {} },
    media: {}, whatsapp: {}, tvRequests: {}, directLinks: {}, queue: {}, lockdown: {}, omdb: {},
  };
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
    redacted: () => ({}), onChange: () => {},
  };
}

async function boot() {
  const configStore = makeConfigStore();
  const store = new FileSessionStore({ file: path.join(tmp, 'live.json') });
  const stateStore = (() => {
    const sp = new Map();
    return { namespace(n) {
      if (!sp.has(n)) sp.set(n, {});
      const d = sp.get(n);
      return { get: (k, v) => d[k] ?? v, set: (k, v) => { d[k] = v; }, push: (k, v) => { (d[k] ??= []).unshift(v); } };
    } };
  })();

  const app = express();
  app.use(express.json());
  // Stand in for express-session: a session per caller, plus the store.
  app.use((req, _res, next) => {
    req.sessionID = req.headers['x-sid'] || 'sid-1';
    req.sessionStore = store;
    req.session = { user: { username: req.headers['x-who'] || 'mark', role: req.headers['x-role'] || 'admin' } };
    next();
  });
  app.use('/api', createApiRouter({
    configStore,
    bot: { dataDir: tmp, groupCache: new Map(), groups: () => [], on: () => {}, state: 'connected' },
    queue: new JobQueue({ concurrency: 1 }), linkQueue: new JobQueue({ concurrency: 1 }),
    pluginManager: { plugins: new Map(), notifyConfigChange: async () => {} },
    stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {}, failover: null,
  }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return { server, port: server.address().port, configStore, store,
           events: () => stateStore.namespace('audit').get('events', []) };
}

function req(port, method, p, body, who = 'mark', role = 'admin', sid = 'sid-1') {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { 'x-who': who, 'x-role': role, 'x-sid': sid };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf, json: (() => { try { return JSON.parse(buf); } catch { return null; } })() }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const t = await boot();
const { port } = t;
const account = (u) => t.configStore.get().web.admins.find((a) => a.username === u);

console.log('=== an account a super-admin adds starts on a temporary password ===');
{
  const r = await req(port, 'POST', '/api/admins', { username: 'yossi', password: 'temp-pass-1', role: 'admin' }, 'superadmin', 'superadmin');
  ok(r.status === 200 && account('yossi')?.mustChangePassword === true, `added, marked temporary (${r.status})`);
  ok(r.json.admins.find((a) => a.username === 'yossi')?.mustChangePassword === true, 'and the Admins list says so');
  const who = authenticate(t.configStore, 'yossi', 'temp-pass-1');
  ok(who?.mustChangePassword === true, 'signing in with it says it must be changed');
}

console.log('=== until it is changed, the panel is shut ===');
{
  for (const [m, p] of [['GET', '/api/admins'], ['GET', '/api/config'], ['PUT', '/api/admins/mark/timeout']]) {
    const r = await req(port, m, p, m === 'GET' ? undefined : { minutes: 5 }, 'yossi', 'admin');
    ok(r.status === 403 && r.json?.error === 'password-change-required', `${m} ${p}: refused (${r.status} ${r.json?.error})`);
  }
  const st = await req(port, 'GET', '/api/auth/status', undefined, 'yossi', 'admin');
  ok(st.json?.user?.mustChangePassword === true, 'the status check tells the panel to ask for a new password');
  const other = await req(port, 'GET', '/api/admins', undefined, 'mark', 'admin');
  ok(other.status === 200, 'an account never given a temporary password is untouched');
  ok(!account('mark').mustChangePassword && !mustChangePassword(t.configStore, 'superadmin'), 'and is not marked');
}

console.log('=== choosing their own password opens it ===');
{
  const wrong = await req(port, 'POST', '/api/auth/password', { current: 'not-it-at-all', next: 'yossi-own-pass' }, 'yossi', 'admin');
  ok(wrong.status === 401 && account('yossi').mustChangePassword === true, 'the temporary password is still needed to change it');
  const same = await req(port, 'POST', '/api/auth/password', { current: 'temp-pass-1', next: 'temp-pass-1' }, 'yossi', 'admin');
  ok(same.status === 400 && account('yossi').mustChangePassword === true, 'keeping the temporary password is not choosing one');
  const r = await req(port, 'POST', '/api/auth/password', { current: 'temp-pass-1', next: 'yossi-own-pass' }, 'yossi', 'admin');
  ok(r.status === 200 && verifyPassword('yossi-own-pass', account('yossi').passwordHash), `changed (${r.status})`);
  ok(!('mustChangePassword' in account('yossi')), 'the mark is gone');
  const now = await req(port, 'GET', '/api/admins', undefined, 'yossi', 'admin');
  ok(now.status === 200, 'and the panel opens');
  ok(authenticate(t.configStore, 'yossi', 'yossi-own-pass')?.mustChangePassword === undefined, 'the next sign-in is an ordinary one');
}

console.log('=== a super-admin\'s reset of someone else is temporary too ===');
{
  const r = await req(port, 'POST', '/api/admins/mark/reset', { password: 'mark-temp-2' }, 'superadmin', 'superadmin');
  ok(r.status === 200 && account('mark').mustChangePassword === true, 'mark must choose a new one');
  const shut = await req(port, 'GET', '/api/admins', undefined, 'mark', 'admin');
  ok(shut.status === 403, 'and is shut out until then, even with a session that was already open');
  const own = await req(port, 'POST', '/api/admins/superadmin/reset', { password: 'super-secret-9' }, 'superadmin', 'superadmin');
  ok(own.status === 200 && !account('superadmin').mustChangePassword, 'resetting your own account is choosing it: not temporary');
}

console.log('=== the functions on their own ===');
{
  const cs = t.configStore;
  resetPassword(cs, 'mark', 'mark-temp-3', { temporary: true });
  ok(mustChangePassword(cs, 'MARK'), 'temporary, whatever the case of the name');
  resetPassword(cs, 'mark', 'mark-own-3');
  ok(!mustChangePassword(cs, 'mark'), 'an ordinary reset clears it');
  addAdmin(cs, 'david', 'david-temp-1');
  ok(listAdmins(cs).find((a) => a.username === 'david').mustChangePassword === true, 'addAdmin marks a new account');
  ok(!listAdmins(cs).some((a) => 'passwordHash' in a), 'the list still carries no password hash');
}

console.log('=== the live stream and the panel follow the server ===');
{
  const server = fs.readFileSync(new URL('../src/web/server.js', import.meta.url), 'utf8');
  ok(/app\.get\('\/events'[\s\S]{0,400}mustChangePassword\(configStore/.test(server), '/events is refused too: the queue and log are the panel');
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  ok(/r\.user\?\.mustChangePassword\) \{ showPasswordChange\(r\.user, pw\)/.test(app), 'signing in with a temporary password opens the change screen, not the panel');
  ok(/status\.user\?\.mustChangePassword/.test(app), 'so does reloading the page before changing it');
  const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  ok(/id="chpw-gate-new"[^>]*autocomplete="new-password"/.test(html), 'the new password field is one a password manager offers to save');
}

t.server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
