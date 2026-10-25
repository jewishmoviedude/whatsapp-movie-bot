/* A settings save cannot reach past the settings. Run: node test/settings-save-shape.test.mjs

   Found reviewing per-admin sign-out timeouts. Every check in PUT /config read
   patch.web as an object with the key it cared about, and a body that was not
   shaped like that walked straight past all of them:

   - {"__proto__": {"idleTimeoutMinutes": 0}} from a plain admin was merged
     into Object.prototype, so every account without a timeout of its own read
     0 - never signed out. The config did not change, so the server logged
     "no effective change" and the audit log had nothing.
   - {"web": {"__proto__": {"user": {...superadmin}}}} did the same to "user",
     and a visitor with no cookie at all then passed every guard as the
     super-admin, because their empty session inherited it.
   - {"web": []} replaced the whole web section - accounts, session secret -
     and saved it. With no accounts left, first-run setup was open to anyone,
     who then chose the new super-admin's password. {"web": null} made every
     route answer 500.

   And separately: removing an admin left their open sessions working, so a
   removed admin kept plain-admin rights for as long as they kept clicking.

   This drives the real server, with real express-session cookies and real
   sign-ins, because "a visitor with no cookie" and "a cookie that should have
   stopped working" are only meaningful against the real session layer. */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createServer } from '../src/web/server.js';
import { ConfigStore, patchProblem } from '../src/config/store.js';
import { JobQueue } from '../src/core/queue.js';
import { hashPassword } from '../src/util/crypto.js';
import { effectiveIdleMinutes } from '../src/web/idle.js';
import { categoryOf } from '../src/core/audit-filter.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-shape-'));

/** Nothing in this process may have been written onto the shared prototype. */
const prototypeClean = () => ['idleTimeoutMinutes', 'user', 'admins', 'role'].every((k) => !(k in {}));

function makeConfigStore(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const cs = new ConfigStore({ dataDir: dir, masterKey: 'test-master-key-0123456789abcdef' });
  cs.load();
  cs.update({
    web: {
      idleTimeoutMinutes: 15,
      admins: [
        { username: 'superadmin', role: 'superadmin', passwordHash: hashPassword('super-secret-1'), createdAt: 1, lastLogin: null },
        { username: 'mark', role: 'admin', passwordHash: hashPassword('mark-secret-1'), createdAt: 1, lastLogin: null },
        { username: 'yanky', role: 'admin', passwordHash: hashPassword('yanky-secret-1'), createdAt: 1, lastLogin: null },
      ],
    },
    media: { workDir: path.join(dir, 'media') },
  });
  return cs;
}

async function boot(name) {
  const cs = makeConfigStore(name);
  const sp = new Map();
  const stateStore = { namespace(n) {
    if (!sp.has(n)) sp.set(n, {});
    const d = sp.get(n);
    return { get: (k, v) => d[k] ?? v, set: (k, v) => { d[k] = v; }, push: (k, v) => { (d[k] ??= []).unshift(v); } };
  } };
  const bot = Object.assign(new EventEmitter(), {
    dataDir: cs.dataDir, groupCache: new Map(), groups: () => [], state: 'connected',
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

  /** raw: send this exact text as the body. JSON.stringify cannot write an own "__proto__" key. */
  const call = (method, p, { body, raw, cookie } = {}) => new Promise((resolve, reject) => {
    const data = raw ?? (body === undefined ? null : JSON.stringify(body));
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (data !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({
        status: res.statusCode, body: buf, setCookie: res.headers['set-cookie'],
        json: (() => { try { return JSON.parse(buf); } catch { return null; } })(),
      }));
    });
    r.on('error', reject);
    if (data !== null) r.write(data);
    r.end();
  });
  const login = async (username, password) => {
    const r = await call('POST', '/api/auth/login', { body: { username, password } });
    if (r.status !== 200) throw new Error(`could not sign in as ${username}: ${r.status} ${r.body}`);
    return (r.setCookie ?? []).map((x) => x.split(';')[0]).join('; ');
  };
  return {
    cs, server, call, login,
    events: () => stateStore.namespace('audit').get('events', []),
    onDisk: () => JSON.parse(fs.readFileSync(path.join(cs.dataDir, 'config.json'), 'utf8')),
  };
}

console.log('=== the store never follows __proto__, constructor or prototype ===');
{
  const cs = makeConfigStore('store');
  const before = JSON.stringify(cs.get());
  cs.update(JSON.parse('{"__proto__":{"idleTimeoutMinutes":0},"web":{"__proto__":{"user":{"role":"superadmin"}}}}'));
  cs.update(JSON.parse('{"constructor":{"prototype":{"admins":[]}},"web":{"constructor":{"prototype":{"role":"x"}}}}'));
  ok(prototypeClean(), 'an update carrying them writes nothing onto Object.prototype');
  ok(JSON.stringify(cs.get()) === before, 'and nothing into the config either');
  ok(effectiveIdleMinutes(cs.get().web, 'mark') === 15, 'so an account on the default still gets 15 minutes');

  // Not "debug", the default since 2026-10-12, which would merge nothing.
  cs.update({ logging: { level: 'warn' } });
  ok(cs.get().logging.level === 'warn', 'an ordinary update still merges as before');
}

console.log('=== patchProblem names what is wrong, and passes what the panel sends ===');
{
  const cur = { web: { port: 8080, admins: [] }, logging: { level: 'info' }, bannedNumbers: [] };
  ok(patchProblem(cur, { web: { port: 8081 }, logging: { level: 'debug' }, bannedNumbers: ['1'] }) === null,
    'an ordinary save has no problem');
  ok(patchProblem(cur, { newPlugin: { a: 1 } }) === null, 'nor does a section the defaults do not know about');
  ok(/"web" was sent as a list/.test(patchProblem(cur, { web: [] })), '{"web": []} is named');
  ok(/"web" was sent as null/.test(patchProblem(cur, { web: null })), '{"web": null} is named');
  ok(/"web" was sent as text/.test(patchProblem(cur, { web: 'x' })), '{"web": "x"} is named');
  ok(/"__proto__" is not a setting/.test(patchProblem(cur, JSON.parse('{"__proto__":{}}'))), 'a top-level __proto__ is named');
  ok(/"web.__proto__" is not a setting/.test(patchProblem(cur, JSON.parse('{"web":{"__proto__":{}}}'))), 'and one inside a section, with its path');
  ok(/"bannedNumbers.0.constructor"/.test(patchProblem(cur, JSON.parse('{"bannedNumbers":[{"constructor":{}}]}')) ?? ''),
    'and one hidden inside a list');
  ok(/not a set of settings/.test(patchProblem(cur, [])), 'a body that is a list is refused');
  const long = patchProblem(cur, JSON.parse(`{"web":{"${'x'.repeat(200)}":{"__proto__":{}}}}`));
  ok(long.length < 160 && /…/.test(long), 'a sender-chosen key name is clipped before it reaches the audit log');
}

const t = await boot('http');
const mark = await t.login('mark', 'mark-secret-1');
const superCookie = await t.login('superadmin', 'super-secret-1');

console.log('=== a plain admin cannot switch everyone\'s timeout off through the prototype ===');
{
  for (const raw of ['{"__proto__":{"idleTimeoutMinutes":0}}', '{"web":{"__proto__":{"idleTimeoutMinutes":0}}}']) {
    const r = await t.call('PUT', '/api/config', { raw, cookie: mark });
    ok(r.status === 400, `${raw}: refused (${r.status})`);
    ok(/not a setting/.test(r.json?.error ?? '') && /Nothing was saved/.test(r.json?.error ?? ''),
      `with a reason: "${r.json?.error}"`);
    ok(prototypeClean(), 'Object.prototype is untouched');
    ok(['mark', 'yanky', 'superadmin'].every((u) => effectiveIdleMinutes(t.cs.get().web, u) === 15),
      'every account is still on the 15-minute default');
  }
  const list = await t.call('GET', '/api/admins', { cookie: mark });
  ok(list.json?.admins?.every((a) => a.idleTimeoutMinutes === null) && list.json?.myIdle?.minutes === 15,
    'the Admins list and My account agree');
  const rows = t.events().filter((e) => e.user === 'mark' && e.action === 'refused: a malformed settings save');
  ok(rows.length === 2, `both attempts are in the audit log against him (${rows.length})`);
  ok(categoryOf(rows[0]) === 'settings', 'filed under Settings');
}

console.log('=== nor make a visitor with no cookie the super-admin ===');
{
  const r = await t.call('PUT', '/api/config',
    { raw: '{"web":{"__proto__":{"user":{"username":"superadmin","role":"superadmin"}}}}', cookie: mark });
  ok(r.status === 400, `refused (${r.status})`);
  ok(prototypeClean(), 'nothing was inherited by every session');
  const anon = await t.call('PUT', '/api/admins/mark/timeout', { body: { minutes: 0 } });
  ok(anon.status === 401, `an anonymous request is still unauthorised (${anon.status})`);
  const anonAdd = await t.call('POST', '/api/admins', { body: { username: 'intruder', password: 'intruder-pass-1', role: 'superadmin' } });
  ok(anonAdd.status === 401 && !t.cs.get().web.admins.some((a) => a.username === 'intruder'),
    'and cannot create a super-admin');
}

console.log('=== constructor and prototype are refused the same way ===');
{
  for (const raw of ['{"constructor":{"prototype":{"idleTimeoutMinutes":0}}}', '{"web":{"prototype":{"x":1}}}']) {
    const r = await t.call('PUT', '/api/config', { raw, cookie: mark });
    ok(r.status === 400 && prototypeClean(), `${raw}: refused, prototype clean (${r.status})`);
  }
}

console.log('=== a plain admin cannot replace the web section wholesale ===');
{
  const adminsBefore = JSON.stringify(t.cs.get().web.admins);
  // "warn", not "debug": debug is the default since 2026-10-12
  // (live-settings-defaults), so it would read as unchanged either way.
  for (const raw of ['{"web":[]}', '{"web":"x"}', '{"web":null}', '{"web":5}', '{"logging":{"level":"warn"},"web":[]}']) {
    const r = await t.call('PUT', '/api/config', { raw, cookie: mark });
    ok(r.status === 400, `${raw}: refused (${r.status})`);
  }
  ok(JSON.stringify(t.cs.get().web.admins) === adminsBefore, 'every account is still there, hashes and all');
  ok(Array.isArray(t.onDisk().web.admins) && t.onDisk().web.admins.length === 3, 'and on disk');
  ok(t.cs.get().logging.level !== 'warn', 'the whole save was refused, not just the web part of it');

  const st = await t.call('GET', '/api/auth/status');
  ok(st.status === 200 && st.json?.setupRequired === false, 'first-run setup is not offered to anyone');
  const setup = await t.call('POST', '/api/auth/setup', { body: { password: 'attacker-pass-1' } });
  ok(setup.status === 409, `and cannot be used to mint a super-admin (${setup.status})`);

  const bySuper = await t.call('PUT', '/api/config', { raw: '{"web":[]}', cookie: superCookie });
  ok(bySuper.status === 400, `the super-admin cannot do it by accident either (${bySuper.status})`);

  const rows = t.events().filter((e) => e.action === 'refused: a malformed settings save');
  ok(rows.some((e) => e.user === 'mark' && /"web" was sent as a list/.test(e.detail ?? '')),
    'each attempt is audited with what was wrong with it');
}

console.log('=== an ordinary save still works ===');
{
  const r = await t.call('PUT', '/api/config', { body: { logging: { level: 'warn' }, web: { port: 8080 } }, cookie: mark });
  ok(r.status === 200 && t.cs.get().logging.level === 'warn', `a plain admin's save of ordinary settings goes through (${r.status})`);
}

console.log('=== removing an admin ends their open sessions ===');
{
  const yanky = await t.login('yanky', 'yanky-secret-1');
  const yankyPhone = await t.login('yanky', 'yanky-secret-1');
  ok((await t.call('GET', '/api/config', { cookie: yanky })).status === 200, 'yanky is signed in, on two devices');

  const del = await t.call('DELETE', '/api/admins/yanky', { cookie: superCookie });
  ok(del.status === 200 && del.json?.endedSessions === 2, `the super-admin removes him, ending both (${del.json?.endedSessions})`);
  const ev = t.events().find((e) => e.action === 'remove admin "yanky"');
  ok(ev?.detail === 'signed out 2 session(s)', `the audit row says so: "${ev?.detail}"`);

  const after = await t.call('PUT', '/api/config', { body: { logging: { level: 'info' } }, cookie: yanky });
  ok(after.status === 401, `his old cookie no longer works (${after.status})`);
  ok((await t.call('GET', '/api/admins', { cookie: yankyPhone })).status === 401, 'on either device');
  ok((await t.call('GET', '/api/config', { cookie: mark })).status === 200, 'while other admins are untouched');
  ok((await t.call('GET', '/api/config', { cookie: superCookie })).status === 200, 'including the one who removed him');

  const again = await t.call('DELETE', '/api/admins/mark', { cookie: superCookie });
  ok(again.status === 200, 'removing someone signed in on one device works too');
  ok((await t.call('GET', '/api/config', { cookie: mark })).status === 401, 'and ends that session');
}

t.server.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
