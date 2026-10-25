/* Per-admin sign-out timeouts. Run: node test/per-admin-timeout.test.mjs

   The owner asked to decide, for each admin, how many idle minutes they get
   on the :8080 panel before it signs them out - and that only he, the
   super-admin, can set that, above all to 0, which switches the protection
   off for an account.

   Before this, there was one global number (web.idleTimeoutMinutes) and ANY
   signed-in admin could change it from Settings, including to 0. A settings
   save could also carry web.admins wholesale, which let a plain admin rewrite
   their own account. So this checks both halves: the value each session is
   actually held to, and every server path that could write one. */
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { idleTimeout, effectiveIdleMinutes, ownIdleMinutes, parseIdleMinutes } from '../src/web/idle.js';
import { listAdmins, setAdminTimeout, isSuperAdmin } from '../src/web/auth.js';
import { createApiRouter } from '../src/web/api.js';
import { ConfigStore } from '../src/config/store.js';
import { JobQueue } from '../src/core/queue.js';
import { hashPassword } from '../src/util/crypto.js';
import { categoryOf } from '../src/core/audit-filter.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-admin-'));

/* A clock we control, so nothing sleeps. */
let clock = 5_000_000;
const now = () => clock;
const minutes = (n) => { clock += n * 60_000; };

const ADMINS = () => [
  { username: 'superadmin', role: 'superadmin', passwordHash: hashPassword('super-secret-1'), createdAt: 1, lastLogin: null },
  // An account from before per-admin timeouts existed: no field at all.
  { username: 'mark', role: 'admin', passwordHash: hashPassword('mark-secret-1'), createdAt: 1, lastLogin: null },
  { username: 'yanky', role: 'admin', passwordHash: hashPassword('yanky-secret-1'), createdAt: 1, lastLogin: null },
];

/* The real ConfigStore, so arrays are replaced and hashes redacted exactly as
   they are in production. */
function makeConfigStore(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const cs = new ConfigStore({ dataDir: dir, masterKey: 'test-master-key-0123456789abcdef' });
  cs.load();
  cs.update({ web: { admins: ADMINS(), idleTimeoutMinutes: 15 }, media: { workDir: path.join(dir, 'media') } });
  return cs;
}

/* A guard wired exactly as server.js wires it. */
const guardFor = (cs) => idleTimeout((user) => effectiveIdleMinutes(cs.get().web, user?.username), now);

function run(guard, { method = 'GET', path: p = '/api/config', session }) {
  const req = { method, path: p, session };
  let status = null, body = null, nexted = false;
  const res = { status(c) { status = c; return res; }, json(b) { body = b; return res; } };
  guard(req, res, () => { nexted = true; });
  return { status, body, nexted };
}

function session(username, role = 'admin') {
  const s = { user: { username, role }, lastActive: now() };
  s.destroy = (cb) => { s.user = null; s.destroyed = true; cb?.(); };
  return s;
}

console.log('=== which number applies to whom ===');
{
  const web = {
    idleTimeoutMinutes: 15,
    admins: [
      { username: 'Mark', idleTimeoutMinutes: 5 },
      { username: 'yanky', idleTimeoutMinutes: null },
      { username: 'owner', idleTimeoutMinutes: 0 },
      { username: 'legacy' },
      { username: 'handedited', idleTimeoutMinutes: '0' },
      { username: 'negative', idleTimeoutMinutes: -3 },
    ],
  };
  ok(effectiveIdleMinutes(web, 'Mark') === 5, 'an admin\'s own value overrides the global default');
  ok(effectiveIdleMinutes(web, ' mark ') === 5, 'matched the way sign-in matches usernames: case and spaces do not matter');
  ok(effectiveIdleMinutes(web, 'yanky') === 15, 'null falls back to the global default');
  ok(effectiveIdleMinutes(web, 'legacy') === 15, 'so does an account that has never had the field');
  ok(effectiveIdleMinutes(web, 'owner') === 0, '0 is honoured as "never", not mistaken for "unset"');
  ok(effectiveIdleMinutes(web, 'handedited') === 15,
    'a string "0" from a hand-edited config is NOT read as never — guessing wrong there disables the lock');
  ok(effectiveIdleMinutes(web, 'negative') === 15, 'nor is a negative number');
  ok(effectiveIdleMinutes(web, 'nobody') === 15, 'an account that no longer exists gets the default');
  ok(effectiveIdleMinutes({ admins: [] }, 'x') === 15, 'and with no global either, the schema default of 15');
  ok(effectiveIdleMinutes({ idleTimeoutMinutes: 0, admins: [{ username: 'a', idleTimeoutMinutes: 30 }] }, 'a') === 30,
    'an admin with their own value keeps it even when the global is switched off');
  ok(ownIdleMinutes(web, 'yanky') === null && ownIdleMinutes(web, 'owner') === 0,
    'ownIdleMinutes tells "uses the default" (null) apart from "never" (0)');

  // A review found a settings save that put idleTimeoutMinutes: 0 onto
  // Object.prototype, which every account without its own value inherited.
  Object.prototype.idleTimeoutMinutes = 0;
  try {
    ok(ownIdleMinutes(web, 'legacy') === null && effectiveIdleMinutes(web, 'legacy') === 15,
      'a 0 inherited from a polluted Object.prototype is not read as an account\'s own "never"');
    ok(effectiveIdleMinutes({ admins: [] }, 'x') === 15, 'nor as the global value');
    ok(effectiveIdleMinutes(web, 'owner') === 0 && effectiveIdleMinutes(web, 'Mark') === 5,
      'while values the accounts really carry still apply');
  } finally {
    delete Object.prototype.idleTimeoutMinutes;
  }
}

console.log('=== what counts as a valid timeout ===');
{
  const bad = (v, allowNull = true) => { try { parseIdleMinutes(v, { allowNull }); return false; } catch { return true; } };
  ok(parseIdleMinutes(0) === 0 && parseIdleMinutes(1440) === 1440 && parseIdleMinutes(30) === 30, '0, 30 and 1440 are accepted');
  ok(parseIdleMinutes(null, { allowNull: true }) === null, 'null is "use the default" where that is allowed');
  ok(bad(null, false), 'but not for the global value itself, which has nothing to fall back to');
  ok(bad(-1), 'negatives are refused');
  ok(bad(1.5), 'fractions are refused');
  ok(bad(1441), 'more than a day is refused');
  ok(bad('30'), 'a numeric STRING is refused rather than coerced — +\'\' is 0');
  ok(bad(''), 'an empty string is refused, not read as 0');
  ok(bad(undefined), 'a missing value is refused, not read as the default');
  ok(bad(NaN) && bad(Infinity) && bad(true), 'NaN, Infinity and booleans are refused');
}

console.log('=== the guard holds each admin to their own number ===');
{
  const cs = makeConfigStore('guard');
  const guard = guardFor(cs);
  cs.update({ web: { admins: cs.get().web.admins.map((a) => (a.username === 'yanky' ? { ...a, idleTimeoutMinutes: 5 } : a)) } });

  const y = session('yanky');
  const m = session('mark');
  minutes(6);
  const ry = run(guard, { path: '/api/queue', session: y });
  const rm = run(guard, { path: '/api/queue', session: m });
  ok(y.destroyed === true && ry.status === 440, 'yanky, on 5 minutes, is signed out after 6 idle');
  ok(/after 5 minutes/.test(ry.body?.message ?? ''), `and told the number that applied to him: "${ry.body?.message}"`);
  ok(!m.destroyed && rm.nexted, 'mark, on the default 15, is still in at 6');
  minutes(10);
  const rm2 = run(guard, { path: '/api/queue', session: m });
  ok(m.destroyed === true && rm2.status === 440, 'and is signed out at 16, exactly as before this change');
}

console.log('=== 0 means never, and only for that admin ===');
{
  const cs = makeConfigStore('never');
  const guard = guardFor(cs);
  cs.update({ web: { admins: cs.get().web.admins.map((a) => (a.username === 'superadmin' ? { ...a, idleTimeoutMinutes: 0 } : a)) } });
  const su = session('superadmin', 'superadmin');
  const mo = session('mark');
  minutes(60 * 24 * 3);
  const r = run(guard, { path: '/api/queue', session: su });
  ok(r.nexted && !su.destroyed, 'three days idle with 0 and still signed in');
  run(guard, { path: '/api/queue', session: mo });
  ok(mo.destroyed === true, 'while an admin on the default is signed out as usual');
}

console.log('=== a change reaches a session that is already open ===');
{
  const cs = makeConfigStore('live');
  const guard = guardFor(cs);
  const setYanky = (v) => cs.update({ web: { admins: cs.get().web.admins.map((a) => (a.username === 'yanky' ? { ...a, idleTimeoutMinutes: v } : a)) } });

  setYanky(60);
  const y = session('yanky');
  minutes(20);
  ok(run(guard, { path: '/api/queue', session: y }).nexted, 'on 60 minutes, 20 idle is fine');
  setYanky(10);                                    // lowered while he is signed in
  const r = run(guard, { path: '/api/queue', session: y });
  ok(r.status === 440 && y.destroyed, 'lowered to 10 and his existing session ends on its next request — no restart, no re-login');

  // Raising it rescues an open session that would otherwise have lapsed.
  setYanky(5);
  const y2 = session('yanky');
  minutes(8);
  setYanky(30);
  ok(run(guard, { path: '/api/queue', session: y2 }).nexted && !y2.destroyed, 'raised to 30 and an 8-minute-idle session stays in');
}

console.log('=== switching the timeout back on measures from the last real click ===');
{
  // While an admin is on 0 the guard still records deliberate actions. If it
  // did not, the super-admin turning the timeout back on would measure from
  // the moment it was switched off, and sign out someone who was mid-task.
  const cs = makeConfigStore('reenable');
  const guard = guardFor(cs);
  const setMark = (v) => cs.update({ web: { admins: cs.get().web.admins.map((a) => (a.username === 'mark' ? { ...a, idleTimeoutMinutes: v } : a)) } });
  setMark(0);
  const s = session('mark');
  for (let i = 0; i < 12; i++) { minutes(10); run(guard, { method: 'PUT', path: '/api/config', session: s }); }
  setMark(15);
  minutes(2);
  const r = run(guard, { method: 'PUT', path: '/api/config', session: s });
  ok(r.nexted && !s.destroyed, 'two hours of steady use on "never", switched to 15: still signed in');

  // But polling alone while on 0 still does not count as being there.
  setMark(0);
  const idle = session('mark');
  for (let i = 0; i < 240; i++) { clock += 5000; run(guard, { path: '/api/queue', session: idle }); }
  setMark(15);
  const r2 = run(guard, { path: '/api/queue', session: idle });
  ok(r2.status === 440 && idle.destroyed, '20 minutes of nothing but polling, switched to 15: signed out');
}

console.log('=== accounts without the field behave exactly as before ===');
{
  const cs = makeConfigStore('legacy');
  const perAdmin = guardFor(cs);
  const globalOnly = idleTimeout(() => cs.get().web?.idleTimeoutMinutes ?? 15, now);  // the old wiring
  const a = session('mark'), b = session('mark');
  const outcomes = [];
  for (const step of [5, 5, 4, 2, 20]) {
    minutes(step);
    const ra = run(perAdmin, { path: '/api/queue', session: a });
    const rb = run(globalOnly, { path: '/api/queue', session: b });
    outcomes.push(ra.status === rb.status && !!a.destroyed === !!b.destroyed);
  }
  ok(outcomes.every(Boolean), 'the per-admin guard and the old global-only guard agree at every step');
  ok(listAdmins(cs).find((x) => x.username === 'mark').idleTimeoutMinutes === null,
    'the list reports null for them — "uses the default"');
  ok(!('idleTimeoutMinutes' in cs.get().web.admins.find((x) => x.username === 'mark')),
    'and nothing was written into their stored account just by reading it');
}

console.log('=== only a real super-admin can set one, even calling the function directly ===');
{
  const cs = makeConfigStore('direct');
  const refused = (actor, who, v) => { try { setAdminTimeout(cs, actor, who, v); return null; } catch (e) { return e; } };

  let e = refused({ username: 'mark', role: 'admin' }, 'mark', 0);
  ok(e?.status === 403, 'a plain admin setting their OWN timeout to 0 is refused');
  e = refused({ username: 'mark', role: 'superadmin' }, 'mark', 0);
  ok(e?.status === 403, 'so is a session that CLAIMS superadmin for an account that is not one');
  e = refused({ username: 'ghost', role: 'superadmin' }, 'mark', 0);
  ok(e?.status === 403, 'or for an account that no longer exists');
  ok(!('idleTimeoutMinutes' in cs.get().web.admins.find((x) => x.username === 'mark')), 'and none of them wrote anything');

  ok(isSuperAdmin(cs, { username: 'SuperAdmin', role: 'superadmin' }), 'the real super-admin passes (usernames matched case-insensitively)');
  const r = setAdminTimeout(cs, { username: 'superadmin', role: 'superadmin' }, 'mark', 0);
  ok(r.before === null && r.after === 0, 'and can set 0, reporting what it was');
  e = refused({ username: 'superadmin', role: 'superadmin' }, 'nobody', 10);
  ok(e?.status === 404, 'an unknown account is a 404');
  setAdminTimeout(cs, { username: 'superadmin', role: 'superadmin' }, 'mark', null);
  ok(!('idleTimeoutMinutes' in cs.get().web.admins.find((x) => x.username === 'mark')),
    'back to the default removes the field, rather than leaving a null behind');
}

/* ------------------------------------------------------ over HTTP --- */

async function boot(name) {
  const configStore = makeConfigStore(name);
  const stateStore = (() => {
    const sp = new Map();
    return { namespace(n) {
      if (!sp.has(n)) sp.set(n, {});
      const d = sp.get(n);
      return { get: (k, v) => d[k] ?? v, set: (k, v) => { d[k] = v; }, push: (k, v) => { (d[k] ??= []).unshift(v); } };
    } };
  })();

  // Sessions that persist between requests, so the idle guard can be seen
  // ending one that was opened before a timeout changed.
  const sessions = new Map();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const sid = req.headers['x-sid'] || `${req.headers['x-who']}-default`;
    if (!sessions.has(sid)) {
      const s = { user: { username: req.headers['x-who'], role: req.headers['x-role'] }, lastActive: now() };
      s.destroy = (cb) => { sessions.delete(sid); s.user = null; cb?.(); };
      sessions.set(sid, s);
    }
    req.session = sessions.get(sid);
    req.sessionID = sid;
    next();
  });
  app.use(guardFor(configStore));
  app.use('/api', createApiRouter({
    configStore,
    bot: { dataDir: tmp, groupCache: new Map(), groups: () => [], on: () => {}, state: 'connected' },
    queue: new JobQueue({ concurrency: 1 }), linkQueue: new JobQueue({ concurrency: 1 }),
    pluginManager: { plugins: new Map(), notifyConfigChange: async () => {} },
    stateStore, fileLogger: { tail: () => [] }, alerts: {}, lockScheduler: {}, failover: null,
  }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return {
    server, port: server.address().port, configStore, sessions,
    events: () => stateStore.namespace('audit').get('events', []),
    stored: (u) => configStore.get().web.admins.find((a) => a.username === u),
  };
}

function call(port, method, p, body, who, role, sid) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { 'x-who': who, 'x-role': role };
    if (sid) headers['x-sid'] = sid;
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

/** Send this exact text as the body: JSON.stringify cannot write an own "__proto__" key. */
function callRaw(port, method, p, raw, who, role) {
  return new Promise((resolve, reject) => {
    const headers = { 'x-who': who, 'x-role': role, 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) };
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf, json: (() => { try { return JSON.parse(buf); } catch { return null; } })() }));
    });
    r.on('error', reject);
    r.write(raw);
    r.end();
  });
}

const t = await boot('http');
const SU = ['superadmin', 'superadmin'];
const MO = ['mark', 'admin'];
const asSuper = (m, p, b) => call(t.port, m, p, b, ...SU);
const asAdmin = (m, p, b) => call(t.port, m, p, b, ...MO);

console.log('=== the admin list shows each timeout, and never a hash ===');
{
  const r = await asSuper('GET', '/api/admins');
  ok(r.status === 200, 'the list loads');
  const mo = r.json.admins.find((a) => a.username === 'mark');
  ok(mo && 'idleTimeoutMinutes' in mo && mo.idleTimeoutMinutes === null, 'each admin carries idleTimeoutMinutes (null = default)');
  ok(!/passwordHash|scrypt/.test(r.body), 'no password hash, or anything that looks like one, anywhere in the reply');
  ok(r.json.defaultIdleMinutes === 15, 'the global default comes with it, for the "default (15)" placeholder');
  ok(r.json.myIdle?.minutes === 15 && r.json.myIdle?.own === null, 'and what applies to whoever is asking, for My account');

  const plain = await asAdmin('GET', '/api/admins');
  ok(!/passwordHash|scrypt/.test(plain.body), 'the same for a plain admin');
}

console.log('=== a plain admin cannot set any timeout ===');
{
  for (const [who, minutesWanted] of [['mark', 0], ['mark', 600], ['yanky', 0], ['superadmin', 1]]) {
    const r = await asAdmin('PUT', `/api/admins/${who}/timeout`, { minutes: minutesWanted });
    ok(r.status === 403, `mark setting ${who} to ${minutesWanted}: refused (${r.status})`);
  }
  ok(/super-admin/.test((await asAdmin('PUT', '/api/admins/mark/timeout', { minutes: null })).json?.error ?? ''),
    'even back to the default, with a reason that names who can');
  ok(['mark', 'yanky', 'superadmin'].every((u) => !('idleTimeoutMinutes' in t.stored(u))), 'nothing was written');
  const refusals = t.events().filter((e) => e.user === 'mark' && /^refused: set the sign-out timeout/.test(e.action));
  ok(refusals.length === 5, `every attempt is in the audit log against him (${refusals.length})`);
  ok(categoryOf(refusals[0]) === 'accounts', 'filed under Admin accounts, where the owner will look');

  // A session that says superadmin for an account that is not one.
  const forged = await call(t.port, 'PUT', '/api/admins/mark/timeout', { minutes: 0 }, 'mark', 'superadmin', 'forged');
  ok(forged.status === 403, 'a session claiming superadmin for a plain account is refused too');
  ok(!('idleTimeoutMinutes' in t.stored('mark')), 'and wrote nothing');
}

console.log('=== the super-admin can ===');
{
  let r = await asSuper('PUT', '/api/admins/mark/timeout', { minutes: 30 });
  ok(r.status === 200 && t.stored('mark').idleTimeoutMinutes === 30, 'sets mark to 30');
  ok(r.json.admins.find((a) => a.username === 'mark').idleTimeoutMinutes === 30, 'and the reply carries the new list');
  let ev = t.events()[0];
  ok(ev.user === 'superadmin' && ev.action === 'set the sign-out timeout for "mark" to 30 min'
    && ev.detail === 'was the default (15 min)', `audited with before and after: "${ev.action}" / "${ev.detail}"`);

  r = await asSuper('PUT', '/api/admins/mark/timeout', { minutes: 0 });
  ok(r.status === 200 && t.stored('mark').idleTimeoutMinutes === 0, 'sets 0 (never)');
  ev = t.events()[0];
  ok(/to never$/.test(ev.action) && ev.detail === 'was 30 min', `recorded as "never": "${ev.action}"`);

  r = await asSuper('PUT', '/api/admins/superadmin/timeout', { minutes: 120 });
  ok(r.status === 200 && t.stored('superadmin').idleTimeoutMinutes === 120, 'sets their own');

  r = await asSuper('PUT', '/api/admins/MARK/timeout', { minutes: null });
  ok(r.status === 200 && !('idleTimeoutMinutes' in t.stored('mark')), 'and puts an admin back on the default (username in any case)');

  const miss = await asSuper('PUT', '/api/admins/nobody/timeout', { minutes: 5 });
  ok(miss.status === 404, `an unknown account is a 404 (${miss.status})`);
}

console.log('=== validation ===');
{
  const before = JSON.stringify(t.stored('yanky'));
  for (const [label, body] of [
    ['-1', { minutes: -1 }], ['2.5', { minutes: 2.5 }], ['1441', { minutes: 1441 }],
    ['"30"', { minutes: '30' }], ['""', { minutes: '' }], ['true', { minutes: true }],
    ['a missing value', {}], ['no body at all', undefined],
  ]) {
    const r = await asSuper('PUT', '/api/admins/yanky/timeout', body);
    ok(r.status === 400, `${label} is refused (${r.status})`);
  }
  ok(JSON.stringify(t.stored('yanky')) === before, 'and none of them changed the account');
  const r = await asSuper('PUT', '/api/admins/yanky/timeout', { minutes: -1 });
  ok(/0 to 1440/.test(r.json?.error ?? ''), `the refusal says the rule: "${r.json?.error}"`);
}

console.log('=== a plain admin cannot change the global through a settings save ===');
{
  const was = t.configStore.get().web.idleTimeoutMinutes;
  const level = t.configStore.get().logging.level;
  const wantLevel = level === 'debug' ? 'warn' : 'debug';
  for (const v of [0, 60, 5]) {
    const r = await asAdmin('PUT', '/api/config', { web: { idleTimeoutMinutes: v }, logging: { level: wantLevel } });
    ok(r.status === 403, `to ${v}: 403 (${r.status})`);
  }
  const r = await asAdmin('PUT', '/api/config', { web: { idleTimeoutMinutes: 0 }, logging: { level: wantLevel } });
  ok(/super-admin/.test(r.json?.error ?? '') && /Nothing was saved/.test(r.json?.error ?? ''),
    `with a message that says who can and what happened: "${r.json?.error}"`);
  ok(t.configStore.get().web.idleTimeoutMinutes === was, 'the global is unchanged');
  ok(t.configStore.get().logging.level === level,
    'and the WHOLE save was refused — the other field in it did not slip through');
  ok(t.events().some((e) => e.user === 'mark' && /^refused: change the sign-out timeout from 15 to 0/.test(e.action)),
    'the attempt is audited, with the value he wanted');

  const same = await asAdmin('PUT', '/api/config', { web: { idleTimeoutMinutes: was }, logging: { level: wantLevel } });
  ok(same.status === 200, 'resaving the value that is already there is not a change, so an ordinary save still works');
  ok(t.configStore.get().logging.level === wantLevel, 'and the rest of it is saved');

  const without = await asAdmin('PUT', '/api/config', { logging: { level } });
  ok(without.status === 200 && t.configStore.get().logging.level === level, 'as does a save that leaves the field out, as the panel now does');
}

console.log('=== nor rewrite accounts through a settings save ===');
{
  const snapshot = JSON.stringify(t.configStore.get().web.admins);
  const promote = t.configStore.redacted().web.admins.map((a) => ({ ...a, role: 'superadmin', idleTimeoutMinutes: 0 }));
  const r = await asAdmin('PUT', '/api/config', { web: { admins: promote } });
  ok(r.status === 403, `a plain admin sending web.admins is refused (${r.status})`);
  ok(JSON.stringify(t.configStore.get().web.admins) === snapshot, 'the accounts are untouched — no promotion, no 0');
  ok(t.events().some((e) => e.user === 'mark' && /admin accounts through settings/.test(e.action)), 'and it is audited');

  const s = await asSuper('PUT', '/api/config', { web: { admins: t.configStore.redacted().web.admins } });
  ok(s.status === 400, `from the super-admin too, since the browser's copy has no hashes and would lock everyone out (${s.status})`);
  ok(JSON.stringify(t.configStore.get().web.admins) === snapshot, 'still untouched');
  ok(t.configStore.get().web.admins.every((a) => a.passwordHash), 'every account still has its password hash');
}

console.log('=== nor switch every account to "never" through the prototype ===');
{
  // The body carried no own web.idleTimeoutMinutes or web.admins, so both
  // checks above were skipped; the merge then followed "__proto__" onto
  // Object.prototype. The config did not change, so nothing was audited.
  const effective = () => ['superadmin', 'mark', 'yanky'].map((u) => effectiveIdleMinutes(t.configStore.get().web, u)).join();
  const was = effective();
  for (const raw of ['{"__proto__":{"idleTimeoutMinutes":0}}', '{"web":{"__proto__":{"idleTimeoutMinutes":0}}}']) {
    const r = await callRaw(t.port, 'PUT', '/api/config', raw, ...MO);
    ok(r.status === 400, `${raw}: refused (${r.status})`);
    ok(!('idleTimeoutMinutes' in {}), 'nothing was written onto Object.prototype');
    ok(effective() === was, `every account keeps the timeout it had (${effective()})`);
  }
  const list = await asAdmin('GET', '/api/admins');
  const listed = (u) => list.json.admins.find((a) => a.username === u)?.idleTimeoutMinutes;
  ok(listed('mark') === null && listed('yanky') === null && list.json.myIdle.own === null && list.json.myIdle.minutes === 15,
    'the Admins list and My account still show the default for accounts with no value of their own');
  ok(t.events().filter((e) => e.user === 'mark' && e.action === 'refused: a malformed settings save').length === 2,
    'and both attempts are audited against him');
}

console.log('=== the super-admin can change the global, within limits ===');
{
  let r = await asSuper('PUT', '/api/config', { web: { idleTimeoutMinutes: 0 } });
  ok(r.status === 200 && t.configStore.get().web.idleTimeoutMinutes === 0, 'to 0');
  r = await asSuper('PUT', '/api/config', { web: { idleTimeoutMinutes: 45 } });
  ok(r.status === 200 && t.configStore.get().web.idleTimeoutMinutes === 45, 'and to 45');
  ok(t.events().some((e) => e.action === 'changed settings' && /idleTimeoutMinutes/.test(e.detail ?? '')), 'audited as a settings change');
  for (const v of [-5, 1441, 2.5, '30', null]) {
    const bad = await asSuper('PUT', '/api/config', { web: { idleTimeoutMinutes: v } });
    ok(bad.status === 400, `${JSON.stringify(v)} is refused (${bad.status})`);
  }
  ok(t.configStore.get().web.idleTimeoutMinutes === 45, 'and left the value alone');
  await asSuper('PUT', '/api/config', { web: { idleTimeoutMinutes: 15 } });
}

console.log('=== end to end: a timeout set over the API ends a session already open ===');
{
  // yanky signs in and does something.
  let r = await call(t.port, 'GET', '/api/admins', undefined, 'yanky', 'admin', 'yanky-tab');
  ok(r.status === 200, 'yanky is signed in');
  minutes(8);
  r = await call(t.port, 'GET', '/api/queue', undefined, 'yanky', 'admin', 'yanky-tab');
  ok(r.status === 200, 'eight minutes later his page is still polling happily under the 15-minute default');

  const set = await asSuper('PUT', '/api/admins/yanky/timeout', { minutes: 5 });
  ok(set.status === 200, 'the super-admin gives him 5 minutes');

  r = await call(t.port, 'GET', '/api/queue', undefined, 'yanky', 'admin', 'yanky-tab');
  ok(r.status === 440, `his very next request is the session-expired answer (${r.status})`);
  ok(/after 5 minutes/.test(r.json?.message ?? ''), `saying so: "${r.json?.message}"`);
  ok(!t.sessions.has('yanky-tab'), 'and the session is destroyed, not just refused');
}

console.log('=== the panel ===');
{
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../src/web/server.js', import.meta.url), 'utf8');

  ok(/idleTimeout\(\(user\) => effectiveIdleMinutes\(configStore\.get\(\)\.web, user\?\.username\)\)/.test(server),
    'server.js resolves the timeout per signed-in admin, from live config');
  ok(/<input id="f-idle"/.test(html) && /id="f-idle-lock"/.test(html), 'the global field keeps its id, with a hint for who may change it');
  ok(/\$\('f-idle'\)\.disabled = !isSuper/.test(app), 'the global field is disabled for anyone but the super-admin');
  ok(/function idleField\(\) \{\s*if \(CURRENT_USER\?\.role !== 'superadmin'\) return \{\};/.test(app),
    'and a plain admin\'s save leaves it out, so it can never trip the refusal');
  ok(/\.\.\.idleField\(\)/.test(app), 'the settings form uses that');
  const idleFieldSrc = app.slice(app.indexOf('function idleField()'), app.indexOf('$(\'btn-save\')'));
  ok(/validity\?\.badInput/.test(idleFieldSrc) && /throw new Error\(/.test(idleFieldSrc),
    'a super-admin\'s box the browser cannot read (e.g. "1e") stops the save with a message, not "Settings saved"');
  ok(/id="adm-idle-\$\{esc\(a\.username\)\}"/.test(app), 'each admin row has a minutes box');
  ok(/placeholder="\$\{defLabel\}"/.test(app) && /default \(\$\{ADMIN_IDLE_DEFAULT === 0 \? 'never'/.test(app),
    'whose placeholder shows the global default');
  ok(/api\('PUT', `\/admins\/\$\{encodeURIComponent\(username\)\}\/timeout`, \{ minutes \}\)/.test(app), 'saved through the super-admin route');
  ok(/m === 0 \? 'never signed out'/.test(app), '0 is labelled as "never"');
  ok(/id="my-idle"/.test(html) && /renderMyIdle\(r\.myIdle\)/.test(app), 'My account shows the timeout that applies to you');
}

t.server.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
