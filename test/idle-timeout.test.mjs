/* Idle sign-out. Run: node test/idle-timeout.test.mjs

   The trap this exists to avoid: an "any request in the last N minutes" timer
   never fires here, because the portal polls /queue every five seconds and
   holds an /events stream open for as long as the tab is. A super-admin's
   browser left open would stay authorised indefinitely - the exact situation
   an idle lock is supposed to prevent.

   So only DELIBERATE actions count as activity. */
import { idleTimeout, isPassive } from '../src/web/idle.js';

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log(`  ok   ${m}`)) : (fail++, console.log(`  FAIL ${m}`)); };

/* A clock we control, so nothing sleeps. */
let clock = 1_000_000;
const now = () => clock;
const minutes = (n) => { clock += n * 60_000; };

function run(guard, { method = 'GET', path = '/api/config', session }) {
  const req = { method, path, session };
  let status = null, body = null, nexted = false;
  const res = {
    status(c) { status = c; return res; },
    json(b) { body = b; return res; },
  };
  guard(req, res, () => { nexted = true; });
  return { status, body, nexted, req };
}

function session() {
  const s = { user: { username: 'mommy', role: 'superadmin' }, lastActive: now() };
  s.destroy = (cb) => { s.user = null; s.destroyed = true; cb?.(); };
  return s;
}

console.log('=== which requests count as the operator being there ===');
{
  ok(isPassive({ method: 'GET', path: '/api/queue' }), '/queue polling is passive');
  ok(isPassive({ method: 'GET', path: '/api/queue/links' }), 'so is the links queue');
  ok(isPassive({ method: 'GET', path: '/events' }), 'and the SSE stream');
  ok(isPassive({ method: 'GET', path: '/api/status' }), 'and the status poll');

  ok(!isPassive({ method: 'GET', path: '/api/groups' }), 'opening the Groups tab is deliberate');
  ok(!isPassive({ method: 'GET', path: '/api/history' }), 'so is opening History');
  ok(!isPassive({ method: 'POST', path: '/api/queue' }), 'and any write is, even on a passive path');
  ok(!isPassive({ method: 'DELETE', path: '/api/queue/abc' }), 'including a cancellation');
}

console.log('=== polling does NOT keep a session alive ===');
{
  const guard = idleTimeout(() => 15, now);
  const s = session();

  // 14 minutes of the page polling away, as it does with a tab left open.
  for (let i = 0; i < 168; i++) {           // 14 min at 5s intervals
    clock += 5000;
    run(guard, { path: '/api/queue', session: s });
  }
  ok(!s.destroyed, 'still signed in at 14 minutes');

  minutes(2);                                // now past the limit
  const r = run(guard, { path: '/api/queue', session: s });
  ok(s.destroyed === true, 'and signed out at 16 — polling never extended it');
  ok(r.status === 440, `the poll is answered with a session-expired status (${r.status})`);
  ok(/without activity/.test(r.body.message), `and says why: "${r.body.message}"`);
  ok(r.nexted === false, 'the request does not continue to the route');
}

console.log('=== actually using the portal DOES keep it alive ===');
{
  const guard = idleTimeout(() => 15, now);
  const s = session();
  for (let i = 0; i < 5; i++) {
    minutes(10);                             // ten minutes between clicks
    const r = run(guard, { method: 'PUT', path: '/api/config', session: s });
    ok(r.nexted === true, `click ${i + 1} after 10 idle minutes is allowed through`);
  }
  ok(!s.destroyed, 'fifty minutes of real use, still signed in');
}

console.log('=== the session is DESTROYED, not merely refused ===');
{
  // Refusing one request but leaving the cookie valid would mean the next
  // click authorises again - no lock at all.
  const guard = idleTimeout(() => 15, now);
  const s = session();
  minutes(20);
  run(guard, { session: s });
  ok(s.destroyed === true, 'destroy() was called');
  ok(s.user === null, 'and the user is gone from the session');

  const after = run(guard, { method: 'PUT', path: '/api/config', session: s });
  ok(after.nexted === true, 'a session with no user falls through to the normal auth guard');
  ok(after.status === null, 'the idle guard itself does not answer for it');
}

console.log('=== signed-out visitors are left to the auth guard ===');
{
  const guard = idleTimeout(() => 15, now);
  const r = run(guard, { session: {} });
  ok(r.nexted === true, 'no user means nothing to expire');
  ok(r.status === null, 'and no response from this middleware');

  const r2 = run(guard, { session: undefined });
  ok(r2.nexted === true, 'a missing session object does not throw');
}

console.log('=== it can be switched off ===');
{
  const guard = idleTimeout(() => 0, now);
  const s = session();
  minutes(60 * 24);
  const r = run(guard, { session: s });
  ok(r.nexted === true, 'zero minutes disables the timeout entirely');
  ok(!s.destroyed, 'and nobody is signed out');
}

console.log('=== a session with no recorded activity is not killed on sight ===');
{
  // Sessions created before this feature existed have no lastActive. Treating
  // that as "idle since 1970" would sign everyone out on deploy.
  const guard = idleTimeout(() => 15, now);
  const s = { user: { username: 'mommy' }, destroy: (cb) => { s.destroyed = true; cb?.(); } };
  const r = run(guard, { method: 'PUT', path: '/api/config', session: s });
  ok(r.nexted === true, 'an older session is allowed through');
  ok(!s.destroyed, 'not signed out just for predating the setting');
  ok(typeof s.lastActive === 'number', 'and it starts being tracked from now on');
}

console.log('=== the timeout is read live, not captured at startup ===');
{
  let mins = 15;
  const guard = idleTimeout(() => mins, now);
  const s = session();
  minutes(20);
  mins = 60;                                  // raised in Settings meanwhile
  const r = run(guard, { session: s });
  ok(r.nexted === true, 'the new value applies immediately, with no restart');
  ok(!s.destroyed, 'and the admin is not signed out under the old one');
}

console.log('=== the setting round-trips through the portal ===');
{
  const fs = await import('node:fs');
  const app = fs.readFileSync(new URL('../src/web/public/app.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../src/web/public/index.html', import.meta.url), 'utf8');

  ok(/<input id="f-idle"/.test(html), 'the field exists');
  // A field that saves but never loads shows empty, and +'' is 0 - which
  // would silently DISABLE the timeout on the next settings save.
  ok(/\$\('f-idle'\)\.value = c\.web\.idleTimeoutMinutes/.test(app), 'it is populated on load');
  ok(/idleTimeoutMinutes: \+\$\('f-idle'\)\.value/.test(app), 'and read back on save');

  const server = fs.readFileSync(new URL('../src/web/server.js', import.meta.url), 'utf8');
  ok(/app\.use\(idleTimeout\(/.test(server), 'the guard is mounted');
  const guardAt = server.indexOf('app.use(idleTimeout(');
  ok(guardAt < server.indexOf("app.get('/events'"), 'before the SSE stream, so a stale stream is cut too');
  ok(guardAt < server.indexOf("app.use('/api'"), 'and before the API');

  ok(/res\.status === 401 \|\| res\.status === 440/.test(app),
    'the portal treats an idle sign-out as a sign-out, not as a failed button press');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
