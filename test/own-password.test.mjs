/* Every admin can change their own password.
   Run: node test/own-password.test.mjs

   Two things make this more than a form. An account whose holder cannot
   rotate its own credentials is one nobody can secure after a leak - so it
   must not be super-admin only. And a change that leaves other sessions alive
   is cosmetic: someone changing their password because they think it has been
   used by somebody else expects that to end the other person's access, but a
   stolen cookie keeps working for its full lifetime unless it is destroyed. */
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApiRouter } from '../src/web/api.js';
import { FileSessionStore } from '../src/web/session-store.js';
import { JobQueue } from '../src/core/queue.js';
import { hashPassword, verifyPassword } from '../src/util/crypto.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-'));

/* --------------------------------------------------- session store --- */

console.log('=== one account can be signed out everywhere ===');
{
  const store = new FileSessionStore({ file: path.join(tmp, 's.json') });
  const add = (sid, username) => store.set(sid, { user: { username } }, () => {});
  add('a1', 'mommy'); add('a2', 'mommy'); add('a3', 'mommy');
  add('b1', 'mark');

  const removed = store.destroyUser('mommy', { keepSid: 'a2' });
  ok(removed === 2, `the other two sessions went (${removed})`);
  ok(store.sessions.has('a2'), 'the one doing the changing stays signed in');
  ok(!store.sessions.has('a1') && !store.sessions.has('a3'), 'the others are gone');
  ok(store.sessions.has('b1'), 'and another admin is untouched');
}

console.log('=== matching a username is forgiving but not sloppy ===');
{
  const store = new FileSessionStore({ file: path.join(tmp, 's2.json') });
  store.set('x', { user: { username: 'Mommy' } }, () => {});
  store.set('y', { user: { username: 'mommyuser' } }, () => {});
  ok(store.destroyUser(' MOMMY ') === 1, 'case and surrounding spaces do not matter');
  ok(store.sessions.has('y'), 'but a different, longer username is NOT swept up');

  ok(store.destroyUser('') === 0, 'an empty username destroys nothing');
  ok(store.destroyUser(null) === 0, 'and neither does a missing one');
}

console.log('=== a corrupt session record does not stop the sweep ===');
{
  const store = new FileSessionStore({ file: path.join(tmp, 's3.json') });
  store.sessions.set('bad', { data: '{not json', expires: Date.now() + 1e6 });
  store.set('good', { user: { username: 'mommy' } }, () => {});
  ok(store.destroyUser('mommy') === 1, 'the valid session is still removed');
  ok(store.sessions.has('bad'), 'and the unreadable one is left alone rather than throwing');
}

/* ------------------------------------------------------ over HTTP --- */

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

console.log('=== a plain admin can change their OWN password ===');
{
  const r = await req(port, 'POST', '/api/auth/password',
    { current: 'mark-secret-1', next: 'mark-secret-2' }, 'mark', 'admin');
  ok(r.status === 200, `no super-admin role required (${r.status})`);
  const me = t.configStore.get().web.admins.find((a) => a.username === 'mark');
  ok(verifyPassword('mark-secret-2', me.passwordHash), 'the new password works');
  ok(!verifyPassword('mark-secret-1', me.passwordHash), 'and the old one does not');
  ok(t.events().some((e) => e.action === 'changed own password' && e.user === 'mark'),
    'the change is audited against them');
}

console.log('=== the current password must be right ===');
{
  const r = await req(port, 'POST', '/api/auth/password',
    { current: 'not-my-password', next: 'something-else-1' }, 'mark', 'admin');
  ok(r.status === 401, 'a wrong current password is refused');
  const me = t.configStore.get().web.admins.find((a) => a.username === 'mark');
  ok(verifyPassword('mark-secret-2', me.passwordHash), 'and nothing changed');
}

console.log('=== weak or unchanged passwords are refused ===');
{
  const short = await req(port, 'POST', '/api/auth/password',
    { current: 'mark-secret-2', next: 'short' }, 'mark', 'admin');
  ok(short.status === 400, 'under eight characters is refused');
  ok(/at least 8/.test(short.body), 'and says the rule');

  const same = await req(port, 'POST', '/api/auth/password',
    { current: 'mark-secret-2', next: 'mark-secret-2' }, 'mark', 'admin');
  ok(same.status === 400, 'reusing the current password is refused');
  ok(/same as the current/.test(same.body), 'rather than silently succeeding');
}

console.log('=== changing it signs the account out everywhere else ===');
{
  const s = t.store;
  s.set('other-device', { user: { username: 'mark' } }, () => {});
  s.set('this-one', { user: { username: 'mark' } }, () => {});
  s.set('someone-else', { user: { username: 'superadmin' } }, () => {});

  const r = await req(port, 'POST', '/api/auth/password',
    { current: 'mark-secret-2', next: 'mark-secret-3' }, 'mark', 'admin', 'this-one');
  ok(r.status === 200, 'the change succeeds');
  ok(r.json.endedElsewhere === 1, `and reports what it closed (${r.json.endedElsewhere})`);
  ok(!s.sessions.has('other-device'), 'the other device is signed out — a leaked cookie stops working');
  ok(s.sessions.has('this-one'), 'but you are not signed out of the tab you are using');
  ok(s.sessions.has('someone-else'), 'and nobody else is affected');
  ok(t.events().some((e) => /signed out 1 other session/.test(e.detail ?? '')), 'the audit log says so');
}

console.log('=== a super-admin reset also ends that person\'s sessions ===');
{
  const s = t.store;
  s.set('mark-a', { user: { username: 'mark' } }, () => {});
  s.set('mark-b', { user: { username: 'mark' } }, () => {});

  const r = await req(port, 'POST', '/api/admins/mark/reset',
    { password: 'reset-by-super-1' }, 'superadmin', 'superadmin');
  ok(r.status === 200, 'the reset succeeds');
  ok(!s.sessions.has('mark-a') && !s.sessions.has('mark-b'),
    'every session of theirs is closed — a reset that leaves them signed in locks nobody out');
  const me = t.configStore.get().web.admins.find((a) => a.username === 'mark');
  ok(verifyPassword('reset-by-super-1', me.passwordHash), 'and the new password is in effect');
}

console.log('=== a plain admin cannot reset anyone else ===');
{
  const r = await req(port, 'POST', '/api/admins/superadmin/reset',
    { password: 'trying-it-on-1' }, 'mark', 'admin');
  ok(r.status === 403, 'resetting another account is still super-admin only');
  const su = t.configStore.get().web.admins.find((a) => a.username === 'superadmin');
  ok(verifyPassword('super-secret-1', su.passwordHash), 'and their password is untouched');
}

console.log('=== the portal puts it where an admin will find it ===');
{
  const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');

  ok(/data-group="account" data-label="My account"/.test(html),
    'it has its own "My account" section, not buried among plugins and ports');
  ok(!/superadmin-only[^>]*>[\s\S]{0,400}id="btn-chpw"/.test(html), 'and is not super-admin gated');
  ok(/id="f-pw-new2"/.test(html), 'there is a confirm field');
  ok(/The two new passwords do not match/.test(app), 'a typo is caught before the round trip');
  ok(/signs out anyone else who is signed in as you/.test(html),
    'and the page says what changing it actually does');
}

t.server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
